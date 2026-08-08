import type { TooltipContent } from "../core/types";
import type { Theme } from "../themes/types";

export type TooltipLayout = {
  width: number;
  height: number;
  paddingX: number;
  paddingY: number;
  lineHeight: number;
  lineGap: number;
  title?: string;
  lines: readonly string[];
};

const paddingX = 8;
const paddingY = 6;
const lineGap = 4;
const columnGap = 20;
import { SYSTEM_MONO_FONT_FAMILY } from "../themes/defaultTheme";

export const TOOLTIP_TITLE_MONO_FONT = SYSTEM_MONO_FONT_FAMILY;

export function layoutTooltip(
  content: TooltipContent,
  theme: Theme,
  titleFontMode: "mono" | "regular" = "mono",
  titleWeight: "regular" | "semibold" | "bold" = "semibold",
  tabularNumbers = true
): TooltipLayout {
  const title = content.title;
  const lines = content.lines;
  const font = `${theme.typography.fontSize}px ${theme.typography.fontFamily}`;
  const titleFontWeight = titleWeight === "regular" ? 400 : titleWeight === "bold" ? 700 : 600;
  const titleFont = `${titleFontWeight} ${theme.typography.fontSize}px ${titleFontMode === "mono" ? TOOLTIP_TITLE_MONO_FONT : theme.typography.fontFamily}`;
  const lineHeight = Math.ceil(theme.typography.fontSize * 1.35);
  const titlePair = title ? splitTooltipLine(title) : undefined;
  const titleWidth = titlePair
    ? measureText(titlePair.name, titleFont, tabularNumbers) +
      columnGap +
      measureText(titlePair.value, titleFont, tabularNumbers) +
      (content.titleMarker ? 14 : 0)
    : title
      ? measureText(title, titleFont, tabularNumbers) + (content.titleMarker ? 14 : 0)
      : 0;
  const widths = [
    ...(titleWidth > 0 ? [titleWidth] : []),
    ...lines.map((line, index) =>
      measureTooltipLine(
        line,
        font,
        title === undefined && index === 0,
        content.markers?.[index] !== undefined,
        tabularNumbers
      )
    )
  ];
  const lineCount = lines.length + (title ? 1 : 0);
  const contentHeight = lineCount * lineHeight + Math.max(0, lineCount - 1) * lineGap;

  const layout: TooltipLayout = {
    width: Math.ceil(Math.max(...widths, 0) + paddingX * 2 + 4),
    height: Math.ceil(contentHeight + paddingY * 2),
    paddingX,
    paddingY,
    lineHeight,
    lineGap,
    lines
  };

  if (title !== undefined) {
    layout.title = title;
  }

  return layout;
}

function measureTooltipLine(
  line: string,
  font: string,
  forcePlain: boolean,
  hasMarker: boolean,
  tabularNumbers: boolean
): number {
  const markerWidth = hasMarker ? 14 : 0;

  if (forcePlain) {
    return markerWidth + measureText(line, font, tabularNumbers);
  }

  const pair = splitTooltipLine(line);

  if (!pair) {
    return markerWidth + measureText(line, font, tabularNumbers);
  }

  return (
    markerWidth +
    measureText(pair.name, font, tabularNumbers) +
    columnGap +
    measureText(pair.value, font, tabularNumbers)
  );
}

export function splitTooltipLine(line: string): { name: string; value: string } | undefined {
  const separatorIndex = line.indexOf("\t");

  if (separatorIndex <= 0 || separatorIndex >= line.length - 1) {
    return undefined;
  }

  const name = line.slice(0, separatorIndex).trim();
  const value = line.slice(separatorIndex + 1).trim();

  if (!name || !value) {
    return undefined;
  }

  return { name, value };
}

function measureText(text: string, font: string, tabularNumbers: boolean): number {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");

  if (!context) {
    return text.length * 8;
  }

  context.font = font;
  // Canvas text metrics do not expose font-variant-numeric. Measuring every
  // digit as the same glyph keeps the box and value column stable when the
  // rendered tooltip uses tabular numerals.
  const measuredText = tabularNumbers ? text.replace(/\d/g, "0") : text;
  return context.measureText(measuredText).width;
}
