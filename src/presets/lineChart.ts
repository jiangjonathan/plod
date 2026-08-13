import type { AxesOverrideSpec, EdgeBlurSpec, LineCurve, PanSpec, PlotSpec, SelectionSpec, TitleAnimationProfile, TooltipResult, TooltipSpec, ZoomSpec } from "../core/types";
import { cartesianLinearAxes } from "../axes/builders";
import { lineMark, type LineHoverGuide, type LineHoverGuideStyle } from "../marks/lineMark";
import type { Accessor } from "../marks/types";
import type { DataInput } from "../data/types";

export type LineChartOptions<TDatum> = {
  data: DataInput<TDatum>;
  x: Accessor<TDatum, number>;
  y: Accessor<TDatum, number>;
  series?: Accessor<TDatum, string | number>;
  seriesOrder?: readonly (string | number)[];
  yDomain?: readonly [number, number];
  strokes?: readonly string[];
  signedStrokes?: {
    positive: string;
    negative: string;
  };
  curve?: LineCurve;
  area?: boolean;
  areaFill?: string;
  areaFills?: readonly string[];
  areaOpacity?: number;
  areaBaseline?: "plot" | "zero";
  areaOverlap?: "blend" | "cover" | "multiply" | "screen";
  areaStroke?: boolean;
  strokeWidth?: number;
  tooltip?: boolean | ((datum: TDatum, index: number) => TooltipResult);
  tooltipVisibleOnly?: boolean;
  lineFocus?: boolean;
  hoverGuide?: LineHoverGuide;
  hoverGuideStyle?: LineHoverGuideStyle;
  axes?: boolean | AxesOverrideSpec;
  timeAxis?: boolean | "auto" | "year" | "month" | "day" | "hour" | "minute" | "second";
  yAxisPosition?: "left" | "right";
  timeZone?: PlotSpec["timeZone"];
  selection?: SelectionSpec | false;
  zoom?: ZoomSpec | false;
  pan?: PanSpec | false;
  dragInteraction?: "selection" | "pan";
  tooltipPosition?: TooltipSpec["position"];
  tooltipShadow?: boolean;
  tooltipTabularNumbers?: boolean;
  tooltipTitleFont?: "mono" | "regular";
  tooltipTitleWeight?: "regular" | "semibold" | "bold";
  frame?: boolean;
  border?: boolean;
  edgeBlur?: boolean | EdgeBlurSpec;
  width?: number;
  height?: number;
  startEmpty?: boolean;
  titleAnimation?: TitleAnimationProfile;
};

export function lineChart<TDatum>(options: LineChartOptions<TDatum>): PlotSpec<TDatum> {
  const spec: PlotSpec<TDatum> = {
    data: options.data,
    marks: [lineMark({
      x: options.x,
      y: options.y,
      ...(options.series !== undefined ? { series: options.series } : {}),
      ...(options.seriesOrder !== undefined ? { seriesOrder: options.seriesOrder } : {}),
      ...(options.yDomain !== undefined ? { yDomain: options.yDomain } : {}),
      ...(options.strokes !== undefined ? { strokes: options.strokes } : {}),
      ...(options.signedStrokes !== undefined ? { signedStrokes: options.signedStrokes } : {}),
      ...(options.strokeWidth !== undefined ? { strokeWidth: options.strokeWidth } : {}),
      ...(options.curve !== undefined ? { curve: options.curve } : {}),
      ...(options.area !== undefined ? { area: options.area } : {}),
      ...(options.areaFill !== undefined ? { areaFill: options.areaFill } : {}),
      ...(options.areaFills !== undefined ? { areaFills: options.areaFills } : {}),
      ...(options.areaOpacity !== undefined ? { areaOpacity: options.areaOpacity } : {}),
      ...(options.areaBaseline !== undefined ? { areaBaseline: options.areaBaseline } : {}),
      ...(options.areaOverlap !== undefined ? { areaOverlap: options.areaOverlap } : {}),
      ...(options.areaStroke !== undefined ? { areaStroke: options.areaStroke } : {}),
      ...(options.tooltip !== undefined ? { tooltip: options.tooltip } : {}),
      ...(options.tooltipVisibleOnly !== undefined ? { tooltipVisibleOnly: options.tooltipVisibleOnly } : {}),
      ...(options.lineFocus !== undefined ? { lineFocus: options.lineFocus } : {}),
      ...(options.hoverGuide !== undefined ? { hoverGuide: options.hoverGuide } : {}),
      ...(options.hoverGuideStyle !== undefined ? { hoverGuideStyle: options.hoverGuideStyle } : {})
    })]
  };
  if (options.timeZone !== undefined) spec.timeZone = options.timeZone;
  spec.presetOptions = options;
  if (options.startEmpty !== undefined) {
    spec.startEmpty = options.startEmpty;
  }
  if (options.titleAnimation !== undefined) {
    spec.titleAnimation = options.titleAnimation;
  }

  if (options.axes !== false) {
    spec.axes = (data) => {
      const currentOpts = spec.presetOptions ?? options;
      const resolved = cartesianLinearAxes({
        data,
        x: currentOpts.x,
        y: currentOpts.y,
        ...(currentOpts.yDomain !== undefined ? { yDomain: currentOpts.yDomain } : {}),
        ...(currentOpts.timeAxis !== undefined ? { timeAxis: currentOpts.timeAxis } : {}),
        ...(currentOpts.yAxisPosition !== undefined ? { yAxisPosition: currentOpts.yAxisPosition } : {}),
        series: currentOpts.series,
        hiddenSeries: spec.hiddenSeries
      });

      const customAxes = (currentOpts.axes && typeof currentOpts.axes === "object") ? currentOpts.axes : {};
      if (resolved.x && customAxes.x) {
        resolved.x = { ...resolved.x, ...customAxes.x };
      }
      if (resolved.y && customAxes.y) {
        resolved.y = { ...resolved.y, ...customAxes.y };
      }

      return resolved;
    };
  }

  if (
    options.tooltipPosition !== undefined ||
    options.tooltipShadow !== undefined ||
    options.tooltipTabularNumbers !== undefined ||
    options.tooltipTitleFont !== undefined ||
    options.tooltipTitleWeight !== undefined
  ) {
    spec.tooltip = {
      ...(options.tooltipPosition !== undefined ? { position: options.tooltipPosition } : {}),
      ...(options.tooltipShadow !== undefined ? { shadow: options.tooltipShadow } : {}),
      tabularNumbers: options.tooltipTabularNumbers !== false,
      ...(options.tooltipTitleFont !== undefined ? { titleFont: options.tooltipTitleFont } : {}),
      ...(options.tooltipTitleWeight !== undefined ? { titleWeight: options.tooltipTitleWeight } : {})
    };
  }

  if (options.selection !== undefined) {
    spec.interactions = { ...spec.interactions, selection: options.selection };
  }

  if (options.zoom !== undefined) {
    spec.interactions = { ...spec.interactions, zoom: resolveLineZoom(options.zoom) };
  }

  if (options.pan !== undefined) {
    spec.interactions = { ...spec.interactions, pan: options.pan };
  }

  if (options.dragInteraction !== undefined) {
    spec.interactions = { ...spec.interactions, dragInteraction: options.dragInteraction };
  }

  if (options.frame === false) {
    spec.frame = false;
  } else if (options.border !== undefined) {
    spec.frame = { border: options.border };
  }
  if (options.edgeBlur !== undefined) spec.edgeBlur = options.edgeBlur;
  if (options.width !== undefined) spec.width = options.width;
  if (options.height !== undefined) spec.height = options.height;

  return spec;
}

function resolveLineZoom(zoom: ZoomSpec | false): ZoomSpec | false {
  if (zoom === false) {
    return false;
  }

  return {
    ...zoom,
    minPoints: zoom.minPoints ?? 3
  };
}
