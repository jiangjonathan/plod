import type { PlotSpec } from "../core/types";
import { lineChart, type LineChartOptions } from "./lineChart";

/**
 * How overlapping series fills combine on area charts.
 *
 * - `blend` — translucent source-over; overlapping colors mix
 * - `cover` — later series cover earlier without muddy mixing (isolated layer)
 * - `multiply` / `screen` — canvas composite modes
 */
export type AreaOverlap = "blend" | "cover" | "multiply" | "screen";

/**
 * Area charts are line charts with a filled baseline.
 *
 * They reuse the line mark pipeline (hover, streaming LOD, focus, signed
 * strokes, etc.) and only change the defaults that make the fill read as an
 * area: monotone curve, slightly thinner stroke, fill-to-zero, and `area: true`.
 */
export type AreaChartOptions<TDatum> = Omit<
  LineChartOptions<TDatum>,
  "area" | "areaFill" | "areaFills" | "areaOpacity" | "areaBaseline" | "areaOverlap" | "areaStroke"
> & {
  /** Single fill color for every series. Falls back to each series stroke. */
  fill?: string;
  /** Per-series fill colors. */
  fills?: readonly string[];
  /** Fill opacity from 0–1. Defaults to `0.22`. */
  opacity?: number;
  /** Where the area closes. Defaults to `"zero"`. */
  baseline?: "plot" | "zero";
  /** How overlapping fills combine. Defaults to `"blend"`. */
  overlap?: AreaOverlap;
  /** Draw the line stroke on top of the fill. Defaults to `true`. */
  showLine?: boolean;
};

export function areaChart<TDatum>(options: AreaChartOptions<TDatum>): PlotSpec<TDatum> {
  const {
    fill,
    fills,
    opacity = 0.22,
    baseline = "zero",
    overlap = "blend",
    showLine = true,
    curve = "monotone-x",
    strokeWidth = 2,
    ...rest
  } = options;

  return lineChart({
    ...rest,
    curve,
    strokeWidth,
    area: true,
    areaOpacity: opacity,
    areaBaseline: baseline,
    areaOverlap: overlap,
    areaStroke: showLine,
    ...(fill !== undefined ? { areaFill: fill } : {}),
    ...(fills !== undefined ? { areaFills: fills } : {})
  });
}
