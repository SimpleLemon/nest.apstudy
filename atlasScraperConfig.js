const path = require('path');
const { parseEnvList } = require('./atlasCourseUtils');

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

module.exports = {
  ATLAS_BASE,
  CATALOG_DEPARTMENT_BASE_URL,
  CATALOG_HEADERS,
  CATALOG_INDEX_URL,
  DETAILS_DELAY_MS,
  DETAILS_ENABLED,
  DRY_RUN,
  OUTPUT_DIR,
  REQUEST_DELAY_MS,
  REQUIRED_HEADERS,
  REQUIREMENT_FIELD,
  REQUIREMENT_MAX_RESULTS,
  SELECTED_CAMPUSES,
  SELECTED_REQUIREMENTS,
  SELECTED_SUBJECT_CODES,
  SELECTED_TERMS,
};
