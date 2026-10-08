import { escapeHtml } from "./core/ui-primitives-module.js";
import { normalizeDetailRows, formatNumber } from "./admin-analytics-model.js";
import { deltaMarkup, chartEmpty } from "./admin-analytics-presentation.js";
function renderDetailRows(root, items, { type = "countries" } = {}) {
  if (!root) return;
  const rows = normalizeDetailRows(items);
  const maxValue = Math.max(1, ...rows.map((row) => row.value));
  const primaryHeader = type === "pages" ? "Page title and screen path" : "Country";
  const valueHeaderMarkup = type === "pages"
    ? `<span>${escapeHtml("Views")}</span>`
    : `<span aria-label="Active users">Users</span>`;
  root.innerHTML = `
    <div class="admin-analytics-rank-head">
      <span>${escapeHtml(primaryHeader)}</span>
      ${valueHeaderMarkup}
    </div>
    ${rows.length ? rows.map((row) => {
      const labelText = type === "pages" ? row.title : row.label;
      const labelTitle = labelText ? ` title="${escapeHtml(labelText)}"` : "";
      const pathTitle = row.path ? ` title="${escapeHtml(row.path)}"` : "";
      return `
      <div class="admin-analytics-rank-row admin-analytics-rank-row--compact">
        <div class="admin-analytics-rank-label">
          <strong${labelTitle}>${escapeHtml(labelText)}</strong>
          ${type === "pages" && row.path ? `<span${pathTitle}>${escapeHtml(row.path)}</span>` : ""}
        </div>
        <div class="admin-analytics-rank-value">
          <strong>${formatNumber(row.value)}</strong>
          ${deltaMarkup(row.comparison)}
        </div>
        <div class="admin-analytics-bar-track" aria-hidden="true">
          <span style="width:${Math.max(3, (row.value / maxValue) * 100).toFixed(1)}%"></span>
        </div>
      </div>
    `;
    }).join("") : chartEmpty()}
  `;
}

export { renderDetailRows };
