import type { PanSpec, PlotSelection, SceneGraph, SelectionSpec, ZoomSpec } from "../core/types";

/** Wheel / trackpad zoom strength (scale = exp(delta * sensitivity)). */
const DEFAULT_ZOOM_WHEEL_SENSITIVITY = 0.006;
/** Extra multiplier when the browser reports a pinch (ctrl+wheel). */
const PINCH_ZOOM_SENSITIVITY_MULTIPLIER = 2.5;
const DOUBLE_TAP_MS = 300;
const TAP_MAX_DURATION_MS = 250;
const TAP_MAX_DISTANCE_PX = 10;
const DOUBLE_TAP_MAX_DISTANCE_PX = 32;

type SelectionController = {
  destroy(): void;
};

type SelectionControllerOptions = {
  getScene: () => SceneGraph;
  getSpec: () => SelectionSpec | false | undefined;
  getZoomSpec: () => ZoomSpec | false | undefined;
  getPanSpec: () => PanSpec | false | undefined;
  getDragInteraction?: () => "selection" | "pan" | undefined;
  onSelect: (selection: PlotSelection) => void;
  onZoom: (centerX: number, scaleX: number, centerY?: number, scaleY?: number) => void;
  onPan: (deltaX: number, deltaY?: number) => void;
  onPanEnd?: () => void;
  onClear: () => void;
};

export function attachSelectionController(
  target: HTMLElement,
  options: SelectionControllerOptions
): SelectionController {
  const originalPosition = target.style.position;
  const originalCursor = target.style.cursor;
  const originalTouchAction = target.style.touchAction;

  if (getComputedStyle(target).position === "static") {
    target.style.position = "relative";
  }

  const overlay = document.createElement("div");

  overlay.style.position = "absolute";
  overlay.style.pointerEvents = "none";
  overlay.style.display = "none";
  overlay.style.boxSizing = "border-box";
  target.append(overlay);

  let prevDistance = 0;
  let prevCenter = { x: 0, y: 0 };
  let isPinching = false;
  let suppressNextContextMenu = false;
  let touchTapStart: { x: number; y: number; time: number } | undefined;
  let lastTap: { x: number; y: number; time: number } | undefined;

  const updateTouchAction = () => {
    target.style.touchAction = resolveTouchAction(options, originalTouchAction);
  };

  updateTouchAction();

  const pointerDown = (event: PointerEvent) => {
    if (isPinching) {
      return;
    }
    const spec = resolveSpec(options.getSpec());
    const panSpec = resolvePanSpec(options.getPanSpec());
    const dragInteraction = options.getDragInteraction?.() ?? "selection";

    if (
      panSpec &&
      panSpec.drag !== false &&
      (event.pointerType !== "touch" || panSpec.touch !== false) &&
      shouldStartPointerPan(event, spec, dragInteraction)
    ) {
      startPointerPan(target, event, options, () => isPinching, () => {
        suppressNextContextMenu = true;
      });
      return;
    }

    if (!spec || event.button !== 0 || dragInteraction === "pan") {
      return;
    }

    const scene = options.getScene();
    const start = toLocalPoint(target, event);

    if (!pointInRect(start.x, start.y, scene.plotArea)) {
      return;
    }

    event.preventDefault();
    target.setPointerCapture(event.pointerId);

    const plotArea = scene.plotArea;
    const primaryAxis = scene.dataFocusAxis ?? "x";
    const startX = clamp(start.x, plotArea.x, plotArea.x + plotArea.width);
    const startY = clamp(start.y, plotArea.y, plotArea.y + plotArea.height);
    const minPixelSpan = spec.minPixelSpan ?? 8;
    const revealPixelSpan = Math.min(4, minPixelSpan);

    hideOverlay(overlay);

    const pointerMove = (moveEvent: PointerEvent) => {
      if (isPinching) {
        pointerUp(moveEvent);
        return;
      }
      const current = toLocalPoint(target, moveEvent);
      const currentX = clamp(current.x, plotArea.x, plotArea.x + plotArea.width);
      const currentY = clamp(current.y, plotArea.y, plotArea.y + plotArea.height);
      const span = selectionPixelSpan(spec, primaryAxis, startX, currentX, startY, currentY);

      if (span >= revealPixelSpan) {
        showOverlay(overlay, spec, primaryAxis, plotArea, startX, currentX, startY, currentY);
      } else {
        hideOverlay(overlay);
      }
    };
    const pointerUp = (upEvent: PointerEvent) => {
      const end = toLocalPoint(target, upEvent);
      const endX = clamp(end.x, plotArea.x, plotArea.x + plotArea.width);
      const endY = clamp(end.y, plotArea.y, plotArea.y + plotArea.height);
      const span = selectionPixelSpan(spec, primaryAxis, startX, endX, startY, endY);

      hideOverlay(overlay);
      target.releasePointerCapture(upEvent.pointerId);
      target.removeEventListener("pointermove", pointerMove);
      target.removeEventListener("pointerup", pointerUp);
      target.removeEventListener("pointercancel", pointerUp);

      if (span >= minPixelSpan) {
        const left = Math.min(startX, endX);
        const right = Math.max(startX, endX);
        const top = Math.min(startY, endY);
        const bottom = Math.max(startY, endY);
        const xRange: readonly [number, number] = [
          (left - plotArea.x) / plotArea.width,
          (right - plotArea.x) / plotArea.width
        ];
        const yRange: readonly [number, number] = [
          (top - plotArea.y) / plotArea.height,
          (bottom - plotArea.y) / plotArea.height
        ];
        const valueYRange: readonly [number, number] = [
          1 - (bottom - plotArea.y) / plotArea.height,
          1 - (top - plotArea.y) / plotArea.height
        ];

        options.onSelect(primaryAxis === "y"
          ? {
              y: yRange,
              ...(spec.mode === "xy" ? { x: xRange } : {})
            }
          : {
              x: xRange,
              ...(spec.mode === "xy" ? { y: valueYRange } : {})
            });
      }
    };

    target.addEventListener("pointermove", pointerMove);
    target.addEventListener("pointerup", pointerUp);
    target.addEventListener("pointercancel", pointerUp);
  };
  const wheel = (event: WheelEvent) => {
    const panSpec = resolvePanSpec(options.getPanSpec());
    const zoomSpec = resolveZoomSpec(options.getZoomSpec());
    const scene = options.getScene();
    const point = toLocalPoint(target, event);

    if (!pointInRect(point.x, point.y, scene.plotArea)) {
      return;
    }

    const yAxisFocus = scene.dataFocusAxis === "y";
    const intent = yAxisFocus
      ? resolveVerticalPanIntent(event)
      : resolveWheelIntent(event);

    if (intent.kind === "pan" && panSpec && panSpec.wheel !== false) {
      event.preventDefault();
      if (yAxisFocus) {
        options.onPan(0, intent.delta / scene.plotArea.height);
      } else {
        options.onPan(intent.delta / scene.plotArea.width, 0);
      }
      return;
    }

    if (yAxisFocus) {
      return;
    }

    if (intent.kind !== "zoom" || !zoomSpec || (zoomSpec.wheel === false && !event.ctrlKey)) {
      return;
    }

    event.preventDefault();
    const centerX = (point.x - scene.plotArea.x) / scene.plotArea.width;
    const centerY = 1 - (point.y - scene.plotArea.y) / scene.plotArea.height;
    const sensitivity = resolveWheelZoomSensitivity(zoomSpec, event);
    const scale = Math.exp(intent.delta * sensitivity);

    if (zoomSpec.mode === "xy") {
      options.onZoom(
        clamp(centerX, 0, 1),
        scale,
        clamp(centerY, 0, 1),
        scale
      );
    } else {
      options.onZoom(clamp(centerX, 0, 1), scale);
    }
  };
  const pointerMoveCursor = (event: PointerEvent) => {
    updateTouchAction();
    const scene = options.getScene();
    const point = toLocalPoint(target, event);

    if (!pointInRect(point.x, point.y, scene.plotArea)) {
      target.style.cursor = originalCursor;
      return;
    }

    const dragInteraction = options.getDragInteraction?.() ?? "selection";
    if (dragInteraction === "pan") {
      const panSpec = resolvePanSpec(options.getPanSpec());
      target.style.cursor = panSpec && panSpec.drag !== false ? "grab" : originalCursor;
      return;
    }

    if (resolveSpec(options.getSpec())) {
      target.style.cursor = "crosshair";
      return;
    }

    const panSpec = resolvePanSpec(options.getPanSpec());

    target.style.cursor = panSpec && panSpec.drag !== false ? "grab" : originalCursor;
  };
  const doubleClick = (event: MouseEvent) => {
    const spec = resolveSpec(options.getSpec());

    if (!spec) {
      return;
    }

    const scene = options.getScene();
    const point = toLocalPoint(target, event);

    if (pointInRect(point.x, point.y, scene.plotArea)) {
      options.onClear();
    }
  };
  const contextMenu = (event: MouseEvent) => {
    if (suppressNextContextMenu) {
      event.preventDefault();
      suppressNextContextMenu = false;
      return;
    }

    const panSpec = resolvePanSpec(options.getPanSpec());

    if (!panSpec || panSpec.drag === false) {
      return;
    }

    const scene = options.getScene();
    const point = toLocalPoint(target, event);

    if (pointInRect(point.x, point.y, scene.plotArea)) {
      event.preventDefault();
    }
  };

  const touchStart = (event: TouchEvent) => {
    updateTouchAction();
    if (event.touches.length === 2) {
      const scene = options.getScene();
      isPinching = true;
      touchTapStart = undefined;
      const p1 = event.touches[0]!;
      const p2 = event.touches[1]!;
      const center = touchCenter(p1, p2);
      const localCenter = clientPointToLocal(target, { clientX: center.x, clientY: center.y });

      if (!pointInRect(localCenter.x, localCenter.y, scene.plotArea) || !hasEnabledTouchGesture(options)) {
        isPinching = false;
        prevDistance = 0;
        return;
      }

      event.preventDefault();
      prevDistance = Math.hypot(p1.clientX - p2.clientX, p1.clientY - p2.clientY);
      prevCenter = center;
    } else if (event.touches.length === 1) {
      isPinching = false;
      prevDistance = 0;
      const touch = event.touches[0]!;
      const point = clientPointToLocal(target, touch);
      touchTapStart = pointInRect(point.x, point.y, options.getScene().plotArea)
        ? { x: touch.clientX, y: touch.clientY, time: Date.now() }
        : undefined;
    } else {
      isPinching = false;
      touchTapStart = undefined;
    }
  };

  const touchMove = (event: TouchEvent) => {
    if (event.touches.length === 1 && touchTapStart) {
      const touch = event.touches[0]!;
      if (pointerDragDistance(touchTapStart, { x: touch.clientX, y: touch.clientY }) > TAP_MAX_DISTANCE_PX) {
        touchTapStart = undefined;
      }
    }

    if (event.touches.length === 2 && isPinching && prevDistance > 0) {
      event.preventDefault();

      const p1 = event.touches[0]!;
      const p2 = event.touches[1]!;
      const currentDistance = Math.hypot(p1.clientX - p2.clientX, p1.clientY - p2.clientY);
      const currentCenter = touchCenter(p1, p2);

      if (currentDistance > 0) {
        const scale = prevDistance / currentDistance;
        const scene = options.getScene();
        const zoomSpec = resolveZoomSpec(options.getZoomSpec());
        const panSpec = resolvePanSpec(options.getPanSpec());

        // 1. Pan centroid translation
        if (panSpec && panSpec.drag !== false && panSpec.touch !== false) {
          const deltaX = currentCenter.x - prevCenter.x;
          const deltaY = currentCenter.y - prevCenter.y;
          const is2DPan = (panSpec.mode === "xy") || (resolveSpec(options.getSpec())?.mode === "xy");

          const panDeltaX = -deltaX / scene.plotArea.width;
          const panDeltaY = deltaY / scene.plotArea.height;

          if (is2DPan) {
            options.onPan(panDeltaX, panDeltaY);
          } else {
            const primaryAxis = scene.dataFocusAxis ?? "x";
            if (primaryAxis === "y") {
              options.onPan(0, panDeltaY);
            } else {
              options.onPan(panDeltaX, 0);
            }
          }
        }

        // 2. Zoom around centroid
        if (zoomSpec && zoomSpec.touch !== false) {
          const bounds = target.getBoundingClientRect();
          const localCenterX = currentCenter.x - bounds.left;
          const localCenterY = currentCenter.y - bounds.top;

          const centerX = (localCenterX - scene.plotArea.x) / scene.plotArea.width;
          const centerY = 1 - (localCenterY - scene.plotArea.y) / scene.plotArea.height;

          if (zoomSpec.mode === "xy") {
            options.onZoom(
              clamp(centerX, 0, 1),
              scale,
              clamp(centerY, 0, 1),
              scale
            );
          } else {
            const primaryAxis = scene.dataFocusAxis ?? "x";
            if (primaryAxis === "y") {
              options.onZoom(0.5, 1, clamp(centerY, 0, 1), scale);
            } else {
              options.onZoom(clamp(centerX, 0, 1), scale);
            }
          }
        }
      }

      prevDistance = currentDistance;
      prevCenter = currentCenter;
    }
  };

  const touchEnd = (event: TouchEvent) => {
    if (event.touches.length < 2) {
      if (isPinching) {
        options.onPanEnd?.();
      }
      isPinching = false;
      prevDistance = 0;
    }

    if (event.touches.length === 0 && event.changedTouches.length === 1 && touchTapStart) {
      const touch = event.changedTouches[0]!;
      const now = Date.now();
      const point = clientPointToLocal(target, touch);
      const tapDistance = pointerDragDistance(touchTapStart, { x: touch.clientX, y: touch.clientY });
      const isTap = now - touchTapStart.time <= TAP_MAX_DURATION_MS &&
        tapDistance <= TAP_MAX_DISTANCE_PX &&
        pointInRect(point.x, point.y, options.getScene().plotArea);

      if (isTap && lastTap && now - lastTap.time <= DOUBLE_TAP_MS) {
        const doubleTapDistance = pointerDragDistance(lastTap, { x: touch.clientX, y: touch.clientY });
        if (doubleTapDistance <= DOUBLE_TAP_MAX_DISTANCE_PX) {
          event.preventDefault();
          options.onClear();
          lastTap = undefined;
          touchTapStart = undefined;
          return;
        }
      }

      lastTap = isTap ? { x: touch.clientX, y: touch.clientY, time: now } : undefined;
      touchTapStart = undefined;
    }
  };

  target.addEventListener("pointerdown", pointerDown);
  target.addEventListener("pointermove", pointerMoveCursor);
  target.addEventListener("pointerleave", resetCursor);
  target.addEventListener("wheel", wheel, { passive: false });
  target.addEventListener("dblclick", doubleClick);
  target.addEventListener("contextmenu", contextMenu);
  target.addEventListener("touchstart", touchStart, { passive: false });
  target.addEventListener("touchmove", touchMove, { passive: false });
  target.addEventListener("touchend", touchEnd);
  target.addEventListener("touchcancel", touchEnd);

  return {
    destroy() {
      target.removeEventListener("pointerdown", pointerDown);
      target.removeEventListener("pointermove", pointerMoveCursor);
      target.removeEventListener("pointerleave", resetCursor);
      target.removeEventListener("wheel", wheel);
      target.removeEventListener("dblclick", doubleClick);
      target.removeEventListener("contextmenu", contextMenu);
      target.removeEventListener("touchstart", touchStart);
      target.removeEventListener("touchmove", touchMove);
      target.removeEventListener("touchend", touchEnd);
      target.removeEventListener("touchcancel", touchEnd);
      overlay.remove();
      target.style.position = originalPosition;
      target.style.cursor = originalCursor;
      target.style.touchAction = originalTouchAction;
    }
  };

  function resetCursor(): void {
    target.style.cursor = originalCursor;
  }
}

function resolveSpec(spec: SelectionSpec | false | undefined): SelectionSpec | undefined {
  if (!spec || spec.enabled === false) {
    return undefined;
  }

  return spec;
}

function resolveZoomSpec(spec: ZoomSpec | false | undefined): ZoomSpec | undefined {
  if (!spec || spec.enabled === false) {
    return undefined;
  }

  return spec;
}

function resolvePanSpec(spec: PanSpec | false | undefined): PanSpec | undefined {
  if (!spec || spec.enabled === false) {
    return undefined;
  }

  return spec;
}

function hasEnabledTouchGesture(options: SelectionControllerOptions): boolean {
  const zoomSpec = resolveZoomSpec(options.getZoomSpec());
  const panSpec = resolvePanSpec(options.getPanSpec());

  return (zoomSpec !== undefined && zoomSpec.touch !== false) ||
    (panSpec !== undefined && panSpec.drag !== false && panSpec.touch !== false);
}

function resolveTouchAction(options: SelectionControllerOptions, fallback: string): string {
  const selectionSpec = resolveSpec(options.getSpec());
  const zoomSpec = resolveZoomSpec(options.getZoomSpec());
  const panSpec = resolvePanSpec(options.getPanSpec());

  if (zoomSpec && zoomSpec.touch !== false) {
    return "none";
  }

  if (selectionSpec) {
    return "none";
  }

  if (panSpec && panSpec.drag !== false && panSpec.touch !== false) {
    const primaryAxis = options.getScene().dataFocusAxis ?? "x";

    return panSpec.mode === "xy"
      ? "none"
      : primaryAxis === "y"
        ? "pan-x"
        : "pan-y";
  }

  return fallback;
}

function shouldStartPointerPan(
  event: PointerEvent,
  selectionSpec: SelectionSpec | undefined,
  dragInteraction: "selection" | "pan"
): boolean {
  if (event.pointerType === "touch") {
    return true;
  }

  if (event.button === 1 || event.button === 2 || event.altKey || event.metaKey || event.ctrlKey) {
    return true;
  }

  if (dragInteraction === "pan") {
    return event.button === 0;
  }

  return event.button === 0 && !selectionSpec;
}

function shouldEndPointerPan(event: PointerEvent, initiatingButton: number): boolean {
  if (event.pointerType !== "mouse") {
    return false;
  }

  if (event.buttons === 0) {
    return true;
  }

  const mask = initiatingButton === 1
    ? 4
    : initiatingButton === 2
      ? 2
      : 1;

  return (event.buttons & mask) === 0;
}

function safelySetPointerCapture(target: HTMLElement, pointerId: number): void {
  try {
    target.setPointerCapture(pointerId);
  } catch {
    // Some browsers do not allow capture for all secondary-button sequences.
  }
}

function safelyReleasePointerCapture(target: HTMLElement, pointerId: number): void {
  try {
    if (target.hasPointerCapture(pointerId)) {
      target.releasePointerCapture(pointerId);
    }
  } catch {
    // Ignore release races when the browser already cancelled capture.
  }
}

function startPointerPan(
  target: HTMLElement,
  event: PointerEvent,
  options: SelectionControllerOptions,
  checkPinch: () => boolean,
  suppressContextMenu: () => void
): void {
  const scene = options.getScene();
  const start = toLocalPoint(target, event);
  const initiatingButton = event.button;

  if (!pointInRect(start.x, start.y, scene.plotArea)) {
    return;
  }

  event.preventDefault();
  if (initiatingButton === 2 || event.ctrlKey) {
    suppressContextMenu();
  }
  safelySetPointerCapture(target, event.pointerId);
  const previousCursor = target.style.cursor;

  const selectionSpec = resolveSpec(options.getSpec());
  const panSpec = resolvePanSpec(options.getPanSpec());
  const is2DPanning = (panSpec?.mode === "xy") || (selectionSpec?.mode === "xy");

  target.style.cursor = "grabbing";

  if (is2DPanning) {
    let previousX = event.clientX;
    let previousY = event.clientY;

    const pointerMove = (moveEvent: PointerEvent) => {
      if (shouldEndPointerPan(moveEvent, initiatingButton)) {
        pointerUp(moveEvent);
        return;
      }
      if (checkPinch()) {
        pointerUp(moveEvent);
        return;
      }
      const deltaX = moveEvent.clientX - previousX;
      const deltaY = moveEvent.clientY - previousY;

      previousX = moveEvent.clientX;
      previousY = moveEvent.clientY;

      const panDeltaX = -deltaX / scene.plotArea.width;
      const panDeltaY = deltaY / scene.plotArea.height;

      options.onPan(panDeltaX, panDeltaY);
    };

    const pointerUp = (upEvent: PointerEvent) => {
      safelyReleasePointerCapture(target, upEvent.pointerId);
      target.removeEventListener("pointermove", pointerMove);
      target.removeEventListener("pointerup", pointerUp);
      target.removeEventListener("pointercancel", pointerUp);
      target.style.cursor = previousCursor;
      options.onPanEnd?.();
    };

    target.addEventListener("pointermove", pointerMove);
    target.addEventListener("pointerup", pointerUp);
    target.addEventListener("pointercancel", pointerUp);
  } else {
    const primaryAxis = scene.dataFocusAxis ?? "x";
    let previousPosition = primaryAxis === "y" ? event.clientY : event.clientX;

    const pointerMove = (moveEvent: PointerEvent) => {
      if (shouldEndPointerPan(moveEvent, initiatingButton)) {
        pointerUp(moveEvent);
        return;
      }
      if (checkPinch()) {
        pointerUp(moveEvent);
        return;
      }
      const position = primaryAxis === "y" ? moveEvent.clientY : moveEvent.clientX;
      const delta = position - previousPosition;

      previousPosition = position;
      const panDelta = primaryAxis === "y"
        ? delta / scene.plotArea.height
        : -delta / scene.plotArea.width;

      if (primaryAxis === "y") {
        options.onPan(0, panDelta);
      } else {
        options.onPan(panDelta, 0);
      }
    };

    const pointerUp = (upEvent: PointerEvent) => {
      safelyReleasePointerCapture(target, upEvent.pointerId);
      target.removeEventListener("pointermove", pointerMove);
      target.removeEventListener("pointerup", pointerUp);
      target.removeEventListener("pointercancel", pointerUp);
      target.style.cursor = previousCursor;
      options.onPanEnd?.();
    };

    target.addEventListener("pointermove", pointerMove);
    target.addEventListener("pointerup", pointerUp);
    target.addEventListener("pointercancel", pointerUp);
  }
}

function resolveWheelZoomSensitivity(zoomSpec: ZoomSpec, event: WheelEvent): number {
  const base = zoomSpec.sensitivity ?? DEFAULT_ZOOM_WHEEL_SENSITIVITY;

  return event.ctrlKey ? base * PINCH_ZOOM_SENSITIVITY_MULTIPLIER : base;
}

function normalizeWheelDelta(event: WheelEvent): number {
  const lineHeight = 16;
  const pageHeight = window.innerHeight || 800;
  const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE
    ? lineHeight
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
      ? pageHeight
      : 1;

  return event.deltaY * unit;
}

function normalizeWheelDeltaX(event: WheelEvent): number {
  const lineHeight = 16;
  const pageWidth = window.innerWidth || 800;
  const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE
    ? lineHeight
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
      ? pageWidth
      : 1;

  return event.deltaX * unit;
}

function resolveWheelIntent(event: WheelEvent): { kind: "pan" | "zoom"; delta: number } {
  const deltaX = normalizeWheelDeltaX(event);
  const deltaY = normalizeWheelDelta(event);

  if (event.shiftKey && Math.abs(deltaY) > 0) {
    return { kind: "pan", delta: deltaY };
  }

  if (Math.abs(deltaX) > Math.abs(deltaY)) {
    return { kind: "pan", delta: deltaX };
  }

  return { kind: "zoom", delta: deltaY };
}

function resolveVerticalPanIntent(event: WheelEvent): { kind: "pan"; delta: number } {
  const deltaX = normalizeWheelDeltaX(event);
  const deltaY = normalizeWheelDelta(event);

  return {
    kind: "pan",
    delta: Math.abs(deltaY) >= Math.abs(deltaX) ? deltaY : deltaX
  };
}

function showOverlay(
  overlay: HTMLDivElement,
  spec: SelectionSpec,
  primaryAxis: "x" | "y",
  plotArea: { x: number; y: number; width: number; height: number },
  startX: number,
  currentX: number,
  startY: number,
  currentY: number
): void {
  const primaryOnly = spec.mode !== "xy";
  const left = primaryOnly && primaryAxis === "y" ? plotArea.x : Math.min(startX, currentX);
  const right = primaryOnly && primaryAxis === "y" ? plotArea.x + plotArea.width : Math.max(startX, currentX);
  const top = spec.mode === "xy" || primaryAxis === "y" ? Math.min(startY, currentY) : plotArea.y;
  const bottom = spec.mode === "xy" || primaryAxis === "y" ? Math.max(startY, currentY) : plotArea.y + plotArea.height;

  overlay.style.display = "block";
  overlay.style.left = `${left}px`;
  overlay.style.top = `${top}px`;
  overlay.style.width = `${Math.max(1, right - left)}px`;
  overlay.style.height = `${Math.max(1, bottom - top)}px`;
  overlay.style.background = spec.fill ?? "rgba(56, 128, 145, 0.16)";
  overlay.style.border = `1px solid ${spec.stroke ?? "rgba(56, 128, 145, 0.85)"}`;
}

function selectionPixelSpan(
  spec: SelectionSpec,
  primaryAxis: "x" | "y",
  startX: number,
  currentX: number,
  startY: number,
  currentY: number
): number {
  const xSpan = Math.abs(currentX - startX);
  const ySpan = Math.abs(currentY - startY);

  if (primaryAxis === "y" && spec.mode !== "xy") {
    return ySpan;
  }

  return spec.mode === "xy" ? Math.max(xSpan, ySpan) : xSpan;
}

function hideOverlay(overlay: HTMLDivElement): void {
  overlay.style.display = "none";
}

function toLocalPoint(target: HTMLElement, event: MouseEvent): { x: number; y: number } {
  const bounds = target.getBoundingClientRect();

  return {
    x: event.clientX - bounds.left,
    y: event.clientY - bounds.top
  };
}

function clientPointToLocal(target: HTMLElement, point: { clientX: number; clientY: number }): { x: number; y: number } {
  const bounds = target.getBoundingClientRect();

  return {
    x: point.clientX - bounds.left,
    y: point.clientY - bounds.top
  };
}

function touchCenter(a: Touch, b: Touch): { x: number; y: number } {
  return {
    x: (a.clientX + b.clientX) / 2,
    y: (a.clientY + b.clientY) / 2
  };
}

function pointerDragDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pointInRect(x: number, y: number, rect: { x: number; y: number; width: number; height: number }): boolean {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
