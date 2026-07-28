# Plod

Plod is a browser-first TypeScript plotting library focused on responsive
rendering, live data, interaction, animation, Canvas, and WebGL point clouds.

The library includes its plot settings interface, tooltips, selection, zoom,
pan, fullscreen controls, animation replay, and PNG export. Demo sites,
benchmarks, datasets, and the chart studio live outside this repository.

## Install

```sh
npm install plod
```

## Usage

```ts
import { plot } from "plod";

const data = [
  { date: "2026-01-01", value: 12 },
  { date: "2026-01-02", value: 18 },
  { date: "2026-01-03", value: 15 }
];

const chart = plot("#chart", data).line({
  x: (row) => Date.parse(row.date),
  y: "value",
  timeAxis: true
});

chart.update({ data: nextData });
chart.resize();
chart.destroy();
```

The chart container must have a measurable size:

```css
#chart {
  width: 100%;
  height: 420px;
}
```

## Public API

The root entry point exports:

- `createPlot`, `plot`, `buildPlot`, and `PlotBuilder`
- line, area, bar, and scatter chart presets
- line, bar, point, and scatter marks
- Canvas and WebGL-backed rendering behavior
- linear and categorical axis builders
- retained and level-of-detail data series
- themes, transforms, interaction types, and core plotting contracts

## Development

```sh
npm install
npm test
npm run build
```

The package has no runtime npm dependencies. TypeScript is used only for
development and declaration generation.

See [docs/architecture.md](docs/architecture.md) for the internal module
boundaries and extension points.

## License

MIT
