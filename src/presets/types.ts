import type { PlotSpec } from "../core/types";

export type Preset<TDatum = unknown, TOptions = unknown> = (options: TOptions) => PlotSpec<TDatum>;
