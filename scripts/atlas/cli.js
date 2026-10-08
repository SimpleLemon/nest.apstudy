/** Atlas command line entry. Importing this module never starts a request. */
const path = require('node:path');
const { discoverMetadata, undergraduateCareers } = require('./metadata');
const { createTransport } = require('./transport');
const { createBrowserExportTransport } = require('./browser-export');
const { importTerm } = require('./importer');
const { atomicJson, readJson, acquireImportLock } = require('./snapshots');
const { parseEnvList } = require('./atlasCourseUtils');

const HELP = `Usage: npm run scrape:atlas -- (--list-terms | --terms Fall_2026[,Spring_2027] | --upcoming)
  --scope undergraduate       All official undergraduate careers (default)
  --dry-run                   Validate and report without writing files
  --metadata FILE             Authoritative Atlas selector HTML or JSON export
  --browser-export DIR        Public responses captured through normal browser access
  --output-dir DIR            Data root; stores snapshots in DIR/data/atlas
  --details on|off            Section detail enrichment (default on)
  --subjects LIST             Diagnostic subject subset; requires --dry-run
  --campuses LIST             Diagnostic campus subset; requires --dry-run
  --requirements LIST|off     Optional requirement-tag enrichment
  --delay-ms N                Minimum delay between requests (default 1500)
  --details-delay-ms N         Minimum detail delay (default 1000)
  --page-size N               Requested page size (default 500)
  --help                     Show this help without accessing Atlas
CLI options override corresponding ATLAS_* environment settings.
Access challenges stop the run; incomplete imports never replace the active snapshot.`;

function parseOptions(argv = [], env = process.env) {
  const values = { terms: env.ATLAS_TERMS, scope: env.ATLAS_SCOPE || 'undergraduate',
    metadata: env.ATLAS_METADATA_FILE, 'output-dir': env.ATLAS_OUTPUT_DIR,
    'browser-export': env.ATLAS_BROWSER_EXPORT,
    details: env.ATLAS_DETAILS || 'on', subjects: env.ATLAS_SUBJECTS, campuses: env.ATLAS_CAMPUSES,
    requirements: env.ATLAS_REQUIREMENTS || 'off', 'delay-ms': env.ATLAS_REQUEST_DELAY_MS || '1500',
    'details-delay-ms': env.ATLAS_DETAILS_DELAY_MS || '1000', 'page-size': env.ATLAS_PAGE_SIZE || '500',
    'requirement-field': env.ATLAS_REQUIREMENT_FIELD || 'requirement',
    'requirement-max-results': env.ATLAS_REQUIREMENT_MAX_RESULTS || '2500' };
  const flags = { 'dry-run': env.ATLAS_DRY_RUN === '1', upcoming: env.ATLAS_UPCOMING === '1' };
  const booleanKeys = new Set(['dry-run', 'upcoming', 'list-terms', 'help']);
  const selectedModes = new Set();
  for (let i = 0; i < argv.length; i++) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
    if (!match) throw new Error(`Unexpected argument: ${argv[i]}`);
    const [, key, inline] = match;
    if (['terms', 'upcoming', 'list-terms'].includes(key)) selectedModes.add(key);
    if (booleanKeys.has(key)) {
      if (inline !== undefined) throw new Error(`--${key} does not take a value.`);
      flags[key] = true;
    } else {
      if (!Object.hasOwn(values, key)) throw new Error(`Unknown option: --${key}`);
      const value = inline ?? argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`--${key} requires a value.`);
      values[key] = value;
    }
  }
  if (selectedModes.size > 1) throw new Error('Choose exactly one of --list-terms, --terms, or --upcoming.');
  if (selectedModes.has('terms')) flags.upcoming = false;
  if (selectedModes.has('upcoming') || selectedModes.has('list-terms')) values.terms = undefined;
  if (flags.help) return { help: true };
  if (values.scope !== 'undergraduate') throw new Error('Only --scope undergraduate is supported.');
  if (!['on', 'off'].includes(values.details)) throw new Error('--details must be on or off.');
  const number = (key, minimum) => {
    const result = Number(values[key]);
    if (!Number.isSafeInteger(result) || result < minimum) throw new Error(`--${key} must be an integer >= ${minimum}.`);
    return result;
  };
  const terms = parseEnvList(values.terms);
  if (!flags['list-terms'] && !flags.upcoming && !terms.length) throw new Error('Select --terms or --upcoming (use --list-terms to discover published terms).');
  const subjects = parseEnvList(values.subjects).filter(value => value !== 'all');
  const campuses = parseEnvList(values.campuses).filter(value => value !== 'all');
  if ((subjects.length || campuses.length) && !flags['dry-run'] && !flags['list-terms']) throw new Error('Subject/campus restrictions require --dry-run; partial undergraduate coverage cannot be published.');
  if (!/^[a-z_]+$/.test(values['requirement-field'])) throw new Error('Invalid requirement field.');
  return { terms, upcoming: flags.upcoming, listTerms: flags['list-terms'], dryRun: flags['dry-run'],
    scope: values.scope, subjects, campuses, metadataFile: values.metadata, browserExport: values['browser-export'],
    outputDir: path.resolve(values['output-dir'] || path.join(__dirname, '../..')),
    details: values.details !== 'off', delay: number('delay-ms', 0), detailsDelay: number('details-delay-ms', 0),
    pageSize: number('page-size', 1), requirements: values.requirements === 'off' ? [] : parseEnvList(values.requirements),
    requirementField: values['requirement-field'], requirementMaxResults: number('requirement-max-results', 1) };
}

function selectTerms(metadata, options, now = new Date()) {
  const published = Object.entries(metadata.terms).filter(([, term]) => term.published !== false);
  if (options.listTerms) return published.map(([key]) => key);
  if (options.upcoming) {
    // These calendar boundaries select from discovered terms; they never invent IDs.
    const starts = { Spring: '01-01', Summer: '05-01', Fall: '08-01', Winter: '12-01' };
    const today = now.toISOString().slice(0, 10);
    const names = published.filter(([key, term]) => {
      const [season, year] = key.split('_');
      return (term.starts_on || `${year}-${starts[season]}`) > today;
    }).sort(([a], [b]) => {
      const date = key => { const [season, year] = key.split('_'); return `${year}-${starts[season]}`; };
      return date(a).localeCompare(date(b));
    }).map(([key]) => key);
    if (!names.length) throw new Error('Atlas metadata contains no published upcoming terms. No term IDs were guessed.');
    return names;
  }
  const known = new Set(published.map(([key]) => key));
  const unknown = options.terms.filter(term => !known.has(term));
  if (unknown.length) throw new Error(`Unknown or unpublished Atlas terms: ${unknown.join(', ')}. Use --list-terms.`);
  return [...new Set(options.terms)];
}

async function runCli(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const options = parseOptions(argv, env);
  const log = dependencies.log || console.log;
  if (options.help) { log(HELP); return { status: 'help' }; }
  const transport = dependencies.transport || (options.browserExport
    ? createBrowserExportTransport(options.browserExport) : createTransport(options));
  const metadata = await discoverMetadata({ metadataFile: options.metadataFile, fetchText: transport.fetchText });
  const terms = selectTerms(metadata, options, dependencies.now);
  if (options.listTerms) {
    for (const name of terms) log(`${name}\t${metadata.terms[name].srcdb}\t${metadata.terms[name].label}`);
    return { status: 'listed', terms };
  }
  undergraduateCareers(metadata);
  for (const subject of options.subjects) {
    if (!metadata.subjects.some(item => item.value === subject)) throw new Error(`Unknown Atlas subject: ${subject}`);
  }
  const atlasRoot = path.join(options.outputDir, 'data', 'atlas');
  const release = options.dryRun ? () => {} : acquireImportLock(atlasRoot);
  try {
    if (!options.dryRun) {
      const registryFile = path.join(atlasRoot, 'registry.json');
      const oldRegistry = readJson(registryFile, { terms: {} });
      const historical = Object.fromEntries(Object.entries(oldRegistry.terms || {}).map(([key, value]) => [key, { ...value, published: false }]));
      atomicJson(registryFile, { ...metadata, terms: { ...historical, ...metadata.terms } });
    }
    const reports = [];
    for (const termName of terms) {
      const report = await importTerm({ metadata, termName, atlasRoot, legacyRoot: options.outputDir,
        transport, options: { ...options, log } });
      reports.push(report);
      if (!options.dryRun && Object.keys(report.coverage?.discovered_subjects || {}).length) {
        const file = path.join(atlasRoot, 'registry.json');
        const registry = readJson(file);
        const known = new Set(registry.subjects.map(item => item.value));
        for (const subject of Object.keys(report.coverage.discovered_subjects)) {
          if (!known.has(subject)) registry.subjects.push({ value: subject, label: subject,
            source: 'career_roster', discovered_in: termName });
        }
        atomicJson(file, registry);
      }
      log(JSON.stringify(report, null, 2));
    }
    return { status: options.dryRun ? 'dry_run' : 'complete', reports };
  } finally { release(); }
}

module.exports = { HELP, parseOptions, selectTerms, runCli };
