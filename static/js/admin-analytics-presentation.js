import { escapeHtml } from "./core/ui-primitives-module.js";
import { formatPercent } from "./admin-analytics-model.js";
const TREND_UP_SVG = '<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"><path d="m22 7-7.38 7.335c-.997.991-1.496 1.487-2.115 1.487s-1.117-.496-2.115-1.488l-.24-.238c-.997-.992-1.497-1.489-2.116-1.489s-1.118.497-2.115 1.49L2 18" opacity=".5"/><path d="M22 12.546V7h-5.582"/></svg>';
const TREND_DOWN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"><path d="m22 18-7.38-7.335c-.997-.991-1.496-1.487-2.115-1.487s-1.117.496-2.115 1.488l-.24.238c-.997.992-1.497 1.489-2.116 1.489s-1.118-.497-2.115-1.49L2 7" opacity=".5"/><path d="M22 12.454V18h-5.582"/></svg>';
const TREND_NEUTRAL_SVG = '<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.5"><path d="M5 12h14"/></svg>';

function comparisonForMetric(payload, key) {
  return payload?.comparison?.metrics?.[key] || null;
}

function deltaLabel(comparison) {
  if (!comparison?.available) return "";
  if (comparison.label) return String(comparison.label);
  if (comparison.percentChange == null) return "";
  const number = Number(comparison.percentChange);
  if (!Number.isFinite(number)) return "";
  const prefix = number > 0 ? "+" : number < 0 ? "-" : "";
  return `${prefix}${formatPercent(number)}`;
}

function deltaBadgeClass(comparison) {
  const direction = comparison?.direction === "up" ? "up" : comparison?.direction === "down" ? "down" : "neutral";
  return `admin-stat-delta admin-stat-delta--${direction}`;
}

function deltaTrendSvg(comparison) {
  if (comparison?.direction === "down") return TREND_DOWN_SVG;
  if (comparison?.direction === "up") return TREND_UP_SVG;
  return TREND_NEUTRAL_SVG;
}


function deltaMarkup(comparison) {
  const label = deltaLabel(comparison);
  if (!label) return "";
  return `<span class="${deltaBadgeClass(comparison)}" title="Compared with the previous period" aria-label="${escapeHtml(label)} compared with the previous period"><span>${escapeHtml(label)}${deltaTrendSvg(comparison)}</span></span>`;
}

function chartEmpty(label = "No data yet") {
  return `<div class="admin-analytics-empty">${escapeHtml(label)}</div>`;
}

export { comparisonForMetric, deltaLabel, deltaBadgeClass, deltaTrendSvg, deltaMarkup, chartEmpty };
