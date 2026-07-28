import type { AxesSpec, AxisSpec } from "../core/types";
import { niceLinearDomain } from "../core/axes";
import type { Accessor } from "../marks/types";
import { readAccessor } from "../marks/accessor";
import type { BarLayoutMode } from "../marks/barMark";

export type BandAxisOptions = {
  labels: readonly string[];
  position?: "bottom" | "left" | "right";
  count?: number;
  numericDomain?: readonly [number, number];
  timeGranularity?: "auto" | "year" | "month" | "day" | "hour" | "minute" | "second";
  maxTickCount?: number;
  maxLabelCount?: number;
  minLabelGap?: number;
  numeric?: boolean;
};

export type LinearAxisOptions = {
  domain: readonly [number, number];
  position: "left" | "right" | "bottom";
  timeGranularity?: "auto" | "year" | "month" | "day" | "hour" | "minute" | "second";
  tickStepMin?: number;
  nice?: boolean;
  tickCount?: number;
  maxTickCount?: number;
  minTickSpacing?: number;
  includeBounds?: boolean;
};

export function bandBottomAxis(options: BandAxisOptions): AxisSpec {
  const axis: AxisSpec = {
    kind: "band",
    position: options.position ?? "bottom",
    labels: options.labels
  };

  if (options.maxTickCount !== undefined) axis.maxTickCount = options.maxTickCount;
  if (options.count !== undefined) axis.count = options.count;
  if (options.numericDomain !== undefined) axis.numericDomain = options.numericDomain;
  if (options.timeGranularity !== undefined) axis.timeGranularity = options.timeGranularity;
  if (options.maxLabelCount !== undefined) axis.maxLabelCount = options.maxLabelCount;
  if (options.minLabelGap !== undefined) axis.minLabelGap = options.minLabelGap;
  if (options.numeric !== undefined) axis.numeric = options.numeric;

  return axis;
}

export function bandLeftAxis(options: Omit<BandAxisOptions, "position">): AxisSpec {
  return bandBottomAxis({ ...options, position: "left" });
}

export function bandRightAxis(options: Omit<BandAxisOptions, "position">): AxisSpec {
  return bandBottomAxis({ ...options, position: "right" });
}

export function linearAxis(options: LinearAxisOptions): AxisSpec {
  const axis: AxisSpec = {
    kind: "linear",
    position: options.position,
    domain: options.nice === false ? options.domain : niceLinearDomain(options.domain[0], options.domain[1])
  };

  if (options.timeGranularity !== undefined) axis.timeGranularity = options.timeGranularity;
  if (options.tickStepMin !== undefined) axis.tickStepMin = options.tickStepMin;
  if (options.nice !== undefined) axis.nice = options.nice;
  if (options.tickCount !== undefined) axis.tickCount = options.tickCount;
  if (options.maxTickCount !== undefined) axis.maxTickCount = options.maxTickCount;
  if (options.minTickSpacing !== undefined) axis.minTickSpacing = options.minTickSpacing;
  if (options.includeBounds !== undefined) axis.includeBounds = options.includeBounds;

  return axis;
}

export function barAxes<TDatum>(options: {
  data: readonly TDatum[];
  x: Accessor<TDatum, string | number>;
  y: Accessor<TDatum, string | number>;
  series?: Accessor<TDatum, string | number>;
  stack?: Accessor<TDatum, string | number>;
  stackGroup?: Accessor<TDatum, string | number>;
  layout?: BarLayoutMode;
  stacked?: boolean;
  domainMin?: number;
  domainMax?: number;
  timeAxis?: boolean | "auto" | "year" | "month" | "day" | "hour" | "minute" | "second";
  orientation?: "vertical" | "horizontal";
  yAxisPosition?: "left" | "right";
}): AxesSpec {
  const categoryAccessor = options.orientation === "horizontal" ? options.y : options.x;
  const valueAccessor = (options.orientation === "horizontal" ? options.x : options.y) as Accessor<TDatum, number>;
  const categorySummary = summarizeBandValues(options.data, categoryAccessor, options.series !== undefined);
  const stacked = resolveBarLayout(options) !== "grouped";
  const valueAxisDomain = stacked && options.series
    ? stackedValueDomain(options.data, categoryAccessor, valueAccessor, options.domainMin, options.domainMax, options.stack ?? options.stackGroup)
    : valueDomain(options.data, valueAccessor, options.domainMin, options.domainMax);
  const categoryAxisOptions: BandAxisOptions = {
    labels: categorySummary.labels,
    count: categorySummary.count,
    maxTickCount: options.orientation === "horizontal" ? 500 : 48,
    maxLabelCount: options.orientation === "horizontal" ? 500 : 48,
    minLabelGap: options.orientation === "horizontal" ? 2 : 18
  };

  if (categorySummary.numericDomain) {
    categoryAxisOptions.numericDomain = categorySummary.numericDomain;
  }
  if (options.timeAxis) {
    categoryAxisOptions.timeGranularity = options.timeAxis === true ? "auto" : options.timeAxis;
  }

  const valueAxis = linearAxis({
    position: options.orientation === "horizontal" ? "bottom" : options.yAxisPosition ?? "left",
    domain: valueAxisDomain,
    nice: false,
    maxTickCount: 16,
    minTickSpacing: 48
  });
  const categoryAxis = options.orientation === "horizontal"
    ? bandLeftAxis(categoryAxisOptions)
    : bandBottomAxis(categoryAxisOptions);

  return options.orientation === "horizontal"
    ? {
        x: valueAxis,
        y: categoryAxis
      }
    : {
        x: categoryAxis,
        y: valueAxis
      };
}

function resolveBarLayout<TDatum>(options: {
  stack?: Accessor<TDatum, string | number>;
  stackGroup?: Accessor<TDatum, string | number>;
  layout?: BarLayoutMode;
  stacked?: boolean;
}): BarLayoutMode {
  if (options.layout) {
    return options.layout;
  }

  if (options.stacked !== undefined) {
    return options.stacked ? "stacked" : "grouped";
  }

  return options.stack !== undefined || options.stackGroup !== undefined ? "stacked" : "grouped";
}

export function cartesianLinearAxes<TDatum>(options: {
  data: readonly TDatum[];
  x: Accessor<TDatum, number>;
  y: Accessor<TDatum, number>;
  xDomain?: readonly [number, number];
  yDomain?: readonly [number, number];
  timeAxis?: boolean | "auto" | "year" | "month" | "day" | "hour" | "minute" | "second";
  series?: Accessor<TDatum, string | number>;
  hiddenSeries?: Set<string | number> | undefined;
  yAxisPosition?: "left" | "right";
}): AxesSpec {
  return {
    x: linearAxis({
      position: "bottom",
      domain: options.xDomain ?? extent(options.data, options.x),
      ...(options.timeAxis ? { timeGranularity: options.timeAxis === true ? "auto" : options.timeAxis } : {}),
      ...(!options.timeAxis ? { tickStepMin: 1 } : {}),
      maxTickCount: 16,
      minTickSpacing: 72
    }),
    y: linearAxis({
      position: options.yAxisPosition ?? "left",
      domain: options.yDomain ?? extentWithHidden(options.data, options.y, options.series, options.hiddenSeries),
      maxTickCount: 16,
      minTickSpacing: 48
    })
  };
}

function valueDomain<TDatum>(
  data: readonly TDatum[],
  accessor: Accessor<TDatum, number>,
  configuredMin: number | undefined,
  configuredMax: number | undefined
): readonly [number, number] {
  let min = 0;
  let max = 0;

  data.forEach((datum, index) => {
    const value = readAccessor(accessor, datum, index);

    if (Number.isFinite(value)) {
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
  });

  const nice = niceLinearDomain(
    configuredMin ?? min,
    configuredMax ?? max
  );

  return [
    configuredMin ?? Math.min(0, nice[0]),
    configuredMax ?? Math.max(0, nice[1])
  ];
}

function stackedValueDomain<TDatum>(
  data: readonly TDatum[],
  categoryAccessor: Accessor<TDatum, string | number>,
  valueAccessor: Accessor<TDatum, number>,
  configuredMin: number | undefined,
  configuredMax: number | undefined,
  stackGroupAccessor: Accessor<TDatum, string | number> | undefined
): readonly [number, number] {
  const groups = new Map<string | number, { positive: number; negative: number }>();

  data.forEach((datum, index) => {
    const category = readAccessor(categoryAccessor, datum, index);
    const stackGroup = stackGroupAccessor ? readAccessor(stackGroupAccessor, datum, index) : "";
    const value = readAccessor(valueAccessor, datum, index);

    if (!Number.isFinite(value)) {
      return;
    }

    const groupKey = `${String(category)}\u0000${String(stackGroup)}`;
    const group = groups.get(groupKey) ?? { positive: 0, negative: 0 };

    if (value >= 0) {
      group.positive += value;
    } else {
      group.negative += value;
    }

    groups.set(groupKey, group);
  });

  let min = 0;
  let max = 0;

  for (const group of groups.values()) {
    min = Math.min(min, group.negative);
    max = Math.max(max, group.positive);
  }

  const nice = niceLinearDomain(
    configuredMin ?? min,
    configuredMax ?? max
  );

  return [
    configuredMin ?? Math.min(0, nice[0]),
    configuredMax ?? Math.max(0, nice[1])
  ];
}

function extent<TDatum>(data: readonly TDatum[], accessor: Accessor<TDatum, number>): readonly [number, number] {
  if (data.length === 0) {
    return [0, 1];
  }

  let min = readAccessor(accessor, data[0] as TDatum, 0);
  let max = min;

  for (let index = 1; index < data.length; index += 1) {
    const value = readAccessor(accessor, data[index] as TDatum, index);

    if (value < min) min = value;
    if (value > max) max = value;
  }

  return min === max ? [min, min + 1] : [min, max];
}

function extentWithHidden<TDatum>(
  data: readonly TDatum[],
  accessor: Accessor<TDatum, number>,
  seriesAccessor?: Accessor<TDatum, string | number>,
  hiddenSeries?: Set<string | number>
): readonly [number, number] {
  if (data.length === 0) {
    return [0, 1];
  }

  let min = Infinity;
  let max = -Infinity;
  let hasValid = false;

  for (let index = 0; index < data.length; index += 1) {
    const datum = data[index] as TDatum;
    if (seriesAccessor && hiddenSeries) {
      const rawSeriesKey = readAccessor(seriesAccessor, datum, index);
      const seriesKey = typeof rawSeriesKey === "string" || typeof rawSeriesKey === "number"
        ? rawSeriesKey
        : String(rawSeriesKey);
      if (hiddenSeries.has(seriesKey) || hiddenSeries.has(String(seriesKey))) {
        continue;
      }
    }
    const value = readAccessor(accessor, datum, index);
    if (!Number.isFinite(value)) continue;

    if (value < min) min = value;
    if (value > max) max = value;
    hasValid = true;
  }

  if (!hasValid) {
    return [0, 1];
  }

  return min === max ? [min, min + 1] : [min, max];
}

function summarizeBandValues<TDatum>(
  data: readonly TDatum[],
  accessor: Accessor<TDatum, string | number>,
  unique: boolean
): { labels: readonly string[]; count: number; numericDomain?: readonly [number, number] } {
  if (data.length === 0) {
    return { labels: [], count: 0 };
  }

  const values = unique ? uniqueAccessorValues(data, accessor) : data.map((datum, index) => readAccessor(accessor, datum, index));
  const firstValue = values[0] ?? "";
  const lastValue = values[values.length - 1] ?? firstValue;
  const firstNumeric = Number(firstValue);
  const lastNumeric = Number(lastValue);

  if (Number.isFinite(firstNumeric) && Number.isFinite(lastNumeric)) {
    return {
      labels: [String(firstValue), String(lastValue)],
      count: values.length,
      numericDomain: [firstNumeric, lastNumeric]
    };
  }

  if (values.length > 2000) {
    return {
      labels: [String(firstValue), String(lastValue)],
      count: values.length
    };
  }

  return {
    labels: values.map(String),
    count: values.length
  };
}

function uniqueAccessorValues<TDatum>(
  data: readonly TDatum[],
  accessor: Accessor<TDatum, string | number>
): readonly (string | number)[] {
  const seen = new Set<string | number>();
  const values: (string | number)[] = [];

  data.forEach((datum, index) => {
    const value = readAccessor(accessor, datum, index);

    if (!seen.has(value)) {
      seen.add(value);
      values.push(value);
    }
  });

  return values;
}
