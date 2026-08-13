import { generateSettingsHtml, SCATTER_SETTING_IDS } from "../interaction/settingsHtml";
import { SETTINGS_CSS } from "../interaction/settingsStyle";
import { encodeAxes, encodeFrame, resolveAxes, encodeGridlines, niceLinearDomain } from "./axes";
import type { AxisTickFadeState } from "./axes";
import { resolveEdgeBlurSize, resolveMarkKinds, resolvePlotEdgeBlur } from "./edgeBlur";
import { computeLayout, PLOT_CONTROL_BUTTON_SIZE, resolveAxisTitlePlotOffset } from "../layout/computeLayout";
import type { Layout } from "../layout/types";
import { attachHoverController } from "../interaction/hoverController";
import { attachPlotChromeHoverGate, isPlotUiChrome } from "../interaction/plotUiChrome";
import { attachSelectionController } from "../interaction/selectionController";
import { attachTooltipController } from "../interaction/tooltipController";
import { canvasRenderer } from "../renderers/canvasRenderer";
import { defaultTheme, SYSTEM_FONT_FAMILY, SYSTEM_MONO_FONT_FAMILY } from "../themes/defaultTheme";
import type { Theme } from "../themes/types";
import type { DataInput, DataSourceResolveRequest, DataSourceView } from "../data/types";
import {
  getPointArrayCategoryCount,
  getPointCount,
  scatterViewMetadata
} from "../data/metadata";
import {
  easeInCubic,
  easeOutCubic,
  ORIGIN_EXTEND_TICK_ANIM_MS,
  resolveAnimationEasing,
  usesLineTriggeredAxisTicks
} from "./animation";
import {
  isScatterGpuAnimationProfile,
  patchScatterPointCloudAnimation
} from "../marks/scatterAnimation";
import { barMark } from "../marks/barMark";
import { lineMark } from "../marks/lineMark";
import { scatterMark, rawPointsCache, appendRawCache } from "../marks/scatterMark";
import type { Accessor } from "../marks/types";
import type {
  AnimationOptions,
  AxisAnimationProfile,
  AxisAnimationState,
  AxesSpec,
  AxisSpec,
  CornerRadii,
  FocusMode,
  HoverState,
  Plot,
  PlotSelection,
  PlotSpec,
  PlotUpdate,
  Primitive,
  RenderOptimizationSpec,
  Rect,
  ScatterHoverEntry,
  ScatterHoverInteraction,
  SceneGraph,
  Size,
  TitleAnimationProfile
} from "./types";

const USE_FOCUS_PREVIEW_FAST_PATH = true;
/** How long after a data append we treat the chart as actively streaming. */
const STREAMING_ACTIVE_MS = 500;
const LIVE_HEADER_HUD_MIN_SCALE = 0.72;
const LIVE_HEADER_HUD_REVEAL_SCALE = 0.76;
const LIVE_HEADER_HUD_FADE_MS = 160;
const LINE_FOCUS_TRANSITION_MS = 140;
let nextPointCloudResizePhase = 0;
let pointCloudResizeFrameTime = Number.NEGATIVE_INFINITY;
let pointCloudResizeFramePhase = 1;

type ExportableCanvasSurface = {
  element: Element;
  glElement?: HTMLCanvasElement;
  hoverElement?: HTMLCanvasElement;
};

function downloadCanvasPng(surface: ExportableCanvasSurface, filename = "plot.png"): void {
  if (!(surface.element instanceof HTMLCanvasElement)) {
    return;
  }

  const baseCanvas = surface.element;
  const exportCanvas = document.createElement("canvas");
  exportCanvas.width = baseCanvas.width;
  exportCanvas.height = baseCanvas.height;
  const context = exportCanvas.getContext("2d");
  if (!context) {
    return;
  }

  context.drawImage(baseCanvas, 0, 0);
  if (surface.glElement && surface.glElement.width > 0 && surface.glElement.height > 0 && getComputedStyle(surface.glElement).display !== "none") {
    context.drawImage(surface.glElement, 0, 0, exportCanvas.width, exportCanvas.height);
  }
  if (surface.hoverElement && surface.hoverElement.width > 0 && surface.hoverElement.height > 0) {
    context.drawImage(surface.hoverElement, 0, 0, exportCanvas.width, exportCanvas.height);
  }

  exportCanvas.toBlob((blob) => {
    if (!blob) {
      return;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, "image/png");
}

function resolvePlotAreaCornerRadii<TDatum>(spec: PlotSpec<TDatum>): CornerRadii | undefined {
  if (spec.frame && typeof spec.frame === "object" && spec.frame.cornerRadius !== undefined) {
    const r = spec.frame.cornerRadius;
    return [r, r, r, r] as const;
  }
  return undefined;
}

function shouldClipPrimitive(p: Primitive, plotArea: Rect): boolean {
  if (p.kind === "rect" && p.stroke === undefined && 
      Math.abs(p.width - plotArea.width) < 0.1 && 
      Math.abs(p.height - plotArea.height) < 0.1) {
    return false;
  }
  if (p.kind === "rect" && p.stroke !== undefined && 
      Math.abs(p.width - plotArea.width) < 0.1 && 
      Math.abs(p.height - plotArea.height) < 0.1) {
    return false;
  }
  if (p.kind === "text") {
    return false;
  }
  if (p.kind === "path") {
    if (p.points.length === 2) {
      const p0 = p.points[0];
      const p1 = p.points[1];
      if (p0 && p1) {
        const dx = Math.abs(p0[0] - p1[0]);
        const dy = Math.abs(p0[1] - p1[1]);
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 20) {
          return false;
        }
      }
    }
  }
  return true;
}

function patchScenePrimitives<TDatum>(scene: SceneGraph, spec: PlotSpec<TDatum>): readonly Primitive[] {
  const radii = resolvePlotAreaCornerRadii(spec);
  const plotArea = scene.plotArea;
  if (!radii || !plotArea) {
    return scene.primitives;
  }
  return scene.primitives.map(p => {
    if (p.kind === "rect" && 
        Math.abs(p.x - plotArea.x) < 0.1 &&
        Math.abs(p.y - plotArea.y) < 0.1 &&
        Math.abs(p.width - plotArea.width) < 0.1 &&
        Math.abs(p.height - plotArea.height) < 0.1 &&
        p.stroke === undefined) {
      return {
        ...p,
        cornerRadii: radii
      };
    }
    if (shouldClipPrimitive(p, plotArea)) {
      return {
        ...p,
        clip: {
          ...(p.clip ?? plotArea),
          cornerRadii: radii
        }
      };
    }
    return p;
  });
}

function applyChartBorderStyles(container: HTMLElement, border: { enabled?: boolean; radius?: number; color?: string; } | undefined): void {
  const targetEl = (container.parentElement && (
    container.parentElement.querySelector(":scope > .resize-handle") !== null ||
    container.parentElement.classList.contains("plot-container") ||
    container.parentElement.classList.contains("hero-chart-container")
  )) ? container.parentElement : container;

  if (border && border.enabled) {
    const radius = border.radius ?? 12;
    const color = border.color ?? "#cbd5e1";
    targetEl.style.border = `1px solid ${color}`;
    targetEl.style.borderRadius = `${radius}px`;
    targetEl.style.overflow = "hidden";
    targetEl.style.setProperty("--chart-radius", `${radius}px`);
    targetEl.style.setProperty("--chart-border", `1px solid ${color}`);
    targetEl.classList.add("rounded");
  } else {
    targetEl.style.border = "none";
    targetEl.style.borderRadius = "0px";
    targetEl.style.setProperty("--chart-radius", "0px");
    targetEl.style.setProperty("--chart-border", "none");
    targetEl.classList.remove("rounded");
  }
}

export function createPlot<TDatum>(container: Element, initialSpec: PlotSpec<TDatum>): Plot<TDatum> {
  // Activity windows — keep in sync so lerp / tick-fade / settle don't disagree.
  const FOCUS_SETTLE_MS = 150;
  const STREAMING_TICK_FADE_MS = 150;
  const STREAMING_DOMAIN_SETTLE_MS = 160;
  const CONTINUOUS_INTERACTION_MS = 200;
  const SERIES_TOGGLE_LERP_MS = 1000;
  let spec: PlotSpec<TDatum> = initialSpec;
  let size = readSize(container, spec);
  let markAnimationProgress = initialSpec.startEmpty ? 0 : 1;
  let axisAnimationProfile: AxisAnimationProfile = initialSpec.axisAnimation ?? initialSpec.presetOptions?.axisAnimationProfile ?? "none";
  let axisAnimationActive = !!initialSpec.startEmpty && axisAnimationProfile !== "none";
  let axisAnimationRuntime: AxisAnimationState | undefined = axisAnimationActive ? {
    profile: axisAnimationProfile,
    progress: 0,
    elapsedMs: 0,
    ...(usesLineTriggeredAxisTicks(axisAnimationProfile) ? {
      lineProgress: 0,
      lineDurationMs: 1,
      tickAnimMs: ORIGIN_EXTEND_TICK_ANIM_MS,
      lineEasing: (t: number) => t
    } : {})
  } : undefined;
  let animationProfile: AnimationOptions["profile"] = "rise";
  let randomFillFade = false;
  let animationFrame: number | undefined;
  let focus: PlotSelection | undefined;
  let skipLerpOnce = false;
  let skipXFocusLerpOnce = false;
  let lastSeriesToggleTime = 0;
  let hover: HoverState | undefined;
  let pinnedLineSeriesIndex: number | undefined;
  let linePinGesture: {
    x: number;
    y: number;
    seriesIndex?: number;
  } | undefined;
  let linePinHoverRefreshFrame: number | undefined;
  let lineFocusTransitionFrame: number | undefined;
  let lineFocusDimProgress = 0;
  let lineFocusEmphasisBySeries = new Map<number, number>();
  let lineFocusTransition: {
    startedAt: number;
    startDimProgress: number;
    targetDimProgress: number;
    startEmphasisBySeries: Map<number, number>;
    targetSeriesIndex?: number;
  } | undefined;
  let scatterHoverAnimFrame: number | undefined;
  let scatterAnimationCache: RenderCache | undefined;
  let scatterAnimationCacheKey: string | undefined;
  const scatterHoverAnimations = new Map<number, {
    index: number;
    progress: number;
    target: number;
    startProgress: number;
    startTime: number;
    durationMs: number;
  }>();
  let cachedBaseAxes: {
    data: readonly TDatum[];
    axes: AxesSpec;
  } | undefined;
  let lastHoverEncodeContext: HoverEncodeContext<TDatum> | undefined;

  // Animated scale-change state
  let smoothedScalingEnabled = initialSpec.smoothedScaling !== false;
  let lastRenderedXDomain: readonly [number, number] | undefined;
  let lastRenderedYDomain: readonly [number, number] | undefined;
  let lastRenderedFocus: PlotSelection | undefined;
  let targetXDomain: readonly [number, number] | undefined;
  let targetYDomain: readonly [number, number] | undefined;
  let lastResolvedFocusForTarget: PlotSelection | undefined;
  let domainAnimFrame: number | undefined;
  let domainAnimGeneration = 0;
  let isViewportAnimating = false;
  /** True while a user focus/window change is lerping X — blocks streamingPin from snapping mid-transition. */
  let focusTransitionActive = false;
  let pendingSelection: PlotSelection | undefined;
  let lastDomainLerpTime: number | undefined;
  let streamingDomainSettleTimer: ReturnType<typeof setTimeout> | undefined;
  let tickFadeFrame: number | undefined;
  let suppressTickFadeUntilResizeSettles = false;
  const prefersReducedMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const tickFadeState: AxisTickFadeState = {
    now: 0,
    durationMs: prefersReducedMotion ? 0 : 220,
    appearedAt: new Map(),
    activeKeys: new Set(),
    initialized: false
  };
  const EDGE_BLUR_FADE_MS = prefersReducedMotion ? 0 : 200;
  let edgeBlurFadeFrame: number | undefined;
  let edgeBlurFadeLastTime: number | undefined;
  let edgeBlurFade = { left: 0, right: 0, top: 0, bottom: 0 };
  let edgeBlurFadeStyle: { color: string; size: number } | undefined;
  let lastDataUpdateTime = 0;
  function clearDomainAnimation(): void {
    domainAnimGeneration += 1;
    if (domainAnimFrame !== undefined) {
      cancelAnimationFrame(domainAnimFrame);
      domainAnimFrame = undefined;
    }
    if (streamingDomainSettleTimer !== undefined) {
      clearTimeout(streamingDomainSettleTimer);
      streamingDomainSettleTimer = undefined;
    }
    lastDomainLerpTime = undefined;
    pendingSelection = undefined;
    isViewportAnimating = false;
  }

  function beginFocusTransition(): void {
    if (smoothedScalingEnabled) {
      focusTransitionActive = true;
      skipXFocusLerpOnce = false;
    }
  }

  function finishFocusTransitionIfSettled(
    activeX: readonly [number, number] | undefined,
    targetX: readonly [number, number] | undefined,
    xStillAnimating: boolean
  ): void {
    if (!focusTransitionActive) {
      return;
    }
    if (!xStillAnimating || domainsEqual(activeX, targetX)) {
      focusTransitionActive = false;
    }
  }

  function resetDomainAnimationForSelection(): void {
    clearDomainAnimation();
  }

  function finishPlotAnimationForViewportChange(): void {
    if (animationFrame === undefined) {
      return;
    }

    cancelAnimationFrame(animationFrame);
    animationFrame = undefined;
    markAnimationProgress = 1;
    axisAnimationActive = false;
    axisAnimationRuntime = undefined;
    axisAnimationProfile = "none";
    animationProfile = undefined;
    randomFillFade = false;
    scatterAnimationCache = undefined;
    scatterAnimationCacheKey = undefined;
    resetTickFadeForAxisAnimation();
  }

  function applySelection(selection: PlotSelection): void {
    // Intro/replay and viewport interpolation must not own the canvas at the
    // same time. Finish the mark animation at the committed selection boundary
    // so the domain transition starts from one stable, fully rendered scene.
    finishPlotAnimationForViewportChange();
    invalidateHoverForViewChange({ clearLineHover: true });
    resetDomainAnimationForSelection();
    focus = composeSelectionFocus(focus, selection);
    lockViewportFromSelection(selection);
    if (lineFocusEnabled()) {
      // Selection changes the line projection and its hidden hit-test geometry
      // together. Do not let a point-cloud or streaming fast path retain the
      // pre-selection line-focus hit tester.
      forceFullRedrawFlag = true;
    }
    notifyFocusChange("selection");
    scheduleRedraw();
  }

  function recordDataUpdate(): void {
    lastDataUpdateTime = performance.now();
    // Don't cancel an in-flight All↔window focus lerp on every append.
    if (!lockedViewport && domainAnimFrame !== undefined && !focusTransitionActive) {
      clearDomainAnimation();
    }
  }

  function renderedDataLength(): number {
    return renderCache?.viewData?.length ?? cachedBaseAxes?.data.length ?? 0;
  }

  function skipStreamingStartLerpIfNeeded(wasEmpty: boolean): void {
    if (spec.streaming !== true || !wasEmpty) {
      return;
    }

    clearDomainAnimation();
    targetXDomain = undefined;
    targetYDomain = undefined;
    lastResolvedFocusForTarget = undefined;
    lastDomainLerpTime = undefined;
    skipLerpOnce = true;
  }
  let isContinuousInteractionActive = false;
  let continuousInteractionTimer: ReturnType<typeof setTimeout> | undefined;
  let lockedViewport: { x?: readonly [number, number]; y?: readonly [number, number] } | undefined;
  let lockedViewportBaseExtent: { x?: readonly [number, number]; y?: readonly [number, number] } | undefined;

  function clearLockedViewport(): void {
    lockedViewport = undefined;
    lockedViewportBaseExtent = undefined;
  }

  function lockedViewportMatchesLastRender(): boolean {
    return (
      domainsEqual(lockedViewport?.x, lastRenderedXDomain) &&
      domainsEqual(lockedViewport?.y, lastRenderedYDomain)
    );
  }

  function resolveFullDataDomainExtents(): {
    x?: readonly [number, number];
    y?: readonly [number, number];
  } {
    const theme = spec.theme ?? defaultTheme;
    const baseLayout = computeLayout(size, theme, undefined, spec.plotPadding, spec.title, spec.hiddenSeries);
    const plotArea = renderCache?.plotArea ?? baseLayout.plotArea;
    const renderDistance = resolveRenderOptimization(spec.optimization);
    const request: DataSourceResolveRequest = {
      plotArea,
      renderDistance,
      ...(currentDataFocusAxis ? { dataFocusAxis: currentDataFocusAxis } : {})
    };
    const resolved = resolveDataInput(spec.data, request);
    const axes = applyPlotTimeZone(cachedBaseAxes?.axes ?? resolveAxes(spec.axes, resolved.data), spec.timeZone);

    return {
      ...(axes?.x?.kind === "linear" ? { x: axes.x.domain } : {}),
      ...(axes?.y?.kind === "linear" ? { y: axes.y.domain } : {})
    };
  }

  function lockViewportFromSelection(selection: PlotSelection): void {
    // Freeze the selected absolute domain for streaming charts so the window
    // does not slide as new points append — including autoscale (index) mode.
    if (
      !isDataSource(spec.data) ||
      typeof spec.data.subscribe !== "function"
    ) {
      clearLockedViewport();
      return;
    }

    const extent = resolveFullDataDomainExtents();
    const next: { x?: readonly [number, number]; y?: readonly [number, number] } = {};
    const baseExtent: { x?: readonly [number, number]; y?: readonly [number, number] } = {};

    if (selection.x && currentAxes?.x?.kind === "linear") {
      next.x = domainFromFocusRatio(currentAxes.x.domain, selection.x);
      baseExtent.x = extent.x ?? currentAxes.x.domain;
    }

    if (selection.y && currentAxes?.y?.kind === "linear") {
      next.y = domainFromFocusRatio(currentAxes.y.domain, selection.y);
      baseExtent.y = extent.y ?? currentAxes.y.domain;
    }

    lockedViewport = next.x !== undefined || next.y !== undefined ? next : undefined;
    lockedViewportBaseExtent = lockedViewport ? baseExtent : undefined;
    lastResolvedFocusForTarget = undefined;
  }

  function panLockedViewport(delta: number, axis: "x" | "y"): boolean {
    const domain = axis === "y" ? lockedViewport?.y : lockedViewport?.x;
    const extent = axis === "y" ? lockedViewportBaseExtent?.y : lockedViewportBaseExtent?.x;

    if (!domain || !extent) {
      return false;
    }

    const span = domain[1] - domain[0];
    const extentSpan = extent[1] - extent[0];

    if (!Number.isFinite(span) || !Number.isFinite(extentSpan) || span <= 0 || extentSpan <= span) {
      return false;
    }

    const nextStart = Math.max(extent[0], Math.min(extent[1] - span, domain[0] + delta * span));
    const nextDomain: readonly [number, number] = [nextStart, nextStart + span];

    lockedViewport = {
      ...lockedViewport,
      ...(axis === "y" ? { y: nextDomain } : { x: nextDomain })
    };
    lastResolvedFocusForTarget = undefined;

    return true;
  }

  function setContinuousInteractionActive(): void {
    isContinuousInteractionActive = true;
    setChartHoverSuspended(true);
    clearDomainAnimation();
    if (continuousInteractionTimer !== undefined) {
      clearTimeout(continuousInteractionTimer);
    }
    continuousInteractionTimer = setTimeout(() => {
      isContinuousInteractionActive = false;
      continuousInteractionTimer = undefined;
      setChartHoverSuspended(false);
    }, CONTINUOUS_INTERACTION_MS);
  }

  function wasSeriesToggledRecently(): boolean {
    return (performance.now() - lastSeriesToggleTime) < SERIES_TOGGLE_LERP_MS;
  }

  function setChartHoverSuspended(suspended: boolean): void {
    hoverController?.setSuspended(suspended);
    tooltipController?.setSuspended(suspended);
  }

  /** Locked viewport wins; otherwise windowed autoscale Y when focusMode is index. */
  function resolveViewportYDomain(
    data: readonly TDatum[],
    xDomain: readonly [number, number] | undefined,
    fallback: readonly [number, number] | undefined,
    options?: { respectFocusY?: boolean }
  ): readonly [number, number] | undefined {
    if (lockedViewport?.y) {
      return lockedViewport.y;
    }
    if (options?.respectFocusY && focus?.y) {
      return fallback;
    }
    if (resolveFocusMode(spec) !== "index") {
      return fallback;
    }
    return resolveVisibleLineYDomain(spec, data, xDomain) ?? fallback;
  }

  function notifyFocusChange(reason: "selection" | "zoom" | "pan" | "clear"): void {
    if (spec.interactions !== false) {
      spec.interactions?.onFocusChange?.(focus, reason);
    }
  }

  function controlsBelongOnLeft(): boolean {
    const presetAxes = spec.presetOptions?.axes;
    const configuredPosition =
      (presetAxes && typeof presetAxes === "object" ? presetAxes.y?.position : undefined) ??
      spec.presetOptions?.yAxisPosition ??
      (spec.axes && typeof spec.axes === "object" ? spec.axes.y?.position : undefined);
    return (configuredPosition ?? currentAxes?.y?.position) === "right";
  }

  function updateSettingsButtonsPosition(surf?: any): void {
    if (!(container instanceof HTMLElement)) {
      return;
    }
    const btn = container.querySelector(".plot-settings-btn") as HTMLElement | null;
    const activeSurf = surf || (typeof surface !== "undefined" ? surface : undefined);
    if (!btn || !activeSurf?.element) {
      return;
    }

    const canvasEl = activeSurf.element as HTMLElement;
    // Prefer known plot size over offsetWidth — offset* forces layout.
    const canvasLeft = activeSurf.lastAlignLeft ?? canvasEl.offsetLeft;
    const canvasTop = activeSurf.lastAlignTop ?? canvasEl.offsetTop;
    const canvasWidth = size.width;
    const controlsOnLeft = controlsBelongOnLeft();
    const plotArea = renderCache?.plotArea;
    const buttonSize = PLOT_CONTROL_BUTTON_SIZE;
    const gutter = controlsOnLeft
      ? (plotArea?.x ?? PLOT_CONTROL_BUTTON_SIZE + 20)
      : (plotArea ? size.width - (plotArea.x + plotArea.width) : PLOT_CONTROL_BUTTON_SIZE + 20);
    const centeredInset = Math.max(0, (gutter - buttonSize) / 2);
    const leftOffset = canvasLeft;
    const rightOffset = size.width - (canvasLeft + canvasWidth);
    const positionControl = (element: HTMLElement, inset: number): void => {
      if (controlsOnLeft) {
        element.style.setProperty("right", "auto", "important");
        element.style.setProperty("left", `${leftOffset + inset}px`, "important");
      } else {
        element.style.setProperty("left", "auto", "important");
        element.style.setProperty("right", `${rightOffset + inset}px`, "important");
      }
    };
    btn.style.top = `${canvasTop + 6}px`;
    positionControl(btn, centeredInset);
    const replayBtn = container.querySelector(".plot-replay-btn") as HTMLElement | null;
    if (replayBtn) {
      replayBtn.style.top = `${canvasTop + 36}px`;
      positionControl(replayBtn, centeredInset);
    }
    const streamBtn = container.querySelector(".plot-stream-btn") as HTMLElement | null;
    if (streamBtn) {
      streamBtn.style.top = `${canvasTop + 66}px`;
      positionControl(streamBtn, centeredInset);
    }
    const popover = container.querySelector(".plot-settings-popover") as HTMLElement | null;
    if (popover) {
      const popoverInset = Math.max(0, centeredInset - 2);
      popover.style.top = `${canvasTop + 38}px`;
      positionControl(popover, popoverInset);
      const safetyPadding = container.querySelector(".plot-settings-safety-padding") as HTMLElement | null;
      if (safetyPadding) {
        safetyPadding.style.top = `${canvasTop}px`;
        positionControl(safetyPadding, popoverInset);
      }
    }
    lastPositionedControlsOnLeft = controlsOnLeft;
    settingsButtonsPositionDirty = false;
  }

  const renderer = spec.renderer ?? canvasRenderer();
  const baseRender = renderer.render;
  renderer.render = (surf, targetScene) => {
    const patchedScene = {
      ...targetScene,
      primitives: patchScenePrimitives(targetScene, spec)
    };
    baseRender(surf, patchedScene);
  };

  if (renderer.renderOverlay) {
    const baseRenderOverlay = renderer.renderOverlay;
    renderer.renderOverlay = (surf, targetScene) => {
      const patchedScene = {
        ...targetScene,
        primitives: patchScenePrimitives(targetScene, spec)
      };
      baseRenderOverlay(surf, patchedScene);
    };
  }

  if (renderer.renderScatterHover) {
    const baseRenderScatterHover = renderer.renderScatterHover;
    renderer.renderScatterHover = (surf, targetScene) => {
      const patchedScene = {
        ...targetScene,
        primitives: patchScenePrimitives(targetScene, spec)
      };
      baseRenderScatterHover(surf, patchedScene);
    };
  }
  const overlayHover = renderer.renderOverlay !== undefined;
  let resizeSettleTimer: ReturnType<typeof setTimeout> | undefined;
  beginTickFadeEncode();
  const initialBuilt = buildScene(
    spec,
    size,
    markAnimationProgress,
    axisAnimationRuntime,
    animationProfile,
    randomFillFade,
    focus,
    markEncodeHover(),
    () => cachedBaseAxes,
    (next) => {
      cachedBaseAxes = next;
    },
    { axisTickFade: tickFadeState }
  );
  finishTickFadeEncode();
  let currentAxes = initialBuilt.axes;
  let currentDataFocusAxis: "x" | "y" = initialBuilt.dataFocusAxis ?? "x";
  let settingsButtonsPositionDirty = false;
  let lastPositionedControlsOnLeft: boolean | undefined;
  const pointCloudResizePhase = initialBuilt.markPrimitives.some((primitive) => primitive.kind === "point-cloud")
    ? nextPointCloudResizePhase++ % 2
    : undefined;
  let pointCloudResizeDrawDeferred = false;
  lastRenderedXDomain = resolveLayoutXDomain(initialBuilt.axes);
  lastRenderedYDomain = resolveLayoutYDomain(initialBuilt.axes);
  lastRenderedFocus = focus;
  let renderCache: RenderCache | undefined = initialSpec.startEmpty ? undefined : {
    contentKey: buildContentKey(spec, size, focus, markEncodeHover()),
    stableContentKey: buildStableContentKey(spec, focus),
    dataContentKey: buildDataContentKey(spec, size),
    size: initialBuilt.size,
    plotArea: initialBuilt.plotArea,
    axes: initialBuilt.axes,
    ...(initialBuilt.dataFocusAxis ? { dataFocusAxis: initialBuilt.dataFocusAxis } : {}),
    viewData: initialBuilt.viewData,
    backgroundPrimitives: initialBuilt.backgroundPrimitives,
    framePrimitives: initialBuilt.framePrimitives,
    gridPrimitives: initialBuilt.gridPrimitives,
    markPrimitives: initialBuilt.markPrimitives,
    axisPrimitives: initialBuilt.axisPrimitives,
    ...(initialBuilt.clipArea ? { clipArea: initialBuilt.clipArea } : {}),
    theme: spec.theme ?? defaultTheme,
    ...(extractBaseAxesFromBuilt(initialBuilt))
  };
  let scene = sceneWithOverlayHover(initialBuilt.scene);
  let unsubscribeData: (() => void) | undefined;
  let scheduledRedrawFrame: number | undefined;
  // Pointer delivery can briefly pause during a fast drag. Wait long enough to
  // avoid mistaking that gap for resize completion and rebuilding mid-gesture.
  const RESIZE_SETTLE_MS = 120;
  let focusSettleTimer: ReturnType<typeof setTimeout> | undefined;
  let forceFullRedrawFlag = false;
  let streamingDataAppended = false;
  let liveHudEl: HTMLElement | null | undefined;
  const surface = renderer.mount(container);



  const tooltipController = container instanceof HTMLElement
    ? attachTooltipController(container, () => scene, () => spec.theme ?? defaultTheme, () => isViewportAnimating ? false : spec.tooltip)
    : undefined;
  const selectionController = container instanceof HTMLElement
    ? attachSelectionController(container, {
        getScene: () => scene,
        getSpec: () => spec.interactions === false ? false : spec.interactions?.selection,
        getZoomSpec: () => spec.interactions === false ? false : spec.interactions?.zoom,
        getPanSpec: () => spec.interactions === false ? false : spec.interactions?.pan,
        getDragInteraction: () => spec.interactions === false ? undefined : spec.interactions?.dragInteraction,
        onSelect: (selection) => {
          if (domainAnimFrame !== undefined) {
            pendingSelection = selection;
            return;
          }
          applySelection(selection);
        },
        onZoom: (centerX, scaleX, centerY, scaleY) => {
          const zoomSpec = spec.interactions !== false ? spec.interactions?.zoom : undefined;
          const configuredMinSpan = resolveZoomMinSpan(
            spec.data,
            (zoomSpec && typeof zoomSpec === "object") ? zoomSpec.minSpan ?? 0 : 0,
            (zoomSpec && typeof zoomSpec === "object") ? zoomSpec.minPoints : undefined
          );
          const xMinSpan = resolveAxisZoomMinSpan(currentAxes?.x, configuredMinSpan);
          const yMinSpan = resolveAxisZoomMinSpan(currentAxes?.y, configuredMinSpan);

          if (zoomSpec && typeof zoomSpec === "object" && zoomSpec.mode === "xy" && centerY !== undefined && scaleY !== undefined) {
            let nextFocus = zoomSelectionFocus(
              focus,
              centerX,
              scaleX,
              xMinSpan,
              "x"
            );
            nextFocus = zoomSelectionFocus(
              nextFocus,
              centerY,
              scaleY,
              yMinSpan,
              "y"
            );
            focus = nextFocus;
          } else {
            const focusAxis = scene.dataFocusAxis ?? "x";
            focus = zoomSelectionFocus(
              focus,
              centerX,
              scaleX,
              focusAxis === "y" ? yMinSpan : xMinSpan,
              focusAxis
            );
          }
          clearLockedViewport();
          setContinuousInteractionActive();
          invalidateHoverForViewChange();
          notifyFocusChange("zoom");
          scheduleInteractionRedraw();
          scheduleFocusSettle();
        },
        onPan: (deltaX, deltaY) => {
          let pannedLockedViewport = false;
          let nextFocus = focus;
          if (deltaX !== 0) {
            const pannedX = panLockedViewport(deltaX, "x");
            pannedLockedViewport = pannedX || pannedLockedViewport;
            if (!pannedX) {
              nextFocus = panSelectionFocus(nextFocus, deltaX, resolvePanInitialSpan(spec.data), "x");
            }
          }
          if (deltaY !== undefined && deltaY !== 0) {
            const pannedY = panLockedViewport(deltaY, "y");
            pannedLockedViewport = pannedY || pannedLockedViewport;
            if (!pannedY) {
              nextFocus = panSelectionFocus(nextFocus, deltaY, resolvePanInitialSpan(spec.data), "y");
            }
          }

          if (pannedLockedViewport || nextFocus) {
            if (!pannedLockedViewport) {
              focus = nextFocus;
            }
            setContinuousInteractionActive();
            invalidateHoverForViewChange();
            notifyFocusChange("pan");
            scheduleInteractionRedraw();
            scheduleFocusSettle();
          }
        },
        onClear: () => {
          finishPlotAnimationForViewportChange();
          clearDomainAnimation();
          focus = undefined;
          clearLockedViewport();
          invalidateHoverForViewChange({ clearLineHover: true });
          notifyFocusChange("clear");
          scheduleRedraw();
        }
      })
    : undefined;
  const hoverController = container instanceof HTMLElement
    ? attachHoverController(container, {
        getScene: () => scene,
        getEnabled: () => spec.interactions !== false && spec.interactions?.hover !== false,
        onHover: (nextHover, options) => {
          const sameHover =
            hover?.markType === nextHover?.markType &&
            hover?.index === nextHover?.index &&
            hover?.seriesIndex === nextHover?.seriesIndex &&
            hover?.x === nextHover?.x &&
            hover?.y === nextHover?.y &&
            hover?.xValue === nextHover?.xValue &&
            hover?.yValue === nextHover?.yValue;

          if (sameHover && !options?.force) {
            return;
          }

          if (sameHover && !nextHover) {
            return;
          }

          const previousHover = hover;
          const previousMarkType = previousHover?.markType;
          const previousScatterIndex = previousHover?.markType === "scatter" ? previousHover.index : undefined;
          hover = nextHover;
          transitionLineFocusVisual(previousHover, nextHover);
          const scatterHoverMode = resolveScatterHoverInteraction(spec);

          if (scatterHoverMode !== "none" && (nextHover?.markType === "scatter" || previousMarkType === "scatter")) {
            if (nextHover?.markType === "scatter") {
              const { hover: _sceneHover, ...sceneWithoutHover } = scene;
              scene = { ...sceneWithoutHover, hover: nextHover };
              transitionScatterHoverGrow(previousScatterIndex, nextHover.index);
              tooltipController?.refresh();
              return;
            }

            if (previousScatterIndex !== undefined) {
              transitionScatterHoverGrow(previousScatterIndex, undefined);
            }

            if (!nextHover) {
              clearRenderedScatterHoverState(previousScatterIndex);
              return;
            }
          }

          if (!nextHover) {
            // Overlay hover never dirties the main scene/cache — only the overlay
            // canvas. Avoid cache-busting full redraws on pointer leave (those
            // recompute axis margins mid-stream and visibly shrink the plot).
            // Keep lastHoverEncodeContext so re-enter encodes against the same
            // viewData/domains as the visible line (a fresh buildScene can
            // disagree after streaming LOD / domain settle).
            if (overlayHover && renderer.renderOverlay && !lineFocusEnabled()) {
              const { hover: _sceneHover, ...sceneWithoutHover } = scene;
              scene = sceneWithoutHover;
              tooltipController?.hide();
              clearHoverOverlay();
              clearScatterHoverOverlay();
              return;
            }
            clearRenderedHoverState();
            return;
          }

          if (overlayHover && renderer.renderOverlay && !lineFocusEnabled()) {
            const { hover: _sceneHover, ...sceneWithoutHover } = scene;
            scene = nextHover ? { ...sceneWithoutHover, hover: nextHover } : sceneWithoutHover;
            if (nextHover?.markType !== "scatter") {
              renderer.renderOverlay(surface, nextHover ? buildHoverOverlayScene(nextHover) : emptyOverlayScene());
            } else {
              renderer.renderOverlay(surface, applyScatterHoverState(scene));
            }
            tooltipController?.refresh();
            return;
          }

          scheduleRedraw();
        }
      })
    : undefined;
  const lineFocusPointerDownHandler = container instanceof HTMLElement ? beginLinePinGesture : undefined;
  const lineFocusClick = container instanceof HTMLElement ? finishLinePinGesture : undefined;
  const lineFocusPointerCancel = () => cancelLinePinGesture();
  if (container instanceof HTMLElement && lineFocusPointerDownHandler && lineFocusClick) {
    container.addEventListener("pointerdown", lineFocusPointerDownHandler, true);
    container.addEventListener("pointercancel", lineFocusPointerCancel, true);
    container.addEventListener("click", lineFocusClick);
  }

  renderScene(scene);
  syncDataSubscription();

  const plotInstance: Plot<TDatum> = {
    update(update: PlotUpdate<TDatum>) {
      const leavingDashboardPreview =
        spec.dashboardResizePreview === true &&
        update.dashboardResizePreview === false;
      spec = { ...spec, ...update };
      if (leavingDashboardPreview) {
        suppressTickFadeUntilResizeSettles = true;
        resetTickFadeForAxisAnimation();
      }
      if ("smoothedScaling" in update) {
        smoothedScalingEnabled = update.smoothedScaling !== false;
        if (!smoothedScalingEnabled) {
          clearDomainAnimation();
          forceFullRedrawFlag = true;
          skipLerpOnce = true;
        }
      }
      if ("chartBorder" in update && container instanceof HTMLElement) {
        applyChartBorderStyles(container, update.chartBorder);
      }
      if ("width" in update || "height" in update) {
        targetXDomain = undefined;
        targetYDomain = undefined;
        lastResolvedFocusForTarget = undefined;
      }
      if ("data" in update || "axes" in update || "marks" in update || "interactions" in update) {
        cachedBaseAxes = undefined;
        targetXDomain = undefined;
        targetYDomain = undefined;
        lastResolvedFocusForTarget = undefined;
        skipLerpOnce = true;
      }
      if ("hiddenSeries" in update) {
        // Keep renderCache / lastRenderedYDomain so autoscale can lerp to the new
        // visible-series extent instead of snapping on the first frame.
        cachedBaseAxes = undefined;
        targetYDomain = undefined;
        lastResolvedFocusForTarget = undefined;
        lastSeriesToggleTime = performance.now();
        forceFullRedrawFlag = true;
      }
      if ("data" in update || "axes" in update || "marks" in update || "theme" in update || "frame" in update || "optimization" in update || "edgeBlur" in update || "interactions" in update) {
        if ("data" in update && !("axes" in update) && !("marks" in update) && !("theme" in update) && !("frame" in update) && !("optimization" in update) && !("edgeBlur" in update) && !("interactions" in update) && renderCache && (canUseStreamingFastPath(renderCache) || canUseLineStreamingFastPath(renderCache, spec))) {
          streamingDataAppended = true;
        } else {
          renderCache = undefined;
        }
      }

      size = readSize(container, spec);
      if ("data" in update) {
        recordDataUpdate();
        syncDataSubscription();
      }

      const sizeOnlyUpdate = ("width" in update || "height" in update) &&
        !("data" in update) &&
        !("marks" in update) &&
        !("axes" in update);

      if (sizeOnlyUpdate) {
        scheduleResizeRedraw();
      } else {
        if ("axes" in update || "theme" in update || "plotPadding" in update) {
          settingsButtonsPositionDirty = true;
        }
        scheduleRedraw();
      }
    },
    appendData(data: TDatum | readonly TDatum[] | Iterable<TDatum>): boolean {
      const wasEmpty = renderedDataLength() === 0;
      const appended = appendToSpecData(spec.data, data);

      if (appended) {
        skipStreamingStartLerpIfNeeded(wasEmpty);
        if (!isDataSource(spec.data) || !spec.data.subscribe) {
          patchOrInvalidateBaseAxesOnDataChange(
            spec,
            spec.data,
            () => cachedBaseAxes,
            (next) => {
              cachedBaseAxes = next;
            }
          );
          if (lockedViewport) {
            recordDataUpdate();
            return true;
          }
          if (renderCache && (canUseStreamingFastPath(renderCache) || canUseLineStreamingFastPath(renderCache, spec))) {
            streamingDataAppended = true;
          } else {
            renderCache = undefined;
          }
          recordDataUpdate();
          scheduleRedraw();
        }
      }

      return appended;
    },
    clearData(): boolean {
      const cleared = clearSpecData(spec.data);

      if (cleared) {
        if (!isDataSource(spec.data) || !spec.data.subscribe) {
          cachedBaseAxes = undefined;
          clearLockedViewport();
          if (renderCache && (canUseStreamingFastPath(renderCache) || canUseLineStreamingFastPath(renderCache, spec))) {
            streamingDataAppended = true;
          } else {
            renderCache = undefined;
          }
          recordDataUpdate();
          scheduleRedraw();
        }
      }

      return cleared;
    },
    resize(nextSize?: Partial<Size>) {
      if (nextSize?.width !== undefined) {
        spec = { ...spec, width: nextSize.width };
      }
      if (nextSize?.height !== undefined) {
        spec = { ...spec, height: nextSize.height };
      }
      size = { ...readSize(container, spec), ...nextSize };
      targetXDomain = undefined;
      targetYDomain = undefined;
      lastResolvedFocusForTarget = undefined;
      scheduleResizeRedraw();
    },
    animate(options?: AnimationOptions) {
      if (animationFrame !== undefined) {
        cancelAnimationFrame(animationFrame);
        animationFrame = undefined;
      }

      if (resizeSettleTimer !== undefined) {
        clearTimeout(resizeSettleTimer);
        resizeSettleTimer = undefined;
      }

      const prefersReducedMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (prefersReducedMotion) {
        markAnimationProgress = 1;
        axisAnimationActive = false;
        axisAnimationRuntime = undefined;
        axisAnimationProfile = "none";
        scatterAnimationCache = undefined;
        scatterAnimationCacheKey = undefined;
        resetTickFadeForAxisAnimation();
        redraw();
        return;
      }

      const configured = spec.presetOptions ?? {};
      const markDurationMs = Math.max(0, options?.durationMs ?? spec.animationDuration ?? configured.animationDuration ?? 700);
      const axisLineDurationMs = Math.max(0, options?.axisDurationMs ?? spec.axisAnimationDuration ?? configured.axisAnimationDuration ?? markDurationMs);
      animationProfile = options?.profile ?? configured.animationProfile ?? "rise";
      randomFillFade = (animationProfile === "random-fill" || animationProfile === "random-fill-grow") && (options?.randomFillFade ?? configured.randomFillFade ?? false);
      axisAnimationProfile = options?.axisProfile ?? configured.axisAnimationProfile ?? spec.axisAnimation ?? "none";
      const markEasing = resolveAnimationEasing(options?.easing ?? spec.animationEasing ?? configured.animationEasing, animationProfile);
      const axisEasing = resolveAnimationEasing(options?.axisEasing ?? options?.easing ?? spec.axisAnimationEasing ?? configured.axisAnimationEasing ?? spec.animationEasing ?? configured.animationEasing, animationProfile);
      const startedAt = performance.now();
      const axisAnimating = axisAnimationProfile !== "none";
      const lineTriggeredTicks = usesLineTriggeredAxisTicks(axisAnimationProfile);
      const axisTotalDurationMs = lineTriggeredTicks
        ? axisLineDurationMs + ORIGIN_EXTEND_TICK_ANIM_MS
        : axisLineDurationMs;

      axisAnimationActive = axisAnimating;
      scatterAnimationCache = undefined;
      scatterAnimationCacheKey = undefined;

      const tick = (time: number) => {
        const elapsed = time - startedAt;
        const markT = markDurationMs <= 0 ? 1 : Math.min(1, elapsed / markDurationMs);
        const axisLineT = axisLineDurationMs <= 0 ? 1 : Math.min(1, elapsed / axisLineDurationMs);

        markAnimationProgress = markEasing(markT);

        if (axisAnimating) {
          const lineProgress = axisEasing(axisLineT);
          axisAnimationRuntime = {
            profile: axisAnimationProfile,
            progress: lineProgress,
            elapsedMs: elapsed,
            ...(lineTriggeredTicks ? {
              lineProgress,
              lineDurationMs: axisLineDurationMs,
              tickAnimMs: ORIGIN_EXTEND_TICK_ANIM_MS,
              lineEasing: axisEasing
            } : {})
          };
        }

        redraw();

        const axisDone = !axisAnimating || elapsed >= axisTotalDurationMs;
        const markDone = markT >= 1;

        if (!markDone || !axisDone) {
          animationFrame = requestAnimationFrame(tick);
        } else {
          animationFrame = undefined;
          markAnimationProgress = 1;
          axisAnimationActive = false;
          axisAnimationRuntime = undefined;
          axisAnimationProfile = "none";
          animationProfile = undefined;
          scatterAnimationCache = undefined;
          scatterAnimationCacheKey = undefined;
          resetTickFadeForAxisAnimation();
          redraw();
        }
      };

      markAnimationProgress = 0;
      resetTickFadeForAxisAnimation();
      axisAnimationRuntime = axisAnimating
        ? {
            profile: axisAnimationProfile,
            progress: 0,
            elapsedMs: 0,
            ...(lineTriggeredTicks ? {
              lineProgress: 0,
              lineDurationMs: axisLineDurationMs,
              tickAnimMs: ORIGIN_EXTEND_TICK_ANIM_MS,
              lineEasing: axisEasing
            } : {})
          }
        : undefined;
      redraw();
      animationFrame = requestAnimationFrame(tick);
    },
    focus(selection: PlotSelection, options?: { user?: boolean; immediateX?: boolean; streamingPin?: boolean }) {
      focus = selection;
      clearLockedViewport();
      if (options?.streamingPin) {
        // Keep the sliding window pinned, but never snap X while a user window
        // switch (All ↔ 7d ↔ day) is still interpolating.
        // We intentionally do NOT set skipXFocusLerpOnce = true here for streaming,
        // so that the fast path X lerp smoothly animates the new data instead of snapping.
        return;
      }
      invalidateHoverForViewChange();
      if (options?.immediateX) {
        skipXFocusLerpOnce = true;
        forceFullRedrawFlag = true;
      } else {
        beginFocusTransition();
      }
      scheduleRedraw();
    },
    resetFocus(options?: { immediate?: boolean }) {
      if (focus === undefined && lockedViewport === undefined) {
        return;
      }
      finishPlotAnimationForViewportChange();
      focus = undefined;
      clearLockedViewport();
      invalidateHoverForViewChange({ clearLineHover: true });
      if (options?.immediate) {
        skipLerpOnce = true;
        skipXFocusLerpOnce = true;
        forceFullRedrawFlag = true;
      } else {
        beginFocusTransition();
      }
      scheduleRedraw();
    },
    getFocus() {
      return focus;
    },
    isUserFocusActive() {
      return focus !== undefined;
    },
    hasLockedViewport() {
      return lockedViewport !== undefined;
    },
    render() {
      if (scheduledRedrawFrame !== undefined) {
        cancelAnimationFrame(scheduledRedrawFrame);
        scheduledRedrawFrame = undefined;
      }
      if (tickFadeFrame !== undefined) {
        cancelAnimationFrame(tickFadeFrame);
        tickFadeFrame = undefined;
      }
      if (edgeBlurFadeFrame !== undefined) {
        cancelAnimationFrame(edgeBlurFadeFrame);
        edgeBlurFadeFrame = undefined;
      }
      clearDomainAnimation();
      forceFullRedrawFlag = true;
      skipLerpOnce = true;
      skipXFocusLerpOnce = true;
      redraw({ skipInteractionRefresh: true });
      if (hover?.markType !== "scatter") {
        renderCurrentHoverOverlay();
      }
      renderScatterHoverOverlay();
      tooltipController?.refresh();
    },
    destroy() {
      if (animationFrame !== undefined) {
        cancelAnimationFrame(animationFrame);
      }
      if (scatterHoverAnimFrame !== undefined) {
        cancelAnimationFrame(scatterHoverAnimFrame);
      }
      if (lineFocusTransitionFrame !== undefined) {
        cancelAnimationFrame(lineFocusTransitionFrame);
      }
      if (linePinHoverRefreshFrame !== undefined) {
        cancelAnimationFrame(linePinHoverRefreshFrame);
      }
      lineFocusTransition = undefined;
      lineFocusEmphasisBySeries.clear();
      scatterHoverAnimations.clear();
      if (scheduledRedrawFrame !== undefined) {
        cancelAnimationFrame(scheduledRedrawFrame);
      }
      if (tickFadeFrame !== undefined) {
        cancelAnimationFrame(tickFadeFrame);
      }
      if (edgeBlurFadeFrame !== undefined) {
        cancelAnimationFrame(edgeBlurFadeFrame);
      }
      if (continuousInteractionTimer !== undefined) {
        clearTimeout(continuousInteractionTimer);
      }
      if (resizeSettleTimer !== undefined) {
        clearTimeout(resizeSettleTimer);
      }
      if (focusSettleTimer !== undefined) {
        clearTimeout(focusSettleTimer);
      }
      if (streamingDomainSettleTimer !== undefined) {
        clearTimeout(streamingDomainSettleTimer);
      }
      unsubscribeData?.();
      tooltipController?.destroy();
      selectionController?.destroy();
      hoverController?.destroy();
      if (container instanceof HTMLElement && lineFocusPointerDownHandler && lineFocusClick) {
        container.removeEventListener("pointerdown", lineFocusPointerDownHandler, true);
        container.removeEventListener("pointercancel", lineFocusPointerCancel, true);
        container.removeEventListener("click", lineFocusClick);
      }
      renderer.destroy(surface);
    },
    getPlotArea() {
      return renderCache ? renderCache.plotArea : { x: 0, y: 0, width: 0, height: 0 };
    }
  };

  function ensureSettingsStyles(): void {
    let style = document.getElementById("plot-settings-styles") as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement("style");
      style.id = "plot-settings-styles";
      document.head.appendChild(style);
    }
    style.textContent = SETTINGS_CSS;
  }

  function renderScene(nextScene: SceneGraph): void {
    renderer.render(surface, nextScene);
    const controlsOnLeft = controlsBelongOnLeft();
    if (settingsButtonsPositionDirty || controlsOnLeft !== lastPositionedControlsOnLeft) {
      updateSettingsButtonsPosition(surface);
    }
    if (!isContinuousInteractionActive) {
      updateLiveHeaderHUD(nextScene.plotArea);
    }
  }

  function updateLiveHeaderHUD(plotArea: Rect): void {
    if (!spec.liveHeaderTicker) {
      if (liveHudEl) {
        liveHudEl.style.display = "none";
      }
      return;
    }

    // Reuse the view already resolved for this frame — a second LOD resolve was a
    // major per-frame cost with the live header enabled.
    let data = (renderCache?.viewData as readonly TDatum[] | undefined) ?? [];
    if (data.length === 0) {
      const activeRenderDistance = resolveRenderOptimization(spec.optimization);
      data = resolveDataInput(spec.data, { plotArea, renderDistance: activeRenderDistance }).data;
    }
    const activeAxes = currentAxes ?? (
      cachedBaseAxes && "axes" in cachedBaseAxes ? cachedBaseAxes.axes : cachedBaseAxes
    );
    if (data.length === 0 || !activeAxes) {
      if (liveHudEl) {
        liveHudEl.style.display = "none";
      }
      return;
    }

    const xDomain = resolveLayoutXDomain(activeAxes);
    const yDomain = resolveLayoutYDomain(activeAxes);
    if (!xDomain || !yDomain) {
      if (liveHudEl) {
        liveHudEl.style.display = "none";
      }
      return;
    }

    let hudEl = liveHudEl;
    if (!hudEl || !hudEl.isConnected) {
      hudEl = container instanceof Element
        ? container.querySelector(".plot-live-hud") as HTMLElement | null
        : null;
      if (!hudEl) {
        hudEl = document.createElement("div");
        hudEl.className = "plot-live-hud";
        hudEl.style.position = "absolute";
        hudEl.style.display = "flex";
        hudEl.style.gap = "6px";
        hudEl.style.alignItems = "center";
        hudEl.style.pointerEvents = "auto";
        hudEl.style.zIndex = "10";
        hudEl.style.fontFamily = SYSTEM_MONO_FONT_FAMILY;
        hudEl.style.fontSize = "10px";
        hudEl.style.fontWeight = "600";
        hudEl.style.userSelect = "none";
        hudEl.style.fontVariantNumeric = "tabular-nums";

        const stopEvents = [
          "mousedown", "mouseup", "mousemove", "click", "dblclick",
          "pointerdown", "pointerup", "pointermove", "touchstart", "touchend", "touchmove",
          "wheel", "mousewheel"
        ];
        stopEvents.forEach((event) => {
          hudEl!.addEventListener(event, (e) => {
            e.stopPropagation();
          });
        });

        const clearChartHover = () => {
          hoverController?.clear();
          tooltipController?.hide();
        };
        attachPlotChromeHoverGate({
          elements: [hudEl],
          clearHover: clearChartHover,
          setSuspended: setChartHoverSuspended
        });

        if (container instanceof Element) {
          container.appendChild(hudEl);
        }
      }
      liveHudEl = hudEl;
    }

    hudEl.style.display = "flex";
    hudEl.style.flexWrap = "nowrap";
    hudEl.style.fontFamily = SYSTEM_MONO_FONT_FAMILY;
    hudEl.style.left = `${plotArea.x + 8}px`;
    hudEl.style.top = `${plotArea.y + 8}px`;
    hudEl.style.transformOrigin = "left top";
    hudEl.style.backgroundColor = "";
    hudEl.style.border = "";
    hudEl.style.boxShadow = "";
    hudEl.style.color = "";
    hudEl.classList.remove("is-dark");

    const xAccessor = spec.presetOptions?.x ?? "x";
    const yAccessor = spec.presetOptions?.y ?? "y";
    const seriesAccessor = spec.presetOptions?.series;
    const seriesOrder = Array.isArray(spec.presetOptions?.seriesOrder)
      ? spec.presetOptions.seriesOrder as readonly (string | number)[]
      : undefined;

    const latestBySeries = new Map<string | number, {
      datum: TDatum;
      xValue: number;
      yValue: number;
      seriesIndex: number;
      dataIndex: number;
    }>();
    const seriesIndexByKey = new Map<string | number, number>();

    if (seriesOrder) {
      seriesOrder.forEach((key, index) => {
        seriesIndexByKey.set(key, index);
      });
    }

    const expectedSeriesCount = seriesOrder?.length ?? (seriesAccessor === undefined ? 1 : 16);

    for (let index = data.length - 1; index >= 0; index -= 1) {
      const datum = data[index] as TDatum;
      const xValRaw = readDatumValue(xAccessor, datum, index);
      const xValue = xValRaw instanceof Date ? xValRaw.getTime() : Number(xValRaw);
      const yValRaw = readDatumValue(yAccessor, datum, index);
      const yValue = Number(yValRaw);

      if (!Number.isFinite(xValue) || !Number.isFinite(yValue)) {
        continue;
      }

      const rawSeriesKey = seriesAccessor === undefined
        ? "__default"
        : readDatumValue(seriesAccessor, datum, index);
      const seriesKey = typeof rawSeriesKey === "string" || typeof rawSeriesKey === "number"
        ? rawSeriesKey
        : String(rawSeriesKey);
      let seriesIndex = seriesIndexByKey.get(seriesKey);

      if (seriesIndex === undefined) {
        seriesIndex = seriesIndexByKey.size;
        seriesIndexByKey.set(seriesKey, seriesIndex);
      }

      if (!latestBySeries.has(seriesKey)) {
        latestBySeries.set(seriesKey, { datum, xValue, yValue, seriesIndex, dataIndex: index });
        if (latestBySeries.size >= expectedSeriesCount) {
          break;
        }
      }
    }

    if (latestBySeries.size === 0) {
      hudEl.style.display = "none";
      return;
    }

    let maxXValue = -Infinity;
    for (const entry of latestBySeries.values()) {
      if (entry.xValue > maxXValue) {
        maxXValue = entry.xValue;
      }
    }

    let xText = "";
    if (spec.presetOptions?.timeAxis) {
      xText = new Date(maxXValue).toLocaleString(undefined, {
        month: "short",
        day: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
      });
    } else {
      xText = maxXValue.toLocaleString(undefined, { maximumFractionDigits: 2 });
    }

    const activeTheme = spec.theme ?? defaultTheme;
    const isDarkBg = activeTheme.palette.background !== "#ffffff" && activeTheme.palette.background !== "#fff" && activeTheme.palette.background !== "rgb(255, 255, 255)";
    const chipBg = isDarkBg ? "rgba(30, 41, 59, 0.65)" : "rgba(255, 255, 255, 0.65)";
    const textColor = activeTheme.palette.foreground ?? "#0f172a";

    // 1. Manage X-Axis / Time chip
    let xChip = hudEl.querySelector(".hud-chip-time") as HTMLElement | null;
    if (!xChip) {
      xChip = document.createElement("div");
      xChip.className = "hud-chip hud-chip-time";
      xChip.style.backgroundColor = chipBg;
      xChip.style.border = "1px solid transparent";
      xChip.style.borderRadius = "6px";
      xChip.style.padding = "4px 8px";
      xChip.style.color = textColor;
      xChip.style.height = "14px";
      xChip.style.display = "flex";
      xChip.style.alignItems = "center";
      xChip.style.boxShadow = "0 2px 4px rgba(0, 0, 0, 0.05)";
      xChip.style.backdropFilter = "blur(4px)";
      (xChip.style as any).WebkitBackdropFilter = "blur(4px)";
      xChip.style.fontFamily = SYSTEM_MONO_FONT_FAMILY;
      xChip.style.minWidth = spec.presetOptions?.timeAxis ? "138px" : "60px";
      xChip.style.justifyContent = "center";
      xChip.style.whiteSpace = "nowrap";
      xChip.style.flexShrink = "0";
      const spacer = hudEl.querySelector(".hud-spacer");
      hudEl.insertBefore(xChip, spacer || null);
    } else {
      xChip.style.backgroundColor = chipBg;
      xChip.style.color = textColor;
    }
    if (xChip.textContent !== xText) {
      xChip.textContent = xText;
    }

    // 2. Manage Series chips
    const sortedEntries = [...latestBySeries.entries()].sort((a, b) => a[1].seriesIndex - b[1].seriesIndex);
    const currentKeys = new Set<string>();

    for (const [key, entry] of sortedEntries) {
      const seriesKeyStr = String(key);
      currentKeys.add(seriesKeyStr);
      const seriesName = key === "__default" ? "Live" : String(key);
      const color = resolveLiveTickerColor(spec, activeTheme, entry.datum, entry.dataIndex, entry.seriesIndex, entry.yValue);
      const formattedVal = formatLiveTickerValue(entry.yValue);
      const isHidden = spec.hiddenSeries?.has(key) || spec.hiddenSeries?.has(seriesKeyStr) || false;

      let seriesChip = hudEl.querySelector(`.hud-chip-series[data-key="${seriesKeyStr}"]`) as HTMLElement | null;
      let dot: HTMLElement;
      let nameLabel: HTMLElement;
      let valueLabel: HTMLElement;

      if (!seriesChip) {
        seriesChip = document.createElement("div");
        seriesChip.className = "hud-chip hud-chip-series";
        seriesChip.setAttribute("data-key", seriesKeyStr);
        seriesChip.style.backgroundColor = chipBg;
        seriesChip.style.borderRadius = "6px";
        seriesChip.style.padding = "4px 8px";
        seriesChip.style.display = "flex";
        seriesChip.style.alignItems = "center";
        seriesChip.style.gap = "6px";
        seriesChip.style.cursor = "pointer";
        seriesChip.style.transition = "opacity 0.15s, border-color 0.15s";
        seriesChip.style.height = "14px";
        seriesChip.style.border = "1px solid transparent";
        seriesChip.style.boxShadow = "0 2px 4px rgba(0, 0, 0, 0.05)";
        seriesChip.style.backdropFilter = "blur(4px)";
        seriesChip.style.flexShrink = "0";
        (seriesChip.style as any).WebkitBackdropFilter = "blur(4px)";

        dot = document.createElement("div");
        dot.className = "chip-dot";
        dot.style.width = "6px";
        dot.style.height = "6px";
        dot.style.borderRadius = "50%";
        dot.style.flexShrink = "0";
        seriesChip.appendChild(dot);

        nameLabel = document.createElement("span");
        nameLabel.className = "chip-name";
        nameLabel.style.fontSize = "11px";
        nameLabel.style.fontWeight = "500";
        nameLabel.style.fontFamily = SYSTEM_FONT_FAMILY;
        nameLabel.style.color = "#000000";
        nameLabel.style.whiteSpace = "nowrap";
        nameLabel.style.overflow = "hidden";
        nameLabel.style.textOverflow = "ellipsis";
        seriesChip.appendChild(nameLabel);

        valueLabel = document.createElement("span");
        valueLabel.className = "chip-value";
        valueLabel.style.fontWeight = "700";
        valueLabel.style.fontFamily = SYSTEM_MONO_FONT_FAMILY;
        valueLabel.style.minWidth = "42px";
        valueLabel.style.display = "inline-block";
        valueLabel.style.textAlign = "right";
        valueLabel.style.flexShrink = "0";
        seriesChip.appendChild(valueLabel);

        seriesChip.addEventListener("mouseenter", () => {
          const isHiddenNow = spec.hiddenSeries?.has(key) || spec.hiddenSeries?.has(seriesKeyStr) || false;
          const activeColor = resolveLiveTickerColor(
            spec,
            spec.theme ?? defaultTheme,
            entry.datum,
            entry.dataIndex,
            entry.seriesIndex,
            entry.yValue
          );
          seriesChip!.style.borderColor = activeColor;
          if (isHiddenNow) {
            seriesChip!.style.opacity = "0.7";
          }
        });

        seriesChip.addEventListener("mouseleave", () => {
          const isHiddenNow = spec.hiddenSeries?.has(key) || spec.hiddenSeries?.has(seriesKeyStr) || false;
          seriesChip!.style.borderColor = "transparent";
          if (isHiddenNow) {
            seriesChip!.style.opacity = "0.45";
          }
        });

        seriesChip.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const nextHiddenSeries = new Set(spec.hiddenSeries);
          if (nextHiddenSeries.has(key)) {
            nextHiddenSeries.delete(key);
          } else {
            nextHiddenSeries.add(key);
          }
          plotInstance.update({
            hiddenSeries: nextHiddenSeries.size > 0 ? nextHiddenSeries : undefined
          });
        });

        const spacer = hudEl.querySelector(".hud-spacer");
        hudEl.insertBefore(seriesChip, spacer || null);
      } else {
        dot = seriesChip.querySelector(".chip-dot") as HTMLElement;
        nameLabel = seriesChip.querySelector(".chip-name") as HTMLElement;
        valueLabel = seriesChip.querySelector(".chip-value") as HTMLElement;
      }

      seriesChip.style.backgroundColor = chipBg;
      seriesChip.style.opacity = isHidden ? "0.45" : "1";
      seriesChip.style.flexShrink = "0";
      seriesChip.classList.remove("is-hidden");

      dot.style.backgroundColor = color;

      nameLabel.style.fontFamily = SYSTEM_FONT_FAMILY;
      nameLabel.style.color = isHidden
        ? (isDarkBg ? "rgba(255, 255, 255, 0.4)" : "rgba(0, 0, 0, 0.4)")
        : (isDarkBg ? "rgba(255, 255, 255, 0.9)" : "#000000");
      if (nameLabel.textContent !== `${seriesName}:`) {
        nameLabel.textContent = `${seriesName}:`;
      }

      valueLabel.style.fontFamily = SYSTEM_MONO_FONT_FAMILY;
      valueLabel.style.color = isHidden ? (isDarkBg ? "rgba(255, 255, 255, 0.4)" : "rgba(0, 0, 0, 0.4)") : color;
      if (valueLabel.textContent !== formattedVal) {
        valueLabel.textContent = formattedVal;
      }
    }

    // 3. Remove stale chips
    const allSeriesChips = hudEl.querySelectorAll(".hud-chip-series");
    allSeriesChips.forEach((chip) => {
      const keyAttr = chip.getAttribute("data-key");
      if (keyAttr && !currentKeys.has(keyAttr)) {
        chip.remove();
      }
    });

    // 4. Time Window Selector
    if (spec.timeWindows && spec.timeWindows.length > 0) {
      let spacer = hudEl.querySelector(".hud-spacer") as HTMLElement | null;
      if (!spacer) {
        spacer = document.createElement("div");
        spacer.className = "hud-spacer";
        spacer.style.flex = "1";
        hudEl.appendChild(spacer);
      }

      let windowContainer = hudEl.querySelector(".hud-window-selector") as HTMLElement | null;
      if (!windowContainer) {
        windowContainer = document.createElement("div");
        windowContainer.className = "hud-window-selector";
        windowContainer.style.display = "flex";
        windowContainer.style.alignItems = "center";
        windowContainer.style.backgroundColor = isDarkBg ? "rgba(30, 41, 59, 0.45)" : "rgba(255, 255, 255, 0.45)";
        windowContainer.style.borderRadius = "9999px";
        windowContainer.style.padding = "2px";
        windowContainer.style.gap = "2px";
        windowContainer.style.backdropFilter = "blur(8px)";
        windowContainer.style.flexShrink = "0";
        (windowContainer.style as any).WebkitBackdropFilter = "blur(8px)";
        windowContainer.style.boxShadow = "0 2px 4px rgba(0, 0, 0, 0.05), inset 0 1px 2px rgba(0, 0, 0, 0.05)";
        hudEl.appendChild(windowContainer);
      } else {
        windowContainer.style.backgroundColor = isDarkBg ? "rgba(30, 41, 59, 0.45)" : "rgba(255, 255, 255, 0.45)";
      }

      const activeColor = activeTheme.palette.foreground ?? "#0f172a";
      const inactiveColor = isDarkBg ? "rgba(255, 255, 255, 0.5)" : "rgba(0, 0, 0, 0.5)";
      const hoverColor = isDarkBg ? "rgba(255, 255, 255, 0.8)" : "rgba(0, 0, 0, 0.8)";
      const activeBg = isDarkBg ? "rgba(255, 255, 255, 0.15)" : "rgba(0, 0, 0, 0.06)";

      spec.timeWindows.forEach((windowSpec) => {
        const windowKey = String(windowSpec.value);
        let btn = windowContainer!.querySelector(`button[data-window="${windowKey}"]`) as HTMLElement | null;
        if (!btn) {
          btn = document.createElement("button");
          btn.setAttribute("data-window", windowKey);
          btn.style.appearance = "none";
          btn.style.border = "none";
          btn.style.outline = "none";
          btn.style.background = "transparent";
          btn.style.margin = "0";
          btn.style.cursor = "pointer";
          btn.style.borderRadius = "9999px";
          btn.style.padding = "2px 8px";
          btn.style.fontSize = "10px";
          btn.style.fontWeight = "600";
          btn.style.fontFamily = SYSTEM_FONT_FAMILY;
          btn.style.transition = "background-color 0.15s, color 0.15s";
          btn.textContent = windowSpec.label;
          
          btn.addEventListener("click", () => {
            spec.onTimeWindowChange?.(windowSpec.value);
          });
          btn.addEventListener("mouseenter", () => {
            if (String(spec.activeTimeWindow) !== windowKey) {
              btn!.style.color = hoverColor;
            }
          });
          btn.addEventListener("mouseleave", () => {
            if (String(spec.activeTimeWindow) !== windowKey) {
              btn!.style.color = inactiveColor;
            }
          });
          
          windowContainer!.appendChild(btn);
        }

        const isActive = String(spec.activeTimeWindow) === windowKey;
        btn.style.backgroundColor = isActive ? activeBg : "transparent";
        if (!btn.matches(":hover") || isActive) {
          btn.style.color = isActive ? activeColor : inactiveColor;
        }
        btn.style.boxShadow = isActive ? "0 1px 2px rgba(0, 0, 0, 0.05)" : "none";
      });

      // Remove stale buttons
      const currentWindowKeys = new Set(spec.timeWindows.map(w => String(w.value)));
      const allWindowBtns = windowContainer.querySelectorAll("button");
      allWindowBtns.forEach(btn => {
        const key = btn.getAttribute("data-window");
        if (key && !currentWindowKeys.has(key)) {
          btn.remove();
        }
      });
    } else {
      const spacer = hudEl.querySelector(".hud-spacer");
      const windowContainer = hudEl.querySelector(".hud-window-selector");
      if (spacer) spacer.remove();
      if (windowContainer) windowContainer.remove();
    }

    // Scale the whole HUD to the plot width instead of crushing chips.
    fitLiveHeaderHUD(hudEl, plotArea);
  }

  function fitLiveHeaderHUD(hudEl: HTMLElement, plotArea: Rect): void {
    const available = Math.max(1, plotArea.width - 16);
    hudEl.style.transform = "";
    hudEl.style.width = "max-content";

    const natural = Math.max(hudEl.scrollWidth, hudEl.offsetWidth);
    if (natural <= available) {
      // Room to spare — span the plot so the window selector stays right-aligned.
      hudEl.style.width = `${available}px`;
      setLiveHeaderHUDVisible(hudEl, true);
      return;
    }

    const scale = available / natural;
    const revealThreshold = hudEl.getAttribute("aria-hidden") === "true"
      ? LIVE_HEADER_HUD_REVEAL_SCALE
      : LIVE_HEADER_HUD_MIN_SCALE;
    hudEl.style.width = `${natural}px`;
    hudEl.style.transform = `scale(${scale})`;
    setLiveHeaderHUDVisible(hudEl, scale >= revealThreshold);
  }

  function setLiveHeaderHUDVisible(hudEl: HTMLElement, visible: boolean): void {
    const isVisible = hudEl.getAttribute("aria-hidden") !== "true";
    if (visible === isVisible) {
      return;
    }

    hudEl.style.transition = visible
      ? `opacity ${LIVE_HEADER_HUD_FADE_MS}ms ease, visibility 0s linear`
      : `opacity ${LIVE_HEADER_HUD_FADE_MS}ms ease, visibility 0s linear ${LIVE_HEADER_HUD_FADE_MS}ms`;
    hudEl.style.opacity = visible ? "1" : "0";
    hudEl.style.visibility = visible ? "visible" : "hidden";
    hudEl.style.pointerEvents = visible ? "auto" : "none";
    if (visible) {
      hudEl.removeAttribute("aria-hidden");
    } else {
      hudEl.setAttribute("aria-hidden", "true");
    }
  }

  function iconSvg(paths: string): string {
    return `<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false" fill="none" xmlns="http://www.w3.org/2000/svg">${paths}</svg>`;
  }

  function playIconSvg(): string {
    return iconSvg(`<path d="M6.75 5.55C6.75 4.87 7.5 4.45 8.08 4.81L14.6 8.9C15.15 9.25 15.15 10.05 14.6 10.4L8.08 14.49C7.5 14.85 6.75 14.43 6.75 13.75V5.55Z" fill="currentColor"/>`);
  }

  function restartIconSvg(): string {
    return iconSvg(`<path d="M14.7 6.15A6 6 0 1 0 16 10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M15.25 3.35V6.75H11.85" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`);
  }

  function menuIconSvg(): string {
    return iconSvg(`<circle cx="3" cy="10" r="1.6" fill="currentColor"/><circle cx="10" cy="10" r="1.6" fill="currentColor"/><circle cx="17" cy="10" r="1.6" fill="currentColor"/>`);
  }

  function setupSettingsUI(containerEl: HTMLElement, plot: Plot<TDatum>): void {
    ensureSettingsStyles();

    if (window.getComputedStyle(containerEl).position === "static") {
      containerEl.style.position = "relative";
    }

    const menuButton = document.createElement("button");
    menuButton.className = "plot-settings-btn";
    menuButton.type = "button";
    menuButton.title = "Plot settings";
    menuButton.setAttribute("aria-label", "Plot settings");
    menuButton.innerHTML = menuIconSvg();
    containerEl.appendChild(menuButton);

    const replayButton = document.createElement("button");
    replayButton.className = "plot-replay-btn";
    replayButton.type = "button";
    replayButton.title = "Replay animation";
    replayButton.setAttribute("aria-label", "Replay animation");
    replayButton.innerHTML = restartIconSvg();
    containerEl.appendChild(replayButton);

    const streamButton = document.createElement("button");
    streamButton.className = "plot-stream-btn";
    streamButton.type = "button";
    streamButton.title = "Start streaming";
    streamButton.setAttribute("aria-label", "Start streaming");
    streamButton.innerHTML = playIconSvg();
    containerEl.appendChild(streamButton);

    const popover = document.createElement("div");
    popover.className = "plot-settings-popover";
    containerEl.appendChild(popover);

    const safetyPadding = document.createElement("div");
    safetyPadding.className = "plot-settings-safety-padding";
    containerEl.appendChild(safetyPadding);
    const fullscreenTarget = resolveFullscreenTarget(containerEl);
    const closeSettingsPopover = () => {
      popover.style.transition = "none";
      popover.classList.remove("show");
      menuButton.classList.remove("active");
      setChartHoverSuspended(false);
    };
    const resizeAfterFullscreenChange = () => {
      requestAnimationFrame(() => {
        plot.resize();
        tooltipController?.refresh();
      });
    };

    // Stop events on settings elements from bubbling up to the plot container
    const stopEvents = [
      "click", "dblclick", "mousedown", "mouseup", "mousemove",
      "pointerdown", "pointerup", "pointermove", "touchstart", "touchend", "touchmove",
      "wheel", "mousewheel", "keydown", "keyup", "keypress", "contextmenu"
    ];
    stopEvents.forEach((event) => {
      popover.addEventListener(event, (e) => {
        e.stopPropagation();
      });
      safetyPadding.addEventListener(event, (e) => {
        e.stopPropagation();
      });
    });

    const buttonStopEvents = ["mousedown", "pointerdown", "wheel", "mousewheel", "mousemove", "pointermove"];
    buttonStopEvents.forEach((event) => {
      menuButton.addEventListener(event, (e) => {
        e.stopPropagation();
      });
      replayButton.addEventListener(event, (e) => {
        e.stopPropagation();
      });
      streamButton.addEventListener(event, (e) => {
        e.stopPropagation();
      });
    });

    const clearChartHover = () => {
      hoverController?.clear();
      tooltipController?.hide();
    };
    const chromeElements = [menuButton, replayButton, streamButton, popover, safetyPadding];
    attachPlotChromeHoverGate({
      elements: chromeElements,
      clearHover: clearChartHover,
      setSuspended: setChartHoverSuspended,
      shouldKeepSuspended: () => popover.classList.contains("show")
    });

    containerEl.addEventListener("mouseenter", () => {
      containerEl.classList.add("plot-container-hovered");
    });
    containerEl.addEventListener("mouseleave", () => {
      if (!popover.classList.contains("show")) {
        containerEl.classList.remove("plot-container-hovered");
      }
    });

    menuButton.addEventListener("click", (e) => {
      e.stopPropagation();
      const isShowing = popover.classList.contains("show");
      document.querySelectorAll(".plot-settings-popover").forEach((p) => {
        if (p !== popover) {
          (p as HTMLElement).style.transition = "none";
          p.classList.remove("show");
          p.parentElement?.classList.remove("plot-container-hovered");
          p.parentElement?.querySelector(".plot-settings-btn")?.classList.remove("active");
        }
      });

      if (isShowing) {
        closeSettingsPopover();
      } else {
        popover.style.transition = "";
        renderSettingsContent(popover, plot);
        popover.classList.add("show");
        menuButton.classList.add("active");
        hoverController?.clear();
        setChartHoverSuspended(true);
      }
    });

    replayButton.addEventListener("click", (e) => {
      e.stopPropagation();
      plot.animate();
    });

    document.addEventListener("click", (e) => {
      if (!popover.contains(e.target as Node) && e.target !== menuButton) {
        closeSettingsPopover();
        containerEl.classList.remove("plot-container-hovered");
      }
    });

    document.addEventListener("fullscreenchange", () => {
      const wasFullscreen = fullscreenTarget.classList.contains("plot-fullscreen-target");
      const isFullscreen = document.fullscreenElement === fullscreenTarget;
      if (!wasFullscreen && !isFullscreen) {
        return;
      }
      setFullscreenClass(fullscreenTarget, isFullscreen);
      updateFullscreenButtonLabel(popover, fullscreenTarget);
      containerEl.classList.toggle("plot-container-hovered", isFullscreen);
      if (!isFullscreen) {
        closeSettingsPopover();
      }
      resizeAfterFullscreenChange();
    });

    updateSettingsButtonsPosition(surface);
    requestAnimationFrame(() => {
      updateSettingsButtonsPosition(surface);
    });
  }

  const settingsSectionOpenState = new Map<string, boolean>();
  const settingsSectionOpenAttr = (sectionId: string): string => settingsSectionOpenState.get(sectionId) === true ? " open" : "";

  function renderSettingsContent(popoverEl: HTMLElement, plot: Plot<TDatum>): void {
    const markKind = spec.marks[0]?.kind;
    const presetOpts = spec.presetOptions ?? {};
    const containerEl = popoverEl.parentElement instanceof HTMLElement ? popoverEl.parentElement : null;
    const fullscreenTarget = containerEl ? resolveFullscreenTarget(containerEl) : null;
    const fullscreenLabel = fullscreenTarget && popoverEl.ownerDocument.fullscreenElement === fullscreenTarget
      ? "Exit Fullscreen"
      : "Fullscreen";

        popoverEl.innerHTML = generateSettingsHtml({
      spec,
      currentAxes,
      markKind,
      presetOpts,
      fullscreenLabel,
      settingsSectionOpenAttr,
      escapeHtmlAttr,
      smoothedScalingEnabled
    });


    const showPanel = (name: string): void => {
      popoverEl.querySelectorAll<HTMLElement>(".plot-settings-panel").forEach((panel) => {
        panel.hidden = panel.dataset.panel !== name;
      });
      const content = popoverEl.querySelector<HTMLElement>(".plot-settings-content");
      content?.scrollTo({ top: 0 });
      updateMenuScrollability(content);
    };

    popoverEl.querySelectorAll<HTMLElement>("[data-open-panel]").forEach((button) => {
      button.addEventListener("click", () => {
        showPanel(button.dataset.openPanel ?? "root");
      });
    });
    const settingsContent = popoverEl.querySelector<HTMLElement>(".plot-settings-content");
    settingsContent?.addEventListener("wheel", preventMenuOverscroll, { passive: false });
    settingsContent?.addEventListener("scroll", clampMenuScroll);
    updateMenuScrollability(settingsContent);

    popoverEl.querySelectorAll<HTMLDetailsElement>("details").forEach((details) => {
      details.addEventListener("toggle", () => {
        const sectionId = details.dataset.section;
        if (sectionId) {
          settingsSectionOpenState.set(sectionId, details.open);
        }
        updateMenuScrollability(settingsContent);
      });
    });

    const profileSelect = popoverEl.querySelector("#set-anim-profile") as HTMLSelectElement;
    const fadeRow = popoverEl.querySelector("#set-anim-fade-row") as HTMLElement;
    if (profileSelect && fadeRow) {
      profileSelect.addEventListener("change", () => {
        const val = profileSelect.value;
        if (val === "random-fill" || val === "random-fill-grow") {
          fadeRow.style.display = "";
        } else {
          fadeRow.style.display = "none";
        }
      });
    }

    const borderCheckbox = popoverEl.querySelector("#set-border") as HTMLInputElement | null;
    const plotBorderColorRow = popoverEl.querySelector("#set-plot-border-color-row") as HTMLElement | null;
    const plotRadiusRow = popoverEl.querySelector("#set-plot-radius-row") as HTMLElement | null;
    if (borderCheckbox && plotBorderColorRow && plotRadiusRow) {
      const updatePlotBorderVisibility = () => {
        const checked = borderCheckbox.checked;
        plotBorderColorRow.style.display = checked ? "" : "none";
        plotRadiusRow.style.display = checked ? "" : "none";
      };
      borderCheckbox.addEventListener("change", updatePlotBorderVisibility);
      updatePlotBorderVisibility();
    }

    const chartBorderCheckbox = popoverEl.querySelector("#set-chart-border") as HTMLInputElement | null;
    const chartBorderColorRow = popoverEl.querySelector("#set-chart-border-color-row") as HTMLElement | null;
    const chartRadiusRow = popoverEl.querySelector("#set-chart-radius-row") as HTMLElement | null;
    if (chartBorderCheckbox && chartBorderColorRow && chartRadiusRow) {
      const updateChartBorderVisibility = () => {
        const checked = chartBorderCheckbox.checked;
        chartBorderColorRow.style.display = checked ? "" : "none";
        chartRadiusRow.style.display = checked ? "" : "none";
      };
      chartBorderCheckbox.addEventListener("change", updateChartBorderVisibility);
      updateChartBorderVisibility();
    }

    const bindTitleVisibility = (checkboxId: string, optionsName: string, textId: string, fallbackText: string): void => {
      const checkbox = popoverEl.querySelector(`#${checkboxId}`) as HTMLInputElement | null;
      const options = popoverEl.querySelector(`[data-title-options="${optionsName}"]`) as HTMLElement | null;
      const textInput = popoverEl.querySelector(`#${textId}`) as HTMLInputElement | null;
      if (!checkbox || !options) return;

      const updateVisibility = () => {
        options.hidden = !checkbox.checked;
        if (checkbox.checked && textInput && textInput.value.trim() === "") {
          textInput.value = fallbackText;
        }
      };
      checkbox.addEventListener("change", updateVisibility);
      updateVisibility();
    };
    bindTitleVisibility("set-title-enabled", "chart", "set-title-text", "Chart Title");
    bindTitleVisibility("set-axis-title-enabled-x", "x", "set-axis-title-x", "X Axis");
    bindTitleVisibility("set-axis-title-enabled-y", "y", "set-axis-title-y", "Y Axis");

    const bindFormattingButtons = (): void => {
      const toggleButtons = Array.from(popoverEl.querySelectorAll<HTMLButtonElement>("[data-toggle-input]"));
      for (const button of toggleButtons) {
        const inputId = button.dataset.toggleInput;
        const input = inputId ? popoverEl.querySelector<HTMLInputElement>(`#${inputId}`) : null;
        if (!input) continue;

        button.setAttribute("aria-pressed", input.checked ? "true" : "false");
        button.addEventListener("click", () => {
          input.checked = !input.checked;
          button.setAttribute("aria-pressed", input.checked ? "true" : "false");
          input.dispatchEvent(new Event("change", { bubbles: true }));
        });
      }
    };
    bindFormattingButtons();

    const bindRowsVisibility = (checkboxId: string, rowIds: readonly string[]): void => {
      const checkbox = popoverEl.querySelector(`#${checkboxId}`) as HTMLInputElement | null;
      const rows = rowIds
        .map((id) => popoverEl.querySelector(`#${id}`) as HTMLElement | null)
        .filter((row): row is HTMLElement => row !== null);
      if (!checkbox || rows.length === 0) return;

      const updateVisibility = () => {
        for (const row of rows) {
          row.style.display = checkbox.checked ? "" : "none";
        }
      };
      checkbox.addEventListener("change", updateVisibility);
      updateVisibility();
    };
    const bindAnyRowsVisibility = (checkboxIds: readonly string[], rowIds: readonly string[]): void => {
      const checkboxes = checkboxIds
        .map((id) => popoverEl.querySelector(`#${id}`) as HTMLInputElement | null)
        .filter((checkbox): checkbox is HTMLInputElement => checkbox !== null);
      const rows = rowIds
        .map((id) => popoverEl.querySelector(`#${id}`) as HTMLElement | null)
        .filter((row): row is HTMLElement => row !== null);
      if (checkboxes.length === 0 || rows.length === 0) return;

      const updateVisibility = () => {
        const visible = checkboxes.some((checkbox) => checkbox.checked);
        for (const row of rows) {
          row.style.display = visible ? "" : "none";
        }
      };
      for (const checkbox of checkboxes) {
        checkbox.addEventListener("change", updateVisibility);
      }
      updateVisibility();
    };
    bindRowsVisibility("set-grid-x", ["set-every-x-row"]);
    bindRowsVisibility("set-grid-y", ["set-every-y-row"]);
    bindAnyRowsVisibility(["set-grid-x", "set-grid-y"], ["set-grid-thickness-row", "set-grid-style-row"]);
    bindRowsVisibility("set-ticks-x", ["set-ticks-size-x-row", "set-ticks-thickness-x-row"]);
    bindRowsVisibility("set-ticks-y", ["set-ticks-size-y-row", "set-ticks-thickness-y-row"]);
    bindRowsVisibility("set-edge-blur", [
      "set-edge-blur-size-row",
      "set-edge-blur-left-row",
      "set-edge-blur-right-row",
      "set-edge-blur-top-row",
      "set-edge-blur-bottom-row"
    ]);



    const apply = (event?: Event): void => {
      const nextSpec: PlotUpdate<TDatum> = {};
      const nextPresetOpts = { ...(spec.presetOptions ?? {}) };

      if (markKind === "bar") {
        const oInput = popoverEl.querySelector("#set-bar-orientation") as HTMLSelectElement;
        const newOrientation = oInput.value;
        const prevOrientation = nextPresetOpts.orientation ?? "vertical";
        if (newOrientation !== prevOrientation) {
          const tempX = nextPresetOpts.x;
          nextPresetOpts.x = nextPresetOpts.y;
          nextPresetOpts.y = tempX;
          nextPresetOpts.orientation = newOrientation;
        }

        const cInput = popoverEl.querySelector("#set-bar-corners") as HTMLInputElement;
        const crRatio = Number(cInput.value) / 100;
        nextPresetOpts.appearance = {
          ...(nextPresetOpts.appearance ?? {}),
          cornerRadiusRatio: crRatio,
          roundBottom: (popoverEl.querySelector("#set-bar-roundbottom") as HTMLInputElement).checked,
          layeredStack: (popoverEl.querySelector("#set-bar-layered") as HTMLInputElement).checked
        };

        nextPresetOpts.gapRatio = Number((popoverEl.querySelector("#set-bar-gap") as HTMLInputElement).value);
        const interBarGapInput = popoverEl.querySelector("#set-bar-interbar-gap") as HTMLInputElement | null;
        const interGroupGapInput = popoverEl.querySelector("#set-bar-intergroup-gap") as HTMLInputElement | null;
        if (interBarGapInput) {
          nextPresetOpts.interBarGapRatio = Number(interBarGapInput.value);
        }
        if (interGroupGapInput) {
          nextPresetOpts.interGroupGapRatio = Number(interGroupGapInput.value);
        }
        nextPresetOpts.minBarWidth = Number((popoverEl.querySelector("#set-bar-minwidth") as HTMLInputElement).value);
        nextPresetOpts.minGapWidth = Number((popoverEl.querySelector("#set-bar-mingap") as HTMLInputElement).value);
        nextPresetOpts.dynamicGap = (popoverEl.querySelector("#set-bar-dynamic") as HTMLInputElement).checked;
        nextPresetOpts.dynamicGapStrength = Number((popoverEl.querySelector("#set-bar-strength") as HTMLInputElement).value);

        const labelsChecked = (popoverEl.querySelector("#set-bar-labels") as HTMLInputElement).checked;
        nextPresetOpts.valueLabels = labelsChecked ? { padding: 8 } : false;

        const hsInput = popoverEl.querySelector("#set-bar-hoverstyle") as HTMLSelectElement;
        if (hsInput) {
          nextPresetOpts.hoverStyle = hsInput.value;
        }

        nextSpec.marks = [barMark(nextPresetOpts)];
      } else if (markKind === "line") {
        const curveInput = popoverEl.querySelector("#set-line-curve") as HTMLSelectElement;
        nextPresetOpts.curve = curveInput.value;
        nextPresetOpts.area = (popoverEl.querySelector("#set-line-area") as HTMLInputElement).checked;
        const areaBaselineInput = popoverEl.querySelector("#set-line-area-baseline") as HTMLSelectElement | null;
        if (areaBaselineInput) {
          nextPresetOpts.areaBaseline = areaBaselineInput.value === "zero" ? "zero" : "plot";
        }
        const areaOverlapInput = popoverEl.querySelector("#set-line-area-overlap") as HTMLSelectElement | null;
        if (areaOverlapInput) {
          const value = areaOverlapInput.value;
          nextPresetOpts.areaOverlap =
            value === "cover" || value === "multiply" || value === "screen" ? value : "blend";
        }
        const areaOpacityInput = popoverEl.querySelector("#set-line-area-opacity") as HTMLInputElement | null;
        if (areaOpacityInput) {
          nextPresetOpts.areaOpacity = clampNumber(Number(areaOpacityInput.value), 0, 1);
        }
        const areaFillInput = popoverEl.querySelector("#set-line-area-fill") as HTMLInputElement | null;
        if (areaFillInput) {
          const fill = areaFillInput.value.trim();
          if (fill) {
            nextPresetOpts.areaFill = fill;
          } else {
            delete nextPresetOpts.areaFill;
          }
        }
        const areaStrokeInput = popoverEl.querySelector("#set-line-area-stroke") as HTMLInputElement | null;
        if (areaStrokeInput) {
          nextPresetOpts.areaStroke = areaStrokeInput.checked;
        }
        nextPresetOpts.strokeWidth = clampNumber(
          Number((popoverEl.querySelector("#set-line-width") as HTMLInputElement).value),
          0.5,
          12
        );
        nextPresetOpts.tooltipVisibleOnly = (popoverEl.querySelector("#set-line-visible-tooltip") as HTMLInputElement).checked;
        nextPresetOpts.lineFocus = (popoverEl.querySelector("#set-line-focus") as HTMLInputElement).checked;
        const hoverGuideInput = popoverEl.querySelector("#set-line-hover-guide") as HTMLSelectElement | null;
        if (hoverGuideInput) {
          nextPresetOpts.hoverGuide = hoverGuideInput.value;
        }
        const hoverGuideStyleInput = popoverEl.querySelector("#set-line-hover-guide-style") as HTMLSelectElement | null;
        if (hoverGuideStyleInput) {
          nextPresetOpts.hoverGuideStyle = hoverGuideStyleInput.value;
        }

        nextSpec.marks = [lineMark(nextPresetOpts)];
      } else if (markKind === "scatter") {
        const shapeInput = popoverEl.querySelector<HTMLSelectElement>(`#${SCATTER_SETTING_IDS.shape}`);
        const styleInput = popoverEl.querySelector<HTMLSelectElement>(`#${SCATTER_SETTING_IDS.style}`);
        const hoverModeInput = popoverEl.querySelector<HTMLSelectElement>(`#${SCATTER_SETTING_IDS.hoverMode}`);
        const hoverGrowInput = popoverEl.querySelector<HTMLInputElement>(`#${SCATTER_SETTING_IDS.hoverGrow}`);

        if (shapeInput) nextPresetOpts.shape = shapeInput.value;
        if (styleInput) nextPresetOpts.pointStyle = styleInput.value;
        if (hoverModeInput) nextPresetOpts.hoverInteraction = hoverModeInput.value;
        if (hoverGrowInput) {
          const hoverGrowRadius = Number(hoverGrowInput.value);
          if (Number.isFinite(hoverGrowRadius)) nextPresetOpts.hoverGrowRadius = hoverGrowRadius;
        }

        nextSpec.marks = [scatterMark(nextPresetOpts)];
      }

      const xGChecked = (popoverEl.querySelector("#set-grid-x") as HTMLInputElement).checked;
      const yGChecked = (popoverEl.querySelector("#set-grid-y") as HTMLInputElement).checked;
      const xEdgeGChecked = (popoverEl.querySelector("#set-edgegrid-x") as HTMLInputElement).checked;
      const yEdgeGChecked = (popoverEl.querySelector("#set-edgegrid-y") as HTMLInputElement).checked;
      const xSubgridChecked = (popoverEl.querySelector("#set-subgrid-x") as HTMLInputElement).checked;
      const ySubgridChecked = (popoverEl.querySelector("#set-subgrid-y") as HTMLInputElement).checked;
      const xTChecked = (popoverEl.querySelector("#set-ticks-x") as HTMLInputElement).checked;
      const yTChecked = (popoverEl.querySelector("#set-ticks-y") as HTMLInputElement).checked;
      const xLChecked = (popoverEl.querySelector("#set-line-x") as HTMLInputElement).checked;
      const yLChecked = (popoverEl.querySelector("#set-line-y") as HTMLInputElement).checked;
      const yAxisPositionValue = (popoverEl.querySelector("#set-y-axis-position") as HTMLSelectElement).value as "left" | "right";

      const xAngle = Number((popoverEl.querySelector("#set-angle-x") as HTMLInputElement).value);
      const yAngle = Number((popoverEl.querySelector("#set-angle-y") as HTMLInputElement).value);
      const xDensity = Number((popoverEl.querySelector("#set-density-x") as HTMLInputElement).value);
      const yDensity = Number((popoverEl.querySelector("#set-density-y") as HTMLInputElement).value);
      const xSub = (popoverEl.querySelector("#set-subticks-x") as HTMLInputElement).checked;
      const ySub = (popoverEl.querySelector("#set-subticks-y") as HTMLInputElement).checked;
      const xEveryVal = (popoverEl.querySelector("#set-every-x") as HTMLInputElement).value;
      const yEveryVal = (popoverEl.querySelector("#set-every-y") as HTMLInputElement).value;
      const thicknessVal = (popoverEl.querySelector("#set-grid-thickness") as HTMLInputElement).value;
      const gridStyleVal = (popoverEl.querySelector("#set-grid-style") as HTMLSelectElement).value;

      const xEvery = xEveryVal.trim() === "" ? undefined : Math.max(1, Math.floor(Number(xEveryVal)));
      const yEvery = yEveryVal.trim() === "" ? undefined : Math.max(1, Math.floor(Number(yEveryVal)));
      const thickness = thicknessVal.trim() === "" ? undefined : Number(thicknessVal);
      const gridlineStyle = gridStyleVal === "dotted" || gridStyleVal === "dashed" ? gridStyleVal : "solid";

      const xTickSizeVal = Number((popoverEl.querySelector("#set-ticks-size-x") as HTMLInputElement).value);
      const yTickSizeVal = Number((popoverEl.querySelector("#set-ticks-size-y") as HTMLInputElement).value);
      const xTickThicknessVal = Number((popoverEl.querySelector("#set-ticks-thickness-x") as HTMLInputElement).value);
      const yTickThicknessVal = Number((popoverEl.querySelector("#set-ticks-thickness-y") as HTMLInputElement).value);
      nextPresetOpts.yAxisPosition = yAxisPositionValue;

      const customAxes = (nextPresetOpts.axes && typeof nextPresetOpts.axes === "object") ? nextPresetOpts.axes : {};
      const customX = (customAxes.x && typeof customAxes.x === "object") ? customAxes.x : {};
      const customY = (customAxes.y && typeof customAxes.y === "object") ? customAxes.y : {};
      const parseOptionalNumber = (val: string): number | undefined => {
        if (val.trim() === "") return undefined;
        const num = Number(val);
        return Number.isFinite(num) ? num : undefined;
      };

      const chartTitleTextInput = popoverEl.querySelector("#set-title-text") as HTMLInputElement;
      const chartTitleEnabledValue = (popoverEl.querySelector("#set-title-enabled") as HTMLInputElement).checked;
      const chartTitleTextValue = chartTitleTextInput.value.trim() || "Chart Title";
      const chartTitleFontSizeValue = parseOptionalNumber((popoverEl.querySelector("#set-title-size") as HTMLInputElement).value);
      const chartTitleOffsetXValue = parseOptionalNumber((popoverEl.querySelector("#set-title-offset-x") as HTMLInputElement).value);
      const chartTitleOffsetYValue = parseOptionalNumber((popoverEl.querySelector("#set-title-offset-y") as HTMLInputElement).value);
      nextSpec.title = chartTitleEnabledValue
        ? {
            text: chartTitleTextValue,
            position: (popoverEl.querySelector("#set-title-position") as HTMLSelectElement).value as any,
            align: (popoverEl.querySelector("#set-title-align") as HTMLSelectElement).value as any,
            bold: (popoverEl.querySelector("#set-title-bold") as HTMLInputElement).checked,
            italic: (popoverEl.querySelector("#set-title-italic") as HTMLInputElement).checked,
            ...(chartTitleFontSizeValue !== undefined ? { fontSize: chartTitleFontSizeValue } : {}),
            ...(chartTitleOffsetXValue !== undefined ? { offsetX: chartTitleOffsetXValue } : {}),
            ...(chartTitleOffsetYValue !== undefined ? { offsetY: chartTitleOffsetYValue } : {})
          }
        : undefined;

      const xAxisTitleEnabledValue = (popoverEl.querySelector("#set-axis-title-enabled-x") as HTMLInputElement).checked;
      const yAxisTitleEnabledValue = (popoverEl.querySelector("#set-axis-title-enabled-y") as HTMLInputElement).checked;
      const xAxisTitleTextValue = ((popoverEl.querySelector("#set-axis-title-x") as HTMLInputElement).value).trim() || "X Axis";
      const yAxisTitleTextValue = ((popoverEl.querySelector("#set-axis-title-y") as HTMLInputElement).value).trim() || "Y Axis";
      const xAxisTitleFontSizeValue = parseOptionalNumber((popoverEl.querySelector("#set-axis-title-size-x") as HTMLInputElement).value);
      const yAxisTitleFontSizeValue = parseOptionalNumber((popoverEl.querySelector("#set-axis-title-size-y") as HTMLInputElement).value);
      const xAxisTitleOffsetXValue = parseOptionalNumber((popoverEl.querySelector("#set-axis-title-offset-x-x") as HTMLInputElement).value);
      const xAxisTitleOffsetYValue = parseOptionalNumber((popoverEl.querySelector("#set-axis-title-offset-y-x") as HTMLInputElement).value);
      const yAxisTitleOffsetXValue = parseOptionalNumber((popoverEl.querySelector("#set-axis-title-offset-x-y") as HTMLInputElement).value);
      const yAxisTitleOffsetYValue = parseOptionalNumber((popoverEl.querySelector("#set-axis-title-offset-y-y") as HTMLInputElement).value);
      const xAxisTitle = xAxisTitleEnabledValue
        ? {
            text: xAxisTitleTextValue,
            position: (popoverEl.querySelector("#set-axis-title-position-x") as HTMLSelectElement).value as any,
            align: (popoverEl.querySelector("#set-axis-title-align-x") as HTMLSelectElement).value as any,
            bold: (popoverEl.querySelector("#set-axis-title-bold-x") as HTMLInputElement).checked,
            italic: (popoverEl.querySelector("#set-axis-title-italic-x") as HTMLInputElement).checked,
            ...(xAxisTitleFontSizeValue !== undefined ? { fontSize: xAxisTitleFontSizeValue } : {}),
            ...(xAxisTitleOffsetXValue !== undefined ? { offsetX: xAxisTitleOffsetXValue } : {}),
            ...(xAxisTitleOffsetYValue !== undefined ? { offsetY: xAxisTitleOffsetYValue } : {})
          }
        : undefined;
      const yAxisTitle = yAxisTitleEnabledValue
        ? {
            text: yAxisTitleTextValue,
            position: (popoverEl.querySelector("#set-axis-title-position-y") as HTMLSelectElement).value as any,
            align: (popoverEl.querySelector("#set-axis-title-align-y") as HTMLSelectElement).value as any,
            bold: (popoverEl.querySelector("#set-axis-title-bold-y") as HTMLInputElement).checked,
            italic: (popoverEl.querySelector("#set-axis-title-italic-y") as HTMLInputElement).checked,
            ...(yAxisTitleFontSizeValue !== undefined ? { fontSize: yAxisTitleFontSizeValue } : {}),
            ...(yAxisTitleOffsetXValue !== undefined ? { offsetX: yAxisTitleOffsetXValue } : {}),
            ...(yAxisTitleOffsetYValue !== undefined ? { offsetY: yAxisTitleOffsetYValue } : {})
          }
        : undefined;

      nextPresetOpts.axes = {
        x: {
          ...customX,
          title: xAxisTitle,
          gridlines: xGChecked,
          edgeGridlines: xEdgeGChecked,
          subgridlines: xSubgridChecked,
          ticks: xTChecked,
          line: xLChecked,
          labelAngle: Number.isFinite(xAngle) ? xAngle : undefined,
          tickDensity: Number.isFinite(xDensity) ? xDensity : undefined,
          subticks: xSub,
          tickSize: Number.isFinite(xTickSizeVal) ? xTickSizeVal : undefined,
          tickThickness: Number.isFinite(xTickThicknessVal) ? xTickThicknessVal : undefined,
          ...(xEvery !== undefined ? { gridlineEvery: xEvery } : {}),
          ...(thickness !== undefined ? { gridlineThickness: thickness } : {}),
          gridlineStyle
        },
        y: {
          ...customY,
          position: yAxisPositionValue,
          title: yAxisTitle,
          gridlines: yGChecked,
          edgeGridlines: yEdgeGChecked,
          subgridlines: ySubgridChecked,
          ticks: yTChecked,
          line: yLChecked,
          labelAngle: Number.isFinite(yAngle) ? yAngle : undefined,
          tickDensity: Number.isFinite(yDensity) ? yDensity : undefined,
          subticks: ySub,
          tickSize: Number.isFinite(yTickSizeVal) ? yTickSizeVal : undefined,
          tickThickness: Number.isFinite(yTickThicknessVal) ? yTickThicknessVal : undefined,
          ...(yEvery !== undefined ? { gridlineEvery: yEvery } : {}),
          ...(thickness !== undefined ? { gridlineThickness: thickness } : {}),
          gridlineStyle
        }
      };

      const colorBg = (popoverEl.querySelector("#set-color-bg") as HTMLInputElement).value;
      const colorPlotBg = (popoverEl.querySelector("#set-color-plot-bg") as HTMLInputElement).value;
      const colorFg = (popoverEl.querySelector("#set-color-fg") as HTMLInputElement).value;
      const colorGrid = (popoverEl.querySelector("#set-color-grid") as HTMLInputElement).value;

      const currentTheme = spec.theme ?? defaultTheme;
      nextSpec.theme = {
        ...currentTheme,
        palette: {
          ...currentTheme.palette,
          background: colorBg,
          plotBackground: colorPlotBg,
          foreground: colorFg,
          grid: colorGrid
        }
      };

      if (spec.axes !== undefined) {
        if (typeof spec.axes === "function") {
          nextSpec.axes = spec.axes;
        } else {
          nextSpec.axes = {
            ...spec.axes,
            x: {
              ...spec.axes.x,
              ...nextPresetOpts.axes.x
            },
            y: {
              ...spec.axes.y,
              ...nextPresetOpts.axes.y
            }
          };
        }
      } else {
        nextSpec.axes = nextPresetOpts.axes;
      }

      const padTopVal = (popoverEl.querySelector("#set-pad-top") as HTMLInputElement).value;
      const padRightVal = (popoverEl.querySelector("#set-pad-right") as HTMLInputElement).value;
      const padBottomVal = (popoverEl.querySelector("#set-pad-bottom") as HTMLInputElement).value;
      const padLeftVal = (popoverEl.querySelector("#set-pad-left") as HTMLInputElement).value;

      const parsePadding = (val: string): number | undefined => {
        return parseOptionalNumber(val);
      };

      const plotPadding: Required<PlotSpec>["plotPadding"] = {};
      const topPad = parsePadding(padTopVal);
      const rightPad = parsePadding(padRightVal);
      const bottomPad = parsePadding(padBottomVal);
      const leftPad = parsePadding(padLeftVal);
      if (topPad !== undefined) plotPadding.top = topPad;
      if (rightPad !== undefined) plotPadding.right = rightPad;
      if (bottomPad !== undefined) plotPadding.bottom = bottomPad;
      if (leftPad !== undefined) plotPadding.left = leftPad;

      nextSpec.plotPadding = plotPadding;

      const borderCheckedInput = popoverEl.querySelector("#set-border") as HTMLInputElement | null;
      const borderChecked = borderCheckedInput ? borderCheckedInput.checked : false;
      const borderRadiusInput = popoverEl.querySelector("#set-border-radius") as HTMLInputElement | null;
      const borderRadiusVal = borderRadiusInput ? Number(borderRadiusInput.value) : NaN;
      const borderColorInput = popoverEl.querySelector("#set-color-border") as HTMLInputElement | null;
      const borderColorVal = borderColorInput ? borderColorInput.value : "";

      if (borderChecked) {
        nextSpec.frame = {
          border: true,
          plotAreaStroke: borderColorVal,
          ...(Number.isFinite(borderRadiusVal) && borderRadiusVal > 0 ? { cornerRadius: borderRadiusVal } : {})
        };
      } else {
        nextSpec.frame = false;
      }

      const chartBorderEnabledInput = popoverEl.querySelector("#set-chart-border") as HTMLInputElement | null;
      const chartBorderEnabled = chartBorderEnabledInput ? chartBorderEnabledInput.checked : false;
      const chartBorderRadiusInput = popoverEl.querySelector("#set-chart-border-radius") as HTMLInputElement | null;
      const chartBorderRadius = chartBorderRadiusInput ? Number(chartBorderRadiusInput.value) : 12;
      const chartBorderColorInput = popoverEl.querySelector("#set-color-chart-border") as HTMLInputElement | null;
      const chartBorderColor = chartBorderColorInput ? chartBorderColorInput.value : "#cbd5e1";

      nextSpec.chartBorder = {
        enabled: chartBorderEnabled,
        radius: Number.isFinite(chartBorderRadius) ? chartBorderRadius : 12,
        color: chartBorderColor
      };



      const edgeBlurInput = popoverEl.querySelector("#set-edge-blur") as HTMLInputElement | null;
      if (edgeBlurInput) {
        const edgeBlurSizeInput = popoverEl.querySelector("#set-edge-blur-size") as HTMLInputElement | null;
        const edgeBlurSizeValue = edgeBlurSizeInput ? Number(edgeBlurSizeInput.value) : NaN;
        nextSpec.edgeBlur = edgeBlurInput.checked
          ? {
              left: (popoverEl.querySelector("#set-edge-blur-left") as HTMLInputElement | null)?.checked ?? true,
              right: (popoverEl.querySelector("#set-edge-blur-right") as HTMLInputElement | null)?.checked ?? true,
              top: (popoverEl.querySelector("#set-edge-blur-top") as HTMLInputElement | null)?.checked ?? true,
              bottom: (popoverEl.querySelector("#set-edge-blur-bottom") as HTMLInputElement | null)?.checked ?? true,
              size: Number.isFinite(edgeBlurSizeValue) ? edgeBlurSizeValue : 28
            }
          : false;
      }

      const tPos = (popoverEl.querySelector("#set-tooltip-pos") as HTMLSelectElement).value;
      const tooltipTabular = (popoverEl.querySelector("#set-tooltip-tabular") as HTMLInputElement | null)?.checked ?? false;
      nextSpec.tooltip = {
        ...(spec.tooltip && typeof spec.tooltip === "object" ? spec.tooltip : {}),
        position: tPos as any,
        tabularNumbers: tooltipTabular
      };

      const animProfileVal = (popoverEl.querySelector("#set-anim-profile") as HTMLSelectElement).value;
      const animFadeChecked = (popoverEl.querySelector("#set-anim-fade") as HTMLInputElement)?.checked ?? false;
      const animDurationVal = Number((popoverEl.querySelector("#set-anim-duration") as HTMLInputElement).value);
      const axisAnimProfileVal = (popoverEl.querySelector("#set-axis-anim-profile") as HTMLSelectElement).value;
      const axisAnimDurationVal = (popoverEl.querySelector("#set-axis-anim-duration") as HTMLInputElement).value;
      const animEasingVal = (popoverEl.querySelector("#set-anim-easing") as HTMLSelectElement).value;
      const axisAnimEasingVal = (popoverEl.querySelector("#set-axis-anim-easing") as HTMLSelectElement).value;
      const titleAnimationVal = (popoverEl.querySelector("#set-title-animation") as HTMLSelectElement).value as TitleAnimationProfile;

      nextPresetOpts.animationProfile = animProfileVal;
      nextPresetOpts.randomFillFade = animFadeChecked;
      nextPresetOpts.animationDuration = animDurationVal;
      nextPresetOpts.axisAnimationProfile = axisAnimProfileVal;
      nextPresetOpts.axisAnimationDuration = axisAnimDurationVal.trim() === "" ? undefined : Number(axisAnimDurationVal);
      nextPresetOpts.animationEasing = animEasingVal;
      nextPresetOpts.axisAnimationEasing = axisAnimEasingVal;

      nextSpec.axisAnimation = axisAnimProfileVal as any;
      nextSpec.animationDuration = animDurationVal;
      nextSpec.axisAnimationDuration = axisAnimDurationVal.trim() === "" ? undefined : Number(axisAnimDurationVal);
      nextSpec.animationEasing = animEasingVal === "auto" ? undefined : animEasingVal as any;
      nextSpec.axisAnimationEasing = axisAnimEasingVal === "auto" ? undefined : axisAnimEasingVal as any;
      nextSpec.titleAnimation = titleAnimationVal;

      const changedId = event?.target instanceof Element ? event.target.id : "";
      if (changedId.startsWith("set-inter-") || changedId === "set-view-autoscale" || changedId === "set-view-smooth-pan") {
        const interactions = (spec.interactions && typeof spec.interactions === "object") ? spec.interactions : {};
        const selChecked = (popoverEl.querySelector("#set-inter-select") as HTMLInputElement).checked;
        const zoomChecked = (popoverEl.querySelector("#set-inter-zoom") as HTMLInputElement).checked;
        const panChecked = (popoverEl.querySelector("#set-inter-pan") as HTMLInputElement).checked;
        const smoothChecked = (popoverEl.querySelector("#set-view-smooth-pan") as HTMLInputElement).checked;
        const dragMode = (popoverEl.querySelector("#set-inter-drag") as HTMLSelectElement).value;
        const autoscaleChecked = (popoverEl.querySelector("#set-view-autoscale") as HTMLInputElement).checked;

        nextSpec.interactions = {
          ...interactions,
          selection: selChecked ? preserveInteractionOptions(interactions.selection) : false,
          zoom: zoomChecked ? preserveInteractionOptions(interactions.zoom) : false,
          pan: panChecked ? { ...preserveInteractionOptions(interactions.pan), smooth: smoothChecked } : false,
          dragInteraction: dragMode as any,
          focusMode: autoscaleChecked ? "index" : "domain"
        };
      }

      if (changedId === "set-view-animate-scale") {
        const smoothedScalingChecked = (popoverEl.querySelector("#set-view-animate-scale") as HTMLInputElement).checked;
        nextSpec.smoothedScaling = smoothedScalingChecked;
      }

      initialSpec.presetOptions = nextPresetOpts;
      spec.presetOptions = nextPresetOpts;
      plot.update(nextSpec);
    };

    popoverEl.querySelectorAll("input, select").forEach((input) => {
      input.addEventListener("change", apply);
      if (input.tagName === "INPUT" && (input.getAttribute("type") === "number" || input.getAttribute("type") === "range" || input.getAttribute("type") === "text")) {
        input.addEventListener("input", apply);
      }
    });
    const showColorPresets = (targetId: string): void => {
      popoverEl.querySelectorAll<HTMLElement>("[data-color-presets-for]").forEach((presets) => {
        presets.hidden = presets.dataset.colorPresetsFor !== targetId;
      });
      updateMenuScrollability(settingsContent);
    };
    popoverEl.querySelectorAll<HTMLInputElement>("input[type='color']").forEach((input) => {
      const hasPresets = popoverEl.querySelector(`[data-color-presets-for="${input.id}"]`) !== null;
      if (!hasPresets) return;

      input.addEventListener("click", () => showColorPresets(input.id));
      input.addEventListener("focus", () => showColorPresets(input.id));
    });
    popoverEl.querySelectorAll<HTMLButtonElement>("[data-color-target][data-color-value]").forEach((button) => {
      button.addEventListener("click", () => {
        const targetId = button.dataset.colorTarget;
        const color = button.dataset.colorValue;
        const input = targetId ? popoverEl.querySelector<HTMLInputElement>(`#${targetId}`) : null;
        if (!input || !color) return;

        input.value = color;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
    });

    popoverEl.querySelector("#set-btn-animate")?.addEventListener("click", () => {
      const durationMs = Number((popoverEl.querySelector("#set-anim-duration") as HTMLInputElement).value);
      const axisDurationVal = (popoverEl.querySelector("#set-axis-anim-duration") as HTMLInputElement).value;
      const axisDurationMs = axisDurationVal.trim() === "" ? durationMs : Number(axisDurationVal);
      const profile = (popoverEl.querySelector("#set-anim-profile") as HTMLSelectElement).value as any;
      const axisProfile = (popoverEl.querySelector("#set-axis-anim-profile") as HTMLSelectElement).value as any;
      const easing = (popoverEl.querySelector("#set-anim-easing") as HTMLSelectElement).value as any;
      const axisEasing = (popoverEl.querySelector("#set-axis-anim-easing") as HTMLSelectElement).value as any;
      const randomFillFade = (popoverEl.querySelector("#set-anim-fade") as HTMLInputElement)?.checked ?? false;

      plot.animate({
        durationMs,
        axisDurationMs,
        profile,
        axisProfile,
        easing: easing === "auto" ? undefined : easing,
        axisEasing: axisEasing === "auto" ? undefined : axisEasing,
        randomFillFade
      });
    });
    popoverEl.querySelector("#set-export-png")?.addEventListener("click", () => {
      downloadCanvasPng(surface as ExportableCanvasSurface);
    });
    popoverEl.querySelector("#set-btn-reset")?.addEventListener("click", () => {
      plot.resetFocus();
    });
    popoverEl.querySelector("#set-btn-fullscreen")?.addEventListener("click", () => {
      const containerEl = popoverEl.parentElement instanceof HTMLElement ? popoverEl.parentElement : null;
      if (containerEl) {
        const target = resolveFullscreenTarget(containerEl);
        popoverEl.classList.remove("show");
        containerEl.querySelector(".plot-settings-btn")?.classList.remove("active");
        toggleFullscreen(target);
      }
    });
  }

  if (container instanceof HTMLElement) {
    setupSettingsUI(container, plotInstance);
    applyChartBorderStyles(container, spec.chartBorder);
  }

  return plotInstance;

  function scheduleFocusSettle(): void {
    if (focusSettleTimer !== undefined) {
      clearTimeout(focusSettleTimer);
    }
    focusSettleTimer = setTimeout(() => {
      focusSettleTimer = undefined;
      if (renderCache && canSkipFocusSettleFullRedraw(renderCache)) {
        isContinuousInteractionActive = false;
        if (continuousInteractionTimer !== undefined) {
          clearTimeout(continuousInteractionTimer);
          continuousInteractionTimer = undefined;
        }
        setChartHoverSuspended(false);
        scheduleTickFadeFrame(hasActiveTickFade());
        hoverController?.forceRefresh();
        renderScatterHoverOverlay();
        tooltipController?.refresh();
        return;
      }
      isContinuousInteractionActive = false;
      if (continuousInteractionTimer !== undefined) {
        clearTimeout(continuousInteractionTimer);
        continuousInteractionTimer = undefined;
      }
      setChartHoverSuspended(false);
      forceFullRedrawFlag = true;
      scheduleRedraw();
    }, FOCUS_SETTLE_MS);
  }

  function scheduleRedraw(): void {
    if (resizeSettleTimer !== undefined) {
      return;
    }
    if (scheduledRedrawFrame !== undefined || isViewportAnimating) {
      return;
    }

    scheduledRedrawFrame = requestAnimationFrame(() => {
      scheduledRedrawFrame = undefined;
      redraw();
      // Re-hit-test after every redraw. Pointermove alone is not enough while
      // streaming: the cursor can stay still as data moves underneath it.
      hoverController?.forceRefresh();
      renderScatterHoverOverlay();
      tooltipController?.refresh();
    });
  }

  function scheduleResizeRedraw(): void {
    // Resize owns the frame budget while an intro/replay is actively running.
    // A startEmpty plot has progress 0 but no RAF yet; keep that pending reveal
    // empty when its container receives an initial ResizeObserver notification.
    const interruptedAnimation = animationFrame !== undefined;
    if (interruptedAnimation) {
      if (animationFrame !== undefined) {
        cancelAnimationFrame(animationFrame);
        animationFrame = undefined;
      }
      markAnimationProgress = 1;
      axisAnimationActive = false;
      axisAnimationRuntime = undefined;
      axisAnimationProfile = "none";
      animationProfile = undefined;
      scatterAnimationCache = undefined;
      scatterAnimationCacheKey = undefined;
      resetTickFadeForAxisAnimation();
    }

    if (resizeSettleTimer !== undefined) {
      clearTimeout(resizeSettleTimer);
    }
    // Resize frames already sample axis tick opacity. Do not leave an
    // independent fade frame queued as well: dashboards resize several plots
    // together, so that duplicate loop multiplies the per-frame axes work.
    if (tickFadeFrame !== undefined) {
      cancelAnimationFrame(tickFadeFrame);
      tickFadeFrame = undefined;
    }
    resizeSettleTimer = setTimeout(() => {
      resizeSettleTimer = undefined;
      // Dashboard preview may skip this plot's WebGL paint for a frame. The
      // settle pass must replace that retained surface, even if only ticks are
      // otherwise dirty, or the axes and point cloud can end at different sizes.
      const needsPointCloudResizeRedraw = pointCloudResizeDrawDeferred;
      pointCloudResizeDrawDeferred = false;
      if (suppressTickFadeUntilResizeSettles) {
        // The dashboard exit resize already painted its final ticks at full
        // opacity. Resetting before the settle render makes any exact rebuild
        // treat those ticks as established instead of introducing a late fade.
        suppressTickFadeUntilResizeSettles = false;
        resetTickFadeForAxisAnimation();
      }
      forceFullRedrawFlag = needsPointCloudResizeRedraw || streamingDataAppended || !renderCache;
      updateSettingsButtonsPosition(surface);
      if (!forceFullRedrawFlag && renderCache && currentAxes && hasActiveTickFade()) {
        redrawAxisTickFadeFrame();
        return;
      }
      scheduleRedraw();
    }, RESIZE_SETTLE_MS);

    // A queued domain-interpolation frame reads the latest `size`, so let it
    // resize and interpolate in one paint instead of drawing this chart twice.
    if (scheduledRedrawFrame !== undefined || domainAnimFrame !== undefined) {
      return;
    }

    scheduledRedrawFrame = requestAnimationFrame((time) => {
      scheduledRedrawFrame = undefined;
      const deferPointCloudDraw = dashboardResizePreviewEnabled(spec) &&
        pointCloudResizePhase !== undefined &&
        !isPointCloudResizePaintSlot(time, pointCloudResizePhase);
      if (redrawResizeFastPath(deferPointCloudDraw)) {
        pointCloudResizeDrawDeferred = deferPointCloudDraw;
        return;
      }
      if (redrawResizeCacheFastPath()) {
        pointCloudResizeDrawDeferred = false;
        return;
      }
      pointCloudResizeDrawDeferred = false;
      forceFullRedrawFlag = true;
      redraw({
        skipHover: hover?.markType === "scatter",
        skipInteractionRefresh: true
      });
    });
  }

  function scheduleInteractionRedraw(): void {
    if (resizeSettleTimer !== undefined) {
      clearTimeout(resizeSettleTimer);
      resizeSettleTimer = undefined;
    }

    if (isViewportAnimating) {
      return;
    }

    if (scheduledRedrawFrame !== undefined) {
      cancelAnimationFrame(scheduledRedrawFrame);
      scheduledRedrawFrame = undefined;
    }

    scheduledRedrawFrame = requestAnimationFrame(() => {
      scheduledRedrawFrame = undefined;
      if (USE_FOCUS_PREVIEW_FAST_PATH && !isStreamingActive(lastDataUpdateTime)) {
        if (!redrawFocusPreviewFastPath()) {
          redraw({ skipHover: hover?.markType === "scatter", skipInteractionRefresh: true });
        }
      } else {
        redraw({ skipHover: hover?.markType === "scatter", skipInteractionRefresh: true });
      }
      const deferDenseScatterHover = isContinuousInteractionActive &&
        renderCache !== undefined &&
        canSkipFocusSettleFullRedraw(renderCache);
      if (!deferDenseScatterHover) {
        hoverController?.forceRefresh();
        // Overlay hover geometry is view-dependent even when the hovered datum
        // identity is unchanged, so rebuild it after every focus update.
        if (hover?.markType !== "scatter") {
          renderCurrentHoverOverlay();
        }
        renderScatterHoverOverlay();
        tooltipController?.refresh();
      } else {
        tooltipController?.hide();
      }
    });
  }

  function redrawResizeFastPath(deferPointCloudDraw = false): boolean {
    if (
      markAnimationProgress < 1 ||
      axisAnimationActive ||
      !renderCache ||
      forceFullRedrawFlag ||
      renderCache.size.width === size.width && renderCache.size.height === size.height ||
      !canUseFocusFastPath(renderCache, spec, renderCache.size)
    ) {
      return false;
    }

    const theme = spec.theme ?? defaultTheme;
    // Keep the exact domain currently on screen. A resize can arrive between
    // two zoom interpolation frames; jumping to the target focus here causes
    // both a teleport and an old-size viewport until interpolation catches up.
    const axes = currentAxes ?? renderCache.axes;

    if (!axes) {
      return false;
    }

    const layout = computeLayout(size, theme, axes, spec.plotPadding, spec.title, spec.hiddenSeries);
    const xDomain = resolveLayoutXDomain(axes);
    const yDomain = resolveLayoutYDomain(axes);
    const markPrimitives = patchPointCloudPlotArea(
      patchPointCloudDomains(renderCache.markPrimitives, xDomain, yDomain),
      layout.plotArea
    );
    const framePrimitives = spec.frame === false
      ? []
      : encodeFrame(size, layout.plotArea, theme, spec.frame);
    const { gridPrimitives, axisPrimitives: baseAxisPrimitives } = encodeGridAndAxesWithTickFade(
      axes,
      layout.plotArea,
      theme,
      undefined,
      undefined,
      true
    );
    const axisPrimitives = [
      ...baseAxisPrimitives,
      ...encodePlotLabels(spec, axes, size, layout.plotArea, theme, 1),
      ...encodeLiveYValueTickers(
        (renderCache.viewData ?? []) as readonly TDatum[],
        spec,
        layout.plotArea,
        theme,
        xDomain,
        yDomain
      )
    ];
    const backgroundPrimitives = encodeChartBackground(size, layout.plotArea, theme);
    const contentKey = buildContentKey(spec, size, focus, undefined);

    currentAxes = axes;

    renderCache = {
      ...renderCache,
      contentKey,
      stableContentKey: buildStableContentKey(spec, focus),
      dataContentKey: buildDataContentKey(spec, size),
      size,
      plotArea: layout.plotArea,
      axes,
      backgroundPrimitives,
      framePrimitives,
      gridPrimitives,
      markPrimitives,
      axisPrimitives
    };

    resizeHoverEncodeContext(layout.plotArea);
    scene = sceneWithOverlayHover({
      size,
      plotArea: layout.plotArea,
      ...(renderCache.dataFocusAxis ? { dataFocusAxis: renderCache.dataFocusAxis } : {}),
      primitives: [
        ...backgroundPrimitives,
        ...framePrimitives,
        ...gridPrimitives,
        ...markPrimitives,
        ...axisPrimitives
      ],
      growOnlyCanvas: true,
      ...(deferPointCloudDraw ? { deferPointCloudDraw: true } : {})
    }, renderCache.dataWindow);

    renderScene(scene);
    return true;
  }

  function redrawResizeCacheFastPath(): boolean {
    const cache = renderCache;
    if (
      markAnimationProgress < 1 ||
      axisAnimationActive ||
      isViewportAnimating ||
      streamingDataAppended ||
      !cache ||
      forceFullRedrawFlag ||
      cache.size.width === size.width && cache.size.height === size.height ||
      cache.stableContentKey !== buildStableContentKey(spec, focus)
    ) {
      return false;
    }

    const axes = cache.axes;
    const theme = spec.theme ?? defaultTheme;
    const layout = computeLayout(size, theme, axes, spec.plotPadding, spec.title, spec.hiddenSeries);
    const transform = resizePlotAreaTransform(cache.plotArea, layout.plotArea);
    if (!transform) {
      return false;
    }

    if (!canTransformResizeMarkPrimitives(cache.markPrimitives)) {
      return false;
    }

    const markPrimitives = bakeResizeMarkPrimitives(cache.markPrimitives, transform);
    if (!markPrimitives) {
      return false;
    }
    const framePrimitives = spec.frame === false
      ? []
      : encodeFrame(size, layout.plotArea, theme, spec.frame);
    const { gridPrimitives, axisPrimitives: baseAxisPrimitives } = encodeGridAndAxesWithTickFade(
      axes,
      layout.plotArea,
      theme,
      undefined,
      undefined,
      true
    );
    const axisPrimitives = [
      ...baseAxisPrimitives,
      ...encodePlotLabels(spec, axes, size, layout.plotArea, theme, 1),
      ...encodeLiveYValueTickers(
        (cache.viewData ?? []) as readonly TDatum[],
        spec,
        layout.plotArea,
        theme,
        resolveLayoutXDomain(axes),
        resolveLayoutYDomain(axes)
      )
    ];
    const backgroundPrimitives = encodeChartBackground(size, layout.plotArea, theme);

    scene = sceneWithOverlayHover({
      size,
      plotArea: layout.plotArea,
      ...(cache.dataFocusAxis ? { dataFocusAxis: cache.dataFocusAxis } : {}),
      primitives: [
        ...backgroundPrimitives,
        ...framePrimitives,
        ...gridPrimitives,
        ...markPrimitives,
        ...axisPrimitives
      ],
      growOnlyCanvas: true
    }, cache.dataWindow);

    currentAxes = axes;
    currentDataFocusAxis = cache.dataFocusAxis ?? "x";
    renderCache = {
      ...cache,
      contentKey: buildContentKey(spec, size, focus, undefined),
      dataContentKey: buildDataContentKey(spec, size),
      size,
      plotArea: layout.plotArea,
      backgroundPrimitives,
      framePrimitives,
      gridPrimitives,
      markPrimitives,
      axisPrimitives,
      ...(cache.clipArea ? { clipArea: transformResizeRect(cache.clipArea, transform) } : {})
    };

    resizeHoverEncodeContext(layout.plotArea);
    renderScene(scene);
    return true;
  }

  function resizeHoverEncodeContext(plotArea: Rect): void {
    const context = lastHoverEncodeContext;
    if (!context ||
      context.size.width === size.width &&
      context.size.height === size.height &&
      context.plotArea.x === plotArea.x &&
      context.plotArea.y === plotArea.y &&
      context.plotArea.width === plotArea.width &&
      context.plotArea.height === plotArea.height
    ) {
      return;
    }

    const transform = resizePlotAreaTransform(context.plotArea, plotArea);
    if (!transform) {
      lastHoverEncodeContext = undefined;
      return;
    }

    const markPlotArea = transformResizeRect(context.markLayout.plotArea, transform);
    const clipArea = context.markLayout.clipArea
      ? transformResizeRect(context.markLayout.clipArea, transform)
      : undefined;

    lastHoverEncodeContext = {
      ...context,
      size,
      plotArea,
      markLayout: {
        ...context.markLayout,
        size,
        plotArea: markPlotArea,
        ...(clipArea ? { clipArea } : {})
      }
    };
  }

  function redraw(
    options: {
      skipHover?: boolean;
      skipInteractionRefresh?: boolean;
      skipOverlayRefresh?: boolean;
    } = {},
    overrideXDomain?: readonly [number, number],
    overrideYDomain?: readonly [number, number]
  ): void {
    const encodedHover = options.skipHover ? undefined : markEncodeHover();
    const contentKey = buildContentKey(spec, size, focus, encodedHover);
    const animating = markAnimationProgress < 1 || axisAnimationActive;
    const scatterAnimKey = buildScatterAnimationCacheKey();
    const isAnimOverride = overrideXDomain !== undefined || overrideYDomain !== undefined;

    if (
      animating &&
      isScatterGpuAnimationProfile(animationProfile) &&
      scatterAnimationCache &&
      scatterAnimationCacheKey === scatterAnimKey
    ) {
      redrawScatterAnimationFastPath(scatterAnimationCache);
      skipLerpOnce = false;
      skipXFocusLerpOnce = false;
      return;
    }

    if (renderCache === undefined) {
      targetXDomain = undefined;
      targetYDomain = undefined;
      lastResolvedFocusForTarget = undefined;
    }

    if (!isAnimOverride) {
      if (
        !animating &&
        !streamingDataAppended &&
        renderCache?.contentKey === contentKey &&
        !forceFullRedrawFlag &&
        (!lockedViewport || lockedViewportMatchesLastRender())
      ) {
        scene = sceneWithOverlayHover(assembleSceneFromCache(renderCache, encodedHover));
        renderScene(scene);
        skipLerpOnce = false;
        skipXFocusLerpOnce = false;
        streamingDataAppended = false;
        return;
      }

      if (streamingDataAppended && renderCache && !animating && encodedHover === undefined && !forceFullRedrawFlag) {
        // Scatter streaming cannot freeze a locked window; line streaming can.
        if (!lockedViewport && canUseStreamingFastPath(renderCache)) {
          redrawStreamingFastPath(renderCache, contentKey);
          skipLerpOnce = false;
          skipXFocusLerpOnce = false;
          streamingDataAppended = false;
          return;
        }
        if (canUseLineStreamingFastPath(renderCache, spec)) {
          redrawLineStreamingFastPath(renderCache, contentKey);
          skipLerpOnce = false;
          skipXFocusLerpOnce = false;
          streamingDataAppended = false;
          return;
        }
      }

      if (
        !streamingDataAppended &&
        !animating &&
        encodedHover === undefined &&
        !forceFullRedrawFlag &&
        isStreamingActive(lastDataUpdateTime) &&
        renderCache &&
        canUseLineStreamingFastPath(renderCache, spec)
      ) {
        redrawLineStreamingFastPath(renderCache, contentKey);
        skipLerpOnce = false;
        skipXFocusLerpOnce = false;
        return;
      }

      if (
        !animating &&
        encodedHover === undefined &&
        renderCache &&
        canUseFocusFastPath(renderCache, spec, size) &&
        !forceFullRedrawFlag &&
        (!smoothedScalingEnabled ||
          isContinuousInteractionActive ||
          lockedViewport ||
          canUseRawPointCloudFocusInterpolation(renderCache))
      ) {
        redrawFocusFastPath(renderCache, contentKey);
        skipLerpOnce = false;
        skipXFocusLerpOnce = false;
        streamingDataAppended = false;
        return;
      }
    }

    streamingDataAppended = false;

    forceFullRedrawFlag = false;

    const streamingActive = isStreamingActive(lastDataUpdateTime);
    if (streamingActive && cachedBaseAxes && isDataSource(spec.data)) {
      const patched = patchCachedBaseAxesFromSource(
        spec.data,
        cachedBaseAxes,
        (next) => {
          cachedBaseAxes = next;
        },
        hasHiddenSeries(spec)
      );

      if (patched) {
        cachedBaseAxes = patched;
      }

      if (cachedBaseAxes.axes?.x?.kind === "linear") {
        targetXDomain = focus?.x
          ? domainFromFocusRatio(cachedBaseAxes.axes.x.domain, focus.x)
          : cachedBaseAxes.axes.x.domain;
      }

      if (cachedBaseAxes.axes?.y?.kind === "linear") {
        targetYDomain = resolveViewportYDomain(
          cachedBaseAxes.data,
          targetXDomain,
          cachedBaseAxes.axes.y.domain
        );
      }

      lastResolvedFocusForTarget = focus;
    }

    let targetX = lockedViewport?.x ?? targetXDomain;
    let targetY = lockedViewport?.y ?? targetYDomain;

    if (
      targetX === undefined ||
      targetY === undefined ||
      isFocusDifferent(lastResolvedFocusForTarget, focus) ||
      lockedViewport
    ) {
      const targetBuilt = buildScene(
        spec,
        size,
        markAnimationProgress,
        axisAnimationRuntime,
        animationProfile,
        randomFillFade,
        focus,
        encodedHover,
        () => cachedBaseAxes,
        () => {},
        { hoverOnly: true, skipMarks: true },
        currentDataFocusAxis
      );
      targetX = lockedViewport?.x ?? resolveLayoutXDomain(targetBuilt.axes);
      targetY = lockedViewport?.y ?? resolveLayoutYDomain(targetBuilt.axes);
      if (!lockedViewport) {
        targetXDomain = targetX;
        targetYDomain = targetY;
      }
      lastResolvedFocusForTarget = focus;
    }

    let activeX = targetX;
    let activeY = targetY;
    let activeFocus = focus;
    let needsMoreFrames = false;

    const allowXImmediateSmoothing = skipXFocusLerpOnce && !isAnimOverride && !skipLerpOnce;
    const seriesToggledRecently = wasSeriesToggledRecently();
    // Series toggles must always be allowed to lerp Y, even if a pan/zoom
    // interaction flag is still set — otherwise windowed autoscale snaps.
    if (
      smoothedScalingEnabled &&
      (!isContinuousInteractionActive || allowXImmediateSmoothing || seriesToggledRecently) &&
      !isAnimOverride &&
      !skipLerpOnce
    ) {
      const FAST_LERP = 0.25;
      const VIEW_LERP = 0.12;
      const SLOW_LERP = 0.05;
      const EPSILON = 1e-4;

      const isAutoscale = resolveFocusMode(spec) === "index";
      const isViewportTransition = !skipXFocusLerpOnce && isFocusDifferent(lastRenderedFocus, focus);

      if (lockedViewport) {
        if (lastRenderedXDomain !== undefined && targetX !== undefined) {
          const next = lerpDomain(lastRenderedXDomain, targetX, FAST_LERP, EPSILON);
          activeX = next.domain;
          needsMoreFrames = needsMoreFrames || next.needsMoreFrames;
        }

        if (lastRenderedYDomain !== undefined && targetY !== undefined) {
          const next = lerpDomain(lastRenderedYDomain, targetY, FAST_LERP, EPSILON);
          activeY = next.domain;
          needsMoreFrames = needsMoreFrames || next.needsMoreFrames;
        }
      } else if (isViewportTransition && !seriesToggledRecently) {
        const curFocusX = lastRenderedFocus?.x ?? [0, 1];
        const curFocusY = lastRenderedFocus?.y ?? [0, 1];
        const targetFocusX = focus?.x ?? [0, 1];
        const targetFocusY = focus?.y ?? [0, 1];

        let nextFocusX = curFocusX;
        let nextFocusY = curFocusY;
        let focusNeedsMore = false;

        const diffX0 = Math.abs(targetFocusX[0] - curFocusX[0]);
        const diffX1 = Math.abs(targetFocusX[1] - curFocusX[1]);
        if (diffX0 > EPSILON || diffX1 > EPSILON) {
          nextFocusX = [
            curFocusX[0] + (targetFocusX[0] - curFocusX[0]) * VIEW_LERP,
            curFocusX[1] + (targetFocusX[1] - curFocusX[1]) * VIEW_LERP
          ];
          focusNeedsMore = true;
        } else {
          nextFocusX = targetFocusX;
        }

        const diffY0 = Math.abs(targetFocusY[0] - curFocusY[0]);
        const diffY1 = Math.abs(targetFocusY[1] - curFocusY[1]);
        if (diffY0 > EPSILON || diffY1 > EPSILON) {
          nextFocusY = [
            curFocusY[0] + (targetFocusY[0] - curFocusY[0]) * VIEW_LERP,
            curFocusY[1] + (targetFocusY[1] - curFocusY[1]) * VIEW_LERP
          ];
          focusNeedsMore = true;
        } else {
          nextFocusY = targetFocusY;
        }

        if (focusNeedsMore) {
          const isXFull = Math.abs(nextFocusX[0]) < EPSILON && Math.abs(nextFocusX[1] - 1) < EPSILON;
          const isYFull = Math.abs(nextFocusY[0]) < EPSILON && Math.abs(nextFocusY[1] - 1) < EPSILON;
          activeFocus = (isXFull && isYFull) ? undefined : {
            ...(isXFull ? {} : { x: nextFocusX }),
            ...(isYFull ? {} : { y: nextFocusY })
          };
          needsMoreFrames = true;
        } else {
          activeFocus = focus;
        }

        if (lastRenderedYDomain !== undefined && targetY !== undefined) {
          const currentData = cachedBaseAxes?.data ?? [];
          const baseXDomain = resolveLayoutXDomain(cachedBaseAxes?.axes);
          const currentTargetX = baseXDomain ? domainFromFocusRatio(baseXDomain, nextFocusX) : undefined;
          const currentTargetY = isAutoscale
            ? (resolveVisibleYDomainForFocus(spec, currentData, currentTargetX, activeFocus, currentDataFocusAxis) ?? targetY)
            : targetY;

          const next = lerpDomain(lastRenderedYDomain, currentTargetY, VIEW_LERP, EPSILON);
          activeY = next.domain;
          needsMoreFrames = needsMoreFrames || next.needsMoreFrames;
        }
      } else {
        // Base domain transition (streaming data or autoscale toggle)
        if (isStreamingActive(lastDataUpdateTime)) {
          // Allow X to lerp while streaming. This makes the domain smoothly follow appends,
          // creating a smooth "drawn in" effect instead of a rigid jittery jump.
          if (skipXFocusLerpOnce || skipLerpOnce) {
            activeX = targetX;
            skipXFocusLerpOnce = false;
          } else {
            const animatedDomains = resolveAnimatedDomains(targetX, undefined, SLOW_LERP, 1e-3);
            activeX = animatedDomains.x;
            needsMoreFrames = needsMoreFrames || animatedDomains.needsMoreFrames;
          }

          const currentData = cachedBaseAxes?.data ?? [];
          const currentTargetY = isAutoscale
            ? (resolveVisibleYDomainForFocus(spec, currentData, activeX, focus, currentDataFocusAxis) ?? targetY)
            : targetY;

          if (skipLerpOnce) {
            activeY = currentTargetY;
          } else if (lastRenderedYDomain !== undefined && currentTargetY !== undefined) {
            const lerpCoeff = seriesToggledRecently ? 0.25 : SLOW_LERP;
            const next = lerpDomain(lastRenderedYDomain, currentTargetY, lerpCoeff, 1e-3);
            activeY = next.domain;
            needsMoreFrames = needsMoreFrames || next.needsMoreFrames;
          } else {
            activeY = currentTargetY;
          }
        } else {
          if (lastRenderedXDomain !== undefined && targetX !== undefined) {
            const diff0 = Math.abs(targetX[0] - lastRenderedXDomain[0]);
            const diff1 = Math.abs(targetX[1] - lastRenderedXDomain[1]);
            const span = Math.max(1e-9, targetX[1] - targetX[0]);
            
            if (diff0 > EPSILON * span || diff1 > EPSILON * span) {
              activeX = [
                lastRenderedXDomain[0] + (targetX[0] - lastRenderedXDomain[0]) * FAST_LERP,
                lastRenderedXDomain[1] + (targetX[1] - lastRenderedXDomain[1]) * FAST_LERP
              ];
              needsMoreFrames = true;
            } else {
              activeX = targetX;
            }
          }

          if (lastRenderedYDomain !== undefined && targetY !== undefined) {
            const currentData = cachedBaseAxes?.data ?? [];
            const currentTargetY = isAutoscale
              ? (resolveVisibleYDomainForFocus(spec, currentData, activeX, focus, currentDataFocusAxis) ?? targetY)
              : targetY;

            const diff0 = Math.abs(currentTargetY[0] - lastRenderedYDomain[0]);
            const diff1 = Math.abs(currentTargetY[1] - lastRenderedYDomain[1]);
            const span = Math.max(1e-9, currentTargetY[1] - currentTargetY[0]);
            
            if (diff0 > EPSILON * span || diff1 > EPSILON * span) {
              activeY = [
                lastRenderedYDomain[0] + (currentTargetY[0] - lastRenderedYDomain[0]) * FAST_LERP,
                lastRenderedYDomain[1] + (currentTargetY[1] - lastRenderedYDomain[1]) * FAST_LERP
              ];
              needsMoreFrames = true;
            } else {
              activeY = currentTargetY;
            }
          }
        }
      }
    }

    finishFocusTransitionIfSettled(activeX, targetX, needsMoreFrames && !domainsEqual(activeX, targetX));

    if (
      ((isContinuousInteractionActive && !allowXImmediateSmoothing && !seriesToggledRecently) || !smoothedScalingEnabled)
    ) {
      clearDomainAnimation();
    }
    const isViewportAnimActive = smoothedScalingEnabled && !isContinuousInteractionActive && !isAnimOverride && !lockedViewport && !skipXFocusLerpOnce && isFocusDifferent(lastRenderedFocus, focus);

    const useTickFade = !axisAnimationActive && !suppressTickFadeUntilResizeSettles;
    if (useTickFade) {
      beginTickFadeEncode();
    }
    const lineFocusVisual = currentLineFocusTransition();
    const built = buildScene(
      spec,
      size,
      markAnimationProgress,
      axisAnimationRuntime,
      animationProfile,
      randomFillFade,
      activeFocus,
      encodedHover,
      () => cachedBaseAxes,
      (next) => {
        cachedBaseAxes = next;
      },
      {
        overrideXDomain: isViewportAnimActive ? undefined : (isAnimOverride ? overrideXDomain : activeX),
        overrideYDomain: isAnimOverride
          ? overrideYDomain
          : isViewportAnimActive && (focus?.y !== undefined || lastRenderedFocus?.y !== undefined)
            ? undefined
            : activeY,
        ...(lineFocusVisual ? { lineFocusTransition: lineFocusVisual } : {}),
        // Axis intro profiles own opacity/position; tick-fade would leave labels mid-grey.
        ...(useTickFade ? { axisTickFade: tickFadeState } : {})
      },
      currentDataFocusAxis
    );
    if (useTickFade) {
      finishTickFadeEncode();
    }
    currentAxes = built.axes;
    currentDataFocusAxis = built.dataFocusAxis ?? "x";
    
    // Store current rendered domains and focus
    if (!isAnimOverride) {
      lastRenderedFocus = activeFocus;
      lastRenderedXDomain = isViewportAnimActive ? resolveLayoutXDomain(built.axes) : activeX;
      lastRenderedYDomain = isViewportAnimActive ? resolveLayoutYDomain(built.axes) : activeY;
    } else {
      lastRenderedFocus = focus;
      lastRenderedXDomain = overrideXDomain;
      lastRenderedYDomain = overrideYDomain;
    }
    skipLerpOnce = false;
    skipXFocusLerpOnce = false;
    if (!needsMoreFrames) {
      lastDomainLerpTime = undefined;
    }

    if (!animating && !isAnimOverride && !needsMoreFrames) {
      renderCache = {
        contentKey,
        stableContentKey: buildStableContentKey(spec, focus),
        dataContentKey: buildDataContentKey(spec, size),
        size: built.size,
        plotArea: built.plotArea,
        axes: built.axes,
        ...(built.dataFocusAxis ? { dataFocusAxis: built.dataFocusAxis } : {}),
        ...(built.dataWindow ? { dataWindow: built.dataWindow } : {}),
        viewData: built.viewData,
        backgroundPrimitives: built.backgroundPrimitives,
        framePrimitives: built.framePrimitives,
        gridPrimitives: built.gridPrimitives,
        markPrimitives: built.markPrimitives,
        axisPrimitives: built.axisPrimitives,
        ...(built.clipArea ? { clipArea: built.clipArea } : {}),
        theme: spec.theme ?? defaultTheme,
        ...(extractBaseAxesFromBuilt(built))
      };
    }

    scene = sceneWithOverlayHover({
      ...built.scene,
      ...(dashboardResizePreviewEnabled(spec) ? { growOnlyCanvas: true } : {})
    }, built.dataWindow);
    lastHoverEncodeContext = {
      viewData: built.viewData,
      markLayout: built.markLayout,
      size: built.size,
      plotArea: built.plotArea,
      ...(built.dataFocusAxis ? { dataFocusAxis: built.dataFocusAxis } : {}),
      theme: spec.theme ?? defaultTheme
    };

    if (
      animating &&
      isScatterGpuAnimationProfile(animationProfile) &&
      built.markPrimitives.some((primitive) => primitive.kind === "point-cloud" && primitive.isRaw)
    ) {
      scatterAnimationCache = {
        contentKey,
        stableContentKey: buildStableContentKey(spec, focus),
        dataContentKey: buildDataContentKey(spec, size),
        size: built.size,
        plotArea: built.plotArea,
        axes: built.axes,
        ...(built.dataFocusAxis ? { dataFocusAxis: built.dataFocusAxis } : {}),
        ...(built.dataWindow ? { dataWindow: built.dataWindow } : {}),
        backgroundPrimitives: built.backgroundPrimitives,
        framePrimitives: built.framePrimitives,
        gridPrimitives: built.gridPrimitives,
        markPrimitives: built.markPrimitives,
        axisPrimitives: built.axisPrimitives,
        ...(built.clipArea ? { clipArea: built.clipArea } : {}),
        theme: spec.theme ?? defaultTheme,
        ...(extractBaseAxesFromBuilt(built))
      };
      scatterAnimationCacheKey = scatterAnimKey;
    } else if (!animating) {
      scatterAnimationCache = undefined;
      scatterAnimationCacheKey = undefined;
    }

    renderScene(scene);
    if (!options.skipOverlayRefresh) {
      if (!options.skipInteractionRefresh) {
        renderCurrentHoverOverlay();
      } else if (hover && hover.markType !== "scatter") {
        renderCurrentHoverOverlay();
      }
    }

    if (needsMoreFrames && !isAnimOverride) {
      if (isStreamingActive(lastDataUpdateTime) && !focusTransitionActive) {
        isViewportAnimating = false;
        scheduleDomainSettleAfterStreaming();
      } else if (canScheduleDomainAnimationNow()) {
        scheduleDomainAnimationFrame();
      } else {
        scheduleDomainSettleAfterStreaming();
      }
    } else if (
      domainAnimFrame === undefined &&
      !isContinuousInteractionActive &&
      !options.skipInteractionRefresh
    ) {
      lastDomainLerpTime = undefined;
      isViewportAnimating = false;
      focusTransitionActive = false;
      hoverController?.forceRefresh();
      tooltipController?.refresh();
      if (pendingSelection !== undefined) {
        const sel = pendingSelection;
        pendingSelection = undefined;
        applySelection(sel);
        return;
      }
    } else if (!needsMoreFrames) {
      focusTransitionActive = false;
    }
  }

  function clearRenderedHoverState(): void {
    if (scheduledRedrawFrame !== undefined) {
      cancelAnimationFrame(scheduledRedrawFrame);
      scheduledRedrawFrame = undefined;
    }

    const { hover: _sceneHover, ...sceneWithoutHover } = scene;
    scene = sceneWithoutHover;
    lastHoverEncodeContext = undefined;
    renderCache = undefined;
    scatterAnimationCache = undefined;
    scatterAnimationCacheKey = undefined;
    forceFullRedrawFlag = true;
    tooltipController?.hide();
    clearHoverOverlay();
    clearScatterHoverOverlay();
    redraw({ skipHover: true, skipInteractionRefresh: true });
  }

  function clearRenderedScatterHoverState(previousScatterIndex: number | undefined): void {
    const { hover: _sceneHover, ...sceneWithoutHover } = scene;
    scene = sceneWithoutHover;
    hover = undefined;
    lastHoverEncodeContext = undefined;
    tooltipController?.hide();
    clearHoverOverlay();

    if (previousScatterIndex === undefined && scatterHoverAnimations.size === 0) {
      clearScatterHoverOverlay();
    }
  }

  function buildScatterAnimationCacheKey(): string {
    const fadeKey = (animationProfile === "random-fill" || animationProfile === "random-fill-grow") && randomFillFade ? "|fade" : "";
    return `${buildStableContentKey(spec, focus)}|${animationProfile ?? "rise"}${fadeKey}|${size.width}x${size.height}`;
  }

  function redrawScatterAnimationFastPath(cache: RenderCache): void {
    const theme = spec.theme ?? defaultTheme;
    const profile = animationProfile ?? "rise";
    const patchedMarks = cache.markPrimitives.map((primitive) => (
      primitive.kind === "point-cloud" && primitive.isRaw
        ? patchScatterPointCloudAnimation(
          primitive,
          profile,
          markAnimationProgress,
          cache.plotArea,
          cache.clipArea,
          randomFillFade
        )
        : primitive
    ));

    let gridPrimitives = cache.gridPrimitives;
    let axisPrimitives = cache.axisPrimitives;

    const titleAnimationActive = markAnimationProgress < 1 && hasAnimatedTitleProfile(spec, currentAxes);
    if ((axisAnimationActive || titleAnimationActive) && currentAxes) {
      // Axis intro profiles own tick opacity/position. Mixing in the continuous
      // tick-fade leaves labels grey or shifted after the animation completes.
      const { gridPrimitives: nextGrid, axisPrimitives: baseAxis } = encodeGridAndAxesWithTickFade(
        currentAxes,
        cache.plotArea,
        theme,
        undefined,
        axisAnimationRuntime,
        !axisAnimationActive
      );
      gridPrimitives = nextGrid;
      axisPrimitives = [
        ...baseAxis,
        ...encodePlotLabels(spec, currentAxes, cache.size, cache.plotArea, theme, markAnimationProgress),
        ...encodeLiveYValueTickers(
          (cache.viewData ?? []) as readonly TDatum[],
          spec,
          cache.plotArea,
          theme,
          resolveLayoutXDomain(currentAxes),
          resolveLayoutYDomain(currentAxes)
        )
      ];
    }

    scene = sceneWithOverlayHover({
      size: cache.size,
      plotArea: cache.plotArea,
      ...(cache.dataFocusAxis ? { dataFocusAxis: cache.dataFocusAxis } : {}),
      primitives: [
        ...cache.backgroundPrimitives,
        ...cache.framePrimitives,
        ...gridPrimitives,
        ...patchedMarks,
        ...axisPrimitives
      ]
    }, cache.dataWindow);

    renderScene(scene);
    renderCurrentHoverOverlay();
    renderScatterHoverOverlay();
  }

  function encodeGridAndAxesWithTickFade(
    axes: AxesSpec | undefined,
    plotArea: Rect,
    theme: Theme,
    virtualPlotArea?: Rect,
    animation?: AxisAnimationState,
    useTickFade = true
  ): { gridPrimitives: readonly Primitive[]; axisPrimitives: readonly Primitive[] } {
    const shouldUseTickFade = useTickFade && !suppressTickFadeUntilResizeSettles;
    if (shouldUseTickFade) {
      beginTickFadeEncode();
    }
    const fade = shouldUseTickFade ? tickFadeState : undefined;
    const gridPrimitives = encodeGridlines(axes, plotArea, theme, animation, fade);
    const axisPrimitives = encodeAxes(axes, plotArea, theme, virtualPlotArea, animation, fade, shouldFadeStreamingAxisEdge(spec, focus));
    if (shouldUseTickFade) {
      finishTickFadeEncode();
    }
    return { gridPrimitives, axisPrimitives };
  }

  function beginTickFadeEncode(): void {
    tickFadeState.now = performance.now();
    tickFadeState.activeKeys.clear();
  }

  function resetTickFadeForAxisAnimation(): void {
    if (tickFadeFrame !== undefined) {
      cancelAnimationFrame(tickFadeFrame);
      tickFadeFrame = undefined;
    }
    tickFadeState.appearedAt.clear();
    tickFadeState.activeKeys.clear();
    // Next encode treats current ticks as already fully faded-in.
    tickFadeState.initialized = false;
  }

  function finishTickFadeEncode(): void {
    let fading = false;

    for (const [key, appearedAt] of tickFadeState.appearedAt) {
      if (!tickFadeState.activeKeys.has(key)) {
        tickFadeState.appearedAt.delete(key);
      } else if (tickFadeState.now - appearedAt < tickFadeState.durationMs) {
        fading = true;
      }
    }

    tickFadeState.initialized = true;
    // Resize owns the frame budget while it is active. Once it settles, the
    // settle pass resumes any remaining fade. Other interactions still keep an
    // independent fade driver so ticks cannot be stranded at a zoom limit.
    scheduleTickFadeFrame(resizeSettleTimer === undefined && fading);
  }

  function hasActiveTickFade(): boolean {
    if (!tickFadeState.initialized || tickFadeState.durationMs <= 0) {
      return false;
    }

    const now = performance.now();
    for (const [key, appearedAt] of tickFadeState.appearedAt) {
      if (
        tickFadeState.activeKeys.has(key) &&
        now - appearedAt < tickFadeState.durationMs
      ) {
        return true;
      }
    }
    return false;
  }

  function scheduleTickFadeFrame(fading: boolean): void {
    if (!fading) {
      if (tickFadeFrame !== undefined) {
        cancelAnimationFrame(tickFadeFrame);
        tickFadeFrame = undefined;
      }
      return;
    }

    if (tickFadeFrame !== undefined || domainAnimFrame !== undefined) {
      return;
    }

    tickFadeFrame = requestAnimationFrame(() => {
      tickFadeFrame = undefined;
      const isStreaming = (performance.now() - lastDataUpdateTime) < STREAMING_TICK_FADE_MS;
      if (isStreaming) {
        scheduleTickFadeFrame(true);
      } else {
        redrawAxisTickFadeFrame();
      }
    });
  }

  function redrawAxisTickFadeFrame(): void {
    if (!renderCache || !currentAxes) {
      redraw({ skipHover: true, skipInteractionRefresh: true });
      return;
    }

    const theme = spec.theme ?? defaultTheme;
    const { gridPrimitives, axisPrimitives: baseAxis } = encodeGridAndAxesWithTickFade(
      currentAxes,
      renderCache.plotArea,
      theme,
      undefined,
      axisAnimationActive ? axisAnimationRuntime : undefined,
      !axisAnimationActive
    );
    const axisPrimitives = [
      ...baseAxis,
      ...encodePlotLabels(spec, currentAxes, renderCache.size, renderCache.plotArea, theme, markAnimationProgress),
      ...encodeLiveYValueTickers(
        (renderCache.viewData ?? []) as readonly TDatum[],
        spec,
        renderCache.plotArea,
        theme,
        resolveLayoutXDomain(currentAxes),
        resolveLayoutYDomain(currentAxes)
      )
    ];

    renderCache = {
      ...renderCache,
      gridPrimitives,
      axisPrimitives
    };
    scene = sceneWithOverlayHover({
      size: renderCache.size,
      plotArea: renderCache.plotArea,
      ...(renderCache.dataFocusAxis ? { dataFocusAxis: renderCache.dataFocusAxis } : {}),
      primitives: [
        ...renderCache.backgroundPrimitives,
        ...renderCache.framePrimitives,
        ...renderCache.gridPrimitives,
        ...renderCache.markPrimitives,
        ...axisPrimitives
      ],
      ...(
        resizeSettleTimer !== undefined ||
        isContinuousInteractionActive ||
        canSkipFocusSettleFullRedraw(renderCache)
          ? { deferPointCloudDraw: true }
          : {}
      )
    }, renderCache.dataWindow);

    renderScene(scene);
  }

  function resolveAnimatedDomains(
    targetX: readonly [number, number] | undefined,
    targetY: readonly [number, number] | undefined,
    fallbackAmount: number,
    epsilon = 1e-4
  ): { x: readonly [number, number] | undefined; y: readonly [number, number] | undefined; needsMoreFrames: boolean } {
    const prefersReducedMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Series toggles must lerp even if a pan/zoom interaction flag is still set.
    const blockForInteraction = isContinuousInteractionActive && !wasSeriesToggledRecently();
    if (
      prefersReducedMotion ||
      !smoothedScalingEnabled ||
      blockForInteraction ||
      skipLerpOnce ||
      targetX === undefined && targetY === undefined
    ) {
      return { x: targetX, y: targetY, needsMoreFrames: false };
    }

    const now = performance.now();
    const elapsedMs = lastDomainLerpTime === undefined ? 16.67 : Math.max(0, Math.min(64, now - lastDomainLerpTime));
    lastDomainLerpTime = now;

    // Frame-rate independent exponential smoothing keeps work constant per
    // frame and avoids long tails on lower refresh-rate displays.
    const amount = Math.max(fallbackAmount, 1 - Math.exp(-elapsedMs / 90));
    let activeX = targetX;
    let activeY = targetY;
    let needsMoreFrames = false;

    if (lastRenderedXDomain !== undefined && targetX !== undefined) {
      const next = lerpDomain(lastRenderedXDomain, targetX, amount, epsilon);
      activeX = next.domain;
      needsMoreFrames = needsMoreFrames || next.needsMoreFrames;
    }

    if (lastRenderedYDomain !== undefined && targetY !== undefined) {
      const next = lerpDomain(lastRenderedYDomain, targetY, amount, epsilon);
      activeY = next.domain;
      needsMoreFrames = needsMoreFrames || next.needsMoreFrames;
    }

    return { x: activeX, y: activeY, needsMoreFrames };
  }

  function canScheduleDomainAnimationNow(): boolean {
    return true;
  }

  function scheduleDomainSettleAfterStreaming(): void {
    if (streamingDomainSettleTimer !== undefined) {
      return;
    }

    streamingDomainSettleTimer = setTimeout(() => {
      streamingDomainSettleTimer = undefined;
      if (isStreamingActive(lastDataUpdateTime)) {
        scheduleDomainSettleAfterStreaming();
        return;
      }
      scheduleDomainAnimationFrame();
    }, STREAMING_DOMAIN_SETTLE_MS);
  }

  function scheduleDomainAnimationFrame(): void {
    if (!smoothedScalingEnabled) {
      clearDomainAnimation();
      return;
    }

    isViewportAnimating = true;
    if (domainAnimFrame !== undefined) {
      return;
    }

    const generation = domainAnimGeneration;
    domainAnimFrame = requestAnimationFrame(() => {
      if (generation !== domainAnimGeneration) {
        return;
      }
      domainAnimFrame = undefined;
      if (renderCache) {
        const contentKey = buildContentKey(spec, size, focus, undefined);
        if (
          !lockedViewport &&
          isStreamingActive(lastDataUpdateTime) &&
          canUseStreamingFastPath(renderCache)
        ) {
          redrawStreamingFastPath(renderCache, contentKey);
        } else if (canUseLineStreamingFastPath(renderCache, spec)) {
          redrawLineStreamingFastPath(renderCache, contentKey);
        } else if (canUseFocusFastPath(renderCache, spec, size)) {
          redrawFocusFastPath(renderCache, contentKey);
        } else {
          forceFullRedrawFlag = true;
          redraw({ skipInteractionRefresh: true });
        }
      } else {
        redraw({ skipInteractionRefresh: true });
      }
      // Refresh hover overlays so they track the viewport during interpolation
      hoverController?.forceRefresh();
      renderScatterHoverOverlay();
      tooltipController?.refresh();
    });
  }

  function redrawLineStreamingFastPath(cache: RenderCache, contentKey: string): void {
    const theme = spec.theme ?? defaultTheme;
    const renderDistance = resolveRenderOptimization(spec.optimization);
    const panSmoothEnabled = spec.interactions !== false &&
      spec.interactions?.pan !== false &&
      (typeof spec.interactions?.pan !== "object" || spec.interactions?.pan?.smooth !== false);

    let baseAxes = cache.baseAxes;
    if (baseAxes) {
      const patched = patchCachedBaseAxesFromSource(
        spec.data,
        {
          data: (cache.viewData ?? []) as readonly TDatum[],
          axes: baseAxes
        },
        (next) => {
          cachedBaseAxes = next;
        },
        hasHiddenSeries(spec)
      );

      if (patched) {
        baseAxes = patched.axes;
        cachedBaseAxes = patched;
      }
    }

    const dataRequest: DataSourceResolveRequest = {
      plotArea: cache.plotArea,
      renderDistance,
      snapToIndices: !panSmoothEnabled,
      includeContinuityPoints: true,
      ...(currentDataFocusAxis ? { dataFocusAxis: currentDataFocusAxis } : {}),
      ...(lockedViewport?.x ? { xDomain: lockedViewport.x } : {}),
      ...(lockedViewport?.y ? { yDomain: lockedViewport.y } : {}),
      ...(focus ? { focus } : {})
    };

    let resolvedData = resolveDataInput(spec.data, dataRequest);
    let transformed = (spec.transforms ?? []).reduce<readonly TDatum[]>(
      (data, transform) => transform.apply(data),
      resolvedData.data
    );

    const baseXDomain = baseAxes?.x?.kind === "linear"
      ? baseAxes.x.domain
      : cache.baseXDomain;
    const baseYDomain = baseAxes?.y?.kind === "linear"
      ? baseAxes.y.domain
      : cache.baseYDomain;

    const targetFocusedXDomain = lockedViewport?.x
      ?? (baseXDomain ? resolveFastPathDomain(baseXDomain, focus?.x) : resolvedData.domain?.visibleX);
    let targetFocusedYDomain = lockedViewport?.y
      ?? baseYDomain
      ?? undefined;

    const seriesToggledRecently = wasSeriesToggledRecently();
    const streamingActive = isStreamingActive(lastDataUpdateTime);
    // Allow X to lerp while streaming. This makes the domain smoothly follow appends,
    // which effectively clips the leading edge and reveals it over time, creating a 
    // smooth "drawn in" effect instead of a rigid jittery jump.
    const snapX = skipLerpOnce || skipXFocusLerpOnce;
    const snapY = skipLerpOnce;
    const fastPathLerp = seriesToggledRecently ? 0.25 : 0.18;

    let focusedXDomain = targetFocusedXDomain;
    let xNeedsMoreFrames = false;
    if (snapX) {
      skipXFocusLerpOnce = false;
    } else {
      const animatedDomains = resolveAnimatedDomains(targetFocusedXDomain, undefined, fastPathLerp, 1e-3);
      focusedXDomain = animatedDomains.x;
      xNeedsMoreFrames = animatedDomains.needsMoreFrames;
    }

    targetFocusedYDomain = resolveViewportYDomain(
      transformed,
      focusedXDomain,
      targetFocusedYDomain
    );

    let focusedYDomain = targetFocusedYDomain;
    let yNeedsMoreFrames = false;
    if (snapY) {
      skipLerpOnce = false;
    } else {
      const animatedY = resolveAnimatedDomains(undefined, targetFocusedYDomain, fastPathLerp, 1e-3);
      focusedYDomain = animatedY.y;
      yNeedsMoreFrames = animatedY.needsMoreFrames;
    }
    const sourceXDomain = resolvedData.domain?.visibleX;

    if (
      focusedXDomain &&
      sourceXDomain &&
      targetFocusedXDomain &&
      !domainContains(sourceXDomain, focusedXDomain)
    ) {
      const transitionXDomain = unionDomains(focusedXDomain, targetFocusedXDomain);
      resolvedData = resolveDataInput(spec.data, {
        ...dataRequest,
        xDomain: transitionXDomain
      });
      transformed = (spec.transforms ?? []).reduce<readonly TDatum[]>(
        (data, transform) => transform.apply(data),
        resolvedData.data
      );
    }

    const patchedAxes = patchLinearAxesDomains(
      applyDataSourceAxisDomain(baseAxes, resolvedData.domain),
      focusedXDomain,
      focusedYDomain
    );
    const focusedLayout = computeLayout(size, theme, patchedAxes, spec.plotPadding, spec.title, spec.hiddenSeries);
    const xDomain = focusedXDomain ?? resolveLayoutXDomain(patchedAxes);
    const yDomain = focusedYDomain ?? resolveLayoutYDomain(patchedAxes);
    const lineFocusVisual = currentLineFocusTransition();
    const markLayout = {
      ...focusedLayout,
      ...(lineFocusVisual ? { lineFocusTransition: lineFocusVisual } : {}),
      animation: {
        progress: markAnimationProgress,
        profile: animationProfile ?? "rise",
        ...((animationProfile === "random-fill" || animationProfile === "random-fill-grow") && randomFillFade ? { randomFillFade: true as const } : {})
      },
      ...(xDomain ? { xDomain } : {}),
      ...(yDomain ? { yDomain } : {}),
      renderDistance,
      ...(resolvedData.domain ? {
        dataWindow: {
          startIndex: resolvedData.domain.startIndex,
          endIndex: resolvedData.domain.endIndex,
          visibleStart: resolvedData.domain.visibleStart,
          visibleEnd: resolvedData.domain.visibleEnd,
          ...(focusedXDomain ? { visibleX: focusedXDomain } : resolvedData.domain.visibleX !== undefined ? { visibleX: resolvedData.domain.visibleX } : {}),
          totalLength: resolvedData.domain.totalLength
        }
      } : {})
    };
    const markPrimitives = spec.marks.flatMap((mark) => mark.encode(transformed, markLayout, theme));

    lastRenderedXDomain = focusedXDomain;
    lastRenderedYDomain = focusedYDomain;
    lastRenderedFocus = focus;
    finishFocusTransitionIfSettled(focusedXDomain, targetFocusedXDomain, xNeedsMoreFrames);
    const needsMoreFrames = xNeedsMoreFrames || yNeedsMoreFrames;
    if (needsMoreFrames) {
      // Sliding-window pins already redraw every append — don't add a second rAF.
      // User window switches still get domain frames so X can interpolate.
      if (streamingActive && !focusTransitionActive) {
        isViewportAnimating = false;
        scheduleDomainSettleAfterStreaming();
      } else if (canScheduleDomainAnimationNow()) {
        scheduleDomainAnimationFrame();
      } else {
        scheduleDomainSettleAfterStreaming();
      }
    } else {
      lastDomainLerpTime = undefined;
      isViewportAnimating = false;
      focusTransitionActive = false;
      if (pendingSelection !== undefined) {
        const sel = pendingSelection;
        pendingSelection = undefined;
        applySelection(sel);
        return;
      }
    }

    renderFastPathScene(
      cache,
      contentKey,
      focusedXDomain,
      focusedYDomain,
      markPrimitives,
      baseXDomain,
      baseYDomain,
      transformed,
      markLayout.dataWindow,
      patchedAxes
    );
  }

  function canUseStreamingFastPath(cache: RenderCache): boolean {
    if (!cache.baseAxes) {
      return false;
    }
    return cache.markPrimitives.some(
      (p) => p.kind === "point-cloud" && p.isRaw
    );
  }

  function renderFastPathScene(
    cache: RenderCache,
    contentKey: string,
    focusedXDomain: readonly [number, number] | undefined,
    focusedYDomain: readonly [number, number] | undefined,
    updatedMarks: readonly Primitive[],
    targetX?: readonly [number, number],
    targetY?: readonly [number, number],
    viewData?: readonly TDatum[],
    dataWindow?: Layout["dataWindow"],
    baseAxesOverride?: AxesSpec
  ): void {
    const theme = spec.theme ?? defaultTheme;
    const baseAxes = baseAxesOverride ?? cache.baseAxes;
    const focusedAxes = patchLinearAxesDomains(
      baseAxes,
      focusedXDomain,
      focusedYDomain
    );
    const focusedLayout = computeLayout(size, theme, focusedAxes, spec.plotPadding, spec.title, spec.hiddenSeries);
    const finalMarks = focusedLayout.plotArea.x !== cache.plotArea.x ||
      focusedLayout.plotArea.y !== cache.plotArea.y ||
      focusedLayout.plotArea.width !== cache.plotArea.width ||
      focusedLayout.plotArea.height !== cache.plotArea.height
      ? patchPointCloudPlotArea(updatedMarks, focusedLayout.plotArea)
      : updatedMarks;

    // Keep tick continuity for raw point-cloud focus transitions too. Follow-up
    // fade frames set deferPointCloudDraw, so only the 2D axes are repainted.
    const { gridPrimitives, axisPrimitives: baseAxis } = encodeGridAndAxesWithTickFade(
      focusedAxes,
      focusedLayout.plotArea,
      theme,
      undefined,
      undefined,
      !axisAnimationActive
    );
    const axisPrimitives = [
      ...baseAxis,
      ...encodeLiveYValueTickers(
        (viewData ?? cache.viewData ?? []) as readonly TDatum[],
        spec,
        focusedLayout.plotArea,
        theme,
        focusedXDomain ?? resolveLayoutXDomain(focusedAxes),
        focusedYDomain ?? resolveLayoutYDomain(focusedAxes)
      )
    ];
    const framePrimitives = spec.frame === false
      ? []
      : encodeFrame(size, focusedLayout.plotArea, theme, spec.frame);
    const backgroundPrimitives = encodeChartBackground(size, focusedLayout.plotArea, theme);

    currentAxes = focusedAxes;

    const hoverForScene = resizeSettleTimer === undefined ? markEncodeHover() : undefined;
    scene = sceneWithOverlayHover({
      size,
      plotArea: focusedLayout.plotArea,
      ...(cache.dataFocusAxis ? { dataFocusAxis: cache.dataFocusAxis } : {}),
      ...(hoverForScene ? { hover: hoverForScene } : {}),
      primitives: [
        ...backgroundPrimitives,
        ...framePrimitives,
        ...gridPrimitives,
        ...finalMarks,
        ...axisPrimitives
      ],
      ...(dashboardResizePreviewEnabled(spec) ? { growOnlyCanvas: true } : {})
    });

    const nextRenderCache: RenderCache = {
      ...cache,
      contentKey,
      stableContentKey: buildStableContentKey(spec, focus),
      dataContentKey: buildDataContentKey(spec, size),
      size,
      plotArea: focusedLayout.plotArea,
      axes: focusedAxes,
      ...(viewData ? { viewData } : {}),
      ...(dataWindow ? { dataWindow } : {}),
      backgroundPrimitives,
      markPrimitives: finalMarks,
      gridPrimitives,
      axisPrimitives,
      framePrimitives,
      ...(baseAxesOverride ? { baseAxes: baseAxesOverride } : {})
    };
    if (targetX !== undefined) {
      nextRenderCache.baseXDomain = targetX;
    }
    if (targetY !== undefined) {
      nextRenderCache.baseYDomain = targetY;
    }
    renderCache = nextRenderCache;

    renderScene(scene);
    lastHoverEncodeContext = viewData ? {
      viewData,
      markLayout: {
        size,
        plotArea: focusedLayout.plotArea,
        animation: {
          progress: markAnimationProgress,
          profile: animationProfile ?? "rise",
          ...((animationProfile === "random-fill" || animationProfile === "random-fill-grow") && randomFillFade ? { randomFillFade: true as const } : {})
        },
        ...(focusedXDomain ? { xDomain: focusedXDomain } : {}),
        ...(focusedYDomain ? { yDomain: focusedYDomain } : {}),
        ...(dataWindow ? { dataWindow } : {}),
        renderDistance: resolveRenderOptimization(spec.optimization),
        ...(spec.hiddenSeries ? { hiddenSeries: spec.hiddenSeries } : {})
      },
      size,
      plotArea: focusedLayout.plotArea,
      ...(cache.dataFocusAxis ? { dataFocusAxis: cache.dataFocusAxis } : {}),
      theme
    } : undefined;
    if (resizeSettleTimer === undefined) {
      renderCurrentHoverOverlay();
    }
  }

  function redrawStreamingFastPath(cache: RenderCache, contentKey: string): void {
    const renderDistance = resolveRenderOptimization(spec.optimization);
    const panSmoothEnabled = spec.interactions !== false &&
      spec.interactions?.pan !== false &&
      (typeof spec.interactions?.pan !== "object" || spec.interactions?.pan?.smooth !== false);
    const dataRequest: DataSourceResolveRequest = {
      plotArea: cache.plotArea,
      renderDistance: {
        ...renderDistance,
        enabled: false
      },
      snapToIndices: !panSmoothEnabled,
      includeContinuityPoints: true,
      ...(currentDataFocusAxis ? { dataFocusAxis: currentDataFocusAxis } : {})
    };
    const resolvedData = resolveDataInput(spec.data, dataRequest);
    const data = resolvedData.data;
    const metadata = scatterViewMetadata(data);

    const cacheKey = metadata.__rawPointsKey ?? metadata.__rawPoints ?? data;
    const rawCache = rawPointsCache.get(cacheKey);
    const hasRaw = metadata.__rawPoints instanceof Float32Array;
    const rawPoints = hasRaw ? metadata.__rawPoints! : undefined;
    const rawPointCount = hasRaw
      ? getPointCount(rawPoints!) ?? rawPoints!.length / 2
      : data.length;

    if (rawCache && rawPoints) {
      // Update points reference on the cache in case of reallocation
      rawCache.points = rawPoints;
      const categoryIds = metadata.__categoryIds instanceof Float32Array
        ? metadata.__categoryIds
        : undefined;
      rawCache.categoryIds = categoryIds;
      rawCache.categoryCount = categoryIds ? getPointArrayCategoryCount(categoryIds) : 0;
      if (rawCache.pointCount !== rawPointCount) {
        appendRawCache(rawCache, rawCache.points, rawCache.pointCount, rawPointCount, categoryIds);
      }
    }

    let targetX: readonly [number, number] | undefined;
    let targetY: readonly [number, number] | undefined;

    const specAxes = typeof spec.axes === "object" ? spec.axes : undefined;

    if (specAxes?.x?.kind === "linear" && specAxes.x.domain) {
      targetX = specAxes.x.domain;
    } else if (rawCache) {
      targetX = rawCache.fullXDomain;
    } else if (resolvedData.domain?.x) {
      targetX = resolvedData.domain.x;
    } else if (resolvedData.domain?.visibleX) {
      targetX = resolvedData.domain.visibleX;
    } else {
      targetX = cache.baseXDomain;
    }

    if (specAxes?.y?.kind === "linear" && specAxes.y.domain) {
      targetY = specAxes.y.domain;
    } else if (rawCache) {
      targetY = rawCache.fullYDomain;
    } else {
      targetY = cache.baseYDomain;
    }

    const targetFocusedXDomain = lockedViewport?.x
      ?? (targetX ? resolveFastPathDomain(targetX, focus?.x) : undefined);
    const targetFocusedYDomain = lockedViewport?.y
      ?? (targetY ? resolveFastPathDomain(targetY, focus?.y) : undefined);
    const animatedDomains = resolveAnimatedDomains(targetFocusedXDomain, targetFocusedYDomain, 0.18, 1e-3);
    const focusedXDomain = animatedDomains.x;
    const focusedYDomain = animatedDomains.y;

    lastRenderedXDomain = focusedXDomain;
    lastRenderedYDomain = focusedYDomain;
    lastRenderedFocus = focus;
    if (animatedDomains.needsMoreFrames && canScheduleDomainAnimationNow()) {
      scheduleDomainAnimationFrame();
    } else if (animatedDomains.needsMoreFrames) {
      scheduleDomainSettleAfterStreaming();
    } else {
      lastDomainLerpTime = undefined;
      isViewportAnimating = false;
      if (pendingSelection !== undefined) {
        const sel = pendingSelection;
        pendingSelection = undefined;
        applySelection(sel);
        return;
      }
    }

    const updatedMarks = patchPointCloudDomains(
      cache.markPrimitives,
      focusedXDomain,
      focusedYDomain,
      rawPointCount,
      targetX,
      targetY,
      rawPoints,
      hasRaw
        ? (metadata.__categoryIds instanceof Float32Array ? metadata.__categoryIds : null)
        : undefined,
      hasRaw
        ? (metadata.__categoryIds ? getPointArrayCategoryCount(metadata.__categoryIds) : 0)
        : undefined
    );

    renderFastPathScene(
      cache,
      contentKey,
      focusedXDomain,
      focusedYDomain,
      updatedMarks,
      targetX,
      targetY,
      data,
      resolvedData.domain ? {
        startIndex: resolvedData.domain.startIndex,
        endIndex: resolvedData.domain.endIndex,
        visibleStart: resolvedData.domain.visibleStart,
        visibleEnd: resolvedData.domain.visibleEnd,
        ...(focusedXDomain ? { visibleX: focusedXDomain } : resolvedData.domain.visibleX ? { visibleX: resolvedData.domain.visibleX } : {}),
        totalLength: resolvedData.domain.totalLength
      } : undefined
    );
  }

  function redrawFocusFastPath(cache: RenderCache, contentKey: string): void {
    const targetFocusedXDomain = lockedViewport?.x
      ?? (cache.baseXDomain ? resolveFastPathDomain(cache.baseXDomain, focus?.x) : undefined);
    const targetFocusedYDomain = resolveViewportYDomain(
      (cache.viewData ?? []) as readonly TDatum[],
      targetFocusedXDomain,
      lockedViewport?.y
        ?? (cache.baseYDomain ? resolveFastPathDomain(cache.baseYDomain, focus?.y) : undefined),
      { respectFocusY: true }
    );
    const streaming = isStreamingActive(lastDataUpdateTime);
    const animatedDomains = resolveAnimatedDomains(
      targetFocusedXDomain,
      targetFocusedYDomain,
      streaming ? 0.18 : 0.12,
      streaming ? 1e-3 : 1e-4
    );
    const focusedXDomain = animatedDomains.x;
    const focusedYDomain = animatedDomains.y;

    lastRenderedXDomain = focusedXDomain;
    lastRenderedYDomain = focusedYDomain;
    if (animatedDomains.needsMoreFrames && canScheduleDomainAnimationNow()) {
      scheduleDomainAnimationFrame();
    } else if (animatedDomains.needsMoreFrames) {
      scheduleDomainSettleAfterStreaming();
    } else {
      lastDomainLerpTime = undefined;
      lastRenderedFocus = focus;
      isViewportAnimating = false;
      hoverController?.forceRefresh();
      tooltipController?.refresh();
      if (pendingSelection !== undefined) {
        const sel = pendingSelection;
        pendingSelection = undefined;
        applySelection(sel);
        return;
      } else if (!canSkipFocusSettleFullRedraw(cache)) {
        // Mixed-mark scenes may need a full encode once the viewport lands.
        // Raw point-cloud-only scenes are already correct after domain patching,
        // and rebuilding them here can steal an animation frame on large data.
        skipLerpOnce = true;
        forceFullRedrawFlag = true;
        scheduleRedraw();
      }
    }

    const updatedMarks = patchPointCloudDomains(
      cache.markPrimitives,
      focusedXDomain,
      focusedYDomain
    );

    renderFastPathScene(
      cache,
      contentKey,
      focusedXDomain,
      focusedYDomain,
      updatedMarks,
      cache.baseXDomain,
      cache.baseYDomain,
      cache.viewData as readonly TDatum[] | undefined,
      cache.dataWindow
    );
  }

  function redrawFocusPreviewFastPath(): boolean {
    if (
      markAnimationProgress < 1 ||
      axisAnimationActive ||
      !renderCache ||
      forceFullRedrawFlag ||
      !canUseFocusFastPath(renderCache, spec, size)
    ) {
      return false;
    }

    const focusedXDomain = lockedViewport?.x
      ?? (renderCache.baseXDomain ? resolveFastPathDomain(renderCache.baseXDomain, focus?.x) : undefined);
    const focusedYDomain = resolveViewportYDomain(
      (renderCache.viewData ?? []) as readonly TDatum[],
      focusedXDomain,
      lockedViewport?.y
        ?? (renderCache.baseYDomain ? resolveFastPathDomain(renderCache.baseYDomain, focus?.y) : undefined),
      { respectFocusY: true }
    );
    const focusedAxes = patchLinearAxesDomains(
      renderCache.baseAxes,
      focusedXDomain,
      focusedYDomain
    );
    const focusedLayout = computeLayout(size, spec.theme ?? defaultTheme, focusedAxes, spec.plotPadding, spec.title, spec.hiddenSeries);
    const updatedMarks = patchPointCloudDomains(
      renderCache.markPrimitives,
      focusedXDomain,
      focusedYDomain
    );
    const finalMarks = focusedLayout.plotArea.x !== renderCache.plotArea.x ||
      focusedLayout.plotArea.y !== renderCache.plotArea.y ||
      focusedLayout.plotArea.width !== renderCache.plotArea.width ||
      focusedLayout.plotArea.height !== renderCache.plotArea.height
      ? patchPointCloudPlotArea(updatedMarks, focusedLayout.plotArea)
      : updatedMarks;
    const theme = spec.theme ?? defaultTheme;
    const framePrimitives = spec.frame === false
      ? []
      : encodeFrame(size, focusedLayout.plotArea, theme, spec.frame);
    const { gridPrimitives, axisPrimitives: baseAxis } = encodeGridAndAxesWithTickFade(
      focusedAxes,
      focusedLayout.plotArea,
      theme
    );
    const axisPrimitives = [
      ...baseAxis,
      ...encodeLiveYValueTickers(
        (renderCache.viewData ?? []) as readonly TDatum[],
        spec,
        focusedLayout.plotArea,
        theme,
        focusedXDomain ?? resolveLayoutXDomain(focusedAxes),
        focusedYDomain ?? resolveLayoutYDomain(focusedAxes)
      )
    ];
    const backgroundPrimitives = encodeChartBackground(size, focusedLayout.plotArea, theme);

    currentAxes = focusedAxes;
    lastRenderedXDomain = focusedXDomain;
    lastRenderedYDomain = focusedYDomain;
    lastRenderedFocus = focus;
    lastDomainLerpTime = undefined;

    scene = sceneWithOverlayHover({
      size,
      plotArea: focusedLayout.plotArea,
      ...(renderCache.dataFocusAxis ? { dataFocusAxis: renderCache.dataFocusAxis } : {}),
      primitives: [
        ...backgroundPrimitives,
        ...framePrimitives,
        ...gridPrimitives,
        ...finalMarks,
        ...axisPrimitives
      ]
    }, renderCache.dataWindow);

    const nextRenderCache: RenderCache = {
      ...renderCache,
      contentKey: buildContentKey(spec, size, focus, undefined),
      stableContentKey: buildStableContentKey(spec, focus),
      plotArea: focusedLayout.plotArea,
      axes: focusedAxes,
      backgroundPrimitives,
      markPrimitives: finalMarks,
      gridPrimitives,
      axisPrimitives,
      framePrimitives
    };
    renderCache = nextRenderCache;

    renderScene(scene);
    lastHoverEncodeContext = undefined;
    return true;
  }

  function invalidateScatterHoverForViewChange(): void {
    if (hover?.markType !== "scatter") {
      return;
    }

    if (scatterHoverAnimFrame !== undefined) {
      cancelAnimationFrame(scatterHoverAnimFrame);
      scatterHoverAnimFrame = undefined;
    }

    scatterHoverAnimations.clear();
    hover = undefined;

    const { hover: _sceneHover, ...sceneWithoutHover } = scene;
    scene = sceneWithoutHover;

    clearScatterHoverOverlay();
  }

  function invalidateHoverForViewChange(options: { clearLineHover?: boolean } = {}): void {
    if (!hover) {
      return;
    }

    if (hover.markType === "line" && !options.clearLineHover) {
      return;
    }

    if (hover.markType === "scatter") {
      invalidateScatterHoverForViewChange();
      return;
    }

    const previousHover = hover;
    hover = undefined;
    transitionLineFocusVisual(previousHover, undefined);
    tooltipController?.hide();
    clearHoverOverlay();
  }

  function clearScatterHoverOverlay(): void {
    const renderScatterHover = renderer.renderScatterHover ?? renderer.renderOverlay;

    if (!renderScatterHover) {
      return;
    }

    renderScatterHover(surface, {
      size: scene.size,
      plotArea: scene.plotArea,
      primitives: []
    });
  }

  function clearHoverOverlay(): void {
    if (!renderer.renderOverlay) {
      return;
    }

    renderer.renderOverlay(surface, emptyOverlayScene());
  }

  function renderCurrentHoverOverlay(): void {
    if (!overlayHover || !renderer.renderOverlay) {
      return;
    }

    if (!hover || hover.markType === "scatter") {
      clearHoverOverlay();
      return;
    }

    renderer.renderOverlay(surface, buildHoverOverlayScene(hover));
  }

  function markEncodeHover(): HoverState | undefined {
    return (overlayHover && !lineFocusEnabled()) ? undefined : hover;
  }

  function lineFocusEnabled(): boolean {
    return spec.presetOptions?.lineFocus === true ||
      spec.marks.some((mark) => mark.kind === "line" && (mark as any).lineFocus === true);
  }

  function lineFocusSeriesIndex(value: HoverState | undefined): number | undefined {
    return value?.markType === "line" ? value.seriesIndex : undefined;
  }

  function lineFocusSeriesAtPoint(x: number, y: number): number | undefined {
    for (let index = scene.primitives.length - 1; index >= 0; index -= 1) {
      const primitive = scene.primitives[index];
      if (primitive?.kind !== "rect" || !primitive.lineFocusHitTest) {
        continue;
      }
      const hit = primitive.lineFocusHitTest(x, y);
      if (hit) {
        return hit.seriesIndex;
      }
    }
    return undefined;
  }

  function beginLinePinGesture(event: PointerEvent): void {
    cancelLinePinGesture();
    if (
      !(container instanceof HTMLElement) ||
      event.button !== 0 ||
      !event.isPrimary ||
      !lineFocusEnabled() ||
      isPlotUiChrome(event.target)
    ) {
      return;
    }

    const bounds = container.getBoundingClientRect();
    const seriesIndex = lineFocusSeriesAtPoint(
      event.clientX - bounds.left,
      event.clientY - bounds.top
    );
    linePinGesture = {
      x: event.clientX,
      y: event.clientY,
      ...(seriesIndex !== undefined ? { seriesIndex } : {})
    };

    const heldSeriesIndex = pinnedLineSeriesIndex ?? seriesIndex;
    if (heldSeriesIndex !== undefined) {
      settleLineFocusVisual(heldSeriesIndex);
    }
  }

  function finishLinePinGesture(event: MouseEvent): void {
    if (
      !(container instanceof HTMLElement) ||
      event.button !== 0 ||
      !lineFocusEnabled() ||
      isPlotUiChrome(event.target)
    ) {
      cancelLinePinGesture();
      return;
    }

    const gesture = linePinGesture;
    if (
      !gesture ||
      Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) >= 8
    ) {
      cancelLinePinGesture();
      return;
    }
    linePinGesture = undefined;

    const bounds = container.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    const plotArea = scene.plotArea;
    if (
      x < plotArea.x ||
      x > plotArea.x + plotArea.width ||
      y < plotArea.y ||
      y > plotArea.y + plotArea.height
    ) {
      restoreLineFocusAfterCancelledGesture(gesture.seriesIndex);
      return;
    }

    if (gesture.seriesIndex !== undefined) {
      setPinnedLineFocus(gesture.seriesIndex);
    } else if (pinnedLineSeriesIndex !== undefined) {
      setPinnedLineFocus(undefined);
    } else {
      restoreLineFocusAfterCancelledGesture(gesture.seriesIndex);
    }
  }

  function cancelLinePinGesture(): void {
    const heldSeriesIndex = linePinGesture?.seriesIndex;
    linePinGesture = undefined;
    restoreLineFocusAfterCancelledGesture(heldSeriesIndex);
  }

  function restoreLineFocusAfterCancelledGesture(heldSeriesIndex: number | undefined): void {
    if (pinnedLineSeriesIndex !== undefined) {
      settleLineFocusVisual(pinnedLineSeriesIndex);
      return;
    }
    if (heldSeriesIndex === undefined) {
      return;
    }
    transitionLineFocusVisual(
      { markType: "line", index: -1, seriesIndex: heldSeriesIndex },
      hover
    );
  }

  function transitionLineFocusVisual(
    previous: HoverState | undefined,
    next: HoverState | undefined
  ): void {
    if (!lineFocusEnabled()) {
      resetLineFocusVisual();
      return;
    }

    const lockedSeriesIndex = pinnedLineSeriesIndex ?? linePinGesture?.seriesIndex;
    const previousSeriesIndex = lockedSeriesIndex ?? lineFocusSeriesIndex(previous);
    const nextSeriesIndex = lockedSeriesIndex ?? lineFocusSeriesIndex(next);
    if (previousSeriesIndex === nextSeriesIndex) {
      return;
    }

    if (prefersReducedMotion || LINE_FOCUS_TRANSITION_MS <= 0) {
      lineFocusDimProgress = nextSeriesIndex === undefined ? 0 : 1;
      lineFocusEmphasisBySeries = nextSeriesIndex === undefined
        ? new Map()
        : new Map([[nextSeriesIndex, 1]]);
      lineFocusTransition = undefined;
      if (lineFocusTransitionFrame !== undefined) {
        cancelAnimationFrame(lineFocusTransitionFrame);
        lineFocusTransitionFrame = undefined;
      }
      return;
    }

    lineFocusTransition = {
      startedAt: performance.now(),
      startDimProgress: lineFocusDimProgress,
      targetDimProgress: nextSeriesIndex === undefined ? 0 : 1,
      startEmphasisBySeries: new Map(lineFocusEmphasisBySeries),
      ...(nextSeriesIndex !== undefined ? { targetSeriesIndex: nextSeriesIndex } : {})
    };

    if (lineFocusTransitionFrame === undefined) {
      lineFocusTransitionFrame = requestAnimationFrame(tickLineFocusTransition);
    }
  }

  function settleLineFocusVisual(seriesIndex: number): void {
    if (lineFocusTransitionFrame !== undefined) {
      cancelAnimationFrame(lineFocusTransitionFrame);
      lineFocusTransitionFrame = undefined;
    }

    lineFocusTransition = undefined;
    lineFocusDimProgress = 1;
    lineFocusEmphasisBySeries = new Map([[seriesIndex, 1]]);
  }

  function setPinnedLineFocus(seriesIndex: number | undefined): void {
    if (seriesIndex !== undefined) {
      pinnedLineSeriesIndex = seriesIndex;
      settleLineFocusVisual(seriesIndex);
      forceFullRedrawFlag = true;
      scheduleRedraw();
      scheduleLinePinHoverRefresh();
      return;
    }

    const previousSeriesIndex = pinnedLineSeriesIndex;
    pinnedLineSeriesIndex = undefined;
    if (previousSeriesIndex === undefined) {
      return;
    }
    transitionLineFocusVisual(
      { markType: "line", index: -1, seriesIndex: previousSeriesIndex },
      undefined
    );
    hoverController?.clear();
    tooltipController?.hide();
    forceFullRedrawFlag = true;
    scheduleRedraw();
  }

  function scheduleLinePinHoverRefresh(): void {
    if (linePinHoverRefreshFrame !== undefined) {
      cancelAnimationFrame(linePinHoverRefreshFrame);
    }
    linePinHoverRefreshFrame = requestAnimationFrame(() => {
      linePinHoverRefreshFrame = undefined;
      hoverController?.forceRefresh();
      tooltipController?.refresh();
    });
  }

  function tickLineFocusTransition(time: number): void {
    lineFocusTransitionFrame = undefined;
    const transition = lineFocusTransition;
    if (!transition) {
      return;
    }

    const progress = Math.min(1, Math.max(0, (time - transition.startedAt) / LINE_FOCUS_TRANSITION_MS));
    const eased = easeOutCubic(progress);
    lineFocusDimProgress = transition.startDimProgress +
      (transition.targetDimProgress - transition.startDimProgress) * eased;

    const seriesIndices = new Set(transition.startEmphasisBySeries.keys());
    if (transition.targetSeriesIndex !== undefined) {
      seriesIndices.add(transition.targetSeriesIndex);
    }
    const nextEmphasis = new Map<number, number>();
    for (const seriesIndex of seriesIndices) {
      const start = transition.startEmphasisBySeries.get(seriesIndex) ?? 0;
      const target = seriesIndex === transition.targetSeriesIndex ? 1 : 0;
      const value = start + (target - start) * eased;
      if (value > 0.001) {
        nextEmphasis.set(seriesIndex, value);
      }
    }
    lineFocusEmphasisBySeries = nextEmphasis;

    forceFullRedrawFlag = true;
    redraw({ skipInteractionRefresh: true });

    if (progress < 1 && lineFocusTransition === transition) {
      lineFocusTransitionFrame = requestAnimationFrame(tickLineFocusTransition);
      return;
    }

    if (lineFocusTransition === transition) {
      lineFocusTransition = undefined;
      lineFocusDimProgress = transition.targetDimProgress;
      lineFocusEmphasisBySeries = transition.targetSeriesIndex === undefined
        ? new Map()
        : new Map([[transition.targetSeriesIndex, 1]]);
    }
  }

  function currentLineFocusTransition(): Layout["lineFocusTransition"] {
    if (
      pinnedLineSeriesIndex === undefined &&
      lineFocusDimProgress <= 0.001 &&
      lineFocusEmphasisBySeries.size === 0
    ) {
      return undefined;
    }

    return {
      dimProgress: lineFocusDimProgress,
      emphasisBySeries: lineFocusEmphasisBySeries,
      ...(pinnedLineSeriesIndex !== undefined ? { pinnedSeriesIndex: pinnedLineSeriesIndex } : {})
    };
  }

  function resetLineFocusVisual(): void {
    if (lineFocusTransitionFrame !== undefined) {
      cancelAnimationFrame(lineFocusTransitionFrame);
      lineFocusTransitionFrame = undefined;
    }
    if (linePinHoverRefreshFrame !== undefined) {
      cancelAnimationFrame(linePinHoverRefreshFrame);
      linePinHoverRefreshFrame = undefined;
    }
    lineFocusTransition = undefined;
    lineFocusDimProgress = 0;
    lineFocusEmphasisBySeries = new Map();
    pinnedLineSeriesIndex = undefined;
    linePinGesture = undefined;
  }

  function resolveScatterHoverForScene(): HoverState | undefined {
    return hover?.markType === "scatter" ? hover : undefined;
  }

  function getActiveScatterHoverEntries(): ScatterHoverEntry[] {
    return [...scatterHoverAnimations.values()].map((animation) => ({
      index: animation.index,
      progress: animation.progress,
      ...(animation.target === 0 && animation.startProgress > 0
        ? { shrinkStartProgress: animation.startProgress }
        : {})
    }));
  }

  function transitionScatterHoverGrow(
    previousIndex: number | undefined,
    nextIndex: number | undefined
  ): void {
    if (previousIndex !== undefined && previousIndex !== nextIndex) {
      startScatterHoverAnimation(previousIndex, 0);
    } else if (previousIndex !== undefined && nextIndex === undefined) {
      startScatterHoverAnimation(previousIndex, 0);
    }

    if (nextIndex !== undefined) {
      startScatterHoverAnimation(nextIndex, 1);
    } else {
      scheduleScatterHoverAnimations();
    }
  }

  function startScatterHoverAnimation(index: number, target: number): void {
    const existing = scatterHoverAnimations.get(index);
    const startProgress = existing?.progress ?? (target > 0 ? 0 : 1);

    if (target > 0 && startProgress >= 1) {
      renderScatterHoverOverlay();
      return;
    }

    if (target === 0 && startProgress <= 0) {
      scatterHoverAnimations.delete(index);
      renderScatterHoverOverlay();
      return;
    }

    scatterHoverAnimations.set(index, {
      index,
      progress: startProgress,
      target,
      startProgress,
      startTime: performance.now(),
      durationMs: target > startProgress ? 180 : 260
    });

    scheduleScatterHoverAnimations();
  }

  function scheduleScatterHoverAnimations(): void {
    renderScatterHoverOverlay();

    if (scatterHoverAnimFrame !== undefined || scatterHoverAnimations.size === 0) {
      return;
    }

    scatterHoverAnimFrame = requestAnimationFrame(tickScatterHoverAnimations);
  }

  function tickScatterHoverAnimations(): void {
    scatterHoverAnimFrame = undefined;

    if (scatterHoverAnimations.size === 0) {
      renderScatterHoverOverlay();
      return;
    }

    const now = performance.now();
    let hasActive = false;

    for (const [index, animation] of scatterHoverAnimations) {
      const t = Math.min(1, (now - animation.startTime) / animation.durationMs);
      const eased = animation.target > animation.startProgress
        ? easeOutCubic(t)
        : easeInCubic(t);
      animation.progress = animation.startProgress +
        (animation.target - animation.startProgress) * eased;

      if (t < 1) {
        hasActive = true;
        continue;
      }

      animation.progress = animation.target;

      if (animation.target === 0) {
        scatterHoverAnimations.delete(index);
      }
    }

    renderScatterHoverOverlay();

    if (hasActive) {
      scatterHoverAnimFrame = requestAnimationFrame(tickScatterHoverAnimations);
    }
  }

  function renderScatterHoverOverlay(): void {
    if (!spec.marks.some((m) => m.kind === "scatter")) {
      return;
    }

    const renderScatterHover = renderer.renderScatterHover ?? renderer.renderOverlay;

    if (!renderScatterHover) {
      return;
    }

    const { hover: _sceneHover, ...sceneWithoutHover } = scene;
    const overlayHoverState = resolveScatterHoverForScene();
    const overlayScene = applyScatterHoverState(
      overlayHoverState
        ? { ...sceneWithoutHover, hover: overlayHoverState }
        : sceneWithoutHover
    );

    if (overlayScene.scatterHover?.length || overlayScene.hover?.markType === "scatter") {
      renderScatterHover(surface, overlayScene);
      return;
    }

    if (renderer.renderScatterHover) {
      renderScatterHover(surface, {
        ...overlayScene,
        size: scene.size,
        plotArea: scene.plotArea,
        primitives: []
      });
    } else if (renderer.renderOverlay) {
      renderer.renderOverlay(surface, overlayScene);
    }
  }

  function applyScatterHoverState(nextScene: SceneGraph): SceneGraph {
    const scatterHoverMode = resolveScatterHoverInteraction(spec);

    if (scatterHoverMode === "none") {
      return nextScene;
    }

    const scatterHover = getActiveScatterHoverEntries();

    return scatterHover.length > 0 ? { ...nextScene, scatterHover } : nextScene;
  }

  function sceneWithOverlayHover(
    nextScene: SceneGraph,
    dataWindow?: Layout["dataWindow"]
  ): SceneGraph {
    const overlayHoverState = overlayHover ? resolveScatterHoverForScene() : undefined;
    const withHover = overlayHoverState ? { ...nextScene, hover: overlayHoverState } : nextScene;
    const edgeBlur = buildAnimatedSceneEdgeBlur(
      dataWindow ?? renderCache?.dataWindow,
      withHover.dataFocusAxis ?? "x"
    );

    return edgeBlur ? { ...withHover, edgeBlur } : withHover;
  }

  function buildAnimatedSceneEdgeBlur(
    dataWindow: Layout["dataWindow"] | undefined,
    dataFocusAxis: "x" | "y"
  ): SceneGraph["edgeBlur"] {
    // Scatter plots never render edge blur. Avoid allocating fade state and a
    // mark-kind Set on every 120 Hz point-cloud frame.
    if (
      spec.edgeBlur === undefined ||
      spec.edgeBlur === false ||
      !spec.marks.some((mark) => mark.kind === "bar" || mark.kind === "line")
    ) {
      return undefined;
    }

    const target = resolveSceneEdgeBlur(
      spec,
      spec.theme ?? defaultTheme,
      focus,
      dataFocusAxis,
      dataWindow
    );

    if (target) {
      edgeBlurFadeStyle = {
        color: target.color ?? (spec.theme ?? defaultTheme).palette.background,
        size: target.size ?? resolveEdgeBlurSize(spec)
      };
    }

    const targets = {
      left: target?.left ? 1 : 0,
      right: target?.right ? 1 : 0,
      top: target?.top ? 1 : 0,
      bottom: target?.bottom ? 1 : 0
    };

    if (EDGE_BLUR_FADE_MS <= 0) {
      edgeBlurFade = targets;
      edgeBlurFadeLastTime = undefined;
      if (edgeBlurFadeFrame !== undefined) {
        cancelAnimationFrame(edgeBlurFadeFrame);
        edgeBlurFadeFrame = undefined;
      }
    } else {
      const now = performance.now();
      const dt = edgeBlurFadeLastTime === undefined ? 16 : Math.min(64, now - edgeBlurFadeLastTime);
      edgeBlurFadeLastTime = now;
      const step = dt / EDGE_BLUR_FADE_MS;
      edgeBlurFade = {
        left: approachFade(edgeBlurFade.left, targets.left, step),
        right: approachFade(edgeBlurFade.right, targets.right, step),
        top: approachFade(edgeBlurFade.top, targets.top, step),
        bottom: approachFade(edgeBlurFade.bottom, targets.bottom, step)
      };
    }

    const fading =
      Math.abs(edgeBlurFade.left - targets.left) > 0.001 ||
      Math.abs(edgeBlurFade.right - targets.right) > 0.001 ||
      Math.abs(edgeBlurFade.top - targets.top) > 0.001 ||
      Math.abs(edgeBlurFade.bottom - targets.bottom) > 0.001;
    scheduleEdgeBlurFadeFrame(fading);

    const visible =
      edgeBlurFade.left > 0.001 ||
      edgeBlurFade.right > 0.001 ||
      edgeBlurFade.top > 0.001 ||
      edgeBlurFade.bottom > 0.001;
    if (!visible || !edgeBlurFadeStyle) {
      return undefined;
    }

    return {
      left: edgeBlurFade.left > 0.001,
      right: edgeBlurFade.right > 0.001,
      top: edgeBlurFade.top > 0.001,
      bottom: edgeBlurFade.bottom > 0.001,
      leftOpacity: edgeBlurFade.left,
      rightOpacity: edgeBlurFade.right,
      topOpacity: edgeBlurFade.top,
      bottomOpacity: edgeBlurFade.bottom,
      color: edgeBlurFadeStyle.color,
      size: edgeBlurFadeStyle.size
    };
  }

  function scheduleEdgeBlurFadeFrame(fading: boolean): void {
    if (!fading) {
      if (edgeBlurFadeFrame !== undefined) {
        cancelAnimationFrame(edgeBlurFadeFrame);
        edgeBlurFadeFrame = undefined;
      }
      edgeBlurFadeLastTime = undefined;
      return;
    }

    if (edgeBlurFadeFrame !== undefined || resizeSettleTimer !== undefined) {
      return;
    }

    edgeBlurFadeFrame = requestAnimationFrame(() => {
      edgeBlurFadeFrame = undefined;
      scheduleRedraw();
    });
  }

  function buildHoverOverlayScene(nextHover: HoverState): SceneGraph {
    if (lastHoverEncodeContext) {
      return buildHoverOverlayFromContext(spec.marks, lastHoverEncodeContext, nextHover);
    }

    // Match the last painted domains when the encode context was dropped so
    // hover markers land on the same geometry as the main canvas.
    const built = buildScene(
      spec,
      size,
      markAnimationProgress,
      axisAnimationRuntime,
      animationProfile,
      randomFillFade,
      focus,
      nextHover,
      () => cachedBaseAxes,
      (next) => {
        cachedBaseAxes = next;
      },
      {
        hoverOnly: true,
        ...(lastRenderedXDomain ? { overrideXDomain: lastRenderedXDomain } : {}),
        ...(lastRenderedYDomain ? { overrideYDomain: lastRenderedYDomain } : {})
      },
      currentDataFocusAxis
    );

    return {
      ...built.scene,
      hover: nextHover,
      overlay: true
    };
  }

  function emptyOverlayScene(): SceneGraph {
    return {
      size: scene.size,
      plotArea: scene.plotArea,
      ...(scene.dataFocusAxis ? { dataFocusAxis: scene.dataFocusAxis } : {}),
      overlay: true,
      primitives: []
    };
  }

  function syncDataSubscription(): void {
    unsubscribeData?.();
    unsubscribeData = undefined;

    if (!isDataSource(spec.data) || !spec.data.subscribe) {
      return;
    }

    unsubscribeData = spec.data.subscribe(() => {
      const wasEmpty = renderedDataLength() === 0;
      skipStreamingStartLerpIfNeeded(wasEmpty);
      const canRefreshResizeStream = resizeSettleTimer !== undefined &&
        renderCache !== undefined &&
        (canUseStreamingFastPath(renderCache) || canUseLineStreamingFastPath(renderCache, spec));

      if (canRefreshResizeStream) {
        // The resize-owned 30Hz fast path patches axes and geometry from the
        // latest source state. Avoid repeating that bookkeeping at source rate.
        streamingDataAppended = true;
        lastDataUpdateTime = performance.now();
        return;
      }

      patchOrInvalidateBaseAxesOnDataChange(
        spec,
        spec.data,
        () => cachedBaseAxes,
        (next) => {
          cachedBaseAxes = next;
        }
      );
      if (renderCache && (canUseStreamingFastPath(renderCache) || canUseLineStreamingFastPath(renderCache, spec))) {
        streamingDataAppended = true;
      } else {
        renderCache = undefined;
      }
      recordDataUpdate();
      scheduleRedraw();
    });
  }
}

type RenderCache = {
  contentKey: string;
  stableContentKey: string;
  dataContentKey: string;
  size: Size;
  plotArea: Rect;
  axes: AxesSpec | undefined;
  dataFocusAxis?: "x" | "y";
  dataWindow?: Layout["dataWindow"];
  viewData?: readonly unknown[];
  backgroundPrimitives: readonly Primitive[];
  framePrimitives: readonly Primitive[];
  gridPrimitives: readonly Primitive[];
  markPrimitives: readonly Primitive[];
  axisPrimitives: readonly Primitive[];
  clipArea?: Rect;
  theme: Theme;
  baseXDomain?: readonly [number, number];
  baseYDomain?: readonly [number, number];
  baseAxes?: AxesSpec;
};

type BuiltScene<TDatum = unknown> = {
  scene: SceneGraph;
  size: Size;
  plotArea: Rect;
  dataFocusAxis?: "x" | "y";
  dataWindow?: Layout["dataWindow"];
  viewData: readonly TDatum[];
  markLayout: Layout;
  backgroundPrimitives: readonly Primitive[];
  framePrimitives: readonly Primitive[];
  gridPrimitives: readonly Primitive[];
  markPrimitives: readonly Primitive[];
  axisPrimitives: readonly Primitive[];
  clipArea?: Rect;
  axes: AxesSpec | undefined;
  initialAxes: AxesSpec | undefined;
};

type HoverEncodeContext<TDatum> = {
  viewData: readonly TDatum[];
  markLayout: Layout;
  size: Size;
  plotArea: Rect;
  dataFocusAxis?: "x" | "y";
  theme: Theme;
};

function buildHoverOverlayFromContext<TDatum>(
  marks: PlotSpec<TDatum>["marks"],
  context: HoverEncodeContext<TDatum>,
  nextHover: HoverState
): SceneGraph {
  const hoverMarkLayout: Layout = {
    ...context.markLayout,
    hover: nextHover,
    hoverOnly: true
  };
  const markPrimitives = marks.flatMap((mark) => mark.encode(context.viewData, hoverMarkLayout, context.theme));

  return {
    size: context.size,
    plotArea: context.plotArea,
    ...(context.dataFocusAxis ? { dataFocusAxis: context.dataFocusAxis } : {}),
    hover: nextHover,
    overlay: true,
    primitives: markPrimitives
  };
}

const dataIdentityTokens = new WeakMap<object, number>();
let dataIdentitySeq = 0;

/**
 * Produces a stable, O(1) identity token for a data input. Plain arrays are
 * tagged by reference via a WeakMap rather than stringified, so the content key
 * stays cheap even for million-row datasets (stringifying the whole array every
 * frame was previously the dominant resize cost).
 */
function dataIdentityToken<TDatum>(data: PlotSpec<TDatum>["data"]): string {
  if (isDataSource(data)) {
    return `source:${data.version}`;
  }

  if (typeof data === "object" && data !== null) {
    let token = dataIdentityTokens.get(data);

    if (token === undefined) {
      dataIdentitySeq += 1;
      token = dataIdentitySeq;
      dataIdentityTokens.set(data, token);
    }

    return `arr:${token}`;
  }

  return String(data);
}

function buildContentKey<TDatum>(
  spec: PlotSpec<TDatum>,
  size: Size,
  focus: PlotSelection | undefined,
  hover: HoverState | undefined
): string {
  const hoverKey = hover ? `${hover.markType}:${hover.index}:${hover.seriesIndex ?? ""}:${hover.x ?? ""}:${hover.y ?? ""}:${hover.xValue ?? ""}:${hover.yValue ?? ""}` : "";

  return `${size.width}x${size.height}|${buildStableContentKey(spec, focus)}|${hoverKey}`;
}

function buildStableContentKey<TDatum>(
  spec: PlotSpec<TDatum>,
  focus: PlotSelection | undefined
): string {
  return `${JSON.stringify(focus ?? null)}|${dataIdentityToken(spec.data)}|${buildHiddenSeriesContentKey(spec.hiddenSeries)}|${buildLabelContentKey(spec)}`;
}

function buildHiddenSeriesContentKey(hiddenSeries: Set<string | number> | undefined): string {
  if (!hiddenSeries || hiddenSeries.size === 0) {
    return "";
  }

  return [...hiddenSeries].map(String).sort().join(",");
}

function buildLabelContentKey<TDatum>(spec: PlotSpec<TDatum>): string {
  const axes = typeof spec.axes === "function" ? undefined : spec.axes;
  return JSON.stringify({
    title: spec.title ?? null,
    titleAnimation: spec.titleAnimation ?? null,
    timeZone: spec.timeZone ?? null,
    xTitle: axes?.x?.title ?? null,
    yTitle: axes?.y?.title ?? null,
    plotPadding: spec.plotPadding ?? null
  });
}

function encodePlotLabels<TDatum>(
  spec: PlotSpec<TDatum>,
  axes: AxesSpec | undefined,
  size: Size,
  plotArea: Rect,
  theme: Theme,
  animationProgress: number
): readonly Primitive[] {
  const primitives: Primitive[] = [];
  const title = resolveChartTitleSpec(spec.title);
  if (title?.text) {
    const position = title.position ?? "top";
    const align = title.align ?? "center";
    const baseX = align === "left"
      ? plotArea.x
      : align === "right"
        ? plotArea.x + plotArea.width
        : plotArea.x + plotArea.width / 2;
    const baseY = position === "bottom"
      ? size.height - (title.offset ?? 14)
      : title.offset ?? 18;
    const x = baseX + (title.offsetX ?? 0);
    const y = baseY + (title.offsetY ?? 0);

    primitives.push(animateTitlePrimitive({
      kind: "text",
      x,
      y,
      text: title.text,
      fill: title.color ?? theme.palette.foreground,
      font: title.font ?? buildTitleFont(title, theme, 1.25, true),
      align,
      baseline: position === "bottom" ? "bottom" : "top",
      maxWidth: Math.max(1, plotArea.width)
    }, spec.titleAnimation, animationProgress, position === "bottom" ? "chart-bottom" : "chart-top"));
  }

  const xTitle = resolveAxisTitleSpec(axes?.x?.title);
  if (xTitle?.text) {
    const position = xTitle.position ?? "bottom";
    const align = xTitle.align ?? "center";
    const x = axisTitleX(plotArea, align) + (xTitle.offsetX ?? 0);
    const titleOffset = resolveAxisTitlePlotOffset(theme, axes?.x, position);
    const baseY = position === "top"
      ? Math.max(0, plotArea.y - titleOffset)
      : Math.min(size.height, plotArea.y + plotArea.height + titleOffset);
    const y = baseY + (xTitle.offsetY ?? 0);

    primitives.push(animateTitlePrimitive({
      kind: "text",
      x,
      y,
      text: xTitle.text,
      fill: xTitle.color ?? theme.palette.foreground,
      font: xTitle.font ?? buildTitleFont(xTitle, theme, 1, false),
      align: axisTitleTextAlign(align),
      baseline: position === "top" ? "bottom" : "top",
      maxWidth: Math.max(1, plotArea.width)
    }, spec.titleAnimation, animationProgress, position === "top" ? "x-top" : "x-bottom"));
  }

  const yTitle = resolveAxisTitleSpec(axes?.y?.title);
  if (yTitle?.text) {
    const position = yTitle.position ?? "left";
    const align = yTitle.align ?? "center";
    const titleOffset = resolveAxisTitlePlotOffset(theme, axes?.y, position);
    const baseX = position === "right"
      ? Math.min(size.width, plotArea.x + plotArea.width + titleOffset)
      : Math.max(0, plotArea.x - titleOffset);
    const x = baseX + (yTitle.offsetX ?? 0);
    const y = axisTitleY(plotArea, align) + (yTitle.offsetY ?? 0);

    primitives.push(animateTitlePrimitive({
      kind: "text",
      x,
      y,
      text: yTitle.text,
      fill: yTitle.color ?? theme.palette.foreground,
      font: yTitle.font ?? buildTitleFont(yTitle, theme, 1, false),
      align: axisTitleTextAlign(align),
      baseline: "middle",
      angle: position === "right" ? 90 : -90,
      maxWidth: Math.max(1, plotArea.height)
    }, spec.titleAnimation, animationProgress, position === "right" ? "y-right" : "y-left"));
  }

  return primitives;
}

export function resolveChartTitleSpec(title: PlotSpec<any>["title"]) {
  if (!title) return undefined;
  return typeof title === "string" ? { text: title } : title;
}

export function resolveAxisTitleSpec(title: AxisSpec["title"] | undefined) {
  if (!title) return undefined;
  return typeof title === "string" ? { text: title } : title;
}

function hasAnimatedTitleProfile<TDatum>(spec: PlotSpec<TDatum>, axes: AxesSpec | undefined): boolean {
  return isAnimatedTitleProfile(spec.titleAnimation) && (
    Boolean(resolveChartTitleSpec(spec.title)?.text) ||
    Boolean(resolveAxisTitleSpec(axes?.x?.title)?.text) ||
    Boolean(resolveAxisTitleSpec(axes?.y?.title)?.text)
  );
}

function isAnimatedTitleProfile(profile: TitleAnimationProfile | undefined): boolean {
  return profile !== undefined && profile !== "none";
}

function animateTitlePrimitive(
  primitive: Primitive & { kind: "text" },
  profile: TitleAnimationProfile | undefined,
  progress: number,
  direction: "chart-top" | "chart-bottom" | "x-top" | "x-bottom" | "y-left" | "y-right"
): Primitive & { kind: "text" } {
  const p = Math.max(0, Math.min(1, progress));
  const resolvedProfile = profile ?? "none";
  if (resolvedProfile === "none" || p >= 1) {
    return primitive;
  }

  const next = { ...primitive, opacity: p };
  if (resolvedProfile === "fade") {
    return next;
  }

  const distance = 10;
  const offset = distance * (1 - p);
  if (direction === "chart-top" || direction === "x-top") return { ...next, y: next.y - offset };
  if (direction === "chart-bottom" || direction === "x-bottom") return { ...next, y: next.y + offset };
  if (direction === "y-left") return { ...next, x: next.x - offset };
  return { ...next, x: next.x + offset };
}

function axisTitleX(plotArea: Rect, align: "start" | "center" | "end"): number {
  if (align === "start") return plotArea.x;
  if (align === "end") return plotArea.x + plotArea.width;
  return plotArea.x + plotArea.width / 2;
}

function axisTitleY(plotArea: Rect, align: "start" | "center" | "end"): number {
  if (align === "start") return plotArea.y + plotArea.height;
  if (align === "end") return plotArea.y;
  return plotArea.y + plotArea.height / 2;
}

function axisTitleTextAlign(align: "start" | "center" | "end"): CanvasTextAlign {
  if (align === "start") return "start";
  if (align === "end") return "end";
  return "center";
}

function buildTitleFont(title: { fontSize?: number; bold?: boolean; italic?: boolean }, theme: Theme, scale: number, defaultBold: boolean): string {
  const style = title.italic ? "italic " : "";
  const weight = (title.bold ?? defaultBold) ? "600" : "400";
  const size = title.fontSize ?? Math.round(theme.typography.fontSize * scale);
  return `${style}${weight} ${size}px ${theme.typography.fontFamily}`;
}

function escapeHtmlAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Content key that captures data identity + size but NOT focus.
 * When this key matches, only the zoom/pan domain has changed and
 * the fast path can be used.
 */
function buildDataContentKey<TDatum>(
  spec: PlotSpec<TDatum>,
  size: Size
): string {
  return `${size.width}x${size.height}|${dataIdentityToken(spec.data)}`;
}

function canUseFocusFastPath<TDatum>(
  cache: RenderCache,
  spec: PlotSpec<TDatum>,
  size: Size
): boolean {
  // The fast path applies when only the focus changed (not data, size, marks, or theme).
  if (cache.dataContentKey !== buildDataContentKey(spec, size)) {
    return false;
  }

  // We need base domains to compute focused domains.
  if (!cache.baseXDomain && !cache.baseYDomain) {
    return false;
  }

  // Need at least one point-cloud primitive to benefit from fast path.
  return cache.markPrimitives.some(
    (p) => p.kind === "point-cloud" && p.isRaw
  );
}

function canSkipFocusSettleFullRedraw(cache: RenderCache): boolean {
  return cache.markPrimitives.length > 0 &&
    cache.markPrimitives.every((p) => p.kind === "point-cloud" && p.isRaw);
}

function canUseRawPointCloudFocusInterpolation(cache: RenderCache): boolean {
  return canSkipFocusSettleFullRedraw(cache);
}

function extractBaseAxesFromBuilt(built: BuiltScene): {
  baseXDomain?: readonly [number, number];
  baseYDomain?: readonly [number, number];
  baseAxes?: AxesSpec;
} {
  const result: {
    baseXDomain?: readonly [number, number];
    baseYDomain?: readonly [number, number];
    baseAxes?: AxesSpec;
  } = {};

  const initialAxes = built.initialAxes;

  if (initialAxes?.x?.kind === "linear") {
    result.baseXDomain = initialAxes.x.domain;
  }

  if (initialAxes?.y?.kind === "linear") {
    result.baseYDomain = initialAxes.y.domain;
  }

  if (initialAxes) {
    result.baseAxes = initialAxes;
  }

  return result;
}

function resolveFastPathDomain(
  baseDomain: readonly [number, number],
  focusRange: readonly [number, number] | undefined
): readonly [number, number] {
  if (!focusRange) {
    return baseDomain;
  }

  return domainFromFocusRatio(baseDomain, focusRange);
}

function domainFromFocusRatio(
  baseDomain: readonly [number, number],
  focusRange: readonly [number, number]
): readonly [number, number] {
  const start = clamp01(Math.min(focusRange[0], focusRange[1]));
  const end = clamp01(Math.max(focusRange[0], focusRange[1]));

  if (end - start >= 0.999) {
    return baseDomain;
  }

  const span = baseDomain[1] - baseDomain[0] || 1;

  return [
    baseDomain[0] + span * start,
    baseDomain[0] + span * end
  ];
}

function domainsEqual(
  a: readonly [number, number] | undefined,
  b: readonly [number, number] | undefined
): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }

  return a[0] === b[0] && a[1] === b[1];
}

function isFiniteDomain(domain: readonly [number, number] | undefined): domain is readonly [number, number] {
  return domain !== undefined &&
    Number.isFinite(domain[0]) &&
    Number.isFinite(domain[1]) &&
    domain[0] < domain[1];
}

function domainContains(
  outer: readonly [number, number],
  inner: readonly [number, number]
): boolean {
  const outerMin = Math.min(outer[0], outer[1]);
  const outerMax = Math.max(outer[0], outer[1]);
  const innerMin = Math.min(inner[0], inner[1]);
  const innerMax = Math.max(inner[0], inner[1]);
  const epsilon = Math.max(1e-9, (outerMax - outerMin) * 1e-6);

  return innerMin >= outerMin - epsilon && innerMax <= outerMax + epsilon;
}

function unionDomains(
  a: readonly [number, number],
  b: readonly [number, number]
): readonly [number, number] {
  return [
    Math.min(a[0], a[1], b[0], b[1]),
    Math.max(a[0], a[1], b[0], b[1])
  ];
}

function lerpDomain(
  from: readonly [number, number],
  to: readonly [number, number],
  amount: number,
  epsilon: number
): { domain: readonly [number, number]; needsMoreFrames: boolean } {
  if (!isFiniteDomain(to)) {
    return { domain: from, needsMoreFrames: false };
  }

  if (!isFiniteDomain(from)) {
    return { domain: to, needsMoreFrames: false };
  }

  const span = Math.max(1e-9, to[1] - to[0]);
  const diff0 = Math.abs(to[0] - from[0]);
  const diff1 = Math.abs(to[1] - from[1]);

  if (diff0 <= epsilon * span && diff1 <= epsilon * span) {
    return { domain: to, needsMoreFrames: false };
  }

  return {
    domain: [
      from[0] + (to[0] - from[0]) * amount,
      from[1] + (to[1] - from[1]) * amount
    ],
    needsMoreFrames: true
  };
}

function patchPointCloudDomains(
  primitives: readonly Primitive[],
  xDomain: readonly [number, number] | undefined,
  yDomain: readonly [number, number] | undefined,
  overridePointCount?: number,
  overrideFullXDomain?: readonly [number, number],
  overrideFullYDomain?: readonly [number, number],
  overridePoints?: Float32Array,
  overrideCategoryIds?: Float32Array | null,
  overrideCategoryCount?: number
): readonly Primitive[] {
  const hasOverrides = overridePointCount !== undefined ||
    overrideFullXDomain !== undefined ||
    overrideFullYDomain !== undefined ||
    overridePoints !== undefined ||
    overrideCategoryIds !== undefined ||
    overrideCategoryCount !== undefined;

  // Pan/zoom hot path: mutate domains/radius in place to avoid per-frame allocs.
  if (!hasOverrides) {
    for (const primitive of primitives) {
      if (primitive.kind !== "point-cloud" || !primitive.isRaw) {
        continue;
      }

      const fullX = primitive.fullXDomain;
      const fullY = primitive.fullYDomain;
      let nextRadius = primitive.radius;
      if (primitive.baseRadius !== undefined && fullX && fullY && xDomain && yDomain && primitive.plotArea) {
        const xSpan = Math.max(Number.EPSILON, xDomain[1] - xDomain[0]);
        const ySpan = Math.max(Number.EPSILON, yDomain[1] - yDomain[0]);
        const fullXSpan = Math.max(Number.EPSILON, fullX[1] - fullX[0]);
        const fullYSpan = Math.max(Number.EPSILON, fullY[1] - fullY[0]);
        const zoomRatio = Math.max(fullXSpan / xSpan, fullYSpan / ySpan);
        nextRadius = resolveBaseRadiusForPatch(
          primitive.baseRadius,
          primitive.radiusScaleConfig,
          zoomRatio
        );
      }

      primitive.radius = nextRadius;
      if (xDomain) {
        primitive.xDomain = xDomain;
      }
      if (yDomain) {
        primitive.yDomain = yDomain;
      }
    }
    return primitives;
  }

  return primitives.map((p) => {
    if (p.kind !== "point-cloud" || !p.isRaw) {
      return p;
    }

    const fullX = overrideFullXDomain ?? p.fullXDomain;
    const fullY = overrideFullYDomain ?? p.fullYDomain;
    let nextRadius = p.radius;
    if (p.baseRadius !== undefined && fullX && fullY && xDomain && yDomain && p.plotArea) {
      const xSpan = Math.max(Number.EPSILON, xDomain[1] - xDomain[0]);
      const ySpan = Math.max(Number.EPSILON, yDomain[1] - yDomain[0]);
      const fullXSpan = Math.max(Number.EPSILON, fullX[1] - fullX[0]);
      const fullYSpan = Math.max(Number.EPSILON, fullY[1] - fullY[0]);

      const zoomX = fullXSpan / xSpan;
      const zoomY = fullYSpan / ySpan;
      const zoomRatio = Math.max(zoomX, zoomY);

      nextRadius = resolveBaseRadiusForPatch(
        p.baseRadius,
        p.radiusScaleConfig,
        zoomRatio
      );
    }

    const nextPrimitive: Extract<Primitive, { kind: "point-cloud" }> = {
      ...p,
      radius: nextRadius,
      ...(overridePoints ? { points: overridePoints } : {}),
      ...(xDomain ? { xDomain } : {}),
      ...(yDomain ? { yDomain } : {}),
      ...(overridePointCount !== undefined ? { pointCount: overridePointCount } : {}),
      ...(overrideFullXDomain ? { fullXDomain: overrideFullXDomain } : {}),
      ...(overrideFullYDomain ? { fullYDomain: overrideFullYDomain } : {})
    };

    if (overrideCategoryIds instanceof Float32Array) {
      nextPrimitive.categoryIds = overrideCategoryIds;
    } else if (overrideCategoryIds === null) {
      delete nextPrimitive.categoryIds;
      delete nextPrimitive.categoryPalette;
      delete nextPrimitive.categoryShapes;
    }

    if (overrideCategoryCount !== undefined) {
      nextPrimitive.categoryCount = overrideCategoryCount;
    }

    return nextPrimitive;
  });
}

function resolveBaseRadiusForPatch(
  baseRadius: number,
  radiusScaleConfig: any,
  zoomRatio: number
): number {
  if (radiusScaleConfig === false) {
    return baseRadius;
  }

  const config = typeof radiusScaleConfig === "object" ? radiusScaleConfig : {};
  const maxScale = config.maxScale ?? 3.5;
  const scale = Math.min(maxScale, Math.max(1, Math.pow(zoomRatio, 0.55)));

  return baseRadius * scale;
}

function patchPointCloudPlotArea(
  primitives: readonly Primitive[],
  plotArea: Rect
): readonly Primitive[] {
  return primitives.map((p) => {
    if (p.kind !== "point-cloud" || !p.isRaw) {
      return p;
    }

    let nextRadius = p.radius;
    if (p.baseRadius !== undefined && p.fullXDomain && p.fullYDomain && p.xDomain && p.yDomain) {
      const xSpan = Math.max(Number.EPSILON, p.xDomain[1] - p.xDomain[0]);
      const ySpan = Math.max(Number.EPSILON, p.yDomain[1] - p.yDomain[0]);
      const fullXSpan = Math.max(Number.EPSILON, p.fullXDomain[1] - p.fullXDomain[0]);
      const fullYSpan = Math.max(Number.EPSILON, p.fullYDomain[1] - p.fullYDomain[0]);

      const zoomX = fullXSpan / xSpan;
      const zoomY = fullYSpan / ySpan;
      const zoomRatio = Math.max(zoomX, zoomY);

      nextRadius = resolveBaseRadiusForPatch(
        p.baseRadius,
        p.radiusScaleConfig,
        zoomRatio
      );
    }

    return {
      ...p,
      radius: nextRadius,
      plotArea,
      clip: resolveScatterClipFromPlotArea(plotArea)
    };
  });
}

function resolveScatterClipFromPlotArea(
  plotArea: Rect
): Rect {
  return plotArea;
}

function patchLinearAxesDomains(
  baseAxes: AxesSpec | undefined,
  xDomain: readonly [number, number] | undefined,
  yDomain: readonly [number, number] | undefined
): AxesSpec | undefined {
  if (!baseAxes) {
    return undefined;
  }

  let patched = baseAxes;

  if (xDomain && baseAxes.x?.kind === "linear") {
    patched = {
      ...patched,
      x: {
        ...baseAxes.x,
        domain: xDomain,
        scaleDomain: xDomain,
        baseDomain: baseAxes.x.baseDomain ?? baseAxes.x.domain,
        nice: false
      }
    };
  }

  if (yDomain && baseAxes.y?.kind === "linear") {
    patched = {
      ...patched,
      y: {
        ...baseAxes.y,
        domain: yDomain,
        scaleDomain: yDomain,
        baseDomain: baseAxes.y.baseDomain ?? baseAxes.y.domain,
        nice: false
      }
    };
  }

  return patched;
}

function resizePlotAreaTransform(
  from: Rect,
  to: Rect
): { a: number; d: number; e: number; f: number } | undefined {
  if (from.width <= 0 || from.height <= 0 || to.width <= 0 || to.height <= 0) {
    return undefined;
  }

  const transform = {
    a: to.width / from.width,
    d: to.height / from.height,
    e: to.x - from.x * (to.width / from.width),
    f: to.y - from.y * (to.height / from.height)
  };

  return Object.values(transform).every(Number.isFinite) ? transform : undefined;
}

function canTransformResizeMarkPrimitives(primitives: readonly Primitive[]): boolean {
  return primitives.length > 0 && primitives.every(
    (primitive) =>
      primitive.kind === "path" ||
      primitive.kind === "circle" ||
      primitive.kind === "rect" ||
      primitive.kind === "rects" ||
      primitive.kind === "text" ||
      primitive.kind === "point-cloud"
  );
}

function bakeResizeMarkPrimitives(
  primitives: readonly Primitive[],
  transform: { a: number; d: number; e: number; f: number }
): Primitive[] | undefined {
  const resized: Primitive[] = [];

  for (const primitive of primitives) {
    if (primitive.kind === "path") {
      resized.push({
        ...primitive,
        points: primitive.points.map(([x, y]) => [
          x * transform.a + transform.e,
          y * transform.d + transform.f
        ]),
        ...(primitive.clip ? { clip: transformResizeRect(primitive.clip, transform) } : {}),
        ...(primitive.areaBaseline === undefined
          ? {}
          : { areaBaseline: primitive.areaBaseline * transform.d + transform.f })
      });
      continue;
    }

    if (primitive.kind === "circle") {
      resized.push({
        ...primitive,
        x: primitive.x * transform.a + transform.e,
        y: primitive.y * transform.d + transform.f,
        ...(primitive.clip ? { clip: transformResizeRect(primitive.clip, transform) } : {})
      });
      continue;
    }

    if (primitive.kind === "point-cloud") {
      const points = primitive.isRaw
        ? primitive.points
        : transformResizePointBuffer(primitive.points, transform);
      resized.push({
        ...primitive,
        points,
        ...(primitive.clip ? { clip: transformResizeRect(primitive.clip, transform) } : {}),
        ...(primitive.plotArea
          ? { plotArea: transformResizeRect(primitive.plotArea, transform) }
          : {})
      });
      continue;
    }

    if (primitive.kind === "rect") {
      const hitTest = primitive.hitTest;
      resized.push({
        ...primitive,
        ...transformResizeRect(primitive, transform),
        ...(primitive.clip ? { clip: transformResizeRect(primitive.clip, transform) } : {}),
        ...(primitive.tooltipBounds
          ? { tooltipBounds: transformResizeRect(primitive.tooltipBounds, transform) }
          : {}),
        ...(hitTest
          ? {
              hitTest: (x: number, y: number) => {
                const hit = hitTest(
                  (x - transform.e) / transform.a,
                  (y - transform.f) / transform.d
                );
                return hit
                  ? {
                      ...hit,
                      x: hit.x * transform.a + transform.e,
                      y: hit.y * transform.d + transform.f,
                      width: hit.width * transform.a,
                      height: hit.height * transform.d,
                      ...(hit.hoverX === undefined
                        ? {}
                        : { hoverX: hit.hoverX * transform.a + transform.e }),
                      ...(hit.hoverY === undefined
                        ? {}
                        : { hoverY: hit.hoverY * transform.d + transform.f }),
                      ...(hit.tooltipBounds
                        ? { tooltipBounds: transformResizeRect(hit.tooltipBounds, transform) }
                        : {})
                    }
                  : undefined;
              }
            }
          : {})
      });
      continue;
    }

    if (primitive.kind === "rects") {
      resized.push({
        ...primitive,
        rects: primitive.rects.map((rect) => transformResizeRect(rect, transform)),
        ...(primitive.clip ? { clip: transformResizeRect(primitive.clip, transform) } : {})
      });
      continue;
    }

    if (primitive.kind === "text") {
      resized.push({
        ...primitive,
        x: primitive.x * transform.a + transform.e,
        y: primitive.y * transform.d + transform.f,
        ...(primitive.clip ? { clip: transformResizeRect(primitive.clip, transform) } : {}),
        ...(primitive.maxWidth === undefined ? {} : { maxWidth: primitive.maxWidth * transform.a })
      });
      continue;
    }

    return undefined;
  }

  return resized;
}

function transformResizePointBuffer(
  points: Float32Array,
  transform: { a: number; d: number; e: number; f: number }
): Float32Array {
  const resized = new Float32Array(points.length);
  for (let index = 0; index < points.length; index += 2) {
    resized[index] = (points[index] ?? 0) * transform.a + transform.e;
    resized[index + 1] = (points[index + 1] ?? 0) * transform.d + transform.f;
  }
  return resized;
}

function transformResizeRect(
  rect: Rect,
  transform: { a: number; d: number; e: number; f: number }
): Rect {
  return {
    x: rect.x * transform.a + transform.e,
    y: rect.y * transform.d + transform.f,
    width: rect.width * transform.a,
    height: rect.height * transform.d,
    ...(rect.cornerRadii ? { cornerRadii: rect.cornerRadii } : {})
  };
}

function encodeChartBackground(size: Size, plotArea: Rect, theme: Theme): Primitive[] {
  return [
    {
      kind: "rect",
      x: 0,
      y: 0,
      width: size.width,
      height: size.height,
      fill: theme.palette.background
    },
    {
      kind: "rect",
      x: plotArea.x,
      y: plotArea.y,
      width: plotArea.width,
      height: plotArea.height,
      fill: theme.palette.plotBackground ?? theme.palette.background
    }
  ];
}

function assembleSceneFromCache(
  cache: RenderCache,
  hover: HoverState | undefined
): SceneGraph {
  return {
    size: cache.size,
    plotArea: cache.plotArea,
    ...(cache.dataFocusAxis ? { dataFocusAxis: cache.dataFocusAxis } : {}),
    ...(hover ? { hover } : {}),
    primitives: [
      ...cache.backgroundPrimitives,
      ...cache.framePrimitives,
      ...cache.gridPrimitives,
      ...cache.markPrimitives,
      ...cache.axisPrimitives
    ]
  };
}

function buildScene<TDatum>(
  spec: PlotSpec<TDatum>,
  size: Size,
  markAnimationProgress: number,
  axisAnimation: AxisAnimationState | undefined,
  animationProfile: AnimationOptions["profile"],
  randomFillFade: boolean,
  focus: PlotSelection | undefined,
  hover: HoverState | undefined,
  getCachedBaseAxes: () => { data: readonly TDatum[]; axes: AxesSpec } | undefined,
  setCachedBaseAxes: (cache: { data: readonly TDatum[]; axes: AxesSpec } | undefined) => void,
  options: {
    markPrimitives?: readonly Primitive[];
    previewPlotArea?: Rect;
    hoverOnly?: boolean;
    skipMarks?: boolean;
    lineFocusTransition?: Layout["lineFocusTransition"];
    overrideXDomain?: readonly [number, number] | undefined;
    overrideYDomain?: readonly [number, number] | undefined;
    axisTickFade?: AxisTickFadeState;
  } = {},
  indexingFocusAxis?: "x" | "y"
): BuiltScene<TDatum> {
  const theme = spec.theme ?? defaultTheme;
  const baseLayout = computeLayout(size, theme, undefined, spec.plotPadding, spec.title, spec.hiddenSeries);
  const renderDistance = resolveRenderOptimization(spec.optimization);
  const focusMode = resolveFocusMode(spec);
  const panSmoothEnabled = spec.interactions !== false &&
    spec.interactions?.pan !== false &&
    spec.interactions?.pan?.smooth !== false;
  const dataRequest: DataSourceResolveRequest = {
    plotArea: options.previewPlotArea ?? baseLayout.plotArea,
    renderDistance,
    snapToIndices: !panSmoothEnabled,
    includeContinuityPoints: true,
    ...(options.overrideXDomain ? { xDomain: options.overrideXDomain } : {}),
    ...(options.overrideYDomain ? { yDomain: options.overrideYDomain } : {}),
    ...(indexingFocusAxis ? { dataFocusAxis: indexingFocusAxis } : {})
  };

  if (focus) {
    dataRequest.focus = focus;
  }

  const resolvedData = resolveDataInput(spec.data, dataRequest);

  const transformed = (spec.transforms ?? []).reduce<readonly TDatum[]>(
    (data, transform) => transform.apply(data),
    resolvedData.data
  );
  const hasHiddenSeries = spec.hiddenSeries !== undefined && spec.hiddenSeries.size > 0;
  let cachedBaseAxes = getCachedBaseAxes();
  const patchedCachedBaseAxes = patchCachedBaseAxesFromSource(
    spec.data,
    cachedBaseAxes,
    setCachedBaseAxes,
    hasHiddenSeries
  );

  if (patchedCachedBaseAxes) {
    cachedBaseAxes = patchedCachedBaseAxes;
  }

  if (
    !cachedBaseAxes &&
    !hasHiddenSeries &&
    isDataSource(spec.data) &&
    resolveDataSourceYExtent(spec.data) &&
    resolveDataSourceXExtent(spec.data)
  ) {
    const bootAxes = applyPlotTimeZone(
      patchAxesYFromExtent(
        patchAxesXFromExtent(
          resolveAxes(spec.axes, []) ?? {},
          resolveDataSourceXExtent(spec.data)!
        ),
        resolveDataSourceYExtent(spec.data)!
      ),
      spec.timeZone
    );

    if (bootAxes) {
      const cacheObj = { data: transformed, axes: bootAxes, size: { width: size.width, height: size.height } };
      (cacheObj as any).version = spec.data.version;
      setCachedBaseAxes(cacheObj);
      cachedBaseAxes = cacheObj;
    }
  }

  const isCacheOutdated = cachedBaseAxes && isDataSource(spec.data) &&
    (cachedBaseAxes as any).version !== spec.data.version;

  if (
    resolvedData.source &&
    (!cachedBaseAxes || isCacheOutdated) &&
    focusMode === "domain" &&
    focus &&
    !hasHiddenSeries &&
    !(resolveDataSourceYExtent(spec.data) && resolveDataSourceXExtent(spec.data))
  ) {
    const fullRequest: DataSourceResolveRequest = {
      ...dataRequest
    };
    delete fullRequest.focus;
    delete fullRequest.xDomain;
    delete fullRequest.yDomain;
    const fullResolvedData = resolveDataInput(spec.data, fullRequest);
    const fullTransformed = (spec.transforms ?? []).reduce<readonly TDatum[]>(
      (data, transform) => transform.apply(data),
      fullResolvedData.data
    );
    const fullAxes = applyPlotTimeZone(resolveAxes(spec.axes, fullTransformed), spec.timeZone);
    if (fullAxes) {
      const cacheObj = { data: fullTransformed, axes: fullAxes, size: { width: size.width, height: size.height } };
      (cacheObj as any).version = isDataSource(spec.data) ? spec.data.version : undefined;
      setCachedBaseAxes(cacheObj);
      cachedBaseAxes = cacheObj;
    }
  }

  const currentCache = cachedBaseAxes;
  const canUseCachedBaseAxes = currentCache !== undefined &&
    (!resolvedData.source
      ? currentCache.data === transformed
      : focusMode === "domain") &&
    (currentCache as any).size?.width === size.width &&
    (currentCache as any).size?.height === size.height;
  const initialAxes = applyPlotTimeZone((canUseCachedBaseAxes && currentCache)
    ? currentCache.axes
    : resolveAxes(spec.axes, transformed), spec.timeZone);

  if (initialAxes && (!resolvedData.source || !focus || focusMode === "domain")) {
    const cacheObj = { data: transformed, axes: initialAxes, size: { width: size.width, height: size.height } };
    (cacheObj as any).version = isDataSource(spec.data) ? spec.data.version : undefined;
    setCachedBaseAxes(cacheObj);
  }
  const dataFocusAxis = resolveDataFocusAxis(initialAxes);
  const fixedScaleBandFocus = focusMode === "domain" && isBandFocusAxis(initialAxes, dataFocusAxis);
  const smoothPan = fixedScaleBandFocus || (panSmoothEnabled && focusMode !== "domain");
  const view = resolvedData.source
    ? { data: transformed, axisData: transformed }
    : focusMode === "domain"
      ? { data: transformed, axisData: transformed }
    : applySelectionFocus(transformed, focus, smoothPan, dataFocusAxis);
  const axisData = resolvedData.source
    ? transformed
    : focusMode === "domain"
      ? transformed
      : view.virtual
        ? view.data
        : view.axisData;
  let resolvedBaseAxes = view.virtual
    ? initialAxes
    : resolvedData.source || axisData === transformed
    ? initialAxes
    : applyPlotTimeZone(resolveAxes(spec.axes, axisData), spec.timeZone);

  if (focus?.y && initialAxes?.y && resolvedBaseAxes?.y) {
    resolvedBaseAxes = {
      ...resolvedBaseAxes,
      y: initialAxes.y
    };
  }
  const axes = applySelectionAxisDomain(
    applyVirtualBandAxisDomain(
      applyDataSourceAxisDomain(
        resolvedBaseAxes,
        resolvedData.domain
      ),
      view.virtual
    ),
    focus,
    focusMode,
    resolvedData.domain?.visibleX !== undefined
  );

  let finalAxes = axes;
  if (options.overrideXDomain && finalAxes?.x && finalAxes.x.kind === "linear") {
    finalAxes = {
      ...finalAxes,
      x: {
        ...finalAxes.x,
        domain: options.overrideXDomain,
        scaleDomain: options.overrideXDomain,
        nice: false
      }
    };
  }
  let yDomainOverride = options.overrideYDomain;
  if (!yDomainOverride && focusMode === "index" && finalAxes?.y && finalAxes.y.kind === "linear") {
    const targetX = options.overrideXDomain ?? resolveLayoutXDomain(finalAxes);
    const yDomainData = targetX ? transformed : view.axisData;
    yDomainOverride = resolveVisibleLineYDomain(spec, yDomainData, targetX);
  }

  if (yDomainOverride && finalAxes?.y && finalAxes.y.kind === "linear") {
    finalAxes = {
      ...finalAxes,
      y: {
        ...finalAxes.y,
        baseDomain: finalAxes.y.baseDomain ?? finalAxes.y.domain,
        domain: yDomainOverride,
        scaleDomain: yDomainOverride,
        nice: false
      }
    };
  }

  if (transformed.length === 0) {
    finalAxes = undefined;
  }

  const finalLayout = computeLayout(size, theme, finalAxes, spec.plotPadding, spec.title, spec.hiddenSeries);
  const markPlotArea = view.virtual
    ? view.virtual.axis === "y"
      ? {
          ...finalLayout.plotArea,
          y: finalLayout.plotArea.y + finalLayout.plotArea.height * view.virtual.offsetRatio,
          height: finalLayout.plotArea.height * view.virtual.widthScale
        }
      : {
          ...finalLayout.plotArea,
          x: finalLayout.plotArea.x + finalLayout.plotArea.width * view.virtual.offsetRatio,
          width: finalLayout.plotArea.width * view.virtual.widthScale
        }
    : finalLayout.plotArea;
  const yDomain = yDomainOverride ?? resolveLayoutYDomain(finalAxes);
  const xDomain = options.overrideXDomain ?? resolveLayoutXDomain(finalAxes);
  const markLayout = {
    ...finalLayout,
    plotArea: markPlotArea,
    ...(hover ? { hover } : {}),
    ...(options.lineFocusTransition ? { lineFocusTransition: options.lineFocusTransition } : {}),
    ...(options.hoverOnly ? { hoverOnly: true } : {}),
    ...(view.virtual ? { clipArea: finalLayout.plotArea } : {}),
    animation: {
      progress: markAnimationProgress,
      profile: animationProfile ?? "rise",
      ...((animationProfile === "random-fill" || animationProfile === "random-fill-grow") && randomFillFade ? { randomFillFade: true as const } : {})
    },
    ...(xDomain ? { xDomain } : {}),
    ...(yDomain ? { yDomain } : {}),
    renderDistance,
    ...(resolvedData.domain ? {
      dataWindow: {
        startIndex: resolvedData.domain.startIndex,
        endIndex: resolvedData.domain.endIndex,
        visibleStart: resolvedData.domain.visibleStart,
        visibleEnd: resolvedData.domain.visibleEnd,
        ...(options.overrideXDomain !== undefined || resolvedData.domain.visibleX !== undefined
          ? { visibleX: options.overrideXDomain ?? resolvedData.domain.visibleX }
          : {}),
        totalLength: resolvedData.domain.totalLength
      }
    } : {})
  };
  const axisPlotArea = view.virtual ? markPlotArea : undefined;
  const framePrimitives = options.hoverOnly || spec.frame === false
    ? []
    : encodeFrame(size, finalLayout.plotArea, theme, spec.frame);
  const markPrimitives = options.skipMarks
    ? []
    : options.markPrimitives ??
    spec.marks.flatMap((mark) => mark.encode(view.data, markLayout, theme));
  const gridPrimitives = options.hoverOnly ? [] : encodeGridlines(
    finalAxes,
    finalLayout.plotArea,
    theme,
    axisAnimation,
    options.axisTickFade
  );
  const axisPrimitives = options.hoverOnly ? [] : [
    ...encodeAxes(
      finalAxes,
      finalLayout.plotArea,
      theme,
      axisPlotArea,
      axisAnimation,
      options.axisTickFade,
      shouldFadeStreamingAxisEdge(spec, focus)
    ),
    ...encodePlotLabels(spec, finalAxes, size, finalLayout.plotArea, theme, markAnimationProgress)
  ];

  if (spec.liveYValueTicker && !options.hoverOnly) {
    axisPrimitives.push(...encodeLiveYValueTickers(
      transformed,
      spec,
      finalLayout.plotArea,
      theme,
      xDomain,
      yDomain
    ));
  }
  const backgroundPrimitives: Primitive[] = options.hoverOnly ? [] : encodeChartBackground(size, finalLayout.plotArea, theme);

  return {
    size,
    plotArea: finalLayout.plotArea,
    dataFocusAxis,
    ...(markLayout.dataWindow ? { dataWindow: markLayout.dataWindow } : {}),
    viewData: view.data,
    markLayout,
    backgroundPrimitives,
    framePrimitives,
    gridPrimitives,
    markPrimitives,
    axisPrimitives,
    axes: finalAxes,
    initialAxes,
    scene: {
      size,
      plotArea: finalLayout.plotArea,
      dataFocusAxis,
      ...(hover ? { hover } : {}),
      primitives: [
        ...backgroundPrimitives,
        ...framePrimitives,
        ...gridPrimitives,
        ...markPrimitives,
        ...axisPrimitives
      ]
    }
  };
}

function encodeLiveYValueTickers<TDatum>(
  data: readonly TDatum[],
  spec: PlotSpec<TDatum>,
  plotArea: Rect,
  theme: Theme,
  xDomain: readonly [number, number] | undefined,
  yDomain: readonly [number, number] | undefined
): readonly Primitive[] {
  if (!spec.liveYValueTicker || !xDomain || !yDomain || data.length === 0) {
    return [];
  }

  const xAccessor = spec.presetOptions?.x ?? "x";
  const yAccessor = spec.presetOptions?.y ?? "y";
  const seriesAccessor = spec.presetOptions?.series;
  const seriesOrder = Array.isArray(spec.presetOptions?.seriesOrder)
    ? spec.presetOptions.seriesOrder as readonly (string | number)[]
    : undefined;
  const latestBySeries = new Map<string | number, {
    datum: TDatum;
    dataIndex: number;
    seriesIndex: number;
    xValue: number;
    yValue: number;
  }>();
  const seriesIndexByKey = new Map<string | number, number>();

  if (seriesOrder) {
    seriesOrder.forEach((key, index) => {
      seriesIndexByKey.set(key, index);
    });
  }

  const expectedSeriesCount = seriesOrder?.length ?? (seriesAccessor === undefined ? 1 : 16);

  for (let index = data.length - 1; index >= 0; index -= 1) {
    const datum = data[index] as TDatum;
    const xValue = readDatumValue(xAccessor, datum, index);
    const yValue = readDatumValue(yAccessor, datum, index);

    if (!Number.isFinite(xValue) || !Number.isFinite(yValue)) {
      continue;
    }

    const rawSeriesKey = seriesAccessor === undefined
      ? "__default"
      : readDatumValue(seriesAccessor, datum, index);
    const seriesKey = typeof rawSeriesKey === "string" || typeof rawSeriesKey === "number"
      ? rawSeriesKey
      : String(rawSeriesKey);

    if (spec.hiddenSeries && (spec.hiddenSeries.has(seriesKey) || spec.hiddenSeries.has(String(seriesKey)))) {
      continue;
    }
    let seriesIndex = seriesIndexByKey.get(seriesKey);

    if (seriesIndex === undefined) {
      seriesIndex = seriesIndexByKey.size;
      seriesIndexByKey.set(seriesKey, seriesIndex);
    }

    if (!latestBySeries.has(seriesKey)) {
      latestBySeries.set(seriesKey, { datum, dataIndex: index, seriesIndex, xValue, yValue });
      if (latestBySeries.size >= expectedSeriesCount) {
        break;
      }
    }
  }

  const ySpan = yDomain[1] - yDomain[0] || 1;
  const xSpan = xDomain[1] - xDomain[0] || 1;
  const rightEdgeX = plotArea.x + plotArea.width;
  const font = `bold 9px ${SYSTEM_FONT_FAMILY}`;
  const badgeHeight = 16;
  const primitives: Primitive[] = [];
  const entries = [...latestBySeries.values()].sort((left, right) => left.seriesIndex - right.seriesIndex);
  const renderEntries: {
    seriesIndex: number;
    xPixel: number;
    yPixel: number;
    badgeY: number;
    badgeWidth: number;
    tickerText: string;
    color: string;
  }[] = [];

  for (const entry of entries) {
    const yPixel = plotArea.y + plotArea.height - ((entry.yValue - yDomain[0]) / ySpan) * plotArea.height;
    const xPixel = plotArea.x + ((entry.xValue - xDomain[0]) / xSpan) * plotArea.width;

    if (yPixel < plotArea.y || yPixel > plotArea.y + plotArea.height) {
      continue;
    }

    const color = resolveLiveTickerColor(spec, theme, entry.datum, entry.dataIndex, entry.seriesIndex, entry.yValue);
    const tickerText = formatLiveTickerValue(entry.yValue);
    const badgeWidth = Math.max(34, tickerText.length * 5.5 + 8);

    renderEntries.push({
      seriesIndex: entry.seriesIndex,
      xPixel,
      yPixel,
      badgeY: yPixel - badgeHeight / 2,
      badgeWidth,
      tickerText,
      color
    });
  }

  const adjustedEntries = resolveLiveTickerBadgeLayout(renderEntries, plotArea, badgeHeight);

  for (const entry of adjustedEntries) {
    if (entry.xPixel < rightEdgeX) {
      primitives.push({
        kind: "path",
        points: [[entry.xPixel, entry.yPixel], [rightEdgeX, entry.yPixel]],
        stroke: entry.color,
        strokeWidth: 1,
        strokeDash: [3, 3]
      });
    }

    const badgeX = rightEdgeX + 4;

    primitives.push({
      kind: "rect",
      x: badgeX,
      y: entry.badgeY,
      width: entry.badgeWidth,
      height: badgeHeight,
      fill: entry.color,
      cornerRadii: [3, 3, 3, 3]
    });

    primitives.push({
      kind: "text",
      x: badgeX + entry.badgeWidth / 2,
      y: entry.badgeY + badgeHeight / 2,
      text: entry.tickerText,
      fill: theme.palette.background ?? "#ffffff",
      font,
      align: "center",
      baseline: "middle"
    });
  }

  return primitives;
}


function resolveLiveTickerBadgeLayout<TEntry extends { yPixel: number; badgeY: number; seriesIndex: number }>(
  entries: readonly TEntry[],
  plotArea: Rect,
  badgeHeight: number
): TEntry[] {
  const sorted = [...entries].sort((left, right) => left.yPixel - right.yPixel || left.seriesIndex - right.seriesIndex);
  const gap = 2;
  const minY = plotArea.y;
  const maxY = plotArea.y + plotArea.height - badgeHeight;

  for (let index = 0; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index] as TEntry;
    current.badgeY = clampNumber(current.badgeY, minY, maxY);

    if (previous && current.badgeY < previous.badgeY + badgeHeight + gap) {
      current.badgeY = previous.badgeY + badgeHeight + gap;
    }
  }

  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const next = sorted[index + 1];
    const current = sorted[index] as TEntry;
    current.badgeY = clampNumber(current.badgeY, minY, maxY);

    if (next && current.badgeY > next.badgeY - badgeHeight - gap) {
      current.badgeY = next.badgeY - badgeHeight - gap;
    }
  }

  return sorted.sort((left, right) => left.seriesIndex - right.seriesIndex);
}

function readDatumValue<TDatum>(
  accessor: unknown,
  datum: TDatum,
  index: number
): any {
  if (typeof accessor === "function") {
    return accessor(datum, index);
  }

  if (typeof accessor === "string" || typeof accessor === "number") {
    return (datum as any)[accessor];
  }

  return undefined;
}

function resolveLiveTickerColor<TDatum>(
  spec: PlotSpec<TDatum>,
  theme: Theme,
  datum: TDatum,
  index: number,
  seriesIndex: number,
  yValue: number
): string {
  const signedStrokes = spec.presetOptions?.signedStrokes;
  if (signedStrokes && typeof signedStrokes === "object") {
    return yValue < 0
      ? signedStrokes.negative ?? theme.palette.foreground
      : signedStrokes.positive ?? theme.palette.foreground;
  }

  const strokes = spec.presetOptions?.strokes;
  if (Array.isArray(strokes) && strokes[seriesIndex]) {
    return strokes[seriesIndex] as string;
  }

  const stroke = spec.presetOptions?.stroke;
  if (typeof stroke === "function") {
    const resolved = stroke(datum, index);
    if (typeof resolved === "string") {
      return resolved;
    }
  } else if (typeof stroke === "string" && spec.presetOptions?.series === undefined) {
    return stroke;
  }

  return theme.palette.series[seriesIndex % Math.max(1, theme.palette.series.length)] ?? theme.palette.foreground;
}

function formatLiveTickerValue(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 100 || Number.isInteger(value)) {
    return value.toFixed(0);
  }

  if (abs >= 10) {
    return value.toFixed(1);
  }

  return value.toFixed(2);
}

function resolveSceneEdgeBlur<TDatum>(
  spec: PlotSpec<TDatum>,
  theme: Theme,
  focus: PlotSelection | undefined,
  dataFocusAxis: "x" | "y",
  dataWindow: Layout["dataWindow"] | undefined
) {
  const edges = resolvePlotEdgeBlur(
    spec,
    focus,
    dataFocusAxis,
    dataWindow,
    resolveMarkKinds(spec)
  );

  if (!edges) {
    return undefined;
  }

  return {
    ...edges,
    color: theme.palette.background,
    size: resolveEdgeBlurSize(spec)
  };
}

function approachFade(current: number, target: number, step: number): number {
  if (step <= 0 || current === target) {
    return target;
  }

  if (current < target) {
    return Math.min(target, current + step);
  }

  return Math.max(target, current - step);
}

function resolveFocusMode<TDatum>(spec: PlotSpec<TDatum>): FocusMode {
  if (spec.interactions === false) {
    return "index";
  }

  return spec.interactions?.focusMode ?? "domain";
}

function shouldFadeStreamingAxisEdge<TDatum>(
  spec: PlotSpec<TDatum>,
  focus: PlotSelection | undefined
): boolean {
  return spec.streaming === true && focus !== undefined;
}

function resolveDataFocusAxis(axes: AxesSpec | undefined): "x" | "y" {
  return axes?.y?.kind === "band" && axes.x?.kind === "linear" ? "y" : "x";
}

function isBandFocusAxis(axes: AxesSpec | undefined, axis: "x" | "y"): boolean {
  return axes?.[axis]?.kind === "band";
}

function applyPlotTimeZone(
  axes: AxesSpec | undefined,
  timeZone: PlotSpec["timeZone"]
): AxesSpec | undefined {
  if (!axes || !timeZone) {
    return axes;
  }

  return {
    ...axes,
    ...(axes.x?.timeGranularity ? { x: { ...axes.x, timeZone: axes.x.timeZone ?? timeZone } } : {}),
    ...(axes.y?.timeGranularity ? { y: { ...axes.y, timeZone: axes.y.timeZone ?? timeZone } } : {})
  };
}

function resolveLayoutYDomain(axes: AxesSpec | undefined): readonly [number, number] | undefined {
  return axes?.y?.kind === "linear" ? axes.y.scaleDomain ?? axes.y.domain : undefined;
}

function resolveLayoutXDomain(axes: AxesSpec | undefined): readonly [number, number] | undefined {
  return axes?.x?.kind === "linear" ? axes.x.scaleDomain ?? axes.x.domain : undefined;
}

function resolveDataInput<TDatum>(
  data: DataInput<TDatum>,
  request: DataSourceResolveRequest
): { data: readonly TDatum[]; source: boolean; domain?: DataSourceView<TDatum>["domain"] } {
  if (isDataSource(data)) {
    const view = data.resolve(request);
    const domain = view.domain && request.xDomain
      ? { ...view.domain, visibleX: request.xDomain }
      : view.domain;

    return {
      data: view.data,
      source: true,
      ...(domain ? { domain } : {})
    };
  }

  return {
    data,
    source: false
  };
}

function applyDataSourceAxisDomain<TDatum>(
  axes: AxesSpec | undefined,
  domain: DataSourceView<TDatum>["domain"] | undefined
): AxesSpec | undefined {
  if (!axes || !domain) {
    return axes;
  }

  let nextAxes = axes;

  if (axes.x?.kind === "band") {
    nextAxes = {
      ...nextAxes,
      x: patchDataSourceBandAxis(axes.x, domain)
    };
  } else if (axes.x?.kind === "linear" && domain.visibleX) {
    nextAxes = {
      ...nextAxes,
      x: {
        ...axes.x,
        domain: domain.visibleX,
        scaleDomain: domain.visibleX,
        nice: false,
        ...(domain.timeHasSubMinutePrecision ? { timeHasSubMinutePrecision: true } : {})
      }
    };
  }

  if (axes.y?.kind === "band") {
    nextAxes = {
      ...nextAxes,
      y: patchDataSourceBandAxis(axes.y, domain)
    };
  }

  return nextAxes;
}

function applyVirtualBandAxisDomain(
  axes: AxesSpec | undefined,
  virtual: {
    axis: "x" | "y";
    visibleStart: number;
    visibleEnd: number;
  } | undefined
): AxesSpec | undefined {
  if (!axes || !virtual) {
    return axes;
  }

  const axis = axes[virtual.axis];

  if (!axis || axis.kind !== "band") {
    return axes;
  }

  return {
    ...axes,
    [virtual.axis]: {
      ...axis,
      visibleBandRange: [virtual.visibleStart, virtual.visibleEnd]
    }
  };
}

function patchDataSourceBandAxis(
  axis: Extract<AxisSpec, { kind: "band" }>,
  domain: NonNullable<DataSourceView["domain"]>
): Extract<AxisSpec, { kind: "band" }> {
  const isNumeric = resolveDataSourceBandAxisNumeric(axis, domain);

  return {
    ...axis,
    ...(isNumeric ? { labels: [String(domain.x[0]), String(domain.x[1])] } : {}),
    count: Math.max(1, domain.endIndex - domain.startIndex),
    numericDomain: [domain.startIndex + 1, domain.endIndex],
    visibleBandRange: [domain.visibleStart, domain.visibleEnd],
    startIndex: domain.startIndex,
    numeric: isNumeric,
    ...(axis.timeGranularity && domain.visibleX ? { timeDomain: domain.visibleX } : {}),
    ...(domain.timeHasSubMinutePrecision ? { timeHasSubMinutePrecision: true } : {})
  };
}

function resolveDataSourceBandAxisNumeric(
  axis: Extract<AxisSpec, { kind: "band" }>,
  domain: NonNullable<DataSourceView["domain"]>
): boolean {
  if (axis.numeric !== undefined) {
    return axis.numeric;
  }

  if (axis.labels.length === 0) {
    return Number.isFinite(domain.x[0]) && Number.isFinite(domain.x[1]);
  }

  if (axis.numericDomain) {
    return Number.isFinite(axis.numericDomain[0]) && Number.isFinite(axis.numericDomain[1]);
  }

  return axis.labels.every((label) => Number.isFinite(Number(label)));
}

function applySelectionAxisDomain(
  axes: AxesSpec | undefined,
  focus: PlotSelection | undefined,
  focusMode: FocusMode,
  skipX = false
): AxesSpec | undefined {
  if (!axes || !focus) {
    return axes;
  }

  let nextAxes = axes;

  if (!skipX && focusMode === "domain" && axes.x?.kind === "linear" && focus.x) {
    nextAxes = narrowLinearAxisDomain(nextAxes, "x", focus.x) ?? nextAxes;
  }

  if (axes.y?.kind === "linear" && focus.y) {
    nextAxes = narrowLinearAxisDomain(nextAxes, "y", focus.y) ?? nextAxes;
  }

  return nextAxes;
}

function narrowLinearAxisDomain(
  axes: AxesSpec,
  axisKey: "x" | "y",
  focusRange: readonly [number, number]
): AxesSpec | undefined {
  const axis = axes[axisKey];

  if (!axis || axis.kind !== "linear") {
    return axes;
  }

  const [rawStart, rawEnd] = focusRange;
  const start = clamp01(Math.min(rawStart, rawEnd));
  const end = clamp01(Math.max(rawStart, rawEnd));

  if (end - start >= 0.999) {
    return axes;
  }

  const [min, max] = axis.domain;
  const span = max - min;

  if (!Number.isFinite(span) || span <= 0) {
    return axes;
  }

  return {
    ...axes,
    [axisKey]: {
      ...axis,
      domain: [
        min + span * start,
        min + span * end
      ],
      baseDomain: axis.baseDomain ?? axis.domain,
      nice: false
    }
  };
}

function isDataSource<TDatum>(data: DataInput<TDatum>): data is Extract<DataInput<TDatum>, { kind: "data-source" }> {
  return typeof data === "object" && data !== null && "kind" in data && data.kind === "data-source";
}

function shouldInvalidateBaseAxesOnDataChange<TDatum>(spec: PlotSpec<TDatum>): boolean {
  if (typeof spec.axes !== "function") {
    return false;
  }

  const presetOptions = spec.presetOptions as { xDomain?: unknown; yDomain?: unknown; domainMin?: unknown; domainMax?: unknown } | undefined;

  if (presetOptions?.xDomain !== undefined || presetOptions?.yDomain !== undefined || presetOptions?.domainMin !== undefined || presetOptions?.domainMax !== undefined) {
    return false;
  }

  return true;
}

function patchOrInvalidateBaseAxesOnDataChange<TDatum>(
  spec: PlotSpec<TDatum>,
  data: DataInput<TDatum>,
  getCachedBaseAxes: () => { data: readonly TDatum[]; axes: AxesSpec } | undefined,
  setCachedBaseAxes: (next: { data: readonly TDatum[]; axes: AxesSpec } | undefined) => void
): void {
  if (!shouldInvalidateBaseAxesOnDataChange(spec)) {
    return;
  }

  const cached = getCachedBaseAxes();
  const xExtent = resolveDataSourceXExtent(data);
  const yExtent = resolveDataSourceYExtent(data);

  if (cached && xExtent && yExtent) {
    const patched = patchCachedBaseAxesFromSource(
      data,
      cached,
      setCachedBaseAxes,
      hasHiddenSeries(spec)
    );

    if (patched) {
      setCachedBaseAxes(patched);
      return;
    }
  }

  setCachedBaseAxes(undefined);
}

function hasHiddenSeries<TDatum>(spec: PlotSpec<TDatum>): boolean {
  return spec.hiddenSeries !== undefined && spec.hiddenSeries.size > 0;
}

function canUseLineStreamingFastPath<TDatum>(cache: RenderCache, plotSpec: PlotSpec<TDatum>): boolean {
  if (!cache.baseAxes) {
    return false;
  }

  if (!isDataSource(plotSpec.data)) {
    return false;
  }

  if (!resolveDataSourceXExtent(plotSpec.data) || !resolveDataSourceYExtent(plotSpec.data)) {
    return false;
  }

  if (plotSpec.marks.length !== 1 || plotSpec.marks[0]?.kind !== "line") {
    return false;
  }

  return cache.markPrimitives.some((primitive) => primitive.kind === "path");
}

function resolveVisibleLineYDomain<TDatum>(
  spec: PlotSpec<TDatum>,
  data: readonly TDatum[],
  xDomain: readonly [number, number] | undefined
): readonly [number, number] | undefined {
  const yAccessor = spec.presetOptions?.y ?? "y";
  const xAccessor = spec.presetOptions?.x ?? "x";
  const seriesAccessor = spec.presetOptions?.series;
  const sourceExtent = resolveDataSourceVisibleYExtent(spec, xAccessor, yAccessor, seriesAccessor, xDomain);
  if (sourceExtent) {
    return resolvePaddedYDomain(sourceExtent[0], sourceExtent[1]);
  }

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let found = false;

  for (let index = 0; index < data.length; index += 1) {
    const datum = data[index] as TDatum;

    if (xDomain) {
      const rawX = readDatumValue(xAccessor, datum, index);
      const x = rawX instanceof Date ? rawX.getTime() : Number(rawX);
      if (!Number.isFinite(x) || x < xDomain[0] || x > xDomain[1]) {
        continue;
      }
    }

    if (seriesAccessor && spec.hiddenSeries) {
      const rawKey = readDatumValue(seriesAccessor, datum, index);
      const key = typeof rawKey === "string" || typeof rawKey === "number" ? rawKey : String(rawKey);
      if (spec.hiddenSeries.has(key) || spec.hiddenSeries.has(String(key))) {
        continue;
      }
    }

    const yExtent = resolveDatumYExtent(datum, yAccessor, index);
    if (!yExtent) {
      continue;
    }

    min = Math.min(min, yExtent[0]);
    max = Math.max(max, yExtent[1]);
    found = true;
  }

  if (!found) {
    return undefined;
  }

  return resolvePaddedYDomain(min, max);
}

function resolveVisibleYDomainForFocus<TDatum>(
  spec: PlotSpec<TDatum>,
  data: readonly TDatum[],
  xDomain: readonly [number, number] | undefined,
  focus: PlotSelection | undefined,
  focusAxis: "x" | "y" | undefined
): readonly [number, number] | undefined {
  if (xDomain) {
    return resolveVisibleLineYDomain(spec, data, xDomain);
  }

  const focused = applySelectionFocus(data, focus, false, focusAxis ?? "x");
  return resolveVisibleLineYDomain(spec, focused.axisData, undefined);
}

function resolveDataSourceVisibleYExtent<TDatum>(
  spec: PlotSpec<TDatum>,
  xAccessor: unknown,
  yAccessor: unknown,
  seriesAccessor: unknown,
  xDomain: readonly [number, number] | undefined
): readonly [number, number] | undefined {
  if (
    !xDomain ||
    !isDataSource(spec.data) ||
    typeof spec.data.yExtentForXDomain !== "function" ||
    spec.transforms?.length ||
    xAccessor !== "x" ||
    yAccessor !== "y" ||
    (seriesAccessor !== undefined && seriesAccessor !== "series")
  ) {
    return undefined;
  }

  return spec.data.yExtentForXDomain(xDomain, spec.hiddenSeries);
}

function resolvePaddedYDomain(
  min: number,
  max: number
): readonly [number, number] | undefined {
  const dataSpan = max - min;
  if (!Number.isFinite(dataSpan) || dataSpan <= 0) {
    return niceLinearDomain(min - 0.5, min + 0.5);
  }

  const standardPadTop = dataSpan * 0.18;
  const standardPadBottom = dataSpan * 0.05;
  const tempMin = min - standardPadBottom;
  const tempMax = max + standardPadTop;
  return niceLinearDomain(
    min >= 0 ? Math.max(0, tempMin) : tempMin,
    max <= 0 ? Math.min(0, tempMax) : tempMax
  );
}

function resolveDatumYExtent<TDatum>(
  datum: TDatum,
  yAccessor: Accessor<TDatum, number>,
  index: number
): readonly [number, number] | undefined {
  const maybeBucket = datum as { minY?: unknown; maxY?: unknown };
  const minY = Number(maybeBucket.minY);
  const maxY = Number(maybeBucket.maxY);

  if (Number.isFinite(minY) && Number.isFinite(maxY)) {
    return minY <= maxY ? [minY, maxY] : [maxY, minY];
  }

  const value = Number(readDatumValue(yAccessor, datum, index));
  return Number.isFinite(value) ? [value, value] : undefined;
}

type AppendableData<TDatum> = {
  append?(datum: TDatum): void;
  appendBatch?(data: readonly TDatum[]): void;
  appendIterable?(data: Iterable<TDatum>): void;
};

type ClearableData = {
  clear?(): void;
};

function appendToSpecData<TDatum>(data: DataInput<TDatum>, nextData: TDatum | readonly TDatum[] | Iterable<TDatum>): boolean {
  if (!isDataSource(data)) {
    return false;
  }

  const source = data as Extract<DataInput<TDatum>, { kind: "data-source" }> & AppendableData<TDatum>;

  if (source.appendBatch && Array.isArray(nextData)) {
    source.appendBatch(nextData);
    return true;
  }

  if (source.appendIterable && isIterableAppendInput(nextData)) {
    source.appendIterable(nextData);
    return true;
  }

  if (source.append) {
    source.append(nextData as TDatum);
    return true;
  }

  return false;
}

function clearSpecData<TDatum>(data: DataInput<TDatum>): boolean {
  if (!isDataSource(data)) {
    return false;
  }

  const source = data as Extract<DataInput<TDatum>, { kind: "data-source" }> & ClearableData;

  if (!source.clear) {
    return false;
  }

  source.clear();
  return true;
}

function isIterableAppendInput<TDatum>(value: TDatum | readonly TDatum[] | Iterable<TDatum>): value is readonly TDatum[] | Iterable<TDatum> {
  return typeof value === "object" && value !== null && Symbol.iterator in value;
}

function resolveRenderOptimization(optimization: RenderOptimizationSpec | false | undefined): Required<RenderOptimizationSpec> {
  if (optimization === false) {
    return {
      enabled: false,
      minDensity: 1.5,
      lineSamplesPerPixel: 2,
      pointCellSize: 8
    };
  }

  return {
    enabled: optimization?.enabled ?? true,
    minDensity: optimization?.minDensity ?? 1.5,
    lineSamplesPerPixel: optimization?.lineSamplesPerPixel ?? 2,
    pointCellSize: optimization?.pointCellSize ?? 8
  };
}

function dashboardResizePreviewEnabled<TDatum>(spec: PlotSpec<TDatum>): boolean {
  return spec.dashboardResizePreview === true;
}

function isPointCloudResizePaintSlot(time: number, phase: number): boolean {
  if (time !== pointCloudResizeFrameTime) {
    pointCloudResizeFrameTime = time;
    pointCloudResizeFramePhase = (pointCloudResizeFramePhase + 1) % 2;
  }
  return phase === pointCloudResizeFramePhase;
}

function applySelectionFocus<TDatum>(
  data: readonly TDatum[],
  focus: PlotSelection | undefined,
  smooth: boolean,
  axis: "x" | "y"
): {
  data: readonly TDatum[];
  axisData: readonly TDatum[];
  virtual?: {
    axis: "x" | "y";
    offsetRatio: number;
    widthScale: number;
    visibleStart: number;
    visibleEnd: number;
  };
} {
  const range = axis === "y" ? focus?.y : focus?.x;

  if (!range || data.length <= 1) {
    return { data, axisData: data };
  }

  const [rawStart, rawEnd] = range;
  const start = clamp01(Math.min(rawStart, rawEnd));
  const end = clamp01(Math.max(rawStart, rawEnd));

  if (end - start >= 0.999) {
    return { data, axisData: data };
  }

  const startIndex = start * data.length;
  const endIndex = end * data.length;
  const first = Math.max(0, Math.min(data.length - 1, Math.floor(startIndex)));
  const lastExclusive = Math.max(first + 1, Math.min(data.length, Math.ceil(endIndex)));
  const axisData = data.slice(first, lastExclusive);

  if (!smooth) {
    return {
      data: axisData,
      axisData
    };
  }

  const renderFirst = Math.max(0, first - 2);
  const renderLastExclusive = Math.min(data.length, lastExclusive + 2);
  const renderData = data.slice(renderFirst, renderLastExclusive);
  const visibleSpan = Math.max(Number.EPSILON, endIndex - startIndex);
  const renderSpan = renderLastExclusive - renderFirst;

  return {
    data: renderData,
    axisData,
    virtual: {
      axis,
      offsetRatio: -((startIndex - renderFirst) / visibleSpan),
      widthScale: renderSpan / visibleSpan,
      visibleStart: startIndex,
      visibleEnd: endIndex
    }
  };
}

function isFocusDifferent(a: PlotSelection | undefined, b: PlotSelection | undefined): boolean {
  if (!a && !b) return false;
  if (!a || !b) return true;
  const aX = a.x ?? [0, 1];
  const aY = a.y ?? [0, 1];
  const bX = b.x ?? [0, 1];
  const bY = b.y ?? [0, 1];
  const EPSILON = 1e-9;
  return (
    Math.abs(aX[0] - bX[0]) > EPSILON ||
    Math.abs(aX[1] - bX[1]) > EPSILON ||
    Math.abs(aY[0] - bY[0]) > EPSILON ||
    Math.abs(aY[1] - bY[1]) > EPSILON
  );
}



function zoomSelectionFocus(
  current: PlotSelection | undefined,
  center: number,
  scale: number,
  minSpan: number,
  axis: "x" | "y" = "x"
): PlotSelection | undefined {
  const range = (axis === "y" ? current?.y : current?.x) ?? [0, 1];
  const start = clamp01(Math.min(range[0], range[1]));
  const end = clamp01(Math.max(range[0], range[1]));
  const span = Math.max(Number.EPSILON, end - start);
  const nextSpan = Math.max(minSpan, Math.min(1, span * scale));

  if (nextSpan >= 0.999) {
    if (axis === "y") {
      return current?.x ? { x: current.x } : undefined;
    }

    return zoomYSelectionFocus(current, scale);
  }

  const anchoredValue = start + span * clamp01(center);
  let nextStart = anchoredValue - nextSpan * clamp01(center);
  let nextEnd = nextStart + nextSpan;

  if (nextStart < 0) {
    nextEnd -= nextStart;
    nextStart = 0;
  }

  if (nextEnd > 1) {
    nextStart -= nextEnd - 1;
    nextEnd = 1;
  }

  return withPreservedOtherAxis(current, axis, [clamp01(nextStart), clamp01(nextEnd)]);
}

function resolveZoomMinSpan<TDatum>(data: DataInput<TDatum>, configured: number, minPoints = 2): number {
  const length = isDataSource(data) ? data.length : data.length;

  if (!length || length <= 1) {
    return configured;
  }

  return Math.max(configured, Math.max(1, minPoints) / length);
}

function resolveAxisZoomMinSpan(_axis: AxisSpec | undefined, configured: number): number {
  return configured;
}

function panSelectionFocus(
  current: PlotSelection | undefined,
  delta: number,
  _initialSpan = 1,
  axis: "x" | "y" = "x"
): PlotSelection | undefined {
  const currentRange = axis === "y" ? current?.y : current?.x;

  if (!currentRange) {
    return current;
  }

  const start = clamp01(Math.min(currentRange[0], currentRange[1]));
  const end = clamp01(Math.max(currentRange[0], currentRange[1]));
  const span = end - start;

  if (span <= 0 || span >= 0.999) {
    return current;
  }

  const maxStart = 1 - span;
  const nextStart = Math.max(0, Math.min(maxStart, start + delta * span));

  return withPreservedOtherAxis(current, axis, [nextStart, nextStart + span]);
}

function withPreservedOtherAxis(
  current: PlotSelection | undefined,
  axis: "x" | "y",
  range: readonly [number, number]
): PlotSelection {
  return axis === "y"
    ? { ...(current?.x ? { x: current.x } : {}), y: range }
    : { x: range, ...(current?.y ? { y: current.y } : {}) };
}

function resolvePanInitialSpan<TDatum>(data: DataInput<TDatum>): number {
  const length = isDataSource(data) ? data.length : data.length;

  if (!length || length <= 1) {
    return 1;
  }

  return Math.max(0.02, Math.min(1, 120 / length));
}


function zoomYSelectionFocus(
  current: PlotSelection | undefined,
  scale: number
): PlotSelection | undefined {
  if (!current?.y) {
    return undefined;
  }

  const start = clamp01(Math.min(current.y[0], current.y[1]));
  const end = clamp01(Math.max(current.y[0], current.y[1]));
  const span = Math.max(Number.EPSILON, end - start);
  const nextSpan = Math.min(1, span * scale);

  if (nextSpan >= 0.999) {
    return undefined;
  }

  const center = (start + end) / 2;
  let nextStart = center - nextSpan / 2;
  let nextEnd = nextStart + nextSpan;

  if (nextStart < 0) {
    nextEnd -= nextStart;
    nextStart = 0;
  }

  if (nextEnd > 1) {
    nextStart -= nextEnd - 1;
    nextEnd = 1;
  }

  return {
    y: [clamp01(nextStart), clamp01(nextEnd)]
  };
}



function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.max(min, Math.min(max, value));
}

function preserveInteractionOptions(value: any): any {
  return value && typeof value === "object" ? value : {};
}

function updateMenuScrollability(content: HTMLElement | null): void {
  if (!content) {
    return;
  }

  requestAnimationFrame(() => {
    const hasOverflow = content.scrollHeight > content.clientHeight + 1;
    content.classList.toggle("no-scroll", !hasOverflow);
  });
}

function preventMenuOverscroll(event: WheelEvent): void {
  const element = event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined;
  if (!element) {
    return;
  }

  event.stopPropagation();
  const maxScrollTop = element.scrollHeight - element.clientHeight;
  if (maxScrollTop <= 1) {
    element.scrollTop = 0;
    event.preventDefault();
    return;
  }

  const scrollingUp = event.deltaY < 0;
  const scrollingDown = event.deltaY > 0;
  const atTop = element.scrollTop <= 0;
  const atBottom = element.scrollTop >= maxScrollTop - 1;

  if ((scrollingUp && atTop) || (scrollingDown && atBottom)) {
    element.scrollTop = atTop ? 0 : maxScrollTop;
    event.preventDefault();
  }
}

function clampMenuScroll(event: Event): void {
  const element = event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined;
  if (!element) {
    return;
  }

  const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
  if (element.scrollTop < 0) {
    element.scrollTop = 0;
  } else if (element.scrollTop > maxScrollTop) {
    element.scrollTop = maxScrollTop;
  }
}

function resolveFullscreenTarget(container: HTMLElement): HTMLElement {
  const parent = container.parentElement;

  if (
    parent instanceof HTMLElement &&
    (
      parent.classList.contains("plot-container") ||
      parent.classList.contains("hero-chart-container") ||
      parent.classList.contains("tile-chart-container") ||
      parent.querySelector(":scope > .resize-handle") !== null ||
      parent.querySelector(":scope > .tile-resize-handle") !== null
    )
  ) {
    return parent;
  }

  return container;
}

function setFullscreenClass(element: Element | null, enabled: boolean): void {
  if (element instanceof HTMLElement) {
    element.classList.toggle("plot-fullscreen-target", enabled);
  }
}

function updateFullscreenButtonLabel(popover: HTMLElement, fullscreenTarget: HTMLElement): void {
  const button = popover.querySelector<HTMLButtonElement>("#set-btn-fullscreen");
  if (button) {
    button.textContent = popover.ownerDocument.fullscreenElement === fullscreenTarget
      ? "Exit Fullscreen"
      : "Fullscreen";
  }
}

function toggleFullscreen(element: Element | null): void {
  if (!element || !element.ownerDocument.fullscreenEnabled) {
    return;
  }

  if (element.ownerDocument.fullscreenElement === element) {
    void element.ownerDocument.exitFullscreen();
    return;
  }

  setFullscreenClass(element, true);
  void element.requestFullscreen().catch(() => {
    setFullscreenClass(element, false);
  });
}

function resolveScatterHoverInteraction<TDatum>(spec: PlotSpec<TDatum>): ScatterHoverInteraction {
  if (spec.interactions === false) {
    return "crosshair";
  }

  const setting = spec.interactions?.scatterHover;

  if (setting === false || setting === "none") {
    return "none";
  }

  return setting ?? "crosshair";
}

function readSize<TDatum>(container: Element, spec: PlotSpec<TDatum>): Size {
  // Avoid the forced synchronous layout (getBoundingClientRect) when the spec
  // already pins both dimensions — this is the common path during an explicit
  // resize drag and measuring would needlessly thrash layout every frame.
  if (spec.width !== undefined && spec.height !== undefined) {
    return { width: Math.max(1, spec.width), height: Math.max(1, spec.height) };
  }

  const bounds = container.getBoundingClientRect();

  return {
    width: spec.width ?? Math.max(1, bounds.width || 640),
    height: spec.height ?? Math.max(1, bounds.height || 360)
  };
}

function composeSelectionFocus(current: PlotSelection | undefined, next: PlotSelection): PlotSelection {
  const selection: PlotSelection = {};

  if (next.x) {
    selection.x = composeRange(current?.x, next.x);
  }

  if (next.y) {
    selection.y = composeRange(current?.y, next.y);
  } else if (current?.y) {
    selection.y = current.y;
  }

  return selection;
}

function composeRange(
  current: readonly [number, number] | undefined,
  next: readonly [number, number]
): readonly [number, number] {
  if (!current) {
    return next;
  }

  const start = Math.min(current[0], current[1]);
  const end = Math.max(current[0], current[1]);
  const span = end - start;

  return [
    start + span * Math.min(next[0], next[1]),
    start + span * Math.max(next[0], next[1])
  ];
}

function isStreamingActive(lastDataUpdateTime: number): boolean {
  return (performance.now() - lastDataUpdateTime) < STREAMING_ACTIVE_MS;
}

function resolveDataSourceYExtent(data: unknown): readonly [number, number] | undefined {
  if (typeof data !== "object" || data === null || !("yExtent" in data)) {
    return undefined;
  }

  const extent = (data as { yExtent?: readonly [number, number] }).yExtent;

  if (!extent || !Number.isFinite(extent[0]) || !Number.isFinite(extent[1])) {
    return undefined;
  }

  return extent;
}

function resolveDataSourceXExtent(data: unknown): readonly [number, number] | undefined {
  if (typeof data !== "object" || data === null || !("xExtent" in data)) {
    return undefined;
  }

  const extent = (data as { xExtent?: readonly [number, number] }).xExtent;

  if (!extent || !Number.isFinite(extent[0]) || !Number.isFinite(extent[1])) {
    return undefined;
  }

  return extent;
}

function patchAxesXFromExtent(axes: AxesSpec, extent: readonly [number, number]): AxesSpec {
  if (axes.x?.kind !== "linear") {
    return axes;
  }

  return {
    ...axes,
    x: {
      ...axes.x,
      domain: extent
    }
  };
}

function patchAxesYFromExtent(axes: AxesSpec, extent: readonly [number, number]): AxesSpec {
  if (axes.y?.kind !== "linear") {
    return axes;
  }

  const domain = niceLinearDomain(
    Math.min(0, extent[0]),
    Math.max(0, extent[1])
  );

  return {
    ...axes,
    y: {
      ...axes.y,
      domain
    }
  };
}

function patchCachedBaseAxesFromSource<TDatum>(
  data: DataInput<TDatum>,
  cached: { data: readonly TDatum[]; axes: AxesSpec } | undefined,
  setCachedBaseAxes?: (next: { data: readonly TDatum[]; axes: AxesSpec }) => void,
  skipYPatch = false
): { data: readonly TDatum[]; axes: AxesSpec } | undefined {
  if (!cached) {
    return cached;
  }

  const yExtent = resolveDataSourceYExtent(data);
  const xExtent = resolveDataSourceXExtent(data);

  if (!yExtent && !xExtent) {
    return cached;
  }

  let patchedAxes = cached.axes;

  if (xExtent) {
    patchedAxes = patchAxesXFromExtent(patchedAxes, xExtent);
  }

  if (yExtent && !skipYPatch) {
    patchedAxes = patchAxesYFromExtent(patchedAxes, yExtent);
  }

  if (patchedAxes === cached.axes) {
    return cached;
  }

  const next = { ...cached, axes: patchedAxes };

  if (isDataSource(data)) {
    (next as { version?: number }).version = data.version;
  }

  setCachedBaseAxes?.(next);
  return next;
}
