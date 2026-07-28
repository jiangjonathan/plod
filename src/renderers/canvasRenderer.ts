import type { Primitive, ResizePreviewTransform, SceneGraph } from "../core/types";
import { drawCanvasPrimitive } from "./canvasPrimitives";
import { drawPlotEdgeBlur } from "./edgeBlur";
import {
  destroyPointCloudGLResources,
  prunePointCloudGLBuffers,
  ensurePointCloudGLResources as ensureGLResources,
  resolveWebGLViewport,
  type PointCloudGLResources,
} from "./pointCloudWebGL";
import { drawScatterSceneHover } from "./scatterHover";
import type { Renderer, RenderSurface } from "./types";

let isolatedAreaLayerCanvas: HTMLCanvasElement | undefined;
let isolatedAreaLayerContext: CanvasRenderingContext2D | undefined;

type PlotResizeSnapshot = {
  canvas: HTMLCanvasElement;
  source: { x: number; y: number; width: number; height: number };
};

type CanvasSurface = RenderSurface & {
  element: HTMLCanvasElement;
  transitionElement: HTMLCanvasElement;
  hoverElement: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  transitionContext: CanvasRenderingContext2D;
  hoverContext: CanvasRenderingContext2D;
  glElement?: HTMLCanvasElement;
  gl?: WebGLRenderingContext;
  resizeTransitionFrame?: number;
  plotResizeSnapshot?: PlotResizeSnapshot;
  resizeTransitionSnapshot?: PlotResizeSnapshot;
  glResources?: PointCloudGLResources;
  lastWidth?: number;
  lastHeight?: number;
  lastPixelRatio?: number;
  lastHoverWidth?: number;
  lastHoverHeight?: number;
  lastHoverPixelRatio?: number;
  lastAlignLeft?: number;
  lastAlignTop?: number;
  lastAlignDisplayWidth?: number;
  lastAlignDisplayHeight?: number;
  resizeArtifactsCleared?: boolean;
};

export function canvasRenderer(): Renderer<CanvasSurface> {
  return {
    mount(container) {
      const canvas = document.createElement("canvas");
      const transitionCanvas = document.createElement("canvas");
      const hoverCanvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      const transitionContext = transitionCanvas.getContext("2d");
      const hoverContext = hoverCanvas.getContext("2d");

      if (!context || !transitionContext || !hoverContext) {
        throw new Error("Canvas 2D context is unavailable.");
      }

      if (container instanceof HTMLElement && getComputedStyle(container).position === "static") {
        container.style.position = "relative";
      }

      canvas.style.display = "block";

      transitionCanvas.style.position = "absolute";
      transitionCanvas.style.left = "0";
      transitionCanvas.style.top = "0";
      transitionCanvas.style.pointerEvents = "none";
      transitionCanvas.style.display = "none";

      hoverCanvas.style.position = "absolute";
      hoverCanvas.style.left = "0";
      hoverCanvas.style.top = "0";
      hoverCanvas.style.pointerEvents = "none";

      container.append(canvas, transitionCanvas, hoverCanvas);

      return {
        element: canvas,
        transitionElement: transitionCanvas,
        hoverElement: hoverCanvas,
        context,
        transitionContext,
        hoverContext
      };
    },
    render(surface, scene) {
      if (scene.resizePreview?.compositorOnly) {
        resizeCanvasCssOnly(surface, scene);
        return;
      }

      const usesPointCloud = sceneHasPointCloud(scene);
      const activeResize = scene.resizePreview !== undefined || scene.growOnlyCanvas === true;
      const deferPointCloudDraw = usesPointCloud && scene.deferPointCloudDraw === true;
      // A retained GL backing store must never be CSS-scaled during a resize:
      // doing so turns fixed-size point sprites into ellipses when only one
      // chart dimension shrinks. The live path only changes viewport/uniforms
      // and reuses every point buffer.
      const liveWebGLResize = scene.liveWebGLResize === true || (usesPointCloud && activeResize);
      const resizeSnapshot = (scene.resizePreview || scene.resizeTransition) && scene.resizeSnapshotRange
        ? surface.plotResizeSnapshot
        : undefined;
      const hideGLForSnapshot = Boolean(resizeSnapshot && scene.resizePreview);

      if (usesPointCloud) {
        ensureGLSurface(surface);
      } else {
        disableGLSurface(surface);
      }
      resizeCanvasSurface(surface, scene, {
        growOnly: scene.resizePreview?.growOnlyCanvas === true || scene.growOnlyCanvas === true,
        snap: 32,
        resizeGL: usesPointCloud && !deferPointCloudDraw,
        liveWebGLResize
      });
      const hoverCssWidth = `${Math.max(1, scene.size.width)}px`;
      const hoverCssHeight = `${Math.max(1, scene.size.height)}px`;
      const hoverDisplaySizeChanged =
        surface.hoverElement.style.width !== hoverCssWidth ||
        surface.hoverElement.style.height !== hoverCssHeight;
      setElementCssSize(surface.hoverElement, hoverCssWidth, hoverCssHeight);
      if (deferPointCloudDraw && activeResize) {
        retainWebGLResizeSurface(surface, scene);
      }
      // Overlay canvases share the host origin; skip forced layout reads mid-drag.
      if (!activeResize) {
        surface.resizeArtifactsCleared = false;
        alignOverlayCanvases(surface, scene);
        if (hoverDisplaySizeChanged) {
          surface.hoverContext.setTransform(1, 0, 0, 1, 0, 0);
          surface.hoverContext.clearRect(0, 0, surface.hoverElement.width, surface.hoverElement.height);
        }
      } else if (!surface.resizeArtifactsCleared || hoverDisplaySizeChanged) {
        // A post-resize crossfade left on screen will cover transformed marks
        // with a stale (often white-backed) snapshot while dragging.
        clearPostResizeTransition(surface);
        // Stale hover overlays sit above the GL layer and can mask points.
        surface.hoverContext.setTransform(1, 0, 0, 1, 0, 0);
        surface.hoverContext.clearRect(0, 0, surface.hoverElement.width, surface.hoverElement.height);
        surface.resizeArtifactsCleared = true;
      }

      if (usesPointCloud && surface.gl) {
        surface.glResources = ensureGLResources(surface.gl, surface.glResources);
      }

      if (!deferPointCloudDraw && surface.gl && (hideGLForSnapshot || usesPointCloud)) {
        if (liveWebGLResize) {
          const viewport = resolveWebGLViewport(surface.gl, scene.size.width, scene.size.height, true);
          surface.gl.enable(surface.gl.SCISSOR_TEST);
          surface.gl.scissor(0, viewport.y, viewport.width, viewport.height);
        }
        surface.gl.clearColor(0, 0, 0, 0);
        surface.gl.clear(surface.gl.COLOR_BUFFER_BIT);
        if (liveWebGLResize) {
          surface.gl.disable(surface.gl.SCISSOR_TEST);
        }
      }
      if (hideGLForSnapshot && surface.glElement) {
        surface.glElement.style.display = "none";
      }

      let liveCanvasSnapshot: PlotResizeSnapshot | undefined;
      if (
        activeResize &&
        !scene.resizePreview &&
        scene.captureResizeSnapshot &&
        scene.resizeSnapshotRange &&
        !rangeHasPointCloud(scene, scene.resizeSnapshotRange)
      ) {
        // Render marks once into their preview buffer, then blit that same
        // buffer into the live frame instead of encoding every mark twice.
        updatePlotResizeSnapshot(surface, scene);
        liveCanvasSnapshot = surface.plotResizeSnapshot;
      }

      const markBlit = resolveResizeMarkBlit(scene, liveCanvasSnapshot, resizeSnapshot);
      let drewResizeSnapshot = false;
      for (let index = 0; index < scene.primitives.length; index += 1) {
        const primitive = scene.primitives[index];

        if (!primitive) {
          continue;
        }
        if (deferPointCloudDraw && primitive.kind === "point-cloud") {
          continue;
        }
        if (markBlit && index >= markBlit.start && index < markBlit.end) {
          if (!drewResizeSnapshot) {
            drawPlotResizeSnapshot(
              surface.context,
              markBlit.snapshot,
              markBlit.transform,
              "low"
            );
            drewResizeSnapshot = true;
          }
          continue;
        }

        const resizeTransform = scene.resizePreview &&
          index >= scene.resizePreview.markPrimitiveStart &&
          index < scene.resizePreview.markPrimitiveEnd
          ? scene.resizePreview.transform
          : undefined;

        if (isIsolatedAreaFill(primitive)) {
          const layerEnd = findIsolatedAreaLayerEnd(scene.primitives, index);
          drawIsolatedAreaLayer(
            surface.context,
            scene.primitives,
            index,
            layerEnd,
            scene.size.width,
            scene.size.height,
            resizeTransform,
            surface.gl,
            surface.glResources
          );
          index = layerEnd - 1;
          continue;
        }

        drawCanvasPrimitive(
          surface.context,
          primitive,
          resizeTransform,
          surface.gl,
          surface.glResources,
          scene.size.width,
          scene.size.height,
          liveWebGLResize
        );
      }

      if (scene.edgeBlur) {
        drawPlotEdgeBlur(surface.context, scene.plotArea, scene.edgeBlur);
      }

      if (!activeResize) {
        if (scene.resizeTransition && resizeSnapshot) {
          startPostResizeTransition(surface, scene, resizeSnapshot, scene.resizeTransition.durationMs);
        } else {
          clearPostResizeTransition(surface);
        }
      }
      if (!scene.resizePreview && scene.captureResizeSnapshot && !liveCanvasSnapshot) {
        updatePlotResizeSnapshot(surface, scene);
      }

      if (usesPointCloud) {
        pruneUnusedGLBuffers(surface, scene);
      }
    },
    renderScatterHover(surface, scene) {
      resizeHoverSurface(surface, scene);
      alignOverlayCanvases(surface, scene);
      drawSceneHover(surface.hoverContext, scene);
    },
    renderOverlay(surface, scene) {
      const usesPointCloud = sceneHasPointCloud(scene);
      if (usesPointCloud) {
        ensureGLSurface(surface);
      }

      resizeHoverSurface(surface, scene);
      alignOverlayCanvases(surface, scene);
      if (usesPointCloud && surface.gl) {
        surface.glResources = ensureGLResources(surface.gl, surface.glResources);
      }
      if (scene.overlay) {
        drawOverlayPrimitives(
          surface.hoverContext,
          scene,
          usesPointCloud ? surface.gl : undefined,
          usesPointCloud ? surface.glResources : undefined
        );
      } else {
        drawSceneHover(surface.hoverContext, scene);
      }

      if (usesPointCloud) {
        pruneUnusedGLBuffers(surface, scene);
      }
    },
    destroy(surface) {
      clearPostResizeTransition(surface);
      clearResizeSnapshots(surface);
      releaseCanvasBackingStore(surface.transitionElement);
      releaseCanvasBackingStore(surface.hoverElement);
      releaseCanvasBackingStore(surface.glElement);
      releaseCanvasBackingStore(surface.element);
      surface.transitionElement.remove();
      surface.hoverElement.remove();
      surface.glElement?.remove();
      surface.element.remove();
      if (surface.gl && surface.glResources) {
        destroyPointCloudGLResources(surface.gl, surface.glResources);
        delete surface.glResources;
      }
    }
  };
}

function ensureGLSurface(surface: CanvasSurface): void {
  if (surface.glElement) {
    surface.glElement.style.display = "block";
    return;
  }

  if (!surface.element.parentElement) {
    return;
  }

  const glCanvas = document.createElement("canvas");
  const gl = glCanvas.getContext("webgl", { alpha: true, premultipliedAlpha: false, antialias: false }) || undefined;

  if (!gl) {
    return;
  }

  glCanvas.style.position = "absolute";
  glCanvas.style.left = "0";
  glCanvas.style.top = "0";
  glCanvas.style.display = "block";
  glCanvas.style.pointerEvents = "none";
  surface.element.parentElement.insertBefore(glCanvas, surface.transitionElement);
  surface.glElement = glCanvas;
  surface.gl = gl;
}

function disableGLSurface(surface: CanvasSurface): void {
  if (!surface.glElement || !surface.gl) {
    return;
  }

  surface.gl.clearColor(0, 0, 0, 0);
  surface.gl.clear(surface.gl.COLOR_BUFFER_BIT);
  surface.glElement.style.display = "none";
  clearResizeSnapshots(surface);
  if (surface.glResources) {
    destroyPointCloudGLResources(surface.gl, surface.glResources);
    delete surface.glResources;
  }
}

function sceneHasPointCloud(scene: SceneGraph): boolean {
  return scene.primitives.some((primitive) => primitive.kind === "point-cloud");
}

function pruneUnusedGLBuffers(surface: CanvasSurface, scene: SceneGraph): void {
  if (!surface.gl || !surface.glResources) {
    return;
  }

  prunePointCloudGLBuffers(surface.gl, surface.glResources, collectActivePointCloudArrays(scene));
}

function collectActivePointCloudArrays(scene: SceneGraph): Set<Float32Array> {
  const active = new Set<Float32Array>();

  for (const primitive of scene.primitives) {
    if (primitive.kind !== "point-cloud") {
      continue;
    }

    active.add(primitive.points);

    if (primitive.radii) {
      active.add(primitive.radii);
    }

    if (primitive.categoryIds) {
      active.add(primitive.categoryIds);
    }

    if (primitive.revealOrder) {
      active.add(primitive.revealOrder);
    }
  }

  return active;
}

function releaseCanvasBackingStore(canvas: HTMLCanvasElement | undefined): void {
  if (!canvas) {
    return;
  }

  canvas.width = 0;
  canvas.height = 0;
}

function drawOverlayPrimitives(
  context: CanvasRenderingContext2D,
  scene: SceneGraph,
  gl?: WebGLRenderingContext,
  glResources?: CanvasSurface["glResources"]
): void {
  context.clearRect(0, 0, scene.size.width, scene.size.height);

  for (const primitive of scene.primitives) {
    drawCanvasPrimitive(
      context,
      primitive,
      undefined,
      gl,
      glResources,
      scene.size.width,
      scene.size.height
    );
  }
}

export function resizeCanvasSurface(
  surface: CanvasSurface,
  scene: SceneGraph,
  options: { growOnly?: boolean; snap?: number; resizeGL?: boolean; liveWebGLResize?: boolean } = {}
): { displayWidth: number; displayHeight: number; pixelRatio: number } {
  const pixelRatio = window.devicePixelRatio || 1;
  const displayWidth = Math.max(1, scene.size.width);
  const displayHeight = Math.max(1, scene.size.height);
  const targetBackingWidth = Math.round(displayWidth * pixelRatio);
  const targetBackingHeight = Math.round(displayHeight * pixelRatio);
  const snap = Math.max(1, options.snap ?? 1);
  const backingWidth = options.growOnly
    ? Math.max(surface.lastWidth ?? 0, Math.ceil(targetBackingWidth / snap) * snap)
    : targetBackingWidth;
  const backingHeight = options.growOnly
    ? Math.max(surface.lastHeight ?? 0, Math.ceil(targetBackingHeight / snap) * snap)
    : targetBackingHeight;
  const scaleX = backingWidth / displayWidth;
  const scaleY = backingHeight / displayHeight;
  const cssWidth = `${displayWidth}px`;
  const cssHeight = `${displayHeight}px`;

  setElementCssSize(surface.element, cssWidth, cssHeight);

  if (options.resizeGL && surface.glElement) {
    // Keep WebGL backing pixels 1:1 with CSS pixels. The live viewport below
    // occupies the visible top-left region; excess retained storage is clipped.
    const glCssWidth = options.liveWebGLResize ? `${backingWidth / pixelRatio}px` : cssWidth;
    const glCssHeight = options.liveWebGLResize ? `${backingHeight / pixelRatio}px` : cssHeight;
    setElementCssSize(surface.glElement, glCssWidth, glCssHeight);
    const clip = options.liveWebGLResize
      ? `rect(0px, ${displayWidth}px, ${displayHeight}px, 0px)`
      : "auto";
    if (surface.glElement.style.clip !== clip) {
      surface.glElement.style.clip = clip;
    }
  }

  if (
    surface.lastWidth !== backingWidth ||
    surface.lastHeight !== backingHeight ||
    surface.lastPixelRatio !== pixelRatio
  ) {
    surface.element.width = backingWidth;
    surface.element.height = backingHeight;
    surface.lastWidth = backingWidth;
    surface.lastHeight = backingHeight;
    surface.lastPixelRatio = pixelRatio;
  }

  surface.context.setTransform(scaleX, 0, 0, scaleY, 0, 0);
  surface.context.clearRect(0, 0, displayWidth, displayHeight);

  if (options.resizeGL && surface.glElement && surface.gl) {
    if (
      surface.glElement.width !== backingWidth ||
      surface.glElement.height !== backingHeight
    ) {
      surface.glElement.width = backingWidth;
      surface.glElement.height = backingHeight;
    }
    const viewport = resolveWebGLViewport(
      surface.gl,
      displayWidth,
      displayHeight,
      options.liveWebGLResize === true
    );
    surface.gl.viewport(0, viewport.y, viewport.width, viewport.height);
  }

  return { displayWidth, displayHeight, pixelRatio };
}

function resizeCanvasCssOnly(surface: CanvasSurface, scene: SceneGraph): void {
  const displayWidth = Math.max(1, scene.size.width);
  const displayHeight = Math.max(1, scene.size.height);
  const width = `${displayWidth}px`;
  const height = `${displayHeight}px`;
  setElementCssSize(surface.element, width, height);
  if (surface.glElement) {
    // Interstitial compositor frames intentionally avoid a point-cloud draw.
    // Keep the last exact GL frame at its native CSS pixel size and only crop
    // it to the current chart bounds. The next staggered live paint updates
    // point positions; no frame ever anisotropically scales the glyphs.
    const pixelRatio = window.devicePixelRatio || 1;
    setElementCssSize(
      surface.glElement,
      `${surface.glElement.width / pixelRatio}px`,
      `${surface.glElement.height / pixelRatio}px`
    );
    const clip = `rect(0px, ${displayWidth}px, ${displayHeight}px, 0px)`;
    if (surface.glElement.style.clip !== clip) {
      surface.glElement.style.clip = clip;
    }
  }
  setElementCssSize(surface.hoverElement, width, height);
}

function retainWebGLResizeSurface(surface: CanvasSurface, scene: SceneGraph): void {
  if (!surface.glElement) {
    return;
  }

  const pixelRatio = window.devicePixelRatio || 1;
  const displayWidth = Math.max(1, scene.size.width);
  const displayHeight = Math.max(1, scene.size.height);
  setElementCssSize(
    surface.glElement,
    `${surface.glElement.width / pixelRatio}px`,
    `${surface.glElement.height / pixelRatio}px`
  );
  const clip = `rect(0px, ${displayWidth}px, ${displayHeight}px, 0px)`;
  if (surface.glElement.style.clip !== clip) {
    surface.glElement.style.clip = clip;
  }
}

function setElementCssSize(element: HTMLElement, width: string, height: string): void {
  if (element.style.width !== width) {
    element.style.width = width;
  }
  if (element.style.height !== height) {
    element.style.height = height;
  }
}

function updatePlotResizeSnapshot(surface: CanvasSurface, scene: SceneGraph): void {
  const source = findResizeSnapshotSource(scene);
  const markRange = scene.resizeSnapshotRange;

  if (!source || !markRange) {
    delete surface.plotResizeSnapshot;
    return;
  }

  const usesWebGLMarks = rangeHasPointCloud(scene, markRange) &&
    surface.glElement !== undefined &&
    surface.glElement.style.display !== "none";
  const sourceCanvas = usesWebGLMarks ? surface.glElement! : surface.element;
  const displayWidth = scene.size.width;
  const displayHeight = scene.size.height;
  const current = surface.plotResizeSnapshot;
  // The transition still reads its preview; capture the live frame elsewhere.
  const snapshot = current && current !== surface.resizeTransitionSnapshot
    ? current.canvas
    : document.createElement("canvas");
  const pixelRatio = window.devicePixelRatio || 1;
  const targetWidth = Math.max(1, Math.round(source.width * Math.min(pixelRatio, sourceCanvas.width / displayWidth)));
  const targetHeight = Math.max(1, Math.round(source.height * Math.min(pixelRatio, sourceCanvas.height / displayHeight)));
  const snapshotWidth = scene.growOnlyCanvas
    ? Math.max(snapshot.width, Math.ceil(targetWidth / 32) * 32)
    : targetWidth;
  const snapshotHeight = scene.growOnlyCanvas
    ? Math.max(snapshot.height, Math.ceil(targetHeight / 32) * 32)
    : targetHeight;
  const context = snapshot.getContext("2d");

  if (!context) {
    delete surface.plotResizeSnapshot;
    return;
  }

  if (snapshot.width !== snapshotWidth || snapshot.height !== snapshotHeight) {
    snapshot.width = snapshotWidth;
    snapshot.height = snapshotHeight;
  }
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, snapshotWidth, snapshotHeight);
  drawMarkRangeToSnapshot(context, scene, markRange, source, snapshotWidth, snapshotHeight);
  if (usesWebGLMarks) {
    drawCanvasRegionToSnapshot(context, sourceCanvas, displayWidth, displayHeight, source, snapshotWidth, snapshotHeight);
  }
  surface.plotResizeSnapshot = {
    canvas: snapshot,
    source
  };
}

function rangeHasPointCloud(
  scene: SceneGraph,
  range: NonNullable<SceneGraph["resizeSnapshotRange"]>
): boolean {
  for (let index = range.markPrimitiveStart; index < range.markPrimitiveEnd; index += 1) {
    if (scene.primitives[index]?.kind === "point-cloud") {
      return true;
    }
  }
  return false;
}

function drawMarkRangeToSnapshot(
  context: CanvasRenderingContext2D,
  scene: SceneGraph,
  range: NonNullable<SceneGraph["resizeSnapshotRange"]>,
  source: { x: number; y: number; width: number; height: number },
  snapshotWidth: number,
  snapshotHeight: number
): void {
  const scaleX = snapshotWidth / source.width;
  const scaleY = snapshotHeight / source.height;
  context.setTransform(scaleX, 0, 0, scaleY, -source.x * scaleX, -source.y * scaleY);

  for (let index = range.markPrimitiveStart; index < range.markPrimitiveEnd; index += 1) {
    const primitive = scene.primitives[index];
    if (!primitive) {
      continue;
    }

    if (isIsolatedAreaFill(primitive)) {
      const layerEnd = Math.min(
        range.markPrimitiveEnd,
        findIsolatedAreaLayerEnd(scene.primitives, index)
      );
      drawIsolatedAreaLayer(
        context,
        scene.primitives,
        index,
        layerEnd,
        scene.size.width,
        scene.size.height,
        undefined
      );
      index = layerEnd - 1;
      continue;
    }

    drawCanvasPrimitive(
      context,
      primitive,
      undefined,
      undefined,
      undefined,
      scene.size.width,
      scene.size.height
    );
  }

  context.setTransform(1, 0, 0, 1, 0, 0);
}

function clearResizeSnapshots(surface: CanvasSurface): void {
  const canvases = new Set<HTMLCanvasElement>();
  if (surface.plotResizeSnapshot) {
    canvases.add(surface.plotResizeSnapshot.canvas);
  }
  if (surface.resizeTransitionSnapshot) {
    canvases.add(surface.resizeTransitionSnapshot.canvas);
  }
  for (const canvas of canvases) {
    releaseCanvasBackingStore(canvas);
  }
  delete surface.plotResizeSnapshot;
  delete surface.resizeTransitionSnapshot;
}

function drawCanvasRegionToSnapshot(
  context: CanvasRenderingContext2D,
  sourceCanvas: HTMLCanvasElement,
  displayWidth: number,
  displayHeight: number,
  source: { x: number; y: number; width: number; height: number },
  snapshotWidth: number,
  snapshotHeight: number
): void {
  const scaleX = sourceCanvas.width / displayWidth;
  const scaleY = sourceCanvas.height / displayHeight;

  context.drawImage(
    sourceCanvas,
    source.x * scaleX,
    source.y * scaleY,
    source.width * scaleX,
    source.height * scaleY,
    0,
    0,
    snapshotWidth,
    snapshotHeight
  );
}

function findResizeSnapshotSource(
  scene: SceneGraph
): { x: number; y: number; width: number; height: number } | undefined {
  const preview = scene.resizePreview;

  if (preview) {
    for (let index = preview.markPrimitiveStart; index < preview.markPrimitiveEnd; index += 1) {
      const primitive = scene.primitives[index];

      if (primitive?.kind === "point-cloud") {
        return primitive.plotArea ?? primitive.clip;
      }
    }
    return undefined;
  }

  for (const primitive of scene.primitives) {
    if (primitive.kind === "point-cloud") {
      return primitive.plotArea ?? primitive.clip;
    }
  }

  return scene.plotArea;
}

function drawPlotResizeSnapshot(
  context: CanvasRenderingContext2D,
  snapshot: PlotResizeSnapshot,
  transform: { a: number; d: number; e: number; f: number },
  quality: ImageSmoothingQuality = "high"
): void {
  const destX = snapshot.source.x * transform.a + transform.e;
  const destY = snapshot.source.y * transform.d + transform.f;
  const destWidth = snapshot.source.width * transform.a;
  const destHeight = snapshot.source.height * transform.d;

  const prevSmoothing = context.imageSmoothingEnabled;
  const prevQuality = context.imageSmoothingQuality;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = quality;
  context.drawImage(snapshot.canvas, destX, destY, destWidth, destHeight);
  context.imageSmoothingEnabled = prevSmoothing;
  context.imageSmoothingQuality = prevQuality;
}

function resolveResizeMarkBlit(
  scene: SceneGraph,
  liveCanvasSnapshot: PlotResizeSnapshot | undefined,
  resizeSnapshot: PlotResizeSnapshot | undefined
): {
  snapshot: PlotResizeSnapshot;
  transform: { a: number; d: number; e: number; f: number };
  start: number;
  end: number;
} | undefined {
  if (liveCanvasSnapshot && scene.resizeSnapshotRange) {
    return {
      snapshot: liveCanvasSnapshot,
      transform: resizePlotAreaTransform(liveCanvasSnapshot.source, scene.plotArea),
      start: scene.resizeSnapshotRange.markPrimitiveStart,
      end: scene.resizeSnapshotRange.markPrimitiveEnd
    };
  }

  if (resizeSnapshot && scene.resizePreview && scene.resizeSnapshotRange) {
    return {
      snapshot: resizeSnapshot,
      transform: scene.resizePreview.transform,
      start: scene.resizeSnapshotRange.markPrimitiveStart,
      end: scene.resizeSnapshotRange.markPrimitiveEnd
    };
  }

  return undefined;
}

function resizeHoverSurface(
  surface: CanvasSurface,
  scene: SceneGraph,
  options: { clear?: boolean } = {}
): void {
  const pixelRatio = window.devicePixelRatio || 1;
  const displayWidth = Math.max(1, scene.size.width);
  const displayHeight = Math.max(1, scene.size.height);
  const backingWidth = Math.round(displayWidth * pixelRatio);
  const backingHeight = Math.round(displayHeight * pixelRatio);

  surface.hoverElement.style.width = `${displayWidth}px`;
  surface.hoverElement.style.height = `${displayHeight}px`;

  if (
    surface.lastHoverWidth !== backingWidth ||
    surface.lastHoverHeight !== backingHeight ||
    surface.lastHoverPixelRatio !== pixelRatio
  ) {
    surface.hoverElement.width = backingWidth;
    surface.hoverElement.height = backingHeight;
    surface.lastHoverWidth = backingWidth;
    surface.lastHoverHeight = backingHeight;
    surface.lastHoverPixelRatio = pixelRatio;
  }

  surface.hoverContext.setTransform(backingWidth / displayWidth, 0, 0, backingHeight / displayHeight, 0, 0);

  if (options.clear !== false) {
    surface.hoverContext.clearRect(0, 0, displayWidth, displayHeight);
  }
}

function resizeTransitionSurface(surface: CanvasSurface, scene: SceneGraph): void {
  const pixelRatio = window.devicePixelRatio || 1;
  const displayWidth = Math.max(1, scene.size.width);
  const displayHeight = Math.max(1, scene.size.height);
  const backingWidth = Math.round(displayWidth * pixelRatio);
  const backingHeight = Math.round(displayHeight * pixelRatio);

  surface.transitionElement.style.width = `${displayWidth}px`;
  surface.transitionElement.style.height = `${displayHeight}px`;

  if (
    surface.transitionElement.width !== backingWidth ||
    surface.transitionElement.height !== backingHeight
  ) {
    surface.transitionElement.width = backingWidth;
    surface.transitionElement.height = backingHeight;
  }

  surface.transitionContext.setTransform(backingWidth / displayWidth, 0, 0, backingHeight / displayHeight, 0, 0);
  surface.transitionContext.clearRect(0, 0, displayWidth, displayHeight);
}

function startPostResizeTransition(
  surface: CanvasSurface,
  scene: SceneGraph,
  snapshot: PlotResizeSnapshot,
  durationMs: number
): void {
  clearPostResizeTransition(surface);

  if (durationMs <= 0) {
    return;
  }

  const startedAt = performance.now();
  resizeTransitionSurface(surface, scene);
  surface.resizeTransitionSnapshot = snapshot;
  surface.transitionElement.style.display = "block";
  if (surface.glElement) {
    surface.glElement.style.opacity = "1";
  }
  drawPlotResizeSnapshot(
    surface.transitionContext,
    snapshot,
    resizePlotAreaTransform(snapshot.source, scene.plotArea)
  );

  const tick = (time: number) => {
    const progress = Math.min(1, (time - startedAt) / durationMs);
    const eased = 1 - (1 - progress) ** 3;

    surface.transitionElement.style.opacity = String(1 - eased);

    if (progress < 1) {
      surface.resizeTransitionFrame = requestAnimationFrame(tick);
    } else {
      clearPostResizeTransition(surface);
    }
  };

  tick(startedAt);
}

function clearPostResizeTransition(surface: CanvasSurface): void {
  if (surface.resizeTransitionFrame !== undefined) {
    cancelAnimationFrame(surface.resizeTransitionFrame);
    delete surface.resizeTransitionFrame;
  }

  surface.transitionContext.clearRect(0, 0, surface.transitionElement.width, surface.transitionElement.height);
  surface.transitionElement.style.display = "none";
  surface.transitionElement.style.opacity = "1";
  releaseCanvasBackingStore(surface.transitionElement);

  if (surface.glElement) {
    surface.glElement.style.opacity = "1";
  }

  const snapshot = surface.resizeTransitionSnapshot;
  if (
    snapshot &&
    snapshot.canvas !== surface.plotResizeSnapshot?.canvas
  ) {
    releaseCanvasBackingStore(snapshot.canvas);
  }
  delete surface.resizeTransitionSnapshot;
}

function resizePlotAreaTransform(
  from: { x: number; y: number; width: number; height: number },
  to: { x: number; y: number; width: number; height: number }
): { a: number; d: number; e: number; f: number } {
  const a = to.width / from.width;
  const d = to.height / from.height;
  const e = to.x - from.x * a;
  const f = to.y - from.y * d;

  return { a, d, e, f };
}

function drawSceneHover(context: CanvasRenderingContext2D, scene: SceneGraph): void {
  drawScatterSceneHover(context, scene);
}

function alignOverlayCanvases(surface: CanvasSurface, scene?: SceneGraph): void {
  const displayWidth = scene?.size.width;
  const displayHeight = scene?.size.height;
  // Pan/zoom does not move the canvas in-container. If display size is unchanged,
  // skip offsetLeft/Top reads entirely — they force synchronous layout.
  if (
    displayWidth !== undefined &&
    displayHeight !== undefined &&
    surface.lastAlignDisplayWidth === displayWidth &&
    surface.lastAlignDisplayHeight === displayHeight &&
    surface.lastAlignLeft !== undefined &&
    surface.lastAlignTop !== undefined
  ) {
    return;
  }

  const leftPx = surface.element.offsetLeft;
  const topPx = surface.element.offsetTop;
  if (
    surface.lastAlignLeft === leftPx &&
    surface.lastAlignTop === topPx &&
    surface.lastAlignDisplayWidth === displayWidth &&
    surface.lastAlignDisplayHeight === displayHeight
  ) {
    return;
  }
  surface.lastAlignLeft = leftPx;
  surface.lastAlignTop = topPx;
  if (displayWidth !== undefined) {
    surface.lastAlignDisplayWidth = displayWidth;
  }
  if (displayHeight !== undefined) {
    surface.lastAlignDisplayHeight = displayHeight;
  }

  const left = `${leftPx}px`;
  const top = `${topPx}px`;

  surface.transitionElement.style.left = left;
  surface.transitionElement.style.top = top;
  surface.hoverElement.style.left = left;
  surface.hoverElement.style.top = top;
  if (surface.glElement) {
    surface.glElement.style.left = left;
    surface.glElement.style.top = top;
  }
}

function isIsolatedAreaFill(primitive: Primitive): boolean {
  return primitive.kind === "path" && primitive.areaLayer === "isolate" && primitive.fill !== undefined;
}

function findIsolatedAreaLayerEnd(primitives: readonly Primitive[], start: number): number {
  let end = start + 1;
  while (end < primitives.length) {
    const next = primitives[end];
    if (!next || !isIsolatedAreaFill(next)) {
      break;
    }
    end += 1;
  }
  return end;
}

function drawIsolatedAreaLayer(
  context: CanvasRenderingContext2D,
  primitives: readonly Primitive[],
  start: number,
  end: number,
  width: number,
  height: number,
  resizeTransform: ResizePreviewTransform | undefined,
  gl?: WebGLRenderingContext,
  glResources?: PointCloudGLResources
): void {
  const first = primitives[start];
  if (!first || first.kind !== "path") {
    return;
  }

  const layerOpacity = first.fillOpacity ?? 1;
  const layer = ensureIsolatedAreaLayer(width, height);
  layer.context.clearRect(0, 0, width, height);

  for (let index = start; index < end; index += 1) {
    const primitive = primitives[index];
    if (!primitive || primitive.kind !== "path") {
      continue;
    }

    // Draw opaque coverage into the isolate layer so overlaps cover instead of mix.
    const {
      fillOpacity: _fillOpacity,
      areaLayer: _areaLayer,
      compositeOperation: _compositeOperation,
      ...direct
    } = primitive;
    drawCanvasPrimitive(
      layer.context,
      direct,
      resizeTransform,
      gl,
      glResources,
      width,
      height
    );
  }

  context.save();
  context.globalAlpha *= Math.max(0, Math.min(1, layerOpacity));
  context.drawImage(layer.canvas, 0, 0, width, height);
  context.restore();
}

function ensureIsolatedAreaLayer(width: number, height: number): {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
} {
  if (!isolatedAreaLayerCanvas || !isolatedAreaLayerContext) {
    isolatedAreaLayerCanvas = document.createElement("canvas");
    const context = isolatedAreaLayerCanvas.getContext("2d");
    if (!context) {
      throw new Error("Canvas 2D context is unavailable for area isolate layer.");
    }
    isolatedAreaLayerContext = context;
  }

  const canvas = isolatedAreaLayerCanvas;
  const context = isolatedAreaLayerContext;
  // Match the main context's CSS-pixel space so drawImage does not double-scale.
  const targetWidth = Math.max(1, Math.ceil(width));
  const targetHeight = Math.max(1, Math.ceil(height));

  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
  }

  context.setTransform(1, 0, 0, 1, 0, 0);
  return { canvas, context };
}
