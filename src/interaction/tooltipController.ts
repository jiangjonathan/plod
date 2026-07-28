import type { Primitive, Rect, SceneGraph, TooltipContent, TooltipMarker, TooltipSpec } from "../core/types";
import type { Theme } from "../themes/types";
import { SYSTEM_FONT_FAMILY } from "../themes/defaultTheme";
import { layoutTooltip, splitTooltipLine, TOOLTIP_TITLE_MONO_FONT } from "./tooltipLayout";
import { drawScatterPoint } from "../renderers/scatterPoint";
import { isClientPointOverPlotUiChrome, isPlotUiChrome } from "./plotUiChrome";

export type TooltipController = {
  refresh(): void;
  hide(): void;
  setSuspended(suspended: boolean): void;
  destroy(): void;
};

export function attachTooltipController(
  target: HTMLElement,
  getScene: () => SceneGraph,
  getTheme: () => Theme,
  getSpec: () => TooltipSpec | false | undefined
): TooltipController {
  const tooltip = document.createElement("div");
  const previousPosition = target.style.position;
  let isSuspended = false;
  const ownerDocument = target.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  let lastHit: TooltipHit | undefined;
  let lastClientPoint: { x: number; y: number } | undefined;
  let activePointerStart: { x: number; y: number } | undefined;
  let activePointerId: number | undefined;
  let lastRenderedSignature: string | undefined;
  let frame: number | undefined;
  let globalTracking = false;
  const positionedRoots = new Map<HTMLElement, string>();

  if (getComputedStyle(target).position === "static") {
    target.style.position = "relative";
  }

  tooltip.style.position = "absolute";
  tooltip.style.pointerEvents = "none";
  tooltip.style.display = "none";
  tooltip.style.background = "#ffffff";
  tooltip.style.border = "1px solid #eef2f7";
  tooltip.style.color = "#0f172a";
  tooltip.style.boxSizing = "border-box";
  tooltip.style.borderRadius = "12px";
  tooltip.style.whiteSpace = "nowrap";
  tooltip.style.zIndex = "1002";
  target.ownerDocument.body.append(tooltip);

  const syncTooltipRoot = () => {
    const fullscreenElement = ownerDocument.fullscreenElement;
    const nextRoot = fullscreenElement instanceof HTMLElement && fullscreenElement.contains(target)
      ? fullscreenElement
      : resolveTooltipRoot(target);

    if (tooltip.parentElement !== nextRoot) {
      const rootStyle = ownerWindow?.getComputedStyle(nextRoot);
      if (nextRoot !== ownerDocument.body && rootStyle?.position === "static") {
        positionedRoots.set(nextRoot, nextRoot.style.position);
        nextRoot.style.position = "relative";
      }
      nextRoot.append(tooltip);
    }
  };

  const move = (event: PointerEvent) => {
    const bounds = target.getBoundingClientRect();
    if (
      !pointInClientBounds(event.clientX, event.clientY, bounds) ||
      isPlotUiChrome(event.target) ||
      isSuspended
    ) {
      leave();
      return;
    }

    lastClientPoint = { x: event.clientX, y: event.clientY };
    startGlobalTracking();

    if (activePointerId !== undefined) {
      if (activePointerStart && Math.hypot(activePointerStart.x - lastClientPoint.x, activePointerStart.y - lastClientPoint.y) > 3) {
        hide();
      }
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
  const refresh = () => {
    if (isSuspended) {
      hide();
      return;
    }

    if (
      lastClientPoint &&
      isClientPointOverPlotUiChrome(lastClientPoint.x, lastClientPoint.y, ownerDocument)
    ) {
      leave();
      return;
    }

    syncTooltipRoot();
    const scene = getScene();
    const point = resolveLocalPoint(scene);
    if (!point) {
      hide();
      return;
    }

    const bounds = target.getBoundingClientRect();
    const { x, y } = point;
    const hit = hitTest(scene.primitives, x, y);

    if (hit) {
      lastHit = hit;
    }

    if (!lastHit || !pointInTooltipPersistenceBand(lastHit.hitRect, x, y)) {
      lastHit = undefined;
      tooltip.style.display = "none";
      lastRenderedSignature = undefined;
      return;
    }

    if (lastRenderedSignature !== lastHit.signature) {
      const specForRender = getSpec();
      const useTabular =
        specForRender === false ||
        !(specForRender && typeof specForRender === "object" && specForRender.tabularNumbers === false);
      const titleFontMode =
        specForRender && typeof specForRender === "object" && specForRender.titleFont === "regular"
          ? "regular"
          : "mono";
      renderTooltip(tooltip, lastHit.content, getTheme(), useTabular, titleFontMode);
      lastRenderedSignature = lastHit.signature;
    }

    const spec = getSpec();
    // getSpec() may return false during viewport animation — don't strip styles.
    if (spec !== false) {
      if (spec && typeof spec === "object" && spec.shadow) {
        tooltip.style.boxShadow = "0 10px 16px -14px rgba(15, 23, 42, 0.32)";
      } else {
        tooltip.style.boxShadow = "none";
      }
      tooltip.style.fontVariantNumeric = spec && typeof spec === "object" && spec.tabularNumbers === false
        ? "normal"
        : "tabular-nums";
      tooltip.style.fontFeatureSettings = spec && typeof spec === "object" && spec.tabularNumbers === false
        ? "normal"
        : '"tnum"';
    }
    placeTooltip(
      tooltip,
      x,
      y,
      bounds.width,
      bounds.height,
      lastHit.bounds,
      resolvePosition(spec === false ? undefined : spec),
      lastHit.placement,
      target
    );
  };
  const leave = () => {
    activePointerId = undefined;
    activePointerStart = undefined;
    stopGlobalTracking();
    hide();
  };
  const globalMove = (event: PointerEvent) => {
    if (!lastClientPoint && !lastHit) {
      return;
    }

    const bounds = target.getBoundingClientRect();
    if (!pointInClientBounds(event.clientX, event.clientY, bounds)) {
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
  const hide = () => {
    lastHit = undefined;
    lastRenderedSignature = undefined;
    lastClientPoint = undefined;
    if (frame !== undefined) {
      cancelAnimationFrame(frame);
      frame = undefined;
    }
    tooltip.style.display = "none";
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
  const resolveLocalPoint = (scene: SceneGraph): { x: number; y: number } | undefined => {
    if (!lastClientPoint) {
      return undefined;
    }

    const bounds = target.getBoundingClientRect();
    if (!pointInClientBounds(lastClientPoint.x, lastClientPoint.y, bounds)) {
      lastClientPoint = undefined;
      return undefined;
    }

    const point = {
      x: lastClientPoint.x - bounds.left,
      y: lastClientPoint.y - bounds.top
    };

    return pointInBounds(scene.plotArea, point.x, point.y) ? point : undefined;
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
  ownerDocument.addEventListener("fullscreenchange", syncTooltipRoot);

  return {
    refresh,
    hide,
    setSuspended(suspended) {
      isSuspended = suspended;
      if (suspended) {
        hide();
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
      ownerDocument.removeEventListener("fullscreenchange", syncTooltipRoot);
      tooltip.remove();
      positionedRoots.forEach((position, root) => {
        root.style.position = position;
      });
      target.style.position = previousPosition;
    }
  };
}

/** Keep overlays in the outermost stacking context that contains their plot. */
function resolveTooltipRoot(target: HTMLElement): HTMLElement {
  const body = target.ownerDocument.body;
  let root = body;
  let ancestor = target.parentElement;

  while (ancestor && ancestor !== body) {
    const style = getComputedStyle(ancestor);
    const positionedWithZIndex = style.zIndex !== "auto" && style.position !== "static";
    const createsStackingContext =
      positionedWithZIndex ||
      style.position === "fixed" ||
      style.position === "sticky" ||
      style.transform !== "none" ||
      style.perspective !== "none" ||
      style.filter !== "none" ||
      style.isolation === "isolate" ||
      Number.parseFloat(style.opacity) < 1;

    if (createsStackingContext) root = ancestor;
    ancestor = ancestor.parentElement;
  }

  return root;
}

type TooltipHit = {
  signature: string;
  content: TooltipContent;
  bounds: Rect;
  hitRect: Rect;
  placement?: "bar-top" | "bar-end-right" | "bar-end-left";
};

function hitTest(primitives: readonly Primitive[], x: number, y: number): TooltipHit | undefined {
  for (let index = primitives.length - 1; index >= 0; index -= 1) {
    const primitive = primitives[index];

    if (primitive?.kind === "rect" && (primitive.hitTest || primitive.tooltip) && pointInBounds(primitive, x, y)) {
      if (primitive.hitTest) {
        const hit = primitive.hitTest(x, y);

        if (hit && hit.tooltip) {
          const bounds = hit.tooltipBounds ?? {
            x: hit.x,
            y: hit.y,
            width: hit.width,
            height: hit.height
          };

          return {
            signature: tooltipSignature(hit.tooltip),
            content: hit.tooltip,
            ...(hit.tooltipPlacement ? { placement: hit.tooltipPlacement } : {}),
            bounds: {
              x: bounds.x,
              y: bounds.y,
              width: bounds.width,
              height: bounds.height
            },
            hitRect: {
              x: hit.x,
              y: hit.y,
              width: hit.width,
              height: hit.height
            }
          };
        }
      } else if (primitive.tooltip) {
        const bounds = primitive.tooltipBounds ?? primitive;

        return {
          signature: tooltipSignature(primitive.tooltip),
          content: primitive.tooltip,
          ...(primitive.tooltipPlacement ? { placement: primitive.tooltipPlacement } : {}),
          bounds: {
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height
          },
          hitRect: {
            x: primitive.x,
            y: primitive.y,
            width: primitive.width,
            height: primitive.height
          }
        };
      }
    }

    if (primitive?.kind === "point-cloud") {
      const hit = primitive.hitTest?.(x, y);

      if (hit?.tooltip) {
        const radius = Math.max(primitive.radius, 6);
        const bounds = {
          x: hit.x - radius,
          y: hit.y - radius,
          width: radius * 2,
          height: radius * 2
        };

        return {
          signature: tooltipSignature(hit.tooltip),
          content: hit.tooltip,
          bounds,
          hitRect: bounds
        };
      }
    }
  }

  return undefined;
}

function tooltipSignature(content: TooltipContent): string {
  return `${content.title ?? ""}\n${markerSignature(content.titleMarker)}\n${content.lines.join("\n")}\n${content.markers?.map(markerSignature).join(",") ?? ""}`;
}

function markerSignature(marker: TooltipMarker | undefined): string {
  if (!marker) {
    return "";
  }

  return typeof marker === "string" ? marker : `${marker.color}:${marker.shape ?? "circle"}`;
}

function pointInBounds(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

function pointInClientBounds(x: number, y: number, bounds: DOMRect): boolean {
  return x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
}

function pointInTooltipPersistenceBand(rect: Rect, x: number, y: number): boolean {
  const pad = 8;

  return x >= rect.x - pad && x <= rect.x + rect.width + pad && y >= rect.y - pad && y <= rect.y + rect.height + pad;
}

function renderTooltip(
  element: HTMLElement,
  content: TooltipContent,
  theme: Theme,
  tabularNumbers = true,
  titleFontMode: "mono" | "regular" = "mono"
): void {
  const layout = layoutTooltip(content, theme, titleFontMode);

  element.style.display = "block";
  element.style.width = `${layout.width}px`;
  element.style.minHeight = "";
  element.style.padding = `${layout.paddingY}px ${layout.paddingX}px`;
  // Set font longhands so we don't clobber font-variant-numeric via the font shorthand.
  element.style.fontSize = `${Math.max(10, theme.typography.fontSize - 1)}px`;
      element.style.fontFamily = SYSTEM_FONT_FAMILY;
  element.style.fontWeight = "normal";
  element.style.fontVariantNumeric = tabularNumbers ? "tabular-nums" : "normal";
  element.style.fontFeatureSettings = tabularNumbers ? '"tnum"' : "normal";
  element.style.lineHeight = `${layout.lineHeight}px`;
  element.style.whiteSpace = "nowrap";
  element.replaceChildren();

  if (layout.title) {
    const title = document.createElement("div");
    const marker = markerElement(content.titleMarker);
    const titlePair = splitTooltipLine(layout.title);

    title.style.display = "flex";
    title.style.alignItems = "center";
    title.style.fontWeight = "600";
    title.style.fontFamily = titleFontMode === "mono" ? TOOLTIP_TITLE_MONO_FONT : theme.typography.fontFamily;
    title.style.marginBottom = `${layout.lineGap}px`;
    if (titlePair) {
      const nameWrap = document.createElement("span");
      const name = document.createElement("span");
      const value = document.createElement("span");

      title.style.justifyContent = "space-between";
      title.style.gap = "20px";
      nameWrap.style.display = "inline-flex";
      nameWrap.style.alignItems = "center";
      nameWrap.style.gap = "6px";
      name.textContent = titlePair.name;
      value.textContent = titlePair.value;
      value.style.textAlign = "right";
      value.style.marginLeft = "auto";
      if (marker) {
        nameWrap.append(marker);
      }
      nameWrap.append(name);
      title.append(nameWrap, value);
    } else if (marker) {
      // Same row chrome as X/Y: fixed label column (swatch) + value column (hex).
      const nameWrap = document.createElement("span");
      const value = document.createElement("span");
      title.style.justifyContent = "flex-start";
      title.style.gap = "6px";
      nameWrap.style.display = "inline-flex";
      nameWrap.style.alignItems = "center";
      nameWrap.style.justifyContent = "center";
      nameWrap.style.boxSizing = "border-box";
      nameWrap.style.width = "12px";
      nameWrap.style.minWidth = "12px";
      nameWrap.style.flex = "0 0 12px";
      marker.style.flex = "0 0 auto";
      marker.style.margin = "0";
      value.textContent = layout.title;
      value.style.textAlign = "left";
      value.style.fontFamily = titleFontMode === "mono" ? TOOLTIP_TITLE_MONO_FONT : theme.typography.fontFamily;
      nameWrap.append(marker);
      title.append(nameWrap, value);
    } else {
      title.append(document.createTextNode(layout.title));
    }
    element.append(title);
  }

  for (const [index, line] of layout.lines.entries()) {
    const row = document.createElement("div");
    const isDimensionRow = !layout.title && index === 0;
    const pair = isDimensionRow ? undefined : splitTooltipLine(line);

    if (pair) {
      const name = document.createElement("span");
      const value = document.createElement("span");
      const marker = markerElement(content.markers?.[index]);
      const nameWrap = document.createElement("span");

      row.style.display = "flex";
      row.style.justifyContent = "space-between";
      row.style.gap = "20px";
      nameWrap.style.display = "inline-flex";
      nameWrap.style.alignItems = "center";
      nameWrap.style.justifyContent = "center";
      nameWrap.style.gap = "6px";
      nameWrap.style.boxSizing = "border-box";
      nameWrap.style.flex = "0 0 auto";
      if (!marker) {
        // Match title swatch column width so X/Y line up with the color dot.
        nameWrap.style.width = "12px";
        nameWrap.style.minWidth = "12px";
        nameWrap.style.flex = "0 0 12px";
      }
      name.textContent = pair.name;
      name.style.textAlign = "left";
      value.textContent = pair.value;
      value.style.textAlign = "right";
      value.style.marginLeft = "auto";
      if (marker) {
        nameWrap.append(marker);
      }
      nameWrap.append(name);
      row.append(nameWrap, value);
    } else {
      const marker = markerElement(content.markers?.[index]);
      if (marker) {
        row.style.display = "flex";
        row.style.alignItems = "center";
        row.style.gap = "6px";
        row.append(marker, document.createTextNode(line));
      } else {
        row.textContent = line;
      }
      if (isDimensionRow) {
        row.style.fontWeight = "600";
      }
    }

    element.append(row);
  }
}

function markerElement(markerSpec: TooltipMarker | undefined): HTMLElement | undefined {
  if (!markerSpec) {
    return undefined;
  }

  if (typeof markerSpec !== "string") {
    const canvas = document.createElement("canvas");
    const pixelRatio = window.devicePixelRatio || 1;
    const cssSize = 12;
    const radius = 4.25;

    canvas.width = Math.ceil(cssSize * pixelRatio);
    canvas.height = Math.ceil(cssSize * pixelRatio);
    canvas.style.width = `${cssSize}px`;
    canvas.style.height = `${cssSize}px`;
    canvas.style.display = "inline-block";
    canvas.style.flex = "0 0 auto";

    const context = canvas.getContext("2d");
    if (context) {
      context.scale(pixelRatio, pixelRatio);
      const shape = markerSpec.shape ?? "circle";
      const opticalY = shape === "triangle" ? cssSize / 2 + 0.7 : cssSize / 2;
      drawScatterPoint(context, cssSize / 2, opticalY, radius, markerSpec.color, shape);
    }

    return canvas;
  }

  const marker = document.createElement("span");
  marker.style.display = "inline-block";
  marker.style.width = "10px";
  marker.style.height = "10px";
  marker.style.borderRadius = "50%";
  marker.style.background = markerSpec;
  marker.style.flex = "0 0 auto";
  marker.style.margin = "0";

  return marker;
}

function placeTooltip(
  element: HTMLElement,
  x: number,
  y: number,
  width: number,
  height: number,
  hitBounds: Rect,
  mode: TooltipSpec["position"],
  placement?: "bar-top" | "bar-end-right" | "bar-end-left",
  target?: HTMLElement
): void {
  const offset = 12;
  const resolvedPlacement = mode === "bar-top" ? placement ?? "bar-top" : undefined;
  const anchorX = resolvedPlacement === "bar-top"
    ? hitBounds.x + hitBounds.width / 2 - element.offsetWidth / 2
    : resolvedPlacement === "bar-end-right"
      ? hitBounds.x + hitBounds.width + offset
      : resolvedPlacement === "bar-end-left"
        ? hitBounds.x - element.offsetWidth - offset
        : x + offset;
  const anchorY = resolvedPlacement === "bar-top"
    ? hitBounds.y - element.offsetHeight - offset
    : resolvedPlacement === "bar-end-right" || resolvedPlacement === "bar-end-left"
      ? hitBounds.y + hitBounds.height / 2 - element.offsetHeight / 2
      : y + offset;

  if (target) {
    const rect = target.getBoundingClientRect();
    const offsetRoot = element.parentElement instanceof HTMLElement && element.parentElement !== target.ownerDocument.body
      ? element.parentElement.getBoundingClientRect()
      : undefined;
    const pageX = offsetRoot ? rect.left - offsetRoot.left : rect.left + window.scrollX;
    const pageY = offsetRoot ? rect.top - offsetRoot.top : rect.top + window.scrollY;

    let tooltipLeft = pageX + anchorX;
    let tooltipTop = pageY + anchorY;

    // Constrain to window viewport boundary to prevent going off-screen
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    if (rect.left + anchorX + element.offsetWidth > viewportWidth) {
      tooltipLeft = (offsetRoot ? viewportWidth - offsetRoot.left : viewportWidth + window.scrollX) - element.offsetWidth - 8;
    }
    const minLeft = offsetRoot ? 8 : window.scrollX + 8;
    const minTop = offsetRoot ? 8 : window.scrollY + 8;

    if (tooltipLeft < minLeft) {
      tooltipLeft = minLeft;
    }

    if (rect.top + anchorY + element.offsetHeight > viewportHeight) {
      tooltipTop = (offsetRoot ? viewportHeight - offsetRoot.top : viewportHeight + window.scrollY) - element.offsetHeight - 8;
    }
    if (tooltipTop < minTop) {
      tooltipTop = minTop;
    }

    element.style.left = `${tooltipLeft}px`;
    element.style.top = `${tooltipTop}px`;
  } else {
    const left = Math.min(width - element.offsetWidth, anchorX);
    const top = Math.min(height - element.offsetHeight, anchorY);

    element.style.left = `${Math.max(0, left)}px`;
    element.style.top = `${Math.max(0, top)}px`;
  }
}

function resolvePosition(spec: TooltipSpec | false | undefined): TooltipSpec["position"] {
  return spec === false ? "cursor" : spec?.position ?? "cursor";
}
