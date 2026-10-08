# SQLite upload storage operator runbook

Updated October 7, 2026. Scanner/runtime/key/backup preparation was explicitly approved and completed; [the dated preparation evidence](storage-sqlite-migration.md#approved-production-preparation-october-2) records its exact state. Compatibility support is now deployed with Appwrite writes and legacy reads enabled; all three web workers use SQLite 3.53.4. Import/cutover and source permission changes still require explicit authorization. Bucket retirement is a separate approval. Read `VPS_CONTEXT.md` before production work.

Do not regenerate the existing keys or repeat provisioning blindly. The fixed-runtime wrapper is `/opt/nest/sqlite/3.53.4/python`; use it for operator tools and arrange the same library for every worker at authorized deployment. The application `.env` intentionally remains root-only. Preparation used a nonsecret `/etc/nest-upload/backup.env` and an isolated backup wrapper; import/cleanup needs a separately protected, minimum-permission migration environment that includes the required existing Appwrite credentials. The backup environment has no API key and cannot authorize remote mutations.

## 1. Establish the operator context and prerequisites

Connect using the repository's documented SSH identity. Run root-only preparation as root; run application tools as `deployer`. Keep evidence private and keep keys outside the application/database/backup directories.

```bash
nest_root=/var/www/nest.apstudy.org
nest_python="$nest_root/.venv/bin/python"
nest_database="$nest_root/instance/nest.sqlite3"
nest_keys=/etc/nest-upload/upload-keys.json
nest_backup_env=/etc/nest-upload/backup.env
nest_migration_env=/etc/nest-upload/storage-migration.env
nest_evidence="/var/backups/nest-storage-migration/$(date -u +%Y%m%dT%H%M%SZ)"
umask 077
install -d -o deployer -g deployer -m 0700 "$nest_evidence"
cd "$nest_root"
df -h "$nest_root" /var/backups
systemctl status nest --no-pager
sudo -u deployer "$nest_python" -c 'import sqlite3, _sqlite3; print(sqlite3.sqlite_version); print(_sqlite3.__file__)'
dpkg-query -W libsqlite3-0
```

Stop until the exact Python-linked SQLite runtime is proven to contain the WAL-reset fix by a fixed upstream release or documented vendor backport. The prior `3.45.1-1ubuntu2.8` changelog did not prove coverage. Test any runtime change with the actual venv and application; retain WAL. [Fixed releases and affected concurrency](https://www.sqlite.org/wal.html#walreset)

For this prepared VPS, set `nest_python=/opt/nest/sqlite/3.53.4/python` for subsequent operator commands. The live Nest unit must also receive `LD_LIBRARY_PATH=/opt/nest/sqlite/3.53.4/lib` and be restarted as part of the separately authorized deployment. Verify actual worker `/proc/<pid>/maps` entries after restart; a passing operator check does not establish the live worker runtime.

Inspect the current backup cron entry/log, server timezone, secret ownership, both database paths, and backup history. Preserve the 76 daily sets plus repair set while resolving the September 14 freshness gap.

```bash
sudo -u deployer crontab -l
timedatectl
stat -c '%U %G %a %n' "$nest_root/.env" "$nest_database" "$nest_root/instance/calendar.sqlite3"
sudo -u deployer test -r "$nest_backup_env"
sudo -u deployer test -r "$nest_database"
sudo -u deployer test -r "$nest_root/instance/calendar.sqlite3"
sudo -u deployer test -w /var/backups/nest-db
```

The backup account reads only its restricted backup environment and keys. Keep the full application `.env` root-only. For authorized import/cleanup, provision `storage-migration.env` separately with the minimum required source credentials, bucket identities, app URL, key/scanner paths, and rollout flags; align its pause flag with the effective worker state. Do not print credentials or copy unrelated application secrets. One root-operated protected directory layout is:

```bash
groupadd -f nest-upload
usermod -aG nest-upload deployer
install -d -o root -g nest-upload -m 0750 /etc/nest-upload
```

The future migration environment must be a root-owned regular file, group `nest-upload`, mode `0640`, readable by the approved operator. Its provisioning is part of authorized deployment/cutover, not the completed nonsecret backup repair.

Provision the keyring once; preserve an existing keyring rather than regenerating it. This root command fails if the file already exists and prints no key:

```bash
"$nest_python" - "$nest_keys" <<'PY'
import base64, json, os, sys
key_id = "upload-2026-10"
descriptor = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
    json.dump({"active_key_id": key_id, "keys": {
        key_id: base64.b64encode(os.urandom(32)).decode("ascii")}}, handle)
PY
chown root:nest-upload "$nest_keys"
chmod 0640 "$nest_keys"
sudo -u deployer test -r "$nest_keys"
```

Recover a protected copy from a separately controlled off-VPS key vault now and test its use. The ordinary database backup, manifest, Git repository, logs, and generated ZIPs must never contain key material. Keep all old key IDs until neither current objects nor retained backups need them. Use storage read credentials for inventory/copy/verify; queue drains need Storage delete permission and account completion needs Auth users-delete permission. Preserve Auth/OAuth credentials and avoid printing `.env`, API keys, or key JSON.

## 2. Prepare and prove ClamAV

Install/update a supported ClamAV daemon and signature updater as approved root preparation. The implementation accepts only an explicit INSTREAM clean result and rejects scanner errors/unavailability. Configure its local socket for the application account; keep TCP scanning bound to loopback if using TCP. Add `deployer` to the socket's allowed group and restart the application to refresh group membership.

Set these explicit clamd policy values in `/etc/clamav/clamd.conf`, retaining the distro's other required settings:

```text
StreamMaxLength 64M
MaxFileSize 64M
MaxScanSize 256M
MaxRecursion 32
MaxFiles 10000
ScanArchive yes
AlertExceedsMax yes
AlertEncrypted yes
LocalSocket /run/clamav/clamd.ctl
LocalSocketGroup clamav
LocalSocketMode 660
```

These values allow the application's full 50 MiB input to reach the scanner while enforcing finite archive expansion. Over-limit, excessively nested, encrypted/unscannable archives must be rejected instead of receiving an apparent clean verdict. Verify the effective options for the installed ClamAV version. [Official clamd configuration sample](https://raw.githubusercontent.com/Cisco-Talos/clamav/main/etc/clamd.conf.sample)

```bash
usermod -aG clamav deployer
systemctl restart clamav-daemon
systemctl status clamav-daemon clamav-freshclam --no-pager
clamconf -n
clamdscan --version
```

Require current signatures and successful application-identity INSTREAM tests: clean 50 MiB input accepted; EICAR rejected; scanner disconnected/timed out rejected; archive/expansion limits and encrypted archives rejected. Check daemon/signature failure alerting. Do not disable scanning or mock it for source imports or production uploads. Synthetic memory profiling mocks only generated private fixture bytes and does not satisfy this gate.

## 3. Deploy compatibility support and establish fresh recovery

Deploy the reviewed additive schema and compatible readers/writers first, through the repository's approved deployment workflow. Configure `.env` as follows while retaining all four Appwrite bucket IDs and credentials:

```dotenv
NEST_STORAGE_BACKEND=appwrite
NEST_STORAGE_READ_LEGACY=true
NEST_STORAGE_MUTATIONS_PAUSED=false
NEST_UPLOAD_KEYRING_PATH=/etc/nest-upload/upload-keys.json
NEST_CLAMAV_SOCKET=/run/clamav/clamd.ctl
NEST_CLAMAV_TIMEOUT=30
NEST_CHAT_ATTACHMENTS_ENABLED=true
```

Restart `nest` and verify all three workers belong to the new deployment and can read the keyring/socket. A shell environment overrides `.env`; use a clean operator shell and pass `--env-file` explicitly. Changing `.env` alone does not change workers' immutable configuration snapshots.

```bash
systemctl restart nest
systemctl show nest -p MainPID -p User -p ActiveEnterTimestamp
pgrep -a -f 'gunicorn.*wsgi'
sudo -u deployer "$nest_python" scripts/backup_nest_db.py \
  --env-file "$nest_backup_env" --instance-dir "$nest_root/instance" \
  --backup-dir "$nest_evidence/pre-copy" --storage-keyring "$nest_keys" \
  --no-discord --preserve-history
```

Require exit 0 and a published `backup_*` directory. APSwiftly data is optional and skipped data is reported; both SQLite databases are required. Before copying source data, restore this fresh set off-VPS using independently recovered keys. A pre-copy set contains records and existing SQLite bytes, but does not recover Appwrite payloads that have not yet been imported.

Repeat memory profiling on the production-equivalent runtime, assess total Gunicorn plus ClamAV RSS/headroom under mixed uploads/downloads/ZIPs/PDF previews, and record database/WAL disk growth:

```bash
sudo -u deployer "$nest_python" scripts/profile_sqlite_storage_memory.py \
  --object-mib 50 --workers 3 --zip-members 2 > "$nest_evidence/synthetic-memory.json"
```

This command uses scratch databases and generated bytes, no source transport, and a mocked scanner for those generated bytes. It does not measure real concurrent ClamAV memory or prove production throughput. Stop on memory pressure, scanner failure, restore failure, or unproven runtime patch coverage.

## 4. Inventory, bulk copy, and settle durable work

Compatibility readers and Appwrite writes stay available during bulk copy. Do not launch opportunistic expiry/orphan cleanup; copy every present object, including expired shared files and orphan avatars. Save the dated production inventory and reconcile its reference results against the October 1 baseline of five orphan candidates and four missing historical avatar IDs.

```bash
sudo -u deployer "$nest_python" scripts/migrate_appwrite_storage_to_sqlite.py dry-run \
  --env-file "$nest_migration_env" --database-path "$nest_database" > "$nest_evidence/inventory-before.json"
sudo -u deployer "$nest_python" scripts/migrate_appwrite_storage_to_sqlite.py copy \
  --env-file "$nest_migration_env" --database-path "$nest_database" > "$nest_evidence/copy-bulk.json"
sudo -u deployer "$nest_python" scripts/migrate_appwrite_storage_to_sqlite.py verify \
  --env-file "$nest_migration_env" --database-path "$nest_database" > "$nest_evidence/verify-bulk.json"
```

Require exit 0 and `failed=0` for copy/verify. Every stage refreshes all four buckets. Original counts were 51/2/6/0 and 52,656,017 bytes; legitimate new objects/deletions can change them. Document each difference. A hash mismatch, unexplained disappearance, or missing current/feature reference is a stop condition; retain the manifest and resolve it without overwriting bytes.

Read queue status. The following drain/completion commands perform remote deletes and are run only within the approved migration/account-cleanup scope. Complete already-recorded account deletions; do not create new tombstones to force the counts to zero.

```bash
sudo -u deployer "$nest_python" scripts/cleanup_legacy_storage.py \
  --env-file "$nest_migration_env" --database-path "$nest_database" --status
sudo -u deployer "$nest_python" scripts/cleanup_deleted_accounts.py \
  --env-file "$nest_migration_env" --database-path "$nest_database" --status
sudo -u deployer "$nest_python" scripts/cleanup_legacy_storage.py \
  --env-file "$nest_migration_env" --database-path "$nest_database"
sudo -u deployer "$nest_python" scripts/cleanup_deleted_accounts.py \
  --env-file "$nest_migration_env" --database-path "$nest_database" --limit 100
```

Repeat bounded completion passes as needed, then repeat both `--status` commands. Status is read-only and exit 1 means pending work; inspect JSON. Require storage `pending=0`, account `pending=0`, `accounts.blocked=0`, and `failed=0`. Auth completion deletes only accounts with durable local-deletion intent and an absent profile after their account-scoped upload work settles, then records `auth_deleted_at`. Failed/deferred work blocks cutover. The tools suppress notifications and sanitize error output.

## 5. Pause all writers, import the delta, and promote

Hold automatic deployments and operator cleanup jobs during cutover. Set `NEST_STORAGE_MUTATIONS_PAUSED=true` while retaining `NEST_STORAGE_BACKEND=appwrite`, then restart all application workers. Verify the old three workers have exited and storage mutations are rejected. Cover uploads, replacements, provider-avatar refresh during OAuth, note edit/collaboration media deletion, attachment finalization/abandoned cleanup, expiry jobs, account deletion/Auth completion, storage mutations from Discord/background jobs, and manual storage CLI jobs. Allow reads and OAuth using existing avatars. Ordinary text-only chat and Discord messages remain enabled.

Repeat both queue status commands after pause. Require no pending/blocked work. If a race left work queued, unpause/restart, drain it, and repeat the pause; never skip it or run drain commands through the pause. Wait for in-flight storage transports/writers to finish before the final inventory.

```bash
sudo -u deployer "$nest_python" scripts/migrate_appwrite_storage_to_sqlite.py dry-run \
  --env-file "$nest_migration_env" --database-path "$nest_database" > "$nest_evidence/inventory-final.json"
sudo -u deployer "$nest_python" scripts/migrate_appwrite_storage_to_sqlite.py copy \
  --env-file "$nest_migration_env" --database-path "$nest_database" > "$nest_evidence/copy-delta.json"
sudo -u deployer "$nest_python" scripts/migrate_appwrite_storage_to_sqlite.py verify \
  --env-file "$nest_migration_env" --database-path "$nest_database" > "$nest_evidence/verify-final.json"
sudo -u deployer "$nest_python" scripts/migrate_appwrite_storage_to_sqlite.py promote \
  --env-file "$nest_migration_env" --database-path "$nest_database" > "$nest_evidence/promotion.json"
```

The explicit import context can write its manifest/payloads while workers remain paused. Require exit 0, no unverified present source, and all live references reconciled. Promotion does no remote I/O and changes references atomically. Review fallback identities against the four recorded missing historical IDs; the summary counts affected URL columns and can exceed four when an ID appears in multiple messages. Never count missing source bytes as recovered.

Set `NEST_STORAGE_BACKEND=sqlite`, keep the pause true and legacy reads true, and restart all workers. Confirm effective configuration and exercise reads while paused. Then set pause false, restart all three workers, and validate new SQLite writes. If any gate fails, retain the pause or use the compatible rollback below.

## 6. Validate access, disable legacy reads, and prove recovery

Use an authorized test account to verify current/historical/manual/OAuth avatars, including a valid avatar above 3 MiB; existing/new private and public shared links, expiry and folder ZIPs; note images and shared notes; GIF/gzip/PDF chat previews and downloads; range/conditional behavior; MIME/attachment headers; quota contention; and replacement/feature/account deletion. Verify private note/chat denial for unauthenticated and unauthorized viewers before conditional responses. Check the rendered result in the connected Brave browser. Record actual URLs/failures if browser verification is unavailable.

Set `NEST_STORAGE_READ_LEGACY=false`, restart all workers, and repeat reads plus new uploads in every feature with Appwrite **Storage** transport unavailable. Keep Appwrite Auth/OAuth working. Corrupt SQLite data must raise an error, not fall back remotely. Require no legacy read attempts or normal Storage API requests.

After Nest serves every note-media reference, revoke public `read("any")` at **both** `notes_media` bucket level and every remaining file. Check no public file grants survive and future legacy uploads cannot add them. Verify unauthenticated direct Appwrite reads fail and authorized Nest reads succeed. Do not rely on enabling file security alone. Preserve other required permissions and Auth/OAuth. [Appwrite permission semantics](https://appwrite.io/docs/products/storage/permissions)

```bash
sudo -u deployer "$nest_python" scripts/backup_nest_db.py \
  --env-file "$nest_backup_env" --instance-dir "$nest_root/instance" \
  --backup-dir "$nest_evidence/post-cutover" --storage-keyring "$nest_keys" \
  --no-discord --preserve-history
```

Copy the completed `backup_*` set to a protected off-VPS recovery location through the approved backup channel; recover the keyring independently. On the isolated recovery host, use reviewed code/dependencies, prevent production jobs/network writes, and supply a non-secret source-identity/app-URL environment file. It needs the original `APPWRITE_ENDPOINT`, `APPWRITE_PROJECT_ID`, `APPWRITE_PROFILE_AVATAR_BUCKET_ID`, and `APP_BASE_URL`, with no API key or production credentials:

```bash
python scripts/verify_storage_backup.py /protected/recovery/backup_TIMESTAMP \
  --env-file /protected/recovery/source-mapping.env \
  --keyring /protected/keys/recovered-upload-keys.json \
  --restore-dir /protected/recovery/disposable-restore
```

The restore directory must not already exist. Require `verified=true`, two checked databases, expected object/byte totals, matching manifest hashes, no unrecovered copied objects, and `coverage.legacy_references=0`. Baseline historical gaps and intentional-retirement receipts must match reviewed evidence. Exercise representative restored HTTP downloads with their normal authorization and compare hashes, including a post-cutover upload. Hash verification alone does not prove the routes/browser rendering.

Update/verify the actual daily backup automation to invoke the reviewed backup script with its readable environment and external keyring. It must publish only fully verified sets and preserve recovery keys separately. Confirm the **next scheduled** 03:00 run succeeds in the server's configured timezone, notifications/alerting behave as configured, and a fresh off-VPS copy is recoverable. A manual run alone does not prove cron permissions or automation.

Observe for at least seven days: storage errors, scanner availability/signature age, rejected quota, lock timeouts, queue counts, legacy read attempts, Gunicorn/ClamAV RSS, database/WAL growth, disk headroom, and daily backup freshness. Keep the four source buckets, manifest, compatible reader, and all recovery keys throughout.

## 7. Compatible rollback and separate retirement

For a runtime regression, pause/restart all writers, preserve the current database and a fresh verified backup, then set writes to Appwrite and enable legacy reads **using the compatible release**. Drain/reconcile durable work before resuming. Keep SQLite reads for objects created since cutover. Reapply note privacy protections to any approved legacy note upload path.

Do not restore the pre-copy database or deploy the old Appwrite-only reader over new uploads. A complete move back to Appwrite requires a separately reviewed export of new SQLite objects and metadata/reference reconciliation first.

Request separate approval to retire buckets only after the observation period, all feature checks, SQLite-only traffic, verified off-VPS restore, and scheduled backup success. Review externally distributed Appwrite URLs, which Nest cannot redirect. Retire storage-specific credentials/scopes and legacy code only after that decision; retain Auth/OAuth credentials and dependencies.
