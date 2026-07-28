export type PointArrayMetadata = {
  __pointCount?: number;
  __dirtyStart?: number;
  __version?: number;
  __xDomain?: readonly [number, number];
  __yDomain?: readonly [number, number];
  __categoryCount?: number;
};

export type ScatterViewMetadata = {
  __rawPointsKey?: object;
  __rawPoints?: Float32Array;
  __categoryIds?: Float32Array;
};

export function pointArrayMetadata(points: Float32Array): Float32Array & PointArrayMetadata {
  return points as Float32Array & PointArrayMetadata;
}

export function scatterViewMetadata<TDatum>(data: readonly TDatum[]): readonly TDatum[] & ScatterViewMetadata {
  return data as readonly TDatum[] & ScatterViewMetadata;
}

export function getPointCount(points: Float32Array): number | undefined {
  return pointArrayMetadata(points).__pointCount;
}

export function getPointArrayVersion(points: Float32Array): number {
  return pointArrayMetadata(points).__version ?? 0;
}

export function getPointArrayDirtyStart(points: Float32Array): number {
  return pointArrayMetadata(points).__dirtyStart ?? 0;
}

export function getPointArrayCategoryCount(points: Float32Array): number {
  return pointArrayMetadata(points).__categoryCount ?? 0;
}

export function getPointArrayXDomain(points: Float32Array): readonly [number, number] | undefined {
  return pointArrayMetadata(points).__xDomain;
}

export function getPointArrayYDomain(points: Float32Array): readonly [number, number] | undefined {
  return pointArrayMetadata(points).__yDomain;
}

export function setPointArrayDirtyStart(points: Float32Array, dirtyStart: number): void {
  pointArrayMetadata(points).__dirtyStart = dirtyStart;
}

export function setPointArrayMetadata(
  points: Float32Array,
  metadata: PointArrayMetadata
): void {
  Object.assign(pointArrayMetadata(points), metadata);
}

export function setScatterViewMetadata<TDatum>(
  data: readonly TDatum[],
  metadata: ScatterViewMetadata
): void {
  Object.assign(scatterViewMetadata(data), metadata);
}
