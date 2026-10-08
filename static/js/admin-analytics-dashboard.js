import { escapeHtml } from "./core/ui-primitives-module.js";
import { METRIC_CONFIG, formatNumber, valueAtPath } from "./admin-analytics-model.js";
import { comparisonForMetric, deltaLabel, deltaBadgeClass, deltaTrendSvg } from "./admin-analytics-presentation.js";
import { renderLineChart, renderMultiLineChart, renderVerticalBarChart } from "./admin-analytics-charts.js";
import { renderDetailRows } from "./admin-analytics-rows.js";
import { renderCountryMap } from "./admin-analytics-map.js";
function setMetricDeltas(root, payload) {
  Object.keys(METRIC_CONFIG).forEach((key) => {
    const el = root.querySelector(`[data-analytics-delta="${key}"]`);
    if (!el) return;
    const comparison = comparisonForMetric(payload, key);
    const label = deltaLabel(comparison);
    el.hidden = !label;
    if (label) {
      el.className = deltaBadgeClass(comparison);
      el.title = "Compared with the previous period";
      el.setAttribute?.("aria-label", `${label} compared with the previous period`);
      el.innerHTML = `<span>${escapeHtml(label)}${deltaTrendSvg(comparison)}</span>`;
    } else {
      el.className = "admin-stat-delta";
      el.removeAttribute?.("title");
      el.removeAttribute?.("aria-label");
      el.innerHTML = "";
    }
  });
}

function syncPeriodLabels(root, label) {
  const text = String(label || "").trim();
  if (!text) return;
  root.querySelectorAll("[data-analytics-period-label]").forEach((el) => {
    el.textContent = text;
  });
}

function renderGaDetailPanel(root, payload, type) {
  if (!root) return;
  const countries = payload?.gaDetails?.countries || [];
  const pages = payload?.gaDetails?.pages || [];
  const traffic = payload?.sources?.traffic?.status === "ok"
    ? payload.sources.traffic.label
    : "Google Analytics unavailable";
  const sourceText = `Source: ${traffic}`;
  if (type === "countries") {
    const gaSource = root.querySelector("[data-analytics-ga-details-source]");
    if (gaSource) gaSource.textContent = sourceText;
    renderCountryMap(root.querySelector("[data-analytics-country-map]"), countries);
    renderDetailRows(root.querySelector('[data-analytics-detail-list="countries"]'), countries, { type: "countries" });
    return;
  }
  const pageSource = root.querySelector("[data-analytics-page-details-source]");
  if (pageSource) pageSource.textContent = sourceText;
  renderDetailRows(root.querySelector('[data-analytics-detail-list="pages"]'), pages, { type: "pages" });
}

function renderGaDetails(root, payload) {
  renderGaDetailPanel(root, payload, "countries");
  renderGaDetailPanel(root, payload, "pages");
}

function setCard(root, key, value, suffix = "") {
  const el = root.querySelector(`[data-analytics-card="${key}"]`);
  if (el) el.textContent = `${formatNumber(value)}${suffix}`;
}

function setMetricCards(root, payload) {
  Object.entries(METRIC_CONFIG).forEach(([key, config]) => {
    setCard(root, key, config.value(payload));
  });
}

function renderMainMetric(root, payload, metricKey) {
  const key = METRIC_CONFIG[metricKey] ? metricKey : "totalUsers";
  const config = METRIC_CONFIG[key];
  const chart = root.querySelector('[data-chart="main"]');
  const title = root.querySelector("[data-analytics-main-title]");
  const description = root.querySelector("[data-analytics-main-description]");
  const source = root.querySelector("[data-analytics-main-source]");
  const tabs = Array.from(root.querySelectorAll("[data-analytics-metric]"));
  tabs.forEach((tab) => {
    const selected = tab.dataset.analyticsMetric === key;
    tab.classList.toggle("is-active", selected);
    tab.classList.toggle("admin-stat-cell--active", selected);
    tab.setAttribute("aria-selected", selected ? "true" : "false");
  });
  if (title) title.textContent = config.title;
  if (description) description.textContent = config.description;
  if (source) source.textContent = sourceTextForMetric(payload, key);
  if (!chart) return;
  const data = valueAtPath(payload, config.seriesPath);
  chart.setAttribute("aria-label", `${config.label} analytics chart`);
  chart.innerHTML = config.type === "multiLine"
    ? renderMultiLineChart(data)
    : config.type === "bar"
      ? renderVerticalBarChart(data, { tone: config.tone })
      : renderLineChart(data, { tone: config.tone, fillArea: config.fillArea });
}

function sourceTextForMetric(payload, metricKey) {
  const traffic = payload?.sources?.traffic?.status === "ok"
    ? payload.sources.traffic.label
    : "Google Analytics unavailable";
  const featureUsage = payload?.sources?.featureUsage?.label || "Nest database";
  if (metricKey === "pageViews") {
    return `Source: ${traffic}`;
  }
  return `Source: ${featureUsage}`;
}

function renderDashboard(root, payload) {
  setMetricCards(root, payload);
  setCard(root, "onboardingRate", payload?.cards?.onboardingRate, "%");
  setMetricDeltas(root, payload);
  const rangeLabel = root.querySelector("[data-analytics-range-dropdown] [data-analytics-range-label]")?.textContent;
  syncPeriodLabels(root, rangeLabel);
  renderMainMetric(root, payload, root.dataset.activeMetric || "totalUsers");
}

export { renderDashboard, renderMainMetric, renderGaDetailPanel, renderGaDetails };
