import type { Theme } from "./types";

/** Platform UI font — resolves to San Francisco on macOS, Segoe UI on Windows, etc. */
export const SYSTEM_FONT_FAMILY =
  'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

/** Platform monospace — SF Mono / Menlo on macOS, Consolas on Windows. */
export const SYSTEM_MONO_FONT_FAMILY =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';

export const defaultTheme: Theme = {
  palette: {
    background: "#ffffff",
    plotBackground: "#ffffff",
    foreground: "#1f2933",
    grid: "#d9e2ec",
    series: ["#1f7a8c", "#bf4342", "#6a994e", "#f2a541"]
  },
  typography: {
    fontFamily: SYSTEM_FONT_FAMILY,
    fontSize: 12
  },
  spacing: {
    plotMargin: {
      top: 24,
      right: 24,
      bottom: 36,
      left: 48
    }
  }
};
