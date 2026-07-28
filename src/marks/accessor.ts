import type { Accessor } from "./types";

export function readAccessor<TDatum, TValue>(
  accessor: Accessor<TDatum, TValue>,
  datum: TDatum,
  index: number
): TValue {
  if (typeof accessor === "function") {
    return accessor(datum, index);
  }

  return datum[accessor] as TValue;
}
