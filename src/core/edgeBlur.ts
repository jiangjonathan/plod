import { resolveFocusRatioRange } from "../data/focusRange";
import type { Layout } from "../layout/types";
import type { EdgeBlurState, PlotSelection, PlotSpec } from "./types";

const EDGE_EPSILON = 1e-4;

export function resolvePlotEdgeBlur<TDatum>(
  spec: PlotSpec<TDatum>,
  focus: PlotSelection | undefined,
  dataFocusAxis: "x" | "y",
  dataWindow: Layout["dataWindow"] | undefined,
  markKinds: ReadonlySet<string>
): EdgeBlurState | undefined {
  if (spec.edgeBlur === false || spec.edgeBlur === undefined) {
    return undefined;
  }

  if (!markKinds.has("bar") && !markKinds.has("line")) {
    return undefined;
  }

  const range = resolveFocusRatioRange(focus, dataFocusAxis);

  if (!range) {
    return undefined;
  }

  const canPanMin = dataWindow
    ? dataWindow.visibleStart > EDGE_EPSILON
    : range[0] > EDGE_EPSILON;
  const canPanMax = dataWindow
    ? dataWindow.visibleEnd < dataWindow.totalLength - EDGE_EPSILON
    : range[1] < 1 - EDGE_EPSILON;

  const edges: EdgeBlurState = {};

  const configured = spec.edgeBlur && typeof spec.edgeBlur === "object" ? spec.edgeBlur : undefined;

  if (dataFocusAxis === "x") {
    if (canPanMin) {
      edges.left = true;
    }
    if (canPanMax) {
      edges.right = true;
    }
  } else {
    if (canPanMin) {
      edges.top = true;
    }
    if (canPanMax) {
      edges.bottom = true;
    }
  }

  if (configured) {
    if (configured.left === false) edges.left = false;
    if (configured.right === false) edges.right = false;
    if (configured.top === false) edges.top = false;
    if (configured.bottom === false) edges.bottom = false;
  }

  return edges.left || edges.right || edges.top || edges.bottom ? edges : undefined;
}

export function resolveMarkKinds<TDatum>(spec: PlotSpec<TDatum>): ReadonlySet<string> {
  const kinds = new Set<string>();

  for (const mark of spec.marks) {
    if (mark.kind) {
      kinds.add(mark.kind);
    }
  }

  return kinds;
}

export function resolveEdgeBlurSize<TDatum>(spec: PlotSpec<TDatum>): number {
  if (spec.edgeBlur && typeof spec.edgeBlur === "object" && spec.edgeBlur.size !== undefined) {
    return Math.max(8, spec.edgeBlur.size);
  }

  return 28;
}
