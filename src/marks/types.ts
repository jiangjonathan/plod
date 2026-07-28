import type { Primitive } from "../core/types";
import type { Layout } from "../layout/types";
import type { Theme } from "../themes/types";

export type Accessor<TDatum, TValue> = keyof TDatum | ((datum: TDatum, index: number) => TValue);

export type MarkKind = "bar" | "line" | "scatter" | "point";

export type Mark<TDatum = unknown> = {
  id?: string;
  kind?: MarkKind;
  encode(data: readonly TDatum[], layout: Layout, theme: Theme): readonly Primitive[];
};
