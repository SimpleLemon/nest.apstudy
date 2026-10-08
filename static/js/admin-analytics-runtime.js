import { METRIC_CONFIG, normalizeRange, getBrowserTimezone, buildAnalyticsUrl } from "./admin-analytics-model.js";
import { renderDashboard, renderMainMetric, renderGaDetailPanel } from "./admin-analytics-dashboard.js";
import { initAnalyticsRangeDropdown } from "./admin-analytics-range.js";
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
  const metricTabs = Array.from(shell.querySelectorAll("[data-analytics-metric]"));
  const defaultRange = normalizeRange(shell.dataset.defaultRange || "30d");
  let activeRange = defaultRange;
  let activeMetric = "totalUsers";
  let latestPayload = null;
  let token = 0;
  const detailTokens = { countries: 0, pages: 0 };
  const timezone = getBrowserTimezone();

  const rangeDropdown = initAnalyticsRangeDropdown(shell, {
    defaultRange,
    onChange: (range) => {
      load(range);
    },
  });

  const load = async (range) => {
    activeRange = normalizeRange(range, defaultRange);
    rangeDropdown?.setActiveRange(activeRange);
    setNotice(shell, "Loading analytics...");
    const requestToken = ++token;
    try {
      const payload = await window.APStudyHttp.fetchJson(buildAnalyticsUrl(activeRange, timezone), {
        jsonMode: "required",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
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

  const loadDetailPanel = async (type, range) => {
    const dropdown = shell.querySelector(`[data-analytics-detail-range-dropdown="${type}"]`);
    const panel = dropdown?.closest(".admin-analytics-ga-panel") || dropdown?.closest(".admin-analytics-ga-detail-card");
    if (!panel) return;
    const detailRange = normalizeRange(range, defaultRange);
    const requestToken = ++detailTokens[type];
    try {
      const payload = await window.APStudyHttp.fetchJson(buildAnalyticsUrl(detailRange, timezone), {
        jsonMode: "required",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      if (requestToken !== detailTokens[type]) return;
      renderGaDetailPanel(panel, payload, type);
    } catch {
      if (requestToken !== detailTokens[type]) return;
      renderGaDetailPanel(panel, {
        gaDetails: { countries: [], pages: [] },
        sources: { traffic: { label: "Google Analytics unavailable", status: "error" } },
      }, type);
    }
  };

  shell.querySelectorAll("[data-analytics-detail-range-dropdown]").forEach((dropdown) => {
    const type = dropdown.dataset.analyticsDetailRangeDropdown;
    if (type !== "countries" && type !== "pages") return;
    initAnalyticsRangeDropdown(dropdown, {
      defaultRange,
      onChange: (range) => {
        loadDetailPanel(type, range);
      },
    });
    loadDetailPanel(type, defaultRange);
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

export { initAdminAnalytics };
