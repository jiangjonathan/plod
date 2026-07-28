import type { PlotSelection } from "../core/types";

export function resolveFocusRatioRange(
  focus: PlotSelection | undefined,
  axis: "x" | "y" = "x"
): readonly [number, number] | undefined {
  const range = axis === "y" ? (focus?.y ?? focus?.x) : (focus?.x ?? focus?.y);

  if (!range) {
    return undefined;
  }

  const start = clamp01(Math.min(range[0], range[1]));
  const end = clamp01(Math.max(range[0], range[1]));

  if (end - start >= 0.999) {
    return undefined;
  }

  return [start, end];
}

export function resolveFocusIndexRange(
  length: number,
  focus: PlotSelection | undefined,
  snapToIndices: boolean,
  axis?: "x" | "y"
): { start: number; end: number; visibleStart: number; visibleEnd: number } {
  const range = resolveFocusRatioRange(focus, axis);

  if (!range || length <= 1) {
    return { start: 0, end: length, visibleStart: 0, visibleEnd: length };
  }

  const [startRatio, endRatio] = range;
  const visibleStart = startRatio * length;
  const visibleEnd = endRatio * length;

  if (snapToIndices) {
    const rawSpan = Math.max(1, visibleEnd - visibleStart);
    const span = Math.max(1, Math.min(length, Math.round(rawSpan)));
    const center = (visibleStart + visibleEnd) / 2;
    const maxStart = length - span;
    const start = Math.max(0, Math.min(maxStart, Math.round(center - span / 2)));
    const end = start + span;

    return { start, end, visibleStart: start, visibleEnd: end };
  }

  const start = Math.max(0, Math.min(length - 1, Math.floor(visibleStart)));
  const end = Math.max(start + 1, Math.min(length, Math.ceil(visibleEnd)));

  return { start, end, visibleStart, visibleEnd };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
