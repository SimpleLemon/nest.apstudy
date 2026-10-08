/** Replay public Atlas responses collected through an accessible normal browser. */
const fs = require('node:fs');
const path = require('node:path');

function requestKey(route, body) {
  const srcdb = route === 'details' ? body?.srcdb ?? body?.other?.srcdb : body?.other?.srcdb;
  if (!['search', 'details'].includes(route) || !/^\d+$/.test(String(srcdb))) {
    throw new Error('Invalid Atlas browser export request.');
  }
  if (route === 'details') return JSON.stringify([route, String(srcdb), body.group]);
  if ((body.other.offset || 0) !== 0 || (body.other.page || 1) !== 1) {
    throw new Error('Browser export has no captured continuation page.');
  }
  if (!Array.isArray(body.criteria)) throw new Error('Invalid browser export search criteria.');
  const criteria = body.criteria.map(item => [String(item.field), String(item.value)])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify([route, String(body.other.srcdb), criteria]);
}

function createBrowserExportTransport(directory) {
  const root = fs.realpathSync(directory);
  const index = JSON.parse(fs.readFileSync(path.join(root, 'index.json'), 'utf8'));
  if (index.schema_version !== 1 || index.source !== 'public-atlas-brave'
    || index.origin !== 'https://atlas.emory.edu' || !Number.isFinite(Date.parse(index.captured_at))
    || !Array.isArray(index.requests) || !index.requests.length) {
    throw new Error('Atlas browser export requires public source provenance and captured requests.');
  }
  const records = new Map();
  for (const request of index.requests) {
    if (!/^\d{6}\.json$/.test(request.file)) throw new Error('Unsafe Atlas browser export filename.');
    const file = fs.realpathSync(path.join(root, request.file));
    if (path.dirname(file) !== root) throw new Error('Browser capture escaped its export directory.');
    const key = requestKey(request.route, request.body);
    if (records.has(key)) throw new Error('Duplicate Atlas browser export request.');
    records.set(key, { file, request });
  }
  return {
    source: { kind: index.source, captured_at: index.captured_at },
    async fetchText(url) {
      if (url !== 'https://atlas.emory.edu/') throw new Error('Unknown Atlas metadata URL.');
      return fs.readFileSync(path.join(root, 'metadata.html'), 'utf8');
    },
    async post(route, body) {
      const entry = records.get(requestKey(route, body));
      if (!entry) throw new Error(`Missing captured Atlas ${route} response; no import was certified.`);
      const record = JSON.parse(fs.readFileSync(entry.file, 'utf8'));
      const url = new URL(record.url);
      if (record.status !== 200 || url.origin !== index.origin || url.pathname !== '/api/'
        || url.searchParams.get('page') !== 'fose' || url.searchParams.get('route') !== route
        || !Number.isFinite(Date.parse(record.fetched_at))
        || requestKey(record.route, record.body) !== requestKey(route, body)
        || !record.data || typeof record.data !== 'object' || record.data.fatal
        || String(record.data.srcdb) !== String(body.srcdb ?? body.other?.srcdb)) {
        throw new Error('Atlas browser capture provenance or term did not verify.');
      }
      return record.data;
    },
  };
}

module.exports = { requestKey, createBrowserExportTransport };
