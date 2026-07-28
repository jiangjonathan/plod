export type ParsedRgba = readonly [number, number, number, number];

const namedColors = new Map<string, ParsedRgba>([
  ["black", [0, 0, 0, 1]],
  ["white", [1, 1, 1, 1]],
  ["transparent", [0, 0, 0, 0]]
]);

export function parseCssColor(color: string): ParsedRgba | undefined {
  const trimmed = color.trim();
  const named = namedColors.get(trimmed.toLowerCase());
  if (named) {
    return named;
  }

  return parseRgbColor(trimmed) ?? parseHexColor(trimmed) ?? parseOklchColor(trimmed);
}

function parseRgbColor(color: string): ParsedRgba | undefined {
  const match = /^rgba?\((.*)\)$/i.exec(color);
  if (!match) {
    return undefined;
  }

  const body = match[1]!.trim();
  const [channelsPart, alphaPart] = splitAlpha(body);
  const rawChannels = channelsPart.includes(",")
    ? channelsPart.split(",").map((part) => part.trim())
    : channelsPart.split(/\s+/).filter(Boolean);

  if (rawChannels.length < 3) {
    return undefined;
  }

  const red = parseRgbChannel(rawChannels[0]!);
  const green = parseRgbChannel(rawChannels[1]!);
  const blue = parseRgbChannel(rawChannels[2]!);
  const alpha = parseAlpha(alphaPart ?? rawChannels[3]) ?? 1;

  if (red === undefined || green === undefined || blue === undefined) {
    return undefined;
  }

  return [red, green, blue, alpha];
}

function parseHexColor(color: string): ParsedRgba | undefined {
  let hex = color;
  if (hex.startsWith("#")) {
    hex = hex.slice(1);
  }

  if (!/^[\da-f]{3,8}$/i.test(hex) || (hex.length !== 3 && hex.length !== 4 && hex.length !== 6 && hex.length !== 8)) {
    return undefined;
  }

  const normalized = hex.length === 3 || hex.length === 4
    ? hex.split("").map((part) => part + part).join("")
    : hex;

  const red = Number.parseInt(normalized.slice(0, 2), 16) / 255;
  const green = Number.parseInt(normalized.slice(2, 4), 16) / 255;
  const blue = Number.parseInt(normalized.slice(4, 6), 16) / 255;
  const alpha = normalized.length === 8 ? Number.parseInt(normalized.slice(6, 8), 16) / 255 : 1;

  return [red, green, blue, alpha];
}

function parseOklchColor(color: string): ParsedRgba | undefined {
  const match = /^oklch\((.*)\)$/i.exec(color);
  if (!match) {
    return undefined;
  }

  const [channelsPart, alphaPart] = splitAlpha(match[1]!.trim());
  const rawChannels = channelsPart.split(/\s+/).filter(Boolean);
  if (rawChannels.length < 3) {
    return undefined;
  }

  const lightness = parseLightness(rawChannels[0]!);
  const chroma = parseChroma(rawChannels[1]!);
  const hue = parseHue(rawChannels[2]!);
  const alpha = parseAlpha(alphaPart) ?? 1;

  if (lightness === undefined || chroma === undefined || hue === undefined) {
    return undefined;
  }

  return oklchToSrgb(lightness, chroma, hue, alpha);
}

function splitAlpha(body: string): readonly [string, string | undefined] {
  const slashIndex = body.indexOf("/");
  if (slashIndex === -1) {
    return [body, undefined];
  }

  return [body.slice(0, slashIndex).trim(), body.slice(slashIndex + 1).trim()];
}

function parseRgbChannel(value: string): number | undefined {
  if (value.endsWith("%")) {
    const percent = Number(value.slice(0, -1));
    return Number.isFinite(percent) ? clamp01(percent / 100) : undefined;
  }

  const channel = Number(value);
  return Number.isFinite(channel) ? clamp01(channel / 255) : undefined;
}

function parseLightness(value: string): number | undefined {
  if (value.endsWith("%")) {
    const percent = Number(value.slice(0, -1));
    return Number.isFinite(percent) ? clamp01(percent / 100) : undefined;
  }

  const lightness = Number(value);
  return Number.isFinite(lightness) ? clamp01(lightness) : undefined;
}

function parseChroma(value: string): number | undefined {
  if (value.endsWith("%")) {
    const percent = Number(value.slice(0, -1));
    return Number.isFinite(percent) ? Math.max(0, percent / 250) : undefined;
  }

  const chroma = Number(value);
  return Number.isFinite(chroma) ? Math.max(0, chroma) : undefined;
}

function parseHue(value: string): number | undefined {
  const lower = value.toLowerCase();
  const raw = lower.endsWith("deg")
    ? Number(lower.slice(0, -3))
    : lower.endsWith("turn")
      ? Number(lower.slice(0, -4)) * 360
      : lower.endsWith("rad")
        ? Number(lower.slice(0, -3)) * 180 / Math.PI
        : Number(lower);

  return Number.isFinite(raw) ? raw : undefined;
}

function parseAlpha(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.endsWith("%")) {
    const percent = Number(trimmed.slice(0, -1));
    return Number.isFinite(percent) ? clamp01(percent / 100) : undefined;
  }

  const alpha = Number(trimmed);
  return Number.isFinite(alpha) ? clamp01(alpha) : undefined;
}

function oklchToSrgb(lightness: number, chroma: number, hueDegrees: number, alpha: number): ParsedRgba {
  const hueRadians = hueDegrees * Math.PI / 180;
  const a = chroma * Math.cos(hueRadians);
  const b = chroma * Math.sin(hueRadians);

  const lPrime = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mPrime = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sPrime = lightness - 0.0894841775 * a - 1.2914855480 * b;

  const l = lPrime ** 3;
  const m = mPrime ** 3;
  const s = sPrime ** 3;

  const redLinear = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const greenLinear = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const blueLinear = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;

  return [
    linearSrgbToSrgb(redLinear),
    linearSrgbToSrgb(greenLinear),
    linearSrgbToSrgb(blueLinear),
    alpha
  ];
}

function linearSrgbToSrgb(value: number): number {
  const clamped = clamp01(value);
  return clamped <= 0.0031308
    ? 12.92 * clamped
    : 1.055 * (clamped ** (1 / 2.4)) - 0.055;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
