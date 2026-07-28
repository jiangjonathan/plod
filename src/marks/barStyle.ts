import type { BarMarkOptions } from "./barMark";

export function resolveBarFill<TDatum>(
  options: BarMarkOptions<TDatum>,
  palette: readonly string[],
  fallback: string,
  seriesIndex: number,
  categoryLabel?: string,
  seriesLabel?: string
): string {
  if (options.fills) {
    if (typeof options.fills === "function") {
      return options.fills(seriesIndex, categoryLabel, seriesLabel);
    }
    if (Array.isArray(options.fills) && options.fills[seriesIndex]) {
      return options.fills[seriesIndex] as string;
    }
  }

  if (options.fill !== undefined && !options.series) {
    return options.fill;
  }

  return palette[seriesIndex % Math.max(1, palette.length)] ?? options.fill ?? fallback;
}

export function lightenColor(color: string, amount: number): string {
  return mixColor(color, "#ffffff", amount);
}

export function darkenColor(color: string, amount: number): string {
  return mixColor(color, "#000000", amount);
}

const hexColorCache = new Map<string, readonly [number, number, number] | undefined>();
const mixColorCache = new Map<string, string>();
const MAX_COLOR_CACHE_ENTRIES = 256;

function parseHexColor(color: string): readonly [number, number, number] | undefined {
  const cached = hexColorCache.get(color);
  if (cached !== undefined || hexColorCache.has(color)) {
    return cached;
  }

  const trimmed = color.trim();
  const hex = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;

  if (!/^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(hex)) {
    setBoundedCacheValue(hexColorCache, color, undefined, MAX_COLOR_CACHE_ENTRIES);
    return undefined;
  }

  const normalized = hex.length === 3
    ? hex.split("").map((part) => part + part).join("")
    : hex;

  const result = [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16)
  ] as const;

  setBoundedCacheValue(hexColorCache, color, result, MAX_COLOR_CACHE_ENTRIES);
  return result;
}

function mixColor(color: string, target: string, amount: number): string {
  const key = `${color}:${target}:${amount}`;
  const cached = mixColorCache.get(key);
  if (cached) {
    return cached;
  }

  const sourceRgb = parseHexColor(color);
  const targetRgb = parseHexColor(target);

  if (!sourceRgb || !targetRgb) {
    setBoundedCacheValue(mixColorCache, key, color, MAX_COLOR_CACHE_ENTRIES);
    return color;
  }

  const t = Math.max(0, Math.min(1, amount));
  const mixed = [
    Math.round(sourceRgb[0] + ((targetRgb[0] ?? sourceRgb[0]) - sourceRgb[0]) * t),
    Math.round(sourceRgb[1] + ((targetRgb[1] ?? sourceRgb[1]) - sourceRgb[1]) * t),
    Math.round(sourceRgb[2] + ((targetRgb[2] ?? sourceRgb[2]) - sourceRgb[2]) * t)
  ];

  const result = `rgb(${mixed[0]}, ${mixed[1]}, ${mixed[2]})`;

  setBoundedCacheValue(mixColorCache, key, result, MAX_COLOR_CACHE_ENTRIES);
  return result;
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
