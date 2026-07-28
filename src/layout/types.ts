import type { AnimationProfile, HoverState, Rect, RenderOptimizationSpec, Size } from "../core/types";

export type Layout = {
  size: Size;
  plotArea: Rect;
  clipArea?: Rect;
  animation?: {
    progress: number;
    profile: AnimationProfile;
    randomFillFade?: boolean;
  };
  hover?: HoverState;
  lineFocusTransition?: {
    dimProgress: number;
    emphasisBySeries: ReadonlyMap<number, number>;
  };
  hoverOnly?: boolean;
  xDomain?: readonly [number, number];
  yDomain?: readonly [number, number];
  renderDistance: Required<RenderOptimizationSpec>;
  dataWindow?: {
    startIndex: number;
    endIndex: number;
    visibleStart: number;
    visibleEnd: number;
    visibleX?: readonly [number, number];
    totalLength: number;
  };
  hiddenSeries?: Set<string | number> | undefined;
};
