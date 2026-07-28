import type { Scale } from "./types";

export type LinearScaleOptions = {
  domain: readonly [number, number];
  range: readonly [number, number];
};

export function linearScale(options: LinearScaleOptions): Scale<number, number> {
  const [domainMin, domainMax] = options.domain;
  const [rangeMin, rangeMax] = options.range;
  const domainSpan = domainMax - domainMin || 1;
  const rangeSpan = rangeMax - rangeMin;

  return {
    map(value) {
      return rangeMin + ((value - domainMin) / domainSpan) * rangeSpan;
    },
    invert(value) {
      return domainMin + ((value - rangeMin) / (rangeSpan || 1)) * domainSpan;
    }
  };
}
