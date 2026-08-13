# Plod

Plod is a performance-first TypeScript plotting engine for responsive,
interactive charts. It combines Canvas rendering, WebGL point clouds,
pixel-budgeted level of detail, and incremental updates behind one browser API.

The library has no runtime npm dependencies.

## What Plod optimizes

### Render work follows screen density

Large data should not produce more geometry than the display can show.
`createLodSeries()` keeps hierarchical first/last/min/max buckets and resolves
only the detail needed for the current viewport and pixel width. Multi-series
lines are decimated independently so one series cannot erase another's extrema.

Grouped and stacked bars use a similar pixel budget. Dense groups are reduced
to representative envelopes instead of encoding every off-screen or
sub-pixel bar.

### Scatter data stays GPU-friendly

Scatter charts encode their points as point-cloud primitives rendered with
WebGL. `createScatterSeries()` maintains growable `Float32Array` buffers and a
stable cache identity. Appends mark only the new range as dirty, allowing the
renderer to update the existing GPU buffer with `bufferSubData()` rather than
re-uploading the full cloud.

Point hover uses a cached data-space grid index, avoiding a linear scan of the
cloud on every pointer move. Axes, labels, and tooltips stay on lightweight 2D
overlay canvases.

### Updates use specialized fast paths

The plot retains resolved data, axes, layout, mark geometry, and render
resources between frames. It has targeted paths for:

- streaming line and point-cloud appends
- zoom, pan, selection, and focus interpolation
- container and dashboard resizes
- hover-only overlay redraws
- axis tick fades without repainting WebGL marks

During live resize, Plod can transform cached Canvas geometry, retain WebGL
buffers, and update viewport uniforms. Dashboard previews may stagger expensive
point-cloud paints across charts, then commit a full settle frame.

### Streaming work can be batched

The built-in data sources maintain extents and LOD indexes incrementally.
`createLodSeries({ bufferAppends: true })` coalesces repeated appends into one
commit per animation frame. Batch and typed-buffer APIs avoid per-update chart
reconstruction for high-frequency feeds.

## Install

```sh
npm install plod
```

Plod is ESM-only and requires a modern browser. The chart container must have
a measurable size.

## Quickstart

```html
<div id="chart"></div>

<style>
  #chart {
    width: 100%;
    height: 420px;
  }
</style>
```

```ts
import { plot } from "plod";

const data = [
  { time: Date.parse("2026-01-01"), value: 12 },
  { time: Date.parse("2026-01-02"), value: 18 },
  { time: Date.parse("2026-01-03"), value: 15 }
];

const chart = plot("#chart", data).line({
  x: "time",
  y: "value",
  timeAxis: true,
  curve: "monotone-x",
  zoom: { mode: "x", wheel: true },
  pan: { mode: "x", drag: true },
  dragInteraction: "pan"
});

chart.update({ data: nextData });
chart.resize();
chart.destroy();
```

The fluent builder finishes with `.line()`, `.area()`, `.bar()`, or
`.scatter()`. Accessors accept either a property name or a callback.

## Large and streaming lines

Use `createLodSeries()` when the source is much denser than the chart or grows
continuously:

```ts
import { createLodSeries, plot } from "plod";

const series = createLodSeries({
  mode: "line",
  maxRawPointsPerPixel: 6,
  bufferAppends: true
});

series.appendBatch(initialPoints);

const chart = plot("#chart", series).line({
  x: "x",
  y: "y",
  series: "series",
  lineFocus: true,
  timeAxis: true
});

series.append({ x: Date.now(), y: nextValue, series: "live" });
// Buffered appends publish automatically on the next frame.
```

For bulk ingestion, `appendBuffer(x, y, count, series?)` reads from typed or
array-like columns. `writeFrom()` efficiently replaces a moving live tail.

## Large and streaming scatter

```ts
import { createScatterSeries, plot } from "plod";

const points = createScatterSeries();
points.appendIterable(initialPoints);

const chart = plot("#scatter", points).scatter({
  x: "x",
  y: "y",
  category: "series",
  radius: 2,
  opacity: 0.7,
  zoom: { mode: "xy", wheel: true },
  pan: { mode: "xy", drag: true }
});

points.append({ x: nextX, y: nextY, series: nextCategory });
```

Keeping the same `ScatterSeries` instance is important: its stable identity is
what lets Plod reuse CPU caches and GPU buffers across appends.

## Grouped and stacked bar LOD

```ts
import { createGroupedBarSeries, plot } from "plod";

const bars = createGroupedBarSeries({
  data: rows,
  group: "timestamp",
  series: "region",
  value: "revenue",
  layout: "stacked",
  maxGroupsPerPixel: 2
});

const chart = plot("#bars", bars).bar({
  x: "group",
  y: "value",
  series: "series",
  layout: "stacked",
  timeAxis: true
});
```

## Tuning the render budget

Optimizations are enabled by default. Lower-level specs can tune or disable
the screen-density budget:

```ts
import { createPlot, lineChart } from "plod";

const spec = lineChart({ data, x: "time", y: "value" });

spec.optimization = {
  enabled: true,
  minDensity: 1.5,
  lineSamplesPerPixel: 2,
  pointCellSize: 8
};

spec.dashboardResizePreview = true;

const chart = createPlot(document.querySelector("#chart")!, spec);
```

| Option | Effect |
| --- | --- |
| `minDensity` | Density threshold before mark-level reduction is worthwhile |
| `lineSamplesPerPixel` | Target line samples retained per horizontal pixel |
| `pointCellSize` | Screen-space cell size used by point reduction paths |
| `dashboardResizePreview` | Enables retained/staggered resize work for multi-chart dashboards |

Use `optimization: false` only when every raw datum must be encoded regardless
of display density. The built-in data sources may still provide their own
viewport-specific views.

## Plot lifecycle

```ts
chart.appendData(pointOrBatch);
chart.clearData();
chart.update({ data, theme, interactions });
chart.focus({ x: [start, end] });
chart.resetFocus();
chart.animate({ profile: "draw-left", durationMs: 700 });
chart.resize();
chart.destroy();
```

Create the plot after its element mounts, keep the instance across data
updates, and call `destroy()` during framework cleanup. Recreating the plot on
every render discards the caches that make incremental updates fast.

## API surface

The root module exports:

- `plot`, `buildPlot`, `PlotBuilder`, and `createPlot`
- line, area, bar, and scatter presets and marks
- `createLodSeries`, `createScatterSeries`, and `createGroupedBarSeries`
- axes, scales, themes, transforms, renderer contracts, and plot types

## Development

```sh
git clone git@github.com:jiangjonathan/plod.git
cd plod
npm install
npm test
npm run build
```

`npm test` runs the settings-contract check and strict TypeScript compiler.
`npm run build` emits ESM JavaScript, declarations, declaration maps, and source
maps to `dist/`.

## License

MIT
