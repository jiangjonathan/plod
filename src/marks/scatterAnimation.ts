import type { AnimationProfile, Primitive, Rect } from "../core/types";

/** Fraction of [0, 1] progress over which revealOrder is mapped (1 = last point at progress 1). */
export const SCATTER_REVEAL_STAGGER = 1;
/** Per-point fade-in window as a fraction of total reveal progress. */
export const SCATTER_REVEAL_FADE_WINDOW = 0.38;

export type ScatterAnimationState = {
  radius: number;
  opacity: number;
  clip: Rect;
  revealProgress?: number;
};

export function buildScatterRevealOrder(pointCount: number): Float32Array {
  const order = new Float32Array(pointCount);

  for (let index = 0; index < pointCount; index += 1) {
    order[index] = scatterRevealOrder01(index, pointCount);
  }

  return order;
}

function scatterRevealOrder01(index: number, count: number): number {
  let hash = Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(count, 0x85ebca6b);
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  hash ^= hash >>> 16;

  return (hash >>> 0) / 4294967296;
}

export function resolveAnimatedScatterState(options: {
  staticRadius: number;
  staticOpacity: number;
  profile: AnimationProfile | undefined;
  progress: number;
  plotArea: Rect;
  clipArea?: Rect;
}): ScatterAnimationState {
  const progress = clamp01(options.progress);
  const baseClip = options.clipArea ?? options.plotArea;

  if (!options.profile || progress >= 1) {
    return {
      radius: options.staticRadius,
      opacity: options.staticOpacity,
      clip: baseClip
    };
  }

  if (options.profile === "rise") {
    return {
      radius: options.staticRadius * progress,
      opacity: options.staticOpacity * progress,
      clip: baseClip
    };
  }

  if (options.profile === "draw-left") {
    const revealRight = options.plotArea.x + options.plotArea.width * progress;
    const right = Math.min(baseClip.x + baseClip.width, revealRight);

    return {
      radius: options.staticRadius,
      opacity: options.staticOpacity,
      clip: {
        ...baseClip,
        width: Math.max(0, right - baseClip.x)
      }
    };
  }

  if (options.profile === "draw-right") {
    const revealLeft = options.plotArea.x + options.plotArea.width * (1 - progress);
    const left = Math.max(baseClip.x, revealLeft);

    return {
      radius: options.staticRadius,
      opacity: options.staticOpacity,
      clip: {
        ...baseClip,
        x: left,
        width: Math.max(0, baseClip.x + baseClip.width - left)
      }
    };
  }

  if (options.profile === "random-fill" || options.profile === "random-fill-grow") {
    return {
      radius: options.staticRadius,
      opacity: options.staticOpacity,
      clip: baseClip,
      revealProgress: progress
    };
  }

  return {
    radius: options.staticRadius,
    opacity: options.staticOpacity,
    clip: baseClip
  };
}

export function patchScatterPointCloudAnimation(
  primitive: Extract<Primitive, { kind: "point-cloud" }>,
  profile: AnimationProfile,
  progress: number,
  plotArea: Rect,
  clipArea?: Rect,
  randomFillFade = false
): Extract<Primitive, { kind: "point-cloud" }> {
  const staticRadius = primitive.staticRadius ?? primitive.radius;
  const staticOpacity = primitive.staticOpacity ?? primitive.opacity ?? 1;
  const animated = resolveAnimatedScatterState({
    staticRadius,
    staticOpacity,
    profile,
    progress,
    plotArea,
    ...(clipArea ? { clipArea } : {})
  });

  const patched: Extract<Primitive, { kind: "point-cloud" }> = {
    ...primitive,
    radius: animated.radius,
    opacity: animated.opacity,
    clip: animated.clip
  };

  if ((profile === "random-fill" || profile === "random-fill-grow") && progress < 1) {
    patched.revealProgress = progress;
    if (profile === "random-fill-grow") {
      patched.revealGrow = true;
      delete patched.revealFade;
    } else if (randomFillFade) {
      patched.revealFade = true;
      delete patched.revealGrow;
    } else {
      delete patched.revealFade;
      delete patched.revealGrow;
    }
  } else {
    delete patched.revealProgress;
    delete patched.revealFade;
    delete patched.revealGrow;
  }

  return patched;
}

export function isScatterGpuAnimationProfile(profile: AnimationProfile | undefined): boolean {
  return profile === "rise" || profile === "draw-left" || profile === "draw-right" || profile === "random-fill" || profile === "random-fill-grow";
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
