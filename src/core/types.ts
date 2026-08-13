import type { DataInput } from "../data/types";
import type { Mark } from "../marks/types";
import type { Renderer } from "../renderers/types";
import type { Theme } from "../themes/types";
import type { Transform } from "../transforms/types";

export type Size = {
  width: number;
  height: number;
};

export type Rect = Size & {
  x: number;
  y: number;
  cornerRadii?: CornerRadii;
};

export type PlotUpdate<TDatum = unknown> = Partial<
  Pick<
    PlotSpec<TDatum>,
    "data" | "marks" | "theme" | "width" | "height" | "axes" | "title" | "titleAnimation" | "frame" | "tooltip" | "interactions" | "optimization" | "dashboardResizePreview" | "resizeTransition" | "edgeBlur" | "axisAnimation" | "animationDuration" | "axisAnimationDuration" | "animationEasing" | "axisAnimationEasing" | "chartBorder" | "plotPadding" | "smoothedScaling" | "timeZone" | "hiddenSeries" | "activeTimeWindow"
  >
>;

export type Plot<TDatum = unknown> = {
  update(update: PlotUpdate<TDatum>): void;
  appendData(data: TDatum | readonly TDatum[] | Iterable<TDatum>): boolean;
  clearData(): boolean;
  resize(size?: Partial<Size>): void;
  animate(options?: AnimationOptions): void;
  focus(selection: PlotSelection, options?: { user?: boolean; immediateX?: boolean; streamingPin?: boolean }): void;
  resetFocus(options?: { immediate?: boolean }): void;
  getFocus?(): PlotSelection | undefined;
  isUserFocusActive?(): boolean;
  hasLockedViewport?(): boolean;
  render(): void;
  destroy(): void;
  getPlotArea?(): { x: number; y: number; width: number; height: number };
};

export type AnimationOptions = {
  profile?: AnimationProfile;
  axisProfile?: AxisAnimationProfile;
  durationMs?: number;
  axisDurationMs?: number;
  easing?: AnimationEasing | ((t: number) => number);
  axisEasing?: AnimationEasing | ((t: number) => number);
  /** When using random-fill, fade each point in instead of popping in. */
  randomFillFade?: boolean;
};

export type AnimationProfile = "rise" | "waterfall-left" | "draw-left" | "draw-right" | "random-fill" | "random-fill-grow";
export type TitleAnimationProfile = "none" | "fade" | "fade-slide";
export type LineCurve = "linear" | "catmull-rom" | "monotone-x" | "basis" | "step" | "step-before" | "step-after";
export type AxisAnimationProfile =
  | "none"
  | "origin-extend"
  | "fade"
  | "fade-slide"
  | "staggered-pop"
  | "domain-expansion";

export type AxisAnimationState = {
  profile: AxisAnimationProfile;
  progress: number;
  elapsedMs?: number;
  lineProgress?: number;
  lineDurationMs?: number;
  tickAnimMs?: number;
  lineEasing?: (t: number) => number;
};
export type AnimationEasing = "linear" | "ease-out-cubic" | "ease-in-out-cubic" | "ease-in-out-sine";
export type TimeZoneMode = "local" | "utc";

export type TimeWindowSpec = {
  label: string;
  value: string | number;
};

export type PlotSpec<TDatum = unknown> = {
  data: DataInput<TDatum>;
  marks: readonly Mark<TDatum>[];
  transforms?: readonly Transform<TDatum>[];
  renderer?: Renderer;
  theme?: Theme;
  axes?: AxesSpec | AxisSpecResolver<TDatum>;
  title?: ChartTitleSpec | string | undefined;
  titleAnimation?: TitleAnimationProfile;
  axisAnimation?: AxisAnimationProfile;
  frame?: FrameSpec | false;
  tooltip?: TooltipSpec | false;
  interactions?: InteractionSpec | false;
  optimization?: RenderOptimizationSpec | false;
  /** Retain dashboard canvas backing stores during live resize. */
  dashboardResizePreview?: boolean;
  resizeTransition?: ResizeTransitionSpec | false;
  edgeBlur?: EdgeBlurSpec | true | false;
  width?: number;
  height?: number;
  presetOptions?: any;
  animationDuration?: number | undefined;
  axisAnimationDuration?: number | undefined;
  animationEasing?: AnimationEasing | undefined;
  axisAnimationEasing?: AnimationEasing | undefined;
  smoothedScaling?: boolean;
  timeZone?: TimeZoneMode;
  liveYValueTicker?: boolean;
  liveHeaderTicker?: boolean;
  timeWindows?: TimeWindowSpec[];
  activeTimeWindow?: string | number;
  onTimeWindowChange?: (value: string | number) => void;
  streaming?: boolean;
  hiddenSeries?: Set<string | number> | undefined;
  chartBorder?: {
    enabled?: boolean;
    radius?: number;
    color?: string;
  };
  plotPadding?: {
    top?: number;
    right?: number;
    bottom?: number;
    left?: number;
  };
  startEmpty?: boolean;
};

export type ChartTitleSpec = {
  text: string;
  position?: "top" | "bottom";
  align?: "left" | "center" | "right";
  offset?: number;
  offsetX?: number;
  offsetY?: number;
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  font?: string;
  color?: string;
};

export type AxisTitleSpec = {
  text: string;
  position?: "bottom" | "top" | "left" | "right";
  align?: "start" | "center" | "end";
  offset?: number;
  offsetX?: number;
  offsetY?: number;
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  font?: string;
  color?: string;
};

export type EdgeBlurSpec = {
  left?: boolean;
  right?: boolean;
  top?: boolean;
  bottom?: boolean;
  size?: number;
};

export type EdgeBlurState = {
  left?: boolean;
  right?: boolean;
  top?: boolean;
  bottom?: boolean;
  color?: string;
  size?: number;
  /** Per-edge fade opacities in [0, 1]. When set, drawing uses these instead of booleans alone. */
  leftOpacity?: number;
  rightOpacity?: number;
  topOpacity?: number;
  bottomOpacity?: number;
};

export type ResizeTransitionSpec = {
  durationMs?: number;
};

export type RenderOptimizationSpec = {
  enabled?: boolean;
  minDensity?: number;
  lineSamplesPerPixel?: number;
  pointCellSize?: number;
};

export type AxisSpecResolver<TDatum = unknown> = (data: readonly TDatum[]) => AxesSpec;

export type AxesSpec = {
  x?: AxisSpec;
  y?: AxisSpec;
};

export type AxesOverrideSpec = {
  x?: Partial<AxisSpec>;
  y?: Partial<AxisSpec>;
};

export type AxisSpec =
  | {
      kind: "band";
      position: "bottom" | "left" | "right";
      labels: readonly string[];
      count?: number;
      numericDomain?: readonly [number, number];
      visibleBandRange?: readonly [number, number];
      startIndex?: number;
      timeDomain?: readonly [number, number];
      timeGranularity?: "auto" | "year" | "month" | "day" | "hour" | "minute" | "second";
      timeZone?: TimeZoneMode;
      timeHasSubMinutePrecision?: boolean;
      ticks?: boolean;
      line?: boolean;
      gridlines?: boolean;
      subgridlines?: boolean;
      edgeGridlines?: boolean;
      gridlineThickness?: number;
      /** Gridline stroke style. Defaults to "solid". */
      gridlineStyle?: "solid" | "dotted" | "dashed";
      /** Draw one gridline every N resolved ticks. Defaults to 1. */
      gridlineEvery?: number;
      tickSize?: number;
      tickThickness?: number;
      /** Multiplier for automatic tick density. 1 is default, >1 greedier, <1 laxer. */
      tickDensity?: number;
      maxTickCount?: number;
      maxLabelCount?: number;
      minLabelGap?: number;
      labelAngle?: number;
      title?: AxisTitleSpec | string;
      subticks?: boolean | number;
      subtickSize?: number;
      numeric?: boolean;
      leftEdgeFade?: boolean;
      labelFormatter?: (value: number) => string;
    }
  | {
      kind: "linear";
      position: "left" | "right" | "bottom";
      domain: readonly [number, number];
      scaleDomain?: readonly [number, number];
      baseDomain?: readonly [number, number];
      timeGranularity?: "auto" | "year" | "month" | "day" | "hour" | "minute" | "second";
      timeZone?: TimeZoneMode;
      timeHasSubMinutePrecision?: boolean;
      tickStepMin?: number;
      nice?: boolean;
      includeBounds?: boolean;
      ticks?: boolean;
      line?: boolean;
      gridlines?: boolean;
      subgridlines?: boolean;
      edgeGridlines?: boolean;
      gridlineThickness?: number;
      /** Gridline stroke style. Defaults to "solid". */
      gridlineStyle?: "solid" | "dotted" | "dashed";
      /** Draw one gridline every N resolved ticks. Defaults to 1. */
      gridlineEvery?: number;
      tickCount?: number;
      /** Multiplier for automatic tick density. 1 is default, >1 greedier, <1 laxer. */
      tickDensity?: number;
      maxTickCount?: number;
      minTickSpacing?: number;
      tickSize?: number;
      tickThickness?: number;
      subticks?: boolean | number;
      subtickSize?: number;
      labelAngle?: number;
      title?: AxisTitleSpec | string;
      leftEdgeFade?: boolean;
      labelFormatter?: (value: number) => string;
    };

export type FrameSpec = {
  stroke?: string;
  plotAreaStroke?: string;
  /** Draw the border around the plot area. Defaults to false. */
  border?: boolean;
  /** Corner radius / border radius of the plot area. */
  cornerRadius?: number;
};

export type TooltipMarker = string | {
  color: string;
  shape?: ScatterPointShape;
};

export type TooltipContent = {
  title?: string;
  titleMarker?: TooltipMarker;
  lines: readonly string[];
  markers?: readonly (TooltipMarker | undefined)[];
};
export type TooltipResult = readonly string[] | TooltipContent;

export type TooltipSpec = {
  position?: "cursor" | "bar-top";
  shadow?: boolean;
  tabularNumbers?: boolean;
  titleFont?: "mono" | "regular";
  titleWeight?: "regular" | "semibold" | "bold";
};

export type FocusMode = "index" | "domain";

export type InteractionSpec = {
  selection?: SelectionSpec | false;
  zoom?: ZoomSpec | false;
  pan?: PanSpec | false;
  hover?: HoverSpec | false;
  focusMode?: FocusMode;
  dragInteraction?: "selection" | "pan";
  scatterHover?: ScatterHoverInteraction | false;
  scatterHoverRadius?: number;
  onFocusChange?: (focus: PlotSelection | undefined, reason: "selection" | "zoom" | "pan" | "clear") => void;
};

export type SelectionSpec = {
  enabled?: boolean;
  mode?: "x" | "xy";
  minPixelSpan?: number;
  fill?: string;
  stroke?: string;
};

export type ZoomSpec = {
  enabled?: boolean;
  mode?: "x" | "xy";
  wheel?: boolean;
  /** Enables two-finger touch pinch zoom. Defaults to true when zoom is enabled. */
  touch?: boolean;
  /** Wheel zoom strength; default ~0.006 (browser ctrl+wheel pinch uses a higher effective value). */
  sensitivity?: number;
  minSpan?: number;
  minPoints?: number;
};

export type PanSpec = {
  enabled?: boolean;
  mode?: "x" | "xy";
  wheel?: boolean;
  drag?: boolean;
  /** Enables one-finger drag pan and two-finger centroid pan on touch devices. Defaults to true. */
  touch?: boolean;
  /** Smoothly preserves partial data windows while panning. Defaults to true. */
  smooth?: boolean;
};

export type GradientFill = {
  stops: readonly { offset: number; color: string }[];
  axis?: "x" | "y";
  bounds?: Rect;
};

export type CornerRadii = readonly [number, number, number, number];

export type RectPaint = {
  fill?: string;
  fillGradient?: GradientFill;
  stroke?: string;
  strokeWidth?: number;
  strokeDash?: readonly number[];
  cornerRadii?: CornerRadii;
};

export type HoverStyle = "none" | "background" | "bar" | "background-and-bar";

export type HoverSpec = {
  enabled?: boolean;
};

export type ScatterPointShape = "circle" | "square" | "diamond" | "triangle" | "star" | "polygon" | "plus" | "cross" | "x";

export type MarkerStyle = {
  fill: string;
  outline?: string;
  outlineWidth?: number;
  strokeWidth?: number;
};

export type ScatterPointStyle = "solid" | "translucent";

export type ScatterHoverInteraction = "none" | "grow" | "crosshair";

export type ScatterHoverEntry = {
  index: number;
  progress: number;
  shrinkStartProgress?: number;
};

export type HoverState = {
  markType: "bar" | "line" | "scatter";
  index: number;
  seriesIndex?: number;
  x?: number;
  y?: number;
  xValue?: number;
  yValue?: number;
};

export type PointCloudHit = {
  index: number;
  x: number;
  y: number;
  radius?: number;
  hitRadius?: number;
  fill?: string;
  shape?: ScatterPointShape;
  tooltip?: TooltipContent;
};

export type PlotSelection = {
  x?: readonly [number, number];
  y?: readonly [number, number];
};

export type Primitive =
  | {
      kind: "path";
      points: readonly [number, number][];
      stroke?: string;
      strokeWidth?: number;
      strokeDash?: readonly number[];
      strokeDashOffset?: number;
      fill?: string;
      clip?: Rect;
      curve?: LineCurve;
      closed?: boolean;
      /**
       * When set with `fill`, the curve applies only to `points` (the top edge).
       * The fill then closes linearly down to this baseline Y — avoids curved
       * overshoot through the area corners (especially with monotone-x).
       */
      areaBaseline?: number;
      /** Opacity applied around the fill via `globalAlpha` (0–1). */
      fillOpacity?: number;
      /** Canvas composite mode used while filling (e.g. multiply / screen). */
      compositeOperation?: GlobalCompositeOperation;
      /**
       * `isolate` draws this fill into a shared offscreen layer so overlapping
       * series cover each other instead of mixing colors, then the layer is
       * blitted at `fillOpacity`.
       */
      areaLayer?: "direct" | "isolate";
    }
  | {
      kind: "circle";
      x: number;
      y: number;
      radius: number;
      fill?: string;
      stroke?: string;
      strokeWidth?: number;
      opacity?: number;
      clip?: Rect;
    }
  | {
    kind: "point-cloud";
    points: Float32Array;
    pointCount?: number;
    radius: number;
    radii?: Float32Array;
      shape?: ScatterPointShape;
      fill?: string;
      categoryIds?: Float32Array;
      categoryPalette?: Float32Array;
      categoryShapes?: Float32Array;
      categoryCount?: number;
      opacity?: number;
      hoverInteraction?: ScatterHoverInteraction;
      hoverGrowRadius?: number;
      hoverOutline?: boolean | string | MarkerStyle;
      hoverCrosshairColor?: string;
      clip?: Rect;
      isRaw?: boolean;
      xDomain?: readonly [number, number];
      yDomain?: readonly [number, number];
      plotArea?: Rect;
      baseRadius?: number;
      radiusScaleConfig?: boolean | {
        maxScale?: number;
        densityTarget?: number;
        gamma?: number;
      } | undefined;
      fullXDomain?: readonly [number, number];
      fullYDomain?: readonly [number, number];
      staticRadius?: number;
      staticOpacity?: number;
      revealOrder?: Float32Array;
      revealProgress?: number;
      revealFade?: boolean;
      revealGrow?: boolean;
      hover?: {
        markType: "scatter";
      };
      hitTest?: (x: number, y: number) => PointCloudHit | undefined;
      lookup?: (index: number) => PointCloudHit | undefined;
    }
  | {
      kind: "rect";
      x: number;
      y: number;
      width: number;
      height: number;
      fill?: string;
      fillGradient?: GradientFill;
      stroke?: string;
      strokeWidth?: number;
      strokeDash?: readonly number[];
      cornerRadii?: CornerRadii;
      tooltip?: TooltipContent;
      tooltipBounds?: Rect;
      tooltipPlacement?: "bar-top" | "bar-end-right" | "bar-end-left";
      hover?: HoverState;
      pixelSnap?: boolean;
      hidden?: boolean;
      clip?: Rect;
      /** Proximity-only line hit test used for click-to-pin interactions. */
      lineFocusHitTest?: (x: number, y: number) => {
        seriesIndex: number;
      } | undefined;
      hitTest?: (x: number, y: number) => {
        index: number;
        tooltip?: TooltipContent | undefined;
        tooltipBounds?: Rect | undefined;
        tooltipPlacement?: "bar-top" | "bar-end-right" | "bar-end-left" | undefined;
        x: number;
        y: number;
        width: number;
        height: number;
        seriesIndex?: number;
        hoverX?: number;
        hoverY?: number;
        hoverXValue?: number;
        hoverYValue?: number;
      } | undefined;
    }
  | {
      kind: "rects";
      rects: readonly Rect[];
      fill?: string;
      fillGradient?: GradientFill;
      stroke?: string;
      strokeWidth?: number;
      strokeDash?: readonly number[];
      cornerRadii?: CornerRadii;
      pixelSnap?: boolean;
      clip?: Rect;
    }
    | {
      kind: "text";
      x: number;
      y: number;
      text: string;
      fill?: string;
      font?: string;
      align?: CanvasTextAlign;
      baseline?: CanvasTextBaseline;
      angle?: number;
      clip?: Rect;
      maxWidth?: number;
      opacity?: number;
    };

export type ResizePreviewTransform = {
  a: number;
  d: number;
  e: number;
  f: number;
};

export type SceneGraph = {
  size: Size;
  plotArea: Rect;
  dataFocusAxis?: "x" | "y";
  hover?: HoverState;
  overlay?: boolean;
  primitives: readonly Primitive[];
  /**
   * During active resize, cached mark primitives are drawn with this canvas
   * transform (or a plot-area bitmap blit). Axes/grid/labels are re-encoded exact.
   */
  resizePreview?: {
    transform: ResizePreviewTransform;
    markPrimitiveStart: number;
    markPrimitiveEnd: number;
    /** Scale the most recently painted frame for one interstitial resize frame. */
    compositorOnly?: boolean;
    /** Keep canvas backing store from shrinking mid-drag to avoid per-frame reallocations. */
    growOnlyCanvas?: boolean;
  };
  resizeTransition?: {
    durationMs: number;
  };
  /** Reuse an oversized backing store while the CSS display size is changing. */
  growOnlyCanvas?: boolean;
  /** Draw raw WebGL into an exact clipped viewport within the retained backing store. */
  liveWebGLResize?: boolean;
  /**
   * Keep the last WebGL point-cloud frame while repainting the 2D axes and chrome.
   * Resize previews may also retain and clip the existing WebGL backing store.
   */
  deferPointCloudDraw?: boolean;
  /** Capture the plot-area pixels for a future resize preview/transition. */
  captureResizeSnapshot?: boolean;
  /** Primitive range containing marks only; excludes frame, grid, and axes. */
  resizeSnapshotRange?: {
    markPrimitiveStart: number;
    markPrimitiveEnd: number;
  };
  edgeBlur?: EdgeBlurState;
  scatterHover?: readonly ScatterHoverEntry[];
};
