# Plod

Plod is a browser-first TypeScript plotting library for responsive,
interactive charts. It renders regular charts with Canvas and can move large
scatter plots to WebGL while keeping the same plot API.

Plod includes line, area, bar, and scatter presets; tooltips; selection; zoom
and pan; animation; live-data updates; responsive resizing; plot controls; and
PNG export. The demo site, benchmarks, datasets, and chart studio live outside
this repository.

## Features

- Fluent, type-safe chart builder for common charts
- Lower-level specs, marks, axes, themes, scales, and renderers
- Responsive Canvas rendering and WebGL point clouds
- Selection, wheel/touch zoom, pan, hover, and click-to-pin line focus
- Animated entry, replay, viewport changes, and resize transitions
- Mutable and subscribable data sources for streaming dashboards
- No runtime npm dependencies

## Requirements

- A modern browser with Canvas support
- Node.js 18 or newer for development and package builds
- A chart container with a measurable width and height

## Install

```sh
npm install plod
```

## Quickstart

Add a container to the page. Plod measures this element, so it must have a
non-zero size.

```html
<div id="chart"></div>

<style>
  #chart {
    width: 100%;
    height: 420px;
  }
</style>
```

Create a chart with the fluent builder:

```ts
import { plot } from "plod";

type Reading = {
  date: string;
  value: number;
  sensor: string;
};

const readings: Reading[] = [
  { date: "2026-01-01", value: 12, sensor: "North" },
  { date: "2026-01-02", value: 18, sensor: "North" },
  { date: "2026-01-03", value: 15, sensor: "North" }
];

const chart = plot<Reading>("#chart", readings)
  .interactions({
    zoom: { mode: "x", wheel: true },
    pan: { mode: "x", drag: true },
    dragInteraction: "pan"
  })
  .tooltip({
    position: "cursor",
    tabularNumbers: true,
    titleWeight: "semibold"
  })
  .line({
    x: (row) => Date.parse(row.date),
    y: "value",
    series: "sensor",
    timeAxis: true,
    curve: "monotone-x",
    lineFocus: true,
    tooltip: (row) => ({
      title: row.sensor,
      lines: [row.date, `Value: ${row.value}`]
    })
  });
```

Accessors such as `x`, `y`, `series`, and `category` accept either a property
name or a callback. The builder finishes with one of `.line()`, `.area()`,
`.bar()`, or `.scatter()` and returns a live `Plot` instance.

## Common chart types

### Bar chart

```ts
const salesChart = plot("#sales", [
  { month: "Jan", revenue: 42, region: "East" },
  { month: "Jan", revenue: 35, region: "West" },
  { month: "Feb", revenue: 51, region: "East" },
  { month: "Feb", revenue: 39, region: "West" }
]).bar({
  x: "month",
  y: "revenue",
  series: "region",
  layout: "grouped",
  valueLabels: true
});
```

Use `layout: "stacked"` or provide `stack`/`stackGroup` for stacked data.

### Area chart

```ts
const area = plot("#traffic", traffic).area({
  x: "timestamp",
  y: "requests",
  series: "service",
  timeAxis: true,
  opacity: 0.24,
  overlap: "blend"
});
```

### Scatter chart

```ts
const cloud = plot("#scatter", points).scatter({
  x: "x",
  y: "y",
  category: "cluster",
  size: "weight",
  radiusRange: [2, 10],
  hoverInteraction: "grow",
  zoom: { mode: "xy", wheel: true },
  pan: { mode: "xy", drag: true }
});
```

Scatter presets enable point-cloud optimizations by default. Plod selects its
rendering path from the encoded scene and available browser capabilities.

## Updating and controlling a plot

The chart methods schedule rendering; callers do not need to manually redraw
after normal updates.

```ts
chart.update({ data: nextReadings });
chart.resize(); // remeasure the container

chart.animate({
  profile: "draw-left",
  durationMs: 700,
  easing: "ease-out-cubic"
});

chart.focus({ x: [startTimestamp, endTimestamp] });
chart.resetFocus();

chart.destroy(); // remove observers, listeners, controls, and render surfaces
```

For append-oriented data sources, use `appendData()` and `clearData()`:

```ts
chart.appendData({
  date: "2026-01-04",
  value: 21,
  sensor: "North"
});

chart.clearData();
```

These methods return `true` when the configured data source supports the
operation. Plain arrays can also be replaced through `update({ data })`.

## Presets without the builder

Preset functions return a `PlotSpec`, which can be adjusted before creating a
plot:

```ts
import { createPlot, lineChart } from "plod";

const element = document.querySelector("#chart");
if (!element) throw new Error("Missing #chart container");

const spec = lineChart({
  data: readings,
  x: (row) => Date.parse(row.date),
  y: "value",
  timeAxis: true,
  zoom: { mode: "x", wheel: true }
});

spec.title = "Sensor readings";
spec.chartBorder = { enabled: true, radius: 12 };

const chartFromSpec = createPlot(element, spec);
```

Use this form when you need to compose presets with lower-level options or
retain a serializable chart configuration.

## Builder configuration

The fluent builder exposes shared configuration before the final chart type:

```ts
const chart = plot("#chart", data)
  .size(900, 480)
  .axes({
    x: { title: { text: "Time" } },
    y: { title: { text: "Value" }, position: "right" }
  })
  .interactions({
    selection: { mode: "x" },
    zoom: { mode: "x" },
    pan: { mode: "x" }
  })
  .tooltip({
    shadow: true,
    titleFont: "regular",
    titleWeight: "bold"
  })
  .modifySpec((spec) => {
    spec.title = "Live values";
    spec.edgeBlur = true;
  })
  .line({ x: "time", y: "value" });
```

Explicit `.size()` values override container measurement. Omit them for a
responsive chart and call `resize()` after layout changes if your environment
does not trigger the built-in observer.

## Public API

The root entry point exports:

- `createPlot`, `plot`, `buildPlot`, and `PlotBuilder`
- `lineChart`, `areaChart`, `barChart`, and `scatterChart`
- line, bar, point, and scatter marks
- Canvas rendering and WebGL-backed point-cloud behavior
- linear and categorical axis builders
- retained, grouped-bar, scatter, and level-of-detail data series
- themes, transforms, interaction types, and core plotting contracts

The package ships ESM JavaScript, TypeScript declarations, declaration maps,
and source maps from `dist/`.

## Development

```sh
git clone git@github.com:jiangjonathan/plod.git
cd plod
npm install
npm test
npm run build
```

Useful scripts:

| Command | Purpose |
| --- | --- |
| `npm test` | Run the settings contract check and strict typecheck |
| `npm run typecheck` | Typecheck without emitting build artifacts |
| `npm run check:settings` | Verify the settings UI and option contracts |
| `npm run build` | Clean and compile the ESM package and declarations |

See [docs/architecture.md](docs/architecture.md) for internal module
boundaries, the rendering lifecycle, and extension points.

## Browser and framework usage

Plod owns the DOM below the supplied chart container. In component frameworks,
create the chart after the element mounts, call `update()` when inputs change,
and call `destroy()` during cleanup. Import Plod only in browser-executed code
when using server-side rendering.

## License

MIT
