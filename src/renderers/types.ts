import type { SceneGraph } from "../core/types";

export type RenderSurface = {
  element: Element;
};

export type Renderer<TSurface extends RenderSurface = RenderSurface> = {
  mount(container: Element): TSurface;
  render(surface: TSurface, scene: SceneGraph): void;
  renderOverlay?(surface: TSurface, scene: SceneGraph): void;
  renderScatterHover?(surface: TSurface, scene: SceneGraph): void;
  destroy(surface: TSurface): void;
};
