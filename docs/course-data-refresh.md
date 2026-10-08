# Course catalog and professor ratings refresh

Course search reads local Atlas snapshots and cached Rate My Professors (RMP)
summaries. Refreshes are manual. Search and saved-course requests never contact
RMP. Live Atlas seat checks remain separate from catalog and rating freshness.

## Current data status

On October 7, 2026, normal Brave access succeeded for both public sources.
Direct Atlas requests still returned HTTP 202 with an AWS WAF challenge; direct
RMP retrieval returned HTTP 403. No browser credentials or cookies were copied.
The following verified snapshots are published locally:

| Term | Atlas ID | Courses | Sections | Coverage |
| --- | --- | --- | --- | --- |
| Fall 2026 | 5269 | 1,341 | 2,675 | All five undergraduate careers; 370 Oxford sections |
| Spring 2027 | 5271 | 919 | 1,557 | All currently published undergraduate sections; tentative schedule |

Every career roster reconciled against its subject queries, and all 4,232
section details passed identity and term validation. Spring currently has zero
published Oxford and undergraduate business sections. Atlas explicitly warns
that its Spring schedule is tentative and subject to change. Future completeness
means coverage of the currently published roster, not a final registration schedule.

Seat capacity and availability come from section details. Atlas's search-row
`total` is a course's section count, so enrollment count stays unavailable unless
the source explicitly supplies an enrolled-student count.

The RMP export covers all 2,153 Emory and 315 Oxford result positions. These
contain 2,083 and 310 unique profiles respectively; repeated profile IDs were
deduplicated after complete pagination. The refreshed cache covers 1,321 Atlas
instructor identities: 570 matched summaries, 51 verified unrated profiles,
685 unmatched names, and 15 uncertain matches. All current school identities
are verified. Generic `ONLIN@ONLINE` sections are assigned to an institution
using their captured undergraduate academic career, separately from their
physical meeting campus. Eleven obsolete unknown-school keys were retired
after their source identities resolved, leaving 1,321 active identities.
Tom Smith's legacy unknown-career identity also has an explicit correction
backed by the same Atlas instructor ID in Atlanta sections and his public RMP
profile. Original profile capture timestamps are retained.

Spring 2026 remains available as `legacy/unverified`; it was not backfilled in
this refresh. Automated live seat checks remain separate and were unavailable
in the local visual preview. The real-data preview uses the saved verified
snapshots and an isolated account; the synthetic fixture preview below remains
available for behavior tests. These local changes have not been deployed.

## Atlas

From the repository root:

```sh
npm run scrape:atlas -- --list-terms
npm run scrape:atlas -- --terms Fall_2026 --dry-run
npm run scrape:atlas -- --terms Fall_2026
npm run scrape:atlas -- --upcoming
# When the normal browser can access Atlas but direct HTTP is challenged:
npm run scrape:atlas -- --terms Fall_2026,Spring_2027 --browser-export data/atlas/browser-captures/20261007-brave --dry-run
npm run scrape:atlas -- --terms Fall_2026,Spring_2027 --browser-export data/atlas/browser-captures/20261007-brave
```

`--upcoming` selects future starts from terms actually published by Atlas. Use
`--terms Fall_2026` to backfill Fall 2026 after it has started. Unknown or
unpublished terms fail; the command never constructs a future term ID.

Discovery requires the official term, subject, and academic-career selectors.
If the public page does not expose all three, a complete, authoritative selector
export can be supplied with `--metadata /path/to/atlas-metadata.json` (or HTML).
It is not a way around an access refusal: live roster requests must also be
accessible normally. The importer stops on access challenges, refusals, and
redirects. Do not reuse challenge cookies, private credentials, or alternative
endpoints to bypass them.

The JSON export has this shape (illustrative values, not a complete export):

```json
{
  "version": 1,
  "complete": true,
  "source": "https://atlas.emory.edu/",
  "discovered_at": "2026-10-07T12:00:00Z",
  "career_field": "career",
  "subject_field": "subject",
  "terms": {
    "Fall_2026": { "srcdb": "5269", "label": "Fall 2026", "published": true }
  },
  "careers": [{ "value": "UCOL", "label": "Emory College" }],
  "subjects": [{ "value": "ENG_OX", "label": "English at Oxford" }]
}
```

Supply every published selector option, retaining exact values. A common
undergraduate career can cover all schools. Where Atlas separates careers,
include Emory College, Oxford, undergraduate allied health, undergraduate
business, and undergraduate nursing.
Use `undergraduate: true` only for an officially undergraduate career whose
label cannot be classified. `undergraduate: false` explicitly excludes a career.
Course numbers do not determine eligibility. Online sections are included when
they belong to those undergraduate careers.

For each career, the importer exhausts its broad roster and each official
subject query, including Oxford subject codes such as `ENG_OX`. Subject codes
found in the official career roster are also checked, because Atlas's selector
omits some real subjects, including `ARCH`, `RES`, `SIRE`, and `CNST`. The two sets of
section identities must match. Declared totals, page cursors, duplicate results,
wrong-term responses, ignored filters, and possible unverified result limits
are checked. A career with an official zero count is recorded as empty; an
entirely empty undergraduate term fails conservatively. If the live service
changes its pagination or selector format, the importer fails for diagnosis
instead of claiming a complete catalog.

Browser exports contain the official selectors in `metadata.html`, an
`index.json` with `schema_version: 1`, `source: "public-atlas-brave"`, official
origin, capture date, and indexed requests, plus one JSON file per observed
public search/detail response. Each response retains its request body, exact
source URL, HTTP status, original fetch time, and returned JSON. Only successful
same-origin public responses are replayed; missing requests, wrong terms,
duplicate request keys, and unsafe paths fail. The live source uses
percent-encoded JSON request bodies and native `count` section totals. Searches
nest `srcdb` in `other`; detail requests require `srcdb` at the top level. Every
returned detail must belong to the requested term. A native
unpaged response at its 2,500-result ceiling requires further diagnosis.

Use normal browser access to collect these public responses; stop if the browser
shows a refusal or challenge. Capture files contain no credentials or cookie
headers and are gitignored. The importer rechecks roster identities and every
requested detail before publication. Atlas's explicit tentative scheduling
notice is retained in term metadata and displayed beside catalog freshness.

Successful generations are written to
`data/atlas/snapshots/TERM/GENERATION/SUBJECT/NUMBER.json`. The manifest is replaced
atomically only after validation and requested enrichment finish. A failed or
interrupted run leaves the previous catalog active. Each generation contains
`_report.json` with counts by career and subject, identity additions/removals,
and enrichment status. Failed runs write `data/atlas/reports/*-failed.json`.

The shared `data/atlas/registry.json` retains discovered terms and their live
IDs, including unpublished historical terms. The runtime pins a manifest view
for each catalog operation. Search uses the current generation; saved-course,
by-ID, and calendar lookups can also resolve prior generations and legacy data.
Do not remove those historical files without separately handling saved IDs.

Useful options:

| Option | Environment equivalent | Behavior |
| --- | --- | --- |
| `--terms A,B` | `ATLAS_TERMS` | Explicit published terms |
| `--upcoming` | `ATLAS_UPCOMING=1` | Discovered future terms |
| `--dry-run` | `ATLAS_DRY_RUN=1` | No registry, snapshot, lock, or report writes |
| `--metadata FILE` | `ATLAS_METADATA_FILE` | Authoritative selector export |
| `--browser-export DIR` | `ATLAS_BROWSER_EXPORT` | Replay public responses captured through normal browser access |
| `--output-dir DIR` | `ATLAS_OUTPUT_DIR` | Catalog root; snapshots go under `DIR/data/atlas` |
| `--details on/off` | `ATLAS_DETAILS` | Detail enrichment; defaults to on |
| `--subjects A,B` | `ATLAS_SUBJECTS` | Diagnostic subset; requires dry run |
| `--campuses Atlanta,Oxford` | `ATLAS_CAMPUSES` | Diagnostic subset; requires dry run |
| `--requirements LIST/off` | `ATLAS_REQUIREMENTS` | Optional requirement-tag enrichment; defaults to off |
| `--delay-ms N` | `ATLAS_REQUEST_DELAY_MS` | Request pacing; defaults to 1500 ms |
| `--details-delay-ms N` | `ATLAS_DETAILS_DELAY_MS` | Detail pacing; defaults to 1000 ms, bounded by request pacing |
| `--page-size N` | `ATLAS_PAGE_SIZE` | Requested page size; defaults to 500 |

CLI values override the corresponding environment settings. Diagnostic subsets
still reconcile the full roster and cannot publish partial undergraduate
coverage. Requested enrichment failures prevent publication; disabling an
enrichment is explicit and recorded in the report. A `.import.lock` prevents
concurrent publication. Remove a stale lock only after confirming its recorded
process has stopped.

## Rate My Professors

```sh
npm run refresh:rmp -- --terms Fall_2026
npm run refresh:rmp -- --terms Fall_2026 Spring_2027
npm run refresh:rmp -- --terms Fall_2026 Spring_2027 --browser-export data/rmp/browser-captures/20261007-brave.json
```

The command reads instructors from the active Atlas generation. Certified
undergraduate snapshots include all their careers. Legacy data uses available
career metadata; unknown-career legacy rows are counted as unverified in the
report. No course-number cutoff is used. The runtime also returns an RMP search
link when there is no verified summary.

Matching uses the authoritative Atlas instructor list, stable Atlas instructor
IDs when available, normalized full names, and school identity: Emory/Atlanta
(`340`) and Oxford (`2633`). Multiple instructors keep separate ratings. Initials,
same-name matches, and unknown school identities do not receive guessed scores. A full
first and last name containing a middle initial can match only when the entire
normalized name agrees exactly with one school-scoped profile. Changing
a saved course's instructor label does not change which professor is rated.

The official Atlas careers `UCOL`, `UAH`, `UBUS`, and `UNUR` establish Emory
school `340`; `UOXF` establishes Oxford school `2633`, including online meetings.
The API retains this source career. Conflicting campus/career evidence remains
unknown, and an instructor ID alone never determines a global school: some
professors teach at both institutions. Generic undergraduate or unrecognized
careers do not establish a school.

Each professor's quality score is a rounded badge beside their name in course
cards and details. The palette and bands follow RMP's public quality cards,
verified in Brave on October 7, 2026: green `#7ff6c3` at 4.0+, yellow `#fff170`
at 3.0–3.9, and red `#ff9c9c` below 3.0. Missing, unrated, and uncertain summaries
show a gray `–`. The badge opens the verified profile, or the professor search
when no profile is verified, in a new tab. Without a safe destination it remains
a noninteractive badge. Counts, difficulty, update dates, and saved-rating
status remain available in details and accessible badge descriptions.

Live Atlas instructor details retain the native instructor ID. When replaying
an older snapshot that omitted IDs, the merge preserves the saved ID only for
a uniquely matching normalized name. Changed or ambiguous names and explicit
incoming IDs do not inherit an old identity, so a seat refresh can retain the
same professor's saved rating without assigning it to someone else.

The public-page reader accepts only verifiable structured summaries. It does
not store review prose or access authenticated/private APIs. Incomplete search
pagination and unrecognized response formats are unavailable, not a confirmed
absence of matching professors. The refresh is paced (at least one second per
request), bounded by `--max-requests`, and stops making requests after an access
refusal or challenge.

`--browser-export FILE` accepts genuine public summaries collected through
normal Brave access. The JSON has `schema_version: 1`, `source:
"public-rmp-brave"`, and complete `directories` for school IDs `340` and `2633`.
Each directory retains its exact public search URL, declared result count,
profiles with numeric IDs, names, school IDs, scores, difficulty, counts,
canonical profile links, and original capture timestamps. Review prose is
excluded. If RMP repeats profile IDs across result positions, every pagination
position and the native final page must be proved; repeated IDs do not become
separate professors. `rendered_profiles` retains the final directory URL,
original capture timestamp, `verification: "exact_profile_id_set"`, and the
independently observed `unique_count` after comparing the fully rendered card
IDs against the exported profiles. It is required when result positions repeat
IDs. When pages also supply `profile_ids`, every page must include them and
their union must agree with the exported profiles. The refresh report records both declared positions and
unique profiles. An incomplete directory cannot certify an unmatched name.

Approved identity corrections belong in `scripts/rmp/overrides.json`:

```json
{
  "schema_version": 1,
  "mappings": {
    "340:atlas:ATLAS_INSTRUCTOR_ID": {
      "professor_id": "RMP_NUMERIC_ID",
      "school_id": "340",
      "expected_name": "Full RMP Name",
      "label": "Reason this identity was confirmed"
    }
  }
}
```

Use a real numeric professor ID and verify the professor's name and school.
Cross-school or unknown-campus mappings additionally require
`allow_cross_school: true`. The profile must still verify the expected name and
school. `--overrides FILE` selects another reviewed mapping file.

`data/rmp/ratings.json` contains overall score, difficulty, count, profile ID,
identity verification, original fetch time, and matching state. Publication is
atomic. A source failure retains previously verified values and their original
timestamp, marks them stale, and records the failed attempt. Ambiguous matches
clear numeric summaries. Summaries older than 30 days are displayed as older
saved ratings. `last-refresh-report.json` reports scope, counts, and failures.
Exit codes are 0 for success, 2 for completed refresh with unavailable summaries,
and 1 for invalid input or a failure before publication.

`--input FILE --output-dir /tmp/rmp-preview` supports offline summary fixtures.
Offline input cannot write the production cache. A fixture is a JSON object
with `schema_version: 1` and `profiles`, each containing `professor_id`, `school_id`,
`name`, `overall_rating`, `difficulty`, and `rating_count`.

## Verification and preview

```sh
node --test tests/js/atlas*.test.cjs tests/js/courses*.test.cjs
.venv/bin/python -m unittest tests.test_atlas_catalog_store tests.test_professor_ratings tests.test_professor_ratings_routes
npm test
npm run build
.venv/bin/desloppify scan --path .
.venv/bin/python tests/browser/courses_server.py
```

The isolated preview at `http://127.0.0.1:8806/__test__/courses/auth` uses disposable
SQLite and 610 synthetic courses, with a visible fixture notice and no external
course/rating requests. `?theme=parchment-light` selects its light theme. Search
shows 100 results initially and lets users reveal every remaining match. Live
status verification processes all candidates in batches bounded by 120 IDs and
24 term/subject groups; a separate limit still protects detail hydration.
