import type { HoverState, Primitive, SceneGraph } from "../core/types";
import { scatterPointShapeScale } from "../renderers/scatterPoint";
import { isClientPointOverPlotUiChrome, isPlotUiChrome } from "./plotUiChrome";

type HoverController = {
  refresh(): void;
  forceRefresh(): boolean;
  clear(): void;
  setSuspended(suspended: boolean): void;
  destroy(): void;
};

type HoverControllerOptions = {
  getScene: () => SceneGraph;
  getEnabled: () => boolean;
  onHover: (hover: HoverState | undefined, options?: { force?: boolean }) => void;
};

export function attachHoverController(target: HTMLElement, options: HoverControllerOptions): HoverController {
  let current: HoverState | undefined;
  let lastClientPoint: { x: number; y: number } | undefined;
  let activePointerStart: { x: number; y: number } | undefined;
  let frame: number | undefined;
  let activePointerId: number | undefined;
  let globalTracking = false;
  let isSuspended = false;
  const ownerDocument = target.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;

  const move = (event: PointerEvent) => {
    if (isSuspended) {
      return;
    }

    const bounds = target.getBoundingClientRect();
    if (
      !pointInBounds(event.clientX, event.clientY, bounds) ||
      isPlotUiChrome(event.target)
    ) {
      leave();
      return;
    }

    lastClientPoint = { x: event.clientX, y: event.clientY };
    startGlobalTracking();

    if (activePointerId !== undefined) {
      if (activePointerStart && pointerDragDistance(activePointerStart, lastClientPoint) > 3) {
        updateHover(undefined, true);
      }
      return;
    }

    if (!options.getEnabled()) {
      updateHover(undefined, true);
      return;
    }

    scheduleRefresh();
  };
  const pointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || !event.isPrimary || isPlotUiChrome(event.target)) {
      return;
    }

    activePointerId = event.pointerId;
    activePointerStart = { x: event.clientX, y: event.clientY };
    lastClientPoint = { x: event.clientX, y: event.clientY };
    startGlobalTracking();
  };
  const pointerUp = (event: PointerEvent) => {
    if (activePointerId !== event.pointerId) {
      return;
    }

    activePointerId = undefined;
    activePointerStart = undefined;

    if (isPlotUiChrome(event.target) || isClientPointOverPlotUiChrome(event.clientX, event.clientY, ownerDocument)) {
      leave();
      return;
    }

    lastClientPoint = { x: event.clientX, y: event.clientY };
    startGlobalTracking();
    scheduleRefresh();
  };
  const leave = () => {
    if (frame !== undefined) {
      cancelAnimationFrame(frame);
      frame = undefined;
    }
    activePointerId = undefined;
    activePointerStart = undefined;
    lastClientPoint = undefined;
    stopGlobalTracking();
    updateHover(undefined, true);
  };
  const globalMove = (event: PointerEvent) => {
    if (!lastClientPoint && !current) {
      return;
    }

    const bounds = target.getBoundingClientRect();
    if (!pointInBounds(event.clientX, event.clientY, bounds)) {
      leave();
    }
  };
  const globalOut = (event: PointerEvent | MouseEvent) => {
    if (!event.relatedTarget) {
      leave();
    }
  };
  const windowBlur = () => {
    leave();
  };
  const visibilityChange = () => {
    if (ownerDocument.visibilityState === "hidden") {
      leave();
    }
  };
  const startGlobalTracking = () => {
    if (globalTracking) {
      return;
    }

    globalTracking = true;
    ownerWindow?.addEventListener("pointermove", globalMove, true);
    ownerWindow?.addEventListener("pointerout", globalOut, true);
    ownerWindow?.addEventListener("mouseout", globalOut, true);
  };
  const stopGlobalTracking = () => {
    if (!globalTracking) {
      return;
    }

    globalTracking = false;
    ownerWindow?.removeEventListener("pointermove", globalMove, true);
    ownerWindow?.removeEventListener("pointerout", globalOut, true);
    ownerWindow?.removeEventListener("mouseout", globalOut, true);
  };
  const refresh = () => {
    if (isSuspended) {
      leave();
      return;
    }

    if (activePointerId !== undefined) {
      return;
    }

    if (!options.getEnabled()) {
      updateHover(undefined, true);
      return;
    }

    if (
      lastClientPoint &&
      isClientPointOverPlotUiChrome(lastClientPoint.x, lastClientPoint.y, ownerDocument)
    ) {
      leave();
      return;
    }

    const scene = options.getScene();
    const point = resolveLocalPoint(scene);
    if (!point) {
      updateHover(undefined, true);
      return;
    }

    const next = hitTestHover(scene.primitives, point.x, point.y);
    updateHover(next, next === undefined);
  };
  const updateHover = (next: HoverState | undefined, force = false): boolean => {
    if (!force && sameHover(current, next)) {
      return false;
    }

    current = next;
    options.onHover(next, force ? { force: true } : undefined);
    return true;
  };
  const scheduleRefresh = () => {
    if (frame !== undefined) {
      return;
    }

    frame = requestAnimationFrame(() => {
      frame = undefined;
      refresh();
    });
  };

  target.addEventListener("pointerdown", pointerDown);
  target.addEventListener("pointerup", pointerUp);
  target.addEventListener("pointermove", move);
  target.addEventListener("pointerleave", leave);
  target.addEventListener("pointercancel", leave);
  target.addEventListener("mouseleave", leave);
  ownerWindow?.addEventListener("blur", windowBlur);
  ownerDocument.addEventListener("visibilitychange", visibilityChange);

  const forceRefresh = () => {
    if (isSuspended) {
      leave();
      return true;
    }

    if (activePointerId !== undefined) {
      return updateHover(undefined, true);
    }

    if (!options.getEnabled()) {
      return updateHover(undefined, true);
    }

    if (
      lastClientPoint &&
      isClientPointOverPlotUiChrome(lastClientPoint.x, lastClientPoint.y, ownerDocument)
    ) {
      leave();
      return true;
    }

    const scene = options.getScene();
    const point = resolveLocalPoint(scene);
    if (!point) {
      return updateHover(undefined, true);
    }

    const next = hitTestHover(scene.primitives, point.x, point.y);
    return updateHover(next, true);
  };
  const resolveLocalPoint = (scene: SceneGraph): { x: number; y: number } | undefined => {
    if (!lastClientPoint) {
      return undefined;
    }

    const bounds = target.getBoundingClientRect();
    if (!pointInBounds(lastClientPoint.x, lastClientPoint.y, bounds)) {
      lastClientPoint = undefined;
      return undefined;
    }

    const point = {
      x: lastClientPoint.x - bounds.left,
      y: lastClientPoint.y - bounds.top
    };

    return pointInRect(scene.plotArea, point.x, point.y) ? point : undefined;
  };

  return {
    refresh,
    forceRefresh,
    clear: leave,
    setSuspended(suspended: boolean) {
      isSuspended = suspended;
      if (suspended) {
        leave();
      }
    },
    destroy() {
      if (frame !== undefined) {
        cancelAnimationFrame(frame);
      }
      target.removeEventListener("pointerdown", pointerDown);
      target.removeEventListener("pointerup", pointerUp);
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerleave", leave);
      target.removeEventListener("pointercancel", leave);
      target.removeEventListener("mouseleave", leave);
      stopGlobalTracking();
      ownerWindow?.removeEventListener("blur", windowBlur);
      ownerDocument.removeEventListener("visibilitychange", visibilityChange);
    }
  };
}

function pointerDragDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function hitTestHover(primitives: readonly Primitive[], x: number, y: number): HoverState | undefined {
  for (let index = primitives.length - 1; index >= 0; index -= 1) {
    const primitive = primitives[index];

    if (primitive?.kind === "rect" && primitive.hover) {
      if (primitive.hitTest) {
        const hit = primitive.hitTest(x, y);
        if (hit) {
          return {
            markType: primitive.hover.markType,
            index: hit.index,
            ...(hit.seriesIndex !== undefined ? { seriesIndex: hit.seriesIndex } : {}),
            ...(hit.hoverX !== undefined ? { x: hit.hoverX } : {}),
            ...(hit.hoverY !== undefined ? { y: hit.hoverY } : {}),
            ...(hit.hoverXValue !== undefined ? { xValue: hit.hoverXValue } : {}),
            ...(hit.hoverYValue !== undefined ? { yValue: hit.hoverYValue } : {})
          };
        }
      } else if (pointInRect(primitive, x, y)) {
        return primitive.hover;
      }
    }

    if (primitive?.kind === "point-cloud" && primitive.hover && primitive.hitTest) {
      const hit = primitive.hitTest(x, y);

      if (hit && pointNearScatterHit(hit, x, y)) {
        return {
          markType: primitive.hover.markType,
          index: hit.index
        };
      }
    }
  }

  return undefined;
}

function pointInRect(rect: { x: number; y: number; width: number; height: number }, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

function pointInBounds(x: number, y: number, bounds: DOMRect): boolean {
  return x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
}

function pointNearScatterHit(
  hit: { x: number; y: number; radius?: number; hitRadius?: number; shape?: Extract<Primitive, { kind: "point-cloud" }>["shape"] },
  x: number,
  y: number
): boolean {
  const radius = hit.hitRadius ?? Math.max(1, (hit.radius ?? 2) * scatterPointShapeScale(hit.shape));
  const pad = 2;
  const dx = hit.x - x;
  const dy = hit.y - y;

  return dx * dx + dy * dy <= (radius + pad) * (radius + pad);
}

function sameHover(left: HoverState | undefined, right: HoverState | undefined): boolean {
  return left?.markType === right?.markType &&
    left?.index === right?.index &&
    left?.seriesIndex === right?.seriesIndex &&
    left?.x === right?.x &&
    left?.y === right?.y &&
    left?.xValue === right?.xValue &&
    left?.yValue === right?.yValue;
}
