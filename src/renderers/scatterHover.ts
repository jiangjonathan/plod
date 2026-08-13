import type { Primitive, SceneGraph, ScatterHoverEntry } from "../core/types";
import { drawScatterPoint } from "./scatterPoint";

export const DEFAULT_SCATTER_HOVER_RADIUS = 7;

export function resolveHoveredScatterRadius(
  baseRadius: number,
  targetRadius: number,
  progress: number
): number {
  const resolvedTarget = Math.max(baseRadius, targetRadius);

  return baseRadius + (resolvedTarget - baseRadius) * progress;
}

export function resolveShrinkingScatterRadius(
  baseRadius: number,
  targetRadius: number,
  progress: number,
  shrinkStartProgress: number,
): number {
  const startFillRadius = resolveHoveredScatterRadius(
    baseRadius,
    targetRadius,
    shrinkStartProgress
  );
  const span = Math.max(Number.EPSILON, shrinkStartProgress);

  const t = (shrinkStartProgress - progress) / span;

  return startFillRadius + (baseRadius - startFillRadius) * t;
}

export function drawScatterSceneHover(
  context: CanvasRenderingContext2D,
  scene: SceneGraph
): void {
  const scatterEntries = scene.scatterHover ?? [];
  const scatterHover = scene.hover?.markType === "scatter" ? scene.hover : undefined;
  const hasScatterHover = scatterEntries.length > 0 || scatterHover !== undefined;

  if (!hasScatterHover) {
    context.clearRect(0, 0, scene.size.width, scene.size.height);
    return;
  }

  for (let index = scene.primitives.length - 1; index >= 0; index -= 1) {
    const primitive = scene.primitives[index];

    if (primitive?.kind !== "point-cloud" || !primitive.lookup) {
      continue;
    }

    const hoverInteraction = primitive.hoverInteraction ?? "crosshair";

    if (hoverInteraction === "none") {
      context.clearRect(0, 0, scene.size.width, scene.size.height);
      return;
    }

    context.clearRect(0, 0, scene.size.width, scene.size.height);

    if (hoverInteraction === "crosshair" && scatterHover) {
      drawScatterCrosshair(context, primitive, scatterHover.index);
    }

    drawGrowScatterHovers(context, primitive, scatterEntries, scene.hover);

    return;
  }
}

function drawScatterCrosshair(
  context: CanvasRenderingContext2D,
  primitive: Extract<Primitive, { kind: "point-cloud" }>,
  index: number
): void {
  const hit = primitive.lookup?.(index);
  const plotArea = primitive.plotArea ?? primitive.clip;

  if (!hit || !plotArea) {
    return;
  }

  context.save();
  context.beginPath();
  context.rect(plotArea.x, plotArea.y, plotArea.width, plotArea.height);
  context.clip();
  context.beginPath();
  context.moveTo(hit.x, plotArea.y);
  context.lineTo(hit.x, plotArea.y + plotArea.height);
  context.moveTo(plotArea.x, hit.y);
  context.lineTo(plotArea.x + plotArea.width, hit.y);
  context.strokeStyle = primitive.hoverCrosshairColor ?? "#111111";
  context.globalAlpha = 0.38;
  context.lineWidth = 1;
  context.setLineDash([4, 4]);
  context.stroke();
  context.restore();
}

function drawGrowScatterHovers(
  context: CanvasRenderingContext2D,
  primitive: Extract<Primitive, { kind: "point-cloud" }>,
  scatterEntries: readonly ScatterHoverEntry[],
  hover: SceneGraph["hover"]
): void {
  const activeHoverIndex = hover?.markType === "scatter" ? hover.index : undefined;

  for (const entry of scatterEntries) {
    if (entry.progress <= 0) {
      continue;
    }

    drawGrowScatterHoverPoint(
      context,
      primitive,
      entry.index,
      entry.progress,
      entry.index === activeHoverIndex,
      entry.shrinkStartProgress
    );
  }
}

function drawGrowScatterHoverPoint(
  context: CanvasRenderingContext2D,
  primitive: Extract<Primitive, { kind: "point-cloud" }>,
  index: number,
  progress: number,
  _showRing: boolean,
  shrinkStartProgress?: number
): void {
  const hit = primitive.lookup!(index);

  if (!hit) {
    return;
  }

  const fill = hit.fill ?? primitive.fill ?? "#111111";
  const shape = hit.shape ?? primitive.shape ?? "circle";
  const baseRadius = hit.radius ?? primitive.radius;
  const targetRadius = primitive.hoverGrowRadius ?? DEFAULT_SCATTER_HOVER_RADIUS;
  const radius = shrinkStartProgress !== undefined
    ? resolveShrinkingScatterRadius(baseRadius, targetRadius, progress, shrinkStartProgress)
    : resolveHoveredScatterRadius(baseRadius, targetRadius, progress);
  const outline = primitive.hoverOutline;
  const markerStyle = resolveHoverMarkerStyle(fill, outline, _showRing);

  const isInsideClip = !primitive.clip || (
    hit.x >= primitive.clip.x &&
    hit.x <= primitive.clip.x + primitive.clip.width &&
    hit.y >= primitive.clip.y &&
    hit.y <= primitive.clip.y + primitive.clip.height
  );

  if (primitive.clip && !isInsideClip) {
    context.save();
    context.beginPath();
    context.rect(primitive.clip.x, primitive.clip.y, primitive.clip.width, primitive.clip.height);
    context.clip();
  }

  // Paint opaque so the grown marker fully covers the base point on the main
  // layer. Using series opacity here stacks alpha and reads as two circles.
  drawScatterPoint(
    context,
    hit.x,
    hit.y,
    radius,
    markerStyle,
    shape,
    1
  );

  if (primitive.clip && !isInsideClip) {
    context.restore();
  }
}

function resolveHoverMarkerStyle(
  fill: string,
  outline: Extract<Primitive, { kind: "point-cloud" }>["hoverOutline"],
  active: boolean
) {
  if (!active || !outline) {
    return { fill };
  }

  if (typeof outline === "string") {
    return { fill, outline, outlineWidth: 1.5 };
  }

  if (typeof outline === "object") {
    return {
      fill: outline.fill ?? fill,
      ...(outline.outline !== undefined ? { outline: outline.outline } : {}),
      ...(outline.outlineWidth !== undefined ? { outlineWidth: outline.outlineWidth } : {}),
      ...(outline.strokeWidth !== undefined ? { strokeWidth: outline.strokeWidth } : {})
    };
  }

  return { fill, outline: "#ffffff", outlineWidth: 1.5 };
}
