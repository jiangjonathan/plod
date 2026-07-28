import type { DataSource } from "./types";
import { resolveFocusIndexRange } from "./focusRange";
import type { Accessor } from "../marks/types";
import { readAccessor } from "../marks/accessor";
import { notifyListeners } from "./listeners";

export type BarSeriesLayout = "grouped" | "stacked";
/** @deprecated Use BarSeriesLayout. */
export type GroupedBarLodMode = BarSeriesLayout;

export type GroupedBarPoint = {
  group: string | number;
  groupIndex: number;
  stackGroup?: string | number;
  series: string | number;
  value: number;
  count: number;
  startGroupIndex: number;
  endGroupIndex: number;
};

export type GroupedBarSeriesOptions<TDatum> = {
  data: readonly TDatum[];
  group: Accessor<TDatum, string | number>;
  stackGroup?: Accessor<TDatum, string | number>;
  series: Accessor<TDatum, string | number>;
  value: Accessor<TDatum, number>;
  seriesOrder?: readonly (string | number)[];
  layout?: BarSeriesLayout;
  /** @deprecated Use layout. */
  mode?: GroupedBarLodMode;
  maxGroupsPerPixel?: number;
  lineDecimation?: boolean;
};

export type GroupedBarSeries = DataSource<GroupedBarPoint> & {
  readonly valueExtent: readonly [number, number];
  readonly stackedValueExtent: readonly [number, number];
  readonly seriesOrder: readonly (string | number)[];
  append(datum: unknown): void;
  appendBatch(data: readonly unknown[]): void;
  appendIterable(data: Iterable<unknown>): void;
  clear(): void;
};

type GroupBucket = {
  key: string | number;
  index: number;
  values: Map<string | number, number>;
  valuesByStack: Map<string | number, Map<string | number, number>>;
};

const DEFAULT_STACK_KEY = "__default_stack__";

export function createGroupedBarSeries<TDatum>(options: GroupedBarSeriesOptions<TDatum>): GroupedBarSeries {
  const mode = options.layout ?? options.mode ?? "grouped";
  const maxGroupsPerPixel = Math.max(0.25, options.maxGroupsPerPixel ?? 2);
  const groups: GroupBucket[] = [];
  const groupsByKey = new Map<string | number, GroupBucket>();
  const seriesOrder: (string | number)[] = [];
  const seenSeries = new Set<string | number>();
  const seriesIndexMap = new Map<string | number, number>();
  /** Per-series contiguous value arrays for fast LOD scanning. seriesGroupValues[seriesIdx][groupIndex] = value. */
  const seriesGroupValues: (number | undefined)[][] = [];
  const stackOrder: (string | number)[] = [];
  const seenStacks = new Set<string | number>();
  let cachedView: {
    start: number;
    end: number;
    groupBudget: number;
    mode: BarSeriesLayout;
    data: readonly GroupedBarPoint[];
  } | undefined;
  let version = 1;
  let rowCount = 0;
  let valueCount = 0;
  let valueExtent: readonly [number, number] = [0, 0];
  let stackedValueExtent: readonly [number, number] = [0, 0];
  const listeners = new Set<() => void>();

  for (const series of options.seriesOrder ?? []) {
    if (!seenSeries.has(series)) {
      seriesIndexMap.set(series, seriesOrder.length);
      seenSeries.add(series);
      seriesOrder.push(series);
    }
  }

  appendRows(options.data, false);

  return {
    kind: "data-source",
    get version() {
      return version;
    },
    get length() {
      return groups.length;
    },
    get valueExtent() {
      return valueExtent;
    },
    get stackedValueExtent() {
      return stackedValueExtent;
    },
    get seriesOrder() {
      return seriesOrder;
    },
    append(datum) {
      appendRows([datum as TDatum], true);
    },
    appendBatch(data) {
      appendRows(data as readonly TDatum[], true);
    },
    appendIterable(data) {
      appendRows(data as Iterable<TDatum>, true);
    },
    clear() {
      groups.length = 0;
      groupsByKey.clear();
      seriesOrder.length = 0;
      seenSeries.clear();
      seriesIndexMap.clear();
      seriesGroupValues.length = 0;
      stackOrder.length = 0;
      seenStacks.clear();
      rowCount = 0;
      valueCount = 0;
      valueExtent = [0, 0];
      stackedValueExtent = [0, 0];

      for (const series of options.seriesOrder ?? []) {
        if (!seenSeries.has(series)) {
          seriesIndexMap.set(series, seriesOrder.length);
          seenSeries.add(series);
          seriesOrder.push(series);
        }
      }

      publish();
    },
    resolve(request) {
      const range = resolveFocusIndexRange(groups.length, request.focus, request.snapToIndices === true, request.dataFocusAxis);
      const horizontalBarLanes = mode === "grouped"
        ? Math.max(1, seriesOrder.length)
        : Math.max(1, stackOrder.length);
      const groupBudget = request.renderDistance.enabled
        ? Math.max(1, Math.floor((request.plotArea.width * maxGroupsPerPixel) / horizontalBarLanes))
        : Number.MAX_SAFE_INTEGER;
      const data = cachedView &&
        cachedView.start === range.start &&
        cachedView.end === range.end &&
        cachedView.groupBudget === groupBudget &&
        cachedView.mode === mode
        ? cachedView.data
        : resolveRows(groups, seriesOrder, stackOrder, range.start, range.end, groupBudget, mode, options.lineDecimation, seriesGroupValues);

      cachedView = {
        start: range.start,
        end: range.end,
        groupBudget,
        mode,
        data
      };

      return {
        data,
        domain: {
          x: [range.start + 1, range.end],
          startIndex: range.start,
          endIndex: range.end,
          visibleStart: range.visibleStart,
          visibleEnd: range.visibleEnd,
          totalLength: groups.length
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

  function appendRows(rows: Iterable<TDatum>, notify: boolean): void {
    let changed = false;

    for (const datum of rows) {
      changed = ingestDatum(datum) || changed;
    }

    if (changed) {
      if (notify) {
        publish();
      }
    }
  }

  function ingestDatum(datum: TDatum): boolean {
    const index = rowCount;
    const groupKey = readAccessor(options.group, datum, index);
    const stackKey = options.stackGroup ? readAccessor(options.stackGroup, datum, index) : DEFAULT_STACK_KEY;
    const seriesKey = readAccessor(options.series, datum, index);
    const value = readAccessor(options.value, datum, index);
    rowCount += 1;

    if (!Number.isFinite(value)) {
      return false;
    }

    valueCount += 1;

    let group = groupsByKey.get(groupKey);

    if (!group) {
      group = {
        key: groupKey,
        index: groups.length,
        values: new Map(),
        valuesByStack: new Map()
      };
      groupsByKey.set(groupKey, group);
      groups.push(group);
    }

    if (!seenSeries.has(seriesKey)) {
      seriesIndexMap.set(seriesKey, seriesOrder.length);
      seenSeries.add(seriesKey);
      seriesOrder.push(seriesKey);
    }

    if (!seenStacks.has(stackKey)) {
      seenStacks.add(stackKey);
      stackOrder.push(stackKey);
    }

    const nextSeriesValue = (group.values.get(seriesKey) ?? 0) + value;
    group.values.set(seriesKey, nextSeriesValue);

    // Maintain per-series contiguous array for fast LOD scanning
    const seriesIdx = seriesIndexMap.get(seriesKey)!;
    let seriesArr = seriesGroupValues[seriesIdx];
    if (!seriesArr) {
      seriesArr = [];
      seriesGroupValues[seriesIdx] = seriesArr;
    }
    seriesArr[group.index] = nextSeriesValue;
    let stackValues = group.valuesByStack.get(stackKey);

    if (!stackValues) {
      stackValues = new Map();
      group.valuesByStack.set(stackKey, stackValues);
    }

    const nextStackSeriesValue = (stackValues.get(seriesKey) ?? 0) + value;
    stackValues.set(seriesKey, nextStackSeriesValue);

    // Update running extents incrementally
    if (valueCount === 1) {
      valueExtent = [nextStackSeriesValue, nextStackSeriesValue];
    } else {
      valueExtent = [Math.min(valueExtent[0], nextStackSeriesValue), Math.max(valueExtent[1], nextStackSeriesValue)];
    }

    let positive = 0;
    let negative = 0;
    for (const val of stackValues.values()) {
      if (val >= 0) {
        positive += val;
      } else {
        negative += val;
      }
    }

    if (valueCount === 1) {
      stackedValueExtent = [Math.min(0, negative), Math.max(0, positive)];
    } else {
      stackedValueExtent = [Math.min(stackedValueExtent[0], negative), Math.max(stackedValueExtent[1], positive)];
    }

    return true;
  }

  function publish(): void {
    version += 1;
    cachedView = undefined;
    notifyListeners(listeners);
  }
}

function resolveRows(
  groups: readonly GroupBucket[],
  seriesOrder: readonly (string | number)[],
  stackOrder: readonly (string | number)[],
  start: number,
  end: number,
  groupBudget: number,
  mode: BarSeriesLayout,
  lineDecimation?: boolean,
  seriesGroupValues?: readonly (readonly (number | undefined)[])[] | undefined
): readonly GroupedBarPoint[] {
  const visibleCount = Math.max(0, end - start);
  const rows: GroupedBarPoint[] = [];

  if (visibleCount <= groupBudget) {
    for (let index = start; index < end; index += 1) {
      appendEnvelopeRows(rows, groups, index, index + 1, seriesOrder, stackOrder, mode, lineDecimation, seriesGroupValues);
    }

    return rows;
  }

  const bucketSize = Math.ceil(visibleCount / groupBudget);

  for (let bucketStart = start; bucketStart < end; bucketStart += bucketSize) {
    appendEnvelopeRows(rows, groups, bucketStart, Math.min(end, bucketStart + bucketSize), seriesOrder, stackOrder, mode, lineDecimation, seriesGroupValues);
  }

  return rows;
}

function appendEnvelopeRows(
  rows: GroupedBarPoint[],
  groups: readonly GroupBucket[],
  start: number,
  end: number,
  seriesOrder: readonly (string | number)[],
  stackOrder: readonly (string | number)[],
  mode: BarSeriesLayout,
  lineDecimation?: boolean,
  seriesGroupValues?: readonly (readonly (number | undefined)[])[] | undefined
): void {
  const count = end - start;
  const meta = {
    key: count > 1 ? `${start + 1}-${end}` : groups[start]!.key,
    index: start
  };

  if (mode === "stacked") {
    appendStackedSeriesRows(rows, groups, start, end, seriesOrder, stackOrder, meta, lineDecimation);
    return;
  }

  appendGroupedSeriesRows(rows, groups, start, end, seriesOrder, meta, lineDecimation, seriesGroupValues);
}

function pushGroupRow(
  rows: GroupedBarPoint[],
  meta: { key: string | number; index: number },
  start: number,
  end: number,
  series: string | number,
  stackGroup: string | number | undefined,
  value: number,
  allowZero?: boolean
): void {
  if (value === 0 && !allowZero) {
    return;
  }

  rows.push({
    group: meta.key,
    groupIndex: meta.index,
    ...(stackGroup !== undefined && stackGroup !== DEFAULT_STACK_KEY ? { stackGroup } : {}),
    series,
    value,
    count: end - start,
    startGroupIndex: start,
    endGroupIndex: end
  });
}

function appendGroupedSeriesRows(
  rows: GroupedBarPoint[],
  groups: readonly GroupBucket[],
  start: number,
  end: number,
  seriesOrder: readonly (string | number)[],
  meta: { key: string | number; index: number },
  lineDecimation?: boolean,
  seriesGroupValues?: readonly (readonly (number | undefined)[])[] | undefined
): void {
  for (let si = 0; si < seriesOrder.length; si += 1) {
    const series = seriesOrder[si]!;
    const fastArr = seriesGroupValues?.[si];
    let minValue = Number.POSITIVE_INFINITY;
    let maxValue = Number.NEGATIVE_INFINITY;
    let minIndex = start;
    let maxIndex = start;
    let hasValue = false;

    for (let groupIndex = start; groupIndex < end; groupIndex += 1) {
      const value = fastArr ? fastArr[groupIndex] : groups[groupIndex]!.values.get(series);

      if (value === undefined) {
        continue;
      }

      if (!hasValue) {
        hasValue = true;
        minValue = value;
        maxValue = value;
        minIndex = groupIndex;
        maxIndex = groupIndex;
      } else {
        if (value < minValue) {
          minValue = value;
          minIndex = groupIndex;
        }
        if (value > maxValue) {
          maxValue = value;
          maxIndex = groupIndex;
        }
      }
    }

    if (!hasValue) {
      continue;
    }

    if (lineDecimation && minValue !== maxValue) {
      if (minIndex < maxIndex) {
        pushGroupRow(rows, { key: meta.key, index: start }, start, end, series, undefined, minValue, true);
        pushGroupRow(rows, { key: meta.key, index: start }, start, end, series, undefined, maxValue, true);
      } else {
        pushGroupRow(rows, { key: meta.key, index: start }, start, end, series, undefined, maxValue, true);
        pushGroupRow(rows, { key: meta.key, index: start }, start, end, series, undefined, minValue, true);
      }
    } else {
      if (minValue < 0 && maxValue > 0) {
        pushGroupRow(rows, meta, start, end, series, undefined, minValue);
        pushGroupRow(rows, meta, start, end, series, undefined, maxValue);
      } else if (maxValue <= 0) {
        pushGroupRow(rows, meta, start, end, series, undefined, minValue);
      } else {
        pushGroupRow(rows, meta, start, end, series, undefined, maxValue);
      }
    }
  }
}

function appendStackedSeriesRows(
  rows: GroupedBarPoint[],
  groups: readonly GroupBucket[],
  start: number,
  end: number,
  seriesOrder: readonly (string | number)[],
  stackOrder: readonly (string | number)[],
  meta: { key: string | number; index: number },
  lineDecimation?: boolean
): void {
  for (const stackKey of stackOrder) {
    let bestPositiveIndex = start;
    let worstPositiveIndex = start;
    let bestNegativeIndex = start;
    let worstNegativeIndex = start;
    let maxPositiveTotal = Number.NEGATIVE_INFINITY;
    let minPositiveTotal = Number.POSITIVE_INFINITY;
    let minNegativeTotal = Number.POSITIVE_INFINITY;
    let maxNegativeTotal = Number.NEGATIVE_INFINITY;

    for (let groupIndex = start; groupIndex < end; groupIndex += 1) {
      const values = groups[groupIndex]!.valuesByStack.get(stackKey);

      if (!values) {
        continue;
      }

      let positiveTotal = 0;
      let negativeTotal = 0;

      for (const value of values.values()) {
        if (value >= 0) {
          positiveTotal += value;
        } else {
          negativeTotal += value;
        }
      }

      if (positiveTotal > maxPositiveTotal) {
        maxPositiveTotal = positiveTotal;
        bestPositiveIndex = groupIndex;
      }
      if (positiveTotal < minPositiveTotal && positiveTotal > 0) {
        minPositiveTotal = positiveTotal;
        worstPositiveIndex = groupIndex;
      }

      if (negativeTotal < minNegativeTotal) {
        minNegativeTotal = negativeTotal;
        bestNegativeIndex = groupIndex;
      }
      if (negativeTotal > maxNegativeTotal && negativeTotal < 0) {
        maxNegativeTotal = negativeTotal;
        worstNegativeIndex = groupIndex;
      }
    }

    if (lineDecimation) {
      const indices = new Set<number>();
      if (maxPositiveTotal > Number.NEGATIVE_INFINITY) {
        indices.add(bestPositiveIndex);
        if (minPositiveTotal < Number.POSITIVE_INFINITY && worstPositiveIndex !== bestPositiveIndex) {
          indices.add(worstPositiveIndex);
        }
      }
      if (minNegativeTotal < Number.POSITIVE_INFINITY) {
        indices.add(bestNegativeIndex);
        if (maxNegativeTotal > Number.NEGATIVE_INFINITY && worstNegativeIndex !== bestNegativeIndex) {
          indices.add(worstNegativeIndex);
        }
      }

      const sortedIndices = Array.from(indices).sort((a, b) => a - b);

      for (const groupIndex of sortedIndices) {
        const groupValues = groups[groupIndex]!.valuesByStack.get(stackKey);
        for (const series of seriesOrder) {
          const val = groupValues?.get(series) ?? 0;
          pushGroupRow(rows, { key: meta.key, index: start }, start, end, series, stackKey, val, true);
        }
      }
    } else {
      const positiveGroup = groups[bestPositiveIndex]!.valuesByStack.get(stackKey);
      const negativeGroup = groups[bestNegativeIndex]!.valuesByStack.get(stackKey);

      for (const series of seriesOrder) {
        const positiveValue = positiveGroup?.get(series) ?? 0;
        const negativeValue = negativeGroup?.get(series) ?? 0;

        if (positiveValue > 0 && negativeValue < 0) {
          pushGroupRow(rows, meta, start, end, series, stackKey, negativeValue);
          pushGroupRow(rows, meta, start, end, series, stackKey, positiveValue);
        } else if (negativeValue < 0) {
          pushGroupRow(rows, meta, start, end, series, stackKey, negativeValue);
        } else if (positiveValue > 0) {
          pushGroupRow(rows, meta, start, end, series, stackKey, positiveValue);
        }
      }
    }
  }
}
