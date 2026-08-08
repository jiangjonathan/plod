import type { AnimationProfile, CornerRadii, LineCurve, Primitive, TooltipContent, TooltipResult } from "../core/types";
import type { Mark, Accessor } from "./types";
import { readAccessor } from "./accessor";
import { calculatePathLength, findXAtLength } from "./lineGeometry";

/** Default stroke used when a line chart does not set `strokeWidth`. Keep in sync with settings UI. */
export const DEFAULT_LINE_STROKE_WIDTH = 1.5;
/** Default area fill opacity when `areaOpacity` is unset. Keep in sync with settings UI. */
export const DEFAULT_LINE_AREA_OPACITY = 0.18;

export type LineMarkOptions<TDatum> = {
  x: Accessor<TDatum, number>;
  y: Accessor<TDatum, number>;
  series?: Accessor<TDatum, string | number>;
  seriesOrder?: readonly (string | number)[];
  yDomain?: readonly [number, number];
  stroke?: string;
  strokes?: readonly string[];
  signedStrokes?: {
    positive: string;
    negative: string;
  };
  strokeWidth?: number;
  pointRadius?: number;
  curve?: LineCurve;
  area?: boolean;
  areaFill?: string;
  /** Per-series fill colors (falls back to `areaFill`, then the series stroke). */
  areaFills?: readonly string[];
  /** Opacity applied to the area fill (0–1). Defaults to the fill's own alpha. */
  areaOpacity?: number;
  /** Where the area closes: plot bottom (default) or y = 0 in data space. */
  areaBaseline?: "plot" | "zero";
  /**
   * How overlapping series fills combine:
   * - `blend` — translucent source-over (colors mix in overlaps)
   * - `cover` — later series cover earlier without muddy color mixing
   * - `multiply` / `screen` — canvas composite modes
   */
  areaOverlap?: "blend" | "cover" | "multiply" | "screen";
  /** Draw the line stroke on top of the fill. Defaults to true. */
  areaStroke?: boolean;
  tooltip?: boolean | ((datum: TDatum, index: number) => TooltipResult);
  tooltipVisibleOnly?: boolean;
  lineFocus?: boolean;
};

export function lineMark<TDatum>(options: LineMarkOptions<TDatum>): Mark<TDatum> {
  let cachedGeometry: LineGeometry<TDatum> | undefined;

  const getGeometry = (
    data: readonly TDatum[],
    layout: Parameters<Mark<TDatum>["encode"]>[1]
  ): LineGeometry<TDatum> => {
    const xDomain = layout.xDomain ?? layout.dataWindow?.visibleX ?? extent(data, options.x);
    const yDomain = layout.yDomain ?? options.yDomain ?? extent(data, options.y);

    if (
      cachedGeometry &&
      cachedGeometry.data === data &&
      samePlotArea(cachedGeometry.plotArea, layout.plotArea) &&
      sameHiddenSeries(cachedGeometry.hiddenSeries, layout.hiddenSeries)
    ) {
      if (
        !sameDomain(cachedGeometry.xDomain, xDomain) ||
        !sameDomain(cachedGeometry.yDomain, yDomain)
      ) {
        reprojectLineGeometry(cachedGeometry, layout.plotArea, xDomain, yDomain);
      }

      return cachedGeometry;
    }

    cachedGeometry = buildLineGeometry(data, layout.plotArea, xDomain, yDomain, options, layout.hiddenSeries);
    return cachedGeometry;
  };

  return {
    kind: "line",
    encode(data, layout, theme): readonly Primitive[] {
      if (data.length === 0) {
        return [];
      }

      if (layout.hoverOnly) {
        const geometry = getGeometry(data, layout);
        const hovered = layout.hover?.markType === "line"
          ? resolveHoveredLinePoints(geometry.pointData, geometry.hoverablePointsByIndex, layout.hover, options, geometry.pointsBySeries)
          : undefined;

        return resolveLineHoverPrimitives(
          hovered,
          layout.plotArea,
          layout.clipArea,
          options,
          theme.palette.background,
          theme.palette.series,
          theme.palette.foreground,
          layout.hover?.seriesIndex
        );
      }

      const geometry = getGeometry(data, layout);
      const { grouped, hoverablePoints, pointData, pointsBySeries, xDomain, yDomain } = geometry;

      const primitives: Primitive[] = [];
      const hovered = layout.hover?.markType === "line"
        ? resolveHoveredLinePoints(pointData, geometry.hoverablePointsByIndex, layout.hover, options, geometry.pointsBySeries)
        : undefined;

      const isHovered = layout.hover?.markType === "line" && layout.hover?.seriesIndex !== undefined;
      const focusTransition = options.lineFocus ? layout.lineFocusTransition : undefined;
      const focusDimProgress = focusTransition?.dimProgress ?? (isHovered ? 1 : 0);
      const renderSeries = focusDimProgress > 0.001 && options.lineFocus
        ? [...grouped.series].sort((left, right) => {
          const leftEmphasis = focusTransition?.emphasisBySeries.get(left.index) ??
            (left.index === layout.hover?.seriesIndex ? 1 : 0);
          const rightEmphasis = focusTransition?.emphasisBySeries.get(right.index) ??
            (right.index === layout.hover?.seriesIndex ? 1 : 0);
          return leftEmphasis - rightEmphasis;
        })
        : grouped.series;

      for (const series of renderSeries) {
        if (layout.hiddenSeries && (layout.hiddenSeries.has(series.key) || layout.hiddenSeries.has(String(series.key)))) {
          continue;
        }
        const seriesPoints = includeLineContinuityPoints(
          resolveRenderableSeriesPoints(pointsBySeries.get(series.index) ?? [], layout.animation, xDomain),
          xDomain
        );
        // Area must share the same top-edge samples as the stroke. Screen-space
        // envelopes shimmer in streaming "all" view as the domain compresses
        // and pixel-bucket membership flips — LOD already budgets density.
        const points = seriesPoints.map<[number, number]>((point) => [point.x, point.y]);
        const baselineY = options.area
          ? resolveAreaBaselineY(layout.plotArea, yDomain, options.areaBaseline ?? "plot")
          : layout.plotArea.y + layout.plotArea.height;
        
        let stroke = resolveAnimatedLineColor(
          resolveLineStroke(options, theme.palette.series, theme.palette.foreground, series.index),
          layout.animation
        );

        const seriesEmphasis = options.lineFocus
          ? focusTransition?.emphasisBySeries.get(series.index) ??
            (isHovered && layout.hover?.seriesIndex === series.index ? 1 : 0)
          : 0;
        const backgroundOpacity = 1 - focusDimProgress * 0.86;
        const seriesOpacity = backgroundOpacity + (1 - backgroundOpacity) * seriesEmphasis;
        if (options.lineFocus && seriesOpacity < 0.999) {
          stroke = withAlpha(stroke, seriesOpacity);
        }

        if (options.area) {
          const opacity = options.areaOpacity ?? DEFAULT_LINE_AREA_OPACITY;
          const overlap = options.areaOverlap ?? "blend";
          const baseFill = resolveAreaFillColor(options, stroke, series.index);

          let areaClip = layout.clipArea ?? layout.plotArea;
          if (layout.animation && (layout.animation.profile === "draw-left" || layout.animation.profile === "draw-right")) {
            const progress = Math.max(0, Math.min(1, layout.animation.progress));
            const totalLength = calculatePathLength(points, options.curve ?? "linear");
            const targetLength = totalLength * progress;
            const targetX = findXAtLength(points, options.curve ?? "linear", targetLength);

            if (layout.animation.profile === "draw-left") {
              areaClip = {
                ...areaClip,
                width: Math.max(0, targetX - areaClip.x)
              };
            } else {
              const reversedPoints = [...points].reverse();
              const targetXRight = findXAtLength(reversedPoints, options.curve ?? "linear", targetLength);
              areaClip = {
                ...areaClip,
                x: targetXRight,
                width: Math.max(0, (layout.plotArea.x + layout.plotArea.width) - targetXRight)
              };
            }
          } else {
            areaClip = resolveLineClip(layout.plotArea, layout.clipArea, layout.animation);
          }

          const areaPrimitive = resolveAreaFillPrimitive(
            points,
            baseFill,
            opacity,
            overlap,
            baselineY,
            areaClip,
            options.curve ?? "linear"
          );
          if (options.lineFocus && seriesOpacity < 0.999) {
            primitives.push({
              ...areaPrimitive,
              ...(areaPrimitive.fillOpacity !== undefined
                ? { fillOpacity: areaPrimitive.fillOpacity * seriesOpacity }
                : { fill: withAlpha(areaPrimitive.fill ?? baseFill, (options.areaOpacity ?? DEFAULT_LINE_AREA_OPACITY) * seriesOpacity) })
            });
          } else {
            primitives.push(areaPrimitive);
          }
        }

        if (!options.area || options.areaStroke !== false) {
          const linePrimitives = resolveLinePathPrimitives(
            points,
            stroke,
            layout.plotArea,
            layout.clipArea,
            layout.animation,
            options,
            yDomain
          );
          if (options.lineFocus && seriesEmphasis > 0.001) {
            const baseStrokeWidth = options.strokeWidth ?? DEFAULT_LINE_STROKE_WIDTH;
            const widthLift = Math.max(0.75, baseStrokeWidth * 0.4) * seriesEmphasis;
            primitives.push(...linePrimitives.map((primitive) => ({
              ...primitive,
              stroke: withAlpha(theme.palette.background, 0.72 * seriesEmphasis),
              strokeWidth: (primitive.strokeWidth ?? baseStrokeWidth) + widthLift + 1.5
            })));
            primitives.push(...linePrimitives.map((primitive) => ({
              ...primitive,
              strokeWidth: (primitive.strokeWidth ?? baseStrokeWidth) + widthLift
            })));
          } else {
            primitives.push(...linePrimitives);
          }
        }
      }

      primitives.push(...resolveLineHoverPrimitives(hovered, layout.plotArea, layout.clipArea, options, theme.palette.background, theme.palette.series, theme.palette.foreground, layout.hover?.seriesIndex));

      primitives.push(...resolveHoverBands(
        options.lineFocus ? pointData : hoverablePoints,
        layout.plotArea,
        options,
        theme.palette.series,
        theme.palette.foreground,
        geometry.hoverIndex,
        focusTransition?.pinnedSeriesIndex
      ));

      return primitives;
    }
  };
}

type LineGeometry<TDatum> = {
  data: readonly TDatum[];
  plotArea: { x: number; y: number; width: number; height: number };
  xDomain: readonly [number, number];
  yDomain: readonly [number, number];
  grouped: ReturnType<typeof collectLineSeries<TDatum>>;
  pointData: readonly LinePoint<TDatum>[];
  hoverablePoints: readonly LinePoint<TDatum>[];
  hoverablePointsByIndex: ReadonlyMap<number, readonly LinePoint<TDatum>[]>;
  pointsBySeries: ReadonlyMap<number, readonly LinePoint<TDatum>[]>;
  hoverIndex: LineHoverIndex<TDatum>;
  hiddenSeries?: Set<string | number> | undefined;
};

type LineHoverIndex<TDatum> = {
  pointsBySeries: ReadonlyMap<number, readonly LinePoint<TDatum>[]>;
  seriesXMonotonic: ReadonlyMap<number, boolean>;
  hoverPoints: readonly LinePoint<TDatum>[];
  pointsByHoverIndex: ReadonlyMap<number, readonly LinePoint<TDatum>[]>;
};

function buildLineGeometry<TDatum>(
  data: readonly TDatum[],
  plotArea: { x: number; y: number; width: number; height: number },
  xDomain: readonly [number, number],
  yDomain: readonly [number, number],
  options: LineMarkOptions<TDatum>,
  hiddenSeries?: Set<string | number>
): LineGeometry<TDatum> {
  const xSpan = xDomain[1] - xDomain[0] || 1;
  const ySpan = yDomain[1] - yDomain[0] || 1;
  const grouped = collectLineSeries(data, options);
  const pointData: LinePoint<TDatum>[] = [];
  const pointsBySeries = new Map<number, LinePoint<TDatum>[]>();

  for (const series of grouped.series) {
    if (hiddenSeries && (hiddenSeries.has(series.key) || hiddenSeries.has(String(series.key)))) {
      continue;
    }
    const seriesPoints: LinePoint<TDatum>[] = [];

    for (const dataIndex of series.data) {
      const datum = data[dataIndex] as TDatum;
      const xValue = readAccessor(options.x, datum, dataIndex);
      const yValue = readAccessor(options.y, datum, dataIndex);
      const point = {
        datum,
        dataIndex,
        index: options.series ? grouped.xIndexByValue.get(xValue) ?? 0 : resolveDatumIndex(datum, dataIndex),
        seriesIndex: series.index,
        xValue,
        yValue,
        x: plotArea.x + ((xValue - xDomain[0]) / xSpan) * plotArea.width,
        y: plotArea.y + plotArea.height - ((yValue - yDomain[0]) / ySpan) * plotArea.height,
        ...(series.label !== undefined ? { seriesLabel: series.label } : {})
      };

      pointData.push(point);
      seriesPoints.push(point);
    }

    pointsBySeries.set(series.index, seriesPoints);
  }

  const hoverablePoints = pointData.filter((point) => point.x >= plotArea.x && point.x <= plotArea.x + plotArea.width);
  const pointsByHoverIndex = groupPointsByHoverIndex(hoverablePoints);

  return {
    data,
    plotArea: { ...plotArea },
    xDomain,
    yDomain,
    grouped,
    pointData,
    hoverablePoints,
    hoverablePointsByIndex: pointsByHoverIndex,
    pointsBySeries,
    hoverIndex: {
      pointsBySeries,
      seriesXMonotonic: resolveSeriesXMonotonic(pointsBySeries),
      hoverPoints: options.series
        ? collapseHoverPointsByX(hoverablePoints)
        : [...hoverablePoints].sort((left, right) => left.xValue - right.xValue),
      pointsByHoverIndex
    },
    hiddenSeries: cloneHiddenSeries(hiddenSeries)
  };
}

function reprojectLineGeometry<TDatum>(
  geometry: LineGeometry<TDatum>,
  plotArea: { x: number; y: number; width: number; height: number },
  xDomain: readonly [number, number],
  yDomain: readonly [number, number]
): void {
  const xSpan = xDomain[1] - xDomain[0] || 1;
  const ySpan = yDomain[1] - yDomain[0] || 1;

  geometry.plotArea = { ...plotArea };
  geometry.xDomain = xDomain;
  geometry.yDomain = yDomain;

  for (const point of geometry.pointData) {
    point.x = plotArea.x + ((point.xValue - xDomain[0]) / xSpan) * plotArea.width;
    point.y = plotArea.y + plotArea.height - ((point.yValue - yDomain[0]) / ySpan) * plotArea.height;
  }

  geometry.hoverablePoints = geometry.pointData.filter(
    (point) => point.x >= plotArea.x && point.x <= plotArea.x + plotArea.width
  );
  geometry.hoverablePointsByIndex = groupPointsByHoverIndex(geometry.hoverablePoints);
  geometry.hoverIndex = {
    pointsBySeries: geometry.pointsBySeries,
    seriesXMonotonic: resolveSeriesXMonotonic(geometry.pointsBySeries),
    hoverPoints: geometry.pointData.some((point) => point.seriesLabel !== undefined)
      ? collapseHoverPointsByX(geometry.hoverablePoints)
      : [...geometry.hoverablePoints].sort((left, right) => left.xValue - right.xValue),
    pointsByHoverIndex: geometry.hoverablePointsByIndex
  };
}

function sameHiddenSeries(
  left: Set<string | number> | undefined,
  right: Set<string | number> | undefined
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.size !== right.size) return false;
  for (const item of left) {
    if (!right.has(item)) return false;
  }
  return true;
}

function cloneHiddenSeries(
  hiddenSeries: Set<string | number> | undefined
): Set<string | number> | undefined {
  return hiddenSeries ? new Set(hiddenSeries) : undefined;
}

function sameDomain(
  left: readonly [number, number],
  right: readonly [number, number]
): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

function samePlotArea(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number }
): boolean {
  return left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height;
}

function resolveLinePathPrimitives<TDatum>(
  points: readonly [number, number][],
  fallbackStroke: string,
  plotArea: { x: number; y: number; width: number; height: number },
  clipArea: { x: number; y: number; width: number; height: number } | undefined,
  animation: { progress: number; profile: AnimationProfile } | undefined,
  options: LineMarkOptions<TDatum>,
  yDomain: readonly [number, number]
): Extract<Primitive, { kind: "path" }>[] {
  if (!options.signedStrokes) {
    return [linePathPrimitive(points, fallbackStroke, plotArea, clipArea, animation, options)];
  }

  const zeroY = yToScreen(0, yDomain, plotArea);
  const baseClip = resolveLineClip(plotArea, clipArea, animation);
  const positiveClip = intersectRects(baseClip, {
    x: plotArea.x,
    y: plotArea.y,
    width: plotArea.width,
    height: Math.max(0, zeroY - plotArea.y)
  });
  const negativeClip = intersectRects(baseClip, {
    x: plotArea.x,
    y: Math.max(plotArea.y, zeroY),
    width: plotArea.width,
    height: Math.max(0, plotArea.y + plotArea.height - zeroY)
  });
  const signed: Extract<Primitive, { kind: "path" }>[] = [];

  if (positiveClip && positiveClip.height > 0) {
    signed.push(linePathPrimitive(points, options.signedStrokes.positive, plotArea, positiveClip, undefined, options));
  }

  if (negativeClip && negativeClip.height > 0) {
    signed.push(linePathPrimitive(points, options.signedStrokes.negative, plotArea, negativeClip, undefined, options));
  }

  return signed;
}

function linePathPrimitive<TDatum>(
  points: readonly [number, number][],
  stroke: string,
  plotArea: { x: number; y: number; width: number; height: number },
  clipArea: { x: number; y: number; width: number; height: number } | undefined,
  animation: { progress: number; profile: AnimationProfile } | undefined,
  options: LineMarkOptions<TDatum>
): Extract<Primitive, { kind: "path" }> {
  const isDrawLeft = animation?.profile === "draw-left" && animation.progress < 1;
  const isDrawRight = animation?.profile === "draw-right" && animation.progress < 1;
  const curve = options.curve ?? "linear";
  const mappedCurve = isDrawRight
    ? (curve === "step-before" ? "step-after" : curve === "step-after" ? "step-before" : curve)
    : curve;
  const finalPoints = isDrawRight ? [...points].reverse() : points;
  const length = (isDrawLeft || isDrawRight) ? calculatePathLength(finalPoints, mappedCurve) : 0;

  return {
    kind: "path",
    points: finalPoints,
    stroke,
    strokeWidth: options.strokeWidth ?? DEFAULT_LINE_STROKE_WIDTH,
    clip: (isDrawLeft || isDrawRight) ? (clipArea ?? plotArea) : resolveLineClip(plotArea, clipArea, animation),
    curve: mappedCurve,
    ...((isDrawLeft || isDrawRight) ? {
      strokeDash: [length, length],
      strokeDashOffset: length * (1 - Math.max(0, Math.min(1, animation.progress)))
    } : {})
  };
}

function yToScreen(
  value: number,
  yDomain: readonly [number, number],
  plotArea: { y: number; height: number }
): number {
  const span = yDomain[1] - yDomain[0] || 1;

  return plotArea.y + plotArea.height - ((value - yDomain[0]) / span) * plotArea.height;
}

function intersectRects(
  a: { x: number; y: number; width: number; height: number; cornerRadii?: CornerRadii },
  b: { x: number; y: number; width: number; height: number }
): { x: number; y: number; width: number; height: number; cornerRadii?: CornerRadii } | undefined {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);

  if (right <= x || bottom <= y) {
    return undefined;
  }

  return {
    x,
    y,
    width: right - x,
    height: bottom - y,
    ...(a.cornerRadii !== undefined ? { cornerRadii: a.cornerRadii } : {})
  };
}

function resolveLineHoverPrimitives<TDatum>(
  hovered: readonly LinePoint<TDatum>[] | undefined,
  plotArea: { x: number; y: number; width: number; height: number },
  clipArea: { x: number; y: number; width: number; height: number } | undefined,
  options: LineMarkOptions<TDatum>,
  background: string,
  palette: readonly string[],
  foreground: string,
  hoveredSeriesIndex?: number
): Primitive[] {
  if (!hovered || hovered.length === 0) {
    return [];
  }

  const anchor = hovered[0] as LinePoint<TDatum>;
  
  let visiblePoints = hovered;
  if (options.lineFocus && hoveredSeriesIndex !== undefined) {
    visiblePoints = visiblePoints.filter((point) => point.seriesIndex === hoveredSeriesIndex);
  }
  if (options.tooltipVisibleOnly) {
    visiblePoints = visiblePoints.filter((point) => point.y >= plotArea.y && point.y <= plotArea.y + plotArea.height);
  }

  return [
    {
      kind: "path",
      points: [
        [anchor.x, plotArea.y],
        [anchor.x, plotArea.y + plotArea.height]
      ],
      stroke: "rgba(0, 0, 0, 0.28)",
      strokeWidth: 1,
      clip: clipArea ?? plotArea
    },
    ...visiblePoints.map((point) => ({
      kind: "circle" as const,
      x: point.x,
      y: point.y,
      radius: (options.pointRadius ?? 4) + (options.lineFocus ? 1 : 0),
      fill: background,
      stroke: resolveLineStroke(options, palette, foreground, point.seriesIndex),
      strokeWidth: (options.strokeWidth ?? DEFAULT_LINE_STROKE_WIDTH) + (options.lineFocus ? 0.75 : 0),
      clip: clipArea ?? plotArea
    }))
  ];
}

function resolveHoverBands<TDatum>(
  points: readonly LinePoint<TDatum>[],
  plotArea: { x: number; y: number; width: number; height: number },
  options: LineMarkOptions<TDatum>,
  palette: readonly string[],
  foreground: string,
  hoverIndex?: LineHoverIndex<TDatum>,
  pinnedSeriesIndex?: number
): Primitive[] {
  if (points.length === 0) {
    return [];
  }

  const pointsBySeries = options.lineFocus ? hoverIndex?.pointsBySeries ?? groupPointsBySeries(points) : undefined;
  const xHoverPoints = options.lineFocus || hoverIndex
    ? []
    : points.filter((point) => point.x >= plotArea.x && point.x <= plotArea.x + plotArea.width);
  const hoverPoints = options.lineFocus
    ? []
    : hoverIndex?.hoverPoints ?? (
      options.series
        ? collapseHoverPointsByX(xHoverPoints)
        : [...xHoverPoints].sort((left, right) => left.xValue - right.xValue)
    );
  const pointsByHoverIndex = !options.lineFocus && options.series
    ? hoverIndex?.pointsByHoverIndex ?? groupPointsByHoverIndex(points)
    : undefined;

  const resolveHit = (x: number, y: number) => {
    if (x < plotArea.x || x > plotArea.x + plotArea.width || y < plotArea.y || y > plotArea.y + plotArea.height) {
      return undefined;
    }

    if (options.lineFocus) {
      if (pinnedSeriesIndex !== undefined) {
        const pinnedPoints = pointsBySeries?.get(pinnedSeriesIndex) ?? [];
        const point = findClosestPinnedLinePoint(
          pinnedPoints,
          x,
          hoverIndex?.seriesXMonotonic.get(pinnedSeriesIndex) === true
        );
        if (!point) {
          return undefined;
        }

        const tooltip = resolveTooltip(options, point, [point], palette, foreground, plotArea);
        return {
          index: point.index,
          seriesIndex: pinnedSeriesIndex,
          hoverX: point.x,
          hoverY: point.y,
          hoverXValue: point.xValue,
          hoverYValue: point.yValue,
          tooltip,
          tooltipBounds: {
            x: point.x,
            y: point.y,
            width: 0,
            height: 0
          },
          x: plotArea.x,
          y: plotArea.y,
          width: plotArea.width,
          height: plotArea.height
        };
      }

      const lineHit = pointsBySeries
        ? findClosestLineFocusHit(pointsBySeries, x, y, plotArea, options, hoverIndex?.seriesXMonotonic)
        : undefined;
      return lineHit ? resolveLineFocusHit(lineHit, options, palette, foreground, plotArea) : undefined;
    }

    if (hoverPoints.length === 0) {
      return undefined;
    }

    let low = 0;
    let high = hoverPoints.length - 1;

    while (low < high) {
      const mid = (low + high) >> 1;
      const midPoint = hoverPoints[mid];
      if (midPoint && midPoint.x < x) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }

    let closestIndex = low;
    const lowPoint = hoverPoints[low];
    let minDistance = lowPoint ? Math.abs(lowPoint.x - x) : Infinity;

    const leftPoint = hoverPoints[low - 1];
    if (leftPoint) {
      const leftDistance = Math.abs(leftPoint.x - x);
      if (leftDistance < minDistance) {
        closestIndex = low - 1;
        minDistance = leftDistance;
      }
    }

    const point = hoverPoints[closestIndex];
    if (!point) {
      return undefined;
    }

    const previous = hoverPoints[closestIndex - 1];
    const next = hoverPoints[closestIndex + 1];
    const left = previous ? (previous.x + point.x) / 2 : point.x - resolveEdgeBandWidth(point, next);
    const right = next ? (point.x + next.x) / 2 : point.x + resolveEdgeBandWidth(point, previous);
    const bandX = Math.max(plotArea.x, left);
    const bandWidth = Math.min(plotArea.x + plotArea.width, right) - bandX;

    if (bandWidth <= 0) {
      return undefined;
    }

    const associatedPoints = resolveAssociatedSeriesPoints(
      point,
      pointsByHoverIndex ?? new Map(),
      isAggregatedLinePoint(point) ? hoverIndex?.pointsBySeries ?? groupPointsBySeries(points) : undefined,
      y
    );
    const closestPoint = associatedPoints.reduce((best, candidate) => (
      Math.abs(candidate.y - y) < Math.abs(best.y - y) ? candidate : best
    ));

    const tooltip = resolveTooltip(options, point, associatedPoints, palette, foreground, plotArea);
    const hasValidSeries = !options.lineFocus && Math.abs(closestPoint.y - y) <= 24;

    return {
      index: point.index,
      ...(hasValidSeries ? { seriesIndex: closestPoint.seriesIndex } : {}),
      hoverX: point.x,
      hoverY: closestPoint.y,
      hoverXValue: point.xValue,
      hoverYValue: closestPoint.yValue,
      tooltip,
      tooltipBounds: {
        x: point.x,
        y: point.y,
        width: 0,
        height: 0
      },
      x: bandX,
      y: plotArea.y,
      width: bandWidth,
      height: plotArea.height
    };
  };

  const hitTest = memoizeRectHitTest(resolveHit);
  const lineFocusHitTest = options.lineFocus && pointsBySeries
    ? (x: number, y: number) => {
        if (
          x < plotArea.x ||
          x > plotArea.x + plotArea.width ||
          y < plotArea.y ||
          y > plotArea.y + plotArea.height
        ) {
          return undefined;
        }

        const hit = findClosestLineFocusHit(
          pointsBySeries,
          x,
          y,
          plotArea,
          options,
          hoverIndex?.seriesXMonotonic
        );
        return hit ? { seriesIndex: hit.seriesIndex } : undefined;
      }
    : undefined;

  return [{
    kind: "rect",
    x: plotArea.x,
    y: plotArea.y,
    width: plotArea.width,
    height: plotArea.height,
    pixelSnap: false,
    hover: {
      markType: "line",
      index: -1
    },
    hidden: true,
    ...(lineFocusHitTest ? { lineFocusHitTest } : {}),
    hitTest
  }];
}

function findClosestPinnedLinePoint<TDatum>(
  points: readonly LinePoint<TDatum>[],
  x: number,
  xMonotonic: boolean
): LinePoint<TDatum> | undefined {
  if (points.length === 0) {
    return undefined;
  }

  if (!xMonotonic) {
    let closest = points[0] as LinePoint<TDatum>;
    let closestDistance = Math.abs(closest.x - x);
    for (let index = 1; index < points.length; index += 1) {
      const point = points[index] as LinePoint<TDatum>;
      const distance = Math.abs(point.x - x);
      if (distance < closestDistance) {
        closest = point;
        closestDistance = distance;
      }
    }
    return closest;
  }

  let low = 0;
  let high = points.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    const point = points[mid];
    if (point && point.x < x) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  const right = points[low] as LinePoint<TDatum> | undefined;
  const left = points[low - 1] as LinePoint<TDatum> | undefined;
  if (!right) {
    return left;
  }
  if (!left) {
    return right;
  }
  return Math.abs(left.x - x) <= Math.abs(right.x - x) ? left : right;
}

function memoizeRectHitTest(
  resolve: NonNullable<Extract<Primitive, { kind: "rect" }>['hitTest']>
): NonNullable<Extract<Primitive, { kind: "rect" }>['hitTest']> {
  let lastX = Number.NaN;
  let lastY = Number.NaN;
  let lastHit: ReturnType<typeof resolve>;

  return (x, y) => {
    if (x === lastX && y === lastY) {
      return lastHit;
    }

    lastX = x;
    lastY = y;
    lastHit = resolve(x, y);
    return lastHit;
  };
}

function resolveLineFocusHit<TDatum>(
  lineHit: { point: LinePoint<TDatum>; seriesIndex: number },
  options: LineMarkOptions<TDatum>,
  palette: readonly string[],
  foreground: string,
  plotArea: { y: number; height: number }
): NonNullable<ReturnType<NonNullable<Extract<Primitive, { kind: "rect" }>["hitTest"]>>> {
  const point = lineHit.point;
  const hitBounds = lineFocusHitRect(point, options);
  const tooltip = resolveTooltip(options, point, [point], palette, foreground, plotArea);

  return {
    index: point.index,
    seriesIndex: lineHit.seriesIndex,
    hoverX: point.x,
    hoverY: point.y,
    hoverXValue: point.xValue,
    hoverYValue: point.yValue,
    tooltip,
    tooltipBounds: {
      x: point.x,
      y: point.y,
      width: 0,
      height: 0
    },
    x: hitBounds.x,
    y: hitBounds.y,
    width: hitBounds.width,
    height: hitBounds.height
  };
}

function resolveHoveredLinePoints<TDatum>(
  pointData: readonly LinePoint<TDatum>[],
  hoverablePointsByIndex: ReadonlyMap<number, readonly LinePoint<TDatum>[]>,
  hover: { index: number; seriesIndex?: number; x?: number; y?: number; xValue?: number; yValue?: number },
  options: LineMarkOptions<TDatum>,
  pointsBySeries?: ReadonlyMap<number, readonly LinePoint<TDatum>[]>
): readonly LinePoint<TDatum>[] {
  if (options.lineFocus && hover.seriesIndex !== undefined) {
    const source = pointData.find((point) => point.seriesIndex === hover.seriesIndex && point.index === hover.index);

    return source ? [source] : [];
  }

  if (options.lineFocus) {
    return [];
  }

  const indexed = hoverablePointsByIndex.get(hover.index);
  if (indexed) {
    const anchor = indexed[0];
    if (anchor && options.series && pointsBySeries && pointsBySeries.size > 1) {
      return resolveAssociatedSeriesPoints(
        anchor,
        hoverablePointsByIndex,
        isAggregatedLinePoint(anchor) ? pointsBySeries : undefined,
        hover.y
      );
    }

    return dedupeBySeriesIndex(indexed, hover.y);
  }

  return resolveNearestHoveredLinePoints(pointData, hover, options, pointsBySeries);
}

function resolveNearestHoveredLinePoints<TDatum>(
  pointData: readonly LinePoint<TDatum>[],
  hover: { index?: number; seriesIndex?: number; x?: number; y?: number; xValue?: number; yValue?: number },
  options: LineMarkOptions<TDatum>,
  pointsBySeries?: ReadonlyMap<number, readonly LinePoint<TDatum>[]>
): readonly LinePoint<TDatum>[] {
  if (pointData.length === 0) {
    return [];
  }

  const candidates = hover.seriesIndex !== undefined
    ? pointData.filter((point) => point.seriesIndex === hover.seriesIndex)
    : pointData;

  if (candidates.length === 0) {
    return [];
  }

  const best = candidates.reduce((currentBest, point) => {
    const bestDistance = lineHoverFallbackDistance(currentBest, hover);
    const pointDistance = lineHoverFallbackDistance(point, hover);

    return pointDistance < bestDistance ? point : currentBest;
  }, candidates[0] as LinePoint<TDatum>);

  if (options.series && hover.seriesIndex === undefined && pointsBySeries && pointsBySeries.size > 1) {
    return resolveAssociatedSeriesPoints(
      best,
      new Map([[best.index, pointData.filter((point) => point.index === best.index)]]),
      isAggregatedLinePoint(best) ? pointsBySeries : undefined,
      hover.y
    );
  }

  if (options.series && hover.seriesIndex === undefined) {
    return pointData.filter((point) => point.index === best.index);
  }

  return [best];
}

function lineHoverFallbackDistance<TDatum>(
  point: LinePoint<TDatum>,
  hover: { x?: number; y?: number; xValue?: number; yValue?: number }
): number {
  if (hover.xValue !== undefined) {
    return Math.abs(point.xValue - hover.xValue);
  }

  if (hover.x !== undefined) {
    return Math.abs(point.x - hover.x);
  }

  if (hover.yValue !== undefined) {
    return Math.abs(point.yValue - hover.yValue);
  }

  if (hover.y !== undefined) {
    return Math.abs(point.y - hover.y);
  }

  return 0;
}

function findNearestPointByXValue<TDatum>(
  points: readonly LinePoint<TDatum>[],
  targetXValue: number
): LinePoint<TDatum> | undefined {
  if (points.length === 0) {
    return undefined;
  }

  if (points.length === 1) {
    return points[0];
  }

  let low = 0;
  let high = points.length - 1;

  while (low < high) {
    const mid = (low + high) >> 1;
    const midPoint = points[mid];

    if (midPoint && midPoint.xValue < targetXValue) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  const right = points[low];
  const left = points[low - 1];

  if (!right) {
    return left;
  }

  if (!left) {
    return right;
  }

  return Math.abs(left.xValue - targetXValue) <= Math.abs(right.xValue - targetXValue) ? left : right;
}

function resolveAssociatedSeriesPoints<TDatum>(
  anchor: LinePoint<TDatum>,
  pointsByHoverIndex: ReadonlyMap<number, readonly LinePoint<TDatum>[]>,
  pointsBySeries?: ReadonlyMap<number, readonly LinePoint<TDatum>[]>,
  preferY?: number
): LinePoint<TDatum>[] {
  const indexed = pointsByHoverIndex.get(anchor.index);
  if (!pointsBySeries || pointsBySeries.size <= 1 || (indexed && indexed.length >= pointsBySeries.size)) {
    return dedupeBySeriesIndex(indexed ?? [anchor], preferY);
  }

  const associated: LinePoint<TDatum>[] = [];

  for (const seriesPoints of pointsBySeries.values()) {
    const nearest = findNearestPointByXValue(seriesPoints, anchor.xValue);

    if (nearest) {
      associated.push(nearest);
    }
  }

  return dedupeBySeriesIndex(associated.length > 0 ? associated : indexed ?? [anchor], preferY);
}

function isAggregatedLinePoint<TDatum>(point: LinePoint<TDatum>): boolean {
  const count = (point.datum as { count?: unknown }).count;

  return typeof count === "number" && count > 1;
}

function dedupeBySeriesIndex<TDatum>(
  points: readonly LinePoint<TDatum>[],
  preferY?: number
): LinePoint<TDatum>[] {
  const bySeries = new Map<number, LinePoint<TDatum>>();

  for (const point of points) {
    const existing = bySeries.get(point.seriesIndex);

    if (
      !existing ||
      (preferY !== undefined && Math.abs(point.y - preferY) < Math.abs(existing.y - preferY))
    ) {
      bySeries.set(point.seriesIndex, point);
    }
  }

  return [...bySeries.values()];
}

function lineFocusHitRect<TDatum>(point: LinePoint<TDatum>, options: LineMarkOptions<TDatum>): { x: number; y: number; width: number; height: number } {
  const radius = Math.max(1, (options.strokeWidth ?? DEFAULT_LINE_STROKE_WIDTH) / 2);

  return {
    x: point.x - radius,
    y: point.y - radius,
    width: radius * 2,
    height: radius * 2
  };
}

function findClosestLineFocusHit<TDatum>(
  pointsBySeries: ReadonlyMap<number, readonly LinePoint<TDatum>[]>,
  x: number,
  y: number,
  plotArea: { x: number; y: number; width: number; height: number },
  options: LineMarkOptions<TDatum>,
  seriesXMonotonic?: ReadonlyMap<number, boolean>
): { point: LinePoint<TDatum>; seriesIndex: number } | undefined {
  const tolerance = Math.max(12, (options.strokeWidth ?? DEFAULT_LINE_STROKE_WIDTH) + 2);
  const toleranceSquared = tolerance * tolerance;
  let best: { point: LinePoint<TDatum>; seriesIndex: number; distanceSquared: number; priority: number } | undefined;

  for (const [seriesIndex, seriesPoints] of pointsBySeries) {
    if (seriesPoints.length === 1) {
      const point = seriesPoints[0] as LinePoint<TDatum>;
      const distanceSquared = squaredDistance(x, y, point.x, point.y);
      if (distanceSquared <= toleranceSquared && isBetterLineHit(0, distanceSquared, best)) {
        best = { point, seriesIndex, distanceSquared, priority: 0 };
      }
      continue;
    }

    const candidateRange = lineFocusCandidateSegmentRange(seriesPoints, x, seriesXMonotonic?.get(seriesIndex) === true);
    for (let index = candidateRange.start; index <= candidateRange.end; index += 1) {
      const previous = seriesPoints[index - 1] as LinePoint<TDatum>;
      const current = seriesPoints[index] as LinePoint<TDatum>;
      const segments = lineHoverSegments(seriesPoints, index, options.curve ?? "linear");

      for (const segment of segments) {
        const visibleSegment = clipLineSegmentToRect(segment.from.x, segment.from.y, segment.to.x, segment.to.y, plotArea);
        if (!visibleSegment) {
          continue;
        }

        const projection = projectPointToSegment(x, y, visibleSegment.x1, visibleSegment.y1, visibleSegment.x2, visibleSegment.y2);
        const priority = segmentHoverPriority(segment);
        if (projection.distanceSquared <= toleranceSquared && isBetterLineHit(priority, projection.distanceSquared, best)) {
          best = {
            point: linePointAtHover(previous, current, segment.owner, projection.x, projection.y),
            seriesIndex,
            distanceSquared: projection.distanceSquared,
            priority
          };
        }
      }
    }
  }

  return best ? { point: best.point, seriesIndex: best.seriesIndex } : undefined;
}

function lineFocusCandidateSegmentRange<TDatum>(
  points: readonly LinePoint<TDatum>[],
  x: number,
  xMonotonic: boolean
): { start: number; end: number } {
  if (!xMonotonic) {
    return { start: 1, end: points.length - 1 };
  }

  let low = 0;
  let high = points.length - 1;

  while (low < high) {
    const mid = (low + high) >> 1;
    const point = points[mid];
    if (point && point.x < x) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  const start = Math.max(1, low - 3);
  const end = Math.min(points.length - 1, low + 3);

  return { start, end };
}

function isBetterLineHit(
  priority: number,
  distanceSquared: number,
  best: { distanceSquared: number; priority: number } | undefined
): boolean {
  if (!best) {
    return true;
  }

  if (priority !== best.priority) {
    return priority < best.priority;
  }

  return distanceSquared < best.distanceSquared;
}

function segmentHoverPriority(segment: { from: { x: number; y: number }; to: { x: number; y: number }; owner: "previous" | "current" | "nearest" }): number {
  const dx = Math.abs(segment.to.x - segment.from.x);
  const dy = Math.abs(segment.to.y - segment.from.y);

  return dx < 0.5 && dy > 0.5 ? 1 : 0;
}

function clipLineSegmentToRect(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  rect: { x: number; y: number; width: number; height: number }
): { x1: number; y1: number; x2: number; y2: number } | undefined {
  const dx = x2 - x1;
  const dy = y2 - y1;
  let t0 = 0;
  let t1 = 1;
  const left = rect.x;
  const right = rect.x + rect.width;
  const top = rect.y;
  const bottom = rect.y + rect.height;

  const clip = (p: number, q: number): boolean => {
    if (p === 0) {
      return q >= 0;
    }

    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }

    return true;
  };

  if (
    !clip(-dx, x1 - left) ||
    !clip(dx, right - x1) ||
    !clip(-dy, y1 - top) ||
    !clip(dy, bottom - y1)
  ) {
    return undefined;
  }

  return {
    x1: x1 + t0 * dx,
    y1: y1 + t0 * dy,
    x2: x1 + t1 * dx,
    y2: y1 + t1 * dy
  };
}

function lineHoverSegments<TDatum>(
  points: readonly LinePoint<TDatum>[],
  currentIndex: number,
  curve: LineCurve
): readonly { from: { x: number; y: number }; to: { x: number; y: number }; owner: "previous" | "current" | "nearest" }[] {
  const previous = points[currentIndex - 1] as LinePoint<TDatum>;
  const current = points[currentIndex] as LinePoint<TDatum>;

  if (curve === "step-before") {
    const corner = { x: previous.x, y: current.y };
    return [
      { from: previous, to: corner, owner: "nearest" },
      { from: corner, to: current, owner: "current" }
    ];
  }

  if (curve === "step" || curve === "step-after") {
    const cornerX = curve === "step" ? (previous.x + current.x) / 2 : current.x;
    const corner = { x: cornerX, y: previous.y };
    return [
      { from: previous, to: corner, owner: "previous" },
      { from: corner, to: current, owner: "nearest" }
    ];
  }

  if (curve === "monotone-x" && points.length >= 3) {
    const tangents = monotoneLineTangents(points);
    const dx = current.x - previous.x;
    if (dx !== 0) {
      return sampleCubicLineSegments(
        previous,
        {
          x: previous.x + dx / 3,
          y: previous.y + (tangents[currentIndex - 1] ?? 0) * dx / 3
        },
        {
          x: current.x - dx / 3,
          y: current.y - (tangents[currentIndex] ?? 0) * dx / 3
        },
        current
      );
    }
  }

  if ((curve === "catmull-rom" || curve === "basis") && points.length >= 3) {
    if (curve === "basis") {
      return sampleBasisLineSegments(points, currentIndex);
    }

    const p0 = points[Math.max(0, currentIndex - 2)] as LinePoint<TDatum>;
    const p1 = previous;
    const p2 = current;
    const p3 = points[Math.min(points.length - 1, currentIndex + 1)] as LinePoint<TDatum>;
    const scale = 1 / 6;
    return sampleCubicLineSegments(
      p1,
      {
        x: p1.x + (p2.x - p0.x) * scale,
        y: p1.y + (p2.y - p0.y) * scale
      },
      {
        x: p2.x - (p3.x - p1.x) * scale,
        y: p2.y - (p3.y - p1.y) * scale
      },
      p2
    );
  }

  return [{ from: previous, to: current, owner: "nearest" }];
}

function sampleCubicLineSegments<TDatum>(
  start: LinePoint<TDatum>,
  cp1: { x: number; y: number },
  cp2: { x: number; y: number },
  end: LinePoint<TDatum>
): readonly { from: { x: number; y: number }; to: { x: number; y: number }; owner: "nearest" }[] {
  const segments: { from: { x: number; y: number }; to: { x: number; y: number }; owner: "nearest" }[] = [];
  let from: { x: number; y: number } = start;
  const steps = 10;

  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps;
    const to = cubicPoint(start, cp1, cp2, end, t);
    segments.push({ from, to, owner: "nearest" });
    from = to;
  }

  return segments;
}

function sampleBasisLineSegments<TDatum>(
  points: readonly LinePoint<TDatum>[],
  currentIndex: number
): readonly { from: { x: number; y: number }; to: { x: number; y: number }; owner: "nearest" }[] {
  const previous = points[currentIndex - 1] as LinePoint<TDatum>;
  const current = points[currentIndex] as LinePoint<TDatum>;

  if (currentIndex === points.length - 1) {
    return [{ from: previous, to: current, owner: "nearest" }];
  }

  const next = points[currentIndex + 1] as LinePoint<TDatum>;
  const end = {
    x: (current.x + next.x) / 2,
    y: (current.y + next.y) / 2
  };
  const segments: { from: { x: number; y: number }; to: { x: number; y: number }; owner: "nearest" }[] = [];
  const start: { x: number; y: number } = currentIndex === 1
    ? previous
    : {
        x: (previous.x + current.x) / 2,
        y: (previous.y + current.y) / 2
      };
  let from = start;
  const steps = 8;

  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps;
    const inv = 1 - t;
    const to = {
      x: inv * inv * start.x + 2 * inv * t * current.x + t * t * end.x,
      y: inv * inv * start.y + 2 * inv * t * current.y + t * t * end.y
    };
    segments.push({ from, to, owner: "nearest" });
    from = to;
  }

  return segments;
}

function cubicPoint(
  start: { x: number; y: number },
  cp1: { x: number; y: number },
  cp2: { x: number; y: number },
  end: { x: number; y: number },
  t: number
): { x: number; y: number } {
  const mt = 1 - t;
  const mt2 = mt * mt;
  const mt3 = mt2 * mt;
  const t2 = t * t;
  const t3 = t2 * t;

  return {
    x: mt3 * start.x + 3 * mt2 * t * cp1.x + 3 * mt * t2 * cp2.x + t3 * end.x,
    y: mt3 * start.y + 3 * mt2 * t * cp1.y + 3 * mt * t2 * cp2.y + t3 * end.y
  };
}

function monotoneLineTangents<TDatum>(points: readonly LinePoint<TDatum>[]): number[] {
  const slopes: number[] = [];
  const tangents: number[] = [];

  for (let index = 0; index < points.length - 1; index += 1) {
    const p0 = points[index] as LinePoint<TDatum>;
    const p1 = points[index + 1] as LinePoint<TDatum>;
    const dx = p1.x - p0.x;
    slopes[index] = dx === 0 ? 0 : (p1.y - p0.y) / dx;
  }

  tangents[0] = slopes[0] ?? 0;
  tangents[points.length - 1] = slopes[slopes.length - 1] ?? 0;

  for (let index = 1; index < points.length - 1; index += 1) {
    const prev = slopes[index - 1] ?? 0;
    const next = slopes[index] ?? 0;
    tangents[index] = prev * next <= 0 ? 0 : (prev + next) / 2;
  }

  const alpha: number[] = [];
  for (let index = 0; index < slopes.length; index += 1) {
    const slope = slopes[index] ?? 0;

    if (slope === 0) {
      alpha[index] = 1;
      continue;
    }

    const a = (tangents[index] ?? 0) / slope;
    const b = (tangents[index + 1] ?? 0) / slope;
    const sum = a * a + b * b;
    alpha[index] = sum > 9 ? 3 / Math.sqrt(sum) : 1;
  }

  for (let index = 0; index < tangents.length; index += 1) {
    const scale = Math.min(
      index > 0 ? alpha[index - 1] ?? 1 : 1,
      index < alpha.length ? alpha[index] ?? 1 : 1
    );
    tangents[index] = (tangents[index] ?? 0) * scale;
  }

  return tangents;
}

function linePointAtHover<TDatum>(
  previous: LinePoint<TDatum>,
  current: LinePoint<TDatum>,
  owner: "previous" | "current" | "nearest",
  x: number,
  y: number
): LinePoint<TDatum> {
  const span = current.x - previous.x;
  const t = span === 0 ? 0 : Math.max(0, Math.min(1, (x - previous.x) / span));
  const xValue = previous.xValue + (current.xValue - previous.xValue) * t;

  if (owner === "previous") return { ...previous, x, y: previous.y, xValue };
  if (owner === "current") return { ...current, x, y: current.y, xValue };

  return {
    ...previous,
    x,
    y,
    xValue,
    yValue: previous.yValue + (current.yValue - previous.yValue) * t
  };
}

function projectPointToSegment(
  x: number,
  y: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): { x: number; y: number; distanceSquared: number } {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared === 0) {
    return { x: x1, y: y1, distanceSquared: squaredDistance(x, y, x1, y1) };
  }

  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lengthSquared));
  const projectedX = x1 + t * dx;
  const projectedY = y1 + t * dy;

  return {
    x: projectedX,
    y: projectedY,
    distanceSquared: squaredDistance(x, y, projectedX, projectedY)
  };
}

function squaredDistance(x1: number, y1: number, x2: number, y2: number): number {
  const dx = x1 - x2;
  const dy = y1 - y2;

  return dx * dx + dy * dy;
}

function groupPointsByHoverIndex<TDatum>(points: readonly LinePoint<TDatum>[]): ReadonlyMap<number, readonly LinePoint<TDatum>[]> {
  const grouped = new Map<number, LinePoint<TDatum>[]>();

  for (const point of points) {
    const existing = grouped.get(point.index);

    if (existing) {
      existing.push(point);
    } else {
      grouped.set(point.index, [point]);
    }
  }

  return grouped;
}

function groupPointsBySeries<TDatum>(points: readonly LinePoint<TDatum>[]): ReadonlyMap<number, readonly LinePoint<TDatum>[]> {
  const grouped = new Map<number, LinePoint<TDatum>[]>();

  for (const point of points) {
    const existing = grouped.get(point.seriesIndex);

    if (existing) {
      existing.push(point);
    } else {
      grouped.set(point.seriesIndex, [point]);
    }
  }

  for (const seriesPoints of grouped.values()) {
    seriesPoints.sort((left, right) => left.xValue - right.xValue);
  }

  return grouped;
}

function resolveSeriesXMonotonic<TDatum>(
  pointsBySeries: ReadonlyMap<number, readonly LinePoint<TDatum>[]>
): ReadonlyMap<number, boolean> {
  const result = new Map<number, boolean>();

  for (const [seriesIndex, points] of pointsBySeries) {
    let monotonic = true;
    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1] as LinePoint<TDatum>;
      const current = points[index] as LinePoint<TDatum>;
      if (current.x < previous.x) {
        monotonic = false;
        break;
      }
    }
    result.set(seriesIndex, monotonic);
  }

  return result;
}

function resolveAreaBaselineY(
  plotArea: { x: number; y: number; width: number; height: number },
  yDomain: readonly [number, number],
  mode: "plot" | "zero"
): number {
  if (mode === "plot") {
    return plotArea.y + plotArea.height;
  }

  const ySpan = yDomain[1] - yDomain[0] || 1;
  const zeroY = plotArea.y + plotArea.height - ((0 - yDomain[0]) / ySpan) * plotArea.height;
  return Math.max(plotArea.y, Math.min(plotArea.y + plotArea.height, zeroY));
}

function resolveAreaFillColor<TDatum>(
  options: LineMarkOptions<TDatum>,
  stroke: string,
  seriesIndex: number
): string {
  const seriesFill = options.areaFills?.[seriesIndex];
  if (seriesFill) {
    return seriesFill;
  }
  if (options.areaFill) {
    return options.areaFill;
  }
  return stroke;
}

function resolveAreaFillPrimitive(
  points: readonly [number, number][],
  baseFill: string,
  opacity: number,
  overlap: "blend" | "cover" | "multiply" | "screen",
  baselineY: number,
  clip: { x: number; y: number; width: number; height: number },
  curve: LineCurve
): Extract<Primitive, { kind: "path" }> {
  const clampedOpacity = Math.max(0, Math.min(1, opacity));

  if (overlap === "cover") {
    return {
      kind: "path",
      points,
      fill: withAlpha(baseFill, 1),
      fillOpacity: clampedOpacity,
      clip,
      curve,
      closed: true,
      areaBaseline: baselineY,
      areaLayer: "isolate"
    };
  }

  if (overlap === "multiply" || overlap === "screen") {
    return {
      kind: "path",
      points,
      fill: withAlpha(baseFill, 1),
      fillOpacity: clampedOpacity,
      compositeOperation: overlap,
      clip,
      curve,
      closed: true,
      areaBaseline: baselineY
    };
  }

  return {
    kind: "path",
    points,
    fill: withAlpha(baseFill, clampedOpacity),
    clip,
    curve,
    closed: true,
    areaBaseline: baselineY
  };
}

function withAlpha(color: string, alpha: number): string {
  const normalizedAlpha = Math.max(0, Math.min(1, alpha));

  if (color.startsWith("#") && (color.length === 7 || color.length === 4)) {
    const hex = color.length === 4
      ? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`
      : color;
    const red = Number.parseInt(hex.slice(1, 3), 16);
    const green = Number.parseInt(hex.slice(3, 5), 16);
    const blue = Number.parseInt(hex.slice(5, 7), 16);

    return `rgba(${red}, ${green}, ${blue}, ${normalizedAlpha})`;
  }

  const hsla = /^hsla?\((.+)\)$/i.exec(color.trim());
  if (hsla) {
    if (hsla[1]!.includes("/")) {
      const base = hsla[1]!.split("/")[0]!.trim();
      return `hsla(${base} / ${normalizedAlpha})`;
    }
    const parts = hsla[1]!.split(",").map((part) => part.trim());
    return `hsla(${parts[0]}, ${parts[1]}, ${parts[2]}, ${normalizedAlpha})`;
  }

  const rgba = /^rgba?\((.+)\)$/i.exec(color.trim());
  if (rgba) {
    if (rgba[1]!.includes("/")) {
      const base = rgba[1]!.split("/")[0]!.trim();
      return `rgba(${base} / ${normalizedAlpha})`;
    }
    const parts = rgba[1]!.split(",").map((part) => part.trim());
    return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${normalizedAlpha})`;
  }

  const oklch = /^oklch\((.+)\)$/i.exec(color.trim());
  if (oklch) {
    const channels = oklch[1]!.split("/")[0]!.trim();
    return `oklch(${channels} / ${normalizedAlpha})`;
  }

  return color;
}

function resolveAnimatedLineColor(
  color: string,
  animation: { progress: number; profile: AnimationProfile } | undefined
): string {
  if (!animation || animation.profile !== "rise" || animation.progress >= 1) {
    return color;
  }

  return withAlpha(color, animation.progress);
}

function shouldIncludeLinePoint(
  animation: { progress: number; profile: AnimationProfile } | undefined,
  xValue: number,
  xDomain: readonly [number, number]
): boolean {
  if (!animation || animation.progress >= 1 || animation.profile !== "waterfall-left") {
    return true;
  }

  const span = xDomain[1] - xDomain[0] || 1;
  const position = Math.max(0, Math.min(1, (xValue - xDomain[0]) / span));
  const staggerWindow = 0.65;
  const localSpan = 1 - staggerWindow;
  const delay = position * staggerWindow;

  return Math.max(0, Math.min(1, (animation.progress - delay) / localSpan)) > 0;
}

function includeLineContinuityPoints<TDatum>(
  points: readonly LinePoint<TDatum>[],
  xDomain: readonly [number, number]
): readonly LinePoint<TDatum>[] {
  const [minX, maxX] = xDomain;
  const before: LinePoint<TDatum>[] = [];
  const after: LinePoint<TDatum>[] = [];
  const visible: LinePoint<TDatum>[] = [];

  for (const point of points) {
    if (point.xValue < minX) {
      before.push(point);
      if (before.length > 2) {
        before.shift();
      }
    } else if (point.xValue > maxX) {
      if (after.length < 2) {
        after.push(point);
      } else {
        break;
      }
    } else {
      visible.push(point);
    }
  }

  if (before.length === 0 && after.length === 0) {
    return visible.length === points.length ? points : visible;
  }

  return [
    ...before,
    ...visible,
    ...after
  ];
}

function resolveLineClip(
  plotArea: { x: number; y: number; width: number; height: number },
  clipArea: { x: number; y: number; width: number; height: number } | undefined,
  animation: { progress: number; profile: AnimationProfile } | undefined
): { x: number; y: number; width: number; height: number } {
  const baseClip = clipArea ?? plotArea;

  if (animation?.profile !== "draw-left" && animation?.profile !== "draw-right") {
    return baseClip;
  }

  const progress = Math.max(0, Math.min(1, animation.progress));
  if (animation.profile === "draw-left") {
    const revealRight = plotArea.x + plotArea.width * progress;
    const right = Math.min(baseClip.x + baseClip.width, revealRight);
    return {
      ...baseClip,
      width: Math.max(0, right - baseClip.x)
    };
  } else {
    const revealLeft = plotArea.x + plotArea.width * (1 - progress);
    const left = Math.max(baseClip.x, revealLeft);
    return {
      ...baseClip,
      x: left,
      width: Math.max(0, baseClip.x + baseClip.width - left)
    };
  }
}

function resolveEdgeBandWidth(
  point: { x: number },
  neighbor: { x: number } | undefined
): number {
  return neighbor ? Math.abs(point.x - neighbor.x) / 2 : 12;
}

type LinePoint<TDatum> = {
  datum: TDatum;
  dataIndex: number;
  index: number;
  x: number;
  y: number;
  xValue: number;
  yValue: number;
  seriesIndex: number;
  seriesLabel?: string;
};



function resolveTooltip<TDatum>(
  options: LineMarkOptions<TDatum>,
  point: LinePoint<TDatum>,
  allPoints: readonly LinePoint<TDatum>[],
  palette: readonly string[],
  foreground: string,
  plotArea?: { y: number; height: number }
): TooltipContent | undefined {
  if (options.tooltip === false) {
    return undefined;
  }

  if (options.tooltipVisibleOnly && plotArea) {
    allPoints = allPoints.filter((candidate) => candidate.y >= plotArea.y && candidate.y <= plotArea.y + plotArea.height);
    if (allPoints.length === 0) {
      return undefined;
    }
  }

  if (options.lineFocus && options.series && allPoints.length === 1) {
    const focusedPoint = allPoints[0] as LinePoint<TDatum>;
    const baseContent = typeof options.tooltip === "function"
      ? normalizeTooltipResult(options.tooltip(focusedPoint.datum, focusedPoint.dataIndex))
      : undefined;
    const baseLine = baseContent?.lines[0];

    return {
      ...(baseContent?.title !== undefined ? { title: baseContent.title } : {}),
      lines: [formatFocusedLineTooltipLine(focusedPoint, baseLine)],
      markers: [baseContent?.markers?.[0] ?? resolveLineStroke(options, palette, foreground, focusedPoint.seriesIndex)]
    };
  }

  if (typeof options.tooltip === "function") {
    const tooltip = options.tooltip;

    if (options.series) {
      const results = sortTooltipPointsByPlotOrder(allPoints).map((candidate) => ({
        point: candidate,
        content: normalizeTooltipResult(tooltip(candidate.datum, candidate.dataIndex))
      }));
      const lines = results.map((result) => resolveSeriesTooltipLine(result.point, result.content));
      const title = results.find((result) => result.content.title)?.content.title;
      const markers = results.map((result) => {
        const color = resolveLineStroke(options, palette, foreground, result.point.seriesIndex);

        return result.content.markers?.[0] ?? color;
      });

      return {
        title: title ?? formatValue(point.xValue),
        lines,
        markers
      };
    }

    return normalizeTooltipResult(tooltip(point.datum, point.dataIndex));
  }

  if (options.series) {
    const orderedPoints = sortTooltipPointsByPlotOrder(allPoints);
    const lines = orderedPoints
      .map((candidate) => `${candidate.seriesLabel ?? "Series"}\t${formatValue(candidate.yValue)}`);

    return {
      title: formatValue(point.xValue),
      lines,
      markers: orderedPoints.map((candidate) => resolveLineStroke(options, palette, foreground, candidate.seriesIndex))
    };
  }

  return {
    lines: [formatValue(point.xValue), `Y\t${formatValue(point.yValue)}`]
  };
}

function normalizeTooltipResult(result: TooltipResult): TooltipContent {
  return Array.isArray(result) ? { lines: result as readonly string[] } : result as TooltipContent;
}

function sortTooltipPointsByPlotOrder<TDatum>(points: readonly LinePoint<TDatum>[]): readonly LinePoint<TDatum>[] {
  return [...points].sort((left, right) => left.y - right.y || left.seriesIndex - right.seriesIndex);
}

function resolveSeriesTooltipLine<TDatum>(point: LinePoint<TDatum>, content: TooltipContent): string {
  if (content.lines.length > 1) {
    const firstLine = content.lines[0] ?? "";
    if (firstLine.startsWith("Group\t") || firstLine.startsWith("Time\t") || firstLine.startsWith("X\t")) {
      return content.lines[1] ?? `${point.seriesLabel ?? "Series"}\t${formatValue(point.yValue)}`;
    }
  }
  return content.lines[0] ?? `${point.seriesLabel ?? "Series"}\t${formatValue(point.yValue)}`;
}

function formatFocusedLineTooltipLine<TDatum>(point: LinePoint<TDatum>, baseLine: string | undefined): string {
  const label = point.seriesLabel ?? "Series";
  const value = formatValue(point.yValue);
  if (!baseLine) {
    return `${label}\t${value}`;
  }

  const tabIndex = baseLine.indexOf("\t");
  const baseValue = tabIndex >= 0 ? baseLine.slice(tabIndex + 1) : baseLine;
  const suffixMatch = /\s+(\([^)]*\))\s*$/.exec(baseValue);

  return `${label}\t${value}${suffixMatch ? ` ${suffixMatch[1]}` : ""}`;
}

function collapseHoverPointsByX<TDatum>(points: readonly LinePoint<TDatum>[]): readonly LinePoint<TDatum>[] {
  const byIndex = new Map<number, LinePoint<TDatum>>();

  for (const point of [...points].sort((left, right) => left.xValue - right.xValue)) {
    if (!byIndex.has(point.index)) {
      byIndex.set(point.index, point);
    }
  }

  return [...byIndex.values()];
}

function collectLineSeries<TDatum>(
  data: readonly TDatum[],
  options: LineMarkOptions<TDatum>
): {
  series: {
    index: number;
    key: string | number;
    label?: string;
    data: number[];
  }[];
  xValues: readonly number[];
  xIndexByValue: ReadonlyMap<number, number>;
} {
  const seriesAccessor = options.series;

  if (!seriesAccessor) {
    return {
      series: [{
        index: 0,
        key: "__default",
        data: Array.from({ length: data.length }, (_, index) => index)
      }],
      xValues: [],
      xIndexByValue: new Map()
    };
  }

  const seriesKeys: (string | number)[] = [];
  const seenSeries = new Set<string | number>();
  const seriesByKey = new Map<string | number, number[]>();
  const seenXValues = new Set<number>();
  const xValues: number[] = [];
  let xValuesSorted = true;
  let lastXValue = Number.NEGATIVE_INFINITY;

  for (const key of options.seriesOrder ?? []) {
    if (!seenSeries.has(key)) {
      seenSeries.add(key);
      seriesKeys.push(key);
      seriesByKey.set(key, []);
    }
  }

  data.forEach((datum, index) => {
    const key = readAccessor(seriesAccessor, datum, index);

    if (!seenSeries.has(key)) {
      seenSeries.add(key);
      seriesKeys.push(key);
      seriesByKey.set(key, []);
    }

    seriesByKey.get(key)?.push(index);
    const xValue = readAccessor(options.x, datum, index);
    if (!seenXValues.has(xValue)) {
      seenXValues.add(xValue);
      xValues.push(xValue);
      if (xValue < lastXValue) {
        xValuesSorted = false;
      }
      lastXValue = xValue;
    }
  });

  if (!xValuesSorted) {
    xValues.sort((left, right) => left - right);
  }

  return {
    series: seriesKeys
      .map((key, index) => ({
        index,
        key,
        data: seriesByKey.get(key) ?? [],
        ...(seriesAccessor ? { label: String(key) } : {})
      }))
      .filter((series) => series.data.length > 0),
    xValues,
    xIndexByValue: new Map(xValues.map((value, index) => [value, index]))
  };
}

function resolveRenderableSeriesPoints<TDatum>(
  points: readonly LinePoint<TDatum>[],
  animation: { progress: number; profile: AnimationProfile } | undefined,
  xDomain: readonly [number, number]
): LinePoint<TDatum>[] {
  const filtered: LinePoint<TDatum>[] = [];
  let sorted = true;
  let previousX = Number.NEGATIVE_INFINITY;

  for (const point of points) {
    if (!shouldIncludeLinePoint(animation, point.xValue, xDomain)) {
      continue;
    }

    if (point.xValue < previousX) {
      sorted = false;
    }
    previousX = point.xValue;
    filtered.push(point);
  }

  if (!sorted) {
    filtered.sort((left, right) => left.xValue - right.xValue);
  }

  return filtered;
}

function resolveLineStroke<TDatum>(
  options: LineMarkOptions<TDatum>,
  palette: readonly string[],
  fallback: string,
  seriesIndex: number
): string {
  if (options.strokes?.[seriesIndex]) {
    return options.strokes[seriesIndex] as string;
  }

  if (options.stroke !== undefined && !options.series) {
    return options.stroke;
  }

  return palette[seriesIndex % Math.max(1, palette.length)] ?? options.stroke ?? fallback;
}

function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function resolveDatumIndex(datum: unknown, fallback: number): number {
  return typeof datum === "object" &&
    datum !== null &&
    typeof (datum as { index?: unknown }).index === "number"
    ? (datum as { index: number }).index
    : fallback;
}

function extent<TDatum>(data: readonly TDatum[], accessor: Accessor<TDatum, number>): readonly [number, number] {
  let min = readAccessor(accessor, data[0] as TDatum, 0);
  let max = min;

  for (let index = 1; index < data.length; index += 1) {
    const value = readAccessor(accessor, data[index] as TDatum, index);

    if (value < min) min = value;
    if (value > max) max = value;
  }

  return min === max ? [min, min + 1] : [min, max];
}
