import type {
  Primitive,
  Rect,
  MarkerStyle,
  ScatterHoverInteraction,
  ScatterPointShape,
  ScatterPointStyle,
  TooltipContent,
  TooltipMarker,
  TooltipResult
} from "../core/types";
import type { Accessor, Mark } from "./types";
import { readAccessor } from "./accessor";
import { buildScatterRevealOrder, resolveAnimatedScatterState } from "./scatterAnimation";
import { parseColor } from "../renderers/pointCloudWebGL";
import {
  getPointArrayCategoryCount,
  getPointArrayXDomain,
  getPointArrayYDomain,
  getPointCount,
  scatterViewMetadata
} from "../data/metadata";

export type ScatterMarkOptions<TDatum> = {
  x: Accessor<TDatum, number>;
  y: Accessor<TDatum, number>;
  radius?: number;
  radiusScale?: boolean | {
    maxScale?: number;
    densityTarget?: number;
    gamma?: number;
  };
  size?: Accessor<TDatum, number>;
  sizeDomain?: readonly [number, number];
  radiusRange?: readonly [number, number];
  fill?: string;
  category?: Accessor<TDatum, string | number | undefined>;
  opacity?: number;
  pointStyle?: ScatterPointStyle;
  xDomain?: readonly [number, number];
  yDomain?: readonly [number, number];
  tooltip?: boolean | ((datum: TDatum, index: number) => TooltipResult);
  hitRadius?: number;
  hitCellSize?: number;
  shape?: ScatterPointShape;
  /** When false, every category uses `shape` (default circle) instead of mixed glyphs. */
  varyCategoryShapes?: boolean;
  hoverInteraction?: ScatterHoverInteraction;
  hoverGrowRadius?: number;
  hoverOutline?: boolean | string | MarkerStyle;
};

type ScatterHitMeta<TDatum> = {
  datum?: TDatum;
  dataIndex: number;
  xValue: number;
  yValue: number;
  sizeValue?: number;
  categoryId?: number;
  categoryValue?: string | number;
};

type ScatterHitResult<TDatum> = {
  x: number;
  y: number;
  radius?: number;
  hitRadius: number;
  meta: ScatterHitMeta<TDatum>;
};

type ScatterRawCache = {
  points: Float32Array;
  radii?: Float32Array | undefined;
  categoryIds?: Float32Array | undefined;
  categoryCount: number;
  meta: ScatterHitMeta<unknown>[];
  indexMap: Map<number, number>;
  fullXDomain: readonly [number, number];
  fullYDomain: readonly [number, number];
  hitIndex: (
    mx: number,
    my: number,
    pixelRadius: number,
    currentXDomain: readonly [number, number],
    currentYDomain: readonly [number, number],
    currentPlotArea: Rect
  ) => ScatterHitResult<unknown> | undefined;
  hitIndexCount: number;
  pointCount: number;
  revealOrder?: Float32Array;
  revealOrderCount: number;
};

type PointCloudPrimitive = Extract<Primitive, { kind: "point-cloud" }>;

const SCATTER_CATEGORY_STYLE_LIMIT = 32;
const DEFAULT_CATEGORY_SHAPES: readonly ScatterPointShape[] = ["circle", "square", "diamond", "triangle", "star", "cross", "x", "polygon"];
const categoryPaletteCache = new Map<string, Float32Array>();
const defaultCategoryShapes = buildCategoryShapes();

export const rawPointsCache = new WeakMap<object, ScatterRawCache>();

function shapeToFloat(shape: ScatterPointShape): number {
  switch (shape) {
    case "circle": return 0.0;
    case "square": return 1.0;
    case "diamond": return 2.0;
    case "triangle": return 3.0;
    case "star": return 4.0;
    case "plus":
    case "cross": return 5.0;
    case "x": return 6.0;
    case "polygon": return 7.0;
    default: return 0.0;
  }
}

function resolveCategoryId(
  category: string | number | undefined,
  categoryMap: Map<string | number, number>
): number {
  if (category === undefined) {
    return 0;
  }

  let categoryId = categoryMap.get(category);

  if (categoryId === undefined) {
    categoryId = categoryMap.size;
    categoryMap.set(category, categoryId);
  }

  return categoryId;
}

function buildCategoryPalette(seriesPalette: readonly string[], fallback: string): Float32Array {
  const key = `${fallback}\n${seriesPalette.join("\n")}`;
  const cached = categoryPaletteCache.get(key);

  if (cached) {
    return cached;
  }

  const palette = new Float32Array(SCATTER_CATEGORY_STYLE_LIMIT * 4);

  for (let index = 0; index < SCATTER_CATEGORY_STYLE_LIMIT; index += 1) {
    const color = seriesPalette[index % Math.max(1, seriesPalette.length)] ?? fallback;
    const [r, g, b, a] = parseColor(color);
    palette[index * 4] = r;
    palette[index * 4 + 1] = g;
    palette[index * 4 + 2] = b;
    palette[index * 4 + 3] = a;
  }

  categoryPaletteCache.set(key, palette);
  return palette;
}

function buildCategoryShapes(shape?: ScatterPointShape): Float32Array {
  const shapes = new Float32Array(SCATTER_CATEGORY_STYLE_LIMIT);
  const uniform = shape !== undefined ? shapeToFloat(shape) : undefined;

  for (let index = 0; index < SCATTER_CATEGORY_STYLE_LIMIT; index += 1) {
    shapes[index] = uniform ?? shapeToFloat(DEFAULT_CATEGORY_SHAPES[index % DEFAULT_CATEGORY_SHAPES.length] ?? "circle");
  }

  return shapes;
}

function categoryFill(palette: Float32Array | undefined, categoryId: number | undefined): string | undefined {
  if (!palette || categoryId === undefined) {
    return undefined;
  }

  const index = (categoryId % SCATTER_CATEGORY_STYLE_LIMIT) * 4;
  const r = Math.round((palette[index] ?? 0) * 255);
  const g = Math.round((palette[index + 1] ?? 0) * 255);
  const b = Math.round((palette[index + 2] ?? 0) * 255);
  const a = palette[index + 3] ?? 1;

  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function categoryShape(shapes: Float32Array | undefined, categoryId: number | undefined): ScatterPointShape | undefined {
  if (!shapes || categoryId === undefined) {
    return undefined;
  }

  const value = shapes[categoryId % SCATTER_CATEGORY_STYLE_LIMIT] ?? 0;

  if (value < 0.5) return "circle";
  if (value < 1.5) return "square";
  if (value < 2.5) return "diamond";
  if (value < 3.5) return "triangle";
  if (value < 4.5) return "star";
  if (value < 5.5) return "cross";
  if (value < 6.5) return "x";
  return "polygon";
}

function buildDataSpaceGridIndex<TDatum>(
  rawPoints: Float32Array,
  meta: readonly ScatterHitMeta<TDatum>[],
  pointCount: number,
  dataMinX: number,
  dataMaxX: number,
  dataMinY: number,
  dataMaxY: number,
  radii: Float32Array | undefined
) {
  const xSpan = dataMaxX - dataMinX || 1;
  const ySpan = dataMaxY - dataMinY || 1;
  const columns = 128;
  const rows = 128;
  const cells: number[][] = Array.from({ length: columns * rows }, () => []);
  for (let index = 0; index < pointCount; index += 1) {
    const px = rawPoints[index * 2] ?? 0;
    const py = rawPoints[index * 2 + 1] ?? 0;
    const nx = (px - dataMinX) / xSpan;
    const ny = (py - dataMinY) / ySpan;
    const col = Math.max(0, Math.min(columns - 1, Math.floor(nx * columns)));
    const row = Math.max(0, Math.min(rows - 1, Math.floor(ny * rows)));
    cells[row * columns + col]?.push(index);
  }

  return (
    mx: number,
    my: number,
    pixelRadius: number,
    currentXDomain: readonly [number, number],
    currentYDomain: readonly [number, number],
    currentPlotArea: Rect
  ) => {
    const curXSpan = currentXDomain[1] - currentXDomain[0] || 1;
    const curYSpan = currentYDomain[1] - currentYDomain[0] || 1;

    const qx = currentXDomain[0] + ((mx - currentPlotArea.x) / currentPlotArea.width) * curXSpan;
    const qy = currentYDomain[0] + ((currentPlotArea.y + currentPlotArea.height - my) / currentPlotArea.height) * curYSpan;

    const qrx = (pixelRadius / currentPlotArea.width) * curXSpan;
    const qry = (pixelRadius / currentPlotArea.height) * curYSpan;

    const qnxMin = (qx - qrx - dataMinX) / xSpan;
    const qnxMax = (qx + qrx - dataMinX) / xSpan;
    const qnyMin = (qy - qry - dataMinY) / ySpan;
    const qnyMax = (qy + qry - dataMinY) / ySpan;

    const minCol = Math.max(0, Math.min(columns - 1, Math.floor(qnxMin * columns)));
    const maxCol = Math.max(0, Math.min(columns - 1, Math.floor(qnxMax * columns)));
    const minRow = Math.max(0, Math.min(rows - 1, Math.floor(qnyMin * rows)));
    const maxRow = Math.max(0, Math.min(rows - 1, Math.floor(qnyMax * rows)));

    let bestIndex = -1;
    let bestDistanceSq = Number.POSITIVE_INFINITY;

    for (let r = minRow; r <= maxRow; r += 1) {
      for (let c = minCol; c <= maxCol; c += 1) {
        const cell = cells[r * columns + c] ?? [];
        for (const idx of cell) {
          const px = rawPoints[idx * 2] ?? 0;
          const py = rawPoints[idx * 2 + 1] ?? 0;

          const sx = currentPlotArea.x + ((px - currentXDomain[0]) / curXSpan) * currentPlotArea.width;
          const sy = currentPlotArea.y + currentPlotArea.height - ((py - currentYDomain[0]) / curYSpan) * currentPlotArea.height;

          const dx = sx - mx;
          const dy = sy - my;
          const distSq = dx * dx + dy * dy;

          const ptRadius = radii ? (radii[idx] ?? pixelRadius) : pixelRadius;
          const hitRadius = Math.max(pixelRadius, ptRadius);

          if (distSq <= hitRadius * hitRadius && distSq <= bestDistanceSq) {
            bestDistanceSq = distSq;
            bestIndex = idx;
          }
        }
      }
    }

    if (bestIndex === -1) {
      return undefined;
    }

    const hitMeta = meta[bestIndex];
    if (!hitMeta) return undefined;

    const px = rawPoints[bestIndex * 2] ?? 0;
    const py = rawPoints[bestIndex * 2 + 1] ?? 0;
    const sx = currentPlotArea.x + ((px - currentXDomain[0]) / curXSpan) * currentPlotArea.width;
    const sy = currentPlotArea.y + currentPlotArea.height - ((py - currentYDomain[0]) / curYSpan) * currentPlotArea.height;

    return {
      x: sx,
      y: sy,
      ...(radii?.[bestIndex] !== undefined ? { radius: radii[bestIndex] } : {}),
      hitRadius: pixelRadius,
      meta: {
        ...hitMeta,
        xValue: px,
        yValue: py
      }
    };
  };
}

export function scatterMark<TDatum>(options: ScatterMarkOptions<TDatum>): Mark<TDatum> {
  return {
    kind: "scatter",
    encode(data, layout, theme): readonly Primitive[] {
      if (data.length === 0) {
        return [];
      }

      const metadata = scatterViewMetadata(data);
      const sourceCategoryIds = metadata.__categoryIds instanceof Float32Array
        ? metadata.__categoryIds
        : undefined;
      const inferredSeriesCategory = options.category === undefined &&
        data.length > 0 &&
        typeof data[0] === "object" &&
        data[0] !== null &&
        hasSeriesValue(data[0]);
      const categoryAccessor = options.category ?? (inferredSeriesCategory ? ("series" as Accessor<TDatum, string | number | undefined>) : undefined);
      const usesCategories = sourceCategoryIds !== undefined || categoryAccessor !== undefined;

      const xDomain = layout.dataWindow?.visibleX ?? layout.xDomain ?? options.xDomain ?? extent(data, options.x);
      const yDomain = layout.yDomain ?? options.yDomain ?? extent(data, options.y);
      const sizeDomain = options.size ? options.sizeDomain ?? extent(data, options.size) : undefined;

      const cacheKey = metadata.__rawPointsKey ?? metadata.__rawPoints ?? data;
      let cache = rawPointsCache.get(cacheKey);
      const hasRaw = metadata.__rawPoints instanceof Float32Array;
      const rawPoints = hasRaw ? metadata.__rawPoints! : new Float32Array(data.length * 2);
      const rawPointCount = hasRaw
        ? getPointCount(rawPoints) ?? rawPoints.length / 2
        : data.length;

      if (cache && hasRaw) {
        cache.points = rawPoints;
      }

      if (
        !cache ||
        (!hasRaw && cache.points.length !== data.length * 2) ||
        (usesCategories && !cache.categoryIds)
      ) {
        const rawRadii = options.size ? new Float32Array(data.length) : undefined;
        const rawCategoryIds = usesCategories && !hasRaw ? new Float32Array(data.length) : undefined;
        const categoryMap = new Map<string | number, number>();
        const meta: ScatterHitMeta<TDatum>[] = [];
        let minX = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;

        let writeIndex = 0;
        if (hasRaw) {
          const pointCount = rawPointCount;
          for (let index = 0; index < pointCount; index += 1) {
            const px = rawPoints[index * 2]!;
            const py = rawPoints[index * 2 + 1]!;

            meta[index] = {
              dataIndex: index,
              xValue: px,
              yValue: py,
              ...(sourceCategoryIds?.[index] !== undefined ? {
                categoryId: sourceCategoryIds[index],
                categoryValue: sourceCategoryIds[index]
              } : {})
            };

            if (px < minX) minX = px;
            if (px > maxX) maxX = px;
            if (py < minY) minY = py;
            if (py > maxY) maxY = py;
          }
          writeIndex = pointCount;
        } else {
          for (let index = 0; index < data.length; index += 1) {
            const datum = data[index] as TDatum;
            const xValue = readAccessor(options.x, datum, index);
            const yValue = readAccessor(options.y, datum, index);
            const sizeValue = options.size ? readAccessor(options.size, datum, index) : undefined;

            if (!Number.isFinite(xValue) || !Number.isFinite(yValue)) {
              continue;
            }

            rawPoints[writeIndex * 2] = xValue;
            rawPoints[writeIndex * 2 + 1] = yValue;

            if (rawRadii && sizeValue !== undefined) {
              rawRadii[writeIndex] = resolveBubbleRadius(sizeValue, sizeDomain, options.radiusRange);
            }

            let categoryId: number | undefined;
            let categoryValue: string | number | undefined;

            if (rawCategoryIds && categoryAccessor) {
              const value = readAccessor(categoryAccessor, datum, index);
              categoryId = resolveCategoryId(value, categoryMap);
              categoryValue = value;
              rawCategoryIds[writeIndex] = categoryId;
            }

            meta[writeIndex] = {
              datum,
              dataIndex: resolveDatumIndex(datum, index),
              xValue,
              yValue,
              ...(sizeValue !== undefined && Number.isFinite(sizeValue) ? { sizeValue } : {}),
              ...(categoryId !== undefined ? { categoryId } : {}),
              ...(categoryValue !== undefined ? { categoryValue } : {})
            };

            minX = Math.min(minX, xValue);
            maxX = Math.max(maxX, xValue);
            minY = Math.min(minY, yValue);
            maxY = Math.max(maxY, yValue);

            writeIndex += 1;
          }
        }

        const packedPoints = hasRaw ? rawPoints : rawPoints.slice(0, writeIndex * 2);
        const packedRadii = rawRadii ? rawRadii.slice(0, writeIndex) : undefined;
        const packedCategoryIds = hasRaw
          ? sourceCategoryIds
          : rawCategoryIds
            ? rawCategoryIds.slice(0, writeIndex)
            : undefined;
        const categoryCount = hasRaw
          ? (sourceCategoryIds ? getPointArrayCategoryCount(sourceCategoryIds) : 0)
          : categoryMap.size;
        const packedMeta = meta.slice(0, writeIndex);

        const indexMap = new Map<number, number>();
        for (let i = 0; i < packedMeta.length; i += 1) {
          const m = packedMeta[i];
          if (m) {
            indexMap.set(m.dataIndex, i);
          }
        }

        const rawXDomain = hasRaw ? getPointArrayXDomain(rawPoints) : undefined;
        const rawYDomain = hasRaw ? getPointArrayYDomain(rawPoints) : undefined;
        const fullXDomain = rawXDomain ?? [
          Number.isFinite(minX) ? minX : 0,
          Number.isFinite(maxX) ? maxX : 1
        ] as const;
        const fullYDomain = rawYDomain ?? [
          Number.isFinite(minY) ? minY : 0,
          Number.isFinite(maxY) ? maxY : 1
        ] as const;

        cache = {
          points: packedPoints,
          radii: packedRadii,
          categoryIds: packedCategoryIds,
          categoryCount,
          meta: packedMeta,
          indexMap,
          fullXDomain,
          fullYDomain,
          hitIndex: buildDataSpaceGridIndex(
            packedPoints,
            packedMeta,
            writeIndex,
            fullXDomain[0],
            fullXDomain[1],
            fullYDomain[0],
            fullYDomain[1],
            packedRadii
          ),
          hitIndexCount: writeIndex,
          pointCount: writeIndex,
          revealOrderCount: 0
        };
        rawPointsCache.set(cacheKey, cache);
      } else if (hasRaw && cache.pointCount !== rawPointCount) {
        appendRawCache(cache, cache.points, cache.pointCount, rawPointCount, sourceCategoryIds);
      }

      const activeCache = cache!;
      if (hasRaw && sourceCategoryIds) {
        activeCache.categoryIds = sourceCategoryIds;
        activeCache.categoryCount = getPointArrayCategoryCount(sourceCategoryIds) || activeCache.categoryCount;
      }

      // Estimate the actual visible count in O(1) based on the zoom ratio of the domains
      const xSpan = Math.max(Number.EPSILON, xDomain[1] - xDomain[0]);
      const ySpan = Math.max(Number.EPSILON, yDomain[1] - yDomain[0]);
      const fullXSpan = Math.max(Number.EPSILON, activeCache.fullXDomain[1] - activeCache.fullXDomain[0]);
      const fullYSpan = Math.max(Number.EPSILON, activeCache.fullYDomain[1] - activeCache.fullYDomain[0]);

      const animationProgress = layout.animation?.progress ?? 1;
      const animationProfile = layout.animation?.profile;
      const needsRevealOrder = (animationProfile === "random-fill" || animationProfile === "random-fill-grow") && animationProgress < 1;
       const zoomX = fullXSpan / xSpan;
      const zoomY = fullYSpan / ySpan;
      const zoomRatio = Math.max(zoomX, zoomY);

      const radius = resolveBaseRadius(options, zoomRatio);

      const baseOpacity = resolveScatterOpacity(options) ?? 1;
      const animated = resolveAnimatedScatterState({
        staticRadius: radius,
        staticOpacity: baseOpacity,
        profile: layout.animation?.profile,
        progress: layout.animation?.progress ?? 1,
        plotArea: layout.plotArea,
        ...(layout.clipArea ? { clipArea: layout.clipArea } : {})
      });
      const hoverInteraction = options.hoverInteraction ?? "crosshair";
      const maxRadius = options.size
        ? Math.max(...(options.radiusRange ?? [2, 10])) * (layout.animation?.profile === "rise" ? animated.radius / Math.max(radius, Number.EPSILON) : 1)
        : animated.radius;

      if (needsRevealOrder && activeCache.revealOrderCount !== activeCache.pointCount) {
        activeCache.revealOrder = buildScatterRevealOrder(activeCache.pointCount);
        activeCache.revealOrderCount = activeCache.pointCount;
      }

      const categoryPalette = activeCache.categoryIds && activeCache.categoryCount > 0
        ? buildCategoryPalette(theme.palette.series, theme.palette.foreground)
        : undefined;
      const categoryShapes = activeCache.categoryIds && activeCache.categoryCount > 0
        ? (options.varyCategoryShapes === false
          ? buildCategoryShapes(options.shape ?? "circle")
          : defaultCategoryShapes)
        : undefined;
      const hasCategoryStyles = activeCache.categoryIds !== undefined &&
        activeCache.categoryCount > 0 &&
        categoryPalette !== undefined &&
        categoryShapes !== undefined;
      const categoryStyleFields = hasCategoryStyles
        ? {
            categoryIds: activeCache.categoryIds!,
            categoryCount: activeCache.categoryCount,
            categoryPalette,
            categoryShapes
          }
        : undefined;

      const pointCloud: PointCloudPrimitive = {
        kind: "point-cloud",
        points: activeCache.points,
        pointCount: activeCache.pointCount,
        radius: animated.radius,
        staticRadius: radius,
        staticOpacity: baseOpacity,
        ...(needsRevealOrder && activeCache.revealOrder ? { revealOrder: activeCache.revealOrder } : {}),
        ...(activeCache.radii ? { radii: activeCache.radii } : {}),
        ...(categoryStyleFields ?? {}),
        shape: options.shape ?? "circle",
        fill: options.fill ?? theme.palette.series[0] ?? theme.palette.foreground,
        opacity: animated.opacity,
        hoverInteraction,
        hoverGrowRadius: options.hoverGrowRadius ?? 7,
        hoverOutline: options.hoverOutline ?? true,
        hoverCrosshairColor: theme.palette.foreground,
        clip: animated.clip,
        isRaw: true,
        xDomain,
        yDomain,
        plotArea: layout.plotArea,
        baseRadius: options.radius ?? 2,
        radiusScaleConfig: options.radiusScale,
        fullXDomain: activeCache.fullXDomain,
        fullYDomain: activeCache.fullYDomain,
        hover: { markType: "scatter" },
        lookup(this: PointCloudPrimitive, index) {
          const pointIdx = activeCache.indexMap.get(index);
          if (pointIdx === undefined) return undefined;

          const px = activeCache.points[pointIdx * 2] ?? 0;
          const py = activeCache.points[pointIdx * 2 + 1] ?? 0;
          const currentXDomain = this.xDomain ?? xDomain;
          const currentYDomain = this.yDomain ?? yDomain;
          const currentPlotArea = this.plotArea ?? layout.plotArea;

          const curXSpan = currentXDomain[1] - currentXDomain[0] || 1;
          const curYSpan = currentYDomain[1] - currentYDomain[0] || 1;

          const sx = currentPlotArea.x + ((px - currentXDomain[0]) / curXSpan) * currentPlotArea.width;
          const sy = currentPlotArea.y + currentPlotArea.height - ((py - currentYDomain[0]) / curYSpan) * currentPlotArea.height;
          const meta = activeCache.meta[pointIdx] as ScatterHitMeta<TDatum> | undefined;
          const fill = categoryFill(categoryPalette, meta?.categoryId);
          const shape = categoryShape(categoryShapes, meta?.categoryId);

          return {
            index,
            x: sx,
            y: sy,
            radius: activeCache.radii?.[pointIdx] ?? (this.radius ?? animated.radius),
            ...(fill ? { fill } : {}),
            ...(shape ? { shape } : {})
          };
        },
        hitTest(this: PointCloudPrimitive, x, y) {
          const currentXDomain = this.xDomain ?? xDomain;
          const currentYDomain = this.yDomain ?? yDomain;
          const currentPlotArea = this.plotArea ?? layout.plotArea;
          const currentRadius = this.radius ?? animated.radius;
          const searchRadius = options.hitRadius ?? Math.max(6, (activeCache.radii ? maxRadius : currentRadius) + 4);

          const hitIndex = ensureRawHitIndex(activeCache);
          const hit = hitIndex(
            x,
            y,
            searchRadius,
            currentXDomain,
            currentYDomain,
            currentPlotArea
          );

          if (!hit) {
            return undefined;
          }

          const hitMeta = hit.meta as ScatterHitMeta<TDatum>;
          const dataIndex = hitMeta.dataIndex;
          let datum = hitMeta.datum;
          if (!datum) {
            datum = data[dataIndex] as TDatum | undefined;
          }
          if (!datum && hasRaw) {
            datum = {
              x: hitMeta.xValue,
              y: hitMeta.yValue,
              index: dataIndex,
              count: 1,
              firstY: hitMeta.yValue,
              lastY: hitMeta.yValue,
              minY: hitMeta.yValue,
              maxY: hitMeta.yValue,
              ...(hitMeta.categoryValue !== undefined ? { series: hitMeta.categoryValue } : {})
            } as TDatum;
          }
          if (!datum) {
            return undefined;
          }

          const tooltipFill = categoryFill(categoryPalette, hitMeta.categoryId);
          const tooltipShape = categoryShape(categoryShapes, hitMeta.categoryId);
          const tooltip = resolveTooltip(
            options,
            { ...hitMeta, datum },
            dataIndex,
            tooltipFill && tooltipShape ? { color: tooltipFill, shape: tooltipShape } : undefined
          );

          return {
            index: dataIndex,
            x: hit.x,
            y: hit.y,
            radius: hit.radius ?? (this.radius ?? animated.radius),
            hitRadius: hit.hitRadius,
            ...(tooltipFill ? { fill: tooltipFill } : {}),
            ...(tooltipShape ? { shape: tooltipShape } : {}),
            ...(tooltip ? { tooltip } : {})
          };
        }
      };

      if (needsRevealOrder) {
        pointCloud.revealProgress = animationProgress;
        if (animationProfile === "random-fill-grow") {
          pointCloud.revealGrow = true;
        } else if (layout.animation?.randomFillFade) {
          pointCloud.revealFade = true;
        }
      }

      return [pointCloud];
    }
  };
}

export function appendRawCache(
  cache: ScatterRawCache,
  rawPoints: Float32Array,
  start: number,
  end: number,
  categoryIds?: Float32Array
): void {
  for (let index = start; index < end; index += 1) {
    const px = rawPoints[index * 2] ?? 0;
    const py = rawPoints[index * 2 + 1] ?? 0;
    const categoryId = categoryIds?.[index];

    cache.meta[index] = {
      dataIndex: index,
      xValue: px,
      yValue: py,
      ...(categoryId !== undefined ? {
        categoryId,
        categoryValue: categoryId
      } : {})
    };
    cache.indexMap.set(index, index);

    if (px < cache.fullXDomain[0] || px > cache.fullXDomain[1]) {
      cache.fullXDomain = [Math.min(cache.fullXDomain[0], px), Math.max(cache.fullXDomain[1], px)];
    }
    if (py < cache.fullYDomain[0] || py > cache.fullYDomain[1]) {
      cache.fullYDomain = [Math.min(cache.fullYDomain[0], py), Math.max(cache.fullYDomain[1], py)];
    }
  }

  const rawXDomain = getPointArrayXDomain(rawPoints);
  const rawYDomain = getPointArrayYDomain(rawPoints);

  if (rawXDomain) {
    cache.fullXDomain = rawXDomain;
  }
  if (rawYDomain) {
    cache.fullYDomain = rawYDomain;
  }

  cache.pointCount = end;
}

function ensureRawHitIndex(
  cache: ScatterRawCache
): ScatterRawCache["hitIndex"] {
  if (cache.hitIndexCount !== cache.pointCount) {
    cache.hitIndex = buildDataSpaceGridIndex(
      cache.points,
      cache.meta,
      cache.pointCount,
      cache.fullXDomain[0],
      cache.fullXDomain[1],
      cache.fullYDomain[0],
      cache.fullYDomain[1],
      cache.radii
    );
    cache.hitIndexCount = cache.pointCount;
  }

  return cache.hitIndex;
}

function hasSeriesValue(value: unknown): value is { series: string | number } {
  return typeof value === "object" &&
    value !== null &&
    "series" in value &&
    (typeof value.series === "string" || typeof value.series === "number");
}

function resolveTooltip<TDatum>(
  options: ScatterMarkOptions<TDatum>,
  meta: ScatterHitMeta<TDatum>,
  index: number,
  categoryMarker?: TooltipMarker
): TooltipContent | undefined {
  if (options.tooltip === false) {
    return undefined;
  }

  if (typeof options.tooltip === "function") {
    return normalizeTooltipResult(options.tooltip(meta.datum!, index));
  }

  if (meta.categoryValue !== undefined) {
    return {
      title: String(meta.categoryValue),
      ...(categoryMarker ? { titleMarker: categoryMarker } : {}),
      lines: [
        `X\t${formatValue(meta.xValue)}`,
        `Y\t${formatValue(meta.yValue)}`,
        ...(meta.sizeValue !== undefined ? [`Size\t${formatValue(meta.sizeValue)}`] : [])
      ]
    };
  }

  return {
    title: `Point ${index + 1}`,
    lines: [
      `X\t${formatValue(meta.xValue)}`,
      `Y\t${formatValue(meta.yValue)}`,
      ...(meta.sizeValue !== undefined ? [`Size\t${formatValue(meta.sizeValue)}`] : [])
    ]
  };
}

function normalizeTooltipResult(result: TooltipResult): TooltipContent {
  return Array.isArray(result) ? { lines: result as readonly string[] } : result as TooltipContent;
}

function resolveBaseRadius<TDatum>(
  options: ScatterMarkOptions<TDatum>,
  zoomRatio: number
): number {
  const baseRadius = options.radius ?? 2;

  if (options.size || options.radiusScale === false) {
    return baseRadius;
  }

  const config = typeof options.radiusScale === "object" ? options.radiusScale : {};
  const maxScale = config.maxScale ?? 3.5;
  const scale = Math.min(maxScale, Math.max(1, Math.pow(zoomRatio, 0.55)));

  return baseRadius * scale;
}

function resolveBubbleRadius(
  value: number | undefined,
  domain: readonly [number, number] | undefined,
  range: readonly [number, number] = [2, 10]
): number {
  if (value === undefined || !Number.isFinite(value) || !domain) {
    return range[0];
  }

  const span = domain[1] - domain[0] || 1;
  const t = clamp((value - domain[0]) / span, 0, 1);
  const areaT = Math.sqrt(t);

  return range[0] + (range[1] - range[0]) * areaT;
}

function extent<TDatum>(data: readonly TDatum[], accessor: Accessor<TDatum, number>): readonly [number, number] {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < data.length; index += 1) {
    const value = readAccessor(accessor, data[index] as TDatum, index);

    if (Number.isFinite(value)) {
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return [0, 1];
  }

  return min === max ? [min, min + 1] : [min, max];
}

function resolveDatumIndex<TDatum>(datum: TDatum, fallback: number): number {
  const index = typeof datum === "object" && datum !== null && "index" in datum
    ? Number((datum as { index: unknown }).index)
    : fallback;

  return Number.isFinite(index) ? index : fallback;
}

function formatValue(value: number): string {
  return Math.abs(value) >= 1000 || Math.abs(value) < 0.01 && value !== 0
    ? value.toPrecision(4)
    : Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function resolveScatterOpacity<TDatum>(options: ScatterMarkOptions<TDatum>): number | undefined {
  if (options.opacity !== undefined) {
    return options.opacity;
  }

  if (options.pointStyle === "translucent") {
    return 0.72;
  }

  return 1;
}
