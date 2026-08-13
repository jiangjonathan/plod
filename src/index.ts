export { createPlot } from "./core/createPlot";
export { buildPlot, plot, PlotBuilder } from "./core/builder";
export type {
  Plot,
  AnimationOptions,
  AnimationProfile,
  AnimationEasing,
  LineCurve,
  PlotSpec,
  PlotUpdate,
  PlotSelection,
  Size,
  Rect,
  AxesSpec,
  AxesOverrideSpec,
  AxisSpec,
  AxisSpecResolver,
  FrameSpec,
  RenderOptimizationSpec,
  InteractionSpec,
  FocusMode,
  SelectionSpec,
  ZoomSpec,
  PanSpec,
  HoverSpec,
  HoverState,
  HoverStyle,
  MarkerStyle,
  ScatterHoverInteraction,
  ScatterPointShape,
  ScatterPointStyle,
  TooltipSpec,
  Primitive,
  SceneGraph
} from "./core/types";

export type { Renderer } from "./renderers/types";
export { canvasRenderer } from "./renderers/canvasRenderer";

export type { Mark } from "./marks/types";
export { barMark } from "./marks/barMark";
export type { BarAppearance, BarFillMode, BarLayoutMode, BarOutlineStyle, BarValueLabelOptions } from "./marks/barMark";
export { lineMark } from "./marks/lineMark";
export type { LineHoverGuide, LineHoverGuideStyle, LineMarkOptions } from "./marks/lineMark";
export { pointMark } from "./marks/pointMark";
export { scatterMark } from "./marks/scatterMark";
export type { ScatterMarkOptions } from "./marks/scatterMark";
export { linearScale } from "./scales/linearScale";

export type { Transform } from "./transforms/types";
export { identityTransform } from "./transforms/identityTransform";

export type {
  DataInput,
  DataSource,
  DataSourceResolveRequest,
  DataSourceView
} from "./data/types";
export type {
  LodPoint,
  LodPointInput,
  LodSeries,
  LodSeriesMode,
  LodSeriesOptions
} from "./data/lodSeries";
export { createLodSeries } from "./data/lodSeries";
export type {
  ScatterSeries,
  ScatterSeriesOptions
} from "./data/scatterSeries";
export { createScatterSeries } from "./data/scatterSeries";
export type {
  GroupedBarLodMode,
  GroupedBarPoint,
  GroupedBarSeries,
  GroupedBarSeriesOptions,
  BarSeriesLayout
} from "./data/groupedBarSeries";
export { createGroupedBarSeries } from "./data/groupedBarSeries";

export type { Preset } from "./presets/types";
export { barChart } from "./presets/barChart";
export { lineChart } from "./presets/lineChart";
export { areaChart } from "./presets/areaChart";
export type { AreaChartOptions, AreaOverlap } from "./presets/areaChart";
export { scatterChart } from "./presets/scatterChart";

export type { Scale } from "./scales/types";
export {
  bandBottomAxis,
  bandLeftAxis,
  linearAxis,
  barAxes,
  cartesianLinearAxes
} from "./axes/builders";

export type { Theme } from "./themes/types";
export { defaultTheme, SYSTEM_FONT_FAMILY, SYSTEM_MONO_FONT_FAMILY } from "./themes/defaultTheme";
