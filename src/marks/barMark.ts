import type { AnimationProfile, CornerRadii, GradientFill, HoverState, HoverStyle, Primitive, RectPaint, TooltipContent, TooltipResult } from "../core/types";
import { niceLinearDomain } from "../core/axes";
import type { Accessor, Mark } from "./types";
import { readAccessor } from "./accessor";
import type { Layout } from "../layout/types";
import { darkenColor, lightenColor, resolveBarFill } from "./barStyle";

/** Default inter-bar / group gap ratio. Keep in sync with settings UI. */
export const DEFAULT_BAR_GAP_RATIO = 0.32;

type BarGeometry = {
  sourceCount: number;
  pixelSnap: boolean;
  valueDomain: readonly [number, number];
  bars: readonly {
    x: number;
    width: number;
    slotX: number;
    slotWidth: number;
    visualIndex: number;
    index: number;
    dataIndex: number;
    value: number;
    valueStart: number;
    valueEnd: number;
    groupIndex: number;
    seriesIndex: number;
    stackLabel?: string;
    seriesLabel?: string;
    categoryLabel?: string;
  }[];
};

const DEFAULT_STACK_KEY = "__default_stack__";
const MIN_GROUP_HOVER_WIDTH = 2;
const barHoverGroupsCache = new WeakMap<BarGeometry, Map<number, BarGeometry["bars"][number][]>>();

export type BarLayoutMode = "grouped" | "stacked" | "grouped-stacked";
export type BarFillMode = "solid" | "gradient" | "none";
export type BarOutlineStyle = "none" | "solid" | "dashed";

export type BarAppearance = {
  /** Fraction of bar thickness used as the corner radius, from 0 to 0.5. */
  cornerRadiusRatio?: number;
  /** Also round the baseline-adjacent end. For vertical bars this is the bottom on positive bars. */
  roundBottom?: boolean;
  /** When stacked, extend upper segments over lower rounded tops to avoid corner gaps. */
  layeredStack?: boolean;
  fillMode?: BarFillMode;
  outline?: BarOutlineStyle;
  strokeWidth?: number;
};

export type BarValueLabelOptions<TDatum> = {
  formatter?: (value: number, datum: TDatum, index: number) => string;
  fill?: string;
  font?: string;
  padding?: number;
};

export type BarMarkOptions<TDatum> = {
  x: Accessor<TDatum, string | number>;
  y: Accessor<TDatum, string | number>;
  series?: Accessor<TDatum, string | number>;
  /** ECharts-style alias for stackGroup. When present, bar series stack by default. */
  stack?: Accessor<TDatum, string | number>;
  stackGroup?: Accessor<TDatum, string | number>;
  seriesOrder?: readonly (string | number)[];
  fill?: string;
  fills?: readonly string[] | ((seriesIndex: number, categoryLabel?: string, seriesLabel?: string) => string);
  appearance?: BarAppearance;
  gapRatio?: number;
  interBarGapRatio?: number;
  interGroupGapRatio?: number;
  /** Controls how multiple bar series are laid out. Defaults to grouped unless stack/stackGroup is present. */
  layout?: BarLayoutMode;
  stacked?: boolean;
  stackTotalTooltip?: boolean;
  dynamicGap?: boolean;
  dynamicGapStrength?: number;
  domainMin?: number;
  domainMax?: number;
  minBarWidth?: number;
  minGapWidth?: number;
  tooltip?: boolean | ((datum: TDatum, index: number) => TooltipResult);
  valueLabels?: boolean | BarValueLabelOptions<TDatum>;
  hoverStyle?: HoverStyle;
  orientation?: "vertical" | "horizontal";
};

export function barMark<TDatum>(options: BarMarkOptions<TDatum>): Mark<TDatum> {
  let cachedGeometry: {
    data: readonly TDatum[];
    plotX: number;
    plotWidth: number;
    dataWindow: Layout["dataWindow"] | undefined;
    valueDomain: readonly [number, number] | undefined;
    geometry: BarGeometry;
  } | undefined;

  const getGeometry = (
    plotX: number,
    plotWidth: number,
    data: readonly TDatum[],
    value: Accessor<TDatum, number>,
    dataWindow: Layout["dataWindow"] | undefined,
    valueDomain: readonly [number, number] | undefined
  ): BarGeometry => {
    if (
      cachedGeometry &&
      cachedGeometry.data === data &&
      cachedGeometry.plotX === plotX &&
      cachedGeometry.plotWidth === plotWidth &&
      sameDataWindow(cachedGeometry.dataWindow, dataWindow) &&
      sameDomain(cachedGeometry.valueDomain, valueDomain)
    ) {
      return cachedGeometry.geometry;
    }

    const geometry = resolveBarGeometry(plotX, plotWidth, data, options, value, dataWindow, valueDomain);
    cachedGeometry = { data, plotX, plotWidth, dataWindow, valueDomain, geometry };
    return geometry;
  };

  return {
    kind: "bar",
    encode(data, layout, theme): readonly Primitive[] {
      if (data.length === 0) {
        return [];
      }

      const horizontal = options.orientation === "horizontal";
      const value = valueAccessor(options);
      const layoutValueDomain = horizontal ? layout.xDomain : layout.yDomain;
      const geometry = getGeometry(
        horizontal ? layout.plotArea.y : layout.plotArea.x,
        horizontal ? layout.plotArea.height : layout.plotArea.width,
        data,
        value,
        layout.dataWindow,
        layoutValueDomain
      );

      const primitives: Primitive[] = [];
      const baseline = resolveZeroBaseline(geometry.valueDomain, horizontal, layout.plotArea, theme.palette.grid, layout.clipArea);

      if (layout.hoverOnly) {
        return resolveBarHoverPrimitives(
          geometry,
          horizontal,
          layout.plotArea,
          layout.clipArea,
          options,
          layout.hover,
          theme.palette.series,
          theme.palette.foreground,
          resolveEffectiveBarAppearance(resolveBarAppearance(options), layout, data.length)
        );
      }

      if (baseline) {
        primitives.push(baseline);
      }

      const barFrontBatches = new Map<string, { paint: RectPaint; rects: { x: number; y: number; width: number; height: number }[] }>();
      const barFrontPrimitives: Primitive[] = [];
      const layeredStackLayers = new Map<number, LayeredStackLayer>();
      const barOverlayPrimitives: Primitive[] = [];
      const appearance = resolveEffectiveBarAppearance(resolveBarAppearance(options), layout, data.length);
      const stacked = resolveBarLayout(options) !== "grouped";
      const layeredStack = appearance.layeredStack === true;
      const stackInfoByBar = buildStackSegmentInfo(geometry.bars, stacked, layeredStack);
      const stackAnimation = buildStackAnimationState(geometry.bars, stacked);
      const batchMainRects = canBatchMainBarRects(appearance);
      const hoverStyle = options.hoverStyle ?? "background-and-bar";
      const clip = layout.clipArea ?? layout.plotArea;
      const valueLabels = resolveValueLabelOptions(options);
      const renderedHoverBackgrounds = new Set<number>();

      for (const bar of geometry.bars) {
        const value = bar.value;
        const index = bar.index;
        const fill = resolveBarFill(options, theme.palette.series, theme.palette.foreground, bar.seriesIndex, bar.categoryLabel, bar.seriesLabel);

        const useLayeredStack = stacked && layeredStack;
        const animationProgress = useLayeredStack
          ? resolveAnimationProgress(layout.animation, bar.visualIndex, geometry.sourceCount)
          : stacked
            ? resolveStackSegmentAnimationProgress(layout.animation, bar, stackAnimation)
            : resolveAnimationProgress(layout.animation, bar.visualIndex, geometry.sourceCount);
        const rectValueStart = useLayeredStack ? 0 : bar.valueStart;
        const animatedValueRect = resolveValueRect(
          rectValueStart,
          bar.valueEnd,
          geometry.valueDomain,
          horizontal,
          layout.plotArea,
          animationProgress
        );
        const hoverIndex = options.series ? bar.groupIndex : index;
        const hovered = layout.hover?.markType === "bar" && layout.hover.index === hoverIndex;
        const showBarHighlight = hovered && (!options.series || bar.slotWidth >= MIN_GROUP_HOVER_WIDTH);

        if (hovered && (hoverStyle === "background" || hoverStyle === "background-and-bar") && !renderedHoverBackgrounds.has(hoverIndex)) {
          renderedHoverBackgrounds.add(hoverIndex);
          barOverlayPrimitives.push({
            kind: "rect",
            x: horizontal ? layout.plotArea.x : bar.slotX,
            y: horizontal ? bar.slotX : layout.plotArea.y,
            width: horizontal ? layout.plotArea.width : bar.slotWidth,
            height: horizontal ? bar.slotWidth : layout.plotArea.height,
            fill: "rgba(0, 0, 0, 0.08)",
            pixelSnap: geometry.pixelSnap,
            clip
          });
        }

        const animatedRect = {
          x: horizontal ? animatedValueRect.x : bar.x,
          y: horizontal ? bar.x : animatedValueRect.y,
          width: horizontal ? animatedValueRect.width : bar.width,
          height: horizontal ? bar.width : animatedValueRect.height
        };
        const stackInfo = stackInfoByBar.get(bar.visualIndex);
        const rect = animatedRect;
        const cornerRadiusPx = resolveBarCornerRadiusPx(appearance, rect, horizontal);
        const visibleLength = horizontal ? rect.width : rect.height;
        const barColor = showBarHighlight && (hoverStyle === "bar" || hoverStyle === "background-and-bar")
          ? lightenColor(fill, 0.18)
          : fill;
        const mainPaint = resolveBarRectPaint(appearance, barColor, rect, bar, horizontal, stackInfo, cornerRadiusPx, useLayeredStack);

        if (visibleLength > 0) {
          const allowBatch = batchMainRects && !useLayeredStack;

          if (useLayeredStack) {
            appendLayeredStackRect(
              layeredStackLayers,
              stackInfo?.orderFromBaseline ?? 0,
              rect,
              mainPaint,
              batchMainRects,
              geometry.pixelSnap,
              clip
            );
          } else {
            appendBarRect(
              barFrontBatches,
              barFrontPrimitives,
              rect,
              mainPaint,
              allowBatch,
              geometry.pixelSnap,
              clip
            );
          }
        }

        if (valueLabels && visibleLength > 0) {
          const label = resolveBarValueLabel(valueLabels, data[bar.dataIndex] as TDatum, index, value);

          if (label) {
            barOverlayPrimitives.push(resolveBarValueLabelPrimitive(label, valueLabels, rect, horizontal, bar.valueEnd >= bar.valueStart, theme.palette.foreground));
          }
        }

        if (hoverStyle !== "none" && !options.series) {
          let lastX = Number.NaN;
          let lastY = Number.NaN;
          let lastHit: ReturnType<NonNullable<Extract<Primitive, { kind: "rect" }>['hitTest']>>;
          barOverlayPrimitives.push({
            kind: "rect",
            x: horizontal ? layout.plotArea.x : bar.slotX,
            y: horizontal ? bar.slotX : layout.plotArea.y,
            width: horizontal ? layout.plotArea.width : bar.slotWidth,
            height: horizontal ? bar.slotWidth : layout.plotArea.height,
            hover: {
              markType: "bar",
              index
            },
            hidden: true,
            hitTest(x, y) {
              if (x === lastX && y === lastY) {
                return lastHit;
              }
              lastX = x;
              lastY = y;
              const rx = horizontal ? layout.plotArea.x : bar.slotX;
              const ry = horizontal ? bar.slotX : layout.plotArea.y;
              const rw = horizontal ? layout.plotArea.width : bar.slotWidth;
              const rh = horizontal ? bar.slotWidth : layout.plotArea.height;
              if (x < rx || x > rx + rw || y < ry || y > ry + rh) {
                lastHit = undefined;
                return lastHit;
              }

              const tooltip = resolveTooltip(options, data[bar.dataIndex] as TDatum, index, value, bar);

              lastHit = {
                index,
                ...(tooltip ? { tooltip } : {}),
                tooltipBounds: rect,
                tooltipPlacement: resolveBarTooltipPlacement(horizontal, bar.valueEnd >= bar.valueStart),
                x: rx,
                y: ry,
                width: rw,
                height: rh
              };
              return lastHit;
            },
            ...(layout.clipArea ? { clip: layout.clipArea } : {})
          });
        }
      }

      primitives.push(...rectBatchesToPrimitives(barFrontBatches, geometry.pixelSnap, clip));
      primitives.push(...barFrontPrimitives);
      primitives.push(...layeredStackLayersToPrimitives(layeredStackLayers, geometry.pixelSnap, clip));
      primitives.push(...barOverlayPrimitives);

      if (options.series && (options.hoverStyle ?? "background-and-bar") !== "none") {
        primitives.push(...resolveGroupedHoverPrimitives(options, data, geometry, horizontal, layout.plotArea, layout.clipArea, theme.palette.series, theme.palette.foreground));
      }

      return primitives;
    }
  };
}

function resolveBarHoverPrimitives<TDatum>(
  geometry: BarGeometry,
  horizontal: boolean,
  plotArea: { x: number; y: number; width: number; height: number },
  clipArea: { x: number; y: number; width: number; height: number } | undefined,
  options: BarMarkOptions<TDatum>,
  hover: HoverState | undefined,
  palette: readonly string[],
  foreground: string,
  appearance: BarAppearance
): Primitive[] {
  if (hover?.markType !== "bar") {
    return [];
  }

  const hoverBars = getBarHoverGroups(geometry, options.series !== undefined).get(hover.index) ?? [];

  if (hoverBars.length === 0) {
    return [];
  }

  const hoverStyle = options.hoverStyle ?? "background-and-bar";
  const first = hoverBars[0] as BarGeometry["bars"][number];
  const showBarHighlight = !options.series || first.slotWidth >= MIN_GROUP_HOVER_WIDTH;
  const stacked = resolveBarLayout(options) !== "grouped";
  const stackInfoByBar = buildStackSegmentInfo(geometry.bars, stacked, appearance.layeredStack === true);
  const primitives: Primitive[] = [];

  if (hoverStyle === "background" || hoverStyle === "background-and-bar") {
    primitives.push({
      kind: "rect",
      x: horizontal ? plotArea.x : first.slotX,
      y: horizontal ? first.slotX : plotArea.y,
      width: horizontal ? plotArea.width : first.slotWidth,
      height: horizontal ? first.slotWidth : plotArea.height,
      fill: "rgba(0, 0, 0, 0.08)",
      pixelSnap: geometry.pixelSnap,
      clip: clipArea ?? plotArea
    });
  }

  if (showBarHighlight && (hoverStyle === "bar" || hoverStyle === "background-and-bar")) {
    const extensionPrimitives: Primitive[] = [];
    const mainPrimitives: Primitive[] = [];
    const layeredHoverLayers = new Map<number, LayeredStackLayer>();
    const layeredStack = stacked && appearance.layeredStack === true;

    for (const bar of hoverBars) {
      const valueRect = resolveValueRect(layeredStack ? 0 : bar.valueStart, bar.valueEnd, geometry.valueDomain, horizontal, plotArea, 1);
      const rect = {
        x: horizontal ? valueRect.x : bar.x,
        y: horizontal ? bar.x : valueRect.y,
        width: horizontal ? valueRect.width : bar.width,
        height: horizontal ? bar.width : valueRect.height
      };

      const growsUp = bar.valueEnd >= bar.valueStart;
      if (!horizontal) {
        if (growsUp) {
          rect.height = Math.max(0, rect.height - 1);
        } else {
          rect.y = rect.y + 1;
          rect.height = Math.max(0, rect.height - 1);
        }
      } else {
        if (growsUp) {
          rect.x = rect.x + 1;
          rect.width = Math.max(0, rect.width - 1);
        } else {
          rect.width = Math.max(0, rect.width - 1);
        }
      }
      const fill = resolveBarFill(options, palette, foreground, bar.seriesIndex, bar.categoryLabel, bar.seriesLabel);
      const cornerRadiusPx = resolveBarCornerRadiusPx(appearance, rect, horizontal);
      const stackInfo = stackInfoByBar.get(bar.visualIndex);
      const paint = resolveBarRectPaint(
        appearance,
        lightenColor(fill, 0.18),
        rect,
        bar,
        horizontal,
        stackInfo,
        cornerRadiusPx,
        layeredStack
      );

      const visibleLength = horizontal ? rect.width : rect.height;
      if (visibleLength > 0 && !layeredStack) {
        const extensionRect = createLayeredExtensionRect(rect, appearance, horizontal, bar, stackInfo, cornerRadiusPx);

        if (extensionRect) {
          const extensionPaint = resolveLayeredExtensionPaint(
            appearance,
            lightenColor(fill, 0.18),
            rect
          );

          extensionPrimitives.push({
            kind: "rect",
            ...extensionRect,
            ...extensionPaint,
            pixelSnap: geometry.pixelSnap,
            clip: clipArea ?? plotArea
          });
        }
      }

      if (layeredStack) {
        appendLayeredStackRect(
          layeredHoverLayers,
          stackInfo?.orderFromBaseline ?? 0,
          rect,
          paint,
          false,
          geometry.pixelSnap,
          clipArea ?? plotArea
        );
      } else {
        mainPrimitives.push({
          kind: "rect",
          ...rect,
          ...paint,
          pixelSnap: geometry.pixelSnap,
          clip: clipArea ?? plotArea
        });
      }
    }

    primitives.push(
      ...extensionPrimitives,
      ...mainPrimitives,
      ...layeredStackLayersToPrimitives(layeredHoverLayers, geometry.pixelSnap, clipArea ?? plotArea)
    );
  }

  return primitives;
}

function getBarHoverGroups(
  geometry: BarGeometry,
  grouped: boolean
): Map<number, BarGeometry["bars"][number][]> {
  const cached = barHoverGroupsCache.get(geometry);
  if (cached) {
    return cached;
  }

  const groups = new Map<number, BarGeometry["bars"][number][]>();

  for (const bar of geometry.bars) {
    const hoverIndex = grouped ? bar.groupIndex : bar.index;
    const bars = groups.get(hoverIndex);

    if (bars) {
      bars.push(bar);
    } else {
      groups.set(hoverIndex, [bar]);
    }
  }

  barHoverGroupsCache.set(geometry, groups);
  return groups;
}

function resolveAnimationProgress(
  animation: { progress: number; profile: AnimationProfile } | undefined,
  index: number,
  count: number
): number {
  if (!animation) {
    return 1;
  }

  if (animation.profile === "waterfall-left") {
    const staggerWindow = 0.65;
    const localSpan = 1 - staggerWindow;
    const delay = count <= 1 ? 0 : (index / (count - 1)) * staggerWindow;

    return clamp01((animation.progress - delay) / localSpan);
  }

  return animation.progress;
}

function resolveStackSegmentAnimationProgress(
  animation: { progress: number; profile: AnimationProfile } | undefined,
  bar: BarGeometry["bars"][number],
  state: StackAnimationState
): number {
  if (!animation) {
    return 1;
  }

  const stack = state.get(stackAnimationKey(bar));
  const stackTotal = stack?.total ?? Math.abs(bar.value);

  if (stackTotal <= 0) {
    return 1;
  }

  const stackProgress = animation.profile === "waterfall-left"
    ? resolveStackWaterfallProgress(animation.progress, stack)
    : animation.progress;
  const revealed = stackTotal * clamp01(stackProgress);
  const segmentStart = Math.min(Math.abs(bar.valueStart), Math.abs(bar.valueEnd));
  const segmentLength = Math.abs(bar.valueEnd - bar.valueStart);

  if (segmentLength <= 0) {
    return 1;
  }

  return clamp01((revealed - segmentStart) / segmentLength);
}

function resolveStackWaterfallProgress(
  progress: number,
  stack: StackAnimationInfo | undefined
): number {
  const staggerWindow = 0.45;
  const localSpan = 1 - staggerWindow;
  const delay = (stack?.position ?? 0) * staggerWindow;

  return clamp01((progress - delay) / localSpan);
}

type StackAnimationInfo = {
  total: number;
  position: number;
  order: number;
};

type StackAnimationState = ReadonlyMap<string, StackAnimationInfo>;

function buildStackAnimationState(
  bars: readonly BarGeometry["bars"][number][],
  stacked: boolean
): StackAnimationState {
  const stacks = new Map<string, StackAnimationInfo>();

  if (!stacked) {
    return stacks;
  }

  for (const bar of bars) {
    const key = stackAnimationKey(bar);
    const existing = stacks.get(key);

    if (existing) {
      existing.total += Math.abs(bar.value);
    } else {
      stacks.set(key, {
        total: Math.abs(bar.value),
        order: stackOrderValue(bar),
        position: 0
      });
    }
  }

  const ordered = [...stacks.values()].sort((left, right) => left.order - right.order);
  const denominator = Math.max(1, ordered.length - 1);

  ordered.forEach((stack, index) => {
    stack.position = index / denominator;
  });

  return stacks;
}

function stackAnimationKey(bar: BarGeometry["bars"][number]): string {
  return `${bar.groupIndex}:${Math.round(bar.x * 100)}:${bar.value >= 0 ? "positive" : "negative"}`;
}

function stackOrderValue(bar: BarGeometry["bars"][number]): number {
  return bar.groupIndex * 100000 + Math.round(bar.x * 100);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function resolveValueRect(
  valueStart: number,
  valueEnd: number,
  domain: readonly [number, number],
  horizontal: boolean,
  plotArea: { x: number; y: number; width: number; height: number },
  animationProgress: number
): { x: number; y: number; width: number; height: number } {
  const [min, max] = domain;
  const span = max - min || 1;
  const startT = clamp01((valueStart - min) / span);
  const endT = clamp01((valueEnd - min) / span);

  if (horizontal) {
    const startX = plotArea.x + startT * plotArea.width;
    const endX = plotArea.x + (startT + (endT - startT) * animationProgress) * plotArea.width;

    return {
      x: Math.min(startX, endX),
      y: plotArea.y,
      width: Math.abs(endX - startX),
      height: plotArea.height
    };
  }

  const startY = plotArea.y + plotArea.height - startT * plotArea.height;
  const endY = plotArea.y + plotArea.height - (startT + (endT - startT) * animationProgress) * plotArea.height;

  return {
    x: plotArea.x,
    y: Math.min(startY, endY),
    width: plotArea.width,
    height: Math.abs(endY - startY)
  };
}

function resolveZeroBaseline(
  domain: readonly [number, number],
  horizontal: boolean,
  plotArea: { x: number; y: number; width: number; height: number },
  stroke: string,
  clipArea: { x: number; y: number; width: number; height: number } | undefined
): Primitive | undefined {
  const [min, max] = domain;

  if (min >= 0 || max <= 0) {
    return undefined;
  }

  const t = (0 - min) / (max - min || 1);

  return horizontal
    ? {
        kind: "path",
        points: [
          [plotArea.x + t * plotArea.width, plotArea.y],
          [plotArea.x + t * plotArea.width, plotArea.y + plotArea.height]
        ],
        stroke,
        ...(clipArea ? { clip: clipArea } : {})
      }
    : {
        kind: "path",
        points: [
          [plotArea.x, plotArea.y + plotArea.height - t * plotArea.height],
          [plotArea.x + plotArea.width, plotArea.y + plotArea.height - t * plotArea.height]
        ],
        stroke,
        ...(clipArea ? { clip: clipArea } : {})
      };
}

function resolveTooltip<TDatum>(
  options: BarMarkOptions<TDatum>,
  datum: TDatum,
  index: number,
  value: number,
  bar: BarGeometry["bars"][number]
): TooltipContent | undefined {
  if (options.tooltip === false) {
    return undefined;
  }

  if (typeof options.tooltip === "function") {
    return normalizeTooltipResult(options.tooltip(datum, index));
  }

  return {
    title: bar.seriesLabel ? `${bar.categoryLabel ?? `Group ${index + 1}`} · ${bar.seriesLabel}` : `Bar ${index + 1}`,
    lines: [`Value\t${value}`]
  };
}

function resolveValueLabelOptions<TDatum>(
  options: BarMarkOptions<TDatum>
): BarValueLabelOptions<TDatum> | undefined {
  if (options.valueLabels === true) {
    return {};
  }

  return options.valueLabels || undefined;
}

function resolveBarValueLabel<TDatum>(
  options: BarValueLabelOptions<TDatum>,
  datum: TDatum,
  index: number,
  value: number
): string {
  return options.formatter ? options.formatter(value, datum, index) : formatValue(value);
}

function resolveBarValueLabelPrimitive<TDatum>(
  text: string,
  options: BarValueLabelOptions<TDatum>,
  rect: { x: number; y: number; width: number; height: number },
  horizontal: boolean,
  positive: boolean,
  fallbackFill: string
): Primitive {
  const padding = options.padding ?? 6;

  if (horizontal) {
    return {
      kind: "text",
      x: positive ? rect.x + rect.width + padding : rect.x - padding,
      y: rect.y + rect.height / 2,
      text,
      fill: options.fill ?? fallbackFill,
      ...(options.font ? { font: options.font } : {}),
      align: positive ? "left" : "right",
      baseline: "middle"
    };
  }

  return {
    kind: "text",
    x: rect.x + rect.width / 2,
    y: positive ? rect.y - padding : rect.y + rect.height + padding,
    text,
    fill: options.fill ?? fallbackFill,
    ...(options.font ? { font: options.font } : {}),
    align: "center",
    baseline: positive ? "bottom" : "top"
  };
}

function canBatchMainBarRects(appearance: BarAppearance): boolean {
  return (appearance.fillMode ?? "solid") !== "gradient";
}

function appendBarRect(
  batches: Map<string, { paint: RectPaint; rects: { x: number; y: number; width: number; height: number }[] }>,
  individual: Primitive[],
  rect: { x: number; y: number; width: number; height: number },
  paint: RectPaint,
  allowBatch: boolean,
  pixelSnap: boolean,
  clip: { x: number; y: number; width: number; height: number }
): void {
  if (!allowBatch) {
    individual.push({
      kind: "rect",
      ...rect,
      ...paint,
      pixelSnap,
      clip
    });

    return;
  }

  const batchKey = barRectBatchKey(paint);
  const batch = batches.get(batchKey);

  if (batch) {
    batch.rects.push(rect);
  } else {
    batches.set(batchKey, { paint, rects: [rect] });
  }
}

type LayeredStackLayer = {
  batches: Map<string, { paint: RectPaint; rects: { x: number; y: number; width: number; height: number }[] }>;
  primitives: Primitive[];
};

function appendLayeredStackRect(
  layers: Map<number, LayeredStackLayer>,
  layerIndex: number,
  rect: { x: number; y: number; width: number; height: number },
  paint: RectPaint,
  allowBatch: boolean,
  pixelSnap: boolean,
  clip: { x: number; y: number; width: number; height: number }
): void {
  let layer = layers.get(layerIndex);

  if (!layer) {
    layer = {
      batches: new Map(),
      primitives: []
    };
    layers.set(layerIndex, layer);
  }

  appendBarRect(layer.batches, layer.primitives, rect, paint, allowBatch, pixelSnap, clip);
}

function layeredStackLayersToPrimitives(
  layers: Map<number, LayeredStackLayer>,
  pixelSnap: boolean,
  clip: { x: number; y: number; width: number; height: number }
): Primitive[] {
  return [...layers.entries()]
    .sort((left, right) => right[0] - left[0])
    .flatMap(([, layer]) => [
      ...rectBatchesToPrimitives(layer.batches, pixelSnap, clip),
      ...layer.primitives
    ]);
}

function rectBatchesToPrimitives(
  batches: Map<string, { paint: RectPaint; rects: { x: number; y: number; width: number; height: number }[] }>,
  pixelSnap: boolean,
  clip: { x: number; y: number; width: number; height: number }
): Primitive[] {
  return [...batches.values()].map<Primitive>((batch) => ({
    kind: "rects",
    rects: batch.rects,
    ...batch.paint,
    pixelSnap,
    clip
  }));
}

function resolveBarAppearance<TDatum>(options: BarMarkOptions<TDatum>): BarAppearance {
  return options.appearance ?? {};
}

function resolveEffectiveBarAppearance(appearance: BarAppearance, layout: Layout, dataLength: number): BarAppearance {
  if (!shouldSimplifyBarAppearance(layout, dataLength)) {
    return appearance;
  }

  return {
    ...(appearance.fillMode === "none" ? { fillMode: "none" as const } : { fillMode: "solid" as const }),
    ...(appearance.outline && appearance.outline !== "none" ? { outline: appearance.outline, strokeWidth: appearance.strokeWidth } : {})
  };
}

function shouldSimplifyBarAppearance(layout: Layout, dataLength: number): boolean {
  if (!layout.renderDistance.enabled) {
    return false;
  }

  const plotWidth = Math.max(1, layout.plotArea.width);
  const visibleCount = layout.dataWindow
    ? Math.max(1, layout.dataWindow.visibleEnd - layout.dataWindow.visibleStart)
    : Math.max(1, dataLength);

  return visibleCount / plotWidth > layout.renderDistance.minDensity;
}

function resolveLayeredExtensionPaint(
  appearance: BarAppearance,
  color: string,
  gradientBounds: { x: number; y: number; width: number; height: number }
): RectPaint {
  const fillMode = appearance.fillMode ?? "solid";
  const paint: RectPaint = {};

  if (fillMode === "gradient") {
    paint.fillGradient = barGradientFill(color, gradientBounds);
  } else if (fillMode === "solid") {
    paint.fill = color;
  }

  return paint;
}

function createLayeredExtensionRect(
  rect: { x: number; y: number; width: number; height: number },
  appearance: BarAppearance,
  horizontal: boolean,
  bar: { valueStart: number; valueEnd: number },
  stackInfo: StackSegmentInfo | undefined,
  overlap: number
): { x: number; y: number; width: number; height: number } | undefined {
  if (!appearance.layeredStack || !stackInfo || stackInfo.isStackBottom || overlap <= 0) {
    return undefined;
  }

  if ((horizontal ? rect.width : rect.height) <= 0) {
    return undefined;
  }

  const growsUp = bar.valueEnd >= bar.valueStart;
  const bleed = 1.0; // Overlap by 1 pixel to prevent subpixel gaps

  if (!horizontal) {
    return growsUp
      ? { x: rect.x, y: rect.y + rect.height - bleed, width: rect.width, height: overlap + bleed }
      : { x: rect.x, y: rect.y - overlap, width: rect.width, height: overlap + bleed };
  }

  return growsUp
    ? { x: rect.x - overlap, y: rect.y, width: overlap + bleed, height: rect.height }
    : { x: rect.x + rect.width - bleed, y: rect.y, width: overlap + bleed, height: rect.height };
}

function resolveBarRectPaint(
  appearance: BarAppearance,
  color: string,
  rect: { width: number; height: number },
  bar: { valueStart: number; valueEnd: number },
  horizontal: boolean,
  stackInfo?: StackSegmentInfo,
  cornerRadiusPx?: number,
  forceRoundBaseline?: boolean
): RectPaint {
  const fillMode = appearance.fillMode ?? "solid";
  const outline = appearance.outline ?? "none";
  const strokeWidth = appearance.strokeWidth ?? (outline !== "none" ? 1.5 : undefined);
  const cornerRadii = (cornerRadiusPx ?? 0) > 0
    ? resolveBarCornerRadii(
      appearance,
      rect,
      bar,
      horizontal,
      stackInfo,
      cornerRadiusPx,
      forceRoundBaseline
    )
    : undefined;
  const paint: RectPaint = {};

  if (cornerRadii && cornerRadii.some((radius) => radius > 0)) {
    paint.cornerRadii = cornerRadii;
  }

  if (fillMode === "gradient") {
    paint.fillGradient = barGradientFill(color);
  } else if (fillMode === "solid") {
    paint.fill = color;
  }

  if (outline !== "none") {
    paint.stroke = color;

    if (strokeWidth !== undefined) {
      paint.strokeWidth = strokeWidth;
    }

    if (outline === "dashed") {
      paint.strokeDash = [5, 4];
    }
  }

  return paint;
}

type StackSegmentInfo = {
  isStackTop: boolean;
  isStackBottom: boolean;
  orderFromBaseline: number;
};

function buildStackSegmentInfo(
  bars: readonly BarGeometry["bars"][number][],
  stacked: boolean,
  layeredStack: boolean
): Map<number, StackSegmentInfo> {
  const info = new Map<number, StackSegmentInfo>();

  if (!stacked || !layeredStack) {
    return info;
  }

  const byStack = new Map<string, BarGeometry["bars"][number][]>();

  for (const bar of bars) {
    const stackKey = `${bar.groupIndex}\u0000${bar.x}`;
    const group = byStack.get(stackKey) ?? [];

    group.push(bar);
    byStack.set(stackKey, group);
  }

  for (const groupBars of byStack.values()) {
    annotateStackSegments(groupBars.filter((bar) => bar.value > 0), info, true);
    annotateStackSegments(groupBars.filter((bar) => bar.value < 0), info, false);
  }

  return info;
}

function annotateStackSegments(
  segments: readonly BarGeometry["bars"][number][],
  info: Map<number, StackSegmentInfo>,
  positive: boolean
): void {
  if (segments.length === 0) {
    return;
  }

  const sorted = [...segments].sort((left, right) => (
    positive ? left.valueStart - right.valueStart : right.valueStart - left.valueStart
  ));

  sorted.forEach((bar, index) => {
    info.set(bar.visualIndex, {
      isStackTop: index === sorted.length - 1,
      isStackBottom: index === 0,
      orderFromBaseline: index
    });
  });
}

function resolveBarCornerRadiusPx(
  appearance: BarAppearance,
  rect: { width: number; height: number },
  horizontal: boolean
): number {
  const ratio = clamp(appearance.cornerRadiusRatio ?? 0, 0, 0.5);

  if (ratio <= 0) {
    return 0;
  }

  const thickness = horizontal ? rect.height : rect.width;
  const length = horizontal ? rect.width : rect.height;

  return Math.min(thickness * ratio, thickness / 2, length / 2);
}

function resolveBarCornerRadii(
  appearance: BarAppearance,
  rect: { width: number; height: number },
  bar: { valueStart: number; valueEnd: number },
  horizontal: boolean,
  stackInfo?: StackSegmentInfo,
  cornerRadiusPx?: number,
  forceRoundBaseline?: boolean
): CornerRadii {
  const radius = cornerRadiusPx ?? resolveBarCornerRadiusPx(appearance, rect, horizontal);

  if (radius <= 0) {
    return [0, 0, 0, 0];
  }

  const roundBaseline = appearance.roundBottom === true
    && (forceRoundBaseline === true || !stackInfo || stackInfo.isStackBottom);
  const baselineSide = roundBaseline ? radius : 0;
  const outer = radius;
  const growsUp = bar.valueEnd >= bar.valueStart;

  if (!horizontal) {
    return growsUp
      ? [outer, outer, baselineSide, baselineSide]
      : [baselineSide, baselineSide, outer, outer];
  }

  return growsUp
    ? [baselineSide, outer, outer, baselineSide]
    : [outer, baselineSide, baselineSide, outer];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function barGradientFill(
  color: string,
  bounds?: { x: number; y: number; width: number; height: number }
): GradientFill {
  const fill: GradientFill = {
    axis: "y",
    stops: [
      { offset: 0, color: lightenColor(color, 0.24) },
      { offset: 1, color: darkenColor(color, 0.08) }
    ]
  };

  if (bounds) {
    fill.bounds = bounds;
  }

  return fill;
}

function barRectBatchKey(paint: RectPaint): string {
  return [
    paint.fill ?? "",
    paint.stroke ?? "",
    paint.strokeWidth ?? "",
    paint.strokeDash?.join(",") ?? "",
    paint.cornerRadii?.join(",") ?? ""
  ].join("|");
}

function resolveGroupedHoverPrimitives<TDatum>(
  options: BarMarkOptions<TDatum>,
  data: readonly TDatum[],
  geometry: BarGeometry,
  horizontal: boolean,
  plotArea: { x: number; y: number; width: number; height: number },
  clipArea: { x: number; y: number; width: number; height: number } | undefined,
  palette: readonly string[],
  foreground: string
): Primitive[] {
  const groupBars = new Map<number, BarGeometry["bars"][number][]>();

  for (const bar of geometry.bars) {
    const bars = groupBars.get(bar.groupIndex);

    if (bars) {
      bars.push(bar);
    } else {
      groupBars.set(bar.groupIndex, [bar]);
    }
  }

  const targets = [...groupBars].map(([index, bars]) => {
    const first = bars[0] as BarGeometry["bars"][number];
    const start = first.slotX;
    const size = first.slotWidth;
    return { index, bars, start, end: start + size };
  }).sort((left, right) => left.start - right.start);

  let lastX = Number.NaN;
  let lastY = Number.NaN;
  let lastHit: ReturnType<NonNullable<Extract<Primitive, { kind: "rect" }>['hitTest']>>;

  return [{
    kind: "rect",
    x: plotArea.x,
    y: plotArea.y,
    width: plotArea.width,
    height: plotArea.height,
    hover: { markType: "bar", index: -1 },
    hidden: true,
    hitTest(x, y) {
      if (x === lastX && y === lastY) {
        return lastHit;
      }
      lastX = x;
      lastY = y;

      const coordinate = horizontal ? y : x;
      const target = findGroupHoverTarget(targets, coordinate);
      if (!target) {
        lastHit = undefined;
        return lastHit;
      }

      const first = target.bars[0] as BarGeometry["bars"][number];
      const rx = horizontal ? plotArea.x : first.slotX;
      const ry = horizontal ? first.slotX : plotArea.y;
      const rw = horizontal ? plotArea.width : first.slotWidth;
      const rh = horizontal ? first.slotWidth : plotArea.height;
      const tooltip = resolveGroupTooltip(options, data, target.bars, palette, foreground);
      const tooltipBounds = resolveGroupTooltipBounds(target.bars, geometry.valueDomain, horizontal, plotArea);
      const tooltipPlacement = resolveGroupedTooltipPlacement(target.bars, horizontal);

      lastHit = {
        index: target.index,
        ...(tooltip ? { tooltip } : {}),
        ...(tooltip ? { tooltipBounds } : {}),
        ...(tooltip ? { tooltipPlacement } : {}),
        x: rx,
        y: ry,
        width: rw,
        height: rh
      };
      return lastHit;
    },
    clip: clipArea ?? plotArea
  }];
}

function findGroupHoverTarget<TBar extends { start: number; end: number }>(
  targets: readonly TBar[],
  coordinate: number
): TBar | undefined {
  let low = 0;
  let high = targets.length - 1;

  while (low <= high) {
    const middle = (low + high) >> 1;
    const target = targets[middle] as TBar;
    if (coordinate < target.start) {
      high = middle - 1;
    } else if (coordinate > target.end) {
      low = middle + 1;
    } else {
      return target;
    }
  }

  return undefined;
}

function sameDomain(
  left: readonly [number, number] | undefined,
  right: readonly [number, number] | undefined
): boolean {
  return left === right || (left?.[0] === right?.[0] && left?.[1] === right?.[1]);
}

function sameDataWindow(left: Layout["dataWindow"] | undefined, right: Layout["dataWindow"] | undefined): boolean {
  return left === right || (
    left?.startIndex === right?.startIndex &&
    left?.endIndex === right?.endIndex &&
    left?.visibleStart === right?.visibleStart &&
    left?.visibleEnd === right?.visibleEnd &&
    left?.totalLength === right?.totalLength &&
    sameDomain(left?.visibleX, right?.visibleX)
  );
}

function resolveBarTooltipPlacement(horizontal: boolean, positive: boolean): "bar-top" | "bar-end-right" | "bar-end-left" {
  if (!horizontal) {
    return "bar-top";
  }

  return positive ? "bar-end-right" : "bar-end-left";
}

function resolveGroupedTooltipPlacement(
  bars: readonly BarGeometry["bars"][number][],
  horizontal: boolean
): "bar-top" | "bar-end-right" | "bar-end-left" {
  if (!horizontal) {
    return "bar-top";
  }

  const total = bars.reduce((sum, bar) => sum + bar.value, 0);

  return total >= 0 ? "bar-end-right" : "bar-end-left";
}

function resolveGroupTooltipBounds(
  bars: readonly BarGeometry["bars"][number][],
  valueDomain: readonly [number, number],
  horizontal: boolean,
  plotArea: { x: number; y: number; width: number; height: number }
): { x: number; y: number; width: number; height: number } {
  const rects = bars.map((bar) => {
    const valueRect = resolveValueRect(bar.valueStart, bar.valueEnd, valueDomain, horizontal, plotArea, 1);

    return {
      x: horizontal ? valueRect.x : bar.x,
      y: horizontal ? bar.x : valueRect.y,
      width: horizontal ? valueRect.width : bar.width,
      height: horizontal ? bar.width : valueRect.height
    };
  });
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));

  return { x: left, y: top, width: right - left, height: bottom - top };
}

function resolveGroupTooltip<TDatum>(
  options: BarMarkOptions<TDatum>,
  data: readonly TDatum[],
  bars: readonly BarGeometry["bars"][number][],
  palette: readonly string[],
  foreground: string
): TooltipContent | undefined {
  if (options.tooltip === false) {
    return undefined;
  }

  const sorted = [...bars].sort((left, right) => left.seriesIndex - right.seriesIndex);
  const title = sorted[0]?.categoryLabel;

  if (typeof options.tooltip === "function") {
    const tooltip = options.tooltip;
    const results = sorted.map((bar) => ({
      bar,
      content: normalizeTooltipResult(tooltip(data[bar.dataIndex] as TDatum, bar.dataIndex))
    }));
    const lines = results.flatMap((result) => result.content.lines);
    const markers = results.flatMap((result) => {
      const color = resolveBarFill(options, palette, foreground, result.bar.seriesIndex, result.bar.categoryLabel, result.bar.seriesLabel);

      return result.content.lines.map((_, lineIndex) => result.content.markers?.[lineIndex] ?? color);
    });

    return appendStackTotalLine(options, {
      ...(title ? { title } : {}),
      lines,
      markers
    }, sorted);
  }

  const lines = sorted.map((bar) => {
    const label = bar.stackLabel
      ? `${bar.stackLabel} / ${bar.seriesLabel ?? `Series ${bar.seriesIndex + 1}`}`
      : bar.seriesLabel ?? `Series ${bar.seriesIndex + 1}`;

    return `${label}\t${bar.value}`;
  });

  return appendStackTotalLine(options, {
    ...(title ? { title } : {}),
    lines,
    markers: sorted.map((bar) => resolveBarFill(options, palette, foreground, bar.seriesIndex, bar.categoryLabel, bar.seriesLabel))
  }, sorted);
}

function appendStackTotalLine<TDatum>(
  options: BarMarkOptions<TDatum>,
  content: TooltipContent,
  bars: readonly BarGeometry["bars"][number][]
): TooltipContent {
  if (resolveBarLayout(options) === "grouped" || options.stackTotalTooltip === false) {
    return content;
  }

  const total = bars.reduce((sum, bar) => sum + bar.value, 0);

  return {
    ...content,
    lines: [...content.lines, `Total\t${formatValue(total)}`],
    ...(content.markers ? { markers: [...content.markers, undefined] } : {})
  };
}

function normalizeTooltipResult(result: TooltipResult): TooltipContent {
  return Array.isArray(result) ? { lines: result as readonly string[] } : result as TooltipContent;
}

function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function resolveBarGeometry<TDatum>(
  plotX: number,
  plotWidth: number,
  data: readonly TDatum[],
  options: BarMarkOptions<TDatum>,
  value: Accessor<TDatum, number>,
  dataWindow: {
    startIndex: number;
    endIndex: number;
    visibleStart: number;
    visibleEnd: number;
    totalLength: number;
  } | undefined,
  valueDomainOverride: readonly [number, number] | undefined
): BarGeometry {
  if (options.series) {
    return resolveGroupedBarGeometry(plotX, plotWidth, data, options, value, dataWindow, valueDomainOverride);
  }

  if (dataWindow && data.every(isIndexedBucketDatum)) {
    return resolveWindowedBarGeometry(plotX, plotWidth, data, options, value, dataWindow, valueDomainOverride);
  }

  const count = data.length;
  const left = plotX;
  const width = Math.max(1, plotWidth);
  const gapRatio = resolveGapRatio(options, count);
  const minBarWidth = options.minBarWidth ?? 2;
  const minGapWidth = options.minGapWidth ?? 2;
  const slotWidth = width / count;
  const valueDomain = valueDomainOverride ?? resolveValueDomain(data, value, options);

  if (slotWidth < 1) {
    return {
      sourceCount: count,
      pixelSnap: false,
      valueDomain,
      bars: resolveDenseBarGeometry(left, width, data, value)
    };
  }

  const gapWidth = resolveContinuousGapWidth(slotWidth, gapRatio, minBarWidth, minGapWidth);
  const barWidth = slotWidth - gapWidth;
  const inset = Math.max(0, (slotWidth - barWidth) / 2);

  return {
    sourceCount: count,
    pixelSnap: gapWidth === 0,
    valueDomain,
    bars: data.map((datum, index) => {
      const slotX = left + index * slotWidth;
      const x = slotX + inset;
      const barValue = readAccessor(value, datum, index);

      return {
        x,
        width: barWidth,
        slotX,
        slotWidth,
        visualIndex: index,
        index,
        dataIndex: index,
        value: barValue,
        valueStart: 0,
        valueEnd: barValue,
        groupIndex: index,
        seriesIndex: 0,
        categoryLabel: String(readAccessor(horizontalCategoryAccessor(options), datum, index))
      };
    })
  };
}

function resolveGroupedBarGeometry<TDatum>(
  plotX: number,
  plotWidth: number,
  data: readonly TDatum[],
  options: BarMarkOptions<TDatum>,
  value: Accessor<TDatum, number>,
  dataWindow: {
    startIndex: number;
    endIndex: number;
    visibleStart: number;
    visibleEnd: number;
    totalLength: number;
  } | undefined,
  valueDomainOverride: readonly [number, number] | undefined
): BarGeometry {
  const seriesAccessor = options.series;

  if (!seriesAccessor) {
    throw new Error("Grouped bar geometry requires a series accessor.");
  }

  const left = plotX;
  const width = Math.max(1, plotWidth);
  const categoryAccessor = horizontalCategoryAccessor(options);
  const stackAccessor = resolveStackAccessor(options);
  const groups = collectGroupedBars(data, categoryAccessor, seriesAccessor, stackAccessor, options.seriesOrder);
  const groupCount = Math.max(1, groups.items.length);
  const stacked = resolveBarLayout(options) !== "grouped";
  const stackGroupCount = stacked ? Math.max(1, groups.stackKeys.length) : 1;
  const seriesCount = stacked ? stackGroupCount : Math.max(1, groups.seriesKeys.length);
  const groupSlotWidth = width / groupCount;
  const visibleStart = dataWindow?.visibleStart ?? 0;
  const visibleEnd = dataWindow?.visibleEnd ?? groups.items.length;
  const visibleCount = Math.max(Number.EPSILON, visibleEnd - visibleStart);
  const groupSlot = dataWindow ? width / visibleCount : groupSlotWidth;
  const minBarWidth = options.minBarWidth ?? 2;
  const minGapWidth = options.minGapWidth ?? 2;
  const groupedGapRatio = resolveGapRatio(options, groupCount);
  const groupGapRatio = Math.max(0, Math.min(0.8, options.interGroupGapRatio ?? (stacked ? 0 : groupedGapRatio)));
  const barGapRatio = Math.max(0, Math.min(0.8, options.interBarGapRatio ?? groupedGapRatio));
  const groupMinBarWidth = minBarWidth * seriesCount;
  const groupGap = resolveContinuousGapWidth(
    groupSlot,
    seriesCount > 1 ? groupGapRatio : resolveGapRatio(options, groupCount),
    groupMinBarWidth,
    minGapWidth
  );
  const groupInnerWidth = Math.max(1, groupSlot - groupGap);
  const barGap = seriesCount > 1
    ? resolveContinuousGapWidth(groupInnerWidth / seriesCount, barGapRatio, minBarWidth, 1)
    : 0;
  const totalBarGap = barGap * Math.max(0, seriesCount - 1);
  const barWidth = Math.max(1, (groupInnerWidth - totalBarGap) / seriesCount);
  const groupInset = Math.max(0, (groupSlot - groupInnerWidth) / 2);
  const valueDomain = valueDomainOverride ?? (stacked ? resolveStackedValueDomain(data, groups, value, options) : resolveValueDomain(data, value, options));
  const bars: {
    x: number;
    width: number;
    slotX: number;
    slotWidth: number;
    visualIndex: number;
    index: number;
    dataIndex: number;
    value: number;
    valueStart: number;
    valueEnd: number;
    groupIndex: number;
    seriesIndex: number;
    stackLabel?: string;
    seriesLabel?: string;
    categoryLabel?: string;
  }[] = [];

  groups.items.forEach((group, ordinalIndex) => {
    const groupIndex = dataWindow ? group.index : ordinalIndex;
    const relativeGroupIndex = groupIndex - visibleStart;
    const groupWidth = dataWindow ? Math.max(1, group.count) : 1;
    const rawGroupSlot = dataWindow ? groupSlot * groupWidth : groupSlotWidth;
    const rawGroupGap = resolveContinuousGapWidth(
      rawGroupSlot,
      seriesCount > 1 ? groupGapRatio : resolveGapRatio(options, groupCount),
      groupMinBarWidth,
      minGapWidth
    );
    const rawGroupInnerWidth = Math.max(1, rawGroupSlot - rawGroupGap);
    const rawGroupInset = Math.max(0, (rawGroupSlot - rawGroupInnerWidth) / 2);
    const rawBarGap = seriesCount > 1
      ? resolveContinuousGapWidth(rawGroupInnerWidth / seriesCount, barGapRatio, minBarWidth, 1)
      : 0;
    const rawTotalBarGap = rawBarGap * Math.max(0, seriesCount - 1);
    const rawBarWidth = Math.max(1, (rawGroupInnerWidth - rawTotalBarGap) / seriesCount);
    const groupX = dataWindow
      ? left + relativeGroupIndex * groupSlot + rawGroupInset
      : left + ordinalIndex * groupSlotWidth + groupInset;
    const slotX = dataWindow ? left + relativeGroupIndex * groupSlot : left + ordinalIndex * groupSlotWidth;
    const slotWidth = dataWindow ? rawGroupSlot : groupSlotWidth;
    const stackKeys = stacked ? groups.stackKeys : [DEFAULT_STACK_KEY];

    stackKeys.forEach((stackKey, stackIndex) => {
      const dataIndicesBySeries = group.dataIndicesByStack.get(stackKey);

      if (!dataIndicesBySeries) {
        return;
      }

      let positiveOffset = 0;
      let negativeOffset = 0;

      groups.seriesKeys.forEach((seriesKey, seriesIndex) => {
        const dataIndices = dataIndicesBySeries.get(seriesKey);

        if (!dataIndices) {
          return;
        }

        for (const dataIndex of dataIndices) {
          const datum = data[dataIndex] as TDatum;
          const barValue = readAccessor(value, datum, dataIndex);
          const valueStart = stacked
            ? barValue >= 0
              ? positiveOffset
              : negativeOffset
            : 0;
          const valueEnd = valueStart + barValue;

          if (stacked) {
            if (barValue >= 0) {
              positiveOffset = valueEnd;
            } else {
              negativeOffset = valueEnd;
            }
          }

          bars.push({
            x: groupX + (stacked ? stackIndex : seriesIndex) * (rawBarWidth + rawBarGap),
            width: rawBarWidth,
            slotX,
            slotWidth,
            visualIndex: bars.length,
            index: dataIndex,
            dataIndex,
            value: barValue,
            valueStart,
            valueEnd,
            groupIndex,
            seriesIndex,
            ...(stackKey !== DEFAULT_STACK_KEY ? { stackLabel: String(stackKey) } : {}),
            seriesLabel: String(seriesKey),
            categoryLabel: String(group.categoryKey)
          });
        }
      });
    });
  });

  return {
    sourceCount: bars.length,
    pixelSnap: !dataWindow && (stacked || barWidth < 2),
    valueDomain,
    bars
  };
}

function resolveDenseBarGeometry<TDatum>(
  left: number,
  width: number,
  data: readonly TDatum[],
  y: Accessor<TDatum, number>
): BarGeometry["bars"] {
  type BarItem = BarGeometry["bars"][number];
  const bars: BarItem[] = [];
  const pixelCount = Math.max(1, Math.ceil(width));
  let visualIndex = 0;

  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const pixelStart = (pixel / pixelCount) * width;
    const pixelEnd = ((pixel + 1) / pixelCount) * width;
    const start = Math.floor((pixel * data.length) / pixelCount);
    const end = Math.max(start + 1, Math.ceil(((pixel + 1) * data.length) / pixelCount));
    let minValue = Number.POSITIVE_INFINITY;
    let maxValue = Number.NEGATIVE_INFINITY;
    let minIndex = start;
    let maxIndex = start;

    for (let index = start; index < end; index += 1) {
      const datum = data[index];
      const value = datum ? readAccessor(y, datum, index) : 0;

      if (!Number.isFinite(value)) {
        continue;
      }

      if (value < minValue) {
        minValue = value;
        minIndex = index;
      }

      if (value > maxValue) {
        maxValue = value;
        maxIndex = index;
      }
    }

    if (!Number.isFinite(minValue) || !Number.isFinite(maxValue)) {
      continue;
    }

    const emitBar = (value: number, dataIndex: number) => {
      bars.push({
        x: left + pixelStart,
        width: Math.max(0.5, pixelEnd - pixelStart),
        slotX: left + pixelStart,
        slotWidth: Math.max(0.5, pixelEnd - pixelStart),
        visualIndex: visualIndex++,
        index: dataIndex,
        dataIndex,
        value,
        valueStart: 0,
        valueEnd: value,
        groupIndex: dataIndex,
        seriesIndex: 0
      });
    };

    if (minValue < 0 && maxValue > 0) {
      emitBar(minValue, minIndex);
      emitBar(maxValue, maxIndex);
      continue;
    }

    if (maxValue <= 0) {
      emitBar(minValue, minIndex);
      continue;
    }

    emitBar(maxValue, maxIndex);
  }

  return bars;
}

function resolveWindowedBarGeometry<TDatum>(
  plotX: number,
  plotWidth: number,
  data: readonly TDatum[],
  options: BarMarkOptions<TDatum>,
  valueAccessor: Accessor<TDatum, number>,
  dataWindow: {
    startIndex: number;
    endIndex: number;
    visibleStart: number;
    visibleEnd: number;
    totalLength: number;
  },
  valueDomainOverride: readonly [number, number] | undefined
): BarGeometry {
  const left = plotX;
  const width = Math.max(1, plotWidth);
  const visibleStart = dataWindow.visibleStart;
  const visibleCount = Math.max(Number.EPSILON, dataWindow.visibleEnd - dataWindow.visibleStart);
  const animationCount = Math.max(1, Math.ceil(visibleCount));
  const valueDomain = valueDomainOverride ?? resolveValueDomain(data, valueAccessor, options);
  const gapRatio = resolveGapRatio(options, data.length);
  const minBarWidth = options.minBarWidth ?? 2;
  const minGapWidth = options.minGapWidth ?? 2;

  return {
    sourceCount: animationCount,
    pixelSnap: false,
    valueDomain,
    bars: data.map((datum, dataIndex) => {
      const bucket = datum as TDatum & { index: number; count: number };
      const bucketStart = bucket.index - visibleStart;
      const bucketWidth = Math.max(1, bucket.count);
      const slotX = left + (bucketStart / visibleCount) * width;
      const slotWidth = Math.max(1, (bucketWidth / visibleCount) * width);
      const gapWidth = resolveContinuousGapWidth(slotWidth, gapRatio, minBarWidth, minGapWidth);
      const barWidth = slotWidth - gapWidth;
      const inset = Math.max(0, (slotWidth - barWidth) / 2);
      const value = readAccessor(valueAccessor, datum, dataIndex);

      return {
        x: slotX + inset,
        width: barWidth,
        slotX,
        slotWidth,
        visualIndex: bucketStart,
        index: bucket.index,
        dataIndex,
        value,
        valueStart: 0,
        valueEnd: value,
        groupIndex: bucket.index,
        seriesIndex: 0
      };
    })
  };
}

function valueAccessor<TDatum>(options: BarMarkOptions<TDatum>): Accessor<TDatum, number> {
  return (options.orientation === "horizontal" ? options.x : options.y) as Accessor<TDatum, number>;
}

function horizontalCategoryAccessor<TDatum>(options: BarMarkOptions<TDatum>): Accessor<TDatum, string | number> {
  return options.orientation === "horizontal" ? options.y : options.x;
}

function collectGroupedBars<TDatum>(
  data: readonly TDatum[],
  categoryAccessor: Accessor<TDatum, string | number>,
  seriesAccessor: Accessor<TDatum, string | number>,
  stackGroupAccessor: Accessor<TDatum, string | number> | undefined,
  seriesOrder: readonly (string | number)[] | undefined
): {
  items: {
    categoryKey: string | number;
    index: number;
    count: number;
    dataIndicesByStack: Map<string | number, Map<string | number, number[]>>;
  }[];
  seriesKeys: readonly (string | number)[];
  stackKeys: readonly (string | number)[];
} {
  const items: {
    categoryKey: string | number;
    index: number;
    count: number;
    dataIndicesByStack: Map<string | number, Map<string | number, number[]>>;
  }[] = [];
  const groupsByKey = new Map<string | number, (typeof items)[number]>();
  const seriesKeys: (string | number)[] = [];
  const seenSeries = new Set<string | number>();
  const stackKeys: (string | number)[] = [];
  const seenStacks = new Set<string | number>();

  for (const key of seriesOrder ?? []) {
    if (!seenSeries.has(key)) {
      seenSeries.add(key);
      seriesKeys.push(key);
    }
  }

  data.forEach((datum, index) => {
    const categoryKey = readAccessor(categoryAccessor, datum, index);
    const seriesKey = readAccessor(seriesAccessor, datum, index);
    const stackKey = stackGroupAccessor ? readAccessor(stackGroupAccessor, datum, index) : DEFAULT_STACK_KEY;

    if (!isValidGroupKey(categoryKey) || !isValidGroupKey(seriesKey) || !isValidGroupKey(stackKey)) {
      return;
    }

    let group = groupsByKey.get(categoryKey);

    if (!group) {
      group = {
        categoryKey,
        index: resolveGroupIndex(datum, items.length),
        count: resolveGroupCount(datum),
        dataIndicesByStack: new Map()
      };
      groupsByKey.set(categoryKey, group);
      items.push(group);
    }

    if (!seenSeries.has(seriesKey)) {
      seenSeries.add(seriesKey);
      seriesKeys.push(seriesKey);
    }

    if (!seenStacks.has(stackKey)) {
      seenStacks.add(stackKey);
      stackKeys.push(stackKey);
    }

    let stack = group.dataIndicesByStack.get(stackKey);

    if (!stack) {
      stack = new Map();
      group.dataIndicesByStack.set(stackKey, stack);
    }

    const stackIndices = stack.get(seriesKey);

    if (stackIndices) {
      stackIndices.push(index);
    } else {
      stack.set(seriesKey, [index]);
    }
  });

  return { items, seriesKeys, stackKeys: stackKeys.length > 0 ? stackKeys : [DEFAULT_STACK_KEY] };
}

function resolveBarLayout<TDatum>(options: Pick<BarMarkOptions<TDatum>, "layout" | "stack" | "stackGroup" | "stacked">): BarLayoutMode {
  if (options.layout) {
    return options.layout;
  }

  if (options.stacked !== undefined) {
    return options.stacked ? "stacked" : "grouped";
  }

  return options.stack !== undefined || options.stackGroup !== undefined ? "stacked" : "grouped";
}

function resolveStackAccessor<TDatum>(
  options: Pick<BarMarkOptions<TDatum>, "stack" | "stackGroup">
): Accessor<TDatum, string | number> | undefined {
  return options.stack ?? options.stackGroup;
}

function resolveGroupIndex(datum: unknown, fallback: number): number {
  if (
    typeof datum === "object" &&
    datum !== null &&
    typeof (datum as { groupIndex?: unknown }).groupIndex === "number"
  ) {
    return (datum as { groupIndex: number }).groupIndex;
  }

  return fallback;
}

function resolveGroupCount(datum: unknown): number {
  if (
    typeof datum === "object" &&
    datum !== null &&
    typeof (datum as { count?: unknown }).count === "number"
  ) {
    return Math.max(1, (datum as { count: number }).count);
  }

  return 1;
}

function isValidGroupKey(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
}

function resolveValueDomain<TDatum>(
  data: readonly TDatum[],
  accessor: Accessor<TDatum, number>,
  options: Pick<BarMarkOptions<TDatum>, "domainMin" | "domainMax">
): readonly [number, number] {
  if (options.domainMin !== undefined && options.domainMax !== undefined) {
    return [options.domainMin, options.domainMax];
  }

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
    options.domainMin ?? min,
    options.domainMax ?? max
  );

  return [
    options.domainMin ?? Math.min(0, nice[0]),
    options.domainMax ?? Math.max(0, nice[1])
  ];
}

function resolveStackedValueDomain<TDatum>(
  data: readonly TDatum[],
  groups: ReturnType<typeof collectGroupedBars<TDatum>>,
  accessor: Accessor<TDatum, number>,
  options: Pick<BarMarkOptions<TDatum>, "domainMin" | "domainMax">
): readonly [number, number] {
  if (options.domainMin !== undefined && options.domainMax !== undefined) {
    return [options.domainMin, options.domainMax];
  }

  let min = 0;
  let max = 0;

  for (const group of groups.items) {
    for (const dataIndicesBySeries of group.dataIndicesByStack.values()) {
      let positive = 0;
      let negative = 0;

      for (const dataIndices of dataIndicesBySeries.values()) {
      for (const dataIndex of dataIndices) {
        const value = readAccessor(accessor, data[dataIndex] as TDatum, dataIndex);

        if (!Number.isFinite(value)) {
          continue;
        }

        if (value >= 0) {
          positive += value;
        } else {
          negative += value;
        }
      }
    }

      min = Math.min(min, negative);
      max = Math.max(max, positive);
    }
  }

  const nice = niceLinearDomain(
    options.domainMin ?? min,
    options.domainMax ?? max
  );

  return [
    options.domainMin ?? Math.min(0, nice[0]),
    options.domainMax ?? Math.max(0, nice[1])
  ];
}

function isIndexedBucketDatum(datum: unknown): datum is { index: number; count: number } {
  return (
    typeof datum === "object" &&
    datum !== null &&
    typeof (datum as { index?: unknown }).index === "number" &&
    typeof (datum as { count?: unknown }).count === "number"
  );
}

function resolveGapRatio<TDatum>(options: BarMarkOptions<TDatum>, count: number): number {
  const base = Math.max(0, Math.min(0.95, options.gapRatio ?? DEFAULT_BAR_GAP_RATIO));

  if (!options.dynamicGap) {
    return base;
  }

  const strength = Math.max(0, Math.min(1, options.dynamicGapStrength ?? 0.5));
  const referenceCount = 100;
  const sparseFactor = Math.max(0, Math.min(1, (referenceCount - count) / referenceCount));
  const multiplier = 1 + sparseFactor * strength * 2;

  return Math.max(0, Math.min(0.95, base * multiplier));
}

function resolveContinuousGapWidth(
  slotWidth: number,
  gapRatio: number,
  minBarWidth: number,
  minGapWidth: number
): number {
  const maxGapWidth = Math.max(0, slotWidth - Math.min(minBarWidth, slotWidth));

  if (maxGapWidth === 0 || gapRatio <= 0) {
    return 0;
  }

  const targetGapWidth = Math.min(maxGapWidth, Math.max(minGapWidth, slotWidth * gapRatio));
  const rampStart = minBarWidth;
  const rampEnd = minBarWidth + Math.max(minGapWidth * 2, targetGapWidth * 2, 1);
  const t = rampEnd <= rampStart ? 1 : Math.max(0, Math.min(1, (slotWidth - rampStart) / (rampEnd - rampStart)));
  const visibility = t * t * (3 - 2 * t);

  return targetGapWidth * visibility;
}
