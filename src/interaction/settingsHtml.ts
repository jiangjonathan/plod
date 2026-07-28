import type { PlotSpec, AxesSpec } from "../core/types";
import { defaultTheme } from "../themes/defaultTheme";
import { resolveChartTitleSpec, resolveAxisTitleSpec } from "../core/createPlot";
import { DEFAULT_LINE_AREA_OPACITY, DEFAULT_LINE_STROKE_WIDTH } from "../marks/lineMark";
import { DEFAULT_AXIS_TICK_THICKNESS, DEFAULT_GRIDLINE_THICKNESS } from "../core/axes";
import { DEFAULT_BAR_CORNER_RADIUS_RATIO, DEFAULT_BAR_GAP_RATIO } from "../presets/barChart";

export interface SettingsHtmlContext<TDatum> {
  spec: PlotSpec<TDatum>;
  currentAxes: AxesSpec | undefined;
  markKind: string | undefined;
  presetOpts: any;
  fullscreenLabel: string;
  smoothedScalingEnabled: boolean;
  settingsSectionOpenAttr: (id: string) => string;
  escapeHtmlAttr: (str: string) => string;
}

export const SCATTER_SETTING_IDS = {
  shape: "set-scatter-shape",
  style: "set-scatter-style",
  hoverMode: "set-scatter-hover-mode",
  hoverGrow: "set-scatter-hover-grow"
} as const;

export function generateSettingsHtml<TDatum>(ctx: SettingsHtmlContext<TDatum>): string {
  const { spec, currentAxes, markKind, presetOpts, fullscreenLabel, smoothedScalingEnabled, settingsSectionOpenAttr, escapeHtmlAttr } = ctx;
  
  let chartSpecificHTML = "";

    if (markKind === "bar") {
      const orientation = presetOpts.orientation ?? "vertical";
      const groupedBars = presetOpts.series !== undefined;
      const gapRatio = presetOpts.gapRatio ?? DEFAULT_BAR_GAP_RATIO;
      const interBarGapRatio = presetOpts.interBarGapRatio ?? gapRatio;
      const interGroupGapRatio = presetOpts.interGroupGapRatio ?? gapRatio;
      const minBarWidth = presetOpts.minBarWidth ?? 2;
      const minGapWidth = presetOpts.minGapWidth ?? 2;
      const dynamicGap = presetOpts.dynamicGap === true;
      const dynamicGapStrength = presetOpts.dynamicGapStrength ?? 0.5;
      const appearance = presetOpts.appearance ?? {};
      const cornerRadiusRatio = appearance.cornerRadiusRatio ?? DEFAULT_BAR_CORNER_RADIUS_RATIO;
      const roundBottom = appearance.roundBottom === true;
      const layeredStack = appearance.layeredStack === true;
      const valueLabels = presetOpts.valueLabels !== undefined && presetOpts.valueLabels !== false;
      const hoverStyle = presetOpts.hoverStyle ?? "background-and-bar";

      chartSpecificHTML = `
        <details class="plot-settings-section" data-section="bar"${settingsSectionOpenAttr("bar")}>
          <summary class="plot-settings-section-title">Bar Chart Settings</summary>
          <div class="plot-settings-section-content">
            <div class="plot-settings-row">
              <label>Orientation</label>
              <select id="set-bar-orientation">
                <option value="vertical" ${orientation === "vertical" ? "selected" : ""}>Vertical</option>
                <option value="horizontal" ${orientation === "horizontal" ? "selected" : ""}>Horizontal</option>
              </select>
            </div>
            <div class="plot-settings-row">
              <label>Corner Radius (%)</label>
              <input type="number" id="set-bar-corners" min="0" max="50" step="1" value="${Math.round(cornerRadiusRatio * 100)}">
            </div>
            <div class="plot-settings-row">
              <label>Gap Ratio</label>
              <input type="number" id="set-bar-gap" min="0" max="0.95" step="0.05" value="${gapRatio}">
            </div>
            ${groupedBars ? `
            <div class="plot-settings-row">
              <label>Inner Bar Gap</label>
              <input type="number" id="set-bar-interbar-gap" min="0" max="0.8" step="0.05" value="${interBarGapRatio}">
            </div>
            <div class="plot-settings-row">
              <label>Group Gap</label>
              <input type="number" id="set-bar-intergroup-gap" min="0" max="0.8" step="0.05" value="${interGroupGapRatio}">
            </div>
            ` : ""}
            <div class="plot-settings-row">
              <label>Min Bar Width</label>
              <input type="number" id="set-bar-minwidth" min="0" max="100" value="${minBarWidth}">
            </div>
            <div class="plot-settings-row">
              <label>Min Gap Width</label>
              <input type="number" id="set-bar-mingap" min="0" max="100" value="${minGapWidth}">
            </div>
            <div class="plot-settings-row">
              <label>Dynamic Gaps</label>
              <input type="checkbox" id="set-bar-dynamic" ${dynamicGap ? "checked" : ""}>
            </div>
            <div class="plot-settings-row">
              <label>Gap Strength</label>
              <input type="number" id="set-bar-strength" min="0" max="1" step="0.05" value="${dynamicGapStrength}">
            </div>
            <div class="plot-settings-row">
              <label>Round Bottom</label>
              <input type="checkbox" id="set-bar-roundbottom" ${roundBottom ? "checked" : ""}>
            </div>
            <div class="plot-settings-row">
              <label>Layered Stack</label>
              <input type="checkbox" id="set-bar-layered" ${layeredStack ? "checked" : ""}>
            </div>
            <div class="plot-settings-row">
              <label>Value Labels</label>
              <input type="checkbox" id="set-bar-labels" ${valueLabels ? "checked" : ""}>
            </div>
            <div class="plot-settings-row">
              <label>Hover Style</label>
              <select id="set-bar-hoverstyle">
                <option value="background-and-bar" ${hoverStyle === "background-and-bar" ? "selected" : ""}>Background & Bar</option>
                <option value="background" ${hoverStyle === "background" ? "selected" : ""}>Background</option>
                <option value="bar" ${hoverStyle === "bar" ? "selected" : ""}>Bar</option>
                <option value="none" ${hoverStyle === "none" ? "selected" : ""}>None</option>
              </select>
            </div>
          </div>
        </details>
      `;
    } else if (markKind === "line") {
      const curve = presetOpts.curve ?? "linear";
      const area = presetOpts.area === true;
      const areaBaseline = presetOpts.areaBaseline === "zero" ? "zero" : "plot";
      const areaOverlap = presetOpts.areaOverlap ?? "blend";
      const areaOpacity = Number.isFinite(presetOpts.areaOpacity) ? presetOpts.areaOpacity : DEFAULT_LINE_AREA_OPACITY;
      const areaStroke = presetOpts.areaStroke !== false;
      const areaFill = typeof presetOpts.areaFill === "string" ? presetOpts.areaFill : "";
      const strokeWidth = Number.isFinite(presetOpts.strokeWidth) ? presetOpts.strokeWidth : DEFAULT_LINE_STROKE_WIDTH;
      const tooltipVisibleOnly = presetOpts.tooltipVisibleOnly === true;
      const lineFocus = presetOpts.lineFocus === true;

      chartSpecificHTML = `
        <details class="plot-settings-section" data-section="line"${settingsSectionOpenAttr("line")}>
          <summary class="plot-settings-section-title">Line Chart Settings</summary>
          <div class="plot-settings-section-content">
            <div class="plot-settings-row">
              <label>Curve Type</label>
              <select id="set-line-curve">
                <option value="linear" ${curve === "linear" ? "selected" : ""}>Linear</option>
                <option value="catmull-rom" ${curve === "catmull-rom" ? "selected" : ""}>Catmull-Rom</option>
                <option value="monotone-x" ${curve === "monotone-x" ? "selected" : ""}>Monotone X</option>
                <option value="basis" ${curve === "basis" ? "selected" : ""}>Basis</option>
                <option value="step" ${curve === "step" ? "selected" : ""}>Step</option>
                <option value="step-before" ${curve === "step-before" ? "selected" : ""}>Step Before</option>
                <option value="step-after" ${curve === "step-after" ? "selected" : ""}>Step After</option>
              </select>
            </div>
            <div class="plot-settings-row">
              <label>Area Fill</label>
              <input type="checkbox" id="set-line-area" ${area ? "checked" : ""}>
            </div>
            <div class="plot-settings-row">
              <label>Area Baseline</label>
              <select id="set-line-area-baseline">
                <option value="plot" ${areaBaseline === "plot" ? "selected" : ""}>Plot bottom</option>
                <option value="zero" ${areaBaseline === "zero" ? "selected" : ""}>Zero</option>
              </select>
            </div>
            <div class="plot-settings-row">
              <label>Area Opacity</label>
              <input type="number" id="set-line-area-opacity" min="0" max="1" step="0.05" value="${areaOpacity}">
            </div>
            <div class="plot-settings-row">
              <label>Area Overlap</label>
              <select id="set-line-area-overlap">
                <option value="blend" ${areaOverlap === "blend" ? "selected" : ""}>Blend colors</option>
                <option value="cover" ${areaOverlap === "cover" ? "selected" : ""}>Cover (no mix)</option>
                <option value="multiply" ${areaOverlap === "multiply" ? "selected" : ""}>Multiply</option>
                <option value="screen" ${areaOverlap === "screen" ? "selected" : ""}>Screen</option>
              </select>
            </div>
            <div class="plot-settings-row">
              <label>Area Fill Color</label>
              <input type="text" id="set-line-area-fill" placeholder="auto (series)" value="${areaFill}">
            </div>
            <div class="plot-settings-row">
              <label>Area Stroke</label>
              <input type="checkbox" id="set-line-area-stroke" ${areaStroke ? "checked" : ""}>
            </div>
            <div class="plot-settings-row">
              <label>Line Thickness</label>
              <input type="number" id="set-line-width" min="0.5" max="12" step="0.5" value="${strokeWidth}">
            </div>
            <div class="plot-settings-row">
              <label>Viewport Tooltips</label>
              <input type="checkbox" id="set-line-visible-tooltip" ${tooltipVisibleOnly ? "checked" : ""}>
            </div>
            <div class="plot-settings-row">
              <label>Line Focus</label>
              <input type="checkbox" id="set-line-focus" ${lineFocus ? "checked" : ""}>
            </div>
          </div>
        </details>
      `;
    } else if (markKind === "scatter") {
      const shape = presetOpts.shape ?? "circle";
      const pointStyle = presetOpts.pointStyle ?? "solid";
      const hoverInteraction = presetOpts.hoverInteraction ?? "grow";

      chartSpecificHTML = `
        <details class="plot-settings-section" data-section="scatter"${settingsSectionOpenAttr("scatter")}>
          <summary class="plot-settings-section-title">Scatter Settings</summary>
          <div class="plot-settings-section-content">
            <div class="plot-settings-row">
              <label>Point Shape</label>
              <select id="${SCATTER_SETTING_IDS.shape}">
                <option value="circle" ${shape === "circle" ? "selected" : ""}>Circle</option>
                <option value="square" ${shape === "square" ? "selected" : ""}>Square</option>
                <option value="diamond" ${shape === "diamond" ? "selected" : ""}>Diamond</option>
                <option value="triangle" ${shape === "triangle" ? "selected" : ""}>Triangle</option>
                <option value="star" ${shape === "star" ? "selected" : ""}>Star</option>
                <option value="polygon" ${shape === "polygon" ? "selected" : ""}>Polygon</option>
                <option value="cross" ${shape === "cross" || shape === "plus" ? "selected" : ""}>Cross</option>
                <option value="x" ${shape === "x" ? "selected" : ""}>X</option>
              </select>
            </div>
            <div class="plot-settings-row">
              <label>Point Style</label>
              <select id="${SCATTER_SETTING_IDS.style}">
                <option value="solid" ${pointStyle === "solid" ? "selected" : ""}>Solid</option>
                <option value="translucent" ${pointStyle === "translucent" ? "selected" : ""}>Translucent</option>
              </select>
            </div>
            <div class="plot-settings-row">
              <label>Hover Mode</label>
              <select id="${SCATTER_SETTING_IDS.hoverMode}">
                <option value="grow" ${hoverInteraction === "grow" ? "selected" : ""}>Grow</option>
                <option value="crosshair" ${hoverInteraction === "crosshair" ? "selected" : ""}>Crosshair</option>
              </select>
            </div>
            <div class="plot-settings-row">
              <label>Hover Grow Radius</label>
              <input type="number" id="${SCATTER_SETTING_IDS.hoverGrow}" min="0" step="1" value="${presetOpts.hoverGrowRadius ?? 7}">
            </div>
          </div>
        </details>
      `;
    }

    const interactions = (spec.interactions && typeof spec.interactions === "object") ? spec.interactions : {};
    const selectionEnabled = interactions.selection !== false;
    const zoomEnabled = interactions.zoom !== false;
    const panEnabled = interactions.pan !== false;
    const smoothPan = (interactions.pan && typeof interactions.pan === "object") ? (interactions.pan as any).smooth === true : true;
    const dragInteraction = (interactions as any).dragInteraction ?? "selection";
    const autoscaleEnabled = (interactions as any).focusMode === "index";
    const tooltipPos = spec.tooltip && typeof spec.tooltip === "object" ? spec.tooltip.position ?? "cursor" : "cursor";
    const tooltipTabularNumbers = spec.tooltip && typeof spec.tooltip === "object" ? spec.tooltip.tabularNumbers !== false : true;

    const xGridlines = currentAxes?.x?.gridlines !== false;
    const yGridlines = currentAxes?.y?.gridlines !== false;
    const xEdgeGridlines = currentAxes?.x?.edgeGridlines === true;
    const yEdgeGridlines = currentAxes?.y?.edgeGridlines === true;
    const xSubgridlines = currentAxes?.x?.subgridlines === true;
    const ySubgridlines = currentAxes?.y?.subgridlines === true;
    const xTicks = currentAxes?.x?.ticks !== false;
    const yTicks = currentAxes?.y?.ticks !== false;
    const xLine = currentAxes?.x?.line !== false;
    const yLine = currentAxes?.y?.line !== false;

    const xLabelAngle = currentAxes?.x?.labelAngle ?? 0;
    const yLabelAngle = currentAxes?.y?.labelAngle ?? 0;
    const xTickDensity = currentAxes?.x?.tickDensity ?? 1;
    const yTickDensity = currentAxes?.y?.tickDensity ?? 1;
    const xSubticks = currentAxes?.x?.subticks === true;
    const ySubticks = currentAxes?.y?.subticks === true;
    const xGridlineEvery = currentAxes?.x?.gridlineEvery ?? "";
    const yGridlineEvery = currentAxes?.y?.gridlineEvery ?? "";
    const gridlineThickness = currentAxes?.x?.gridlineThickness ?? currentAxes?.y?.gridlineThickness ?? DEFAULT_GRIDLINE_THICKNESS;
    const gridlineStyle = currentAxes?.x?.gridlineStyle ?? currentAxes?.y?.gridlineStyle ?? "solid";

    const themeBg = spec.theme?.palette?.background ?? defaultTheme.palette.background;
    const themePlotBg = spec.theme?.palette?.plotBackground ?? defaultTheme.palette.plotBackground ?? themeBg;
    const themeFg = spec.theme?.palette?.foreground ?? defaultTheme.palette.foreground;
    const themeGrid = spec.theme?.palette?.grid ?? defaultTheme.palette.grid;

    const animProfile = presetOpts.animationProfile ?? "rise";
    const randomFillFade = presetOpts.randomFillFade ?? true;
    const animDuration = spec.animationDuration ?? presetOpts.animationDuration ?? 900;
    const axisAnimProfile = presetOpts.axisAnimationProfile ?? spec.axisAnimation ?? "none";
    const axisAnimDuration = spec.axisAnimationDuration ?? presetOpts.axisAnimationDuration;
    const animEasing = spec.animationEasing ?? presetOpts.animationEasing ?? "auto";
    const axisAnimEasing = spec.axisAnimationEasing ?? presetOpts.axisAnimationEasing ?? "auto";

    const frameBorder = spec.frame && typeof spec.frame === "object" ? spec.frame.border === true : false;
    const plotBorderRadius = spec.frame && typeof spec.frame === "object" && spec.frame.cornerRadius !== undefined ? spec.frame.cornerRadius : 12;
    const plotBorderColor = (spec.frame && typeof spec.frame === "object" ? spec.frame.plotAreaStroke : undefined) ?? themeGrid;
    const chartBorderEnabled = spec.chartBorder?.enabled === true;
    const chartBorderRadius = spec.chartBorder?.radius ?? 12;
    const chartBorderColor = spec.chartBorder?.color ?? "#cbd5e1";
    const edgeBlurEnabled = spec.edgeBlur !== false && spec.edgeBlur !== undefined;
    const edgeBlurSpec = spec.edgeBlur && typeof spec.edgeBlur === "object" ? spec.edgeBlur : undefined;
    const edgeBlurLeft = edgeBlurSpec?.left !== false;
    const edgeBlurRight = edgeBlurSpec?.right !== false;
    const edgeBlurTop = edgeBlurSpec?.top !== false;
    const edgeBlurBottom = edgeBlurSpec?.bottom !== false;
    const edgeBlurSize = edgeBlurSpec?.size ?? 28;

    const xTickSize = currentAxes?.x?.tickSize ?? 6;
    const yTickSize = currentAxes?.y?.tickSize ?? 6;
    const xTickThickness = (currentAxes?.x as any)?.tickThickness ?? DEFAULT_AXIS_TICK_THICKNESS;
    const yTickThickness = (currentAxes?.y as any)?.tickThickness ?? DEFAULT_AXIS_TICK_THICKNESS;
    const yAxisPosition = currentAxes?.y?.position === "right" ? "right" : "left";

    const padTop = spec.plotPadding?.top !== undefined ? spec.plotPadding.top : "";
    const padRight = spec.plotPadding?.right !== undefined ? spec.plotPadding.right : "";
    const padBottom = spec.plotPadding?.bottom !== undefined ? spec.plotPadding.bottom : "";
    const padLeft = spec.plotPadding?.left !== undefined ? spec.plotPadding.left : "";
    const chartTitle = resolveChartTitleSpec(spec.title);
    const chartTitleEnabled = Boolean(chartTitle?.text);
    const chartTitleText = chartTitle?.text ?? "";
    const chartTitlePosition = chartTitle?.position ?? "top";
    const chartTitleAlign = chartTitle?.align ?? "center";
    const chartTitleFontSize = chartTitle?.fontSize ?? "";
    const chartTitleBold = chartTitle?.bold !== false;
    const chartTitleItalic = chartTitle?.italic === true;
    const titleAnimation = spec.titleAnimation ?? "none";
    const chartTitleOffsetX = chartTitle?.offsetX ?? "";
    const chartTitleOffsetY = chartTitle?.offsetY ?? chartTitle?.offset ?? "";
    const xAxisTitle = resolveAxisTitleSpec(currentAxes?.x?.title);
    const yAxisTitle = resolveAxisTitleSpec(currentAxes?.y?.title);
    const xAxisTitleEnabled = Boolean(xAxisTitle?.text);
    const yAxisTitleEnabled = Boolean(yAxisTitle?.text);
    const xAxisTitleText = xAxisTitle?.text ?? "";
    const yAxisTitleText = yAxisTitle?.text ?? "";
    const xAxisTitlePosition = xAxisTitle?.position ?? "bottom";
    const yAxisTitlePosition = yAxisTitle?.position ?? "left";
    const xAxisTitleAlign = xAxisTitle?.align ?? "center";
    const yAxisTitleAlign = yAxisTitle?.align ?? "center";
    const xAxisTitleFontSize = xAxisTitle?.fontSize ?? "";
    const yAxisTitleFontSize = yAxisTitle?.fontSize ?? "";
    const xAxisTitleBold = xAxisTitle?.bold === true;
    const yAxisTitleBold = yAxisTitle?.bold === true;
    const xAxisTitleItalic = xAxisTitle?.italic === true;
    const yAxisTitleItalic = yAxisTitle?.italic === true;
    const xAxisTitleOffsetX = xAxisTitle?.offsetX ?? "";
    const xAxisTitleOffsetY = xAxisTitle?.offsetY ?? xAxisTitle?.offset ?? "";
    const yAxisTitleOffsetX = yAxisTitle?.offsetX ?? yAxisTitle?.offset ?? "";
    const yAxisTitleOffsetY = yAxisTitle?.offsetY ?? "";
    const grayscaleColorPresets = ["#020617", "#111827", "#1f2937", "#374151", "#4b5563", "#6b7280"];
    const renderColorPresets = (targetId: string, label: string) => `
      <div class="plot-settings-color-presets" data-color-presets-for="${targetId}" aria-label="${label} grayscale presets" hidden>
        ${grayscaleColorPresets.map((color) => `
          <button
            class="plot-settings-color-preset"
            type="button"
            data-color-target="${targetId}"
            data-color-value="${color}"
            title="${color}"
            aria-label="Use ${color}"
            style="background:${color}"
          ></button>
        `).join("")}
      </div>
    `;

    return `
      <div class="plot-settings-content">
        <div class="plot-settings-panel" data-panel="root">
          <div class="plot-settings-menu">
            <button class="plot-settings-menu-btn" type="button" data-open-panel="export">Export</button>
            <button class="plot-settings-menu-btn" type="button" data-open-panel="view">View</button>
            <button class="plot-settings-menu-btn" type="button" data-open-panel="customize">Customize</button>
          </div>
        </div>

        <div class="plot-settings-panel" data-panel="export" hidden>
          <div class="plot-settings-actions">
            <button class="plot-settings-btn-action" id="set-export-png" type="button">PNG</button>
            <button class="plot-settings-btn-action plot-settings-btn-secondary" id="set-export-svg" type="button" disabled aria-disabled="true" title="SVG export is a work in progress">SVG (WIP)</button>
          </div>
        </div>

        <div class="plot-settings-panel" data-panel="view" hidden>
          <div class="plot-settings-actions">
            <button class="plot-settings-btn-action" id="set-btn-reset" type="button">Reset Zoom</button>
            <button class="plot-settings-btn-action plot-settings-btn-secondary" id="set-btn-fullscreen" type="button">${fullscreenLabel}</button>
          </div>
          <div class="plot-settings-row">
            <label>Autoscale Visible Data</label>
            <input type="checkbox" id="set-view-autoscale" ${autoscaleEnabled ? "checked" : ""}>
          </div>
          <div class="plot-settings-row">
            <label>Animate Scale Changes</label>
            <input type="checkbox" id="set-view-animate-scale" ${smoothedScalingEnabled ? "checked" : ""}>
          </div>
          <div class="plot-settings-row">
            <label>Continuous Pan</label>
            <input type="checkbox" id="set-view-smooth-pan" ${smoothPan ? "checked" : ""}>
          </div>
        </div>

        <div class="plot-settings-panel" data-panel="customize" hidden>
          <h4>Chart Settings</h4>
          ${chartSpecificHTML}

          <details class="plot-settings-section" data-section="titles"${settingsSectionOpenAttr("titles")}>
            <summary class="plot-settings-section-title">Titles</summary>
            <div class="plot-settings-section-content">
              <div class="plot-settings-row">
                <label>Chart Title</label>
                <input type="checkbox" id="set-title-enabled" ${chartTitleEnabled ? "checked" : ""}>
              </div>
              <div class="plot-settings-title-options" data-title-options="chart" ${chartTitleEnabled ? "" : "hidden"}>
                <div class="plot-settings-row">
                  <label>Title Text</label>
                  <input type="text" id="set-title-text" value="${escapeHtmlAttr(chartTitleText)}" placeholder="Untitled chart">
                </div>
                <div class="plot-settings-row">
                  <label>Title Position</label>
                  <select id="set-title-position">
                    <option value="top" ${chartTitlePosition === "top" ? "selected" : ""}>Top</option>
                    <option value="bottom" ${chartTitlePosition === "bottom" ? "selected" : ""}>Bottom</option>
                  </select>
                </div>
                <div class="plot-settings-row">
                  <label>Title Align</label>
                  <select id="set-title-align">
                    <option value="left" ${chartTitleAlign === "left" ? "selected" : ""}>Left</option>
                    <option value="center" ${chartTitleAlign === "center" ? "selected" : ""}>Center</option>
                    <option value="right" ${chartTitleAlign === "right" ? "selected" : ""}>Right</option>
                  </select>
                </div>
                <div class="plot-settings-row">
                  <label>Title Size</label>
                  <input type="number" id="set-title-size" min="6" max="72" step="1" value="${chartTitleFontSize}" placeholder="auto">
                </div>
                <div class="plot-settings-row">
                  <label>Title Style</label>
                  <div class="plot-settings-control-group" role="group" aria-label="Chart title style">
                    <input class="plot-settings-hidden-control" type="checkbox" id="set-title-bold" ${chartTitleBold ? "checked" : ""}>
                    <button class="plot-settings-format-btn plot-settings-format-bold" type="button" data-toggle-input="set-title-bold" aria-pressed="${chartTitleBold ? "true" : "false"}" title="Bold">B</button>
                    <input class="plot-settings-hidden-control" type="checkbox" id="set-title-italic" ${chartTitleItalic ? "checked" : ""}>
                    <button class="plot-settings-format-btn plot-settings-format-italic" type="button" data-toggle-input="set-title-italic" aria-pressed="${chartTitleItalic ? "true" : "false"}" title="Italic">I</button>
                  </div>
                </div>
                <div class="plot-settings-row">
                  <label>Offset X</label>
                  <input type="number" id="set-title-offset-x" step="1" value="${chartTitleOffsetX}" placeholder="0">
                </div>
                <div class="plot-settings-row">
                  <label>Offset Y</label>
                  <input type="number" id="set-title-offset-y" step="1" value="${chartTitleOffsetY}" placeholder="auto">
                </div>
              </div>
              <div class="plot-settings-row">
                <label>X Axis Title</label>
                <input type="checkbox" id="set-axis-title-enabled-x" ${xAxisTitleEnabled ? "checked" : ""}>
              </div>
              <div class="plot-settings-title-options" data-title-options="x" ${xAxisTitleEnabled ? "" : "hidden"}>
                <div class="plot-settings-row">
                  <label>X Title Text</label>
                  <input type="text" id="set-axis-title-x" value="${escapeHtmlAttr(xAxisTitleText)}" placeholder="X axis">
                </div>
                <div class="plot-settings-row">
                  <label>X Title Position</label>
                  <select id="set-axis-title-position-x">
                    <option value="bottom" ${xAxisTitlePosition === "bottom" ? "selected" : ""}>Bottom</option>
                    <option value="top" ${xAxisTitlePosition === "top" ? "selected" : ""}>Top</option>
                  </select>
                </div>
                <div class="plot-settings-row">
                  <label>X Title Align</label>
                  <select id="set-axis-title-align-x">
                    <option value="start" ${xAxisTitleAlign === "start" ? "selected" : ""}>Start</option>
                    <option value="center" ${xAxisTitleAlign === "center" ? "selected" : ""}>Center</option>
                    <option value="end" ${xAxisTitleAlign === "end" ? "selected" : ""}>End</option>
                  </select>
                </div>
                <div class="plot-settings-row">
                  <label>X Title Size</label>
                  <input type="number" id="set-axis-title-size-x" min="6" max="72" step="1" value="${xAxisTitleFontSize}" placeholder="auto">
                </div>
                <div class="plot-settings-row">
                  <label>X Title Style</label>
                  <div class="plot-settings-control-group" role="group" aria-label="X axis title style">
                    <input class="plot-settings-hidden-control" type="checkbox" id="set-axis-title-bold-x" ${xAxisTitleBold ? "checked" : ""}>
                    <button class="plot-settings-format-btn plot-settings-format-bold" type="button" data-toggle-input="set-axis-title-bold-x" aria-pressed="${xAxisTitleBold ? "true" : "false"}" title="Bold">B</button>
                    <input class="plot-settings-hidden-control" type="checkbox" id="set-axis-title-italic-x" ${xAxisTitleItalic ? "checked" : ""}>
                    <button class="plot-settings-format-btn plot-settings-format-italic" type="button" data-toggle-input="set-axis-title-italic-x" aria-pressed="${xAxisTitleItalic ? "true" : "false"}" title="Italic">I</button>
                  </div>
                </div>
                <div class="plot-settings-row">
                  <label>X Offset X</label>
                  <input type="number" id="set-axis-title-offset-x-x" step="1" value="${xAxisTitleOffsetX}" placeholder="0">
                </div>
                <div class="plot-settings-row">
                  <label>X Offset Y</label>
                  <input type="number" id="set-axis-title-offset-y-x" step="1" value="${xAxisTitleOffsetY}" placeholder="auto">
                </div>
              </div>
              <div class="plot-settings-row">
                <label>Y Axis Title</label>
                <input type="checkbox" id="set-axis-title-enabled-y" ${yAxisTitleEnabled ? "checked" : ""}>
              </div>
              <div class="plot-settings-title-options" data-title-options="y" ${yAxisTitleEnabled ? "" : "hidden"}>
                <div class="plot-settings-row">
                  <label>Y Title Text</label>
                  <input type="text" id="set-axis-title-y" value="${escapeHtmlAttr(yAxisTitleText)}" placeholder="Y axis">
                </div>
                <div class="plot-settings-row">
                  <label>Y Title Position</label>
                  <select id="set-axis-title-position-y">
                    <option value="left" ${yAxisTitlePosition === "left" ? "selected" : ""}>Left</option>
                    <option value="right" ${yAxisTitlePosition === "right" ? "selected" : ""}>Right</option>
                  </select>
                </div>
                <div class="plot-settings-row">
                  <label>Y Title Align</label>
                  <select id="set-axis-title-align-y">
                    <option value="start" ${yAxisTitleAlign === "start" ? "selected" : ""}>Start</option>
                    <option value="center" ${yAxisTitleAlign === "center" ? "selected" : ""}>Center</option>
                    <option value="end" ${yAxisTitleAlign === "end" ? "selected" : ""}>End</option>
                  </select>
                </div>
                <div class="plot-settings-row">
                  <label>Y Title Size</label>
                  <input type="number" id="set-axis-title-size-y" min="6" max="72" step="1" value="${yAxisTitleFontSize}" placeholder="auto">
                </div>
                <div class="plot-settings-row">
                  <label>Y Title Style</label>
                  <div class="plot-settings-control-group" role="group" aria-label="Y axis title style">
                    <input class="plot-settings-hidden-control" type="checkbox" id="set-axis-title-bold-y" ${yAxisTitleBold ? "checked" : ""}>
                    <button class="plot-settings-format-btn plot-settings-format-bold" type="button" data-toggle-input="set-axis-title-bold-y" aria-pressed="${yAxisTitleBold ? "true" : "false"}" title="Bold">B</button>
                    <input class="plot-settings-hidden-control" type="checkbox" id="set-axis-title-italic-y" ${yAxisTitleItalic ? "checked" : ""}>
                    <button class="plot-settings-format-btn plot-settings-format-italic" type="button" data-toggle-input="set-axis-title-italic-y" aria-pressed="${yAxisTitleItalic ? "true" : "false"}" title="Italic">I</button>
                  </div>
                </div>
                <div class="plot-settings-row">
                  <label>Y Offset X</label>
                  <input type="number" id="set-axis-title-offset-x-y" step="1" value="${yAxisTitleOffsetX}" placeholder="auto">
                </div>
                <div class="plot-settings-row">
                  <label>Y Offset Y</label>
                  <input type="number" id="set-axis-title-offset-y-y" step="1" value="${yAxisTitleOffsetY}" placeholder="0">
                </div>
              </div>
            </div>
          </details>
          
          <details class="plot-settings-section" data-section="axes"${settingsSectionOpenAttr("axes")}>
            <summary class="plot-settings-section-title">Axes & Grid</summary>
            <div class="plot-settings-section-content">
              <div class="plot-settings-row">
                <label>Y Axis Side</label>
                <select id="set-y-axis-position">
                  <option value="left" ${yAxisPosition === "left" ? "selected" : ""}>Left</option>
                  <option value="right" ${yAxisPosition === "right" ? "selected" : ""}>Right</option>
                </select>
              </div>
              <div class="plot-settings-row">
                <label>X Gridlines</label>
                <input type="checkbox" id="set-grid-x" ${xGridlines ? "checked" : ""}>
              </div>
              <div class="plot-settings-row">
                <label>Y Gridlines</label>
                <input type="checkbox" id="set-grid-y" ${yGridlines ? "checked" : ""}>
              </div>
              <div class="plot-settings-row">
                <label>X Edge Gridlines</label>
                <input type="checkbox" id="set-edgegrid-x" ${xEdgeGridlines ? "checked" : ""}>
              </div>
              <div class="plot-settings-row">
                <label>Y Edge Gridlines</label>
                <input type="checkbox" id="set-edgegrid-y" ${yEdgeGridlines ? "checked" : ""}>
              </div>
              <div class="plot-settings-row">
                <label>X Subgridlines</label>
                <input type="checkbox" id="set-subgrid-x" ${xSubgridlines ? "checked" : ""}>
              </div>
              <div class="plot-settings-row">
                <label>Y Subgridlines</label>
                <input type="checkbox" id="set-subgrid-y" ${ySubgridlines ? "checked" : ""}>
              </div>
              <div class="plot-settings-row">
                <label>X Ticks</label>
                <input type="checkbox" id="set-ticks-x" ${xTicks ? "checked" : ""}>
              </div>
              <div class="plot-settings-row">
                <label>Y Ticks</label>
                <input type="checkbox" id="set-ticks-y" ${yTicks ? "checked" : ""}>
              </div>
              <div class="plot-settings-row" id="set-ticks-size-x-row">
                <label>X Tick Length</label>
                <input type="number" id="set-ticks-size-x" min="0" step="1" value="${xTickSize}">
              </div>
              <div class="plot-settings-row" id="set-ticks-size-y-row">
                <label>Y Tick Length</label>
                <input type="number" id="set-ticks-size-y" min="0" step="1" value="${yTickSize}">
              </div>
              <div class="plot-settings-row" id="set-ticks-thickness-x-row">
                <label>X Tick Thickness</label>
                <input type="number" id="set-ticks-thickness-x" min="0.5" step="0.5" value="${xTickThickness}">
              </div>
              <div class="plot-settings-row" id="set-ticks-thickness-y-row">
                <label>Y Tick Thickness</label>
                <input type="number" id="set-ticks-thickness-y" min="0.5" step="0.5" value="${yTickThickness}">
              </div>
              <div class="plot-settings-row">
                <label>X Axis Line</label>
                <input type="checkbox" id="set-line-x" ${xLine ? "checked" : ""}>
              </div>
              <div class="plot-settings-row">
                <label>Y Axis Line</label>
                <input type="checkbox" id="set-line-y" ${yLine ? "checked" : ""}>
              </div>
              <div class="plot-settings-row">
                <label>X Label Angle</label>
                <input type="number" id="set-angle-x" min="-90" max="90" step="15" value="${xLabelAngle}">
              </div>
              <div class="plot-settings-row">
                <label>Y Label Angle</label>
                <input type="number" id="set-angle-y" min="-90" max="90" step="15" value="${yLabelAngle}">
              </div>
              <div class="plot-settings-row">
                <label>X Tick Density</label>
                <input type="number" id="set-density-x" min="0.1" max="10" step="0.1" value="${xTickDensity}">
              </div>
              <div class="plot-settings-row">
                <label>Y Tick Density</label>
                <input type="number" id="set-density-y" min="0.1" max="10" step="0.1" value="${yTickDensity}">
              </div>
              <div class="plot-settings-row">
                <label>X Subticks</label>
                <input type="checkbox" id="set-subticks-x" ${xSubticks ? "checked" : ""}>
              </div>
              <div class="plot-settings-row">
                <label>Y Subticks</label>
                <input type="checkbox" id="set-subticks-y" ${ySubticks ? "checked" : ""}>
              </div>
              <div class="plot-settings-row" id="set-every-x-row">
                <label>X Grid Spacing</label>
                <input type="number" id="set-every-x" min="1" step="1" value="${xGridlineEvery}">
              </div>
              <div class="plot-settings-row" id="set-every-y-row">
                <label>Y Grid Spacing</label>
                <input type="number" id="set-every-y" min="1" step="1" value="${yGridlineEvery}">
              </div>
              <div class="plot-settings-row" id="set-grid-thickness-row">
                <label>Grid Thickness</label>
                <input type="number" id="set-grid-thickness" min="0.5" step="0.5" value="${gridlineThickness}" placeholder="${DEFAULT_GRIDLINE_THICKNESS}">
              </div>
              <div class="plot-settings-row" id="set-grid-style-row">
                <label>Grid Style</label>
                <select id="set-grid-style">
                  <option value="solid" ${gridlineStyle === "solid" ? "selected" : ""}>Solid</option>
                  <option value="dotted" ${gridlineStyle === "dotted" ? "selected" : ""}>Dotted</option>
                  <option value="dashed" ${gridlineStyle === "dashed" ? "selected" : ""}>Dashed</option>
                </select>
              </div>
            </div>
          </details>

          <details class="plot-settings-section" data-section="theme"${settingsSectionOpenAttr("theme")}>
            <summary class="plot-settings-section-title">Theme Colors</summary>
            <div class="plot-settings-section-content">
              <div class="plot-settings-row">
                <label>Chart Area Bg</label>
                <input type="color" id="set-color-bg" value="${themeBg}">
              </div>
              <div class="plot-settings-row">
                <label>Plot Area Bg</label>
                <input type="color" id="set-color-plot-bg" value="${themePlotBg}">
              </div>
              ${renderColorPresets("set-color-fg", "Axes and text")}
              <div class="plot-settings-row">
                <label>Axes & Text</label>
                <input type="color" id="set-color-fg" value="${themeFg}">
              </div>
              ${renderColorPresets("set-color-grid", "Gridlines")}
              <div class="plot-settings-row">
                <label>Gridlines</label>
                <input type="color" id="set-color-grid" value="${themeGrid}">
              </div>
            </div>
          </details>

          <details class="plot-settings-section" data-section="borders"${settingsSectionOpenAttr("borders")}>
            <summary class="plot-settings-section-title">Borders & Frame</summary>
            <div class="plot-settings-section-content">
              <div class="plot-settings-row">
                <label>Plot Border</label>
                <input type="checkbox" id="set-border" ${frameBorder ? "checked" : ""}>
              </div>
              <div class="plot-settings-row" id="set-plot-border-color-row">
                <label>Plot Border Color</label>
                <input type="color" id="set-color-border" value="${plotBorderColor}">
              </div>
              <div class="plot-settings-row" id="set-plot-radius-row">
                <label>Plot Radius</label>
                <input type="number" id="set-border-radius" min="0" max="80" step="1" value="${plotBorderRadius}">
              </div>
              <div class="plot-settings-row">
                <label>Chart Border</label>
                <input type="checkbox" id="set-chart-border" ${chartBorderEnabled ? "checked" : ""}>
              </div>
              <div class="plot-settings-row" id="set-chart-border-color-row">
                <label>Chart Border Color</label>
                <input type="color" id="set-color-chart-border" value="${chartBorderColor}">
              </div>
              <div class="plot-settings-row" id="set-chart-radius-row">
                <label>Chart Radius</label>
                <input type="number" id="set-chart-border-radius" min="0" max="80" step="1" value="${chartBorderRadius}">
              </div>
              <div class="plot-settings-row">
                <label>Padding Top</label>
                <input type="number" id="set-pad-top" min="0" step="1" value="${padTop}" placeholder="auto">
              </div>
              <div class="plot-settings-row">
                <label>Padding Right</label>
                <input type="number" id="set-pad-right" min="0" step="1" value="${padRight}" placeholder="auto">
              </div>
              <div class="plot-settings-row">
                <label>Padding Bottom</label>
                <input type="number" id="set-pad-bottom" min="0" step="1" value="${padBottom}" placeholder="auto">
              </div>
              <div class="plot-settings-row">
                <label>Padding Left</label>
                <input type="number" id="set-pad-left" min="0" step="1" value="${padLeft}" placeholder="auto">
              </div>
            </div>
          </details>

          <details class="plot-settings-section" data-section="interactions"${settingsSectionOpenAttr("interactions")}>
            <summary class="plot-settings-section-title">Interactions</summary>
            <div class="plot-settings-section-content">
              <div class="plot-settings-row">
                <label>Selection</label>
                <input type="checkbox" id="set-inter-select" ${selectionEnabled ? "checked" : ""}>
              </div>
              <div class="plot-settings-row">
                <label>Zoom</label>
                <input type="checkbox" id="set-inter-zoom" ${zoomEnabled ? "checked" : ""}>
              </div>
              <div class="plot-settings-row">
                <label>Pan</label>
                <input type="checkbox" id="set-inter-pan" ${panEnabled ? "checked" : ""}>
              </div>
              <div class="plot-settings-row">
                <label>Drag Mode</label>
                <select id="set-inter-drag">
                  <option value="selection" ${dragInteraction === "selection" ? "selected" : ""}>Selection</option>
                  <option value="pan" ${dragInteraction === "pan" ? "selected" : ""}>Panning</option>
                </select>
              </div>
              <div class="plot-settings-row">
                <label>Tooltip Pos</label>
                <select id="set-tooltip-pos">
                  <option value="cursor" ${tooltipPos === "cursor" ? "selected" : ""}>Cursor</option>
                  <option value="bar-top" ${tooltipPos === "bar-top" ? "selected" : ""}>Bar Top</option>
                </select>
              </div>
              <div class="plot-settings-row">
                <label>Tabular Tooltip Numbers</label>
                <input type="checkbox" id="set-tooltip-tabular" ${tooltipTabularNumbers ? "checked" : ""}>
              </div>
              <div class="plot-settings-row">
                <label>Edge Blur</label>
                <input type="checkbox" id="set-edge-blur" ${edgeBlurEnabled ? "checked" : ""}>
              </div>
              <div class="plot-settings-row" id="set-edge-blur-size-row">
                <label>Edge Blur Size</label>
                <input type="number" id="set-edge-blur-size" min="8" max="160" step="1" value="${edgeBlurSize}">
              </div>
              <div class="plot-settings-row" id="set-edge-blur-left-row">
                <label>Blur Left</label>
                <input type="checkbox" id="set-edge-blur-left" ${edgeBlurLeft ? "checked" : ""}>
              </div>
              <div class="plot-settings-row" id="set-edge-blur-right-row">
                <label>Blur Right</label>
                <input type="checkbox" id="set-edge-blur-right" ${edgeBlurRight ? "checked" : ""}>
              </div>
              <div class="plot-settings-row" id="set-edge-blur-top-row">
                <label>Blur Top</label>
                <input type="checkbox" id="set-edge-blur-top" ${edgeBlurTop ? "checked" : ""}>
              </div>
              <div class="plot-settings-row" id="set-edge-blur-bottom-row">
                <label>Blur Bottom</label>
                <input type="checkbox" id="set-edge-blur-bottom" ${edgeBlurBottom ? "checked" : ""}>
              </div>
            </div>
          </details>

          <details class="plot-settings-section" data-section="animation"${settingsSectionOpenAttr("animation")}>
            <summary class="plot-settings-section-title">Animation</summary>
            <div class="plot-settings-section-content">
              <div class="plot-settings-row">
                <label>Profile</label>
                <select id="set-anim-profile">
                  <option value="rise" ${animProfile === "rise" ? "selected" : ""}>Rise</option>
                  <option value="random-fill" ${animProfile === "random-fill" ? "selected" : ""}>Random Fill</option>
                  <option value="random-fill-grow" ${animProfile === "random-fill-grow" ? "selected" : ""}>Random Fill Grow</option>
                  <option value="waterfall-left" ${animProfile === "waterfall-left" ? "selected" : ""}>Waterfall Left</option>
                  <option value="draw-left" ${animProfile === "draw-left" ? "selected" : ""}>Draw Left</option>
                  <option value="draw-right" ${animProfile === "draw-right" ? "selected" : ""}>Draw Right</option>
                </select>
              </div>
              <div class="plot-settings-row" id="set-anim-fade-row" ${animProfile !== "random-fill" && animProfile !== "random-fill-grow" ? "style='display:none;'" : ""}>
                <label>Random Fade</label>
                <input type="checkbox" id="set-anim-fade" ${randomFillFade ? "checked" : ""}>
              </div>
              <div class="plot-settings-row">
                <label>Duration (ms)</label>
                <input type="number" id="set-anim-duration" min="0" step="50" value="${animDuration}">
              </div>
              <div class="plot-settings-row">
                <label>Axis Profile</label>
                <select id="set-axis-anim-profile">
                  <option value="none" ${axisAnimProfile === "none" ? "selected" : ""}>None</option>
                  <option value="origin-extend" ${axisAnimProfile === "origin-extend" ? "selected" : ""}>Extend from Origin</option>
                  <option value="fade" ${axisAnimProfile === "fade" ? "selected" : ""}>Fade</option>
                  <option value="fade-slide" ${axisAnimProfile === "fade-slide" ? "selected" : ""}>Fade & Slide</option>
                  <option value="staggered-pop" ${axisAnimProfile === "staggered-pop" ? "selected" : ""}>Staggered Pop</option>
                  <option value="domain-expansion" ${axisAnimProfile === "domain-expansion" ? "selected" : ""}>Domain Expansion</option>
                </select>
              </div>
              <div class="plot-settings-row">
                <label>Axis Duration</label>
                <input type="number" id="set-axis-anim-duration" min="0" step="50" placeholder="same as plot" value="${axisAnimDuration !== undefined ? axisAnimDuration : ""}">
              </div>
              <div class="plot-settings-row">
                <label>Title Profile</label>
                <select id="set-title-animation">
                  <option value="none" ${titleAnimation === "none" ? "selected" : ""}>None</option>
                  <option value="fade" ${titleAnimation === "fade" ? "selected" : ""}>Fade</option>
                  <option value="fade-slide" ${titleAnimation === "fade-slide" ? "selected" : ""}>Fade Slide</option>
                </select>
              </div>
              <div class="plot-settings-row">
                <label>Plot Easing</label>
                <select id="set-anim-easing">
                  <option value="auto" ${animEasing === "auto" ? "selected" : ""}>Auto</option>
                  <option value="linear" ${animEasing === "linear" ? "selected" : ""}>Linear</option>
                  <option value="ease-out-cubic" ${animEasing === "ease-out-cubic" ? "selected" : ""}>Ease Out Cubic</option>
                  <option value="ease-in-out-cubic" ${animEasing === "ease-in-out-cubic" ? "selected" : ""}>Ease In-Out Cubic</option>
                  <option value="ease-in-out-sine" ${animEasing === "ease-in-out-sine" ? "selected" : ""}>Ease In-Out Sine</option>
                </select>
              </div>
              <div class="plot-settings-row">
                <label>Axis Easing</label>
                <select id="set-axis-anim-easing">
                  <option value="auto" ${axisAnimEasing === "auto" ? "selected" : ""}>Auto</option>
                  <option value="linear" ${axisAnimEasing === "linear" ? "selected" : ""}>Linear</option>
                  <option value="ease-out-cubic" ${axisAnimEasing === "ease-out-cubic" ? "selected" : ""}>Ease Out Cubic</option>
                  <option value="ease-in-out-cubic" ${axisAnimEasing === "ease-in-out-cubic" ? "selected" : ""}>Ease In-Out Cubic</option>
                  <option value="ease-in-out-sine" ${axisAnimEasing === "ease-in-out-sine" ? "selected" : ""}>Ease In-Out Sine</option>
                </select>
              </div>
              <div class="plot-settings-actions">
                <button class="plot-settings-btn-action" id="set-btn-animate" type="button">Animate</button>
              </div>
            </div>
          </details>
        </div>
      </div>
    `;
}
