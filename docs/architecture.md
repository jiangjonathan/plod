# Architecture

Plod is a browser plotting engine organized around a small public spec, a
retained scene graph, and rendering paths specialized for ordinary Canvas
marks and large WebGL point clouds.

## Rendering lifecycle

1. A preset or caller creates a `PlotSpec`.
2. `createPlot()` resolves the current data view and applies transforms.
3. Axis builders derive domains, ticks, and labels from the visible data.
4. `computeLayout()` measures the container and resolves the plot area.
5. Marks encode data into renderer-independent scene primitives.
6. The renderer paints grid, marks, axes, hover state, and edge effects.
7. Interaction controllers hit-test the scene and schedule targeted redraws.

The plot retains resolved data, axes, layout, marks, and rendering resources
between frames. An update invalidates only the caches affected by the changed
spec fields.

## Source layout

| Directory | Responsibility |
| --- | --- |
| `src/core` | Plot lifecycle, scheduling, animation, invalidation, focus, settings controls, and public contracts |
| `src/data` | Data-source contracts, listeners, metadata, streaming series, and level-of-detail data windows |
| `src/axes` | Convenience builders for Cartesian linear and categorical axes |
| `src/layout` | Container measurement, margins, axes, plot boxes, and interaction layout state |
| `src/scales` | Domain-to-range mapping primitives |
| `src/marks` | Line, area, bar, point, and scatter encoders plus mark-specific hit testing |
| `src/renderers` | Canvas scene rendering, WebGL point clouds, color handling, and edge effects |
| `src/interaction` | Hover, tooltip, selection, settings, and plot-control behavior |
| `src/themes` | Theme contracts and defaults |
| `src/transforms` | Data transformation contracts and built-ins |
| `src/presets` | User-facing line, area, bar, and scatter recipes |

`src/index.ts` is the package boundary. New public modules must be exported
there so their JavaScript and declarations are reachable through `plod`.

## Scene graph

Marks do not draw directly. A mark receives the resolved data, layout, and
theme and returns `Primitive` values such as paths, rectangles, circles, text,
or point clouds. This separation keeps data encoding independent from the
rendering implementation and lets the engine cache or transform primitives
during animation and resize operations.

The Canvas renderer owns normal 2D drawing. Point-cloud primitives can use the
WebGL path for dense scatter data while axes, labels, and interactions remain
in the same scene lifecycle.

## Invalidation and frame scheduling

`Plot.update()` merges a partial set of public plot fields and invalidates the
minimum useful cache boundary:

- Data, marks, axes, themes, frames, and interaction changes rebuild the
  affected scene state.
- Size-only changes use the resize scheduler and cached geometry where safe.
- Hover and tooltip changes use interaction redraw paths.
- Streaming appends can patch compatible line or point-cloud caches.
- Focus, selection, zoom, and pan retain explicit viewport state.

Animation and viewport interpolation share the same frame scheduler. A
viewport-changing gesture first commits any active entry/replay animation so
two independent timelines do not compete for the canvas.

## Data model

`DataInput<T>` accepts a plain readonly array or a `DataSource<T>`. Data
sources may expose views, subscriptions, append/clear behavior, extents, and
level-of-detail windows. The built-in helpers cover:

- `createLodSeries()` for retained line-like series
- `createScatterSeries()` for large point sets
- `createGroupedBarSeries()` for grouped or stacked categorical data

Presets and marks use accessors, which may be property names or callbacks.
This keeps the engine independent from a required table or dataframe format.

## Interaction model

Interaction controllers are attached once per plot and query the current
scene through closures. Hidden hit-test primitives provide mark-specific
behavior without coupling controllers to a particular mark implementation.
The engine coordinates:

- hover state and tooltip placement
- drag selection and focus ranges
- mouse-wheel, pointer, and touch zoom/pan
- line-series focus and click-to-pin behavior
- plot controls, fullscreen state, replay, and export

Controllers expose cleanup methods that `Plot.destroy()` calls alongside
observers, animation frames, timers, Canvas surfaces, and WebGL resources.

## Extension points

- `Mark<T>` maps data and layout into scene primitives.
- `Transform<T>` derives or filters data before encoding.
- `Scale` maps input domains to visual ranges.
- `Renderer` creates a surface and renders a scene graph.
- `Theme` supplies palette, typography, axis, grid, and interaction tokens.
- A preset composes data, marks, axes, and interactions into a `PlotSpec`.

Prefer extending one of these boundaries over branching inside
`createPlot()`. Changes to lifecycle coordination, caching, focus, or frame
scheduling belong in core because they affect every mark and renderer.

## Verification

Run the contract check and strict compiler before publishing:

```sh
npm test
npm run build
```

The build emits ESM JavaScript, TypeScript declarations, declaration maps, and
source maps into `dist/`.
