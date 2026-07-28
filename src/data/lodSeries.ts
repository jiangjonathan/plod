import type { DataSource, DataSourceResolveRequest } from "./types";
import { resolveFocusIndexRange } from "./focusRange";
import { notifyListeners } from "./listeners";

export type LodSeriesMode = "line" | "bar" | "point";

export type LodPoint = {
  x: number;
  y: number;
  /** Optional series key retained by line LOD so each line is decimated independently. */
  series?: string | number;
  index: number;
  count: number;
  firstY: number;
  lastY: number;
  minY: number;
  maxY: number;
};

export type LodPointInput = {
  x: number;
  y: number;
  series?: string | number;
};

export type LodSeriesOptions = {
  mode?: LodSeriesMode;
  maxRawPointsPerPixel?: number;
  /** Coalesce updateLevels + publish to one commit per animation frame. */
  bufferAppends?: boolean;
};
export type LodSeries = DataSource<LodPoint> & {
  append(point: readonly [number, number] | LodPointInput): void;
  appendBatch(points: readonly (readonly [number, number] | LodPointInput)[]): void;
  appendBuffer(
    x: ArrayLike<number>,
    y: ArrayLike<number>,
    count: number,
    series?: ArrayLike<string | number | undefined>
  ): void;
  appendIterable(points: Iterable<readonly [number, number] | LodPointInput>): void;
  /** Replace everything from `startIndex` onward (for a live tip that moves every frame). */
  writeFrom(
    startIndex: number,
    x: ArrayLike<number>,
    y: ArrayLike<number>,
    count: number,
    series?: ArrayLike<string | number | undefined>
  ): void;
  flush(): void;
  clear(): void;
  readonly length: number;
};

type Bucket = {
  firstIndex: number;
  lastIndex: number;
  count: number;
  firstX: number;
  firstY: number;
  lastX: number;
  lastY: number;
  minIndex: number;
  minX: number;
  minY: number;
  maxIndex: number;
  maxX: number;
  maxY: number;
  /** Present on leaf buckets in multi-series mode to avoid a per-point Map. */
  series?: string | number;
  /** Present only for multi-series data. Kept as a compact list to avoid many small Map allocations. */
  seriesBuckets?: SeriesBucket[];
};

type SeriesBucket = Omit<Bucket, "seriesBuckets" | "series"> & {
  series: string | number | undefined;
};

type ResolvedIndexRange = {
  start: number;
  end: number;
  visibleStart: number;
  visibleEnd: number;
  visibleX?: readonly [number, number];
};

const MIN_STORED_LOD_LEVEL = 6;
const MIN_STORED_BUCKET_SIZE = 2 ** MIN_STORED_LOD_LEVEL;

export function createLodSeries(options: LodSeriesOptions = {}): LodSeries {
  const mode = options.mode ?? "line";
  const bufferAppends = options.bufferAppends === true;
  // Retain enough samples to keep dense line series smooth between CSS pixels.
  // Callers can still lower this for throughput-sensitive live charts.
  const maxRawPointsPerPixel = Math.max(1, options.maxRawPointsPerPixel ?? 6);
  const xValues: number[] = [];
  const yValues: number[] = [];
  const seriesValues: (string | number | undefined)[] = [];
  const levels: Bucket[][] = [];
  const listeners = new Set<() => void>();
  let version = 0;
  let pendingCommitStart: number | undefined;
  let flushFrame: number | undefined;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let cachedView: {
    version: number;
    mode: LodSeriesMode;
    start: number;
    end: number;
    budget: number;
    data: readonly LodPoint[];
  } | undefined;
  let cachedSubMinuteTimestampsVersion = -1;
  let cachedSubMinuteTimestamps = false;
  let hasSeries = false;
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;
  const source: LodSeries = {
    kind: "data-source",
    get version() {
      return version;
    },
    get length() {
      return xValues.length;
    },
    get yExtent(): readonly [number, number] | undefined {
      if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) {
        return undefined;
      }

      return [yMin, yMax];
    },
    get xExtent(): readonly [number, number] | undefined {
      if (xValues.length === 0) {
        return undefined;
      }

      return [xValues[0] ?? 0, xValues[xValues.length - 1] ?? 0];
    },
    yExtentForXDomain(domain, hiddenSeries) {
      commitPending(true);
      return resolveYExtentForDomain(xValues, yValues, seriesValues, levels, domain, hasSeries, hiddenSeries);
    },
    append(point) {
      const startIndex = xValues.length;
      appendRawPoint(point);
      if (xValues.length > startIndex) {
        queueCommit(startIndex);
      }
    },
    appendBatch(points) {
      const startIndex = xValues.length;
      for (let i = 0; i < points.length; i += 1) {
        appendRawPoint(points[i]!);
      }
      if (xValues.length > startIndex) {
        queueCommit(startIndex);
      }
    },
    appendBuffer(x, y, count, series) {
      const startIndex = xValues.length;
      for (let i = 0; i < count; i += 1) {
        appendRawValues(x[i] ?? 0, y[i] ?? 0, series ? series[i] : undefined);
      }
      if (xValues.length > startIndex) {
        queueCommit(startIndex);
      }
    },
    writeFrom(startIndex, x, y, count, series) {
      const safeStart = Math.max(0, Math.min(xValues.length, Math.floor(startIndex)));
      cancelScheduledFlush();
      pendingCommitStart = undefined;

      // Tip-only rewrite: same span, just new values.
      if (count > 0 && safeStart < xValues.length && safeStart + count === xValues.length) {
        for (let i = 0; i < count; i += 1) {
          const index = safeStart + i;
          const nextX = x[i] ?? 0;
          const nextY = y[i] ?? 0;
          if (!Number.isFinite(nextX) || !Number.isFinite(nextY)) continue;
          xValues[index] = nextX;
          yValues[index] = nextY;
          if (series) seriesValues[index] = series[i];
          if (nextY < yMin) yMin = nextY;
          if (nextY > yMax) yMax = nextY;
        }
        updateLevels(safeStart, xValues.length);
        invalidateResolvedBucketCaches(safeStart, xValues.length);
        publish();
        return;
      }

      if (xValues.length > safeStart) {
        xValues.length = safeStart;
        yValues.length = safeStart;
        seriesValues.length = safeStart;
        // Drop cached buckets past the new end; updateLevels rebuilds what we append.
        for (let level = 0; level < levels.length; level += 1) {
          const levelBuckets = levels[level];
          if (!levelBuckets) continue;
          const bucketSize = 2 ** level;
          const maxBuckets = Math.ceil(safeStart / bucketSize);
          if (levelBuckets.length > maxBuckets) {
            levelBuckets.length = maxBuckets;
          }
        }
        if (safeStart > 0) {
          const bucketStart = Math.floor((safeStart - 1) / MIN_STORED_BUCKET_SIZE) * MIN_STORED_BUCKET_SIZE;
          updateLevels(bucketStart, safeStart);
          invalidateResolvedBucketCaches(bucketStart, safeStart);
        } else {
          levels.length = 0;
        }
      }

      for (let i = 0; i < count; i += 1) {
        appendRawValues(x[i] ?? 0, y[i] ?? 0, series ? series[i] : undefined);
      }

      if (xValues.length > safeStart) {
        updateLevels(safeStart, xValues.length);
        invalidateResolvedBucketCaches(safeStart, xValues.length);
      }
      publish();
    },
    appendIterable(points) {
      const startIndex = xValues.length;
      for (const point of points) {
        appendRawPoint(point);
      }
      if (xValues.length > startIndex) {
        if (startIndex === 0) {
          commitPending(true);
        } else {
          queueCommit(startIndex);
        }
      }
    },
    flush() {
      cancelScheduledFlush();
      commitPending(true);
    },
    clear() {
      cancelScheduledFlush();
      pendingCommitStart = undefined;
      xValues.length = 0;
      yValues.length = 0;
      seriesValues.length = 0;
      levels.length = 0;
      hasSeries = false;
      yMin = Number.POSITIVE_INFINITY;
      yMax = Number.NEGATIVE_INFINITY;
      cachedView = undefined;
      publish();
    },
    resolve(request) {
      commitPending(true);
      const range: ResolvedIndexRange = request.xDomain
        ? resolveDomainIndexRange(xValues, request.xDomain)
        : resolveFocusIndexRange(
          xValues.length,
          request.focus,
          request.snapToIndices === true,
          request.dataFocusAxis
        );
      const { start, end, visibleStart, visibleEnd, visibleX } = range;
      const budget = resolveBudget(mode, request, maxRawPointsPerPixel);

      if (
        cachedView &&
        cachedView.version === version &&
        cachedView.mode === mode &&
        cachedView.start === start &&
        cachedView.end === end &&
        cachedView.budget === budget
      ) {
        return {
          data: cachedView.data,
          domain: resolveDomain(mode, xValues, start, end, visibleStart, visibleEnd, hasSubMinuteTimestamps(), visibleX)
        };
      }

      const data = resolveViewData(mode, xValues, yValues, seriesValues, levels, start, end, budget, request.includeContinuityPoints === true, hasSeries);
      cachedView = { version, mode, start, end, budget, data };

      return {
        data,
        domain: resolveDomain(mode, xValues, start, end, visibleStart, visibleEnd, hasSubMinuteTimestamps(), visibleX)
      };
    },
    subscribe(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    }
  };

  return source;

  function appendRawPoint(point: readonly [number, number] | LodPointInput): void {
    const x = isTuplePoint(point) ? point[0] : point.x;
    const y = isTuplePoint(point) ? point[1] : point.y;
    const series = isTuplePoint(point) ? undefined : point.series;

    appendRawValues(x, y, series);
  }

  function appendRawValues(x: number, y: number, series: string | number | undefined): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return;
    }

    if (y < yMin) {
      yMin = y;
    }
    if (y > yMax) {
      yMax = y;
    }

    xValues.push(x);
    yValues.push(y);
    seriesValues.push(series);

    if (series !== undefined && !hasSeries) {
      hasSeries = true;
      // Existing level buckets predate series support, so rebuild them with per-series summaries.
      if (xValues.length > 1) {
        rebuildLevels();
      }
    }
  }

  function queueCommit(startIndex: number): void {
    if (pendingCommitStart === undefined) {
      pendingCommitStart = startIndex;
    }

    if (bufferAppends) {
      scheduleFlush();
      return;
    }

    commitPending(true);
  }

  function scheduleFlush(): void {
    if (flushFrame !== undefined || flushTimer !== undefined) {
      return;
    }

    if (typeof requestAnimationFrame === "function") {
      flushFrame = requestAnimationFrame(() => {
        flushFrame = undefined;
        commitPending(true);
      });
      return;
    }

    flushTimer = setTimeout(() => {
      flushFrame = undefined;
      flushTimer = undefined;
      commitPending(true);
    }, 16);
  }

  function cancelScheduledFlush(): void {
    if (flushFrame !== undefined) {
      cancelAnimationFrame(flushFrame);
      flushFrame = undefined;
    }
    if (flushTimer !== undefined) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
  }

  function commitPending(forcePublish: boolean): void {
    if (pendingCommitStart === undefined) {
      return;
    }

    const startIndex = pendingCommitStart;
    const endIndex = xValues.length;
    pendingCommitStart = undefined;

    if (endIndex > startIndex) {
      updateLevels(startIndex, endIndex);
      invalidateResolvedBucketCaches(startIndex, endIndex);
    }

    if (forcePublish) {
      publish();
    }
  }

  function publish(): void {
    version += 1;
    cachedView = undefined;
    notifyListeners(listeners);
  }

  function hasSubMinuteTimestamps(): boolean {
    if (cachedSubMinuteTimestampsVersion !== version) {
      cachedSubMinuteTimestamps = seriesHasSubMinuteTimestamps(xValues);
      cachedSubMinuteTimestampsVersion = version;
    }

    return cachedSubMinuteTimestamps;
  }

  /**
   * Batch-update the level tree for newly appended indices [startIndex, endIndex).
   *
   * Level 0 gets one bucket per new index. Each higher level only updates the
   * parent buckets that cover the affected range, merging from their two children.
   * Total work is O(M) for M new points, regardless of existing dataset size.
   */
  function updateLevels(startIndex: number, endIndex: number): void {
    const totalLength = xValues.length;
    if (totalLength === 0) {
      return;
    }

    let bucketSize = MIN_STORED_BUCKET_SIZE;
    let level = MIN_STORED_LOD_LEVEL;

    while (bucketSize / 2 <= totalLength) {
      const levelBuckets = levels[level] ?? [];
      levels[level] = levelBuckets;

      const firstAffected = Math.floor(startIndex / bucketSize);
      const lastAffected = Math.floor((endIndex - 1) / bucketSize);

      for (let bucketIndex = firstAffected; bucketIndex <= lastAffected; bucketIndex += 1) {
        if (level === MIN_STORED_LOD_LEVEL) {
          const bucketStart = bucketIndex * bucketSize;
          const bucketEnd = Math.min(totalLength, bucketStart + bucketSize);
          if (bucketEnd > bucketStart) {
            levelBuckets[bucketIndex] = summarizeBucket(
              xValues,
              yValues,
              seriesValues,
              bucketStart,
              bucketEnd,
              hasSeries
            );
          }
        } else {
          const childIndex = bucketIndex * 2;
          const first = levels[level - 1]?.[childIndex];
          const second = levels[level - 1]?.[childIndex + 1];

          if (!first) {
            continue;
          }

          levelBuckets[bucketIndex] = second ? mergeBuckets(first, second) : cloneBucket(first);
        }
      }

      bucketSize *= 2;
      level += 1;
    }
  }

  function invalidateResolvedBucketCaches(startIndex: number, endIndex: number): void {
    for (let level = 0; level < MIN_STORED_LOD_LEVEL; level += 1) {
      const levelBuckets = levels[level];
      if (!levelBuckets) {
        continue;
      }

      const bucketSize = 2 ** level;
      const firstAffected = Math.floor(startIndex / bucketSize);
      const lastAffected = Math.floor((endIndex - 1) / bucketSize);

      for (let bucketIndex = firstAffected; bucketIndex <= lastAffected; bucketIndex += 1) {
        delete levelBuckets[bucketIndex];
      }
    }
  }


  function rebuildLevels(): void {
    levels.length = 0;
    if (xValues.length === 0) {
      return;
    }

    updateLevels(0, xValues.length);
  }
}

function resolveDomainIndexRange(
  xValues: readonly number[],
  domain: readonly [number, number]
): ResolvedIndexRange {
  const length = xValues.length;
  if (length <= 0) {
    return { start: 0, end: 0, visibleStart: 0, visibleEnd: 0, visibleX: domain };
  }

  const min = Math.min(domain[0], domain[1]);
  const max = Math.max(domain[0], domain[1]);
  const start = Math.max(0, Math.min(length - 1, lowerBound(xValues, min)));
  const end = Math.max(start + 1, Math.min(length, upperBound(xValues, max)));

  return {
    start,
    end,
    visibleStart: indexForX(xValues, min),
    visibleEnd: indexForX(xValues, max) + 1,
    visibleX: [min, max]
  };
}

function lowerBound(values: readonly number[], target: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((values[mid] ?? 0) < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(values: readonly number[], target: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((values[mid] ?? 0) <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function indexForX(values: readonly number[], target: number): number {
  if (values.length <= 1) {
    return 0;
  }

  const right = Math.max(1, Math.min(values.length - 1, lowerBound(values, target)));
  const left = right - 1;
  const x0 = values[left] ?? target;
  const x1 = values[right] ?? x0;
  const span = x1 - x0;

  if (!Number.isFinite(span) || span === 0) {
    return left;
  }

  return left + (target - x0) / span;
}

function isTuplePoint(point: readonly [number, number] | LodPointInput): point is readonly [number, number] {
  return Array.isArray(point);
}

function resolveDomain(
  mode: LodSeriesMode,
  xValues: readonly number[],
  start: number,
  end: number,
  visibleStart: number,
  visibleEnd: number,
  hasSubMinuteTimestamps: boolean,
  overrideVisibleX?: readonly [number, number]
): {
  x: readonly [number, number];
  startIndex: number;
  endIndex: number;
  visibleStart: number;
  visibleEnd: number;
  visibleX?: readonly [number, number];
  totalLength: number;
} {
  const lastIndex = Math.max(start, end - 1);
  const xStart = xValues[start] ?? 0;
  const xEnd = xValues[lastIndex] ?? xStart;
  const visibleX = overrideVisibleX ?? (mode === "bar"
    ? resolveVisibleBarXDomain(xValues, visibleStart, visibleEnd)
    : resolveVisibleLineXDomain(xValues, visibleStart, visibleEnd));

  return {
    x: [xStart, xEnd],
    startIndex: start,
    endIndex: end,
    visibleStart,
    visibleEnd,
    ...(visibleX ? { visibleX } : {}),
    ...(hasSubMinuteTimestamps ? { timeHasSubMinutePrecision: true } : {}),
    totalLength: xValues.length
  };
}

function seriesHasSubMinuteTimestamps(xValues: readonly number[]): boolean {
  if (xValues.length === 0) {
    return false;
  }

  const sampleCount = Math.min(64, xValues.length);
  const step = Math.max(1, Math.floor((xValues.length - 1) / Math.max(1, sampleCount - 1)));

  for (let index = 0; index < xValues.length; index += step) {
    const time = xValues[index] ?? Number.NaN;

    if (!Number.isFinite(time)) {
      continue;
    }

    const date = new Date(time);

    if (date.getUTCSeconds() !== 0 || date.getUTCMilliseconds() !== 0) {
      return true;
    }
  }

  return false;
}

function resolveVisibleBarXDomain(
  xValues: readonly number[],
  visibleStart: number,
  visibleEnd: number
): readonly [number, number] | undefined {
  if (xValues.length === 0) {
    return undefined;
  }

  return [
    interpolateXBoundary(xValues, visibleStart - 0.5),
    interpolateXBoundary(xValues, visibleEnd - 0.5)
  ];
}

function resolveVisibleLineXDomain(
  xValues: readonly number[],
  visibleStart: number,
  visibleEnd: number
): readonly [number, number] | undefined {
  if (xValues.length === 0) {
    return undefined;
  }

  return [
    interpolateXBoundary(xValues, visibleStart),
    interpolateXBoundary(xValues, Math.max(visibleStart, visibleEnd - 1))
  ];
}

function interpolateXBoundary(xValues: readonly number[], index: number): number {
  if (xValues.length === 1) {
    return xValues[0] ?? 0;
  }

  const firstStep = (xValues[1] ?? xValues[0] ?? 0) - (xValues[0] ?? 0);
  const lastStep = (xValues[xValues.length - 1] ?? 0) - (xValues[xValues.length - 2] ?? 0);

  if (index <= 0) {
    return (xValues[0] ?? 0) + index * firstStep;
  }

  if (index >= xValues.length - 1) {
    return (xValues[xValues.length - 1] ?? 0) + (index - (xValues.length - 1)) * lastStep;
  }

  const left = Math.floor(index);
  const right = left + 1;
  const t = index - left;

  return (xValues[left] ?? 0) + ((xValues[right] ?? xValues[left] ?? 0) - (xValues[left] ?? 0)) * t;
}

function resolveBudget(mode: LodSeriesMode, request: DataSourceResolveRequest, maxRawPointsPerPixel: number): number {
  const width = Math.max(1, Math.ceil(request.plotArea.width));

  if (!request.renderDistance.enabled) {
    return Number.MAX_SAFE_INTEGER;
  }

  if (mode === "point") {
    const cellSize = Math.max(1, request.renderDistance.pointCellSize);
    const height = Math.max(1, Math.ceil(request.plotArea.height));

    return Math.max(1, Math.ceil(width / cellSize) * Math.ceil(height / cellSize));
  }

  if (mode === "bar") {
    return width * 2;
  }

  // Cap at the pixel-aware lineSamplesPerPixel if available, falling back to maxRawPointsPerPixel.
  const samplesPerPixel = request.renderDistance.lineSamplesPerPixel ?? maxRawPointsPerPixel;
  return Math.max(1, Math.ceil(width * samplesPerPixel));
}

function resolveViewData(
  mode: LodSeriesMode,
  xValues: readonly number[],
  yValues: readonly number[],
  seriesValues: readonly (string | number | undefined)[],
  levels: Bucket[][],
  start: number,
  end: number,
  budget: number,
  includeContinuityPoints: boolean,
  hasSeries: boolean
): readonly LodPoint[] {
  const count = end - start;

  if (count <= 0) {
    return [];
  }

  if (count <= budget) {
    const continuity = includeContinuityPoints ? 2 : 0;
    return rawPoints(
      xValues,
      yValues,
      seriesValues,
      Math.max(0, start - continuity),
      Math.min(xValues.length, end + continuity)
    );
  }

  const level = Math.max(0, Math.ceil(Math.log2(Math.max(1, count / budget))));
  const bucketSize = 2 ** level;
  
  let lodStart = start;
  let lodEnd = end;
  const rawHeadPoints: LodPoint[] = [];
  const rawTailPoints: LodPoint[] = [];

  if (mode === "line") {
    const headEnd = Math.min(end, Math.ceil(start / bucketSize) * bucketSize);
    if (headEnd > start) {
      lodStart = headEnd;
      rawHeadPoints.push(...rawPoints(xValues, yValues, seriesValues, start, headEnd));
    }
    
    const tailStart = Math.max(lodStart, Math.floor((end - 1) / bucketSize) * bucketSize);
    if (tailStart < end) {
      lodEnd = tailStart;
      rawTailPoints.push(...rawPoints(xValues, yValues, seriesValues, tailStart, end));
    }
  }

  const buckets = resolveBuckets(xValues, yValues, seriesValues, levels, level, bucketSize, lodStart, lodEnd, hasSeries);

  if (mode === "bar") {
    return buckets.flatMap(bucketToBarPoints);
  }

  if (mode === "point") {
    return buckets.map(bucketToPoint);
  }

  const points: LodPoint[] = [];

  points.push(...rawHeadPoints);
  
  for (const bucket of buckets) {
    appendBucketLinePoints(points, bucket);
  }
  
  points.push(...rawTailPoints);

  if (!includeContinuityPoints) {
    return points;
  }

  const before = start > 0 ? rawPoints(xValues, yValues, seriesValues, Math.max(0, start - 2), start) : [];
  const after = end < xValues.length ? rawPoints(xValues, yValues, seriesValues, end, Math.min(xValues.length, end + 2)) : [];

  return [...before, ...points, ...after];
}

function resolveBuckets(
  xValues: readonly number[],
  yValues: readonly number[],
  seriesValues: readonly (string | number | undefined)[],
  levels: Bucket[][],
  level: number,
  bucketSize: number,
  start: number,
  end: number,
  hasSeries: boolean
): readonly Bucket[] {
  if (!levels[level]) {
    levels[level] = [];
  }
  const levelBuckets = levels[level]!;
  const firstBucket = Math.floor(start / bucketSize);
  const lastBucketExclusive = Math.ceil(end / bucketSize);
  const buckets: Bucket[] = [];

  for (let bucketIndex = firstBucket; bucketIndex < lastBucketExclusive; bucketIndex += 1) {
    const bucketStart = bucketIndex * bucketSize;
    const bucketEnd = Math.min(xValues.length, bucketStart + bucketSize);

    if (bucketEnd <= start || bucketStart >= end) {
      continue;
    }

    if (bucketStart < start || bucketEnd > end) {
      buckets.push(summarizeBucket(xValues, yValues, seriesValues, Math.max(start, bucketStart), Math.min(end, bucketEnd), hasSeries));
      continue;
    }

    const bucket = levelBuckets[bucketIndex];
    if (bucket) {
      buckets.push(bucket);
    } else {
      const newBucket = summarizeBucket(xValues, yValues, seriesValues, bucketStart, bucketEnd, hasSeries);
      levelBuckets[bucketIndex] = newBucket;
      buckets.push(newBucket);
    }
  }

  return buckets;
}

function resolveYExtentForDomain(
  xValues: readonly number[],
  yValues: readonly number[],
  seriesValues: readonly (string | number | undefined)[],
  levels: Bucket[][],
  domain: readonly [number, number],
  hasSeries: boolean,
  hiddenSeries: ReadonlySet<string | number> | undefined
): readonly [number, number] | undefined {
  if (xValues.length === 0) {
    return undefined;
  }

  const range = resolveDomainIndexRange(xValues, domain);
  const count = range.end - range.start;
  if (count <= 0) {
    return undefined;
  }

  const targetBucketCount = 64;
  const level = Math.max(
    MIN_STORED_LOD_LEVEL,
    Math.ceil(Math.log2(Math.max(1, count / targetBucketCount)))
  );
  const bucketSize = 2 ** level;
  const buckets = resolveBuckets(
    xValues,
    yValues,
    seriesValues,
    levels,
    level,
    bucketSize,
    range.start,
    range.end,
    hasSeries
  );

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (const bucket of buckets) {
    const extent = bucketVisibleYExtent(bucket, hiddenSeries);
    if (!extent) {
      continue;
    }
    min = Math.min(min, extent[0]);
    max = Math.max(max, extent[1]);
  }

  return Number.isFinite(min) && Number.isFinite(max) ? [min, max] : undefined;
}

function bucketVisibleYExtent(
  bucket: Bucket,
  hiddenSeries: ReadonlySet<string | number> | undefined
): readonly [number, number] | undefined {
  if (!hiddenSeries || hiddenSeries.size === 0) {
    return [bucket.minY, bucket.maxY];
  }

  const seriesBuckets = bucket.seriesBuckets ?? (bucket.series !== undefined ? [bucket as SeriesBucket] : undefined);
  if (!seriesBuckets) {
    return [bucket.minY, bucket.maxY];
  }

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (const seriesBucket of seriesBuckets) {
    const key = seriesBucket.series;
    if (key !== undefined && (hiddenSeries.has(key) || hiddenSeries.has(String(key)))) {
      continue;
    }
    min = Math.min(min, seriesBucket.minY);
    max = Math.max(max, seriesBucket.maxY);
  }

  return Number.isFinite(min) && Number.isFinite(max) ? [min, max] : undefined;
}

function rawPoints(
  xValues: readonly number[],
  yValues: readonly number[],
  seriesValues: readonly (string | number | undefined)[],
  start: number,
  end: number
): readonly LodPoint[] {
  const points: LodPoint[] = [];

  for (let index = start; index < end; index += 1) {
    const x = xValues[index] ?? 0;
    const y = yValues[index] ?? 0;
    const series = seriesValues[index];

    points.push({
      x,
      y,
      ...(series !== undefined ? { series } : {}),
      index,
      count: 1,
      firstY: y,
      lastY: y,
      minY: y,
      maxY: y
    });
  }

  return points;
}

function summarizeBucket(
  xValues: readonly number[],
  yValues: readonly number[],
  seriesValues: readonly (string | number | undefined)[],
  start: number,
  end: number,
  includeSeries: boolean
): Bucket {
  let minIndex = start;
  let maxIndex = start;
  let minY = yValues[start] ?? 0;
  let maxY = minY;

  for (let index = start + 1; index < end; index += 1) {
    const y = yValues[index] ?? 0;

    if (y < minY) {
      minY = y;
      minIndex = index;
    }

    if (y > maxY) {
      maxY = y;
      maxIndex = index;
    }
  }

  const lastIndex = Math.max(start, end - 1);

  const bucket: Bucket = {
    firstIndex: start,
    lastIndex,
    count: Math.max(0, end - start),
    firstX: xValues[start] ?? 0,
    firstY: yValues[start] ?? 0,
    lastX: xValues[lastIndex] ?? xValues[start] ?? 0,
    lastY: yValues[lastIndex] ?? yValues[start] ?? 0,
    minIndex,
    minX: xValues[minIndex] ?? xValues[start] ?? 0,
    minY,
    maxIndex,
    maxX: xValues[maxIndex] ?? xValues[start] ?? 0,
    maxY
  };

  if (includeSeries) {
    bucket.seriesBuckets = summarizeSeriesBuckets(xValues, yValues, seriesValues, start, end);
  }

  return bucket;
}

function pointBucket(
  index: number,
  x: number,
  y: number,
  series: string | number | undefined,
  includeSeries: boolean
): Bucket {
  const bucket: Bucket = {
    firstIndex: index,
    lastIndex: index,
    count: 1,
    firstX: x,
    firstY: y,
    lastX: x,
    lastY: y,
    minIndex: index,
    minX: x,
    minY: y,
    maxIndex: index,
    maxX: x,
    maxY: y
  };

  if (includeSeries && series !== undefined) {
    bucket.series = series;
  }

  return bucket;
}

function mergeBuckets(first: Bucket, second: Bucket): Bucket {
  const bucket = { ...first };

  bucket.lastIndex = second.lastIndex;
  bucket.lastX = second.lastX;
  bucket.lastY = second.lastY;
  bucket.count = first.count + second.count;

  if (second.minY < bucket.minY) {
    bucket.minIndex = second.minIndex;
    bucket.minX = second.minX;
    bucket.minY = second.minY;
  }

  if (second.maxY > bucket.maxY) {
    bucket.maxIndex = second.maxIndex;
    bucket.maxX = second.maxX;
    bucket.maxY = second.maxY;
  }

  if (first.seriesBuckets || second.seriesBuckets || first.series !== undefined || second.series !== undefined) {
    bucket.seriesBuckets = mergeSeriesBuckets(bucketSeriesMap(first), bucketSeriesMap(second));
    delete bucket.series;
  }

  return bucket;
}

function summarizeSeriesBuckets(
  xValues: readonly number[],
  yValues: readonly number[],
  seriesValues: readonly (string | number | undefined)[],
  start: number,
  end: number
): SeriesBucket[] {
  const seriesBuckets: SeriesBucket[] = [];

  for (let index = start; index < end; index += 1) {
    const x = xValues[index] ?? 0;
    const y = yValues[index] ?? 0;
    const series = seriesValues[index];
    const existing = findSeriesBucket(seriesBuckets, series);

    if (!existing) {
      const bucket = pointBucket(index, x, y, series, false);
      seriesBuckets.push({ ...bucket, series });
      continue;
    }

    existing.lastIndex = index;
    existing.lastX = x;
    existing.lastY = y;
    existing.count += 1;

    if (y < existing.minY) {
      existing.minIndex = index;
      existing.minX = x;
      existing.minY = y;
    }

    if (y > existing.maxY) {
      existing.maxIndex = index;
      existing.maxX = x;
      existing.maxY = y;
    }
  }

  return seriesBuckets;
}

function mergeSeriesBuckets(
  first: readonly SeriesBucket[] | undefined,
  second: readonly SeriesBucket[] | undefined
): SeriesBucket[] {
  const merged: SeriesBucket[] = [];

  for (const bucket of first ?? []) {
    merged.push({ ...bucket });
  }

  for (const bucket of second ?? []) {
    const existing = findSeriesBucket(merged, bucket.series);
    if (!existing) {
      merged.push({ ...bucket });
      continue;
    }

    existing.lastIndex = bucket.lastIndex;
    existing.lastX = bucket.lastX;
    existing.lastY = bucket.lastY;
    existing.count += bucket.count;

    if (bucket.minY < existing.minY) {
      existing.minIndex = bucket.minIndex;
      existing.minX = bucket.minX;
      existing.minY = bucket.minY;
    }

    if (bucket.maxY > existing.maxY) {
      existing.maxIndex = bucket.maxIndex;
      existing.maxX = bucket.maxX;
      existing.maxY = bucket.maxY;
    }
  }

  return merged;
}

function bucketSeriesMap(bucket: Bucket): SeriesBucket[] | undefined {
  if (bucket.seriesBuckets) {
    return bucket.seriesBuckets;
  }

  if (bucket.series === undefined) {
    return undefined;
  }

  return [{ ...bucket, series: bucket.series }];
}

function cloneBucket(bucket: Bucket): Bucket {
  return {
    ...bucket,
    ...(bucket.seriesBuckets ? { seriesBuckets: bucket.seriesBuckets.map((seriesBucket) => ({ ...seriesBucket })) } : {})
  };
}

function findSeriesBucket(
  buckets: readonly SeriesBucket[],
  series: string | number | undefined
): SeriesBucket | undefined {
  for (let index = 0; index < buckets.length; index += 1) {
    const bucket = buckets[index];
    if (bucket?.series === series) {
      return bucket;
    }
  }
  return undefined;
}

function bucketToBarPoints(bucket: Bucket): LodPoint[] {
  const base: Omit<LodPoint, "y"> = {
    x: bucket.firstX,
    index: bucket.firstIndex,
    count: bucket.count,
    firstY: bucket.firstY,
    lastY: bucket.lastY,
    minY: bucket.minY,
    maxY: bucket.maxY
  };

  if (bucket.minY < 0 && bucket.maxY > 0) {
    return [
      { ...base, y: bucket.minY },
      { ...base, y: bucket.maxY }
    ];
  }

  if (bucket.maxY <= 0) {
    return [{ ...base, y: bucket.minY }];
  }

  return [{ ...base, y: bucket.maxY }];
}

function bucketToPoint(bucket: Bucket): LodPoint {
  return {
    x: (bucket.firstX + bucket.lastX) / 2,
    y: (bucket.minY + bucket.maxY) / 2,
    index: bucket.firstIndex,
    count: bucket.count,
    firstY: bucket.firstY,
    lastY: bucket.lastY,
    minY: bucket.minY,
    maxY: bucket.maxY
  };
}

function appendBucketLinePoints(points: LodPoint[], bucket: Bucket): void {
  if (bucket.seriesBuckets) {
    const start = points.length;

    for (const seriesBucket of bucket.seriesBuckets) {
      appendSeriesBucketLinePoints(points, seriesBucket);
    }

    // There are at most four retained points per series. Insertion sort avoids
    // allocating a short-lived array for every LOD bucket.
    for (let index = start + 1; index < points.length; index += 1) {
      const point = points[index] as LodPoint;
      let cursor = index - 1;

      while (cursor >= start && (points[cursor] as LodPoint).index > point.index) {
        points[cursor + 1] = points[cursor] as LodPoint;
        cursor -= 1;
      }

      points[cursor + 1] = point;
    }
    return;
  }

  if (bucket.series !== undefined) {
    appendSeriesBucketLinePoints(points, { ...bucket, series: bucket.series });
    return;
  }

  appendSeriesBucketLinePoints(points, bucket);
}

function appendSeriesBucketLinePoints(
  points: LodPoint[],
  bucket: Bucket | SeriesBucket,
): void {
  const candidates: [number, number, number][] = [
    [bucket.firstIndex, bucket.firstX, bucket.firstY],
    [bucket.minIndex, bucket.minX, bucket.minY],
    [bucket.maxIndex, bucket.maxX, bucket.maxY],
    [bucket.lastIndex, bucket.lastX, bucket.lastY]
  ];

  candidates.sort((left, right) => left[0] - right[0]);
  let previousIndex = -1;
  const series = "series" in bucket ? bucket.series : undefined;

  for (const [index, x, y] of candidates) {
    if (index === previousIndex) {
      continue;
    }

    previousIndex = index;
    points.push({
      x,
      y,
      ...(series !== undefined ? { series } : {}),
      index,
      count: bucket.count,
      firstY: bucket.firstY,
      lastY: bucket.lastY,
      minY: bucket.minY,
      maxY: bucket.maxY
    });
  }
}
