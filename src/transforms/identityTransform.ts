import type { Transform } from "./types";

export function identityTransform<TDatum>(): Transform<TDatum> {
  return {
    apply(data) {
      return data;
    }
  };
}
