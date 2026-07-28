import type { AxesSpec, AxisSpec, AxisTitleSpec, ChartTitleSpec, Size, PlotSpec } from "../core/types";
import type { Theme } from "../themes/types";
import type { Layout } from "./types";

/** Matches default .plot-settings-btn size in createPlot styles. */
export const PLOT_CONTROL_BUTTON_SIZE = 28;
/** Padding on each side of a control when centering it in the gutter. */
export const PLOT_CONTROL_GUTTER_PAD = 10;
/** Minimum gutter so a control sits centered without overlapping the plot. */
export const PLOT_CONTROL_GUTTER =
  PLOT_CONTROL_BUTTON_SIZE + PLOT_CONTROL_GUTTER_PAD * 2;
const MIN_AUTO_PLOT_AREA_SIZE = 32;
/** Gap between the outer edge of tick labels and the axis title. */
const AXIS_TITLE_LABEL_GAP = 10;
/** Breathing room past the far edge of an axis title. */
const AXIS_TITLE_OUTER_PAD = 8;

export function computeLayout(
  size: Size,
  theme: Theme,
  axes?: AxesSpec,
  plotPadding?: PlotSpec["plotPadding"],
  title?: PlotSpec["title"],
  hiddenSeries?: Set<string | number>
): Layout {
  const resolvedTitle = resolveChartTitle(title);
  const yOnRight = axes?.y?.position === "right";
  const xLabelOverhang = resolveXAxisHorizontalOverhang(theme, axes?.x);
  const defaultTop = theme.spacing.plotMargin.top + titleMargin(resolvedTitle, "top", theme) + axisTitleMargin(axes?.x?.title, "top", theme);
  const defaultBottom = theme.spacing.plotMargin.bottom + titleMargin(resolvedTitle, "bottom", theme);
  const yTopOverhang = resolveYAxisVerticalOverhang(theme, axes?.y, "top");
  const yBottomOverhang = resolveYAxisVerticalOverhang(theme, axes?.y, "bottom");

  const top = Math.max(plotPadding?.top ?? 0, defaultTop, yTopOverhang);
  const maxAutoBottom = Math.max(defaultBottom, Math.floor(size.height - top - MIN_AUTO_PLOT_AREA_SIZE));
  const bottom = Math.max(
    plotPadding?.bottom ?? 0,
    yBottomOverhang,
    resolveBottomMargin(
      theme,
      axes,
      defaultBottom,
      maxAutoBottom
    )
  );

  // Y-label side, x-label overhang, and (on the chrome side) room to center controls.
  const yLeft = resolveVerticalAxisMargin(size, theme, axes?.y, theme.spacing.plotMargin.left, "left");
  const yRight = resolveVerticalAxisMargin(size, theme, axes?.y, theme.spacing.plotMargin.right, "right");

  const requiredLeft = yOnRight
    ? Math.max(xLabelOverhang, PLOT_CONTROL_GUTTER)
    : Math.max(yLeft, xLabelOverhang);
  const requiredRight = yOnRight
    ? Math.max(yRight, xLabelOverhang)
    : Math.max(xLabelOverhang, PLOT_CONTROL_GUTTER);

  // Explicit plotPadding wins as a floor, but never undercut labels/chrome.
  const left = Math.max(plotPadding?.left ?? 0, requiredLeft);
  const right = Math.max(plotPadding?.right ?? 0, requiredRight);

  return {
    size,
    plotArea: {
      x: left,
      y: top,
      width: Math.max(0, size.width - left - right),
      height: Math.max(0, size.height - top - bottom)
    },
    renderDistance: {
      enabled: true,
      minDensity: 1.5,
      lineSamplesPerPixel: 2,
      pointCellSize: 6
    },
    ...(hiddenSeries ? { hiddenSeries } : {})
  };
}

/**
 * Distance from the plot-area edge to the axis-title anchor, clearing tick labels.
 * Honors an explicit title.offset when provided; offsetX/offsetY remain fine-tune nudges.
 */
export function resolveAxisTitlePlotOffset(
  theme: Theme,
  axis: AxisSpec | undefined,
  side: "left" | "right" | "bottom" | "top"
): number {
  const title = normalizeAxisTitle(axis?.title);
  if (!title?.text) {
    return 0;
  }

  if (title.offset !== undefined) {
    return title.offset;
  }

  const fontSize = resolveTitleFontSize(title, theme, 1);
  if (side === "left" || side === "right") {
    const labelBand = resolveVerticalTickLabelBand(theme, axis, side);
    // Rotated title is centered on this x; half the em-box clears past the labels.
    return Math.ceil(labelBand + AXIS_TITLE_LABEL_GAP + fontSize / 2);
  }

  const labelBand = resolveHorizontalTickLabelBand(theme, axis, side);
  return Math.ceil(labelBand + AXIS_TITLE_LABEL_GAP);
}

function resolveChartTitle(title: PlotSpec["title"]): ChartTitleSpec | undefined {
  if (!title) {
    return undefined;
  }

  return typeof title === "string" ? { text: title } : title;
}

function normalizeAxisTitle(title: AxisTitleSpec | string | undefined): AxisTitleSpec | undefined {
  if (!title) {
    return undefined;
  }

  return typeof title === "string" ? { text: title } : title;
}

function titleMargin(title: ChartTitleSpec | undefined, position: "top" | "bottom", theme: Theme): number {
  if (!title?.text || (title.position ?? "top") !== position) {
    return 0;
  }

  return Math.ceil(resolveTitleFontSize(title, theme, 1.25) * 2 + Math.max(0, title.offset ?? title.offsetY ?? 0));
}

function axisTitleMargin(
  title: AxisTitleSpec | string | undefined,
  position: "bottom" | "top" | "left" | "right",
  theme: Theme
): number {
  const titleSpec = normalizeAxisTitle(title);
  if (!titleSpec?.text) {
    return 0;
  }

  const defaultPosition = position === "top" || position === "bottom" ? "bottom" : position;
  const resolvedPosition = titleSpec.position ?? defaultPosition;
  // Top x-titles only contribute when explicitly requested on top.
  if (position === "top") {
    if (titleSpec.position !== "top") {
      return 0;
    }
  } else if (resolvedPosition !== position) {
    return 0;
  }

  const fontSize = resolveTitleFontSize(titleSpec, theme, 1);
  if (titleSpec.offset !== undefined) {
    return Math.ceil(fontSize + Math.max(0, titleSpec.offset));
  }

  return Math.ceil(AXIS_TITLE_LABEL_GAP + fontSize + AXIS_TITLE_OUTER_PAD);
}

function resolveTitleFontSize(title: ChartTitleSpec | AxisTitleSpec, theme: Theme, scale: number): number {
  return title.fontSize ?? Math.round(theme.typography.fontSize * scale);
}

function resolveBottomMargin(
  theme: Theme,
  axes: AxesSpec | undefined,
  defaultBottom: number,
  maxBottom: number
): number {
  const axis = axes?.x;

  if (!axis || axis.position !== "bottom") {
    return defaultBottom;
  }

  const labelBand = resolveHorizontalTickLabelBand(theme, axis, "bottom");
  const title = normalizeAxisTitle(axis.title);
  const titlePosition = title?.position ?? "bottom";
  const titleBand = title?.text && titlePosition === "bottom"
    ? axisTitleMargin(axis.title, "bottom", theme)
    : 0;
  const requested = Math.ceil(labelBand + titleBand + (titleBand > 0 ? 0 : 8));

  return Math.min(maxBottom, Math.max(defaultBottom, requested));
}

/** Space from plot edge → tick → label gap → label → title gap → title → outer pad. */
function resolveVerticalAxisMargin(
  size: Size,
  theme: Theme,
  axis: AxesSpec["y"] | undefined,
  defaultMargin: number,
  side: "left" | "right"
): number {
  if (!axis || axis.position !== side) {
    return defaultMargin;
  }

  const labelBand = resolveVerticalTickLabelBand(theme, axis, side);
  const title = normalizeAxisTitle(axis.title);
  const titlePosition = title?.position ?? side;
  const titleBand = title?.text && titlePosition === side
    ? axisTitleMargin(axis.title, side, theme)
    : AXIS_TITLE_OUTER_PAD;
  const requested = Math.ceil(labelBand + titleBand);
  const maxMargin = Math.max(defaultMargin, Math.floor(size.width * 0.45));

  return Math.min(maxMargin, Math.max(defaultMargin, requested));
}

function resolveVerticalTickLabelBand(
  theme: Theme,
  axis: AxisSpec | undefined,
  side: "left" | "right"
): number {
  if (!axis) {
    return 0;
  }

  const tickReserve = axis.ticks === false ? 0 : (axis.tickSize ?? 6);
  const labelGap = 4;
  const angle = axis.labelAngle ?? 0;
  const domain = axis.kind === "linear" ? (axis.baseDomain ?? axis.domain) : undefined;
  const labels = axis.kind === "band"
    ? sampleLabels(axis.labels)
    : estimateLinearAxisLabels(axis, domain);
  const align = side === "right" ? "left" : "right";
  const maxLabelWidth = labels.reduce(
    (max, label) => Math.max(max, estimateTextBoxExtents(label, theme, angle, align, "middle")[side]),
    0
  );
  return tickReserve + labelGap + maxLabelWidth;
}

function resolveHorizontalTickLabelBand(
  theme: Theme,
  axis: AxisSpec | undefined,
  side: "bottom" | "top"
): number {
  if (!axis) {
    return 0;
  }

  const tickReserve = axis.ticks === false ? 0 : (axis.tickSize ?? 6);
  const angle = axis.labelAngle ?? 0;
  const labelOffset = side === "bottom" ? resolveBottomLabelOffset(angle, theme) : theme.typography.fontSize;
  const domain = axis.kind === "linear" ? (axis.baseDomain ?? axis.domain) : undefined;
  const labels = axis.kind === "band"
    ? sampleLabels(axis.labels)
    : estimateLinearEndLabels(axis, domain);
  const align = side === "bottom" ? resolveBottomLabelAlign(angle) : "center";
  const baseline = side === "bottom" ? resolveBottomLabelBaseline(angle) : "bottom";
  const maxLabelExtent = labels.reduce(
    (max, label) => Math.max(max, estimateTextBoxExtents(label, theme, angle, align, baseline)[side]),
    0
  );
  return tickReserve + labelOffset + maxLabelExtent;
}

/** Half-width of end x labels so they are not clipped when centered on the plot edge. */
function resolveXAxisHorizontalOverhang(theme: Theme, axis: AxesSpec["x"] | undefined): number {
  if (!axis || axis.position !== "bottom") {
    return Math.ceil(theme.typography.fontSize * 2);
  }

  const angle = axis.labelAngle ?? 0;
  const align = resolveBottomLabelAlign(angle);
  const baseline = resolveBottomLabelBaseline(angle);
  if (axis.kind === "band") {
    const sample = sampleLabels(axis.labels);
    const maxOverhang = sample.reduce(
      (max, label) => {
        const extents = estimateTextBoxExtents(label, theme, angle, align, baseline);
        return Math.max(max, extents.left, extents.right);
      },
      0
    );
    return Math.ceil(maxOverhang) + 8;
  }

  const domain = axis.baseDomain ?? axis.domain;
  const endLabels = estimateLinearEndLabels(axis, domain);
  const maxOverhang = endLabels.reduce(
    (max, label) => {
      const extents = estimateTextBoxExtents(label, theme, angle, align, baseline);
      return Math.max(max, extents.left, extents.right);
    },
    0
  );
  return Math.ceil(maxOverhang) + 8;
}

function resolveYAxisVerticalOverhang(
  theme: Theme,
  axis: AxesSpec["y"] | undefined,
  edge: "top" | "bottom"
): number {
  if (!axis || (axis.position !== "left" && axis.position !== "right")) {
    return 0;
  }

  const angle = axis.labelAngle ?? 0;
  if (angle === 0) {
    return 0;
  }

  const domain = axis.kind === "linear" ? (axis.baseDomain ?? axis.domain) : undefined;
  const labels = axis.kind === "band"
    ? sampleLabels(axis.labels)
    : estimateLinearAxisLabels(axis, domain);
  const align = axis.position === "right" ? "left" : "right";
  const maxOverhang = labels.reduce(
    (max, label) => Math.max(max, estimateTextBoxExtents(label, theme, angle, align, "middle")[edge]),
    0
  );

  return Math.ceil(maxOverhang + 8);
}

function estimateLinearEndLabels(
  axis: Extract<AxesSpec["x"] & {}, { kind: "linear" }> | Extract<AxesSpec["y"] & {}, { kind: "linear" }>,
  domain: readonly [number, number] | undefined
): readonly string[] {
  if (!domain) {
    return [""];
  }

  const format = (value: number) =>
    axis.labelFormatter ? axis.labelFormatter(value) : formatEstimate(value);

  if (axis.timeGranularity && !axis.labelFormatter) {
    return ["MMM 2026", "MMM 2026"];
  }

  return [format(domain[0]), format(domain[1])];
}

function estimateLinearAxisLabels(
  axis: Extract<AxesSpec["y"] & {}, { kind: "linear" }> | Extract<AxesSpec["x"] & {}, { kind: "linear" }>,
  domain: readonly [number, number] | undefined
): readonly string[] {
  if (!domain) {
    return [""];
  }

  const format = (value: number) =>
    axis.labelFormatter ? axis.labelFormatter(value) : formatEstimate(value);
  const [min, max] = domain;
  const mid = (min + max) / 2;
  return [format(min), format(mid), format(max)];
}

function sampleLabels(labels: readonly string[]): readonly string[] {
  const maxSamples = 128;

  if (labels.length <= maxSamples) {
    return labels;
  }

  const sampled: string[] = [];
  const step = Math.max(1, Math.floor(labels.length / (maxSamples - 2)));

  sampled.push(labels[0] ?? "");
  for (let index = step; index < labels.length - 1 && sampled.length < maxSamples - 1; index += step) {
    sampled.push(labels[index] ?? "");
  }
  sampled.push(labels[labels.length - 1] ?? "");

  return sampled;
}

function estimateTextWidth(text: string, theme: Theme): number {
  return text.length * theme.typography.fontSize * 0.7;
}

function resolveBottomLabelAlign(angle: number): CanvasTextAlign {
  return angle === 0 ? "center" : "left";
}

function resolveBottomLabelBaseline(angle: number): CanvasTextBaseline {
  if (angle === 0) {
    return "middle";
  }

  return Math.abs(angle) >= 80 ? "middle" : "top";
}

function resolveBottomLabelOffset(angle: number, theme: Theme): number {
  return angle === 0 ? theme.typography.fontSize : 4;
}

type TextBoxExtents = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

function estimateTextBoxExtents(
  text: string,
  theme: Theme,
  angle: number,
  align: CanvasTextAlign,
  baseline: CanvasTextBaseline
): TextBoxExtents {
  const width = estimateTextWidth(text, theme);
  const height = theme.typography.fontSize * 1.18;
  const [x0, x1] = horizontalTextBounds(width, align);
  const [y0, y1] = verticalTextBounds(height, baseline);
  const radians = angle * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const corners = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1]
  ] as const;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const [x, y] of corners) {
    const rotatedX = x * cos - y * sin;
    const rotatedY = x * sin + y * cos;
    minX = Math.min(minX, rotatedX);
    maxX = Math.max(maxX, rotatedX);
    minY = Math.min(minY, rotatedY);
    maxY = Math.max(maxY, rotatedY);
  }

  return {
    left: Math.max(0, -minX),
    right: Math.max(0, maxX),
    top: Math.max(0, -minY),
    bottom: Math.max(0, maxY)
  };
}

function horizontalTextBounds(width: number, align: CanvasTextAlign): readonly [number, number] {
  if (align === "center") {
    return [-width / 2, width / 2];
  }

  if (align === "right" || align === "end") {
    return [-width, 0];
  }

  return [0, width];
}

function verticalTextBounds(height: number, baseline: CanvasTextBaseline): readonly [number, number] {
  if (baseline === "middle") {
    return [-height / 2, height / 2];
  }

  if (baseline === "bottom" || baseline === "ideographic") {
    return [-height, 0];
  }

  return [0, height];
}

function formatEstimate(value: number): string {
  if (!Number.isFinite(value)) {
    return "";
  }

  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
