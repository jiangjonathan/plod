import type { Primitive, ResizePreviewTransform } from "../core/types";
import {
  getPointArrayDirtyStart,
  getPointArrayVersion,
  setPointArrayDirtyStart
} from "../data/metadata";
import { SCATTER_REVEAL_FADE_WINDOW, SCATTER_REVEAL_STAGGER } from "../marks/scatterAnimation";
import {
  POINT_CLOUD_FRAGMENT_SHADER,
  POINT_CLOUD_SHADER_VERSION,
  POINT_CLOUD_VERTEX_SHADER
} from "./pointCloudGlsl";
import { parseCssColor } from "./color";
import { scatterShapeShaderValue } from "./scatterPoint";

export type PointCloudGLResources = {
  version: number;
  program: WebGLProgram;
  attribs: {
    position: number;
    radius: number;
    revealOrder: number;
    category: number;
  };
  uniforms: {
    plotArea: WebGLUniformLocation;
    xDomain: WebGLUniformLocation;
    yDomain: WebGLUniformLocation;
    canvasSize: WebGLUniformLocation;
    globalRadius: WebGLUniformLocation;
    devicePixelRatio: WebGLUniformLocation;
    color: WebGLUniformLocation;
    shape: WebGLUniformLocation;
    categoryEnabled: WebGLUniformLocation;
    categoryCount: WebGLUniformLocation;
    categoryColors: WebGLUniformLocation;
    categoryShapes: WebGLUniformLocation;
    opacity: WebGLUniformLocation;
    resizeTransform: WebGLUniformLocation;
    hasResizeTransform: WebGLUniformLocation;
    revealProgress: WebGLUniformLocation;
    revealEnabled: WebGLUniformLocation;
    revealStagger: WebGLUniformLocation;
    revealFade: WebGLUniformLocation;
    revealGrow: WebGLUniformLocation;
    revealFadeWindow: WebGLUniformLocation;
  };
  buffers: Map<Float32Array, WebGLBuffer>;
  bufferVersions: WeakMap<Float32Array, number>;
 };

export function resolveWebGLViewport(
  gl: WebGLRenderingContext,
  canvasWidth: number,
  canvasHeight: number,
  clipped: boolean
): { width: number; height: number; y: number } {
  if (!clipped) {
    return { width: gl.drawingBufferWidth, height: gl.drawingBufferHeight, y: 0 };
  }

  const pixelRatio = window.devicePixelRatio || 1;
  const width = Math.min(gl.drawingBufferWidth, Math.round(canvasWidth * pixelRatio));
  const height = Math.min(gl.drawingBufferHeight, Math.round(canvasHeight * pixelRatio));
  return { width, height, y: gl.drawingBufferHeight - height };
}

export function initPointCloudGLResources(gl: WebGLRenderingContext): PointCloudGLResources {
  const program = createShaderProgram(gl, POINT_CLOUD_VERTEX_SHADER, POINT_CLOUD_FRAGMENT_SHADER);

  if (!program) {
    throw new Error("Failed to compile WebGL shaders");
  }

  const revealFade = gl.getUniformLocation(program, "u_revealFade");
  const revealGrow = gl.getUniformLocation(program, "u_revealGrow");
  const revealFadeWindow = gl.getUniformLocation(program, "u_revealFadeWindow");

  if (!revealFade || !revealGrow || !revealFadeWindow) {
    throw new Error("Point cloud shader is missing reveal uniforms");
  }

  return {
    version: POINT_CLOUD_SHADER_VERSION,
    program,
    attribs: {
      position: gl.getAttribLocation(program, "a_position"),
      radius: gl.getAttribLocation(program, "a_radius"),
      revealOrder: gl.getAttribLocation(program, "a_revealOrder"),
      category: gl.getAttribLocation(program, "a_category")
    },
    uniforms: {
      plotArea: gl.getUniformLocation(program, "u_plotArea")!,
      xDomain: gl.getUniformLocation(program, "u_xDomain")!,
      yDomain: gl.getUniformLocation(program, "u_yDomain")!,
      canvasSize: gl.getUniformLocation(program, "u_canvasSize")!,
      globalRadius: gl.getUniformLocation(program, "u_globalRadius")!,
      devicePixelRatio: gl.getUniformLocation(program, "u_devicePixelRatio")!,
      color: gl.getUniformLocation(program, "u_color")!,
      shape: gl.getUniformLocation(program, "u_shape")!,
      categoryEnabled: gl.getUniformLocation(program, "u_categoryEnabled")!,
      categoryCount: gl.getUniformLocation(program, "u_categoryCount")!,
      categoryColors: gl.getUniformLocation(program, "u_categoryColors[0]")!,
      categoryShapes: gl.getUniformLocation(program, "u_categoryShapes[0]")!,
      opacity: gl.getUniformLocation(program, "u_opacity")!,
      resizeTransform: gl.getUniformLocation(program, "u_resizeTransform")!,
      hasResizeTransform: gl.getUniformLocation(program, "u_hasResizeTransform")!,
      revealProgress: gl.getUniformLocation(program, "u_revealProgress")!,
      revealEnabled: gl.getUniformLocation(program, "u_revealEnabled")!,
      revealStagger: gl.getUniformLocation(program, "u_revealStagger")!,
      revealFade,
      revealGrow,
      revealFadeWindow
    },
    buffers: new Map<Float32Array, WebGLBuffer>(),
    bufferVersions: new WeakMap<Float32Array, number>()
  };
}

export function ensurePointCloudGLResources(
  gl: WebGLRenderingContext,
  existing?: PointCloudGLResources
): PointCloudGLResources {
  if (existing?.version === POINT_CLOUD_SHADER_VERSION) {
    return existing;
  }

  if (existing) {
    destroyPointCloudGLResources(gl, existing);
  }

  return initPointCloudGLResources(gl);
}

export function prunePointCloudGLBuffers(
  gl: WebGLRenderingContext,
  resources: PointCloudGLResources,
  activeArrays: ReadonlySet<Float32Array>
): void {
  for (const [array, buffer] of resources.buffers) {
    if (!activeArrays.has(array)) {
      gl.deleteBuffer(buffer);
      resources.buffers.delete(array);
    }
  }
}

export function destroyPointCloudGLResources(
  gl: WebGLRenderingContext,
  resources: PointCloudGLResources
): void {
  for (const buffer of resources.buffers.values()) {
    gl.deleteBuffer(buffer);
  }

  resources.buffers.clear();
  gl.deleteProgram(resources.program);
}

export function drawWebGLPointCloud(
  gl: WebGLRenderingContext,
  resources: PointCloudGLResources,
  primitive: Extract<Primitive, { kind: "point-cloud" }>,
  canvasWidth: number,
  canvasHeight: number,
  resizeTransform?: ResizePreviewTransform,
  liveWebGLResize = false
): void {
  const { program, attribs, uniforms, buffers, bufferVersions } = resources;

  gl.useProgram(program);

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  if (primitive.clip) {
    const viewport = resolveWebGLViewport(gl, canvasWidth, canvasHeight, liveWebGLResize);
    const scaleX = viewport.width / canvasWidth;
    const scaleY = viewport.height / canvasHeight;
    // Clip is authored in the cached (pre-resize) plot space. When marks are
    // affinely remapped mid-drag, scissor must follow or white plot-background
    // shows through in the expanded region.
    const clip = resizeTransform
      ? {
          x: primitive.clip.x * resizeTransform.a + resizeTransform.e,
          y: primitive.clip.y * resizeTransform.d + resizeTransform.f,
          width: primitive.clip.width * resizeTransform.a,
          height: primitive.clip.height * resizeTransform.d
        }
      : primitive.clip;
    const scissorX = Math.max(0, Math.floor(clip.x * scaleX));
    const scissorY = viewport.y + Math.max(0, Math.floor((canvasHeight - (clip.y + clip.height)) * scaleY));
    const scissorRight = Math.min(viewport.width, Math.ceil((clip.x + clip.width) * scaleX));
    const scissorTop = viewport.y + Math.min(viewport.height, Math.ceil((canvasHeight - clip.y) * scaleY));

    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(
      scissorX,
      scissorY,
      Math.max(0, scissorRight - scissorX),
      Math.max(0, scissorTop - scissorY)
    );
  } else {
    gl.disable(gl.SCISSOR_TEST);
  }

  let posBuffer = buffers.get(primitive.points);

  if (!posBuffer) {
    posBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, primitive.points, gl.STATIC_DRAW);
    buffers.set(primitive.points, posBuffer);
    bufferVersions.set(primitive.points, getPointArrayVersion(primitive.points));
    setPointArrayDirtyStart(primitive.points, Math.min(primitive.points.length, (primitive.pointCount ?? primitive.points.length / 2) * 2));
  } else {
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
    const version = getPointArrayVersion(primitive.points);
    if (bufferVersions.get(primitive.points) !== version) {
      const dirtyStart = Math.max(0, Math.min(getPointArrayDirtyStart(primitive.points), primitive.points.length));
      const activeComponents = Math.min(primitive.points.length, (primitive.pointCount ?? primitive.points.length / 2) * 2);
      if (dirtyStart < activeComponents) {
        gl.bufferSubData(gl.ARRAY_BUFFER, dirtyStart * 4, primitive.points.subarray(dirtyStart, activeComponents));
      }
      bufferVersions.set(primitive.points, version);
      setPointArrayDirtyStart(primitive.points, activeComponents);
    }
  }

  gl.enableVertexAttribArray(attribs.position);
  gl.vertexAttribPointer(attribs.position, 2, gl.FLOAT, false, 0, 0);

  if (primitive.radii) {
    let radiiBuffer = buffers.get(primitive.radii);

    if (!radiiBuffer) {
      radiiBuffer = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, radiiBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, primitive.radii, gl.STATIC_DRAW);
      buffers.set(primitive.radii, radiiBuffer);
    } else {
      gl.bindBuffer(gl.ARRAY_BUFFER, radiiBuffer);
    }

    gl.enableVertexAttribArray(attribs.radius);
    gl.vertexAttribPointer(attribs.radius, 1, gl.FLOAT, false, 0, 0);
  } else {
    gl.disableVertexAttribArray(attribs.radius);
  }

  const revealEnabled = primitive.revealOrder !== undefined && primitive.revealProgress !== undefined;

  if (revealEnabled) {
    let revealBuffer = buffers.get(primitive.revealOrder!);

    if (!revealBuffer) {
      revealBuffer = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, revealBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, primitive.revealOrder!, gl.STATIC_DRAW);
      buffers.set(primitive.revealOrder!, revealBuffer);
    } else {
      gl.bindBuffer(gl.ARRAY_BUFFER, revealBuffer);
    }

    gl.enableVertexAttribArray(attribs.revealOrder);
    gl.vertexAttribPointer(attribs.revealOrder, 1, gl.FLOAT, false, 0, 0);
  } else {
    gl.disableVertexAttribArray(attribs.revealOrder);
  }

  if (attribs.category >= 0) {
    if (primitive.categoryIds) {
      let categoryBuffer = buffers.get(primitive.categoryIds);

      if (!categoryBuffer) {
        categoryBuffer = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, categoryBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, primitive.categoryIds, gl.STATIC_DRAW);
        buffers.set(primitive.categoryIds, categoryBuffer);
        bufferVersions.set(primitive.categoryIds, getPointArrayVersion(primitive.categoryIds));
      } else {
        gl.bindBuffer(gl.ARRAY_BUFFER, categoryBuffer);
        const version = getPointArrayVersion(primitive.categoryIds);
        if (bufferVersions.get(primitive.categoryIds) !== version) {
          gl.bufferData(gl.ARRAY_BUFFER, primitive.categoryIds, gl.STATIC_DRAW);
          bufferVersions.set(primitive.categoryIds, version);
        }
      }

      gl.enableVertexAttribArray(attribs.category);
      gl.vertexAttribPointer(attribs.category, 1, gl.FLOAT, false, 0, 0);
    } else {
      gl.disableVertexAttribArray(attribs.category);
      gl.vertexAttrib1f(attribs.category, 0);
    }
  }

  const px = window.devicePixelRatio || 1;
  const plotArea = primitive.plotArea ?? { x: 0, y: 0, width: canvasWidth, height: canvasHeight };
  const xDomain = primitive.xDomain ?? [0, 1];
  const yDomain = primitive.yDomain ?? [0, 1];

  gl.uniform4f(uniforms.plotArea, plotArea.x, plotArea.y, plotArea.width, plotArea.height);
  gl.uniform2f(uniforms.xDomain, xDomain[0], xDomain[1]);
  gl.uniform2f(uniforms.yDomain, yDomain[0], yDomain[1]);
  gl.uniform2f(uniforms.canvasSize, canvasWidth, canvasHeight);
  gl.uniform1f(uniforms.globalRadius, primitive.radius);
  gl.uniform1f(uniforms.devicePixelRatio, px);

  const color = parseColor(primitive.fill ?? "#1f7a8c");
  gl.uniform4f(uniforms.color, color[0], color[1], color[2], color[3]);
  gl.uniform1f(uniforms.shape, scatterShapeShaderValue(primitive.shape));
  if (primitive.categoryIds && primitive.categoryPalette && primitive.categoryShapes) {
    gl.uniform1f(uniforms.categoryEnabled, 1);
    gl.uniform1f(uniforms.categoryCount, primitive.categoryCount ?? 0);
    gl.uniform4fv(uniforms.categoryColors, primitive.categoryPalette);
    gl.uniform1fv(uniforms.categoryShapes, primitive.categoryShapes);
  } else {
    gl.uniform1f(uniforms.categoryEnabled, 0);
    gl.uniform1f(uniforms.categoryCount, 0);
  }
  gl.uniform1f(uniforms.opacity, primitive.opacity ?? 1.0);
  gl.uniform1f(uniforms.revealProgress, primitive.revealProgress ?? 1);
  gl.uniform1f(uniforms.revealEnabled, revealEnabled ? 1 : 0);
  gl.uniform1f(uniforms.revealStagger, SCATTER_REVEAL_STAGGER);
  gl.uniform1f(uniforms.revealFade, primitive.revealFade ? 1 : 0);
  gl.uniform1f(uniforms.revealGrow, primitive.revealGrow ? 1 : 0);
  gl.uniform1f(uniforms.revealFadeWindow, primitive.revealGrow ? 0.75 : SCATTER_REVEAL_FADE_WINDOW);

  if (resizeTransform) {
    gl.uniform4f(uniforms.resizeTransform, resizeTransform.a, resizeTransform.d, resizeTransform.e, resizeTransform.f);
    gl.uniform1f(uniforms.hasResizeTransform, 1.0);
  } else {
    gl.uniform4f(uniforms.resizeTransform, 1.0, 1.0, 0.0, 0.0);
    gl.uniform1f(uniforms.hasResizeTransform, 0.0);
  }

  const count = primitive.pointCount ?? primitive.points.length / 2;
  gl.drawArrays(gl.POINTS, 0, count);
}

function createShaderProgram(gl: WebGLRenderingContext, vsSource: string, fsSource: string): WebGLProgram | null {
  const vs = loadShader(gl, gl.VERTEX_SHADER, vsSource);
  const fs = loadShader(gl, gl.FRAGMENT_SHADER, fsSource);

  if (!vs || !fs) {
    return null;
  }

  const program = gl.createProgram();

  if (!program) {
    return null;
  }

  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.bindAttribLocation(program, 0, "a_position"); // Guarantee position is at attribute index 0
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error("Shader link error:", gl.getProgramInfoLog(program));
    return null;
  }

  return program;
}

function loadShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);

  if (!shader) {
    return null;
  }

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error("Shader compile error:", gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }

  return shader;
}

const webglParsedColorCache = new Map<string, [number, number, number, number]>();
const MAX_PARSED_COLOR_CACHE_ENTRIES = 256;

export function parseColor(colorStr: string): [number, number, number, number] {
  const cached = webglParsedColorCache.get(colorStr);
  if (cached) {
    return cached;
  }

  const parsed = parseCssColor(colorStr);
  if (parsed) {
    const result: [number, number, number, number] = [parsed[0], parsed[1], parsed[2], parsed[3]];
    setBoundedCacheValue(webglParsedColorCache, colorStr, result, MAX_PARSED_COLOR_CACHE_ENTRIES);
    return result;
  }

  const fallback: [number, number, number, number] = [0, 0, 0, 1.0];
  setBoundedCacheValue(webglParsedColorCache, colorStr, fallback, MAX_PARSED_COLOR_CACHE_ENTRIES);
  return fallback;
}

function setBoundedCacheValue<K, V>(cache: Map<K, V>, key: K, value: V, maxEntries: number): void {
  cache.set(key, value);

  while (cache.size > maxEntries) {
    const firstKey = cache.keys().next().value as K | undefined;

    if (firstKey === undefined) {
      return;
    }

    cache.delete(firstKey);
  }
}
