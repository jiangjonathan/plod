export function findXAtLength(
  points: readonly [number, number][],
  curve: string,
  targetLength: number
): number {
  if (points.length === 0) return 0;
  if (points.length === 1) return points[0]![0];

  let accumLength = 0;
  for (let i = 1; i < points.length; i++) {
    const p0 = points[i - 1]!;
    const p1 = points[i]!;
    const dx = p1[0] - p0[0];
    const dy = p1[1] - p0[1];
    const segmentLength = curve === "step" || curve === "step-before" || curve === "step-after"
      ? Math.abs(dx) + Math.abs(dy)
      : Math.sqrt(dx * dx + dy * dy);

    if (accumLength + segmentLength >= targetLength) {
      const segmentProgress = segmentLength > 0 ? (targetLength - accumLength) / segmentLength : 0;
      return p0[0] + dx * segmentProgress;
    }
    accumLength += segmentLength;
  }
  return points[points.length - 1]![0];
}

export function calculatePathLength(points: readonly [number, number][], curve: string): number {
  if (points.length < 2) return 0;

  if (curve === "linear") {
    return calculateLinearLength(points);
  }

  if (curve === "step" || curve === "step-before" || curve === "step-after") {
    let length = 0;
    for (let i = 1; i < points.length; i++) {
      const p1 = points[i]!;
      const p0 = points[i - 1]!;
      length += Math.abs(p1[0] - p0[0]) + Math.abs(p1[1] - p0[1]);
    }
    return length || 1;
  }

  if (points.length < 3) {
    return calculateLinearLength(points);
  }

  if (curve === "monotone-x") {
    return calculateMonotoneLength(points);
  }

  return calculateCatmullRomLikeLength(points, curve);
}

function calculateLinearLength(points: readonly [number, number][]): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    const p1 = points[i]!;
    const p0 = points[i - 1]!;
    const dx = p1[0] - p0[0];
    const dy = p1[1] - p0[1];
    length += Math.sqrt(dx * dx + dy * dy);
  }
  return length || 1;
}

function calculateMonotoneLength(points: readonly [number, number][]): number {
  const slopes: number[] = [];
  const tangents: number[] = [];
  let length = 0;

  for (let index = 0; index < points.length - 1; index += 1) {
    const p0 = points[index]!;
    const p1 = points[index + 1]!;
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

  for (let index = 0; index < slopes.length; index += 1) {
    const p0 = points[index]!;
    const p1 = points[index + 1]!;
    const dx = p1[0] - p0[0];
    if (dx === 0) {
      length += Math.abs(p1[1] - p0[1]);
      continue;
    }

    const cp1: [number, number] = [
      p0[0] + dx / 3,
      p0[1] + (tangents[index] ?? 0) * dx / 3
    ];
    const cp2: [number, number] = [
      p1[0] - dx / 3,
      p1[1] - (tangents[index + 1] ?? 0) * dx / 3
    ];

    length += estimateCubicBezierLength(p0, cp1, cp2, p1);
  }

  return length || 1;
}

function calculateCatmullRomLikeLength(points: readonly [number, number][], curve: string): number {
  const tension = curve === "basis" ? 1 : 0;
  const scale = (1 - tension) / 6;
  let length = 0;

  if (scale <= 0) {
    return calculateLinearLength(points);
  }

  for (let index = 0; index < points.length - 1; index += 1) {
    const p0 = points[Math.max(0, index - 1)]!;
    const p1 = points[index]!;
    const p2 = points[index + 1]!;
    const p3 = points[Math.min(points.length - 1, index + 2)]!;

    const cp1: [number, number] = [
      p1[0] + (p2[0] - p0[0]) * scale,
      p1[1] + (p2[1] - p0[1]) * scale
    ];
    const cp2: [number, number] = [
      p2[0] - (p3[0] - p1[0]) * scale,
      p2[1] - (p3[1] - p1[1]) * scale
    ];

    length += estimateCubicBezierLength(p1, cp1, cp2, p2);
  }

  return length || 1;
}

function getCubicBezierPoint(
  t: number,
  p0: readonly [number, number],
  p1: readonly [number, number],
  p2: readonly [number, number],
  p3: readonly [number, number]
): [number, number] {
  const mt = 1 - t;
  const mt2 = mt * mt;
  const mt3 = mt2 * mt;
  const t2 = t * t;
  const t3 = t2 * t;

  return [
    mt3 * p0[0] + 3 * mt2 * t * p1[0] + 3 * mt * t2 * p2[0] + t3 * p3[0],
    mt3 * p0[1] + 3 * mt2 * t * p1[1] + 3 * mt * t2 * p2[1] + t3 * p3[1]
  ];
}

function estimateCubicBezierLength(
  p0: readonly [number, number],
  p1: readonly [number, number],
  p2: readonly [number, number],
  p3: readonly [number, number]
): number {
  let length = 0;
  let prev = p0;
  const steps = 8;

  for (let i = 1; i <= steps; i++) {
    const curr = getCubicBezierPoint(i / steps, p0, p1, p2, p3);
    const dx = curr[0] - prev[0];
    const dy = curr[1] - prev[1];
    length += Math.sqrt(dx * dx + dy * dy);
    prev = curr;
  }

  return length;
}
