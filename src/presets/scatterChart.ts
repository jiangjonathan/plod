import type {
  PanSpec,
  PlotSpec,
  AxesOverrideSpec,
  MarkerStyle,
  ScatterHoverInteraction,
  ScatterPointShape,
  ScatterPointStyle,
  SelectionSpec,
  TitleAnimationProfile,
  TooltipResult,
  TooltipSpec,
  ZoomSpec,
} from "../core/types";
import { cartesianLinearAxes } from "../axes/builders";
import { scatterMark, type ScatterMarkOptions } from "../marks/scatterMark";
import type { Accessor } from "../marks/types";
import type { DataInput } from "../data/types";

export type ScatterChartOptions<TDatum> = {
  data: DataInput<TDatum>;
  x: Accessor<TDatum, number>;
  y: Accessor<TDatum, number>;
  xDomain?: readonly [number, number];
  yDomain?: readonly [number, number];
  radius?: number;
  radiusScale?:
    | boolean
    | {
        maxScale?: number;
        densityTarget?: number;
        gamma?: number;
      };
  hitRadius?: number;
  size?: Accessor<TDatum, number>;
  sizeDomain?: readonly [number, number];
  radiusRange?: readonly [number, number];
  fill?: string;
  category?: Accessor<TDatum, string | number | undefined>;
  opacity?: number;
  pointStyle?: ScatterPointStyle;
  shape?: ScatterPointShape;
  /** When false, every category uses `shape` (default circle) instead of mixed glyphs. */
  varyCategoryShapes?: boolean;
  hoverInteraction?: ScatterHoverInteraction;
  hoverGrowRadius?: number;
  hoverOutline?: boolean | string | MarkerStyle;
  tooltip?: boolean | ((datum: TDatum, index: number) => TooltipResult);
  selection?: SelectionSpec | false;
  zoom?: ZoomSpec | false;
  pan?: PanSpec | false;
  dragInteraction?: "selection" | "pan";
  tooltipPosition?: TooltipSpec["position"];
  tooltipShadow?: boolean;
  tooltipTabularNumbers?: boolean;
  axes?: boolean | AxesOverrideSpec;
  yAxisPosition?: "left" | "right";
  frame?: boolean;
  border?: boolean;
  resizeTransition?: boolean | {
    durationMs?: number;
  };
  width?: number;
  height?: number;
  startEmpty?: boolean;
  titleAnimation?: TitleAnimationProfile;
};

export function scatterChart<TDatum>(
  options: ScatterChartOptions<TDatum>,
): PlotSpec<TDatum> {
  const markOptions: ScatterMarkOptions<TDatum> = {
    x: options.x,
    y: options.y,
  };

  if (options.xDomain !== undefined) markOptions.xDomain = options.xDomain;
  if (options.yDomain !== undefined) markOptions.yDomain = options.yDomain;
  if (options.radius !== undefined) markOptions.radius = options.radius;
  if (options.radiusScale !== undefined)
    markOptions.radiusScale = options.radiusScale;
  if (options.hitRadius !== undefined)
    markOptions.hitRadius = options.hitRadius;
  if (options.size !== undefined) markOptions.size = options.size;
  if (options.sizeDomain !== undefined)
    markOptions.sizeDomain = options.sizeDomain;
  if (options.radiusRange !== undefined)
    markOptions.radiusRange = options.radiusRange;
  if (options.fill !== undefined) markOptions.fill = options.fill;
  if (options.category !== undefined) markOptions.category = options.category;
  if (options.opacity !== undefined) markOptions.opacity = options.opacity;
  if (options.pointStyle !== undefined) markOptions.pointStyle = options.pointStyle;
  if (options.shape !== undefined) markOptions.shape = options.shape;
  if (options.varyCategoryShapes !== undefined) markOptions.varyCategoryShapes = options.varyCategoryShapes;
  if (options.hoverInteraction !== undefined) markOptions.hoverInteraction = options.hoverInteraction;
  if (options.hoverGrowRadius !== undefined) markOptions.hoverGrowRadius = options.hoverGrowRadius;
  if (options.hoverOutline !== undefined) markOptions.hoverOutline = options.hoverOutline;
  if (options.tooltip !== undefined) markOptions.tooltip = options.tooltip;

  const spec: PlotSpec<TDatum> = {
    data: options.data,
    marks: [scatterMark(markOptions)],
    optimization: {
      enabled: true,
      pointCellSize: 5,
    },
    interactions: {
      focusMode: "domain",
      scatterHover: options.hoverInteraction ?? "grow",
      scatterHoverRadius: options.hoverGrowRadius ?? 7,
    },
    resizeTransition: options.resizeTransition === false
      ? false
      : typeof options.resizeTransition === "object" && options.resizeTransition.durationMs !== undefined
        ? { durationMs: options.resizeTransition.durationMs }
        : { durationMs: 300 },
  };
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
        ...(currentOpts.xDomain !== undefined ? { xDomain: currentOpts.xDomain } : {}),
        ...(currentOpts.yDomain !== undefined ? { yDomain: currentOpts.yDomain } : {}),
        ...(currentOpts.yAxisPosition !== undefined ? { yAxisPosition: currentOpts.yAxisPosition } : {}),
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
    options.tooltipTabularNumbers !== undefined
  ) {
    spec.tooltip = {
      ...(options.tooltipPosition !== undefined ? { position: options.tooltipPosition } : {}),
      ...(options.tooltipShadow !== undefined ? { shadow: options.tooltipShadow } : {}),
      tabularNumbers: options.tooltipTabularNumbers !== false
    };
  }

  if (options.selection !== undefined) {
    spec.interactions = { ...spec.interactions, selection: options.selection };
  }

  if (options.zoom !== undefined) {
    spec.interactions = {
      ...spec.interactions,
      zoom: resolveScatterZoom(options.zoom),
    };
  }

  if (options.pan !== undefined) {
    spec.interactions = {
      ...spec.interactions,
      pan: resolveScatterPan(options.pan),
    };
  }

  if (options.dragInteraction !== undefined) {
    spec.interactions = {
      ...spec.interactions,
      dragInteraction: options.dragInteraction,
    };
  }

  if (options.frame === false) {
    spec.frame = false;
  } else if (options.border !== undefined) {
    spec.frame = { border: options.border };
  }
  if (options.width !== undefined) spec.width = options.width;
  if (options.height !== undefined) spec.height = options.height;

  return spec;
}

function resolveScatterPan(pan: PanSpec | false): PanSpec | false {
  if (pan === false) {
    return false;
  }

  return {
    ...pan,
    wheel: false,
  };
}

function resolveScatterZoom(zoom: ZoomSpec | false): ZoomSpec | false {
  if (zoom === false) {
    return false;
  }

  return {
    mode: "xy",
    ...zoom,
    minPoints: zoom.minPoints ?? 16,
  };
}
