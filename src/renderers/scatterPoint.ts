import type { MarkerStyle, ScatterPointShape } from "../core/types";

/** Matches WebGL cross/x arm half-width (0.16) over half-extent (0.5). */
const CROSS_ARM_HALF_WIDTH_RATIO = 0.32;

export function scatterPointShapeScale(shape: ScatterPointShape | undefined): number {
  switch (shape) {
    case "square":
      return 0.9;
    case "diamond":
      return 1.24;
    case "triangle":
      return 1.32;
    case "star":
    case "polygon":
    case "plus":
    case "cross":
    case "x":
      return 1.35;
    default:
      return 1;
  }
}

export function scatterShapeShaderValue(shape: ScatterPointShape | undefined): number {
  switch (shape) {
    case "square":
      return 1;
    case "diamond":
      return 2;
    case "triangle":
      return 3;
    case "star":
      return 4;
    case "plus":
    case "cross":
      return 5;
    case "x":
      return 6;
    case "polygon":
      return 7;
    default:
      return 0;
  }
}

export function drawScatterPoint(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  fillOrStyle: string | MarkerStyle,
  shape: ScatterPointShape | undefined,
  opacity = 1
): void {
  const resolvedShape = shape ?? "circle";
  const resolvedRadius = Math.max(0.5, radius);
  const style = typeof fillOrStyle === "string" ? { fill: fillOrStyle } : fillOrStyle;
  const outlineWidth = Math.max(0, style.outlineWidth ?? 0);

  context.save();
  context.globalAlpha *= opacity;

  buildFilledMarkerPath(context, x, y, resolvedRadius, resolvedShape, style.strokeWidth);

  if (style.outline && outlineWidth > 0) {
    context.strokeStyle = style.outline;
    context.lineWidth = outlineWidth * 2;
    context.lineJoin = "round";
    context.lineCap = "round";
    context.stroke();
  }

  context.fillStyle = style.fill;
  context.fill();
  context.restore();
}

function buildFilledMarkerPath(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  shape: ScatterPointShape,
  strokeWidth?: number
): void {
  context.beginPath();

  if (shape === "circle") {
    context.arc(x, y, radius, 0, Math.PI * 2);
    return;
  }

  if (shape === "square") {
    const half = radius * scatterPointShapeScale(shape);
    context.rect(x - half, y - half, half * 2, half * 2);
    return;
  }

  if (shape === "diamond") {
    const diagonal = radius * scatterPointShapeScale(shape);
    context.moveTo(x, y - diagonal);
    context.lineTo(x + diagonal, y);
    context.lineTo(x, y + diagonal);
    context.lineTo(x - diagonal, y);
    context.closePath();
    return;
  }

  if (shape === "triangle") {
    const circumradius = radius * scatterPointShapeScale(shape);
    const halfBase = circumradius * 0.866;
    context.moveTo(x, y - circumradius);
    context.lineTo(x + halfBase, y + circumradius * 0.5);
    context.lineTo(x - halfBase, y + circumradius * 0.5);
    context.closePath();
    return;
  }

  if (shape === "star") {
    buildRegularStarPath(context, x, y, radius * scatterPointShapeScale(shape), 5);
    return;
  }

  if (shape === "plus" || shape === "cross") {
    const span = radius * scatterPointShapeScale(shape);
    const armHalfWidth = resolveCrossArmHalfWidth(span, strokeWidth);
    buildAxisAlignedCrossPath(context, x, y, span, armHalfWidth);
    return;
  }

  if (shape === "x") {
    const span = radius * scatterPointShapeScale(shape);
    const armHalfWidth = resolveCrossArmHalfWidth(span, strokeWidth);
    buildDiagonalCrossPath(context, x, y, span, armHalfWidth);
    return;
  }

  // Flat-top pentagon — matches WebGL polygon (shape id 7).
  buildRegularPolygonPath(context, x, y, radius * scatterPointShapeScale(shape), 5);
}

function resolveCrossArmHalfWidth(span: number, strokeWidth: number | undefined): number {
  if (strokeWidth !== undefined && strokeWidth > 0) {
    return Math.max(0.5, strokeWidth * 0.5);
  }
  return Math.max(0.5, span * CROSS_ARM_HALF_WIDTH_RATIO);
}

function buildAxisAlignedCrossPath(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  span: number,
  armHalfWidth: number
): void {
  const hw = Math.min(armHalfWidth, span);
  context.moveTo(x - hw, y - span);
  context.lineTo(x + hw, y - span);
  context.lineTo(x + hw, y - hw);
  context.lineTo(x + span, y - hw);
  context.lineTo(x + span, y + hw);
  context.lineTo(x + hw, y + hw);
  context.lineTo(x + hw, y + span);
  context.lineTo(x - hw, y + span);
  context.lineTo(x - hw, y + hw);
  context.lineTo(x - span, y + hw);
  context.lineTo(x - span, y - hw);
  context.lineTo(x - hw, y - hw);
  context.closePath();
}

function buildDiagonalCrossPath(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  span: number,
  armHalfWidth: number
): void {
  const hw = Math.min(armHalfWidth, span);
  // Axis-aligned plus vertices, rotated 45° to match WebGL "x".
  const vertices: Array<readonly [number, number]> = [
    [-hw, -span],
    [hw, -span],
    [hw, -hw],
    [span, -hw],
    [span, hw],
    [hw, hw],
    [hw, span],
    [-hw, span],
    [-hw, hw],
    [-span, hw],
    [-span, -hw],
    [-hw, -hw]
  ];

  for (let index = 0; index < vertices.length; index += 1) {
    const [dx, dy] = vertices[index]!;
    const px = x + (dx - dy) * Math.SQRT1_2;
    const py = y + (dx + dy) * Math.SQRT1_2;
    if (index === 0) {
      context.moveTo(px, py);
    } else {
      context.lineTo(px, py);
    }
  }
  context.closePath();
}

function buildRegularPolygonPath(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  sides: number
): void {
  // Offset by half a sector so a flat edge faces up (WebGL polygon SDF).
  const orientation = -Math.PI / 2 + Math.PI / sides;

  for (let index = 0; index < sides; index += 1) {
    const angle = orientation + (index / sides) * Math.PI * 2;
    const px = x + Math.cos(angle) * radius;
    const py = y + Math.sin(angle) * radius;
    if (index === 0) {
      context.moveTo(px, py);
    } else {
      context.lineTo(px, py);
    }
  }
  context.closePath();
}

function buildRegularStarPath(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  points: number
): void {
  const innerRadius = radius * 0.45;
  const steps = points * 2;

  for (let index = 0; index < steps; index += 1) {
    const pointRadius = index % 2 === 0 ? radius : innerRadius;
    const angle = -Math.PI / 2 + (index / steps) * Math.PI * 2;
    const px = x + Math.cos(angle) * pointRadius;
    const py = y + Math.sin(angle) * pointRadius;
    if (index === 0) {
      context.moveTo(px, py);
    } else {
      context.lineTo(px, py);
    }
  }
  context.closePath();
}
