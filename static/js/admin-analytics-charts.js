import { escapeHtml } from "./core/ui-primitives-module.js";
import { normalizeSeries, seriesIntervalIncrease, stableSeriesColor, niceAxis, formatNumber, clamp, truncateLabel } from "./admin-analytics-model.js";
import { chartEmpty } from "./admin-analytics-presentation.js";
function renderMultiTooltip(bucketLabel, entries, x, y, bounds = { width: 760, height: 300 }) {
  const title = String(bucketLabel || "");
  const rowMarkup = entries.map((entry, index) => `
    <text x="12" y="${34 + index * 16}">
      <tspan fill="${entry.color}">●</tspan>
      <tspan> ${escapeHtml(truncateLabel(entry.label, 18))}: ${escapeHtml(formatNumber(entry.value))}</tspan>
    </text>
  `).join("");
  const boxWidth = clamp(Math.max(160, title.length * 7 + 34, ...entries.map((entry) => entry.label.length * 7 + 48)), 160, 260);
  const boxHeight = 28 + entries.length * 16;
  const boxX = clamp(x - boxWidth / 2, 8, bounds.width - boxWidth - 8);
  const boxY = y - boxHeight - 14 < 8 ? y + 16 : y - boxHeight - 14;
  return `
    <g class="admin-analytics-tooltip" role="tooltip" transform="translate(${boxX.toFixed(1)} ${boxY.toFixed(1)})">
      <rect width="${boxWidth.toFixed(1)}" height="${boxHeight}" rx="8"></rect>
      <text x="12" y="18">${escapeHtml(truncateLabel(title, 28))}</text>
      ${rowMarkup}
    </g>
  `;
}

function renderMultiLineChart(seriesGroups) {
  const groups = (Array.isArray(seriesGroups) ? seriesGroups : []).map((group, index) => ({
    key: String(group?.key || index),
    label: String(group?.label || group?.key || ""),
    points: normalizeSeries(group?.points),
    color: stableSeriesColor(group?.key, index),
    increase: seriesIntervalIncrease(group?.points),
  })).filter((group) => group.points.length && (group.increase > 0 || group.points.some((point) => point.value > 0)));
  if (!groups.length) return chartEmpty();

  const width = 1200;
  const height = 300;
  const padLeft = 28;
  const padRight = 58;
  const padTop = 28;
  const padBottom = 42;
  const chartWidth = width - padLeft - padRight;
  const chartHeight = height - padTop - padBottom;
  const bucketCount = groups[0].points.length;
  const axis = niceAxis(Math.max(0, ...groups.flatMap((group) => group.points.map((point) => point.value))));
  const step = bucketCount > 1 ? chartWidth / (bucketCount - 1) : 0;
  const labelEvery = Math.max(1, Math.ceil(bucketCount / 6));

  const plotted = groups.map((group) => ({
    ...group,
    coords: group.points.map((point, index) => {
      const x = bucketCount > 1 ? padLeft + index * step : padLeft + chartWidth / 2;
      const y = padTop + chartHeight - (point.value / axis.max) * chartHeight;
      return { ...point, x, y };
    }),
  }));

  const hoverBuckets = Array.from({ length: bucketCount }, (_, index) => ({
    label: plotted[0].coords[index]?.label || "",
    x: plotted[0].coords[index]?.x || padLeft,
    entries: plotted.map((group) => ({
      label: group.label,
      value: group.coords[index]?.value || 0,
      color: group.color,
    })),
  }));

  const legend = plotted.map((group) => `
    <div class="admin-analytics-legend-item" role="listitem">
      <span class="admin-analytics-legend-swatch" style="background:${group.color}"></span>
      <span class="admin-analytics-legend-label">${escapeHtml(group.label)}</span>
      <strong class="admin-analytics-legend-value">+${formatNumber(group.increase)}</strong>
    </div>
  `).join("");

  return `
    <div class="admin-analytics-multiline">
      <svg class="admin-analytics-svg admin-analytics-svg--multiline" viewBox="0 0 ${width} ${height}" role="img" aria-label="Multi-series line chart">
        ${axis.ticks.map((tick) => {
          const y = padTop + chartHeight - (tick / axis.max) * chartHeight;
          return `
            <line class="admin-analytics-grid-line" x1="${padLeft}" y1="${y.toFixed(1)}" x2="${width - padRight}" y2="${y.toFixed(1)}"></line>
            <text class="admin-analytics-y-label" x="${width - padRight + 14}" y="${(y + 4).toFixed(1)}">${formatNumber(tick)}</text>
          `;
        }).join("")}
        <line class="admin-analytics-axis" x1="${padLeft}" y1="${height - padBottom}" x2="${width - padRight}" y2="${height - padBottom}"></line>
        ${plotted.map((group) => {
          const path = group.coords.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
          return `<path class="admin-analytics-line admin-analytics-series-line" d="${path}" style="stroke:${group.color}"></path>`;
        }).join("")}
        ${hoverBuckets.map((bucket, bucketIndex) => {
          const hitWidth = Math.max(36, step || 36);
          const hitX = clamp(bucket.x - hitWidth / 2, padLeft, width - padRight - hitWidth);
          const summary = bucket.entries.map((entry) => `${entry.label}: ${formatNumber(entry.value)}`).join(", ");
          const anchorY = bucket.entries.reduce((maxY, entry) => {
            const y = padTop + chartHeight - (entry.value / axis.max) * chartHeight;
            return Math.min(maxY, y);
          }, padTop + chartHeight);
          return `
            <g class="admin-analytics-hover-target" tabindex="0" role="listitem" aria-label="${escapeHtml(bucket.label)}: ${escapeHtml(summary)}">
              <rect class="admin-analytics-hover-band" x="${hitX.toFixed(1)}" y="${padTop}" width="${hitWidth.toFixed(1)}" height="${chartHeight}" rx="4"></rect>
              <rect class="admin-analytics-hit-area" x="${hitX.toFixed(1)}" y="${padTop}" width="${hitWidth.toFixed(1)}" height="${chartHeight}" rx="4"></rect>
              <line class="admin-analytics-hover-line admin-analytics-series-hover-line" x1="${bucket.x.toFixed(1)}" y1="${padTop}" x2="${bucket.x.toFixed(1)}" y2="${height - padBottom}"></line>
              ${plotted.map((group) => {
                const point = group.coords[bucketIndex];
                return `<circle class="admin-analytics-dot admin-analytics-series-dot" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="4" style="fill:${group.color};stroke:${group.color}"></circle>`;
              }).join("")}
              ${renderMultiTooltip(bucket.label, bucket.entries, bucket.x, anchorY, { width, height })}
            </g>
          `;
        }).join("")}
        ${plotted[0].coords.filter((_, index) => index % labelEvery === 0 || index === plotted[0].coords.length - 1).map((point) => `<text class="admin-analytics-x-label" x="${point.x.toFixed(1)}" y="${height - 12}" text-anchor="middle">${escapeHtml(point.label)}</text>`).join("")}
      </svg>
      <div class="admin-analytics-legend" role="list" aria-label="Series legend">${legend}</div>
    </div>
  `;
}

function renderTooltip(label, value, x, y, bounds = { width: 760, height: 300 }) {
  const valueText = formatNumber(value);
  const title = String(label || "");
  const boxWidth = clamp(Math.max(126, title.length * 7 + 34, valueText.length * 13 + 34), 126, 240);
  const boxHeight = 46;
  const boxX = clamp(x - boxWidth / 2, 8, bounds.width - boxWidth - 8);
  const boxY = y - boxHeight - 14 < 8 ? y + 16 : y - boxHeight - 14;
  return `
    <g class="admin-analytics-tooltip" role="tooltip" transform="translate(${boxX.toFixed(1)} ${boxY.toFixed(1)})">
      <rect width="${boxWidth.toFixed(1)}" height="${boxHeight}" rx="8"></rect>
      <text x="12" y="18">${escapeHtml(truncateLabel(title, 28))}</text>
      <text class="admin-analytics-tooltip-value" x="12" y="36">${escapeHtml(valueText)}</text>
    </g>
  `;
}

function renderLineChart(points, { tone = "primary", fillArea = false } = {}) {
  const series = normalizeSeries(points);
  if (!series.length) return chartEmpty();
  const width = 1200;
  const height = 300;
  const padLeft = 28;
  const padRight = 58;
  const padTop = 28;
  const padBottom = 42;
  const chartWidth = width - padLeft - padRight;
  const chartHeight = height - padTop - padBottom;
  const axis = niceAxis(Math.max(0, ...series.map((point) => point.value)));
  const step = series.length > 1 ? chartWidth / (series.length - 1) : 0;
  const coords = series.map((point, index) => {
    const x = series.length > 1 ? padLeft + index * step : padLeft + chartWidth / 2;
    const y = padTop + chartHeight - (point.value / axis.max) * chartHeight;
    return { ...point, x, y };
  });
  const path = coords.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
  const area = `${path} L${coords[coords.length - 1].x.toFixed(1)} ${height - padBottom} L${coords[0].x.toFixed(1)} ${height - padBottom} Z`;
  const labelEvery = Math.max(1, Math.ceil(series.length / 6));

  return `
    <svg class="admin-analytics-svg admin-analytics-svg--${tone}" viewBox="0 0 ${width} ${height}" role="list">
      ${axis.ticks.map((tick) => {
        const y = padTop + chartHeight - (tick / axis.max) * chartHeight;
        return `
          <line class="admin-analytics-grid-line" x1="${padLeft}" y1="${y.toFixed(1)}" x2="${width - padRight}" y2="${y.toFixed(1)}"></line>
          <text class="admin-analytics-y-label" x="${width - padRight + 14}" y="${(y + 4).toFixed(1)}">${formatNumber(tick)}</text>
        `;
      }).join("")}
      <line class="admin-analytics-axis" x1="${padLeft}" y1="${height - padBottom}" x2="${width - padRight}" y2="${height - padBottom}"></line>
      ${fillArea ? `<path class="admin-analytics-area" d="${area}"></path>` : ""}
      <path class="admin-analytics-line" d="${path}"></path>
      ${coords.map((point) => {
        const hitWidth = Math.max(36, step || 36);
        const hitX = clamp(point.x - hitWidth / 2, padLeft, width - padRight - hitWidth);
        return `
        <g class="admin-analytics-hover-target" tabindex="0" role="listitem" aria-label="${escapeHtml(point.label)}: ${formatNumber(point.value)}">
          <rect class="admin-analytics-hover-band" x="${hitX.toFixed(1)}" y="${padTop}" width="${hitWidth.toFixed(1)}" height="${chartHeight}" rx="4"></rect>
          <rect class="admin-analytics-hit-area" x="${hitX.toFixed(1)}" y="${padTop}" width="${hitWidth.toFixed(1)}" height="${chartHeight}" rx="4"></rect>
          <line class="admin-analytics-hover-line" x1="${point.x.toFixed(1)}" y1="${padTop}" x2="${point.x.toFixed(1)}" y2="${height - padBottom}"></line>
          <circle class="admin-analytics-dot" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="4"></circle>
          ${renderTooltip(point.label, point.value, point.x, point.y, { width, height })}
        </g>
      `;
      }).join("")}
      ${coords.filter((_, index) => index % labelEvery === 0 || index === coords.length - 1).map((point) => `<text class="admin-analytics-x-label" x="${point.x.toFixed(1)}" y="${height - 12}" text-anchor="middle">${escapeHtml(point.label)}</text>`).join("")}
    </svg>
  `;
}

function renderVerticalBarChart(items, { tone = "primary" } = {}) {
  const rows = normalizeSeries(items);
  if (!rows.length) return chartEmpty();
  const width = 760;
  const height = 300;
  const padLeft = 28;
  const padRight = 58;
  const padTop = 28;
  const padBottom = 58;
  const chartWidth = width - padLeft - padRight;
  const chartHeight = height - padTop - padBottom;
  const axis = niceAxis(Math.max(0, ...rows.map((row) => row.value)));
  const slot = chartWidth / Math.max(1, rows.length);
  const barWidth = Math.min(74, slot * 0.58);

  return `
    <svg class="admin-analytics-svg admin-analytics-svg--${tone}" viewBox="0 0 ${width} ${height}" role="list">
      ${axis.ticks.map((tick) => {
        const y = padTop + chartHeight - (tick / axis.max) * chartHeight;
        return `
          <line class="admin-analytics-grid-line" x1="${padLeft}" y1="${y.toFixed(1)}" x2="${width - padRight}" y2="${y.toFixed(1)}"></line>
          <text class="admin-analytics-y-label" x="${width - padRight + 14}" y="${(y + 4).toFixed(1)}">${formatNumber(tick)}</text>
        `;
      }).join("")}
      <line class="admin-analytics-axis" x1="${padLeft}" y1="${height - padBottom}" x2="${width - padRight}" y2="${height - padBottom}"></line>
      ${rows.map((row, index) => {
        const barHeight = (row.value / axis.max) * chartHeight;
        const x = padLeft + index * slot + (slot - barWidth) / 2;
        const y = padTop + chartHeight - barHeight;
        return `
          <g class="admin-analytics-hover-target admin-analytics-bar-target" tabindex="0" role="listitem" aria-label="${escapeHtml(row.label)}: ${formatNumber(row.value)}">
            <rect class="admin-analytics-bar-column" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${Math.max(2, barHeight).toFixed(1)}" rx="5"></rect>
            ${renderTooltip(row.label, row.value, x + barWidth / 2, y, { width, height })}
          </g>
          <text class="admin-analytics-x-label" x="${(padLeft + index * slot + slot / 2).toFixed(1)}" y="${height - 22}" text-anchor="middle">${escapeHtml(truncateLabel(row.label, 18))}</text>
        `;
      }).join("")}
    </svg>
  `;
}

function renderBarList(items) {
  const rows = normalizeSeries(items);
  if (!rows.length) return chartEmpty();
  const maxValue = Math.max(1, ...rows.map((row) => row.value));
  return `
    <div class="admin-analytics-bars">
      ${rows.map((row) => `
        <div class="admin-analytics-bar-row">
          <div class="admin-analytics-bar-meta">
            <span>${escapeHtml(row.label)}</span>
            <strong>${formatNumber(row.value)}</strong>
          </div>
          <div class="admin-analytics-bar-track" aria-hidden="true">
            <span style="width:${Math.max(3, (row.value / maxValue) * 100).toFixed(1)}%"></span>
          </div>
        </div>
      `).join("")}
    </div>
  `;
}

export { renderMultiLineChart, renderLineChart, renderVerticalBarChart, renderBarList };
