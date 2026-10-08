const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sectionIdentity } = require('./transport');
const { buildCourseObject } = require('./atlasCourseUtils');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

function containedPath(root, relative) {
  const absolute = path.resolve(root, relative);
  if (absolute === path.resolve(root) || !absolute.startsWith(path.resolve(root) + path.sep)) throw new Error('Snapshot path escapes Atlas storage.');
  return absolute;
}

function readCourses(directory) {
  if (!fs.existsSync(directory)) return [];
  const courses = [];
  for (const subject of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!subject.isDirectory() || subject.name.startsWith('.')) continue;
    for (const file of fs.readdirSync(path.join(directory, subject.name))) {
      if (file.endsWith('.json')) courses.push(readJson(path.join(directory, subject.name, file)));
    }
  }
  return courses;
}

function previousRows(atlasRoot, term, legacyRoot) {
  const manifest = readJson(path.join(atlasRoot, 'manifest.json'), { version: 1, terms: {} });
  const entry = manifest.terms[term];
  const directory = entry?.path ? containedPath(atlasRoot, entry.path) : path.join(legacyRoot, term);
  return readCourses(directory).flatMap(course => (course.sections || []).map(section => ({ ...section, code: course.course_code })));
}

function differences(previous, current) {
  const before = new Set(previous.map(sectionIdentity));
  const after = new Set(current.map(sectionIdentity));
  return { added: [...after].filter(id => !before.has(id)).sort(), removed: [...before].filter(id => !after.has(id)).sort() };
}

function publishSnapshot({ atlasRoot, term, metadata, rows, report, catalogCourseMap = {}, beforePublish }) {
  if (!/^(Spring|Summer|Fall|Winter)_\d{4}$/.test(term) || !/^\d+$/.test(String(metadata?.srcdb))) throw new Error('Invalid snapshot term metadata.');
  if (report?.status !== 'validated' || report.coverage?.scope !== 'undergraduate'
    || report.coverage?.verification !== 'career_subject_roster_identity'
    || report.coverage.sections !== rows.length || !rows.length
    || report.errors?.length || ['missing', 'unexpected', 'duplicates'].some(key => report.reconciliation?.[key]?.length)) {
    throw new Error('Only a complete, reconciled undergraduate roster can be published.');
  }
  if (new Set(rows.map(sectionIdentity)).size !== rows.length) throw new Error('Duplicate section identities prevent snapshot publication.');
  const generation = `${new Date().toISOString().replace(/[-:.]/g, '')}-${crypto.randomUUID().slice(0, 8)}`;
  const relative = path.posix.join('snapshots', term, generation);
  const destination = containedPath(atlasRoot, relative);
  const staging = path.join(atlasRoot, '.staging', `${term}-${generation}`);
  fs.mkdirSync(staging, { recursive: true });
  try {
    const grouped = new Map();
    for (const row of rows) {
      sectionIdentity(row);
      if (!grouped.has(row.code)) grouped.set(row.code, []);
      grouped.get(row.code).push(row);
    }
    for (const [code, sections] of grouped) {
      const course = buildCourseObject(code, sections, term, metadata.srcdb, catalogCourseMap);
      if (!/^[A-Za-z0-9_&-]+$/.test(course.subject) || !/^[A-Za-z0-9_&-]+$/.test(course.catalog_number)) throw new Error(`Unsafe course filename: ${code}`);
      const directory = path.join(staging, course.subject);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, `${course.catalog_number}.json`), JSON.stringify(course, null, 2) + '\n', { flag: 'wx' });
    }
    const publishedReport = { ...report, generation, path: relative, status: 'complete', courses: grouped.size };
    fs.writeFileSync(path.join(staging, '_report.json'), JSON.stringify(publishedReport, null, 2) + '\n');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(staging, destination);
    // A process interrupted here leaves an unreferenced immutable generation;
    // readers continue seeing the previous manifest, never a partial term.
    if (beforePublish) beforePublish();
    const manifestFile = path.join(atlasRoot, 'manifest.json');
    const manifest = readJson(manifestFile, { version: 1, terms: {} });
    const previous = manifest.terms[term];
    const history = previous ? [{ generation: previous.generation, path: previous.path }, ...(previous.previous_generations || [])] : [];
    manifest.terms[term] = { srcdb: String(metadata.srcdb), label: metadata.label, status: 'complete', generation, path: relative,
      tentative: metadata.tentative === true, notice: metadata.notice || null,
      last_successful_refresh: report.finished_at, coverage: report.coverage, previous_generations: history };
    atomicJson(manifestFile, manifest);
    return publishedReport;
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}

function acquireImportLock(atlasRoot) {
  fs.mkdirSync(atlasRoot, { recursive: true });
  const file = path.join(atlasRoot, '.import.lock');
  try { fs.writeFileSync(file, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }), { flag: 'wx' }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Atlas importer lock exists at ${file}. Check that its process has stopped before removing a stale lock.`);
    throw error;
  }
  return () => fs.rmSync(file, { force: true });
}

module.exports = { readJson, atomicJson, containedPath, readCourses, previousRows, differences, publishSnapshot, acquireImportLock };
