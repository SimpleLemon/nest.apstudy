(() => {
  const RANGE_KEYS = new Set(["24h", "7d", "14d", "30d", "60d", "all"]);

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

  function renderLineChart(points, { tone = "primary" } = {}) {
    const series = normalizeSeries(points);
    if (!series.length) return chartEmpty();
    const width = 640;
    const height = 220;
    const padX = 32;
    const padY = 28;
    const maxValue = Math.max(1, ...series.map((point) => point.value));
    const step = series.length > 1 ? (width - padX * 2) / (series.length - 1) : 0;
    const coords = series.map((point, index) => {
      const x = series.length > 1 ? padX + index * step : width / 2;
      const y = height - padY - (point.value / maxValue) * (height - padY * 2);
      return { ...point, x, y };
    });
    const path = coords.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
    const area = `${path} L${coords[coords.length - 1].x.toFixed(1)} ${height - padY} L${coords[0].x.toFixed(1)} ${height - padY} Z`;
    const labelEvery = Math.max(1, Math.ceil(series.length / 6));

    return `
      <svg class="admin-analytics-svg admin-analytics-svg--${tone}" viewBox="0 0 ${width} ${height}" role="presentation" aria-hidden="true">
        <line class="admin-analytics-axis" x1="${padX}" y1="${height - padY}" x2="${width - padX}" y2="${height - padY}"></line>
        <line class="admin-analytics-axis" x1="${padX}" y1="${padY}" x2="${padX}" y2="${height - padY}"></line>
        <path class="admin-analytics-area" d="${area}"></path>
        <path class="admin-analytics-line" d="${path}"></path>
        ${coords.map((point) => `<circle class="admin-analytics-dot" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="3"><title>${escapeHtml(point.label)}: ${formatNumber(point.value)}</title></circle>`).join("")}
        ${coords.filter((_, index) => index % labelEvery === 0 || index === coords.length - 1).map((point) => `<text class="admin-analytics-x-label" x="${point.x.toFixed(1)}" y="${height - 6}" text-anchor="middle">${escapeHtml(point.label)}</text>`).join("")}
        <text class="admin-analytics-y-label" x="${padX + 4}" y="${padY - 8}">${formatNumber(maxValue)}</text>
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
    setCard(root, "totalUsers", payload?.cards?.totalUsers);
    setCard(root, "activeUsers", payload?.cards?.activeUsers);
    setCard(root, "pageViews", payload?.cards?.pageViews);
    setCard(root, "onboardingRate", payload?.cards?.onboardingRate, "%");

    const chart = (name) => root.querySelector(`[data-chart="${name}"]`);
    const totalUsers = chart("totalUsers");
    const activeUsers = chart("activeUsers");
    const pageViews = chart("pageViews");
    const oauth = chart("oauth");
    const uniType = chart("uniType");

    if (totalUsers) totalUsers.innerHTML = renderLineChart(payload?.series?.totalUsers, { tone: "primary" });
    if (activeUsers) activeUsers.innerHTML = renderLineChart(payload?.series?.activeUsers, { tone: "success" });
    if (pageViews) pageViews.innerHTML = renderLineChart(payload?.series?.pageViews, { tone: "secondary" });
    if (oauth) oauth.innerHTML = renderBarList(payload?.breakdowns?.oauth);
    if (uniType) uniType.innerHTML = renderBarList(payload?.breakdowns?.uniType);

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
    const defaultRange = normalizeRange(shell.dataset.defaultRange || "30d");
    let activeRange = defaultRange;
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

    load(activeRange);
  }

  window.AdminAnalytics = {
    buildAnalyticsUrl,
    getBrowserTimezone,
    normalizeRange,
    normalizeSeries,
    renderBarList,
    renderLineChart,
  };

  initAdminAnalytics();
})();
