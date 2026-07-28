import type { PlotSelection, Rect, RenderOptimizationSpec } from "../core/types";

export type DataTable<TDatum = unknown> = {
  rows: readonly TDatum[];
};

export type DataInput<TDatum = unknown> = readonly TDatum[] | DataSource<TDatum>;

export type DataSource<TDatum = unknown> = {
  readonly kind: "data-source";
  readonly version: number;
  readonly length?: number;
  /** Incremental Y extent for streaming autoscale without full-dataset scans. */
  readonly yExtent?: readonly [number, number] | undefined;
  /** Incremental X extent for streaming autoscale without full-dataset scans. */
  readonly xExtent?: readonly [number, number] | undefined;
  /** Optional indexed Y extent lookup for autoscaling an X viewport. */
  yExtentForXDomain?(
    xDomain: readonly [number, number],
    hiddenSeries?: ReadonlySet<string | number>
  ): readonly [number, number] | undefined;
  resolve(request: DataSourceResolveRequest): DataSourceView<TDatum>;
  subscribe?(listener: () => void): () => void;
};

export type DataSourceResolveRequest = {
  focus?: PlotSelection;
  xDomain?: readonly [number, number];
  yDomain?: readonly [number, number];
  plotArea: Rect;
  renderDistance: Required<RenderOptimizationSpec>;
  snapToIndices?: boolean;
  includeContinuityPoints?: boolean;
  dataFocusAxis?: "x" | "y";
};

export type DataSourceView<TDatum = unknown> = {
  data: readonly TDatum[];
  domain?: {
    x: readonly [number, number];
    startIndex: number;
    endIndex: number;
    visibleStart: number;
    visibleEnd: number;
    visibleX?: readonly [number, number];
    timeHasSubMinutePrecision?: boolean;
    totalLength: number;
  };
};

export type ColumnSummary = {
  name: string;
  type: "number" | "string" | "date" | "boolean" | "unknown";
};
