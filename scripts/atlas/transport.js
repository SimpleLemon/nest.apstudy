const BASE = 'https://atlas.emory.edu/api/';
const HEADERS = {
  'Content-Type': 'application/json', 'Accept': 'application/json, text/javascript, */*; q=0.01',
  'X-Requested-With': 'XMLHttpRequest', 'Origin': 'https://atlas.emory.edu', 'Referer': 'https://atlas.emory.edu/',
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class AtlasAccessRefused extends Error {}

function createTransport({ fetchImpl = fetch, delay = 1500, detailsDelay = 1000, timeout = 20000, retries = 2 } = {}) {
  let lastRequest = 0;
  let refusal = null;
  function refuse(message) {
    refusal = new AtlasAccessRefused(message);
    throw refusal;
  }
  async function request(url, options = {}, minimumDelay = delay) {
    if (refusal) throw refusal;
    for (let attempt = 0; ; attempt++) {
      await sleep(Math.max(0, minimumDelay - (Date.now() - lastRequest)));
      lastRequest = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetchImpl(url, { ...options, redirect: 'manual', signal: controller.signal });
        if (response.headers?.get('x-amzn-waf-action') === 'challenge' || response.status === 202) {
          refuse(`Atlas access challenge at ${url} (HTTP ${response.status}); resolve it through normal browser access. No import was certified.`);
        }
        if ([401, 403].includes(response.status) || response.status >= 300 && response.status < 400) {
          refuse(`Atlas access refused at ${url} (HTTP ${response.status}); no import was certified.`);
        }
        const text = await response.text();
        if (/awswaf|captcha|verify (?:that )?you are human|javascript.*(?:challenge|verification)/i.test(text.slice(0, 8000))) {
          refuse(`Atlas returned an access challenge at ${url}; no import was certified.`);
        }
        if ([429, 500, 502, 503, 504].includes(response.status) && attempt < retries) {
          await sleep(1000 * (attempt + 1));
          continue;
        }
        if (!response.ok) throw new Error(`Atlas HTTP ${response.status} at ${url}`);
        return text;
      } finally { clearTimeout(timer); }
    }
  }
  return {
    fetchText: url => request(url, { headers: { Accept: 'text/html' } }),
    async post(route, body) {
      // Search nests the term under `other`; details requires it at the top
      // level. A nested detail term silently returns the default term instead.
      const { other, ...fields } = body;
      const payload = route === 'details' && other?.srcdb
        ? { ...fields, srcdb: body.srcdb ?? other.srcdb } : body;
      const text = await request(`${BASE}?page=fose&route=${route}`, { method: 'POST', headers: HEADERS, body: encodeURIComponent(JSON.stringify(payload)) }, route === 'details' ? Math.max(delay, detailsDelay) : delay);
      try { return JSON.parse(text); }
      catch { throw new Error(`Atlas ${route} returned invalid JSON; no import was certified.`); }
    },
  };
}

function sectionIdentity(row) {
  const code = String(row?.code ?? row?.course_code ?? '').trim();
  const crn = String(row?.crn ?? '').trim();
  const number = String(row?.no ?? row?.section_number ?? '').trim();
  if (!/^[A-Za-z0-9_&-]+\s+[^/\\.]+$/.test(code) || !crn || !number) throw new Error(`Invalid Atlas section identity: ${code}|${crn}|${number}`);
  return `${code}|${crn}|${number}`;
}

function expectedTotal(data) {
  // Only top-level totals describe query size; row-level `total` is not a roster count.
  const value = data.total_count ?? data.totalCount ?? data.total_results ?? data.totalResults ?? data.total ?? data.count;
  if (value === undefined || value === null) return null;
  if (!/^\d+$/.test(String(value))) throw new Error('Invalid Atlas search total.');
  return Number(value);
}

async function fetchAllResults(post, srcdb, criteria, { pageSize = 500, unpagedLimit = 2500 } = {}) {
  const rows = [];
  const seen = new Set();
  let offset = 0;
  let expected = null;
  let page = 1;
  for (let request = 0; request < 1000; request++) {
    const data = await post('search', { other: { srcdb, offset, limit: pageSize, page }, criteria });
    if (!data || data.fatal || !Array.isArray(data.results)) throw new Error(`Invalid Atlas search response${data?.fatal ? `: ${data.fatal}` : ''}`);
    if (String(data.srcdb ?? '') !== String(srcdb)) throw new Error('Atlas search response term does not match the requested term.');
    if (data.truncated || data.is_truncated || data.limit_exceeded) throw new Error('Atlas reported a truncated search response.');
    const total = expectedTotal(data);
    if (expected !== null && total !== null && expected !== total) throw new Error('Atlas search total changed during pagination; retry a stable roster.');
    expected = total ?? expected;
    for (const row of data.results) {
      const id = sectionIdentity(row);
      if (String(row.srcdb ?? srcdb) !== String(srcdb)) throw new Error(`Atlas returned a section from another term: ${id}`);
      if (seen.has(id)) throw new Error(`Duplicate Atlas section or ignored pagination: ${id}`);
      seen.add(id);
      rows.push(row);
    }
    if (expected !== null && rows.length > expected) throw new Error('Atlas returned more sections than its declared query total.');
    const nextOffset = data.next_offset ?? data.pagination?.next_offset;
    const nextPage = data.next_page ?? data.pagination?.next_page;
    const hasMore = data.has_more === true || data.hasMore === true || data.pagination?.has_more === true;
    const next = nextOffset !== undefined && nextOffset !== null || nextPage !== undefined && nextPage !== null;
    // Native FOSE responses report `count` and ignore requested limit/offset.
    // A count at the native ceiling cannot establish a complete unpaged roster.
    if (!next && !hasMore && data.count != null && data.results.length >= unpagedLimit) {
      throw new Error('Atlas reached its native unpaged result limit; roster may be truncated.');
    }
    if (!next && !hasMore && (expected === null || rows.length === expected)) {
      if (expected === null && data.results.length >= Math.min(pageSize, unpagedLimit)) {
        throw new Error('Atlas reached an unverified result limit without a total or continuation token; roster may be truncated.');
      }
      return { rows, requests: request + 1, source_total: expected, verified_ids: seen.size };
    }
    if (!data.results.length) throw new Error(`Atlas pagination ended before all ${expected ?? 'reported'} sections were received.`);
    const newOffset = nextOffset == null ? rows.length : Number(nextOffset);
    const newPage = nextPage == null ? page + 1 : Number(nextPage);
    if (!Number.isInteger(newOffset) || newOffset <= offset || !Number.isInteger(newPage) || newPage <= page) throw new Error('Atlas returned an invalid or repeating page cursor.');
    offset = newOffset;
    page = newPage;
  }
  throw new Error('Atlas pagination exceeded its safety bound.');
}

module.exports = { AtlasAccessRefused, createTransport, sectionIdentity, expectedTotal, fetchAllResults };
