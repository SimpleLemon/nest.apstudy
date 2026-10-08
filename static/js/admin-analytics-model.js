
const RANGE_KEYS = new Set(["24h", "7d", "14d", "30d", "60d", "all"]);

const METRIC_CONFIG = {
  totalUsers: {
    label: "Total Users",
    title: "Total Users",
    description: "Cumulative user growth from the first joined account.",
    type: "line",
    tone: "primary",
    fillArea: true,
    seriesPath: ["series", "totalUsers"],
    value: (payload) => payload?.cards?.totalUsers,
  },
  activeUsers: {
    label: "Users Active",
    title: "Users Active",
    description: "Distinct signed-in users who opened Nest in each bucket.",
    type: "line",
    tone: "primary",
    seriesPath: ["series", "activeUsers"],
    value: (payload) => payload?.cards?.activeUsers,
  },
  pageViews: {
    label: "Views",
    title: "Views",
    description: "Google Analytics page views across the selected range.",
    type: "line",
    tone: "primary",
    seriesPath: ["series", "pageViews"],
    value: (payload) => payload?.cards?.pageViews,
  },
  oauth: {
    label: "OAuth",
    title: "OAuth",
    description: "Cumulative signups by provider across the selected range.",
    type: "multiLine",
    tone: "primary",
    seriesPath: ["series", "oauth"],
    value: (payload) => payload?.cards?.oauth ?? sumMultiSeriesIncrease(payload?.series?.oauth),
  },
  uniType: {
    label: "Uni Type",
    title: "Uni Type",
    description: "Cumulative signups by education type across the selected range.",
    type: "multiLine",
    tone: "secondary",
    seriesPath: ["series", "uniType"],
    value: (payload) => payload?.cards?.uniType ?? sumMultiSeriesIncrease(payload?.series?.uniType),
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

function seriesIntervalIncrease(points) {
  const series = normalizeSeries(points);
  if (!series.length) return 0;
  if (series.length === 1) return series[0].value;
  return series[series.length - 1].value - series[0].value;
}

function sumMultiSeriesIncrease(groups) {
  return (Array.isArray(groups) ? groups : []).reduce(
    (total, group) => total + seriesIntervalIncrease(group?.points),
    0,
  );
}

function stableSeriesColor(key, index = 0) {
  let hash = 0;
  const text = String(key ?? index);
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash |= 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 62% 48%)`;
}

function formatNumber(value) {
  const number = Number(value || 0);
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(number);
}

function formatPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return `${Math.abs(number).toFixed(1)}%`;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function truncateLabel(label, limit = 16) {
  const text = String(label || "");
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}...` : text;
}

function cleanPageTitle(title, path) {
  const pagePath = String(path || "").trim();
  if (pagePath === "/") return "Landing Page";
  let text = String(title || "").trim();
  [" - APStudy Nest", " | APStudy Nest", " - APStudy", " | APStudy"].some((suffix) => {
    if (!text.endsWith(suffix)) return false;
    text = text.slice(0, -suffix.length).trim();
    return true;
  });
  return text || pagePath || "Untitled Page";
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

function normalizeDetailRows(items) {
  return Array.isArray(items)
    ? items.map((item) => {
        const path = String(item?.path || "");
        const title = cleanPageTitle(item?.title || item?.label, path);
        return {
          key: String(item?.key || item?.countryId || path || item?.label || ""),
          countryId: String(item?.countryId || ""),
          label: String(item?.countryId ? (item?.label || item?.countryId) : title),
          title,
          path,
          value: Number(item?.value || 0),
          comparison: item?.comparison || null,
        };
      }).filter((item) => item.label && item.value > 0)
    : [];
}

export { METRIC_CONFIG, getBrowserTimezone, normalizeRange, buildAnalyticsUrl, normalizeSeries, sumSeries, seriesIntervalIncrease, sumMultiSeriesIncrease, stableSeriesColor, formatNumber, formatPercent, clamp, truncateLabel, valueAtPath, niceAxis, normalizeDetailRows };
