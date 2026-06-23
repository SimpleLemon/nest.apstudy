(() => {
  const RANGE_KEYS = new Set(["24h", "7d", "14d", "30d", "60d", "all"]);
  const METRIC_CONFIG = {
    totalUsers: {
      label: "Total Users",
      title: "Total Users",
      description: "Cumulative user growth from the first joined account.",
      type: "line",
      tone: "primary",
      seriesPath: ["series", "totalUsers"],
      value: (payload) => payload?.cards?.totalUsers,
    },
    activeUsers: {
      label: "Users Active",
      title: "Users Active",
      description: "Distinct users who opened Nest in each bucket.",
      type: "line",
      tone: "success",
      seriesPath: ["series", "activeUsers"],
      value: (payload) => payload?.cards?.activeUsers,
    },
    oauth: {
      label: "OAuth",
      title: "OAuth",
      description: "Google, Discord, GitHub, and other account providers.",
      type: "bar",
      tone: "primary",
      seriesPath: ["breakdowns", "oauth"],
      value: (payload) => sumSeries(payload?.breakdowns?.oauth),
    },
    uniType: {
      label: "Uni Type",
      title: "Uni Type",
      description: "Emory, university, high school, graduate, and other users.",
      type: "bar",
      tone: "secondary",
      seriesPath: ["breakdowns", "uniType"],
      value: (payload) => sumSeries(payload?.breakdowns?.uniType),
    },
  };

  function getBrowserTimezone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  }

  function normalizeRange(value, fallback = "30d") {
    return RANGE_KEYS.has(value) ? value : fallback;
  }

  function buildAnalyticsUrl(range, timezone) {
    const url = new URL("/admin/analytics/data", window.location.origin);
    url.searchParams.set("range", normalizeRange(range));
    url.searchParams.set("tz", timezone || getBrowserTimezone());
    return url.toString();
  }

  function normalizeSeries(points) {
    return Array.isArray(points)
      ? points.map((point) => ({
          key: String(point?.key || ""),
          label: String(point?.label || point?.key || ""),
          value: Number(point?.value || 0),
        }))
      : [];
  }

  function sumSeries(points) {
    return normalizeSeries(points).reduce((total, point) => total + point.value, 0);
  }

  function formatNumber(value) {
    const number = Number(value || 0);
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(number);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function chartEmpty(label = "No data yet") {
    return `<div class="admin-analytics-empty">${escapeHtml(label)}</div>`;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function truncateLabel(label, limit = 16) {
    const text = String(label || "");
    return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}...` : text;
  }

  function valueAtPath(payload, path) {
    return path.reduce((current, key) => current?.[key], payload);
  }

  function niceAxis(maxValue) {
    const max = Math.max(0, Number(maxValue || 0));
    if (max <= 0) {
      return { max: 10, ticks: [0, 2, 4, 6, 8, 10] };
    }
    const rawStep = max / 5;
    const magnitude = 10 ** Math.floor(Math.log10(rawStep || 1));
    const residual = rawStep / magnitude;
    const niceResidual = residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 5 ? 5 : 10;
    let axisMax = niceResidual * magnitude * 5;
    if (axisMax <= max) axisMax += niceResidual * magnitude;
    if (axisMax < 10) axisMax = 10;
    axisMax = Math.ceil(axisMax / 10) * 10;
    const step = axisMax / 5;
    return {
      max: axisMax,
      ticks: Array.from({ length: 6 }, (_, index) => Number((step * index).toFixed(6))),
    };
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

  function renderLineChart(points, { tone = "primary" } = {}) {
    const series = normalizeSeries(points);
    if (!series.length) return chartEmpty();
    const width = 760;
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
        <path class="admin-analytics-area" d="${area}"></path>
        <path class="admin-analytics-line" d="${path}"></path>
        ${coords.map((point) => {
          const hitWidth = Math.max(36, step || 36);
          const hitX = clamp(point.x - hitWidth / 2, padLeft, width - padRight - hitWidth);
          return `
          <g class="admin-analytics-hover-target" tabindex="0" role="listitem" aria-label="${escapeHtml(point.label)}: ${formatNumber(point.value)}">
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

  function renderList(root, title, items) {
    if (!root) return;
    const rows = normalizeSeries(items);
    root.innerHTML = `
      <h3>${escapeHtml(title)}</h3>
      ${rows.length ? rows.map((row) => `
        <div class="admin-analytics-list-row">
          <span>${escapeHtml(row.label)}</span>
          <strong>${formatNumber(row.value)}</strong>
        </div>
      `).join("") : chartEmpty()}
    `;
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
    const tabs = Array.from(root.querySelectorAll("[data-analytics-metric]"));
    tabs.forEach((tab) => {
      const selected = tab.dataset.analyticsMetric === key;
      tab.classList.toggle("is-active", selected);
      tab.setAttribute("aria-selected", selected ? "true" : "false");
    });
    if (title) title.textContent = config.title;
    if (description) description.textContent = config.description;
    if (!chart) return;
    const data = valueAtPath(payload, config.seriesPath);
    chart.setAttribute("aria-label", `${config.label} analytics chart`);
    chart.innerHTML = config.type === "bar"
      ? renderVerticalBarChart(data, { tone: config.tone })
      : renderLineChart(data, { tone: config.tone });
  }

  function renderGa4(root, ga4) {
    if (!root) return;
    if (!ga4?.configured) {
      root.innerHTML = `
        <span class="admin-badge admin-badge--muted">Not configured</span>
        <p>${escapeHtml(ga4?.message || "GA4 credentials are not configured.")}</p>
      `;
      return;
    }
    if (ga4.status !== "ok") {
      root.innerHTML = `
        <span class="admin-badge admin-badge--muted">Unavailable</span>
        <p>${escapeHtml(ga4.message || "Unable to load Google Analytics data.")}</p>
      `;
      return;
    }
    root.innerHTML = `
      <div class="admin-analytics-ga4-grid">
        <div><span>Active Users</span><strong>${formatNumber(ga4.totals?.activeUsers)}</strong></div>
        <div><span>Views</span><strong>${formatNumber(ga4.totals?.screenPageViews)}</strong></div>
        <div><span>Events</span><strong>${formatNumber(ga4.totals?.eventCount)}</strong></div>
        <div><span>Realtime</span><strong>${formatNumber(ga4.realtime?.activeUsers)}</strong></div>
      </div>
      ${renderBarList((ga4.realtime?.countries || []).map((row) => ({ label: row.country, value: row.activeUsers })))}
    `;
  }

  function renderDashboard(root, payload) {
    setMetricCards(root, payload);
    setCard(root, "pageViews", payload?.cards?.pageViews);
    setCard(root, "onboardingRate", payload?.cards?.onboardingRate, "%");

    const chart = (name) => root.querySelector(`[data-chart="${name}"]`);
    const pageViews = chart("pageViews");

    renderMainMetric(root, payload, root.dataset.activeMetric || "totalUsers");
    if (pageViews) pageViews.innerHTML = renderLineChart(payload?.series?.pageViews, { tone: "secondary" });

    renderList(root.querySelector('[data-analytics-list="topPages"]'), "Top Pages", payload?.engagement?.topPages);
    renderList(root.querySelector('[data-analytics-list="featureUsage"]'), "Feature Usage", payload?.engagement?.featureUsage);
    renderGa4(root.querySelector("[data-analytics-ga4]"), payload?.ga4);
  }

  function setNotice(root, message, isError = false) {
    const notice = root.querySelector("[data-analytics-notice]");
    if (!notice) return;
    notice.hidden = !message;
    notice.textContent = message || "";
    notice.classList.toggle("is-error", isError);
  }

  function initAdminAnalytics(root = document) {
    const shell = root.querySelector("[data-admin-analytics]");
    if (!shell) return;
    const buttons = Array.from(shell.querySelectorAll("[data-analytics-range]"));
    const metricTabs = Array.from(shell.querySelectorAll("[data-analytics-metric]"));
    const defaultRange = normalizeRange(shell.dataset.defaultRange || "30d");
    let activeRange = defaultRange;
    let activeMetric = "totalUsers";
    let latestPayload = null;
    let token = 0;
    const timezone = getBrowserTimezone();

    const syncButtons = () => {
      buttons.forEach((button) => {
        button.classList.toggle("is-active", button.dataset.analyticsRange === activeRange);
      });
    };

    const load = async (range) => {
      activeRange = normalizeRange(range, defaultRange);
      syncButtons();
      setNotice(shell, "Loading analytics...");
      const requestToken = ++token;
      try {
        const response = await fetch(buildAnalyticsUrl(activeRange, timezone), {
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload.error || "Unable to load analytics.");
        }
        if (requestToken !== token) return;
        latestPayload = payload;
        shell.dataset.activeMetric = activeMetric;
        renderDashboard(shell, payload);
        setNotice(shell, "");
      } catch (error) {
        if (requestToken !== token) return;
        setNotice(shell, error.message || "Unable to load analytics.", true);
      }
    };

    buttons.forEach((button) => {
      button.addEventListener("click", () => {
        load(button.dataset.analyticsRange);
      });
    });

    metricTabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        activeMetric = METRIC_CONFIG[tab.dataset.analyticsMetric] ? tab.dataset.analyticsMetric : "totalUsers";
        shell.dataset.activeMetric = activeMetric;
        if (latestPayload) renderMainMetric(shell, latestPayload, activeMetric);
      });
    });

    load(activeRange);
  }

  window.AdminAnalytics = {
    buildAnalyticsUrl,
    getBrowserTimezone,
    niceAxis,
    normalizeRange,
    normalizeSeries,
    renderDashboard,
    renderBarList,
    renderVerticalBarChart,
    renderLineChart,
    sumSeries,
  };

  initAdminAnalytics();
})();
