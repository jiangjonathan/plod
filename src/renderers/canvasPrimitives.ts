import type { CornerRadii, GradientFill, LineCurve, Primitive, Rect, RectPaint, ResizePreviewTransform } from "../core/types";
import { SYSTEM_FONT_FAMILY } from "../themes/defaultTheme";
import { drawWebGLPointCloud } from "./pointCloudWebGL";
import type { PointCloudGLResources } from "./pointCloudWebGL";

export function drawCanvasPrimitive(
  context: CanvasRenderingContext2D,
  primitive: Primitive,
  resizeTransform?: ResizePreviewTransform,
  gl?: WebGLRenderingContext,
  glResources?: PointCloudGLResources,
  canvasWidth?: number,
  canvasHeight?: number,
  liveWebGLResize = false
): void {
  if (primitive.kind === "path") {
    if (resizeTransform) {
      context.save();
      context.transform(
        resizeTransform.a,
        0,
        0,
        resizeTransform.d,
        resizeTransform.e,
        resizeTransform.f
      );
    }

    if (primitive.clip) {
      context.save();
      context.beginPath();
      applyClip(context, primitive.clip);
      context.clip();
    }

    const curve = primitive.curve ?? "linear";
    const areaBaseline = primitive.areaBaseline;
    const fillOpacity = primitive.fillOpacity;
    const compositeOperation = primitive.compositeOperation;
    const needsFillStyle = Boolean(primitive.fill);
    const shouldSaveFillStyle = fillOpacity !== undefined || compositeOperation !== undefined;

    if (shouldSaveFillStyle) {
      context.save();
      if (compositeOperation) {
        context.globalCompositeOperation = compositeOperation;
      }
      if (fillOpacity !== undefined) {
        context.globalAlpha *= Math.max(0, Math.min(1, fillOpacity));
      }
    }

    if (areaBaseline !== undefined && needsFillStyle && primitive.points.length > 0) {
      // Curve the top edge only, then close linearly to the baseline.
      // Baking baseline corners into a curved path causes overshoot/aliasing,
      // especially while streaming when endpoints shift every frame.
      drawPathPoints(context, primitive.points, curve);
      const first = primitive.points[0] as [number, number];
      const last = primitive.points[primitive.points.length - 1] as [number, number];
      context.lineTo(last[0], areaBaseline);
      context.lineTo(first[0], areaBaseline);
      context.closePath();
      context.fillStyle = primitive.fill as string;
      context.fill();
    } else {
      drawPathPoints(context, primitive.points, curve);
      if (primitive.closed) {
        context.closePath();
      }
      if (primitive.fill) {
        context.fillStyle = primitive.fill;
        context.fill();
      }
    }

    if (shouldSaveFillStyle) {
      context.restore();
    }

    context.strokeStyle = primitive.stroke ?? "currentColor";
    context.lineWidth = primitive.strokeWidth ?? 1;
    context.lineJoin = "round";
    context.lineCap = "round";
    if (primitive.stroke) {
      if (primitive.strokeDash) {
        context.setLineDash([...primitive.strokeDash]);
        context.lineDashOffset = primitive.strokeDashOffset ?? 0;
      }
      context.stroke();
      if (primitive.strokeDash) {
        context.setLineDash([]);
        context.lineDashOffset = 0;
      }
    }

    if (primitive.clip) {
      context.restore();
    }

    if (resizeTransform) {
      context.restore();
    }

    return;
  }

  if (primitive.kind === "rect") {
    if (primitive.hidden) {
      return;
    }

    if (resizeTransform) {
      context.save();
      context.transform(
        resizeTransform.a,
        0,
        0,
        resizeTransform.d,
        resizeTransform.e,
        resizeTransform.f
      );
    }

    if (primitive.clip) {
      context.save();
      context.beginPath();
      applyClip(context, primitive.clip);
      context.clip();
    }

    const paint = rectPaintFromPrimitive(primitive);
    const bounds = normalizeRectBounds(primitive, primitive.pixelSnap !== false);

    if (isFastFillRectPaint(paint)) {
      drawFastFillRect(context, bounds, paint.fill);
    } else {
      drawStyledRect(context, bounds, paint);
    }

    if (primitive.clip) {
      context.restore();
    }

    if (resizeTransform) {
      context.restore();
    }

    return;
  }

  if (primitive.kind === "rects") {
    if (resizeTransform) {
      context.save();
      context.transform(
        resizeTransform.a,
        0,
        0,
        resizeTransform.d,
        resizeTransform.e,
        resizeTransform.f
      );
    }

    if (primitive.clip) {
      context.save();
      context.beginPath();
      applyClip(context, primitive.clip);
      context.clip();
    }

    const paint = rectPaintFromPrimitive(primitive);

    for (const rect of primitive.rects) {
      const bounds = normalizeRectBounds(rect, primitive.pixelSnap !== false);

      if (isFastFillRectPaint(paint)) {
        drawFastFillRect(context, bounds, paint.fill);
      } else {
        drawStyledRect(context, bounds, paint);
      }
    }

    if (primitive.clip) {
      context.restore();
    }

    if (resizeTransform) {
      context.restore();
    }

    return;
  }

  if (primitive.kind === "point-cloud") {
    if (gl && glResources && primitive.isRaw && canvasWidth !== undefined && canvasHeight !== undefined) {
      drawWebGLPointCloud(gl, glResources, primitive, canvasWidth, canvasHeight, resizeTransform, liveWebGLResize);
    }

    return;
  }

  if (primitive.kind === "text") {
    const hasOpacity = primitive.opacity !== undefined && primitive.opacity < 1;
    if (hasOpacity) {
      context.save();
      context.globalAlpha *= Math.max(0, primitive.opacity ?? 1);
    }

    if (primitive.clip) {
      context.save();
      context.beginPath();
      applyClip(context, primitive.clip);
      context.clip();
    }

    context.fillStyle = primitive.fill ?? "currentColor";
    context.font = primitive.font ?? `12px ${SYSTEM_FONT_FAMILY}`;
    context.textAlign = primitive.align ?? "start";
    context.textBaseline = primitive.baseline ?? "alphabetic";
    const x = primitive.x;
    const y = primitive.y;
    if (primitive.angle !== undefined && primitive.angle !== 0) {
      context.save();
      context.translate(x, y);
      context.rotate((primitive.angle * Math.PI) / 180);
      if (primitive.maxWidth !== undefined) {
        context.fillText(primitive.text, 0, 0, primitive.maxWidth);
      } else {
        context.fillText(primitive.text, 0, 0);
      }
      context.restore();

      if (primitive.clip) {
        context.restore();
      }
      if (hasOpacity) {
        context.restore();
      }

      return;
    }

    if (primitive.maxWidth !== undefined) {
      context.fillText(primitive.text, x, y, primitive.maxWidth);
    } else {
      context.fillText(primitive.text, x, y);
    }

    if (primitive.clip) {
      context.restore();
    }
    if (hasOpacity) {
      context.restore();
    }

    return;
  }

  if (primitive.kind === "circle") {
    const shouldClip = primitive.clip && !(
      primitive.x >= primitive.clip.x &&
      primitive.x <= primitive.clip.x + primitive.clip.width &&
      primitive.y >= primitive.clip.y &&
      primitive.y <= primitive.clip.y + primitive.clip.height
    );

    if (shouldClip) {
      context.save();
      context.beginPath();
      applyClip(context, primitive.clip!);
      context.clip();
    } else if (primitive.opacity !== undefined && primitive.opacity < 1) {
      context.save();
    }

    if (primitive.opacity !== undefined) {
      context.globalAlpha *= primitive.opacity;
    }

    context.beginPath();
    context.arc(primitive.x, primitive.y, primitive.radius, 0, Math.PI * 2);
    context.fillStyle = primitive.fill ?? "currentColor";
    context.fill();

    if (primitive.stroke) {
      context.strokeStyle = primitive.stroke;
      context.lineWidth = primitive.strokeWidth ?? 1;
      context.stroke();
    }

    if (shouldClip || (primitive.opacity !== undefined && primitive.opacity < 1)) {
      context.restore();
    }
  }
}


function drawPathPoints(
  context: CanvasRenderingContext2D,
  points: readonly [number, number][],
  curve: LineCurve
): void {
  context.beginPath();

  if (points.length === 0) {
    return;
  }

  const first = points[0] as [number, number];
  context.moveTo(first[0], first[1]);

  if (curve === "linear" || points.length < 2) {
    drawLinearPath(context, points);
    return;
  }

  if (curve === "step" || curve === "step-before" || curve === "step-after") {
    drawStepPath(context, points, curve);
    return;
  }

  if (points.length < 3) {
    drawLinearPath(context, points);
    return;
  }

  if (curve === "monotone-x") {
    drawMonotoneXPath(context, points);
    return;
  }

  drawCardinalPath(context, points, curve === "basis" ? 1 : 0);
}

function drawLinearPath(context: CanvasRenderingContext2D, points: readonly [number, number][]): void {
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index] as [number, number];
    context.lineTo(point[0], point[1]);
  }
}

function drawStepPath(
  context: CanvasRenderingContext2D,
  points: readonly [number, number][],
  curve: Extract<LineCurve, "step" | "step-before" | "step-after">
): void {
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1] as [number, number];
    const point = points[index] as [number, number];

    if (curve === "step-before") {
      context.lineTo(previous[0], point[1]);
    } else if (curve === "step-after") {
      context.lineTo(point[0], previous[1]);
    } else {
      const midpoint = (previous[0] + point[0]) / 2;
      context.lineTo(midpoint, previous[1]);
      context.lineTo(midpoint, point[1]);
    }

    context.lineTo(point[0], point[1]);
  }
}

function drawCardinalPath(
  context: CanvasRenderingContext2D,
  points: readonly [number, number][],
  tension: number
): void {
  const scale = (1 - tension) / 6;

  if (scale <= 0) {
    drawBasisPath(context, points);
    return;
  }

  for (let index = 0; index < points.length - 1; index += 1) {
    const p0 = points[Math.max(0, index - 1)] as [number, number];
    const p1 = points[index] as [number, number];
    const p2 = points[index + 1] as [number, number];
    const p3 = points[Math.min(points.length - 1, index + 2)] as [number, number];
    const dx = p2[0] - p1[0];

    if (dx < 1.0) {
      context.lineTo(p2[0], p2[1]);
      continue;
    }

    const cp1x = p1[0] + (p2[0] - p0[0]) * scale;
    const cp1y = p1[1] + (p2[1] - p0[1]) * scale;
    const cp2x = p2[0] - (p3[0] - p1[0]) * scale;
    const cp2y = p2[1] - (p3[1] - p1[1]) * scale;

    context.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2[0], p2[1]);
  }
}

function drawBasisPath(context: CanvasRenderingContext2D, points: readonly [number, number][]): void {
  if (points.length < 3) {
    drawLinearPath(context, points);
    return;
  }

  for (let index = 1; index < points.length - 1; index += 1) {
    const point = points[index] as [number, number];
    const next = points[index + 1] as [number, number];
    const dx = next[0] - point[0];

    if (dx < 1.0) {
      context.lineTo(next[0], next[1]);
      continue;
    }

    const midX = (point[0] + next[0]) / 2;
    const midY = (point[1] + next[1]) / 2;

    context.quadraticCurveTo(point[0], point[1], midX, midY);
  }

  const last = points[points.length - 1] as [number, number];
  context.lineTo(last[0], last[1]);
}

function drawMonotoneXPath(context: CanvasRenderingContext2D, points: readonly [number, number][]): void {
  const tangents = monotoneTangents(points);

  for (let index = 0; index < points.length - 1; index += 1) {
    const p0 = points[index] as [number, number];
    const p1 = points[index + 1] as [number, number];
    const dx = p1[0] - p0[0];

    if (dx < 1.0) {
      context.lineTo(p1[0], p1[1]);
      continue;
    }

    context.bezierCurveTo(
      p0[0] + dx / 3,
      p0[1] + (tangents[index] ?? 0) * dx / 3,
      p1[0] - dx / 3,
      p1[1] - (tangents[index + 1] ?? 0) * dx / 3,
      p1[0],
      p1[1]
    );
  }
}

function monotoneTangents(points: readonly [number, number][]): number[] {
  const slopes: number[] = [];
  const tangents: number[] = [];

  for (let index = 0; index < points.length - 1; index += 1) {
    const p0 = points[index] as [number, number];
    const p1 = points[index + 1] as [number, number];
    const dx = p1[0] - p0[0];
    slopes[index] = dx === 0 ? 0 : (p1[1] - p0[1]) / dx;
  }

  tangents[0] = slopes[0] ?? 0;
  tangents[points.length - 1] = slopes[slopes.length - 1] ?? 0;

  for (let index = 1; index < points.length - 1; index += 1) {
    const prev = slopes[index - 1] ?? 0;
    const next = slopes[index] ?? 0;
    tangents[index] = prev * next <= 0 ? 0 : (prev + next) / 2;
  }

  const alpha: number[] = [];
  for (let index = 0; index < slopes.length; index += 1) {
    const slope = slopes[index] ?? 0;

    if (slope === 0) {
      alpha[index] = 1;
      continue;
    }

    const a = (tangents[index] ?? 0) / slope;
    const b = (tangents[index + 1] ?? 0) / slope;
    const sum = a * a + b * b;
    alpha[index] = sum > 9 ? 3 / Math.sqrt(sum) : 1;
  }

  for (let index = 0; index < tangents.length; index += 1) {
    const scale = Math.min(
      index > 0 ? alpha[index - 1] ?? 1 : 1,
      index < alpha.length ? alpha[index] ?? 1 : 1
    );
    tangents[index] = (tangents[index] ?? 0) * scale;
  }

  return tangents;
}

type NormalizedRectBounds = {
  left: number;
  top: number;
  width: number;
  height: number;
};

function rectPaintFromPrimitive(primitive: {
  fill?: string;
  fillGradient?: GradientFill;
  stroke?: string;
  strokeWidth?: number;
  strokeDash?: readonly number[];
  cornerRadii?: CornerRadii;
}): RectPaint {
  const paint: RectPaint = {};

  if (primitive.fill !== undefined) {
    paint.fill = primitive.fill;
  }

  if (primitive.fillGradient !== undefined) {
    paint.fillGradient = primitive.fillGradient;
  }

  if (primitive.stroke !== undefined) {
    paint.stroke = primitive.stroke;
  }

  if (primitive.strokeWidth !== undefined) {
    paint.strokeWidth = primitive.strokeWidth;
  }

  if (primitive.strokeDash !== undefined) {
    paint.strokeDash = primitive.strokeDash;
  }

  if (primitive.cornerRadii !== undefined) {
    paint.cornerRadii = primitive.cornerRadii;
  }

  return paint;
}

function normalizeRectBounds(
  rect: { x: number; y: number; width: number; height: number },
  pixelSnap = true
): NormalizedRectBounds {
  const left = pixelSnap ? Math.floor(rect.x) : rect.x;
  const top = pixelSnap ? Math.floor(rect.y) : rect.y;
  const right = pixelSnap ? Math.ceil(rect.x + rect.width) : rect.x + rect.width;
  const bottom = pixelSnap ? Math.ceil(rect.y + rect.height) : rect.y + rect.height;

  return {
    left,
    top,
    width: Math.max(pixelSnap ? 1 : 0, right - left),
    height: Math.max(pixelSnap ? 1 : 0, bottom - top)
  };
}

function isFastFillRectPaint(paint: RectPaint): paint is RectPaint & { fill: string } {
  return paint.fill !== undefined &&
    paint.fillGradient === undefined &&
    paint.stroke === undefined &&
    (!paint.cornerRadii || paint.cornerRadii.every((radius) => radius === 0));
}

function drawFastFillRect(
  context: CanvasRenderingContext2D,
  bounds: NormalizedRectBounds,
  fill: string
): void {
  context.fillStyle = fill;
  context.fillRect(bounds.left, bounds.top, bounds.width, bounds.height);
}

function drawStyledRect(
  context: CanvasRenderingContext2D,
  bounds: NormalizedRectBounds,
  paint: RectPaint
): void {
  const { left, top, width, height } = bounds;

  traceRoundedRectPath(context, left, top, width, height, paint.cornerRadii ?? [0, 0, 0, 0]);

  const fillStyle = resolveCanvasFill(context, left, top, width, height, paint.fill, paint.fillGradient);

  if (fillStyle) {
    context.fillStyle = fillStyle;
    context.fill();
  }

  if (paint.stroke) {
    context.save();
    context.strokeStyle = paint.stroke;
    context.lineWidth = paint.strokeWidth ?? 1;

    if (paint.strokeDash && paint.strokeDash.length > 0) {
      context.setLineDash([...paint.strokeDash]);
    }

    context.stroke();
    context.restore();
  }
}

function resolveCanvasFill(
  context: CanvasRenderingContext2D,
  left: number,
  top: number,
  width: number,
  height: number,
  fill?: string,
  fillGradient?: GradientFill
): string | CanvasGradient | undefined {
  if (fillGradient) {
    const axis = fillGradient.axis ?? "y";
    const bounds = fillGradient.bounds ?? { x: left, y: top, width, height };
    const gradient = axis === "x"
      ? context.createLinearGradient(bounds.x, bounds.y, bounds.x + bounds.width, bounds.y)
      : context.createLinearGradient(bounds.x, bounds.y, bounds.x, bounds.y + bounds.height);

    for (const stop of fillGradient.stops) {
      gradient.addColorStop(stop.offset, stop.color);
    }

    return gradient;
  }

  return fill;
}

function normalizeCornerRadii(
  radii: CornerRadii,
  width: number,
  height: number
): CornerRadii {
  const maxHorizontal = width / 2;
  const maxVertical = height / 2;
  let topLeft = Math.max(0, radii[0] ?? 0);
  let topRight = Math.max(0, radii[1] ?? 0);
  let bottomRight = Math.max(0, radii[2] ?? 0);
  let bottomLeft = Math.max(0, radii[3] ?? 0);

  topLeft = Math.min(topLeft, maxHorizontal, maxVertical);
  topRight = Math.min(topRight, maxHorizontal, maxVertical);
  bottomRight = Math.min(bottomRight, maxHorizontal, maxVertical);
  bottomLeft = Math.min(bottomLeft, maxHorizontal, maxVertical);

  const topScale = Math.min(1, maxHorizontal / Math.max(topLeft, topRight, Number.EPSILON));
  const bottomScale = Math.min(1, maxHorizontal / Math.max(bottomLeft, bottomRight, Number.EPSILON));
  const leftScale = Math.min(1, maxVertical / Math.max(topLeft, bottomLeft, Number.EPSILON));
  const rightScale = Math.min(1, maxVertical / Math.max(topRight, bottomRight, Number.EPSILON));
  const scale = Math.min(topScale, bottomScale, leftScale, rightScale, 1);

  if (scale < 1) {
    topLeft *= scale;
    topRight *= scale;
    bottomRight *= scale;
    bottomLeft *= scale;
  }

  return [topLeft, topRight, bottomRight, bottomLeft];
}
  
function applyClip(context: CanvasRenderingContext2D, clip: Rect): void {
  if (clip.cornerRadii) {
    traceRoundedRectPath(context, clip.x, clip.y, clip.width, clip.height, clip.cornerRadii);
  } else {
    context.rect(clip.x, clip.y, clip.width, clip.height);
  }
}

function traceRoundedRectPath(
  context: CanvasRenderingContext2D,
  left: number,
  top: number,
  width: number,
  height: number,
  radii: CornerRadii
): void {
  const [topLeft, topRight, bottomRight, bottomLeft] = normalizeCornerRadii(radii, width, height);

  if (topLeft <= 0 && topRight <= 0 && bottomRight <= 0 && bottomLeft <= 0) {
    context.beginPath();
    context.rect(left, top, width, height);
    return;
  }

  if (typeof context.roundRect === "function") {
    context.beginPath();
    context.roundRect(left, top, width, height, [topLeft, topRight, bottomRight, bottomLeft]);
    return;
  }

  context.beginPath();
  context.moveTo(left + topLeft, top);
  context.lineTo(left + width - topRight, top);
  context.arcTo(left + width, top, left + width, top + topRight, topRight);
  context.lineTo(left + width, top + height - bottomRight);
  context.arcTo(left + width, top + height, left + width - bottomRight, top + height, bottomRight);
  context.lineTo(left + bottomLeft, top + height);
  context.arcTo(left, top + height, left, top + height - bottomLeft, bottomLeft);
  context.lineTo(left, top + topLeft);
  context.arcTo(left, top, left + topLeft, top, topLeft);
  context.closePath();
}
