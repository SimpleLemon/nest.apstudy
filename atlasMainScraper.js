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
 *   - POST to https://atlas.emory.edu/api/?page=fose&route=details with group "key:{key}"
 *   - Browser-like headers required (Referer, Origin, X-Requested-With)
 *   - No "list all subjects" endpoint; subject codes are hardcoded
 *   - enrl_stat server-side filter does not work; filtered client-side
 *   - meetingTimes is a JSON string inside JSON; must be double-parsed
 */

const fs = require('fs');
const path = require('path');
const {
  buildCourseObject,
  decodeHtmlEntities,
  firstPresent,
  mergeSectionWithDetails,
  normalizeCampus,
  normalizeRequirements,
  parseCatalogCourseCards,
  parseEnrollmentStatus,
  parseEnvList,
  parseInstructors,
  parseMeetingTimes,
  splitCourseCode,
  stripTags,
} = require('./atlasCourseUtils');

// ── Configuration ────────────────────────────────────────────────────────────

const ATLAS_BASE = 'https://atlas.emory.edu/api/';

const TERMS = {
  'Spring_2026': '5261',
  'Fall_2026': '5269',
};

/** Delay between subject requests in ms. Be respectful. */
const REQUEST_DELAY_MS = 1500;
/** Delay between section detail requests in ms. */
const DETAILS_DELAY_MS = Number.parseInt(process.env.ATLAS_DETAILS_DELAY_MS || '1000', 10);
const DETAILS_ENABLED = process.env.ATLAS_DETAILS !== 'off';

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
  'ECON', 'ECS', 'EDUC', 'EH', 'EMBRYO', 'ENG', 'ENG_OX', 'ENGRD', 'ENVS', 'EPID',
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

const SELECTED_TERMS = parseEnvList(process.env.ATLAS_TERMS).length
  ? Object.fromEntries(
      Object.entries(TERMS).filter(([term]) => parseEnvList(process.env.ATLAS_TERMS).includes(term))
    )
  : TERMS;

const SELECTED_SUBJECT_CODES = parseEnvList(process.env.ATLAS_SUBJECTS).length
  ? SUBJECT_CODES.filter(subject => parseEnvList(process.env.ATLAS_SUBJECTS).includes(subject))
  : SUBJECT_CODES;

const SELECTED_CAMPUSES = parseEnvList(process.env.ATLAS_CAMPUSES).length
  ? parseEnvList(process.env.ATLAS_CAMPUSES).map(campus => campus === 'all' ? '' : campus)
  : ['', 'Oxford'];

const STARRED_GENERAL_ED_REQUIREMENTS = [
  'Cont.Comm.& Writing w. ETHN(*)',
  'Continuing Comm.& Writing(*)',
  'Exp.& Application w. CW(*)',
  'Experience and Application(*)',
  'First Year Seminar w. ETHN(*)',
  'First Year Seminar(*)',
  'First Year Writing w.ETHN(*)',
  'First Year Writing(*)',
  'Health(*)',
  'Humanities & Arts w.ETHN(*)',
  'Humanities & Arts with CW(*)',
  'Humanities and Arts(*)',
  'Humanities&Arts w. CW/ETHN(*)',
  'Intercult.Comm. w. CW(*)',
  'Intercult.Comm. w. CW/ETHN(*)',
  'Intercult.Comm.with ETHN(*)',
  'Intercultural Communication(*)',
  'Natural Sciences w. CW/ETHN(*)',
  'Natural Sciences with CW(*)',
  'Natural Sciences with ETHN(*)',
  'Natural Sciences(*)',
  'Physical Education(*)',
  'Quantit.Reasoning w.CW/ETHN(*)',
  'Quantitat.Reasoning w.CW(*)',
  'Quantitat.Reasoning w.ETHN(*)',
  'Quantitative Reasoning(*)',
  'Race and Ethnicity(*)',
  'Soc.Sciences w. CW/ETHN(*)',
  'Social Sciences with CW(*)',
  'Social Sciences with ETHN(*)',
  'Social Sciences(*)',
];

const SELECTED_REQUIREMENTS = process.env.ATLAS_REQUIREMENTS === 'off'
  ? []
  : (parseEnvList(process.env.ATLAS_REQUIREMENTS).length
      ? parseEnvList(process.env.ATLAS_REQUIREMENTS)
      : STARRED_GENERAL_ED_REQUIREMENTS);
const REQUIREMENT_FIELD = process.env.ATLAS_REQUIREMENT_FIELD || 'requirement';
const REQUIREMENT_MAX_RESULTS = Number.parseInt(process.env.ATLAS_REQUIREMENT_MAX_RESULTS || '2500', 10);

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

// ── Core search function ─────────────────────────────────────────────────────

/**
 * Search Atlas for all sections under a given subject code.
 * Returns raw result array or null if the term/subject is invalid.
 */
async function fetchSubject(subject, srcdb, campus = '') {
  try {
    const criteria = [{ field: 'subject', value: subject }];
    if (campus) criteria.push({ field: 'campus', value: campus });
    const data = await postJson(
      ATLAS_BASE,
      { page: 'fose', route: 'search' },
      {
        other: { srcdb },
        criteria,
      },
      REQUIRED_HEADERS,
      15000
    );

    if (!data || data === '') {
      console.warn(`  [WARN] Empty response for ${subject}${campus ? ` (${campus})` : ''} in ${srcdb}`);
      return null;
    }
    if (data.fatal) {
      console.warn(`  [WARN] Fatal from Atlas for ${subject}${campus ? ` (${campus})` : ''}: ${data.fatal}`);
      return null;
    }

    return data.results ?? [];
  } catch (err) {
    console.error(`  [ERROR] ${subject}${campus ? ` (${campus})` : ''} in ${srcdb}: ${err.message}`);
    return null;
  }
}

async function fetchSectionDetails(key, srcdb) {
  if (!DETAILS_ENABLED || !key) return null;
  try {
    const data = await postJson(
      ATLAS_BASE,
      { page: 'fose', route: 'details' },
      {
        other: { srcdb },
        group: `key:${key}`,
      },
      REQUIRED_HEADERS,
      15000
    );
    if (!data || data === '' || data.fatal) {
      const message = data?.fatal ? `: ${data.fatal}` : '';
      console.warn(`  [WARN] Details skipped for key ${key}${message}`);
      return null;
    }
    return data;
  } catch (err) {
    console.warn(`  [WARN] Details failed for key ${key}: ${err.message}`);
    return null;
  }
}

async function enrichSectionsWithDetails(sections, srcdb, termMeta) {
  if (!DETAILS_ENABLED || !sections.length) return sections;

  const detailsCache = new Map();
  const enriched = [];

  for (const section of sections) {
    const key = String(section.key ?? '').trim();
    if (!key) {
      enriched.push(section);
      continue;
    }

    if (!detailsCache.has(key)) {
      termMeta.details_requests = (termMeta.details_requests ?? 0) + 1;
      const details = await fetchSectionDetails(key, srcdb);
      if (!details) termMeta.details_errors = (termMeta.details_errors ?? 0) + 1;
      detailsCache.set(key, details);
      await sleep(DETAILS_DELAY_MS);
    }

    const details = detailsCache.get(key);
    enriched.push(details ? mergeSectionWithDetails(section, details) : section);
  }

  return enriched;
}

function sectionTagKey(section) {
  const code = section?.code ?? section?.course_code;
  const sectionNumber = section?.no ?? section?.section_number;
  return [
    code,
    section?.crn,
    sectionNumber,
  ].map(value => String(value ?? '').trim()).join('|');
}

function addRequirementTag(tagMap, section, requirement) {
  const key = sectionTagKey(section);
  if (!key.replace(/\|/g, '')) return;
  if (!tagMap.has(key)) tagMap.set(key, new Set());
  tagMap.get(key).add(requirement);
}

function applyRequirementTags(section, tagMap) {
  const key = sectionTagKey(section);
  const tagged = tagMap.get(key);
  if (!tagged || !tagged.size) return section;
  const requirements = normalizeRequirements(section, { requirements: [...tagged] });
  return {
    ...section,
    requirement_designation: section.requirement_designation ?? requirements[0] ?? null,
    requirements,
  };
}

async function fetchRequirementSections(requirement, srcdb, campus = '') {
  try {
    const criteria = [{ field: REQUIREMENT_FIELD, value: requirement }];
    if (campus) criteria.push({ field: 'campus', value: campus });
    const data = await postJson(
      ATLAS_BASE,
      { page: 'fose', route: 'search' },
      {
        other: { srcdb },
        criteria,
      },
      REQUIRED_HEADERS,
      15000
    );

    if (!data || data === '' || data.fatal) {
      const message = data?.fatal ? `: ${data.fatal}` : '';
      console.warn(`  [WARN] Requirement enrichment skipped for ${requirement}${campus ? ` (${campus})` : ''}${message}`);
      return [];
    }

    const results = data.results ?? [];
    if (Number.isFinite(REQUIREMENT_MAX_RESULTS) && results.length > REQUIREMENT_MAX_RESULTS) {
      console.warn(`  [WARN] Requirement enrichment for ${requirement} returned ${results.length} rows; skipped to avoid an ignored Atlas filter.`);
      return [];
    }
    return results;
  } catch (err) {
    console.error(`  [ERROR] Requirement ${requirement}${campus ? ` (${campus})` : ''} in ${srcdb}: ${err.message}`);
    return [];
  }
}

async function fetchRequirementTagsForTerm(srcdb, termMeta) {
  const tagMap = new Map();
  if (!SELECTED_REQUIREMENTS.length) return tagMap;

  console.log(`  Loading General Ed enrichment (${SELECTED_REQUIREMENTS.length} starred options, field: ${REQUIREMENT_FIELD})...`);
  for (const requirement of SELECTED_REQUIREMENTS) {
    for (const campus of SELECTED_CAMPUSES) {
      const sections = await fetchRequirementSections(requirement, srcdb, campus);
      sections.forEach(section => addRequirementTag(tagMap, section, requirement));
      termMeta.requirement_enrichment_requests++;
      termMeta.requirement_enrichment_rows += sections.length;
      await sleep(REQUEST_DELAY_MS);
    }
  }
  console.log(`  General Ed tags matched ${tagMap.size} unique sections.`);
  return tagMap;
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
  console.log(`Campus passes: ${SELECTED_CAMPUSES.map(campus => campus || 'all').join(', ')}`);
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
      requirement_enrichment_requests: 0,
      requirement_enrichment_rows: 0,
      details_requests: 0,
      details_errors: 0,
      errors: [],
    };

    const requirementTags = await fetchRequirementTagsForTerm(srcdb, termMeta);

    for (let i = 0; i < SELECTED_SUBJECT_CODES.length; i++) {
      const subject = SELECTED_SUBJECT_CODES[i];
      const progress = `[${i + 1}/${SELECTED_SUBJECT_CODES.length}]`;

      termMeta.subjects_attempted++;

      const mergedResults = [];
      const seenSections = new Set();
      let hadNullResponse = false;
      for (const campus of SELECTED_CAMPUSES) {
        const campusResults = await fetchSubject(subject, srcdb, campus);
        if (campusResults === null) {
          hadNullResponse = true;
        } else {
          for (const section of campusResults) {
            const dedupeKey = [
              section.code,
              section.crn,
              section.no,
              section.campus,
            ].map(value => String(value ?? '')).join('|');
            if (seenSections.has(dedupeKey)) continue;
            seenSections.add(dedupeKey);
            mergedResults.push(applyRequirementTags(section, requirementTags));
          }
        }
        await sleep(REQUEST_DELAY_MS);
      }

      const results = await enrichSectionsWithDetails(mergedResults, srcdb, termMeta);

      if (!results || results.length === 0) {
        console.log(`  ${progress} ${subject}: no results`);
        if (hadNullResponse) termMeta.errors.push(subject);
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
    console.log(`    GE enrich requests: ${tm.requirement_enrichment_requests}`);
    console.log(`    GE enrich rows:     ${tm.requirement_enrichment_rows}`);
    console.log(`    Detail requests:    ${tm.details_requests ?? 0}`);
    console.log(`    Detail errors:      ${tm.details_errors ?? 0}`);
    if (tm.errors.length > 0) {
      console.log(`    Errors:             ${tm.errors.join(', ')}`);
    }
  }
  console.log(`\nMetadata: ${DRY_RUN ? '(dry run skipped)' : metaPath}`);
}

// ── Entry point ──────────────────────────────────────────────────────────────

if (require.main === module) {
  runScrape().catch(err => {
    console.error('Fatal scrape error:', err);
    process.exit(1);
  });
}

module.exports = {
  buildCourseObject,
  decodeHtmlEntities,
  enrichSectionsWithDetails,
  fetchSectionDetails,
  firstPresent,
  mergeSectionWithDetails,
  normalizeCampus,
  normalizeRequirements,
  parseCatalogCourseCards,
  parseEnrollmentStatus,
  parseEnvList,
  parseInstructors,
  parseMeetingTimes,
  splitCourseCode,
  stripTags,
};
