/**
 * atlasMainScraper.js -- Bulk Atlas Scraper
 *
 * One-time scraper that pulls all course sections from Emory Atlas
 * for specified terms, grouped by subject and catalog number,
 * and writes structured JSON files to disk.
 *
 * Usage:  npm run scrape:atlas
 *
 * Output: /{term}/{SUBJECT}/{catalogNum}.json
 *
 * Confirmed constraints (April 2026):
 *   - POST to https://atlas.emory.edu/api/?page=fose&route=search
 *   - Browser-like headers required (Referer, Origin, X-Requested-With)
 *   - Details route is broken; search results are the only data source
 *   - No "list all subjects" endpoint; subject codes are hardcoded
 *   - enrl_stat server-side filter does not work; filtered client-side
 *   - meetingTimes is a JSON string inside JSON; must be double-parsed
 */

const fs = require('fs');
const path = require('path');

// ── Configuration ────────────────────────────────────────────────────────────

const ATLAS_BASE = 'https://atlas.emory.edu/api/';

const TERMS = {
  'Spring_2026': '5261',
  'Fall_2026': '5269',
};

/** Delay between subject requests in ms. Be respectful. */
const REQUEST_DELAY_MS = 1500;

/** Output root directory. The Flask app reads term directories at repo root. */
const OUTPUT_DIR = process.env.ATLAS_OUTPUT_DIR
  ? path.resolve(process.env.ATLAS_OUTPUT_DIR)
  : __dirname;

const DRY_RUN = process.env.ATLAS_DRY_RUN === '1';
const CATALOG_INDEX_URL = 'https://catalog.college.emory.edu/academics/departments/index.html';
const CATALOG_DEPARTMENT_BASE_URL = 'https://catalog.college.emory.edu/academics/departments/';
const CATALOG_HEADERS = {
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

/** Headers required by the FOSE engine. Without these, Atlas returns empty. */
const REQUIRED_HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'X-Requested-With': 'XMLHttpRequest',
  'Origin': 'https://atlas.emory.edu',
  'Referer': 'https://atlas.emory.edu/',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

/**
 * Emory subject codes. This list covers the major undergraduate departments
 * and graduate programs. Add or remove codes as needed.
 *
 * Source: Emory registrar department listing + manual verification.
 * Not all codes may be active in every term.
 */
const SUBJECT_CODES = [
  // A
  'AAAS', 'ACCT', 'AMST', 'ANT', 'ARAB', 'ARTHIST', 'ARTS',
  // B
  'BDS', 'BIOL', 'BIOS', 'BMED', 'BSHE', 'BUS',
  // C
  'CHEM', 'CHIN', 'CL', 'CMPL', 'CPLT', 'CS',
  // D
  'DANC', 'DTSC',
  // E
  'ECON', 'ECS', 'EDUC', 'EH', 'EMBRYO', 'ENG', 'ENGRD', 'ENVS', 'EPID',
  // F
  'FILM', 'FIN', 'FREN',
  // G
  'GERM', 'GH', 'GRAD', 'GRK', 'GRS',
  // H
  'HEBR', 'HINDI', 'HIST', 'HLTH', 'HPM',
  // I
  'IBS', 'IDS', 'INFO', 'INTA', 'ISOM', 'ITAL',
  // J
  'JPN', 'JS',
  // K
  'KRN',
  // L
  'LACS', 'LAT', 'LING',
  // M
  'MATH', 'MESAS', 'MKT', 'ML', 'MOT', 'MPHY', 'MUS',
  // N
  'NBB', 'NBIO', 'NRSG', 'NS',
  // O
  'OAM',
  'OXAB', 'OXAS', 'OXBI', 'OXCH', 'OXCM', 'OXEC', 'OXEG',
  'OXEN', 'OXES', 'OXHI', 'OXHU', 'OXIS', 'OXLA', 'OXMA', 'OXMU',
  'OXNE', 'OXPH', 'OXPL', 'OXPS', 'OXRE', 'OXSO', 'OXSP',
  'OXTH', 'OXWT',
  // P
  'PACS', 'PATH', 'PE', 'PERS', 'PHAR', 'PHIL', 'PHYS', 'PLSH', 'POLS', 'PORT', 'PSYC',
  // Q
  'QSS', 'QTM',
  // R
  'REL', 'RLGS', 'RUSS',
  // S
  'SA', 'SOC', 'SPAN', 'SURG',
  // T
  'THEA', 'TIBTN',
  // W
  'WGS', 'WRIT',
];

function parseEnvList(value) {
  return (value ?? '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

const SELECTED_TERMS = parseEnvList(process.env.ATLAS_TERMS).length
  ? Object.fromEntries(
      Object.entries(TERMS).filter(([term]) => parseEnvList(process.env.ATLAS_TERMS).includes(term))
    )
  : TERMS;

const SELECTED_SUBJECT_CODES = parseEnvList(process.env.ATLAS_SUBJECTS).length
  ? SUBJECT_CODES.filter(subject => parseEnvList(process.env.ATLAS_SUBJECTS).includes(subject))
  : SUBJECT_CODES;

// ── Day code mapping ─────────────────────────────────────────────────────────

const DAY_MAP = {
  '0': 'Mon',
  '1': 'Tue',
  '2': 'Wed',
  '3': 'Thu',
  '4': 'Fri',
  '5': 'Sat',
  '6': 'Sun',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options = {}, timeout = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, options = {}, timeout = 15000) {
  const res = await fetchWithTimeout(url, options, timeout);
  return res.text();
}

async function postJson(url, params, body, headers, timeout = 15000) {
  const requestUrl = new URL(url);
  for (const [key, value] of Object.entries(params ?? {})) {
    requestUrl.searchParams.set(key, value);
  }
  const res = await fetchWithTimeout(
    requestUrl.toString(),
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    },
    timeout
  );
  return res.json();
}

/**
 * Parse the meetingTimes field from Atlas.
 * Atlas returns meetingTimes as a JSON string embedded inside JSON.
 * Day codes: "0"=Mon, "1"=Tue, "2"=Wed, "3"=Thu, "4"=Fri
 * Times: integers without colons, e.g., 830, 1345
 */
function parseMeetingTimes(raw) {
  let parsed = [];
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : (raw ?? []);
  } catch {
    return [];
  }

  return parsed.map(m => ({
    day: DAY_MAP[m.meet_day] ?? `Day${m.meet_day}`,
    start: String(m.start_time),
    end: String(m.end_time),
  }));
}

/**
 * Map enrollment status codes to readable strings.
 */
function parseEnrollmentStatus(code) {
  const map = { 'O': 'Open', 'C': 'Closed', 'W': 'Waitlist' };
  return map[code] ?? code;
}

/**
 * Split a course code like "CHEM 150" or "BIOL 141L" into subject and catalog.
 * Handles edge cases like "CS 170" (short subject) and "BIOL 141L" (letter suffix).
 */
function splitCourseCode(code) {
  const trimmed = (code ?? '').trim();
  const spaceIdx = trimmed.lastIndexOf(' ');
  if (spaceIdx === -1) return { subject: trimmed, catalog: 'UNKNOWN' };
  return {
    subject: trimmed.substring(0, spaceIdx).trim(),
    catalog: trimmed.substring(spaceIdx + 1).trim(),
  };
}

function decodeHtmlEntities(value) {
  return String(value ?? '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([a-fA-F0-9]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function stripTags(html) {
  return decodeHtmlEntities(String(html ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function firstPresent(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function parseInstructors(raw) {
  const source = firstPresent(raw, ['instructors', 'instr', 'instructor']);
  if (Array.isArray(source)) {
    return source
      .map(item => {
        if (typeof item === 'object' && item !== null) {
          const name = firstPresent(item, ['name', 'instructor', 'displayName']);
          const email = firstPresent(item, ['email', 'mail']);
          return name ? { name, email: email ?? null } : null;
        }
        const name = String(item ?? '').trim();
        return name ? { name, email: null } : null;
      })
      .filter(Boolean);
  }
  return String(source ?? '')
    .split(/\s*(?:;|\|)\s*/)
    .map(name => name.trim())
    .filter(name => name && name !== 'Staff' && name !== 'TBA')
    .map(name => ({
      name,
      email: firstPresent(raw, ['instructor_email', 'email', 'mail']) ?? null,
    }));
}

function parseCatalogCourseCards(html) {
  const courses = {};
  const cardPattern = /<div class="card"><div class="card-header"[\s\S]*?<button[^>]*>([\s\S]*?)<\/button>[\s\S]*?<div class="card-body">([\s\S]*?)<\/div><\/div><\/div>/g;
  let match;
  while ((match = cardPattern.exec(html))) {
    const heading = stripTags(match[1]);
    const headingMatch = /^([A-Z_]+)\s+([A-Z0-9]+[A-Z]?):\s*(.+)$/.exec(heading);
    if (!headingMatch) continue;

    const [, subject, catalog, title] = headingMatch;
    const body = match[2];
    const descriptionMatch = /<p class="card-text">([\s\S]*?)<\/p>/.exec(body);
    const fields = {};
    const fieldPattern = /<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g;
    let fieldMatch;
    while ((fieldMatch = fieldPattern.exec(body))) {
      fields[stripTags(fieldMatch[1])] = stripTags(fieldMatch[2]);
    }

    const normalizedFields = Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [key.toLowerCase(), value])
    );
    const requisites = normalizedFields.requisites && normalizedFields.requisites !== 'None'
      ? normalizedFields.requisites
      : null;
    courses[`${subject}|${catalog}`] = {
      course_title: title,
      credit_hours: normalizedFields['credit hours'] ?? null,
      requirement_designation: normalizedFields.ger ?? normalizedFields.requirements ?? null,
      course_description: descriptionMatch ? stripTags(descriptionMatch[1]) : null,
      course_notes: firstPresent(normalizedFields, ['course notes', 'notes']) ?? requisites,
      requisites,
      cross_listed: normalizedFields['cross-listed'] && normalizedFields['cross-listed'] !== 'None'
        ? normalizedFields['cross-listed']
        : null,
    };
  }
  return courses;
}

async function fetchCatalogCourseMap() {
  const courses = {};
  try {
    const indexHtml = await fetchText(CATALOG_INDEX_URL, { headers: CATALOG_HEADERS }, 20000);
    const links = new Set();
    const linkPattern = /<a[^>]+href="([^"]+\.html)"[^>]*>\s*<div class="card-body">\s*<h2 class="card-title[^"]*">/g;
    let linkMatch;
    while ((linkMatch = linkPattern.exec(indexHtml))) {
      const href = linkMatch[1];
      if (!href || href === 'index.html') continue;
      links.add(new URL(href, CATALOG_DEPARTMENT_BASE_URL).toString());
    }

    for (const url of links) {
      try {
        const html = await fetchText(url, { headers: CATALOG_HEADERS }, 20000);
        Object.assign(courses, parseCatalogCourseCards(html));
        await sleep(100);
      } catch (err) {
        console.warn(`  [WARN] Catalog enrichment skipped for ${url}: ${err.message}`);
      }
    }
  } catch (err) {
    console.warn(`  [WARN] Catalog enrichment unavailable: ${err.message}`);
  }
  return courses;
}

/**
 * Build the structured JSON object for a single course from its grouped sections.
 */
function buildCourseObject(courseCode, sections, termLabel, srcdb, catalogCourseMap = {}) {
  const { subject, catalog } = splitCourseCode(courseCode);
  const catalogInfo = catalogCourseMap[`${subject}|${catalog}`] ?? {};

  const structuredSections = sections.map(s => ({
    crn: s.crn ?? null,
    section_number: s.no ?? null,
    schedule_type: s.schd ?? null,
    instructor: s.instr ?? null,
    instructors: parseInstructors(s),
    location: firstPresent(s, ['location', 'loc', 'room', 'building', 'bldg_room', 'bldgRoom']),
    enrollment_status: parseEnrollmentStatus(s.enrl_stat),
    enrollment_count: s.total ?? null,
    is_cancelled: !!(s.isCancelled && s.isCancelled !== ''),
    schedule: {
      display: s.meets ?? null,
      meetings: parseMeetingTimes(s.meetingTimes),
    },
  }));

  const types = structuredSections.reduce(
    (acc, s) => {
      const t = s.schedule_type;
      if (t === 'LEC') acc.lectures++;
      else if (t === 'LAB') acc.labs++;
      else if (t === 'DIS') acc.discussions++;
      else acc.other++;

      if (s.enrollment_status === 'Open') acc.open++;
      else if (s.enrollment_status === 'Closed') acc.closed++;
      else if (s.enrollment_status === 'Waitlist') acc.waitlisted++;
      return acc;
    },
    { lectures: 0, labs: 0, discussions: 0, other: 0, open: 0, closed: 0, waitlisted: 0 }
  );

  const instructorsSet = new Set(
    sections
      .map(s => s.instr)
      .filter(i => i && i !== 'Staff' && i.trim() !== '')
  );

  // Use the first section's dates as representative for the course
  const startDate = sections[0]?.start_date ?? null;
  const endDate = sections[0]?.end_date ?? null;

  return {
    course_code: courseCode,
    course_title: sections[0]?.title ?? catalogInfo.course_title ?? null,
    subject,
    catalog_number: catalog,
    term: termLabel,
    srcdb,
    credit_hours: catalogInfo.credit_hours ?? firstPresent(sections[0], ['credit_hours', 'credits', 'hours']),
    requirement_designation: catalogInfo.requirement_designation ?? firstPresent(sections[0], ['requirement_designation', 'ger', 'attributes']),
    course_description: catalogInfo.course_description ?? firstPresent(sections[0], ['course_description', 'description', 'desc']),
    course_notes: catalogInfo.course_notes ?? firstPresent(sections[0], ['course_notes', 'notes']),
    requisites: catalogInfo.requisites ?? null,
    cross_listed: catalogInfo.cross_listed ?? null,
    date_range: {
      start: startDate,
      end: endDate,
    },
    sections: structuredSections,
    section_summary: {
      total_sections: structuredSections.length,
      ...types,
    },
    instructors_unique: [...instructorsSet].sort(),
    scraped_at: new Date().toISOString(),
  };
}

// ── Core search function ─────────────────────────────────────────────────────

/**
 * Search Atlas for all sections under a given subject code.
 * Returns raw result array or null if the term/subject is invalid.
 */
async function fetchSubject(subject, srcdb) {
  try {
    const data = await postJson(
      ATLAS_BASE,
      { page: 'fose', route: 'search' },
      {
        other: { srcdb },
        criteria: [{ field: 'subject', value: subject }],
      },
      REQUIRED_HEADERS,
      15000
    );

    if (!data || data === '') {
      console.warn(`  [WARN] Empty response for ${subject} in ${srcdb}`);
      return null;
    }
    if (data.fatal) {
      console.warn(`  [WARN] Fatal from Atlas for ${subject}: ${data.fatal}`);
      return null;
    }

    return data.results ?? [];
  } catch (err) {
    console.error(`  [ERROR] ${subject} in ${srcdb}: ${err.message}`);
    return null;
  }
}

// ── File writing ─────────────────────────────────────────────────────────────

/**
 * Write a course object to disk at /atlas-data/{term}/{SUBJECT}/{catalog}.json
 */
function writeCourseFile(termLabel, courseObj) {
  if (DRY_RUN) return;
  const termDir = path.join(OUTPUT_DIR, termLabel, courseObj.subject);
  fs.mkdirSync(termDir, { recursive: true });

  const filename = `${courseObj.catalog_number}.json`;
  const filepath = path.join(termDir, filename);
  fs.writeFileSync(filepath, JSON.stringify(courseObj, null, 2), 'utf-8');
}

// ── Main scrape loop ─────────────────────────────────────────────────────────

async function runScrape() {
  console.log('=== Emory Atlas Bulk Scraper ===');
  console.log(`Subjects to scan: ${SELECTED_SUBJECT_CODES.length}`);
  console.log(`Terms: ${Object.keys(SELECTED_TERMS).join(', ')}`);
  console.log(`Output: ${OUTPUT_DIR}`);
  if (DRY_RUN) console.log('Dry run: files will not be written.');
  console.log('');

  // Create output root
  if (!DRY_RUN) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log('Loading Emory College catalog enrichment...');
  const catalogCourseMap = await fetchCatalogCourseMap();
  console.log(`Catalog enrichment loaded for ${Object.keys(catalogCourseMap).length} courses.`);

  const meta = {
    scrape_started: new Date().toISOString(),
    terms: {},
  };

  for (const [termLabel, srcdb] of Object.entries(SELECTED_TERMS)) {
    console.log(`\n── ${termLabel} (srcdb: ${srcdb}) ──`);

    const termMeta = {
      srcdb,
      subjects_attempted: 0,
      subjects_with_data: 0,
      courses_written: 0,
      total_sections: 0,
      errors: [],
    };

    for (let i = 0; i < SELECTED_SUBJECT_CODES.length; i++) {
      const subject = SELECTED_SUBJECT_CODES[i];
      const progress = `[${i + 1}/${SELECTED_SUBJECT_CODES.length}]`;

      termMeta.subjects_attempted++;

      const results = await fetchSubject(subject, srcdb);

      if (!results || results.length === 0) {
        console.log(`  ${progress} ${subject}: no results`);
        if (results === null) termMeta.errors.push(subject);
        await sleep(REQUEST_DELAY_MS);
        continue;
      }

      // Group sections by course code
      const grouped = {};
      for (const section of results) {
        const code = (section.code ?? '').trim();
        if (!code) continue;
        if (!grouped[code]) grouped[code] = [];
        grouped[code].push(section);
      }

      const courseCount = Object.keys(grouped).length;
      const sectionCount = results.length;
      termMeta.subjects_with_data++;
      termMeta.total_sections += sectionCount;

      console.log(
        `  ${progress} ${subject}: ${courseCount} courses, ${sectionCount} sections`
      );

      // Write each course to its own file
      for (const [courseCode, sections] of Object.entries(grouped)) {
        const courseObj = buildCourseObject(courseCode, sections, termLabel, srcdb, catalogCourseMap);
        writeCourseFile(termLabel, courseObj);
        termMeta.courses_written++;
      }

      await sleep(REQUEST_DELAY_MS);
    }

    meta.terms[termLabel] = termMeta;
  }

  meta.scrape_finished = new Date().toISOString();

  // Write metadata file
  const metaPath = path.join(OUTPUT_DIR, '_meta.json');
  if (!DRY_RUN) {
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
  }

  // Print summary
  console.log('\n=== Scrape Complete ===');
  for (const [termLabel, tm] of Object.entries(meta.terms)) {
    console.log(`  ${termLabel}:`);
    console.log(`    Subjects with data: ${tm.subjects_with_data}/${tm.subjects_attempted}`);
    console.log(`    Courses written:    ${tm.courses_written}`);
    console.log(`    Total sections:     ${tm.total_sections}`);
    if (tm.errors.length > 0) {
      console.log(`    Errors:             ${tm.errors.join(', ')}`);
    }
  }
  console.log(`\nMetadata: ${DRY_RUN ? '(dry run skipped)' : metaPath}`);
}

// ── Entry point ──────────────────────────────────────────────────────────────

runScrape().catch(err => {
  console.error('Fatal scrape error:', err);
  process.exit(1);
});
