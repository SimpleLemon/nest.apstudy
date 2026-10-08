# SQLite upload storage migration

Updated October 7, 2026. The additive storage implementation is deployed in Appwrite compatibility mode, with legacy reads enabled. A fresh pre-deployment backup completed, all three web workers use the prepared SQLite 3.53.4 runtime, and notes conversion passes. Storage import, cutover, source permission changes, and recovery validation remain operator work; the dated preparation evidence below records the earlier implementation and setup.

Use [the operator runbook](storage-sqlite-runbook.md) for the ordered commands and stop conditions. Read the repository's local `VPS_CONTEXT.md` before production work and `COMMIT_PUSH.md` before committing or pushing.

## Scope and source baseline

Payloads move into the existing Nest database, `/var/www/nest.apstudy.org/instance/nest.sqlite3`. Feature records continue to control authorization, share codes, expiry, quotas, and relationships. Appwrite Auth/OAuth remains in use.

The October 1 production audit used endpoint `https://nyc.cloud.appwrite.io/v1`, project `69f77663000c16abdff2`, and the following complete inventory. These are a dated baseline; each import stage refreshes the source rather than hard-coding these counts.

| Namespace | Appwrite bucket | Objects | Source bytes | Production references at audit |
| --- | --- | ---: | ---: | --- |
| Avatars | `profile_avatars` | 51 | 1,034,066 | 46 existing objects referenced by current profiles or chat history; five orphan candidates |
| Shared files | `file_share_files` | 2 | 51,044,034 | Both matched expired `shared_files` rows; both must be copied while present |
| Note media | `notes_media` | 6 | 577,917 | All matched active note-media rows |
| Chat attachments | `chat_attachments` | 0 | 0 | No existing rows or bytes; attachment capability enabled and must remain usable |
| **Total** | **All four buckets** | **59** | **52,656,017** | **50.22 MiB** |

Source sizes are file `sizeOriginal` sums. Bucket-level `totalSize=0` was inconsistent with the populated listings and was not used. Four historical avatar IDs were already absent at the production audit; current profile IDs and URLs resolved. Record those gaps as missing baseline history and render the normal avatar fallback. New missing current references or later source disappearances require reconciliation.

The five orphan avatar candidates are `6a35ac31000a7767f1fa`, `6a371edf00241b161aee`, `6a719aee000318ed216a`, `6a8484220026b73ffcd1`, and `6a8a45cf000864a9c61a`, totaling 103,075 bytes. Copy them as well. This audit does not establish whether external clients or retained backups use them. Expiry/orphan cleanup and whole-bucket retirement require their own decision after recovery is proven.

The latest read-only source inventory again returned 59 objects and 52,656,017 bytes. Its `missing_references=0` and all-present-objects-unreferenced counts came from comparison with the **local development database**. They do not supersede the production reference audit and do not certify production reference coverage.

## Storage and feature behavior

Migration `028_sqlite_upload_storage.sql` adds:

- `storage_objects`: immutable `(namespace, object_id)` identity, integer BLOB row ID, original filename, MIME type, stored byte length, SHA-256, format version, encryption key ID, nonce, encrypted payload, and timestamps.
- Explicit `appwrite`/`sqlite` backend markers on users, note media, and chat attachments. Shared files already have a marker. Existing records start as Appwrite.
- `storage_avatar_ownership`: retained uploader attribution for quota/account cleanup, independent of the current profile URL.
- `storage_migration_manifest`: source identity, source timestamps and size, reference status, destination hash/size, stage timestamps, errors, and intentional-removal history.
- Durable legacy-storage deletion queues and account-deletion completion records.

`services/storage_objects.py` scans original content, hashes stored bytes, and encrypts before obtaining the SQLite writer. Feature writers acquire `BEGIN IMMEDIATE`, recheck quota/replacement credit, and commit payloads and metadata together. Network operations, scanning, and decryption happen outside the writer. Metadata/quota queries do not select payloads. Reads capture one bounded ciphertext, close the read snapshot, then authenticate/decrypt before the HTTP response is sent.

AES-256-GCM uses a dedicated external keyring and fresh 12-byte nonces. Associated data authenticates namespace, object ID, MIME type, format version, and stored length. The database contains key IDs, never key material. Keyrings must be regular files, not symlinks, with mode `0600` or `0640`; recovery must preserve every key still referenced by current data or retained backups. See [the authenticated-encryption API](https://cryptography.io/en/latest/hazmat/primitives/aead/).

| Feature | Preserved behavior | Payload bound |
| --- | --- | --- |
| Avatars | Provider refresh and manual uploads; public canonical `/api/avatars/<id>` URLs; external provider URLs preserved; historical avatars retained while referenced | 10 MiB; test above the former 3 MiB Appwrite bucket limit |
| Shared files | Private downloads, public share codes, folders/ZIPs, filenames, expiry, tier quotas, attachment disposition, MIME safety, `nosniff` | 50 MiB per file |
| Note media | Stable media IDs/editor references; parent-note authorization for every read, including conditional responses; sharing and pending-media cleanup | 10 MiB |
| Chat attachments | Independent capability flag; server disabled guard; GIF/gzip behavior, original-input hash, PDF previews, status, scope permissions, byte accounting | 50 MiB original/stored input; bounded previews |

Range and conditional responses retain the existing access checks. A corrupt SQLite payload is an error and cannot silently fall back to Appwrite. Explicit legacy records can use the compatibility transport only while legacy reads are enabled.

Imported avatar attribution prefers one current `avatar_file_id` owner. A `picture_url` borrower is not evidence of upload ownership. If no stored-ID owner exists, one unambiguous historical message `user_id` can supply attribution. Orphans and ambiguous owners are copied without inventing a quota charge. Existing ledger ownership never transfers. Retained historical images remain charged to their known uploader; changing a profile URL cannot erase that charge.

Feature/account deletion commits local payload and metadata cleanup together and records durable remote work. Legacy deletion runs outside the writer; failed remote deletes remain queued. Account Auth deletion completes only after local account removal and its account-scoped upload queue have settled; `auth_deleted_at` records durable completion. Completion receipts survive retries. Drain both storage and account-completion queues before the final mutation pause.

## Import contract

`scripts/migrate_appwrite_storage_to_sqlite.py` exposes `dry-run`, `copy`, `verify`, and `promote`.

| Stage | Remote access | Local writes | Required result |
| --- | --- | --- | --- |
| `dry-run` | Paginated file inventory of every configured bucket | None; existing database opened read-only | Fresh counts, source sizes, unreferenced objects, missing references |
| `copy` | Fresh inventory and bounded downloads | Additive schema, encrypted objects, manifest, ownership | Every present source copied; expiry/orphan status never excludes a source object |
| `verify` | Fresh inventory and bounded downloads | Manifest verification results | Decrypted destination length/SHA-256 equal freshly downloaded bytes |
| `promote` | None | One atomic metadata/URL/manifest promotion | Every present source verified; all live legacy references resolvable; all workers paused |

Reruns authenticate matching destinations without replacing their ciphertext. Different bytes under the same source identity fail without overwrite. Matching hashes in metadata alone are insufficient: copy/verify/promotion capture and decrypt the destination before acquiring the writer, then compare the same full metadata and ciphertext fingerprint under the writer to prevent a concurrent replacement from being marked verified.

The manifest preserves legitimate deletion history. A disappeared source is accepted as retirement only with a durable intentional-removal receipt and no remaining live reference. A removed object still present remotely is recopied; a newly disappeared source without such a receipt blocks promotion. A backup also fails when copied/promoted bytes are missing, including an orphan, unless an intentional-removal receipt explains the absence.

Avatar URL promotion parses endpoint, project, bucket, and object identity. It does not use substring replacement. Stable IDs, share codes, note editor references, and legacy source mappings remain. Only audited baseline gaps in historical chat-avatar columns become fallback values; absent feature payloads cannot be promoted.

CLI settings are resolved through `EnvironmentConfig` after loading the chosen `--env-file`. Existing process settings take precedence (`override=False`), so check the effective rollout settings instead of assuming editing `.env` changes already-running workers.

## Operational readiness and remaining gates

Read-only VPS checks found roughly 132 GiB available, Python 3.12.3, SQLite 3.45.1, and three Gunicorn workers on Ubuntu 24.04. ClamAV was absent. The package was `libsqlite3-0 3.45.1-1ubuntu2.8`; its inspected changelog did not prove the WAL-reset fix was backported. The Python-linked runtime needs patch evidence or a tested upgrade. SQLite documents fixed release 3.51.3 and maintenance backports 3.44.6/3.50.7. Preserve WAL and verify the actual Python runtime. [SQLite WAL-reset advisory](https://www.sqlite.org/wal.html#walreset)

The backup account could read both databases and write the backup destination, but production `.env` was root-owned mode `0600` and unreadable by `deployer`. The newest visible backup was September 14. There were 77 visible backup directories: 76 daily sets and one repair set. Do not prune this history while investigating retention. Repair minimum secret access, create a fresh backup in a separate directory, and prove an independently recovered off-VPS restore before cutover. Recovery and the next scheduled daily backup are still unproven in production.

`backup_nest_db.py` uses SQLite's online backup API, checks both required databases, restores/decrypts every upload before publishing a set, and discards an incomplete set without rotating good history. `--no-discord --preserve-history` supports migration validation without notifications or pruning. `verify_storage_backup.py` restores to a private disposable directory with separately recovered keys, verifies database integrity/foreign keys, all payload hashes, live SQLite pointers, retained ownership, and surviving manifest hashes. It reports unresolved Appwrite pointers and baseline gaps; a successful pre-cutover backup is not proof that legacy references have been migrated.

The local generated-data memory profile used three processes, one 50 MiB object per read/upload, two 50 MiB ZIP members per process with a 1 MiB spill threshold, and a generated near-50 MiB PDF preview. It completed in 2.92 seconds; individual lifetime RSS peaks were 355,729,408, 330,104,832, and 358,793,216 bytes, summing to 1,044,627,456 bytes (about 996 MiB). These peaks were not a measurement of simultaneous VPS RSS. Scanning was mocked **only for these generated local profile bytes**. This is neither production throughput nor a bound on Gunicorn, ClamAV, or aggregate VPS RSS. Repeat the profile and mixed application/scanner workload on the production-equivalent runtime and assess headroom before cutover.

## Completion evidence

Local migration/backup/queue tests cover resumability, hash mismatch, concurrent destination changes, transaction rollback, ownership attribution, missing/orphan restore coverage, separate key recovery, queue pause/status, and environment configuration. Full repository tests/build/Desloppify and browser checks belong to the implementation handoff; record their actual results rather than treating these operator prerequisites as tested production behavior.

The October 2 local handoff completed the following checks:

| Check | Actual result |
| --- | --- |
| `npm test` | Passed: 576 JavaScript tests; 1,557 Python tests run, one skipped. The PDF download regression compares the exact uploaded fixture bytes rather than regenerating timestamped PDF content. |
| `npm run build` | Passed. Vite reported its existing large-chunk advisory. |
| Desloppify from the repository root, `scan --path . --no-badge` | Completed with configured exclusions. JavaScript scores: overall 79.0, objective 94.7, strict 77.6, verified 87.3. The `jscpd` duplication detector exited with errors and was skipped. Existing repository findings remain. |
| Additional Python Desloppify scan, `--lang python scan --path . --no-badge` | Completed: overall 21.6, objective 86.5, strict 21.2, verified 86.5. Subjective dimensions remain unassessed; Bandit was unavailable, reducing security coverage. Independent review of 39 relevant persisted SQL-construction findings found no concrete injection or data-integrity defect; this does not replace missing Bandit coverage. |
| Full-application storage integration | Nine tests passed using disposable databases/keyrings, generated files, a fixture-only scanner, and all Appwrite Storage methods configured to fail if called. Authorization, conditional/range responses, gzip restoration, previews, quota and deletion use the actual application routes. |
| Connected Brave at `http://127.0.0.1:8038` | Rendered settings/current avatars, shared-file cards and public download notice, private note image, and chat PNG/GIF/PDF previews. The disposable server/tab were closed after inspection. |
| Diff whitespace | `git diff --check` passed. |

One direct logged-out browser navigation could not establish the visual denial result: `http://127.0.0.1:8038/api/chat/attachments/5c396d03-6da9-4251-bd6b-a3f967c381bf/preview` failed with `net::ERR_BLOCKED_BY_CLIENT`. The refused URL was respected; no browser protection was changed. Route integration tests separately passed unauthenticated/unauthorized denial before conditional responses. A cookie-consent module also reported a browser fetch failure; no site challenge was observed.

Test/build/scan logs are local temporary evidence under `/private/tmp/nest-storage-npm-test-final-passing.log`, `/private/tmp/nest-storage-build-final.log`, `/private/tmp/nest-storage-desloppify-handoff.log`, and `/private/tmp/nest-storage-desloppify-python-handoff.log`. No production import, configuration/permission change, remote deletion, deployment, commit/push, or notification was performed for this handoff.

## Approved production preparation, October 2

The user subsequently approved scanner/runtime/key/backup preparation and explicitly approved the two private Mac recovery destinations. Preparation changed supporting services and the backup schedule; it did not deploy the application, activate SQLite writes, import Appwrite bytes, change Appwrite permissions, or retire objects/buckets.

| Prepared item | Actual evidence |
| --- | --- |
| ClamAV | Ubuntu ClamAV 1.5.4 daemon/updater installed and active. Downloaded daily 28141, main 63 and bytecode 339 signatures. Unix socket `/run/clamav/clamd.ctl`, group `clamav`, mode `0660`; no scanner TCP listener. `deployer` has socket access. |
| Scanner policy | Stream/file limits 64 MiB, expanded scan limit 256 MiB, recursion 32, files 10,000, three scanner threads, finite queue/time limits, encrypted/over-limit alerts enabled, definitions-age startup guard two days. Real adapter checks passed clean 50 MiB, antivirus test rejection, disconnect, timeout, file-count, recursion, expansion, and encrypted-archive rejection. The last case used a small generated encrypted ZIP made on the Mac because the VPS has no ZIP CLI. |
| Fixed SQLite staged | Official SQLite 3.53.4 archive and amalgamation SHA3-256 verified before compilation. Root-owned library `/opt/nest/sqlite/3.53.4/lib`; wrapper `/opt/nest/sqlite/3.53.4/python` uses the existing production venv with command-scoped `LD_LIBRARY_PATH`. Exact source ID/library mapping verified. Disposable checks passed 50 MiB BLOB/snapshot/hash, rollback, online backup, foreign keys, JSON, FTS5, RTREE and 360 commits from three writers with concurrent checkpoints. Production critical compile defaults/features were retained; the unused baseline `ENABLE_UPDATE_DELETE_LIMIT` was omitted because amalgamation parser generation does not enable it. |
| Upload keys | `/etc/nest-upload/upload-keys.json`, root:`nest-upload`, `0640`, parent `0750`, active key ID `upload-2026-10`; `deployer` has the dedicated group. Independently stored Mac copy `/Users/derekchen/.local/share/nest-upload-recovery/upload-keys-20261002.json`, file `0600`, parent `0700`, outside database backups. No key content entered logs or documentation. |
| Actual storage lifecycle | Generated 50 MiB data used the real scanner, production key and staged runtime in a disposable DB. Payload BLOB was 52,428,816 ciphertext bytes; authenticated reads matched original length/hash, plaintext marker was absent, and commit/rollback/delete preserved atomic metadata/payload behavior. Only the scratch database was accessible to this check. |
| VPS synthetic capacity check | The staged profiler completed in 11.66 seconds with three processes, 50 MiB read/upload inputs, two-member ZIPs and generated PDF previews. Reported per-process lifetime high-water RSS was 257,200,128 bytes each, sum 771,600,384 bytes (about 736 MiB). Each startup high-water counter already equaled its final peak; this does not measure simultaneous application RSS or bound real document/scanner costs. Only these generated profile inputs used mocked scanning; the real daemon stayed running and the separate actual-scanner object check passed. |
| Backup repair | Standalone reviewed tools at `/opt/nest-storage-preparation/20261002`; restricted nonsecret `/etc/nest-upload/backup.env`. The application `.env` remains root-owned `0600`. Daily cron retains 03:00 Europe/London and its existing log, uses the existing flock, the fixed runtime, `--no-discord --preserve-history`, and the staged wrapper. Old backup history was preserved. |
| Fresh snapshots | Diagnostic set `/var/backups/nest-storage-preparation/20261002/manual/backup_2026-10-02_22-47-33` and exact scheduled-command set `/var/backups/nest-db/backup_2026-10-02_22-47-35` both passed two-database integrity/foreign-key checks and restore validation as `deployer`; APSwiftly data was included. |
| Off-VPS recovery | Approved private copy `/Users/derekchen/.local/share/nest-backup-recovery/backup_2026-10-02_22-47-33`; all 39 file hashes matched the VPS, both required DBs restored/verified, and the optional APSwiftly SQLite file passed integrity checking. A generated 193-byte ciphertext probe encrypted on the VPS decrypted with the recovered Mac key; tampering and a missing key were rejected. |
| Live application | `nest` master PID 1009133 and start time remained unchanged; local production HTTP returned 200. Its actual unit currently specifies `User=root`, `Group=www-data`, unlike the intended account layout in `VPS_CONTEXT.md`; preparation did not change its service identity. |

The live application still uses SQLite 3.45.1. At authorized deployment, launch **every** Gunicorn/scheduler/operator process with the staged fixed library and verify the actual worker mappings; the backup wrapper already uses it. No active Nest unit drop-in was installed during preparation. Source integrity and recovery tests do not prove application compatibility after live activation.

The pre-import snapshots contain zero encrypted uploads and 192 legacy references with the correct source-identity configuration. They prove current database recovery, not recovery of Appwrite upload bytes. The independent key probe is synthetic. Final all-source import, promoted/new-upload recovery, private permission checks, mixed application/scanner capacity, and post-cutover off-VPS restore remain deployment/cutover work.

The next real scheduled run is **October 2 at 10:00 PM America/New_York** (October 3 at 03:00 Europe/London). Its actual success remains to be observed; manual execution of the exact command passed. Notifications and history pruning stay disabled in the prepared backup wrapper until separately reviewed. Private VPS evidence is retained in `/var/backups/nest-storage-preparation/20261002`, including pre-change ClamAV/cron files, verified source manifests, scanner/runtime/object checks and backup logs.

Production completion requires fresh final inventory and verified copy of every present source, promoted references, working new uploads/downloads in all four features with Appwrite Storage unavailable, private note/chat access checks, browser-rendered media, drained durable queues, a verified post-cutover off-VPS recovery set with independent keys, and the next daily backup succeeding. Observe for at least seven days with legacy reads disabled before requesting separate bucket-retirement approval.

During observation retain the compatible reader, schema, manifests, every needed key, and source buckets. Rolling writes back to Appwrite must keep the compatible reader serving new SQLite data. Restoring the pre-migration database or deploying an Appwrite-only reader would lose access to new uploads. A full return requires exporting and reconciling post-cutover data first.

`notes_media` was publicly readable at both bucket and file levels. After Nest serves all references, revoke **both** public bucket reads and every file's public read grant; enabling file security alone leaves existing grants. Verify unauthenticated direct reads fail and authorized Nest reads work. Storage credential/scope retirement must preserve credentials/dependencies required by Appwrite Auth/OAuth. [Appwrite storage permissions](https://appwrite.io/docs/products/storage/permissions)
