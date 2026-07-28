const PLOT_UI_CHROME_SELECTOR = [
  "button",
  "input",
  "select",
  "textarea",
  "label",
  "[role='button']",
  ".plot-settings-popover",
  ".plot-settings-safety-padding",
  ".plot-settings-btn",
  ".plot-replay-btn",
  ".plot-stream-btn",
  ".plot-live-hud"
].join(", ");

const CHROME_SUPPRESS_EVENTS = [
  "mouseenter",
  "mousemove",
  "pointerover",
  "pointermove",
  "pointerenter"
] as const;

/** True when the event target is chart chrome (buttons, settings, HUD), not the plot. */
export function isPlotUiChrome(target: EventTarget | null | undefined): boolean {
  return target instanceof Element && target.closest(PLOT_UI_CHROME_SELECTOR) !== null;
}

/** True when the client point is currently over chart chrome. */
export function isClientPointOverPlotUiChrome(
  clientX: number,
  clientY: number,
  doc: Document | null | undefined = typeof document !== "undefined" ? document : undefined
): boolean {
  if (!doc || !Number.isFinite(clientX) || !Number.isFinite(clientY)) {
    return false;
  }

  return isPlotUiChrome(doc.elementFromPoint(clientX, clientY));
}

export type PlotChromeHoverGateOptions = {
  elements: readonly HTMLElement[];
  clearHover: () => void;
  setSuspended: (suspended: boolean) => void;
  /** When true, leave suspension active (e.g. settings popover still open). */
  shouldKeepSuspended?: (event: Event) => boolean;
};

/**
 * Suspend hover/tooltip while the pointer is over chart chrome, and release
 * when it leaves — shared by settings buttons and the live HUD.
 */
export function attachPlotChromeHoverGate(options: PlotChromeHoverGateOptions): () => void {
  const { elements, clearHover, setSuspended, shouldKeepSuspended } = options;

  const suppress = () => {
    clearHover();
    setSuspended(true);
  };

  const release = (event: Event) => {
    if (shouldKeepSuspended?.(event)) {
      return;
    }

    const related = (event as PointerEvent).relatedTarget;
    if (
      related instanceof Element &&
      elements.some((element) => element === related || element.contains(related))
    ) {
      return;
    }

    setSuspended(false);
  };

  for (const eventName of CHROME_SUPPRESS_EVENTS) {
    for (const element of elements) {
      element.addEventListener(eventName, suppress);
    }
  }
  for (const element of elements) {
    element.addEventListener("pointerleave", release);
  }

  return () => {
    for (const eventName of CHROME_SUPPRESS_EVENTS) {
      for (const element of elements) {
        element.removeEventListener(eventName, suppress);
      }
    }
    for (const element of elements) {
      element.removeEventListener("pointerleave", release);
    }
  };
}
