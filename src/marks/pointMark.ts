import type { Primitive } from "../core/types";
import type { Accessor, Mark } from "./types";
import { readAccessor } from "./accessor";

export type PointMarkOptions<TDatum> = {
  x: Accessor<TDatum, number>;
  y: Accessor<TDatum, number>;
  radius?: number;
  fill?: string;
};

export function pointMark<TDatum>(options: PointMarkOptions<TDatum>): Mark<TDatum> {
  return {
    encode(data, layout, theme): readonly Primitive[] {
      const fill = options.fill ?? theme.palette.series[0] ?? theme.palette.foreground;

      return data.map<Primitive>((datum, index) => ({
        kind: "circle",
        x: layout.plotArea.x + readAccessor(options.x, datum, index),
        y: layout.plotArea.y + layout.plotArea.height - readAccessor(options.y, datum, index),
        radius: options.radius ?? 3,
        fill
      }));
    }
  };
}
