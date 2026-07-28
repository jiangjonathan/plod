import type { SceneGraph } from "../core/types";

export type InteractionController = {
  attach(target: Element, getScene: () => SceneGraph): void;
  detach(): void;
};

export type HitTarget = {
  primitiveIndex: number;
  distance: number;
};
