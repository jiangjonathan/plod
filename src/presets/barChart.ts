import type { AxesOverrideSpec, EdgeBlurSpec, HoverStyle, PanSpec, PlotSpec, SelectionSpec, TitleAnimationProfile, TooltipResult, TooltipSpec, ZoomSpec } from "../core/types";
import { barAxes } from "../axes/builders";
import {
  barMark,
  DEFAULT_BAR_GAP_RATIO,
  type BarAppearance,
  type BarLayoutMode,
  type BarMarkOptions,
  type BarValueLabelOptions
} from "../marks/barMark";
import type { Accessor } from "../marks/types";
import type { DataInput } from "../data/types";

/** Default bar corner radius ratio. Keep in sync with settings UI. */
export const DEFAULT_BAR_CORNER_RADIUS_RATIO = 0.22;
export { DEFAULT_BAR_GAP_RATIO };

export type BarChartOptions<TDatum> = {
  data: DataInput<TDatum>;
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
  tooltipPosition?: TooltipSpec["position"];
  tooltipShadow?: boolean;
  tooltipTabularNumbers?: boolean;
  tooltipTitleFont?: "mono" | "regular";
  tooltipTitleWeight?: "regular" | "semibold" | "bold";
  hoverStyle?: HoverStyle;
  orientation?: "vertical" | "horizontal";
  yAxisPosition?: "left" | "right";
  selection?: SelectionSpec | false;
  zoom?: ZoomSpec | false;
  pan?: PanSpec | false;
  dragInteraction?: "selection" | "pan";
  timeAxis?: boolean | "auto" | "year" | "month" | "day" | "hour" | "minute" | "second";
  timeZone?: PlotSpec["timeZone"];
  axes?: boolean | AxesOverrideSpec;
  frame?: boolean;
  border?: boolean;
  edgeBlur?: boolean | EdgeBlurSpec;
  width?: number;
  height?: number;
  startEmpty?: boolean;
  titleAnimation?: TitleAnimationProfile;
};

export function barChart<TDatum>(options: BarChartOptions<TDatum>): PlotSpec<TDatum> {
  const markOptions: BarMarkOptions<TDatum> = {
    x: options.x,
    y: options.y
  };

  if (options.series !== undefined) markOptions.series = options.series;
  if (options.stack !== undefined) markOptions.stack = options.stack;
  if (options.stackGroup !== undefined) markOptions.stackGroup = options.stackGroup;
  if (options.seriesOrder !== undefined) markOptions.seriesOrder = options.seriesOrder;
  if (options.fill !== undefined) markOptions.fill = options.fill;
  if (options.fills !== undefined) markOptions.fills = options.fills;
  markOptions.appearance = {
    cornerRadiusRatio: DEFAULT_BAR_CORNER_RADIUS_RATIO,
    ...(options.appearance ?? {})
  };
  if (options.gapRatio !== undefined) markOptions.gapRatio = options.gapRatio;
  if (options.interBarGapRatio !== undefined) markOptions.interBarGapRatio = options.interBarGapRatio;
  if (options.interGroupGapRatio !== undefined) markOptions.interGroupGapRatio = options.interGroupGapRatio;
  if (options.layout !== undefined) markOptions.layout = options.layout;
  if (options.stacked !== undefined) markOptions.stacked = options.stacked;
  if (options.stackTotalTooltip !== undefined) markOptions.stackTotalTooltip = options.stackTotalTooltip;
  if (options.dynamicGap !== undefined) markOptions.dynamicGap = options.dynamicGap;
  if (options.dynamicGapStrength !== undefined) markOptions.dynamicGapStrength = options.dynamicGapStrength;
  if (options.domainMin !== undefined) markOptions.domainMin = options.domainMin;
  if (options.domainMax !== undefined) markOptions.domainMax = options.domainMax;
  if (options.minBarWidth !== undefined) markOptions.minBarWidth = options.minBarWidth;
  if (options.minGapWidth !== undefined) markOptions.minGapWidth = options.minGapWidth;
  if (options.tooltip !== undefined) markOptions.tooltip = options.tooltip;
  if (options.valueLabels !== undefined) markOptions.valueLabels = options.valueLabels;
  if (options.hoverStyle !== undefined) markOptions.hoverStyle = options.hoverStyle;
  if (options.orientation !== undefined) markOptions.orientation = options.orientation;

  const spec: PlotSpec<TDatum> = {
    data: options.data,
    marks: [barMark(markOptions)]
  };
  if (options.timeZone !== undefined) spec.timeZone = options.timeZone;
  spec.presetOptions = options;
  if (options.startEmpty !== undefined) {
    spec.startEmpty = options.startEmpty;
  }
  if (options.titleAnimation !== undefined) {
    spec.titleAnimation = options.titleAnimation;
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
    spec.interactions = { ...spec.interactions, zoom: options.zoom };
  }

  spec.interactions = {
    ...spec.interactions,
    pan: resolveBarPan(options.pan)
  };

  if (options.dragInteraction !== undefined) {
    spec.interactions = { ...spec.interactions, dragInteraction: options.dragInteraction };
  }

  if (options.hoverStyle === "none") {
    spec.interactions = { ...spec.interactions, hover: false };
  }

  if (options.axes !== false) {
    spec.axes = (data) => {
      const currentOpts = spec.presetOptions ?? options;
      const axesOptions = {
        data,
        x: currentOpts.x,
        y: currentOpts.y,
        ...(currentOpts.series !== undefined ? { series: currentOpts.series } : {}),
        ...(currentOpts.stack !== undefined ? { stack: currentOpts.stack } : {}),
        ...(currentOpts.stackGroup !== undefined ? { stackGroup: currentOpts.stackGroup } : {}),
        ...(currentOpts.layout !== undefined ? { layout: currentOpts.layout } : {}),
        ...(currentOpts.stacked !== undefined ? { stacked: currentOpts.stacked } : {}),
        ...(currentOpts.domainMin !== undefined ? { domainMin: currentOpts.domainMin } : {}),
        ...(currentOpts.orientation !== undefined ? { orientation: currentOpts.orientation } : {}),
        ...(currentOpts.yAxisPosition !== undefined ? { yAxisPosition: currentOpts.yAxisPosition } : {}),
        ...(currentOpts.timeAxis !== undefined ? { timeAxis: currentOpts.timeAxis } : {})
      };

      const resolved = currentOpts.domainMin === undefined && currentOpts.domainMax === undefined
        ? barAxes(axesOptions)
        : barAxes({
            ...axesOptions,
            ...(currentOpts.domainMin !== undefined ? { domainMin: currentOpts.domainMin } : {}),
            ...(currentOpts.domainMax !== undefined ? { domainMax: currentOpts.domainMax } : {})
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

function resolveBarPan(pan: PanSpec | false | undefined): PanSpec | false {
  if (pan === false) {
    return false;
  }

  return {
    mode: "x",
    smooth: true,
    ...(pan ?? {})
  };
}
