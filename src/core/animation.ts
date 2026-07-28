import type { AnimationOptions, AxisAnimationProfile } from "./types";

export const ORIGIN_EXTEND_TICK_ANIM_MS = 150;

export function usesLineTriggeredAxisTicks(profile: AxisAnimationProfile): boolean {
  return profile === "origin-extend" || profile === "domain-expansion";
}

export function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

export function easeInCubic(t: number): number {
  return t ** 3;
}

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t ** 3 : 1 - ((-2 * t + 2) ** 3) / 2;
}

export function easeInOutSine(t: number): number {
  return -(Math.cos(Math.PI * t) - 1) / 2;
}

export function resolveAnimationEasing(
  easing: AnimationOptions["easing"] | undefined,
  profile: AnimationOptions["profile"]
): (t: number) => number {
  if (typeof easing === "function") {
    return easing;
  }

  const resolved = easing ?? (profile === "draw-left" || profile === "draw-right" ? "ease-in-out-cubic" : "ease-out-cubic");

  if (resolved === "linear") return (t) => t;
  if (resolved === "ease-in-out-cubic") return easeInOutCubic;
  if (resolved === "ease-in-out-sine") return easeInOutSine;

  return easeOutCubic;
}

export function resolveElapsedForProgress(
  targetProgress: number,
  durationMs: number,
  easing: (t: number) => number
): number {
  const target = Math.max(0, Math.min(1, targetProgress));

  if (target <= 0) {
    return 0;
  }

  if (target >= 1) {
    return durationMs;
  }

  let lo = 0;
  let hi = 1;

  for (let index = 0; index < 24; index += 1) {
    const mid = (lo + hi) / 2;

    if (easing(mid) < target) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  return ((lo + hi) / 2) * durationMs;
}

export function resolveOriginExtendTickProgress(
  posRatio: number,
  lineProgress: number,
  elapsedMs: number,
  lineDurationMs: number,
  tickAnimMs: number,
  lineEasing: (t: number) => number,
  isLast?: boolean
): number {
  // If this is the final tick of the axis, trigger early when the line is at 97%
  // of the tick's position to avoid a delayed animation finish.
  const triggerRatio = isLast ? posRatio * 0.97 : posRatio;

  if (lineProgress < triggerRatio) {
    return 0;
  }

  const triggerMs = resolveElapsedForProgress(triggerRatio, lineDurationMs, lineEasing);

  return Math.max(0, Math.min(1, (elapsedMs - triggerMs) / tickAnimMs));
}
