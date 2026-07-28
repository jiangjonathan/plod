export type Transform<TDatum = unknown> = {
  id?: string;
  apply(data: readonly TDatum[]): readonly TDatum[];
};
