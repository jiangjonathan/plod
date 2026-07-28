import type { DataSource } from "./types";
import type { LodPoint, LodPointInput } from "./lodSeries";
import { notifyListeners } from "./listeners";
import {
  getPointArrayDirtyStart,
  getPointCount,
  setPointArrayDirtyStart,
  setPointArrayMetadata,
  setScatterViewMetadata
} from "./metadata";

export type ScatterSeriesOptions = {
  xDomain?: readonly [number, number];
  yDomain?: readonly [number, number];
};

export type ScatterSeries = DataSource<LodPoint> & {
  append(point: readonly [number, number] | LodPointInput): void;
  appendIterable(points: Iterable<readonly [number, number] | LodPointInput>): void;
  clear(): void;
  readonly length: number;
};

export function createScatterSeries(options: ScatterSeriesOptions = {}): ScatterSeries {
  const xValues: number[] = [];
  const yValues: number[] = [];
  const seriesValues: (string | number | undefined)[] = [];
  const categoryIdValues: number[] = [];
  const categoryMap = new Map<string | number, number>();
  const listeners = new Set<() => void>();
  const rawPointsKey = {}; // Stable cache key for the lifetime of this series
  let version = 0;
  let xExtent: readonly [number, number] | undefined = options.xDomain;
  let yExtent: readonly [number, number] | undefined = options.yDomain;
  let cachedRawPoints: Float32Array | undefined;
  let cachedCategoryIds: Float32Array | undefined;
  let hasCategories = false;
  let cachedView: {
    version: number;
    signature: string;
    data: readonly LodPoint[];
    xDomain: readonly [number, number];
    yDomain: readonly [number, number];
  } | undefined;

  function getRawPoints(): Float32Array {
    const count = xValues.length;
    const requiredLength = count * 2;
    let arr = cachedRawPoints;
    let copiedPoints = arr ? getPointCount(arr) ?? 0 : 0;

    if (!arr || arr.length < requiredLength) {
      const nextLength = growFloat32Length(arr?.length ?? 0, requiredLength);
      const next = new Float32Array(nextLength);

      if (arr) {
        next.set(arr.subarray(0, Math.min(arr.length, requiredLength)));
      }

      arr = next;
      cachedRawPoints = arr;
      copiedPoints = Math.min(copiedPoints, count);
      setPointArrayDirtyStart(arr, 0);
    }

    for (let i = copiedPoints; i < count; i += 1) {
      arr[i * 2] = xValues[i] ?? 0;
      arr[i * 2 + 1] = yValues[i] ?? 0;
    }

    setPointArrayMetadata(arr, {
      __pointCount: count,
      __version: version,
      ...(xExtent ? { __xDomain: xExtent } : {}),
      ...(yExtent ? { __yDomain: yExtent } : {})
    });

    return arr;
  }

  function getRawCategoryIds(): Float32Array | undefined {
    if (!hasCategories) {
      return undefined;
    }

    const count = categoryIdValues.length;
    let arr = cachedCategoryIds;
    let copiedCategories = arr ? getPointCount(arr) ?? 0 : 0;

    if (!arr || arr.length < count) {
      const next = new Float32Array(growFloat32Length(arr?.length ?? 0, count));

      if (arr) {
        next.set(arr.subarray(0, Math.min(arr.length, count)));
      }

      arr = next;
      cachedCategoryIds = arr;
      copiedCategories = Math.min(copiedCategories, count);
    }

    for (let i = copiedCategories; i < count; i += 1) {
      arr[i] = categoryIdValues[i] ?? 0;
    }

    setPointArrayMetadata(arr, {
      __pointCount: count,
      __version: version,
      __categoryCount: categoryMap.size
    });

    return arr;
  }

  return {
    kind: "data-source",
    get version() {
      return version;
    },
    get length() {
      return xValues.length;
    },
    get xExtent() {
      return xValues.length > 0 ? xExtent : options.xDomain;
    },
    get yExtent() {
      return yValues.length > 0 ? yExtent : options.yDomain;
    },
    append(point) {
      appendPoint(point);
      publish();
    },
    appendIterable(points) {
      for (const point of points) {
        appendPoint(point);
      }
      publish();
    },
    clear() {
      xValues.length = 0;
      yValues.length = 0;
      seriesValues.length = 0;
      categoryIdValues.length = 0;
      categoryMap.clear();
      hasCategories = false;
      xExtent = options.xDomain;
      yExtent = options.yDomain;
      if (cachedRawPoints) {
        setPointArrayMetadata(cachedRawPoints, {
          __pointCount: 0,
          __dirtyStart: 0
        });
      }
      if (cachedCategoryIds) {
        setPointArrayMetadata(cachedCategoryIds, {
          __pointCount: 0
        });
      }
      publish();
    },
    resolve(request) {
      const baseXDomain = xExtent ?? [0, 1];
      const baseYDomain = yExtent ?? [0, 1];
      const xDomain = request.xDomain ?? resolveFocusedDomain(baseXDomain, request.focus?.x);
      const yDomain = request.yDomain ?? resolveFocusedDomain(baseYDomain, request.focus?.y);

      const signature = [
        xDomain[0],
        xDomain[1],
        yDomain[0],
        yDomain[1]
      ].join(":");

      if (cachedView?.version === version && cachedView.signature === signature) {
        const viewData = cachedView.data;
        const categoryIds = getRawCategoryIds();
        setScatterViewMetadata(viewData, {
          __rawPointsKey: rawPointsKey,
          __rawPoints: getRawPoints(),
          ...(categoryIds ? { __categoryIds: categoryIds } : {})
        });
        return {
          data: viewData,
          domain: {
            x: cachedView.xDomain,
            startIndex: 0,
            endIndex: xValues.length,
            visibleStart: 0,
            visibleEnd: xValues.length,
            visibleX: xDomain,
            totalLength: xValues.length
          }
        };
      }

      const data = createLazyLodPointArray(xValues, yValues, seriesValues);
      cachedView = { version, signature, data, xDomain: baseXDomain, yDomain: baseYDomain };
      const categoryIds = getRawCategoryIds();
      setScatterViewMetadata(data, {
        __rawPointsKey: rawPointsKey,
        __rawPoints: getRawPoints(),
        ...(categoryIds ? { __categoryIds: categoryIds } : {})
      });

      return {
        data,
        domain: {
          x: baseXDomain,
          y: baseYDomain,
          startIndex: 0,
          endIndex: xValues.length,
          visibleStart: 0,
          visibleEnd: xValues.length,
          visibleX: xDomain,
          totalLength: xValues.length
        }
      };
    },
    subscribe(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    }
  };

  function appendPoint(point: readonly [number, number] | LodPointInput): void {
    const x = isTuplePoint(point) ? point[0] : point.x;
    const y = isTuplePoint(point) ? point[1] : point.y;
    const series = isTuplePoint(point) ? undefined : point.series;

    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return;
    }

    xValues.push(x);
    yValues.push(y);
    seriesValues.push(series);
    categoryIdValues.push(resolveCategoryId(series));
    xExtent = expandExtent(xExtent, x);
    yExtent = expandExtent(yExtent, y);
  }

  function resolveCategoryId(series: string | number | undefined): number {
    if (series === undefined) {
      return 0;
    }

    hasCategories = true;
    let categoryId = categoryMap.get(series);

    if (categoryId === undefined) {
      categoryId = categoryMap.size;
      categoryMap.set(series, categoryId);
    }

    return categoryId;
  }

  function publish(): void {
    if (cachedRawPoints) {
      const pointCount = getPointCount(cachedRawPoints) ?? 0;
      const dirtyStart = getPointArrayDirtyStart(cachedRawPoints) || pointCount * 2;
      setPointArrayDirtyStart(cachedRawPoints, Math.min(dirtyStart, pointCount * 2));
    }
    version += 1;
    cachedView = undefined;
    notifyListeners(listeners);
  }
}

function growFloat32Length(currentLength: number, requiredLength: number): number {
  let nextLength = Math.max(2048, currentLength);

  while (nextLength < requiredLength) {
    nextLength *= 2;
  }

  return nextLength;
}

function createLazyLodPointArray(
  xValues: readonly number[],
  yValues: readonly number[],
  seriesValues: readonly (string | number | undefined)[]
): readonly LodPoint[] {
  const length = xValues.length;

  // Use a Proxy to avoid allocating 1M+ objects while remaining compatible with array iteration (for axes, transforms).
  return new Proxy([] as unknown as LodPoint[], {
    get(target, prop) {
      if (prop === "length") {
        return length;
      }
      if (prop === Symbol.iterator) {
        return function* () {
          for (let i = 0; i < length; i++) {
            const x = xValues[i] ?? 0;
            const y = yValues[i] ?? 0;
            const series = seriesValues[i];
            yield {
              x,
              y,
              index: i,
              count: 1,
              firstY: y,
              lastY: y,
              minY: y,
              maxY: y,
              ...(series !== undefined ? { series } : {})
            };
          }
        };
      }
      const index = Number(prop);
      if (!Number.isNaN(index) && index >= 0 && index < length) {
        const x = xValues[index] ?? 0;
        const y = yValues[index] ?? 0;
        const series = seriesValues[index];
        return {
          x,
          y,
          index,
          count: 1,
          firstY: y,
          lastY: y,
          minY: y,
          maxY: y,
          ...(series !== undefined ? { series } : {})
        };
      }
      return Reflect.get(target, prop);
    }
  });
}

function isTuplePoint(point: readonly [number, number] | LodPointInput): point is readonly [number, number] {
  return Array.isArray(point);
}

function resolveFocusedDomain(
  domain: readonly [number, number],
  focus: readonly [number, number] | undefined
): readonly [number, number] {
  if (!focus) {
    return domain;
  }

  const start = clamp01(Math.min(focus[0], focus[1]));
  const end = clamp01(Math.max(focus[0], focus[1]));

  if (end - start >= 0.999) {
    return domain;
  }

  const span = domain[1] - domain[0] || 1;

  return [
    domain[0] + span * start,
    domain[0] + span * end
  ];
}

function expandExtent(extent: readonly [number, number] | undefined, value: number): readonly [number, number] {
  return extent ? [Math.min(extent[0], value), Math.max(extent[1], value)] : [value, value];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}
