const path = require('node:path');
const { undergraduateCareers } = require('./metadata');
const { AtlasAccessRefused, sectionIdentity, fetchAllResults } = require('./transport');
const { mergeSectionWithDetails, normalizeCampus, splitCourseCode } = require('./atlasCourseUtils');
const { enrichRequirements } = require('./enrichment');
const { previousRows, differences, publishSnapshot, atomicJson } = require('./snapshots');

function assertRosterMatches(broad, partitioned) {
  const expected = new Set(broad.map(sectionIdentity));
  const actual = new Set(partitioned.map(sectionIdentity));
  if (expected.size !== broad.length || actual.size !== partitioned.length) throw new Error('Duplicate sections in the reconciled Atlas roster.');
  const missing = [...expected].filter(id => !actual.has(id));
  const unexpected = [...actual].filter(id => !expected.has(id));
  if (missing.length || unexpected.length) {
    const error = new Error(`Atlas career/subject roster mismatch: ${missing.length} missing, ${unexpected.length} unexpected sections.`);
    error.reconciliation = { missing, unexpected };
    throw error;
  }
  return { missing, unexpected };
}

async function collectRoster(metadata, term, transport, options = {}) {
  const careers = undergraduateCareers(metadata);
  const rows = new Map();
  const coverage = { scope: 'undergraduate', metadata_discovered_at: metadata.discovered_at, metadata_source: metadata.source,
    verification: 'career_subject_roster_identity', sections: 0, careers: {}, subjects: {}, discovered_subjects: {}, duplicates: [] };
  for (const career of careers) {
    const base = [{ field: metadata.career_field, value: career.value }];
    const broad = await fetchAllResults(transport.post, term.srcdb, base, options);
    // Atlas's dropdown omits some genuine subjects (e.g. ARCH, RES, SIRE).
    // Discover these from the official career roster and reconcile them too.
    const subjects = new Map(metadata.subjects.map(subject => [subject.value, subject]));
    for (const row of broad.rows) {
      const { subject } = splitCourseCode(row.code);
      if (!subjects.has(subject)) {
        subjects.set(subject, { value: subject, label: subject });
        const discovered = coverage.discovered_subjects[subject] ||= { source: 'career_roster', careers: [] };
        if (!discovered.careers.includes(career.value)) discovered.careers.push(career.value);
      }
    }
    const subjectRows = [];
    const bySubject = {};
    for (const subject of broad.source_total === 0 ? [] : subjects.values()) {
      const result = await fetchAllResults(transport.post, term.srcdb, [...base, { field: metadata.subject_field, value: subject.value }], options);
      for (const row of result.rows) {
        const returnedSubject = String(row.code).slice(0, String(row.code).lastIndexOf(' '));
        if (returnedSubject !== subject.value) throw new Error(`Atlas ignored subject filter ${subject.value}: returned ${row.code}.`);
        const returnedCareer = row[metadata.career_field] ?? row.acad_career ?? row.academic_career ?? row.career;
        if (returnedCareer && returnedCareer !== career.value) throw new Error(`Atlas ignored career filter ${career.value}: returned ${returnedCareer}.`);
        subjectRows.push(row);
      }
      bySubject[subject.value] = { sections: result.rows.length, source_total: result.source_total, requests: result.requests };
      coverage.subjects[subject.value] = (coverage.subjects[subject.value] || 0) + result.rows.length;
    }
    assertRosterMatches(broad.rows, subjectRows);
    coverage.careers[career.value] = { label: career.label, sections: broad.rows.length, source_total: broad.source_total,
      empty_roster_verified: broad.source_total === 0, subjects: bySubject };
    for (const row of broad.rows) {
      const id = sectionIdentity(row);
      const returnedCareer = row[metadata.career_field] ?? row.acad_career ?? row.academic_career ?? row.career;
      if (returnedCareer && String(returnedCareer) !== career.value) throw new Error(`Atlas ignored career filter ${career.value}: returned ${returnedCareer}.`);
      if (rows.has(id)) {
        coverage.duplicates.push(id);
        throw new Error(`Atlas returned the same section for different academic careers: ${id}. Career filter may have been ignored.`);
      }
      rows.set(id, { ...row, academic_career: career.value });
    }
    options.log?.(`Verified ${career.label}: ${broad.rows.length} sections across ${Object.keys(bySubject).length} subject queries.`);
  }
  coverage.sections = rows.size;
  if (!rows.size) throw new Error('Atlas returned an empty undergraduate roster; refusing to replace existing data.');
  return { rows: [...rows.values()], coverage };
}

async function enrichRoster(rows, srcdb, transport, options = {}) {
  const enriched = [];
  const errors = [];
  for (const row of rows) {
    if (options.details === false) { enriched.push(row); continue; }
    try {
      if (!row.key) throw new Error('Missing Atlas detail key');
      const detail = await transport.post('details', { other: { srcdb }, group: `key:${row.key}` });
      if (!detail || typeof detail !== 'object' || detail.fatal || !detail.code) throw new Error(detail?.fatal || 'Invalid detail response');
      if (String(detail.srcdb ?? '') !== String(srcdb)) throw new Error('Detail term does not match the verified roster');
      if (String(detail.code).trim() !== String(row.code).trim()
        || detail.crn != null && String(detail.crn) !== String(row.crn)
        || detail.key != null && String(detail.key) !== String(row.key)
        || detail.section != null && String(detail.section) !== String(row.no)) throw new Error('Detail section identity does not match the verified roster');
      enriched.push(mergeSectionWithDetails(row, detail));
    } catch (error) {
      // A challenge must halt further requests, rather than being retried for every section.
      if (error instanceof AtlasAccessRefused) throw error;
      errors.push({ section: sectionIdentity(row), message: error.message });
      enriched.push(row);
    }
  }
  return { rows: enriched, details: { enabled: options.details !== false, errors, status: options.details === false ? 'disabled' : errors.length ? 'partial' : 'complete' } };
}

async function importTerm({ metadata, termName, atlasRoot, legacyRoot, transport, options = {} }) {
  const term = metadata.terms[termName];
  if (!term || term.published === false) throw new Error(`Unknown or unpublished Atlas term: ${termName}`);
  const restricted = !!(options.subjects?.length || options.campuses?.length);
  if (restricted && !options.dryRun) throw new Error('Restricted undergraduate imports require a dry run.');
  const report = { version: 1, term: termName, srcdb: term.srcdb, started_at: new Date().toISOString(), status: 'failed', errors: [],
    source: transport.source || { kind: 'public-atlas-http' },
    reconciliation: { added: [], removed: [], missing: [], unexpected: [], duplicates: [] } };
  try {
    const roster = await collectRoster(metadata, term, transport, options);
    report.coverage = roster.coverage;
    report.reconciliation = { ...differences(previousRows(atlasRoot, termName, legacyRoot), roster.rows), missing: [], unexpected: [], duplicates: [] };
    const requirements = await enrichRequirements(roster.rows, metadata, term.srcdb, transport, options);
    report.requirements = requirements.requirements;
    const enrichment = await enrichRoster(requirements.rows, term.srcdb, transport, options);
    report.details = enrichment.details;
    if (report.details.errors.length || report.requirements.errors.length) {
      report.errors.push(...report.details.errors, ...report.requirements.errors);
      throw new Error('Requested enrichment is incomplete; active snapshot preserved. Use the explicit off option only if enrichment is not required.');
    }
    if (restricted) {
      const matching = enrichment.rows.filter(row => (!options.subjects?.length || options.subjects.includes(row.code.split(/\s+/)[0]))
        && (!options.campuses?.length || options.campuses.includes(normalizeCampus(row.campus_description || row.campus, row.code.split(/\s+/)[0]))));
      report.diagnostic = { subjects: options.subjects, campuses: options.campuses, sections: matching.length, identities: matching.map(sectionIdentity) };
    }
    report.finished_at = new Date().toISOString();
    if (options.dryRun) return { ...report, status: restricted ? 'diagnostic_dry_run' : 'validated_dry_run' };
    report.status = 'validated';
    return publishSnapshot({ atlasRoot, term: termName, metadata: term, rows: enrichment.rows, report });
  } catch (error) {
    report.finished_at = new Date().toISOString();
    report.error = error.message;
    report.errors.push({ message: error.message });
    if (error.reconciliation) report.reconciliation = { ...report.reconciliation, ...error.reconciliation };
    if (!options.dryRun) atomicJson(path.join(atlasRoot, 'reports', `${termName}-${Date.now()}-failed.json`), report);
    error.report = report;
    throw error;
  }
}

module.exports = { assertRosterMatches, collectRoster, enrichRoster, importTerm };
