# Architecture Outline

This outline borrows the separation of concerns seen in mature plotting libraries while targeting browser constraints: frequent resizes, live data updates, interactive hit testing, and multiple render backends.

## Lifecycle

1. Normalize user options into a `PlotSpec`.
2. Run data transforms into column-oriented series.
3. Resolve scales from data domains and explicit options.
4. Compute layout from container size, margins, axes, legends, and annotations.
5. Build a scene graph of renderable primitives.
6. Render only invalidated layers.
7. Route pointer events through hit testing and interaction controllers.

## Directory Responsibilities

| Directory | Responsibility |
| --- | --- |
| `src/core` | Public plot object, specs, scheduler, invalidation, scene graph |
| `src/layout` | Measurement, plot boxes, constraints, axis/legend layout |
| `src/scales` | Data-to-visual mapping primitives |
| `src/marks` | Encoded visual layers |
| `src/transforms` | Data transformation pipeline |
| `src/renderers` | Canvas/SVG/WebGL render backends |
| `src/interaction` | Events, hit testing, tooltips, gestures |
| `src/animation` | Transitions and frame coordination |
| `src/themes` | Design tokens and visual defaults |
| `src/presets` | User-friendly chart recipes |
| `src/data` | Data access, inference, adapters |
| `src/utils` | Dependency-free helpers |

## Performance Model

- Container resize should invalidate layout, not necessarily data transforms.
- Data updates should invalidate transforms, scale domains, layout only when required, and affected scene layers.
- Interaction should use cached hit regions where possible.
- Rendering backends should consume the same scene graph so Canvas, SVG, and WebGL can coexist.
- Expensive phases should be explicit and measurable.

## Public Extension Points

- `Mark`: maps transformed data into scene primitives.
- `Scale`: maps input domain values to visual ranges.
- `Transform`: maps input data into derived data.
- `Renderer`: draws a scene to a target backend.
- `InteractionController`: owns event subscriptions and behavior.
- `Preset`: composes lower-level pieces into a chart recipe.
