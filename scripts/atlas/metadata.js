/** Public Atlas metadata. Never infer published terms or Oxford subject codes. */
const fs = require('node:fs');
const { decodeHtmlEntities, stripTags } = require('./atlasCourseUtils');
const ATLAS_URL = 'https://atlas.emory.edu/';
const SEED_REGISTRY = require('../../data/atlas/registry.json');

function attribute(tag, name) {
  return decodeHtmlEntities(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag)?.slice(1).find(v => v !== undefined) || '');
}

function termKey(label) {
  const match = /\b(Spring|Summer|Fall|Winter)\s+(\d{4})\b/i.exec(label);
  if (!match) throw new Error(`Unrecognized Atlas term label: ${label}`);
  return `${match[1][0].toUpperCase()}${match[1].slice(1).toLowerCase()}_${match[2]}`;
}

function parseMetadataHtml(html, source = ATLAS_URL) {
  const fields = {};
  const fieldNames = {};
  for (const match of String(html).matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
    const tag = match[1];
    const rawField = attribute(tag, 'data-field') || attribute(tag, 'name') || attribute(tag, 'id');
    const field = rawField.replace(/^(?:crit|fose|search)[-_]/, '');
    const kind = /^(srcdb|term|semester)$/.test(field) ? 'terms'
      : /^(subject|subjects)$/.test(field) ? 'subjects'
        : /^(acad_career|academic_career|career|careers)$/.test(field) ? 'careers' : null;
    if (!kind) continue;
    fields[kind] = [];
    fieldNames[kind] = field;
    for (const option of match[2].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)) {
      const value = attribute(option[1], 'value').trim();
      const label = stripTags(option[2]).trim();
      if (!value || /^(all|any|\*)$/i.test(value) || /\bdisabled\b/i.test(option[1])) continue;
      fields[kind].push({ value, label });
    }
  }
  if (!fields.terms?.length || !fields.careers?.length || !fields.subjects?.length) {
    throw new Error('Atlas page did not expose complete term, career, and subject selectors. Supply an authoritative --metadata export; no completeness claim can be made.');
  }
  const terms = {};
  for (const term of fields.terms) {
    const key = termKey(term.label);
    if (terms[key]) throw new Error(`Duplicate Atlas term selector: ${key}`);
    terms[key] = { srcdb: term.value, label: term.label, published: true };
  }
  for (const match of stripTags(html).matchAll(/\b(Spring|Summer|Fall|Winter)\s+\d{4}\s+Classes are tentatively scheduled and subject to change\.?/gi)) {
    const term = terms[termKey(match[0])];
    if (term) Object.assign(term, { tentative: true, notice: match[0] });
  }
  return validateMetadata({
    version: 1, complete: true, source, discovered_at: new Date().toISOString(),
    career_field: fieldNames.careers, subject_field: fieldNames.subjects,
    terms,
    careers: fields.careers, subjects: fields.subjects,
  });
}

function normalizeOptions(options, kind) {
  if (!Array.isArray(options) || !options.length) throw new Error(`Metadata has no ${kind}.`);
  const values = new Set();
  return options.map(item => {
    const value = String(item.value ?? item.code ?? '').trim();
    const label = String(item.label ?? item.name ?? '').trim();
    if (!value || !label || values.has(value)) throw new Error(`Invalid or duplicate ${kind} metadata: ${value}`);
    values.add(value);
    return { ...item, value, label };
  });
}

function validateMetadata(input) {
  if (input?.version !== 1 || input.complete !== true) throw new Error('Metadata must be version 1 and explicitly complete:true; seeded/partial registries cannot certify an import.');
  if (!input.source || new URL(input.source).hostname !== 'atlas.emory.edu') throw new Error('Metadata source must be the official atlas.emory.edu site.');
  if (!input.discovered_at || !Number.isFinite(Date.parse(input.discovered_at))) throw new Error('Metadata requires its original discovered_at timestamp.');
  if (!input.terms || !Object.keys(input.terms).length) throw new Error('Metadata has no published terms.');
  const srcdbs = new Set();
  for (const [key, term] of Object.entries(input.terms)) {
    if (termKey(term.label) !== key || !/^\d+$/.test(String(term.srcdb)) || srcdbs.has(String(term.srcdb))) throw new Error(`Invalid or duplicate term metadata: ${key}`);
    srcdbs.add(String(term.srcdb));
  }
  const careerField = input.career_field || 'acad_career';
  const subjectField = input.subject_field || 'subject';
  if (!/^[a-z_]+$/.test(careerField) || !/^[a-z_]+$/.test(subjectField)) throw new Error('Invalid Atlas metadata field names.');
  return { ...input, career_field: careerField, subject_field: subjectField,
    careers: normalizeOptions(input.careers, 'careers'), subjects: normalizeOptions(input.subjects, 'subjects') };
}

function undergraduateCareers(metadata) {
  const careers = metadata.careers.filter(item => item.undergraduate !== false && (item.undergraduate === true
    || /undergrad|emory college|oxford|bachelor/i.test(item.label)));
  // An explicit common undergraduate career includes all undergraduate schools.
  // Otherwise metadata must enumerate each school; graduate nursing/business are not guessed.
  const common = careers.some(item => /^(undergraduate|undergraduates|undergraduate programs)$/i.test(item.label.trim()));
  const missing = common ? [] : [
    ['Emory College', /emory college/i], ['Oxford', /oxford/i],
    ['undergraduate business', /business|bba/i], ['undergraduate nursing', /nurs|bsn/i],
  ].filter(([, regex]) => !careers.some(item => regex.test(item.label))).map(([label]) => label);
  if (!careers.length || missing.length) throw new Error(`Undergraduate metadata coverage is incomplete: ${missing.join(', ') || 'no undergraduate careers'}. Use explicit undergraduate:true flags for official career labels where needed.`);
  return careers;
}

async function discoverMetadata({ metadataFile, fetchText }) {
  if (metadataFile) {
    const text = fs.readFileSync(metadataFile, 'utf8');
    return text.trimStart().startsWith('{') ? validateMetadata(JSON.parse(text)) : parseMetadataHtml(text);
  }
  return parseMetadataHtml(await fetchText(ATLAS_URL));
}

module.exports = { ATLAS_URL, SEED_REGISTRY, termKey, parseMetadataHtml, validateMetadata, undergraduateCareers, discoverMetadata };
