export type Theme = {
  palette: {
    background: string;
    plotBackground?: string;
    foreground: string;
    grid: string;
    series: readonly string[];
  };
  typography: {
    fontFamily: string;
    fontSize: number;
  };
  spacing: {
    plotMargin: {
      top: number;
      right: number;
      bottom: number;
      left: number;
    };
  };
};
