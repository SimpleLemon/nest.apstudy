import { normalizeDetailRows } from "./admin-analytics-model.js";
import { chartEmpty } from "./admin-analytics-presentation.js";
import { renderBarList } from "./admin-analytics-charts.js";
let googleChartsRequested = false;
let googleChartsReady = false;
const googleChartsCallbacks = [];
let geoChartThemeObserver = null;
let geoChartRedraw = null;

function runGoogleChartsCallback(callback) {
  if (googleChartsReady) {
    callback();
    return true;
  }
  const charts = window.google?.charts;
  if (!charts?.load || !charts?.setOnLoadCallback) {
    return false;
  }
  googleChartsCallbacks.push(callback);
  if (!googleChartsRequested) {
    googleChartsRequested = true;
    charts.load("current", { packages: ["geochart"] });
    charts.setOnLoadCallback(() => {
      googleChartsReady = true;
      while (googleChartsCallbacks.length) {
        googleChartsCallbacks.shift()?.();
      }
    });
  }
  return true;
}

function geoChartThemeOptions() {
  const isDark = document.documentElement?.classList?.contains("dark") ?? false;
  return isDark
    ? {
        colorAxis: { colors: ["#1e3a5f", "#60a5fa"] },
        datalessRegionColor: "#2a2d35",
      }
    : {
        colorAxis: { colors: ["#dbeafe", "#2563eb"] },
        datalessRegionColor: "#eef2f7",
      };
}

function ensureGeoChartThemeObserver(redraw) {
  geoChartRedraw = redraw;
  if (geoChartThemeObserver || typeof MutationObserver !== "function") return;
  geoChartThemeObserver = new MutationObserver(() => {
    geoChartRedraw?.();
  });
  geoChartThemeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-theme"],
  });
}

function renderCountryMapFallback(root, countries) {
  const rows = normalizeDetailRows(countries).slice(0, 6);
  root.innerHTML = rows.length ? renderBarList(rows) : chartEmpty();
}

function renderCountryMap(root, countries) {
  if (!root) return;
  const rows = normalizeDetailRows(countries).filter((row) => row.countryId || row.label);
  if (!rows.length) {
    root.innerHTML = chartEmpty();
    return;
  }
  const draw = () => {
    try {
      const table = [["Country", "Active users"], ...rows.map((row) => [row.countryId || row.label, row.value])];
      const data = window.google.visualization.arrayToDataTable(table);
      const chart = new window.google.visualization.GeoChart(root);
      const themeOptions = geoChartThemeOptions();
      chart.draw(data, {
        backgroundColor: "transparent",
        colorAxis: themeOptions.colorAxis,
        datalessRegionColor: themeOptions.datalessRegionColor,
        legend: "none",
        tooltip: { textStyle: { fontName: "Inter" } },
      });
      ensureGeoChartThemeObserver(draw);
    } catch {
      renderCountryMapFallback(root, rows);
    }
  };
  if (!runGoogleChartsCallback(draw)) {
    renderCountryMapFallback(root, rows);
  }
}

export { renderCountryMap };
