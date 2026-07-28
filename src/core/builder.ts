import { createPlot } from "./createPlot";
import type { Plot, PlotSpec, ZoomSpec, PanSpec, SelectionSpec, AxesOverrideSpec } from "./types";
import { scatterChart, type ScatterChartOptions } from "../presets/scatterChart";
import { lineChart, type LineChartOptions } from "../presets/lineChart";
import { barChart, type BarChartOptions } from "../presets/barChart";
import { areaChart, type AreaChartOptions } from "../presets/areaChart";
import type { DataInput } from "../data/types";

export class PlotBuilder<TDatum = any> {
  private container: Element;
  private baseOptions: any = {};
  private finalSpecModifier?: (spec: PlotSpec<TDatum>) => void;

  constructor(container: Element | string) {
    if (typeof container === "string") {
      const el = document.querySelector(container);
      if (!el) throw new Error(`Container not found: ${container}`);
      this.container = el;
    } else {
      this.container = container;
    }
  }

  /** Set the primary data source (Array or DataSource) */
  data(data: DataInput<TDatum>): this {
    this.baseOptions.data = data;
    return this;
  }

  /** Set manual chart dimensions */
  size(width: number, height: number): this {
    this.baseOptions.width = width;
    this.baseOptions.height = height;
    return this;
  }

  /** Define interactions like zooming and panning */
  interactions(opts: {
    zoom?: ZoomSpec | boolean;
    pan?: PanSpec | boolean;
    selection?: SelectionSpec | false;
    dragInteraction?: "selection" | "pan";
    hoverInteraction?: any;
    focusMode?: "index" | "domain";
  }): this {
    Object.assign(this.baseOptions, opts);
    return this;
  }

  /** Configure axes properties */
  axes(opts: AxesOverrideSpec | boolean): this {
    this.baseOptions.axes = opts;
    return this;
  }

  /** Configure tooltip behavior and formatting */
  tooltip(opts: {
    position?: "cursor" | "bar-top";
    shadow?: boolean;
    tabularNumbers?: boolean;
    titleFont?: "mono" | "regular";
    format?: (datum: TDatum, index: number) => any;
  }): this {
    if (opts.position !== undefined) this.baseOptions.tooltipPosition = opts.position;
    if (opts.shadow !== undefined) this.baseOptions.tooltipShadow = opts.shadow;
    if (opts.tabularNumbers !== undefined) this.baseOptions.tooltipTabularNumbers = opts.tabularNumbers;
    if (opts.titleFont !== undefined) this.baseOptions.tooltipTitleFont = opts.titleFont;
    if (opts.format !== undefined) this.baseOptions.tooltip = opts.format;
    return this;
  }

  /** Modify the generated PlotSpec directly before createPlot is called */
  modifySpec(modifier: (spec: PlotSpec<TDatum>) => void): this {
    this.finalSpecModifier = modifier;
    return this;
  }

  /** Build a Scatter Chart */
  scatter(opts: Omit<ScatterChartOptions<TDatum>, "data"> & { data?: any }): Plot<TDatum> {
    const spec = scatterChart({ ...this.baseOptions, ...opts } as ScatterChartOptions<TDatum>);
    if (this.finalSpecModifier) this.finalSpecModifier(spec);
    return createPlot(this.container, spec);
  }

  /** Build a Line Chart */
  line(opts: Omit<LineChartOptions<TDatum>, "data"> & { data?: any }): Plot<TDatum> {
    const spec = lineChart({ ...this.baseOptions, ...opts } as LineChartOptions<TDatum>);
    if (this.finalSpecModifier) this.finalSpecModifier(spec);
    return createPlot(this.container, spec);
  }

  /** Build a Bar Chart */
  bar(opts: Omit<BarChartOptions<TDatum>, "data"> & { data?: any }): Plot<TDatum> {
    const spec = barChart({ ...this.baseOptions, ...opts } as BarChartOptions<TDatum>);
    if (this.finalSpecModifier) this.finalSpecModifier(spec);
    return createPlot(this.container, spec);
  }

  /** Build an Area Chart */
  area(opts: Omit<AreaChartOptions<TDatum>, "data"> & { data?: any }): Plot<TDatum> {
    const spec = areaChart({ ...this.baseOptions, ...opts } as AreaChartOptions<TDatum>);
    if (this.finalSpecModifier) this.finalSpecModifier(spec);
    return createPlot(this.container, spec);
  }
}

/** 
 * Create a new fluent chart builder. 
 * @example
 * buildPlot("#chart")
 *   .data(mySeries)
 *   .interactions({ zoom: { mode: 'xy' } })
 *   .scatter({ x: 'x', y: 'y', shape: 'circle' });
 */
export function buildPlot<TDatum = any>(container: Element | string): PlotBuilder<TDatum> {
  return new PlotBuilder<TDatum>(container);
}

/** Create a typed chart builder with its data already attached. */
export function plot<TDatum>(container: Element | string, data: DataInput<TDatum>): PlotBuilder<TDatum> {
  return new PlotBuilder<TDatum>(container).data(data);
}
