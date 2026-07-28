import type { EdgeBlurState, Rect } from "../core/types";
import { parseCssColor } from "./color";

export function drawPlotEdgeBlur(
  context: CanvasRenderingContext2D,
  plotArea: Rect,
  edgeBlur: EdgeBlurState
): void {
  const size = edgeBlur.size ?? 28;
  const rgb = parseColor(edgeBlur.color ?? "#ffffff");
  const leftOpacity = resolveEdgeOpacity(edgeBlur.left, edgeBlur.leftOpacity);
  const rightOpacity = resolveEdgeOpacity(edgeBlur.right, edgeBlur.rightOpacity);
  const topOpacity = resolveEdgeOpacity(edgeBlur.top, edgeBlur.topOpacity);
  const bottomOpacity = resolveEdgeOpacity(edgeBlur.bottom, edgeBlur.bottomOpacity);

  if (leftOpacity <= 0 && rightOpacity <= 0 && topOpacity <= 0 && bottomOpacity <= 0) {
    return;
  }

  context.save();
  context.beginPath();
  context.rect(plotArea.x, plotArea.y, plotArea.width, plotArea.height);
  context.clip();

  if (leftOpacity > 0) {
    fillEdgeGradient(
      context,
      plotArea.x,
      plotArea.y,
      plotArea.x + size,
      plotArea.y,
      plotArea.x,
      plotArea.y,
      size,
      plotArea.height,
      rgb,
      leftOpacity
    );
  }

  if (rightOpacity > 0) {
    fillEdgeGradient(
      context,
      plotArea.x + plotArea.width,
      plotArea.y,
      plotArea.x + plotArea.width - size,
      plotArea.y,
      plotArea.x + plotArea.width - size,
      plotArea.y,
      size,
      plotArea.height,
      rgb,
      rightOpacity
    );
  }

  if (topOpacity > 0) {
    fillEdgeGradient(
      context,
      plotArea.x,
      plotArea.y,
      plotArea.x,
      plotArea.y + size,
      plotArea.x,
      plotArea.y,
      plotArea.width,
      size,
      rgb,
      topOpacity
    );
  }

  if (bottomOpacity > 0) {
    fillEdgeGradient(
      context,
      plotArea.x,
      plotArea.y + plotArea.height,
      plotArea.x,
      plotArea.y + plotArea.height - size,
      plotArea.x,
      plotArea.y + plotArea.height - size,
      plotArea.width,
      size,
      rgb,
      bottomOpacity
    );
  }

  context.restore();
}

function resolveEdgeOpacity(enabled: boolean | undefined, opacity: number | undefined): number {
  if (opacity !== undefined) {
    return Math.max(0, Math.min(1, opacity));
  }
  return enabled ? 1 : 0;
}

function fillEdgeGradient(
  context: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rectX: number,
  rectY: number,
  width: number,
  height: number,
  rgb: readonly [number, number, number],
  opacity: number
): void {
  const gradient = context.createLinearGradient(x0, y0, x1, y1);
  const [red, green, blue] = rgb;
  const edgeAlpha = 0.92 * opacity;

  gradient.addColorStop(0, `rgba(${red}, ${green}, ${blue}, ${edgeAlpha})`);
  gradient.addColorStop(1, `rgba(${red}, ${green}, ${blue}, 0)`);
  context.fillStyle = gradient;
  context.fillRect(rectX, rectY, width, height);
}

function parseColor(color: string): readonly [number, number, number] {
  const parsed = parseCssColor(color);
  if (parsed) {
    return [
      Math.round(parsed[0] * 255),
      Math.round(parsed[1] * 255),
      Math.round(parsed[2] * 255)
    ];
  }

  return [255, 255, 255];
}
