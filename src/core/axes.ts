import {
  easeOutCubic,
  resolveOriginExtendTickProgress
} from "./animation";
import type {
  AxesSpec,
  AxisAnimationState,
  AxisSpec,
  AxisSpecResolver,
  FrameSpec,
  Primitive,
  Rect,
  Size,
  TimeZoneMode
} from "./types";
import type { Theme } from "../themes/types";

/** Default axis tick/line stroke width. Keep in sync with settings UI. */
export const DEFAULT_AXIS_TICK_THICKNESS = 1.5;
/** Default gridline stroke width. Keep in sync with settings UI. */
export const DEFAULT_GRIDLINE_THICKNESS = 0.5;

type BandTick = {
  index: number;
  label: string;
  value?: number;
  time?: number;
};

type TimeTickResult = {
  ticks: readonly number[];
  step: number;
};

type ResolvedTimeZone = NonNullable<TimeZoneMode>;
type AxisPosition = Extract<AxisSpec["position"], "bottom" | "left" | "right">;
type VerticalAxisPosition = Extract<AxisPosition, "left" | "right">;

export type AxisTickFadeState = {
  now: number;
  durationMs: number;
  appearedAt: Map<string, number>;
  activeKeys: Set<string>;
  initialized?: boolean;
};


function applyLeftEdgeFade(x: number, plotArea: Rect, axis: AxisSpec, alpha: number, isScaledWindow?: boolean): number {
  if (!isScaledWindow || axis.leftEdgeFade === false || axis.position !== "bottom") {
    return alpha;
  }
  const fadeWidth = Math.max(1, plotArea.width * 0.06);
  if (x < plotArea.x) {
    return 0;
  }
  if (x > plotArea.x + fadeWidth) {
    return alpha;
  }
  const factor = (x - plotArea.x) / fadeWidth;
  return alpha * factor;
}

export function resolveAxes<TDatum>(
  axes: AxesSpec | AxisSpecResolver<TDatum> | undefined,
  data: readonly TDatum[]
): AxesSpec | undefined {
  if (!axes) {
    return undefined;
  }

  return typeof axes === "function" ? axes(data) : axes;
}

export function encodeAxes(
  axes: AxesSpec | undefined,
  plotArea: Rect,
  theme: Theme,
  virtualPlotArea?: Rect,
  animation?: AxisAnimationState,
  tickFade?: AxisTickFadeState,
  isScaledWindow?: boolean
): readonly Primitive[] {
  if (!axes) {
    return [];
  }

  return [
    ...encodeAxis(axes.x, plotArea, theme, virtualPlotArea, animation, tickFade, isScaledWindow),
    ...encodeAxis(axes.y, plotArea, theme, virtualPlotArea, animation, tickFade, isScaledWindow)
  ];
}

export function encodeFrame(size: Size, plotArea: Rect, theme: Theme, frame: FrameSpec | undefined): readonly Primitive[] {
  const primitives: Primitive[] = [
    {
      kind: "rect",
      x: 0,
      y: 0,
      width: size.width,
      height: size.height,
      ...(frame?.stroke !== undefined ? { stroke: frame.stroke } : {})
    }
  ];

  if (frame?.border === true) {
    primitives.push({
      kind: "rect",
      x: plotArea.x,
      y: plotArea.y,
      width: plotArea.width,
      height: plotArea.height,
      stroke: frame?.plotAreaStroke ?? theme.palette.grid,
      ...(frame?.cornerRadius !== undefined
        ? { cornerRadii: [frame.cornerRadius, frame.cornerRadius, frame.cornerRadius, frame.cornerRadius] as const }
        : {})
    });
  }

  return primitives;
}

export function niceLinearDomain(min: number, max: number, desiredCount = 5): readonly [number, number] {
  const span = max - min;

  if (!Number.isFinite(span) || span <= 0) {
    return [min, min + 1];
  }

  const step = niceStep(span / Math.max(1, desiredCount - 1));
  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;

  return [roundTick(niceMin, step), roundTick(niceMax, step)];
}

function encodeAxis(
  axis: AxisSpec | undefined,
  plotArea: Rect,
  theme: Theme,
  virtualPlotArea?: Rect,
  animation?: AxisAnimationState,
  tickFade?: AxisTickFadeState,
  isScaledWindow?: boolean
): readonly Primitive[] {
  if (!axis) {
    return [];
  }

  if (axis.kind === "band") {
    return encodeBandAxis(axis, plotArea, theme, virtualPlotArea, animation, tickFade, isScaledWindow);
  }

  return encodeLinearAxis(axis, plotArea, theme, animation, tickFade, isScaledWindow);
}

function encodeBandAxis(
  axis: Extract<AxisSpec, { kind: "band" }>,
  plotArea: Rect,
  theme: Theme,
  virtualPlotArea?: Rect,
  animation?: AxisAnimationState,
  tickFade?: AxisTickFadeState,
  isScaledWindow?: boolean
): readonly Primitive[] {
  const tickSize = axis.tickSize ?? 6;
  const axisThickness = axis.tickThickness ?? DEFAULT_AXIS_TICK_THICKNESS;
  const labelAngle = axis.labelAngle ?? 0;
  const tickPlotArea = virtualPlotArea ?? plotArea;
  const count = resolveBandCount(axis);
  const slotWidth = count > 0
    ? (isVerticalAxisPosition(axis.position) ? tickPlotArea.height : tickPlotArea.width) / count
    : isVerticalAxisPosition(axis.position) ? tickPlotArea.height : tickPlotArea.width;
  const resolvedTicks = resolveBandTicks(axis, plotArea, theme);
  if (isVerticalAxisPosition(axis.position)) {
    return encodeVerticalBandAxis(axis, plotArea, tickPlotArea, slotWidth, resolvedTicks, theme, tickSize, animation, tickFade);
  }
  const ticks = pruneRenderedBandTicks(resolvedTicks, axis, plotArea, tickPlotArea, slotWidth, theme);

  const yBase = plotArea.y + plotArea.height;
  const lineAnim = getAxisLinePoints("bottom", plotArea, animation);
  const primitives: Primitive[] = [];
  if (axis.line !== false) {
    primitives.push({
      kind: "path",
      points: lineAnim.points,
      stroke: withAlpha(theme.palette.foreground, lineAnim.alpha),
      strokeWidth: axisThickness
    });
  }

  const subticks = resolveBandSubticks(axis, ticks);
  for (const tick of subticks) {
    const xBase = resolveBandTickX(axis, tick, plotArea, tickPlotArea, slotWidth);
    const tRatio = plotArea.width > 0 ? clamp01((xBase - plotArea.x) / plotArea.width) : 0;
    const anim = getAxisAnimationParams(tRatio, "bottom", animation);
    if (!anim.drawTick) continue;
    let alpha = resolveTickFadeAlpha(tickFade, bandTickFadeKey(axis, tick, true), anim.alpha);

    const x = xBase + anim.xShift;
    const y = yBase + anim.yShift;
    alpha = applyLeftEdgeFade(x, plotArea, axis, alpha, isScaledWindow);

    if (axis.ticks !== false) {
      primitives.push({
        kind: "path",
        points: [
          [x, y],
          [x, y + resolveBandSubtickSize(axis) * anim.tickScale]
        ],
        stroke: withAlpha(theme.palette.foreground, alpha),
        strokeWidth: axisThickness
      });
    }
  }

  for (const [tickIndex, tick] of ticks.entries()) {
    const xBase = resolveBandTickX(axis, tick, plotArea, tickPlotArea, slotWidth);
    const tRatio = plotArea.width > 0 ? clamp01((xBase - plotArea.x) / plotArea.width) : 0;
    const isLast = tickIndex === ticks.length - 1;
    const anim = getAxisAnimationParams(tRatio, "bottom", animation, isLast);
    if (!anim.drawTick) continue;
    let alpha = resolveTickFadeAlpha(tickFade, bandTickFadeKey(axis, tick, false), anim.alpha);

    const x = xBase + anim.xShift;
    const y = yBase + anim.yShift;
    alpha = applyLeftEdgeFade(x, plotArea, axis, alpha, isScaledWindow);

    const clip = virtualPlotArea
      ? {
          x: plotArea.x,
          y,
          width: plotArea.width,
          height: tickSize + theme.typography.fontSize * 2
        }
      : undefined;

    if (axis.timeDomain && (x < plotArea.x || x > plotArea.x + plotArea.width)) {
      continue;
    }

    if (axis.ticks !== false) {
      primitives.push({
        kind: "path",
        points: [
          [x, y],
          [x, y + tickSize * anim.tickScale]
        ],
        stroke: withAlpha(theme.palette.foreground, alpha),
        ...(clip ? { clip } : {}),
        strokeWidth: axisThickness
      });
    }
    primitives.push({
      kind: "text",
      x,
      y: y + tickSize * anim.tickScale + resolveBottomLabelOffset(labelAngle, theme),
      text: tick.label,
      fill: withAlpha(theme.palette.foreground, alpha),
      font: font(theme),
      align: resolveBottomLabelAlign(labelAngle),
      baseline: resolveBottomLabelBaseline(labelAngle),
      ...(labelAngle ? { angle: labelAngle } : {})
    });
  }

  return primitives;
}

/** Final collision check using the exact coordinates passed to the renderer. */
function pruneRenderedBandTicks(
  ticks: readonly BandTick[],
  axis: Extract<AxisSpec, { kind: "band" }>,
  plotArea: Rect,
  tickPlotArea: Rect,
  slotWidth: number,
  theme: Theme
): readonly BandTick[] {
  if (ticks.length < 2) return ticks;

  const gap = axis.minLabelGap ?? 16;
  const kept: BandTick[] = [];
  const position = (tick: BandTick): number => resolveBandTickX(axis, tick, plotArea, tickPlotArea, slotWidth);
  const overlaps = (left: BandTick, right: BandTick): boolean => (
    position(right) - position(left) < resolveBottomLabelRequiredSpacing(
      left.label,
      right.label,
      axis.labelAngle ?? 0,
      theme,
      gap
    )
  );

  for (const tick of ticks) {
    const previous = kept[kept.length - 1];
    if (!previous || !overlaps(previous, tick)) kept.push(tick);
  }

  return kept;
}

function encodeVerticalBandAxis(
  axis: Extract<AxisSpec, { kind: "band" }>,
  plotArea: Rect,
  tickPlotArea: Rect,
  slotWidth: number,
  ticks: readonly BandTick[],
  theme: Theme,
  tickSize: number,
  animation?: AxisAnimationState,
  tickFade?: AxisTickFadeState
): readonly Primitive[] {
  const position = axis.position as VerticalAxisPosition;
  const axisThickness = axis.tickThickness ?? DEFAULT_AXIS_TICK_THICKNESS;
  const tickDirection = position === "right" ? 1 : -1;
  const xBase = position === "right" ? plotArea.x + plotArea.width : plotArea.x;
  const lineAnim = getAxisLinePoints(position, plotArea, animation);
  const primitives: Primitive[] = [];
  if (axis.line !== false) {
    primitives.push({
      kind: "path",
      points: lineAnim.points,
      stroke: withAlpha(theme.palette.foreground, lineAnim.alpha),
      strokeWidth: axisThickness
    });
  }

  for (const [tickIndex, tick] of ticks.entries()) {
    const yBase = resolveBandTickY(axis, tick, plotArea, tickPlotArea, slotWidth);

    if (yBase < plotArea.y || yBase > plotArea.y + plotArea.height) {
      continue;
    }

    const tRatio = plotArea.height > 0 ? clamp01((plotArea.y + plotArea.height - yBase) / plotArea.height) : 0;
    const isLast = tickIndex === ticks.length - 1;
    const anim = getAxisAnimationParams(tRatio, position, animation, isLast);
    if (!anim.drawTick) continue;
    const alpha = resolveTickFadeAlpha(tickFade, bandTickFadeKey(axis, tick, false), anim.alpha);

    const x = xBase + anim.xShift;
    const y = yBase + anim.yShift;

    if (axis.ticks !== false) {
      primitives.push({
        kind: "path",
        points: [
          [x + tickDirection * tickSize * anim.tickScale, y],
          [x, y]
        ],
        stroke: withAlpha(theme.palette.foreground, alpha),
        strokeWidth: axisThickness
      });
    }
    primitives.push({
      kind: "text",
      x: x + tickDirection * resolveVerticalLabelOffset(axis, anim.tickScale),
      y,
      text: tick.label,
      fill: withAlpha(theme.palette.foreground, alpha),
      font: font(theme),
      align: position === "right" ? "left" : "right",
      baseline: "middle",
      ...(axis.labelAngle ? { angle: axis.labelAngle } : {})
    });
  }

  return primitives;
}

function resolveBandTicks(
  axis: Extract<AxisSpec, { kind: "band" }>,
  plotArea: Rect,
  theme: Theme
): readonly BandTick[] {
  if (axis.labels.length === 0) {
    return [];
  }

  if (axis.visibleBandRange) {
    if (axis.timeDomain) {
      return resolveVisibleTimeBandTicks(axis, plotArea, theme);
    }

    return resolveVisibleBandTicks(axis, plotArea, theme);
  }

  const count = resolveBandCount(axis);
  const numericLabels = axis.numericDomain
    ? [axis.numericDomain[0], axis.numericDomain[1]]
    : axis.labels.map((label) => Number(label));
  const isNumeric = axis.numeric ?? numericLabels.every(Number.isFinite);
  const maxTicks = resolveMaxBandTicks(axis, plotArea, theme, isNumeric);

  if (isNumeric) {
    return resolveNumericBandTicks(numericLabels, count, maxTicks, axis, plotArea, theme);
  }

  const indexTicks = uniqueTicks([
    0,
    ...niceTicks(0, count - 1, maxTicks).filter((tick) => tick > 0 && tick < count - 1),
    count - 1
  ]);

  const ticks = indexTicks.map((value) => {
    const index = Math.max(0, Math.min(count - 1, Math.round(value)));

    return {
      index,
      label: resolveBandLabel(axis, index, count)
    };
  });

  return pruneOverlappingBandTicks(ticks, axis, plotArea, theme);
}

function resolveVisibleBandTicks(
  axis: Extract<AxisSpec, { kind: "band" }>,
  plotArea: Rect,
  theme: Theme
): readonly BandTick[] {
  const [visibleStart, visibleEnd] = axis.visibleBandRange ?? [0, resolveBandCount(axis)];
  const firstVisibleValue = Math.ceil(visibleStart + 0.5);
  const lastVisibleValue = Math.floor(visibleEnd + 0.5);

  if (lastVisibleValue < firstVisibleValue) {
    return [];
  }

  const maxTicks = resolveMaxBandTicks(axis, plotArea, theme, true);
  const span = Math.max(1, lastVisibleValue - firstVisibleValue);
  const step = niceIntegerBandNumericStep(span / Math.max(1, maxTicks - 1));
  const start = Math.ceil(firstVisibleValue / step) * step;
  const values: number[] = [];

  for (let value = start; value <= lastVisibleValue; value += step) {
    values.push(value);
  }

  if (values.length === 0) {
    values.push(firstVisibleValue);
  }

  const axisStartIndex = axis.startIndex ?? 0;

  return values.map((value) => ({
    index: value - 1,
    label: resolveBandLabel(axis, value - 1 - axisStartIndex, resolveBandCount(axis)),
    value
  }));
}

function resolveVisibleTimeBandTicks(
  axis: Extract<AxisSpec, { kind: "band" }>,
  plotArea: Rect,
  theme: Theme
): readonly BandTick[] {
  const [start, end] = axis.timeDomain ?? [0, 0];

  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return [];
  }

  const configuredMax = axis.maxTickCount ?? axis.maxLabelCount ?? 24;
  const timeZone = axis.timeZone ?? "local";
  const { granularity, ticks } = axis.timeGranularity && axis.timeGranularity !== "auto"
    ? (() => {
        const fixed = axis.timeGranularity;
        const maxTicks = resolveTimeAxisMaxTicks(plotArea, theme, fixed, configuredMax, axis);

        return { granularity: fixed, ...buildTimeTicks(start, end, fixed, maxTicks, timeZone) };
      })()
    : resolveAutoTimeTicks(start, end, (candidate) =>
        resolveTimeAxisMaxTicks(plotArea, theme, candidate, configuredMax, axis),
        timeZone
      );

  return ticks.map((time) => {
    const value = timeBandValue(axis, time);

    return {
      index: 0,
      label: formatTimeTick(time, granularity, timeZone),
      ...(value !== undefined ? { value } : {}),
      time
    };
  });
}

function resolveBandTickX(
  axis: Extract<AxisSpec, { kind: "band" }>,
  tick: BandTick,
  plotArea: Rect,
  tickPlotArea: Rect,
  slotWidth: number
): number {
  if (axis.timeDomain && axis.visibleBandRange && tick.value !== undefined) {
    const [visibleStart, visibleEnd] = axis.visibleBandRange;
    const visibleSpan = Math.max(Number.EPSILON, visibleEnd - visibleStart);

    return plotArea.x + ((tick.value - 0.5 - visibleStart) / visibleSpan) * plotArea.width;
  }

  if (axis.timeDomain && tick.time !== undefined) {
    const [start, end] = axis.timeDomain;
    const span = Math.max(Number.EPSILON, end - start);

    return plotArea.x + ((tick.time - start) / span) * plotArea.width;
  }

  if (axis.visibleBandRange && tick.value !== undefined) {
    const [visibleStart, visibleEnd] = axis.visibleBandRange;
    const visibleSpan = Math.max(Number.EPSILON, visibleEnd - visibleStart);

    return plotArea.x + ((tick.value - 0.5 - visibleStart) / visibleSpan) * plotArea.width;
  }

  return tickPlotArea.x + slotWidth * tick.index + slotWidth / 2;
}

function resolveBandTickY(
  axis: Extract<AxisSpec, { kind: "band" }>,
  tick: BandTick,
  plotArea: Rect,
  tickPlotArea: Rect,
  slotWidth: number
): number {
  if (axis.timeDomain && axis.visibleBandRange && tick.value !== undefined) {
    const [visibleStart, visibleEnd] = axis.visibleBandRange;
    const visibleSpan = Math.max(Number.EPSILON, visibleEnd - visibleStart);

    return plotArea.y + ((tick.value - 0.5 - visibleStart) / visibleSpan) * plotArea.height;
  }

  if (axis.timeDomain && tick.time !== undefined) {
    const [start, end] = axis.timeDomain;
    const span = Math.max(Number.EPSILON, end - start);

    return plotArea.y + ((tick.time - start) / span) * plotArea.height;
  }

  if (axis.visibleBandRange && tick.value !== undefined) {
    const [visibleStart, visibleEnd] = axis.visibleBandRange;
    const visibleSpan = Math.max(Number.EPSILON, visibleEnd - visibleStart);

    return plotArea.y + ((tick.value - 0.5 - visibleStart) / visibleSpan) * plotArea.height;
  }

  return tickPlotArea.y + slotWidth * tick.index + slotWidth / 2;
}

type TimeGranularity = NonNullable<Extract<AxisSpec, { kind: "band" }>["timeGranularity"]>;
type ConcreteTimeGranularity = Exclude<TimeGranularity, "auto">;

const secondMs = 1000;
const minuteMs = 60 * secondMs;
const hourMs = 60 * minuteMs;
const dayMs = 24 * hourMs;
const monthMs = 30 * dayMs;
const yearMs = 365 * dayMs;
const monthLabels = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function resolveTimeGranularity(spanMs: number): ConcreteTimeGranularity {
  if (spanMs >= 2 * yearMs) return "year";
  if (spanMs >= 60 * dayMs) return "month";
  if (spanMs >= 2 * dayMs) return "day";
  if (spanMs >= 2 * hourMs) return "hour";
  if (spanMs >= 2 * minuteMs) return "minute";

  return "second";
}

function resolveTimeAxisMaxTicks(
  plotArea: Rect,
  theme: Theme,
  granularity: ConcreteTimeGranularity,
  configuredMax: number,
  axis: {
    position: "bottom" | "left" | "right";
    minLabelGap?: number;
    minTickSpacing?: number;
    labelAngle?: number;
    tickDensity?: number;
  }
): number {
  const sampleLabels = resolveTimeSampleLabels(granularity);
  const maxLabelWidth = Math.max(
    ...sampleLabels.map((label) => estimateProjectedLabelWidth(label, theme, axis.labelAngle ?? 0)),
    1
  );
  const density = resolveTickDensity(axis.tickDensity);
  const minSpacing = (axis.minTickSpacing ?? (maxLabelWidth + (axis.minLabelGap ?? 16))) / density;
  const axisLength = isVerticalAxisPosition(axis.position) ? plotArea.height : plotArea.width;

  return Math.max(2, Math.min(Math.max(2, Math.floor(configuredMax * density)), Math.floor(axisLength / minSpacing)));
}

function correctTimeGranularity(granularity: ConcreteTimeGranularity, step: number): ConcreteTimeGranularity {
  const stepMs = step * granularityUnitMs(granularity);
  if (stepMs >= 365 * 24 * 60 * 60 * 1000) return "year";
  if (stepMs >= 30 * 24 * 60 * 60 * 1000) return "month";
  if (stepMs >= 24 * 60 * 60 * 1000) return "day";
  if (stepMs >= 60 * 60 * 1000) return "hour";
  if (stepMs >= 60 * 1000) return "minute";
  return "second";
}

function resolveAutoTimeTicks(
  start: number,
  end: number,
  resolveMaxTicks: (granularity: ConcreteTimeGranularity) => number,
  timeZone: ResolvedTimeZone
): { granularity: ConcreteTimeGranularity; ticks: readonly number[]; step: number } {
  // Lock granularity to the zoom span so streaming/window slides don't hunt
  // between hour/day/etc as maxTicks or tiny span jitter changes.
  const granularity = resolveTimeGranularity(end - start);
  const plan = buildTimeTicks(start, end, granularity, resolveMaxTicks(granularity), timeZone);

  return {
    granularity: correctTimeGranularity(granularity, plan.step),
    ticks: plan.ticks,
    step: plan.step
  };
}

function resolveTimeSampleLabels(granularity: ConcreteTimeGranularity): readonly string[] {
  if (granularity === "year") return ["2026"];
  if (granularity === "month") return ["Sep 2026"];
  if (granularity === "day") return ["Sep 30"];
  if (granularity === "hour") return ["Sep 30 23:00"];

  return ["23:59"];
}

function timeBandValue(axis: Extract<AxisSpec, { kind: "band" }>, time: number): number | undefined {
  if (!axis.timeDomain || !axis.visibleBandRange) {
    return undefined;
  }

  const [timeStart, timeEnd] = axis.timeDomain;
  const [visibleStart, visibleEnd] = axis.visibleBandRange;
  const timeSpan = timeEnd - timeStart;
  const visibleSpan = visibleEnd - visibleStart;

  if (!Number.isFinite(timeSpan) || timeSpan <= 0 || !Number.isFinite(visibleSpan) || visibleSpan <= 0) {
    return undefined;
  }

  return visibleStart + 0.5 + ((time - timeStart) / timeSpan) * visibleSpan;
}

const timeStepCache = new Map<string, number>();

const MAX_SLIDING_CACHES = 10;
const slidingTimeTicksCaches: Array<{
  granularity: ConcreteTimeGranularity;
  step: number;
  timeZone: ResolvedTimeZone;
  ticks: number[];
}> = [];

function buildTimeTicks(
  start: number,
  end: number,
  granularity: ConcreteTimeGranularity,
  maxTicks: number,
  timeZone: ResolvedTimeZone
): TimeTickResult {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return { ticks: [start, end], step: 1 };
  }

  // Choose the step from the span alone (which is invariant under panning), and
  // anchor ticks to an absolute, epoch-aligned grid. This keeps the labeled
  // ticks fixed in time as the domain slides, so they translate smoothly with
  // the data instead of jumping between label sets.
  const step = resolveTimeStepCached(start, end, granularity, maxTicks, timeZone);
  const ticks = buildTimeTicksWithStepSliding(start, end, granularity, step, timeZone);

  return {
    ticks: ticks.length > 0 ? ticks : [start, end],
    step
  };
}

function resolveTimeStepCached(
  start: number,
  end: number,
  granularity: ConcreteTimeGranularity,
  _maxTicks: number,
  timeZone: ResolvedTimeZone
): number {
  // Key only on quantized span units — not maxTicks — so streaming layout/Y
  // jitter can't flip the interval at a fixed zoom level.
  const units = quantizeTimeSpanUnits(end - start, granularity);
  const spanKey = `${granularity}|${timeZone}|${units}`;
  const cached = timeStepCache.get(spanKey);

  if (cached !== undefined) {
    return cached;
  }

  const step = resolveTimeStep(units, granularity);
  timeStepCache.set(spanKey, step);
  return step;
}

function buildTimeTicksWithStepSliding(
  start: number,
  end: number,
  granularity: ConcreteTimeGranularity,
  step: number,
  timeZone: ResolvedTimeZone
): readonly number[] {
  let cache: typeof slidingTimeTicksCaches[number] | undefined;
  let minDistance = Infinity;
  const requestedMid = (start + end) / 2;
  const requestedSpan = end - start;

  for (const entry of slidingTimeTicksCaches) {
    if (
      entry.granularity === granularity &&
      entry.step === step &&
      entry.timeZone === timeZone &&
      entry.ticks.length > 0
    ) {
      const entryMid = (entry.ticks[0]! + entry.ticks[entry.ticks.length - 1]!) / 2;
      const distance = Math.abs(requestedMid - entryMid);
      if (distance < 5 * requestedSpan && distance < minDistance) {
        minDistance = distance;
        cache = entry;
      }
    }
  }

  if (cache) {
    const idx = slidingTimeTicksCaches.indexOf(cache);
    if (idx !== -1) {
      slidingTimeTicksCaches.splice(idx, 1);
    }
    slidingTimeTicksCaches.push(cache);

    const prev = cache.ticks;
    let lo = 0;
    let hi = prev.length - 1;

    while (lo < prev.length && (prev[lo] ?? 0) < start) lo++;
    while (hi >= lo && (prev[hi] ?? 0) > end) hi--;

    const ticks: number[] = lo <= hi ? prev.slice(lo, hi + 1) : [];

    if (ticks.length === 0 || ticks[ticks.length - 1]! < end) {
      const cursor = ticks.length > 0
        ? new Date(ticks[ticks.length - 1]!)
        : new Date(alignTimeToStep(start, granularity, step, timeZone));

      if (ticks.length > 0) {
        addTime(cursor, granularity, step, timeZone);
      }

      while (cursor.getTime() <= end) {
        const time = cursor.getTime();

        if (time >= start) {
          ticks.push(time);
        }

        addTime(cursor, granularity, step, timeZone);
      }
    }

    if (ticks.length > 0 && ticks[0]! > start) {
      const cursor = new Date(ticks[0]!);
      addTime(cursor, granularity, -step, timeZone);

      while (cursor.getTime() >= start) {
        ticks.unshift(cursor.getTime());
        addTime(cursor, granularity, -step, timeZone);
      }
    }

    cache.ticks = ticks;
    return ticks;
  }

  const ticks = [...buildTimeTicksWithStep(start, end, granularity, step, timeZone)];
  const newEntry = { granularity, step, timeZone, ticks: [...ticks] };
  slidingTimeTicksCaches.push(newEntry);
  if (slidingTimeTicksCaches.length > MAX_SLIDING_CACHES) {
    slidingTimeTicksCaches.shift();
  }
  return ticks;
}

function quantizeTimeSpanUnits(spanMs: number, granularity: ConcreteTimeGranularity): number {
  return Math.max(1, Math.round(spanMs / granularityUnitMs(granularity)));
}

function resolveTimeStep(units: number, granularity: ConcreteTimeGranularity): number {
  // Week-scale day windows: one label per day.
  if (granularity === "day" && units >= 6 && units <= 8) {
    return 1;
  }

  // Span-only step: aim for ~6 majors at this zoom. Independent of maxTicks so
  // streaming can't change the interval while the window size stays the same.
  const rawStep = units / 6;

  for (const step of validTimeSteps(granularity)) {
    if (rawStep <= step + 1e-9) {
      return step;
    }
  }

  let step = validTimeSteps(granularity).at(-1) ?? 1;
  while (step < rawStep - 1e-9) {
    step *= 2;
  }
  return step;
}

function validTimeSteps(granularity: ConcreteTimeGranularity): readonly number[] {
  if (granularity === "second" || granularity === "minute") return [1, 2, 5, 10, 15, 30, 60, 120];
  if (granularity === "hour") return [1, 2, 3, 4, 6, 8, 12, 24, 48, 96];
  if (granularity === "day") return [1, 2, 4, 8, 16, 32, 64, 128];

  return [1, 2, 3, 4, 6, 12, 24, 48, 96];
}

function buildTimeTicksWithStep(
  start: number,
  end: number,
  granularity: ConcreteTimeGranularity,
  step: number,
  timeZone: ResolvedTimeZone
): readonly number[] {
  const cursor = new Date(alignTimeToStep(start, granularity, step, timeZone));
  const ticks: number[] = [];

  while (cursor.getTime() <= end) {
    const time = cursor.getTime();

    if (time >= start) {
      ticks.push(time);
    }

    addTime(cursor, granularity, step, timeZone);
  }

  return ticks;
}

function granularityUnitMs(granularity: ConcreteTimeGranularity): number {
  if (granularity === "second") return secondMs;
  if (granularity === "minute") return minuteMs;
  if (granularity === "hour") return hourMs;
  if (granularity === "day") return dayMs;
  if (granularity === "month") return monthMs;

  return yearMs;
}

function alignTimeToStep(time: number, granularity: ConcreteTimeGranularity, step: number, timeZone: ResolvedTimeZone): number {
  if (timeZone === "utc") {
    return alignUtcTimeToStep(time, granularity, step);
  }

  const date = new Date(time);

  if (granularity === "second") {
    date.setMilliseconds(0);
    date.setSeconds(Math.floor(date.getSeconds() / step) * step);
    return date.getTime();
  }

  if (granularity === "minute") {
    date.setSeconds(0, 0);
    date.setMinutes(Math.floor(date.getMinutes() / step) * step);
    return date.getTime();
  }

  if (granularity === "hour") {
    date.setMinutes(0, 0, 0);
    date.setHours(Math.floor(date.getHours() / step) * step);
    return date.getTime();
  }

  if (granularity === "day") {
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - ((date.getDate() - 1) % step));
    return date.getTime();
  }

  if (granularity === "month") {
    date.setHours(0, 0, 0, 0);
    const months = date.getFullYear() * 12 + date.getMonth();
    const aligned = Math.floor(months / step) * step;

    return new Date(Math.floor(aligned / 12), aligned % 12, 1).getTime();
  }

  const alignedYear = Math.floor(date.getFullYear() / step) * step;

  return new Date(alignedYear, 0, 1).getTime();
}

function alignUtcTimeToStep(time: number, granularity: ConcreteTimeGranularity, step: number): number {
  const date = new Date(time);

  if (granularity === "second") {
    date.setUTCMilliseconds(0);
    date.setUTCSeconds(Math.floor(date.getUTCSeconds() / step) * step);
    return date.getTime();
  }

  if (granularity === "minute") {
    date.setUTCSeconds(0, 0);
    date.setUTCMinutes(Math.floor(date.getUTCMinutes() / step) * step);
    return date.getTime();
  }

  if (granularity === "hour") {
    date.setUTCMinutes(0, 0, 0);
    date.setUTCHours(Math.floor(date.getUTCHours() / step) * step);
    return date.getTime();
  }

  if (granularity === "day") {
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDate() - 1) % step));
    return date.getTime();
  }

  if (granularity === "month") {
    date.setUTCHours(0, 0, 0, 0);
    const months = date.getUTCFullYear() * 12 + date.getUTCMonth();
    const aligned = Math.floor(months / step) * step;

    return Date.UTC(Math.floor(aligned / 12), aligned % 12, 1);
  }

  const alignedYear = Math.floor(date.getUTCFullYear() / step) * step;

  return Date.UTC(alignedYear, 0, 1);
}

function addTime(date: Date, granularity: ConcreteTimeGranularity, step: number, timeZone: ResolvedTimeZone): void {
  if (timeZone === "utc") {
    if (granularity === "second") date.setUTCSeconds(date.getUTCSeconds() + step);
    else if (granularity === "minute") date.setUTCMinutes(date.getUTCMinutes() + step);
    else if (granularity === "hour") date.setUTCHours(date.getUTCHours() + step);
    else if (granularity === "day") date.setUTCDate(date.getUTCDate() + step);
    else if (granularity === "month") date.setUTCMonth(date.getUTCMonth() + step);
    else date.setUTCFullYear(date.getUTCFullYear() + step);
    return;
  }

  if (granularity === "second") date.setSeconds(date.getSeconds() + step);
  else if (granularity === "minute") date.setMinutes(date.getMinutes() + step);
  else if (granularity === "hour") date.setHours(date.getHours() + step);
  else if (granularity === "day") date.setDate(date.getDate() + step);
  else if (granularity === "month") date.setMonth(date.getMonth() + step);
  else date.setFullYear(date.getFullYear() + step);
}

function formatTimeTick(time: number, granularity: ConcreteTimeGranularity, timeZone: ResolvedTimeZone): string {
  const date = new Date(time);
  const year = timeZone === "utc" ? date.getUTCFullYear() : date.getFullYear();
  const monthIndex = timeZone === "utc" ? date.getUTCMonth() : date.getMonth();
  const day = String(timeZone === "utc" ? date.getUTCDate() : date.getDate());
  const hour = pad2(timeZone === "utc" ? date.getUTCHours() : date.getHours());
  const minute = pad2(timeZone === "utc" ? date.getUTCMinutes() : date.getMinutes());
  const second = pad2(timeZone === "utc" ? date.getUTCSeconds() : date.getSeconds());
  const month = monthLabels[monthIndex] ?? "Jan";

  if (granularity === "year") return String(year);
  if (granularity === "month") return `${month} ${year}`;
  if (granularity === "day") return `${month} ${day}`;
  if (hour === "00" && minute === "00" && second === "00") {
    return `${month} ${day}`;
  }
  if (granularity === "minute" || granularity === "hour") {
    return `${hour}:${minute}:${second}`;
  }
  return `${hour}:${minute}:${second}`;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function resolveNumericBandTicks(
  labels: readonly number[],
  count: number,
  maxTicks: number,
  axis: Extract<AxisSpec, { kind: "band" }>,
  plotArea: Rect,
  theme: Theme
): readonly { index: number; label: string }[] {
  if (!axis.numericDomain && labels.length <= maxTicks) {
    return labels.map((label, index) => ({
      index,
      label: formatAxisTick(axis, label)
    }));
  }

  if (!isMonotonic(labels)) {
    return resolveIndexBandTicks(labels, maxTicks);
  }

  const first = axis.numericDomain?.[0] ?? labels[0] ?? 0;
  const last = axis.numericDomain?.[1] ?? labels[labels.length - 1] ?? first;
  const min = Math.min(first, last);
  const max = Math.max(first, last);
  const step = axis.numericDomain ? niceIntegerBandNumericStep((max - min) / Math.max(1, maxTicks - 1)) : niceBandNumericStep((max - min) / Math.max(1, maxTicks - 1));
  const start = Math.ceil(min / step) * step;
  const values: number[] = [];

  for (let value = start; value <= max + step / 2; value += step) {
    values.push(roundTick(value, step));
  }

  if (values.length === 0) {
    values.push(min, max);
  }

  const ticks = uniqueTicks(values).map((value) => ({
    index: axis.numericDomain
      ? nearestNumericDomainBandIndex(axis.numericDomain, count, value)
      : nearestNumericBandIndex(labels, value),
    label: formatAxisTick(axis, value)
  }));

  return pruneOverlappingBandTicks(ticks, axis, plotArea, theme);
}

function resolveIndexBandTicks(labels: readonly number[], maxTicks: number): readonly { index: number; label: string }[] {
  const step = Math.max(1, Math.ceil(niceStep((labels.length - 1) / Math.max(1, maxTicks - 1))));
  const ticks: { index: number; label: string }[] = [{ index: 0, label: formatTick(labels[0] ?? 0) }];

  for (let index = step; index < labels.length - 1; index += step) {
    ticks.push({ index, label: formatTick(labels[index] ?? index) });
  }

  ticks.push({
    index: labels.length - 1,
    label: formatTick(labels[labels.length - 1] ?? labels.length - 1)
  });

  return ticks;
}

function resolveMaxBandTicks(
  axis: Extract<AxisSpec, { kind: "band" }>,
  plotArea: Rect,
  theme: Theme,
  numeric: boolean
): number {
  const density = resolveTickDensity(axis.tickDensity);
  const configuredMax = Math.max(2, Math.floor((axis.maxTickCount ?? axis.maxLabelCount ?? 24) * density));

  if (isVerticalAxisPosition(axis.position)) {
    const labelHeight = theme.typography.fontSize * 1.18;
    const minSpacing = (labelHeight + Math.min(axis.minLabelGap ?? 2, 3)) / density;

    return Math.max(2, Math.min(configuredMax, Math.floor(plotArea.height / minSpacing)));
  }

  const sampleLabels = numeric ? ["0", String(resolveBandCount(axis))] : axis.labels;
  const maxLabelWidth = Math.max(...sampleLabels.map((label) => estimateProjectedLabelWidth(label, theme, axis.labelAngle ?? 0)), 1);
  const minSpacing = (maxLabelWidth + (axis.minLabelGap ?? 16)) / density;
  const multiplier = axis.position === "bottom" && axis.labelAngle ? 2 : 1;

  return Math.max(2, Math.min(configuredMax * multiplier, Math.floor(plotArea.width / minSpacing) * multiplier));
}

function resolveBandCount(axis: Extract<AxisSpec, { kind: "band" }>): number {
  return Math.max(0, axis.count ?? axis.labels.length);
}

function resolveBandLabel(axis: Extract<AxisSpec, { kind: "band" }>, index: number, count: number): string {
  const numericLabels = axis.numericDomain
    ? [axis.numericDomain[0], axis.numericDomain[1]]
    : axis.labels.map((label) => Number(label));
  const isNumeric = axis.numeric ?? (axis.labels.length > 0 && numericLabels.every(Number.isFinite));

  if (!isNumeric) {
    return axis.labels[index + (axis.startIndex ?? 0)] ?? "";
  }

  if (axis.labels.length === count) {
    return axis.labels[index] ?? "";
  }

  if (index === 0) {
    return axis.labels[0] ?? "";
  }

  if (index === count - 1) {
    return axis.labels[axis.labels.length - 1] ?? "";
  }

  if (axis.numericDomain) {
    const span = axis.numericDomain[1] - axis.numericDomain[0];
    const value = count <= 1 ? axis.numericDomain[0] : axis.numericDomain[0] + (span * index) / (count - 1);

    return formatTick(value);
  }

  return String(index + 1);
}

function nearestNumericDomainBandIndex(domain: readonly [number, number], count: number, value: number): number {
  const span = domain[1] - domain[0];

  if (!Number.isFinite(span) || span === 0 || count <= 1) {
    return 0;
  }

  return Math.max(0, Math.min(count - 1, Math.round(((value - domain[0]) / span) * (count - 1))));
}

function niceBandNumericStep(rawStep: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const multipliers = magnitude < 10 ? [1, 2, 5, 10] : [1, 2, 2.5, 5, 10];
  const multiplier = multipliers.find((candidate) => normalized <= candidate) ?? 10;

  return multiplier * magnitude;
}

function niceIntegerBandNumericStep(rawStep: number): number {
  return Math.max(1, Math.ceil(niceBandNumericStep(rawStep)));
}

function uniqueTicks(ticks: readonly number[]): readonly number[] {
  const seen = new Set<number>();
  const unique: number[] = [];

  for (const tick of ticks) {
    if (!seen.has(tick)) {
      seen.add(tick);
      unique.push(tick);
    }
  }

  return unique;
}

function isMonotonic(values: readonly number[]): boolean {
  if (values.length < 2) {
    return true;
  }

  const direction = Math.sign((values[values.length - 1] ?? 0) - (values[0] ?? 0));

  if (direction === 0) {
    return false;
  }

  return values.every((value, index) => {
    if (index === 0) return true;

    return direction > 0 ? value >= (values[index - 1] ?? value) : value <= (values[index - 1] ?? value);
  });
}

function nearestNumericBandIndex(labels: readonly number[], value: number): number {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  labels.forEach((label, index) => {
    const distance = Math.abs(label - value);

    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });

  return bestIndex;
}

function pruneOverlappingBandTicks(
  ticks: readonly { index: number; label: string }[],
  axis: Extract<AxisSpec, { kind: "band" }>,
  plotArea: Rect,
  theme: Theme
): readonly { index: number; label: string }[] {
  const count = resolveBandCount(axis);
  const axisLength = isVerticalAxisPosition(axis.position) ? plotArea.height : plotArea.width;
  const slotWidth = count > 0 ? axisLength / count : axisLength;
  const minGap = axis.minLabelGap ?? 16;
  const kept: { index: number; label: string }[] = [];

  for (const tick of dedupeTicksByIndex(ticks)) {
    const previous = kept[kept.length - 1];

    if (!previous) {
      kept.push(tick);
      continue;
    }

    const previousPosition = slotWidth * previous.index + slotWidth / 2;
    const currentPosition = slotWidth * tick.index + slotWidth / 2;
    const requiredSpacing = isVerticalAxisPosition(axis.position)
      ? theme.typography.fontSize * 1.18 + Math.min(minGap, 3)
      : resolveBottomLabelRequiredSpacing(previous.label, tick.label, axis.labelAngle ?? 0, theme, minGap);

    if (currentPosition - previousPosition >= requiredSpacing) {
      kept.push(tick);
      continue;
    }

    if (tick.index === count - 1) {
      kept[kept.length - 1] = tick;
      while (kept.length >= 2) {
        const last = kept[kept.length - 1]!;
        const prev = kept[kept.length - 2]!;
        const prevPos = slotWidth * prev.index + slotWidth / 2;
        const lastPos = slotWidth * last.index + slotWidth / 2;
        const req = isVerticalAxisPosition(axis.position)
          ? theme.typography.fontSize * 1.18 + Math.min(minGap, 3)
          : resolveBottomLabelRequiredSpacing(prev.label, last.label, axis.labelAngle ?? 0, theme, minGap);
        if (lastPos - prevPos < req) {
          kept.splice(kept.length - 2, 1);
        } else {
          break;
        }
      }
    }
  }

  return kept;
}

function pruneOverlappingLinearTicks(
  ticks: readonly number[],
  span: number,
  axis: Extract<AxisSpec, { kind: "linear" }>,
  plotArea: Rect,
  theme: Theme,
  timeGranularity?: ConcreteTimeGranularity,
  timeZone?: string
): readonly number[] {
  if (ticks.length < 2 || isVerticalAxisPosition(axis.position)) {
    return ticks;
  }

  const minGap = 8;
  const axisLength = plotArea.width;

  const label = (tick: number): string => timeGranularity
    ? formatTimeTick(tick, timeGranularity, (timeZone ?? "local") as ResolvedTimeZone)
    : formatAxisTick(axis, tick);

  const overlaps = (left: number, right: number): boolean => {
    const distance = Math.abs(right - left) / span * axisLength;
    return distance < resolveBottomLabelRequiredSpacing(
      label(left),
      label(right),
      axis.labelAngle ?? 0,
      theme,
      minGap
    );
  };

  for (let stride = 1; stride < ticks.length; stride += 1) {
    const selected = ticks.filter((_, index) => index % stride === 0);
    const hasOverlap = selected.some((tick, index) => (
      index > 0 && overlaps(selected[index - 1]!, tick)
    ));

    if (!hasOverlap) {
      return selected;
    }
  }

  return ticks.slice(0, 1);
}

function dedupeTicksByIndex(ticks: readonly { index: number; label: string }[]): readonly { index: number; label: string }[] {
  const seen = new Set<number>();
  const deduped: { index: number; label: string }[] = [];

  for (const tick of ticks) {
    if (!seen.has(tick.index)) {
      seen.add(tick.index);
      deduped.push(tick);
    }
  }

  return deduped;
}

const textMeasurementCache = new Map<string, number>();
let textMeasurementContext: CanvasRenderingContext2D | null | undefined;

function estimateTextWidth(text: string, theme: Theme): number {
  const font = `${theme.typography.fontSize}px ${theme.typography.fontFamily}`;
  const key = `${font}\u0000${text}`;

  let width = textMeasurementCache.get(key);
  if (width !== undefined) {
    return width;
  }

  if (textMeasurementContext === undefined && typeof document !== "undefined") {
    textMeasurementContext = document.createElement("canvas").getContext("2d");
  }

  if (textMeasurementContext) textMeasurementContext.font = font;
  const calculatedWidth = (textMeasurementContext?.measureText(text).width
    ?? text.length * theme.typography.fontSize * 0.62) * 1.05;

  textMeasurementCache.set(key, calculatedWidth);
  if (textMeasurementCache.size > 5000) {
    textMeasurementCache.clear();
  }

  return calculatedWidth;
}

function estimateProjectedLabelWidth(text: string, theme: Theme, angle: number): number {
  const radians = Math.abs(angle * Math.PI / 180);
  const width = estimateTextWidth(text, theme);
  const height = theme.typography.fontSize * 1.18;

  return Math.max(1, Math.abs(Math.cos(radians)) * width + Math.abs(Math.sin(radians)) * height);
}


function resolveBottomLabelRequiredSpacing(
  previous: string,
  current: string,
  angle: number,
  theme: Theme,
  gap: number
): number {
  if (angle === 0) {
    return (estimateTextWidth(previous, theme) + estimateTextWidth(current, theme)) / 2 + gap;
  }

  if (Math.abs(angle) >= 80) {
    return theme.typography.fontSize * 1.18 + Math.min(gap, 3);
  }

  return estimateProjectedLabelWidth(previous, theme, angle) + gap;
}

function resolveBandSubticks(
  axis: Extract<AxisSpec, { kind: "band" }>,
  ticks: readonly BandTick[]
): readonly BandTick[] {
  if (!axis.subticks || ticks.length < 2) {
    return [];
  }

  if (axis.timeDomain && ticks.every((tick) => tick.time !== undefined)) {
    return resolveTimeBandSubticks(axis, ticks);
  }

  if (!isNumericBandAxis(axis, ticks)) {
    return [];
  }

  const subticks: BandTick[] = [];

  for (let index = 0; index < ticks.length - 1; index += 1) {
    const start = tickNumericValue(ticks[index] as BandTick);
    const end = tickNumericValue(ticks[index + 1] as BandTick);

    if (start === undefined || end === undefined || end <= start) {
      continue;
    }

    const count = resolveSubtickCount(axis.subticks, end - start, axis);

    if (count <= 0) {
      continue;
    }

    const step = (end - start) / (count + 1);

    for (let offset = 1; offset <= count; offset += 1) {
      const value = start + step * offset;

      subticks.push({
        index: value - 1,
        label: "",
        value
      });
    }
  }

  return subticks;
}

function resolveTimeBandSubticks(
  axis: Extract<AxisSpec, { kind: "band" }>,
  ticks: readonly BandTick[]
): readonly BandTick[] {
  const [min, max] = axis.timeDomain ?? [0, 0];
  const majorSet = new Set(ticks.flatMap((tick) => tick.time === undefined ? [] : [tickKey(tick.time)]));
  const subticks: BandTick[] = [];

  for (let index = 0; index < ticks.length - 1; index += 1) {
    const start = ticks[index]?.time;
    const end = ticks[index + 1]?.time;

    if (start === undefined || end === undefined || end <= start) {
      continue;
    }

    const count = resolveSubtickCount(axis.subticks, end - start, axis);

    if (count <= 0) {
      continue;
    }

    const step = (end - start) / (count + 1);

    if (!Number.isFinite(step) || step <= 0) {
      continue;
    }

    for (let offset = 1; offset <= count; offset += 1) {
      const time = start + step * offset;

      if (time > min && time < max && !majorSet.has(tickKey(time))) {
        const value = timeBandValue(axis, time);

        subticks.push({
          index: 0,
          label: "",
          ...(value !== undefined ? { value } : {}),
          time
        });
      }
    }
  }

  return subticks;
}

function isNumericBandAxis(axis: Extract<AxisSpec, { kind: "band" }>, ticks: readonly BandTick[]): boolean {
  if (axis.numericDomain || axis.numeric || axis.visibleBandRange) {
    return true;
  }

  return ticks.every((tick) => Number.isFinite(Number(tick.label)));
}

function tickNumericValue(tick: BandTick): number | undefined {
  if (tick.value !== undefined) {
    return tick.value;
  }

  const parsed = Number(tick.label);

  return Number.isFinite(parsed) ? parsed : undefined;
}

function resolveBandSubtickSize(axis: Extract<AxisSpec, { kind: "band" }>): number {
  return axis.subtickSize ?? Math.max(2, Math.floor((axis.tickSize ?? 6) * 0.55));
}

type LinearAxisEncoding = {
  min: number;
  max: number;
  span: number;
  ticks: readonly number[];
  subticks: readonly number[];
  timeGranularity?: ConcreteTimeGranularity;
  timeZone: ResolvedTimeZone;
};

let lastLinearAxisEncodingCache:
  | {
      key: string;
      encoding: LinearAxisEncoding;
    }
  | undefined;

function resolveLinearAxisEncodingCacheKey(
  axis: Extract<AxisSpec, { kind: "linear" }>,
  plotArea: Rect,
  theme: Theme
): string {
  const scaleDomain = axis.scaleDomain ?? axis.domain;
  const tickCount = resolveLinearTickCount(axis, plotArea);

  return [
    axis.position,
    scaleDomain[0],
    scaleDomain[1],
    axis.domain[0],
    axis.domain[1],
    axis.timeGranularity ?? "",
    axis.nice === false ? "0" : "1",
    tickCount,
    axis.maxTickCount ?? "",
    axis.tickDensity ?? "",
    axis.tickStepMin ?? "",
    axis.includeBounds === false ? "0" : "1",
    axis.subticks === false ? "0" : typeof axis.subticks === "number" ? axis.subticks : "1",
    plotArea.width,
    plotArea.height,
    theme.typography.fontSize
  ].join("|");
}

function resolveLinearAxisEncoding(
  axis: Extract<AxisSpec, { kind: "linear" }>,
  plotArea: Rect,
  theme: Theme
): LinearAxisEncoding {
  const cacheKey = resolveLinearAxisEncodingCacheKey(axis, plotArea, theme);

  if (lastLinearAxisEncodingCache?.key === cacheKey) {
    return lastLinearAxisEncodingCache.encoding;
  }

  const tickCount = resolveLinearTickCount(axis, plotArea);
  const scaleDomain = axis.scaleDomain ?? axis.domain;
  const autoTime = axis.position === "bottom" && axis.timeGranularity === "auto";
  const fixedTimeGranularity = axis.position === "bottom" && axis.timeGranularity && axis.timeGranularity !== "auto"
    ? axis.timeGranularity
    : undefined;
  // Explicit scaleDomain (or nice:false) locks the encoding extent to the same
  // domain marks use. Without this, pause/full rebuilds re-nice Y and tick
  // labels/gridlines jump relative to the streaming fast path.
  const [min, max] = autoTime || fixedTimeGranularity || axis.scaleDomain !== undefined || axis.nice === false
    ? [scaleDomain[0], scaleDomain[1]]
    : niceLinearDomain(axis.domain[0], axis.domain[1], tickCount);
  const configuredTimeMax = axis.maxTickCount ?? tickCount;
  const timeZone = axis.timeZone ?? "local";
  const timeTickPlan = autoTime
    ? resolveAutoTimeTicks(min, max, (candidate) =>
        resolveTimeAxisMaxTicks(plotArea, theme, candidate, configuredTimeMax, axis),
        timeZone
      )
    : fixedTimeGranularity
      ? {
          granularity: fixedTimeGranularity,
          ...buildTimeTicks(
            min,
            max,
            fixedTimeGranularity,
            resolveTimeAxisMaxTicks(plotArea, theme, fixedTimeGranularity, configuredTimeMax, axis),
            timeZone
          )
        }
      : undefined;
  let ticks = timeTickPlan
    ? timeTickPlan.ticks
    : niceTicks(min, max, tickCount, axis.tickStepMin, shouldIncludeLinearBounds(axis));
  const span = max - min || 1;
  ticks = pruneOverlappingLinearTicks(ticks, span, axis, plotArea, theme, timeTickPlan?.granularity, timeZone);
  const subticks = resolveSubticks(axis, ticks, min, max);

  const encoding: LinearAxisEncoding = {
    min,
    max,
    span,
    ticks,
    subticks,
    ...(timeTickPlan ? { timeGranularity: timeTickPlan.granularity } : {}),
    timeZone
  };
  lastLinearAxisEncodingCache = { key: cacheKey, encoding };
  return encoding;
}

function encodeLinearAxis(
  axis: Extract<AxisSpec, { kind: "linear" }>,
  plotArea: Rect,
  theme: Theme,
  animation?: AxisAnimationState,
  tickFade?: AxisTickFadeState,
  isScaledWindow?: boolean
): readonly Primitive[] {
  const tickSize = axis.tickSize ?? 6;
  const axisThickness = axis.tickThickness ?? DEFAULT_AXIS_TICK_THICKNESS;
  const { min, span, ticks, subticks, timeGranularity, timeZone } = resolveLinearAxisEncoding(axis, plotArea, theme);
  const primitives: Primitive[] = [];

  if (isVerticalAxisPosition(axis.position)) {
    const position = axis.position as VerticalAxisPosition;
    const tickDirection = position === "right" ? 1 : -1;
    const xBase = position === "right" ? plotArea.x + plotArea.width : plotArea.x;
    const lineAnim = getAxisLinePoints(position, plotArea, animation);
    if (axis.line !== false) {
      primitives.push({
        kind: "path",
        points: lineAnim.points,
        stroke: withAlpha(theme.palette.foreground, lineAnim.alpha),
        strokeWidth: axisThickness
      });
    }

    for (const value of subticks) {
      const t = (value - min) / span;
      const yBase = plotArea.y + plotArea.height - t * plotArea.height;
      const tRatio = clamp01(t);
      const anim = getAxisAnimationParams(tRatio, position, animation);
      if (!anim.drawTick) continue;
      const alpha = resolveTickFadeAlpha(tickFade, linearTickFadeKey(axis, value, true), anim.alpha);

      const x = xBase + anim.xShift;
      const y = yBase + anim.yShift;

      if (axis.ticks !== false) {
        primitives.push({
          kind: "path",
          points: [
            [x + tickDirection * resolveSubtickSize(axis) * anim.tickScale, y],
            [x, y]
          ],
          stroke: withAlpha(theme.palette.foreground, alpha),
          strokeWidth: axisThickness
        });
      }
    }

    for (const [tickIndex, value] of ticks.entries()) {
      const t = (value - min) / span;
      const yBase = plotArea.y + plotArea.height - t * plotArea.height;
      const tRatio = clamp01(t);
      const isLast = tickIndex === ticks.length - 1;
      const anim = getAxisAnimationParams(tRatio, position, animation, isLast);
      if (!anim.drawTick) continue;
      const alpha = resolveTickFadeAlpha(tickFade, linearTickFadeKey(axis, value, false), anim.alpha);

      const x = xBase + anim.xShift;
      const y = yBase + anim.yShift;

      if (axis.ticks !== false) {
        primitives.push({
          kind: "path",
          points: [
            [x + tickDirection * tickSize * anim.tickScale, y],
            [x, y]
          ],
          stroke: withAlpha(theme.palette.foreground, alpha),
          strokeWidth: axisThickness
        });
      }
      primitives.push({
        kind: "text",
        x: x + tickDirection * resolveVerticalLabelOffset(axis, anim.tickScale),
        y,
        text: formatAxisTick(axis, value),
        fill: withAlpha(theme.palette.foreground, alpha),
        font: font(theme),
        align: position === "right" ? "left" : "right",
        baseline: "middle",
        ...(axis.labelAngle ? { angle: axis.labelAngle } : {})
      });
    }

    return primitives;
  }

  const yBase = plotArea.y + plotArea.height;
  const lineAnim = getAxisLinePoints("bottom", plotArea, animation);
  if (axis.line !== false) {
    primitives.push({
      kind: "path",
      points: lineAnim.points,
      stroke: withAlpha(theme.palette.foreground, lineAnim.alpha),
      strokeWidth: axisThickness
    });
  }

  for (const value of subticks) {
    const t = (value - min) / span;
    const xBase = plotArea.x + t * plotArea.width;
    const tRatio = clamp01(t);
    const anim = getAxisAnimationParams(tRatio, "bottom", animation);
    if (!anim.drawTick) continue;
    let alpha = resolveTickFadeAlpha(tickFade, linearTickFadeKey(axis, value, true), anim.alpha);

    const x = xBase + anim.xShift;
    const y = yBase + anim.yShift;
    alpha = applyLeftEdgeFade(x, plotArea, axis, alpha, isScaledWindow);

    if (axis.ticks !== false) {
      primitives.push({
        kind: "path",
        points: [
          [x, y],
          [x, y + resolveSubtickSize(axis) * anim.tickScale]
        ],
        stroke: withAlpha(theme.palette.foreground, alpha),
        strokeWidth: axisThickness
      });
    }
  }

  for (const [tickIndex, value] of ticks.entries()) {
    const t = (value - min) / span;
    const xBase = plotArea.x + t * plotArea.width;
    const tRatio = clamp01(t);
    const isLast = tickIndex === ticks.length - 1;
    const anim = getAxisAnimationParams(tRatio, "bottom", animation, isLast);
    if (!anim.drawTick) continue;
    let alpha = resolveTickFadeAlpha(tickFade, linearTickFadeKey(axis, value, false), anim.alpha);

    const x = xBase + anim.xShift;
    const y = yBase + anim.yShift;
    alpha = applyLeftEdgeFade(x, plotArea, axis, alpha, isScaledWindow);

    if (axis.ticks !== false) {
      primitives.push({
        kind: "path",
        points: [
          [x, y],
          [x, y + tickSize * anim.tickScale]
        ],
        stroke: withAlpha(theme.palette.foreground, alpha),
        strokeWidth: axisThickness
      });
    }
    primitives.push({
      kind: "text",
      x,
      y: y + tickSize * anim.tickScale + resolveBottomLabelOffset(axis.labelAngle ?? 0, theme),
      text: timeGranularity ? formatTimeTick(value, timeGranularity, timeZone) : formatAxisTick(axis, value),
      fill: withAlpha(theme.palette.foreground, alpha),
      font: font(theme),
      align: resolveBottomLabelAlign(axis.labelAngle ?? 0),
      baseline: resolveBottomLabelBaseline(axis.labelAngle ?? 0),
      ...(axis.labelAngle ? { angle: axis.labelAngle } : {})
    });
  }

  return primitives;
}

function resolveLinearTickCount(axis: Extract<AxisSpec, { kind: "linear" }>, plotArea: Rect): number {
  if (axis.tickCount !== undefined) {
    return Math.max(2, axis.tickCount);
  }

  const density = resolveTickDensity(axis.tickDensity);
  const axisLength = isVerticalAxisPosition(axis.position) ? plotArea.height : plotArea.width;
  const minTickSpacing = (axis.minTickSpacing ?? 56) / density;
  const maxTickCount = Math.max(2, Math.floor((axis.maxTickCount ?? 12) * density));
  const densityCount = Math.floor(axisLength / minTickSpacing) + 1;

  return Math.max(2, Math.min(maxTickCount, densityCount));
}

function resolveTickDensity(density: number | undefined): number {
  return Number.isFinite(density) && density !== undefined
    ? Math.max(0.1, Math.min(10, density))
    : 1;
}

function resolveSubticks(
  axis: Extract<AxisSpec, { kind: "linear" }>,
  ticks: readonly number[],
  min: number,
  max: number
): readonly number[] {
  if (!axis.subticks || ticks.length < 2) {
    return [];
  }

  const values: number[] = [];
  const majorSet = new Set(ticks.map((tick) => tickKey(tick)));

  for (let index = 0; index < ticks.length - 1; index += 1) {
    const start = ticks[index] as number;
    const end = ticks[index + 1] as number;
    const count = resolveSubtickCount(axis.subticks, end - start, axis);

    if (count <= 0) {
      continue;
    }

    const step = (end - start) / (count + 1);

    if (!Number.isFinite(step) || step <= 0) {
      continue;
    }

    for (let offset = 1; offset <= count; offset += 1) {
      const value = start + step * offset;

      if (value > min && value < max && !majorSet.has(tickKey(value))) {
        values.push(value);
      }
    }
  }

  return values;
}

function resolveSubtickCount(
  subticks: boolean | number | undefined,
  interval: number,
  axis?: { timeHasSubMinutePrecision?: boolean }
): number {
  if (typeof subticks === "number") {
    return Math.max(0, Math.floor(subticks));
  }

  if (!subticks || !Number.isFinite(interval) || interval <= 0) {
    return 0;
  }

  if (approximatelyOneOf(interval, [minuteMs]) && !axis?.timeHasSubMinutePrecision) {
    return 0;
  }

  if (approximatelyOneOf(interval, [5 * minuteMs, 5 * hourMs, 5 * dayMs])) {
    return 4;
  }

  const magnitude = 10 ** Math.floor(Math.log10(interval));
  const normalized = interval / magnitude;
  const rounded = Math.round(normalized * 1000) / 1000;

  if (approximatelyOneOf(interval, [1])) {
    return 0;
  }

  if (approximatelyOneOf(rounded, [1, 2, 10])) {
    return 1;
  }

  if (approximatelyOneOf(rounded, [2.5, 5, 25, 50])) {
    return 4;
  }

  return 1;
}

function approximatelyOneOf(value: number, candidates: readonly number[]): boolean {
  return candidates.some((candidate) => Math.abs(value - candidate) < 1e-6);
}

function resolveSubtickSize(axis: Extract<AxisSpec, { kind: "linear" }>): number {
  return axis.subtickSize ?? Math.max(2, Math.floor((axis.tickSize ?? 6) * 0.55));
}

/** Distance from plot edge to the label anchor. */
function resolveVerticalLabelOffset(
  axis: { ticks?: boolean; tickSize?: number },
  tickScale = 1
): number {
  const gap = 4;
  return (axis.tickSize ?? 6) * tickScale + gap;
}

function tickKey(value: number): string {
  return value.toPrecision(12);
}

function resolveBottomLabelAlign(angle: number): CanvasTextAlign {
  return angle === 0 ? "center" : "left";
}

function resolveBottomLabelBaseline(angle: number): CanvasTextBaseline {
  return Math.abs(angle) >= 80 ? "middle" : "top";
}

function resolveBottomLabelOffset(_angle: number, _theme: Theme): number {
  return 4;
}

function formatAxisTick(axis: AxisSpec, value: number): string {
  return axis.labelFormatter ? axis.labelFormatter(value) : formatTick(value);
}

function formatTick(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function niceTicks(min: number, max: number, desiredCount: number, minStep = 0, includeBounds = false): readonly number[] {
  const span = max - min;

  if (!Number.isFinite(span) || span <= 0) {
    return [min, max];
  }

  const step = minStep > 0
    ? Math.max(minStep, niceIntegerStep(span / Math.max(1, desiredCount - 1)))
    : niceStep(span / Math.max(1, desiredCount - 1));
  const start = Math.ceil(min / step) * step;
  const end = Math.floor(max / step) * step;
  const ticks: number[] = [];

  for (let value = start; value <= end + step / 2; value += step) {
    ticks.push(roundTick(value, step));
  }

  if (includeBounds) {
    const first = roundTick(min, step);
    const last = roundTick(max, step);

    if (ticks[0] !== first) {
      ticks.unshift(first);
    }
    if (ticks[ticks.length - 1] !== last) {
      ticks.push(last);
    }
  } else if (ticks[0] !== min && min === 0) {
    ticks.unshift(0);
  }

  return ticks.length > 0 ? ticks : [min, max];
}

function shouldIncludeLinearBounds(axis: Extract<AxisSpec, { kind: "linear" }>): boolean {
  if (axis.includeBounds === false) {
    return false;
  }
  if (axis.includeBounds === true) {
    return true;
  }
  return axis.nice === false &&
    axis.tickStepMin !== undefined &&
    Number.isInteger(axis.domain[0]) &&
    Number.isInteger(axis.domain[1]);
}

function niceStep(rawStep: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;

  if (normalized <= 1) return magnitude;
  if (normalized <= 2) return 2 * magnitude;
  if (normalized <= 2.5) return 2.5 * magnitude;
  if (normalized <= 5) return 5 * magnitude;
  return 10 * magnitude;
}

function niceIntegerStep(rawStep: number): number {
  if (!Number.isFinite(rawStep) || rawStep <= 1) {
    return 1;
  }

  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;

  if (normalized <= 1) return magnitude;
  if (normalized <= 2) return 2 * magnitude;
  if (normalized <= 5) return 5 * magnitude;

  return 10 * magnitude;
}

function roundTick(value: number, step: number): number {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));

  return Number(value.toFixed(decimals + 1));
}

function font(theme: Theme): string {
  return `${theme.typography.fontSize}px ${theme.typography.fontFamily}`;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function isVerticalAxisPosition(position: AxisPosition): position is VerticalAxisPosition {
  return position === "left" || position === "right";
}

const rgbCache = new Map<string, { r: number; g: number; b: number } | null>();

function parseRgb(color: string): { r: number; g: number; b: number } | null {
  const cached = rgbCache.get(color);
  if (cached !== undefined) return cached;

  if (color.startsWith("#") && (color.length === 7 || color.length === 4)) {
    const hex = color.length === 4
      ? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`
      : color;
    const r = Number.parseInt(hex.slice(1, 3), 16);
    const g = Number.parseInt(hex.slice(3, 5), 16);
    const b = Number.parseInt(hex.slice(5, 7), 16);
    const result = { r, g, b };
    rgbCache.set(color, result);
    return result;
  }

  rgbCache.set(color, null);
  return null;
}

function withAlpha(color: string, alpha: number): string {
  if (!color) return color;
  const rgb = parseRgb(color);
  if (rgb) {
    return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
  }

  return color;
}

function resolveTickFadeAlpha(
  fade: AxisTickFadeState | undefined,
  key: string,
  baseAlpha: number
): number {
  if (!fade || fade.durationMs <= 0 || baseAlpha <= 0) {
    return baseAlpha;
  }

  fade.activeKeys.add(key);
  let appearedAt = fade.appearedAt.get(key);
  if (appearedAt === undefined) {
    appearedAt = fade.initialized ? fade.now : fade.now - fade.durationMs;
    fade.appearedAt.set(key, appearedAt);
  }

  const progress = clamp01((fade.now - appearedAt) / fade.durationMs);
  return baseAlpha * easeOutCubic(progress);
}

function linearTickFadeKey(
  axis: Extract<AxisSpec, { kind: "linear" }>,
  value: number,
  subtick: boolean
): string {
  return `${subtick ? "sub" : "tick"}:linear:${axis.position}:${tickKey(value)}`;
}

function bandTickFadeKey(
  axis: Extract<AxisSpec, { kind: "band" }>,
  tick: BandTick,
  subtick: boolean
): string {
  const value = tick.time ?? tick.value ?? tick.index;
  return `${subtick ? "sub" : "tick"}:band:${axis.position}:${tickKey(value)}:${tick.label}`;
}

function resolveOriginExtendLineProgress(animation: AxisAnimationState): number {
  return animation.lineProgress ?? animation.progress;
}

function resolveLineTriggeredTickProgress(
  posRatio: number,
  animation: AxisAnimationState,
  isLast?: boolean
): number | undefined {
  const clampedPos = clamp01(posRatio);
  const triggerFinalTickEarly = animation.profile === "origin-extend" && isLast;
  const triggerRatio = triggerFinalTickEarly ? clampedPos * 0.97 : clampedPos;
  const lineProgress = resolveOriginExtendLineProgress(animation);

  if (lineProgress < triggerRatio) {
    return undefined;
  }

  const {
    elapsedMs,
    lineDurationMs,
    tickAnimMs,
    lineEasing
  } = animation;

  if (
    elapsedMs === undefined ||
    lineDurationMs === undefined ||
    tickAnimMs === undefined ||
    lineEasing === undefined
  ) {
    return 1;
  }

  return resolveOriginExtendTickProgress(
    clampedPos,
    lineProgress,
    elapsedMs,
    lineDurationMs,
    tickAnimMs,
    lineEasing,
    triggerFinalTickEarly
  );
}

function resolveOriginExtendTick(
  posRatio: number,
  animation: AxisAnimationState,
  isLast?: boolean
): { drawTick: boolean; alpha: number } {
  const tickProgress = resolveLineTriggeredTickProgress(posRatio, animation, isLast);

  if (tickProgress === undefined) {
    return { drawTick: false, alpha: 0 };
  }

  return {
    drawTick: true,
    alpha: easeOutCubic(tickProgress)
  };
}

function resolveDomainExpansionTick(
  posRatio: number,
  animation: AxisAnimationState,
  isLast?: boolean
): { drawTick: boolean; alpha: number; xShift: number; yShift: number; tickScale: number } {
  const tickProgress = resolveLineTriggeredTickProgress(posRatio, animation, isLast);

  if (tickProgress === undefined) {
    return { drawTick: false, alpha: 0, xShift: 0, yShift: 0, tickScale: 1 };
  }

  const tickScale = easeOutCubic(tickProgress);

  return {
    drawTick: tickProgress > 0,
    alpha: tickScale,
    xShift: 0,
    yShift: 0,
    tickScale
  };
}

function getAxisAnimationParams(
  posRatio: number,
  position: AxisPosition,
  animation?: AxisAnimationState,
  isLast?: boolean
) {
  if (!animation) {
    return { drawLine: true, drawTick: true, alpha: 1, xShift: 0, yShift: 0, tickScale: 1 };
  }

  const { progress, profile } = animation;
  
  if (profile === "origin-extend") {
    const reveal = resolveOriginExtendTick(posRatio, animation, isLast);
    return {
      drawLine: true,
      drawTick: reveal.drawTick,
      alpha: reveal.alpha,
      xShift: 0,
      yShift: 0,
      tickScale: 1
    };
  }

  if (profile === "domain-expansion") {
    const reveal = resolveDomainExpansionTick(posRatio, animation, isLast);
    return {
      drawLine: true,
      drawTick: reveal.drawTick,
      alpha: reveal.alpha,
      xShift: reveal.xShift,
      yShift: reveal.yShift,
      tickScale: reveal.tickScale
    };
  }
  
  if (profile === "fade-slide") {
    const shift = 10 * (1 - progress);
    return {
      drawLine: true,
      drawTick: true,
      alpha: progress,
      xShift: position === "left" ? -shift : position === "right" ? shift : 0,
      yShift: position === "bottom" ? shift : 0,
      tickScale: 1
    };
  }

  if (profile === "fade") {
    return {
      drawLine: true,
      drawTick: true,
      alpha: progress,
      xShift: 0,
      yShift: 0,
      tickScale: 1
    };
  }
  
  if (profile === "staggered-pop") {
    const delay = clamp01(posRatio) * 0.5;
    const localProgress = clamp01((progress - delay) / 0.5);
    const popShift = 10 * (1 - localProgress);
    return {
      drawLine: true,
      drawTick: localProgress > 0,
      alpha: localProgress,
      xShift: position === "left" ? -popShift : position === "right" ? popShift : 0,
      yShift: position === "bottom" ? popShift : 0,
      tickScale: localProgress
    };
  }

  return { drawLine: true, drawTick: true, alpha: 1, xShift: 0, yShift: 0, tickScale: 1 };
}

function getAxisLinePoints(
  position: AxisPosition,
  plotArea: Rect,
  animation?: AxisAnimationState
): { points: readonly [number, number][]; alpha: number } {
  const x = position === "right" ? plotArea.x + plotArea.width : plotArea.x;
  const y = plotArea.y + plotArea.height;
  
  if (!animation) {
    return {
      points: isVerticalAxisPosition(position)
        ? [[x, plotArea.y], [x, y]] 
        : [[plotArea.x, y], [plotArea.x + plotArea.width, y]],
      alpha: 1
    };
  }

  const { progress, profile } = animation;

  if (profile === "origin-extend" || profile === "domain-expansion") {
    const lineProgress = resolveOriginExtendLineProgress(animation);

    return {
      points: isVerticalAxisPosition(position)
        ? [[x, y], [x, y - plotArea.height * lineProgress]]
        : [[plotArea.x, y], [plotArea.x + plotArea.width * lineProgress, y]],
      alpha: 1
    };
  }

  if (profile === "fade-slide") {
    const shift = 10 * (1 - progress);
    return {
      points: isVerticalAxisPosition(position)
        ? [[x + (position === "right" ? shift : -shift), plotArea.y], [x + (position === "right" ? shift : -shift), y]]
        : [[plotArea.x, y + shift], [plotArea.x + plotArea.width, y + shift]],
      alpha: progress
    };
  }

  if (profile === "fade") {
    return {
      points: isVerticalAxisPosition(position)
        ? [[x, plotArea.y], [x, y]]
        : [[plotArea.x, y], [plotArea.x + plotArea.width, y]],
      alpha: progress
    };
  }

  // staggered-pop or others draw immediately
  return {
    points: isVerticalAxisPosition(position)
      ? [[x, plotArea.y], [x, y]] 
      : [[plotArea.x, y], [plotArea.x + plotArea.width, y]],
    alpha: 1
  };
}

export function encodeGridlines(
  axes: AxesSpec | undefined,
  plotArea: Rect,
  theme: Theme,
  animation?: AxisAnimationState,
  tickFade?: AxisTickFadeState
): readonly Primitive[] {
  if (!axes) {
    return [];
  }

  const primitives: Primitive[] = [];

  // X Axis Gridlines (vertical lines across plotArea)
  if (axes.x && axes.x.gridlines) {
    const xThickness = axes.x.gridlineThickness ?? DEFAULT_GRIDLINE_THICKNESS;
    const xDash = resolveGridlineDash(axes.x.gridlineStyle, xThickness);
    if (axes.x.subgridlines && axes.x.kind === "linear") {
      const subgridlines = getLinearAxisSubgridlinePositionsAndValues(axes.x, plotArea, theme);
      for (const { ratio, value } of subgridlines) {
        if (ratio < 0 || ratio > 1) continue;
        if (isAxisBoundaryGridline(ratio) && !axes.x.edgeGridlines) continue;
        const tRatio = clamp01(ratio);
        const anim = getAxisAnimationParams(tRatio, "bottom", animation);
        if (!anim.drawTick) continue;

        const alpha = resolveTickFadeAlpha(tickFade, linearTickFadeKey(axes.x, value, true), anim.alpha * 0.45);
        const x = plotArea.x + ratio * plotArea.width + anim.xShift;
        primitives.push({
          kind: "path",
          points: [
            [x, plotArea.y],
            [x, plotArea.y + plotArea.height]
          ],
          stroke: withAlpha(theme.palette.grid, alpha),
          strokeWidth: Math.max(0.5, xThickness * 0.65),
          ...(xDash ? { strokeDash: xDash } : {})
        });
      }
    }

    const gridlines = getAxisGridlineInfos(axes.x, plotArea, theme);
    for (const info of gridlines) {
      const { ratio } = info;
      if (ratio < 0 || ratio > 1) continue;
      if (isAxisBoundaryGridline(ratio) && !axes.x.edgeGridlines) continue;
      const tRatio = clamp01(ratio);
      const anim = getAxisAnimationParams(tRatio, "bottom", animation);
      if (!anim.drawTick) continue;

      let alpha = anim.alpha;
      if (info.kind === "linear" && axes.x.kind === "linear") {
        alpha = resolveTickFadeAlpha(tickFade, linearTickFadeKey(axes.x, info.value, false), anim.alpha);
      } else if (info.kind === "band" && axes.x.kind === "band") {
        alpha = resolveTickFadeAlpha(tickFade, bandTickFadeKey(axes.x, info.tick, false), anim.alpha);
      }

      const x = plotArea.x + ratio * plotArea.width + anim.xShift;
      
      primitives.push({
        kind: "path",
        points: [
          [x, plotArea.y],
          [x, plotArea.y + plotArea.height]
        ],
        stroke: withAlpha(theme.palette.grid, alpha),
        strokeWidth: xThickness,
        ...(xDash ? { strokeDash: xDash } : {})
      });
    }
  }

  // Y Axis Gridlines (horizontal lines across plotArea)
  if (axes.y && axes.y.gridlines) {
    const yThickness = axes.y.gridlineThickness ?? DEFAULT_GRIDLINE_THICKNESS;
    const yDash = resolveGridlineDash(axes.y.gridlineStyle, yThickness);
    if (axes.y.subgridlines && axes.y.kind === "linear") {
      const subgridlines = getLinearAxisSubgridlinePositionsAndValues(axes.y, plotArea, theme);
      for (const { ratio, value } of subgridlines) {
        if (ratio < 0 || ratio > 1) continue;
        if (isAxisBoundaryGridline(ratio) && !axes.y.edgeGridlines) continue;
        const tRatio = clamp01(ratio);
        const anim = getAxisAnimationParams(tRatio, axes.y.position, animation);
        if (!anim.drawTick) continue;

        const alpha = resolveTickFadeAlpha(tickFade, linearTickFadeKey(axes.y, value, true), anim.alpha * 0.45);
        const y = plotArea.y + plotArea.height - ratio * plotArea.height + anim.yShift;
        primitives.push({
          kind: "path",
          points: [
            [plotArea.x, y],
            [plotArea.x + plotArea.width, y]
          ],
          stroke: withAlpha(theme.palette.grid, alpha),
          strokeWidth: Math.max(0.5, yThickness * 0.65),
          ...(yDash ? { strokeDash: yDash } : {})
        });
      }
    }

    const gridlines = getAxisGridlineInfos(axes.y, plotArea, theme);
    for (const info of gridlines) {
      const { ratio } = info;
      if (ratio < 0 || ratio > 1) continue;
      if (isAxisBoundaryGridline(ratio) && !axes.y.edgeGridlines) continue;
      const tRatio = clamp01(ratio);
      const anim = getAxisAnimationParams(tRatio, axes.y.position, animation);
      if (!anim.drawTick) continue;

      let alpha = anim.alpha;
      if (info.kind === "linear" && axes.y.kind === "linear") {
        alpha = resolveTickFadeAlpha(tickFade, linearTickFadeKey(axes.y, info.value, false), anim.alpha);
      } else if (info.kind === "band" && axes.y.kind === "band") {
        alpha = resolveTickFadeAlpha(tickFade, bandTickFadeKey(axes.y, info.tick, false), anim.alpha);
      }

      const y = plotArea.y + plotArea.height - ratio * plotArea.height + anim.yShift;

      primitives.push({
        kind: "path",
        points: [
          [plotArea.x, y],
          [plotArea.x + plotArea.width, y]
        ],
        stroke: withAlpha(theme.palette.grid, alpha),
        strokeWidth: yThickness,
        ...(yDash ? { strokeDash: yDash } : {})
      });
    }
  }

  return primitives;
}

function resolveGridlineDash(
  style: "solid" | "dotted" | "dashed" | undefined,
  thickness: number
): readonly number[] | undefined {
  if (style === "dotted") {
    const dot = Math.max(1, thickness);
    return [dot, Math.max(2, thickness * 2.5)];
  }
  if (style === "dashed") {
    return [Math.max(4, thickness * 4), Math.max(3, thickness * 3)];
  }
  return undefined;
}

function isAxisBoundaryGridline(t: number): boolean {
  return Math.abs(t) < 1e-6 || Math.abs(1 - t) < 1e-6;
}

type GridlineInfo = 
  | { kind: "linear"; ratio: number; value: number }
  | { kind: "band"; ratio: number; tick: BandTick };

function getAxisGridlineInfos(
  axis: AxisSpec,
  plotArea: Rect,
  theme: Theme
): readonly GridlineInfo[] {
  if (axis.kind === "linear") {
    const { min, span, ticks } = resolveLinearAxisEncoding(axis, plotArea, theme);
    const mapped = ticks.map(value => ({
      kind: "linear" as const,
      ratio: (value - min) / span,
      value
    }));
    const stride = Math.max(1, Math.floor(axis.gridlineEvery ?? 1));
    return stride === 1
      ? mapped
      : mapped.filter((_, index) => index % stride === 0);
  } else {
    const count = resolveBandCount(axis);
    const slotWidth = count > 0
      ? (isVerticalAxisPosition(axis.position) ? plotArea.height : plotArea.width) / count
      : isVerticalAxisPosition(axis.position) ? plotArea.height : plotArea.width;
    
    const numericLabels = axis.numericDomain
      ? [axis.numericDomain[0], axis.numericDomain[1]]
      : axis.labels.map((label) => Number(label));
    const isNumeric = axis.numeric ?? numericLabels.every(Number.isFinite);
    const maxTicks = resolveMaxBandTicks(axis, plotArea, theme, isNumeric);

    let ticks: readonly BandTick[];
    if (axis.visibleBandRange) {
      if (axis.timeDomain) {
        ticks = resolveVisibleTimeBandTicks(axis, plotArea, theme);
      } else {
        ticks = resolveVisibleBandTicks(axis, plotArea, theme);
      }
    } else if (isNumeric) {
      ticks = resolveNumericBandTicks(numericLabels, count, maxTicks, axis, plotArea, theme);
    } else {
      const indexTicks = uniqueTicks([
        0,
        ...niceTicks(0, count - 1, maxTicks).filter((tick) => tick > 0 && tick < count - 1),
        count - 1
      ]);
      ticks = indexTicks.map((value) => {
        const index = Math.max(0, Math.min(count - 1, Math.round(value)));
        return {
          index,
          label: resolveBandLabel(axis, index, count)
        };
      });
    }

    const mapped = ticks.map(tick => {
      let ratio = 0;
      if (isVerticalAxisPosition(axis.position)) {
        const y = resolveBandTickY(axis, tick, plotArea, plotArea, slotWidth);
        ratio = plotArea.height > 0 ? (plotArea.y + plotArea.height - y) / plotArea.height : 0;
      } else {
        const x = resolveBandTickX(axis, tick, plotArea, plotArea, slotWidth);
        ratio = plotArea.width > 0 ? (x - plotArea.x) / plotArea.width : 0;
      }
      return {
        kind: "band" as const,
        ratio,
        tick
      };
    });

    const stride = Math.max(1, Math.floor(axis.gridlineEvery ?? 1));
    return stride === 1
      ? mapped
      : mapped.filter((_, index) => index % stride === 0);
  }
}

function getLinearAxisSubgridlinePositionsAndValues(
  axis: AxisSpec,
  plotArea: Rect,
  theme: Theme
): readonly { ratio: number; value: number }[] {
  if (axis.kind !== "linear") {
    return [];
  }

  const { min, span, subticks } = resolveLinearAxisEncoding(
    { ...axis, subticks: axis.subticks ?? true },
    plotArea,
    theme
  );

  return subticks.map((value) => ({
    ratio: (value - min) / span,
    value
  }));
}
