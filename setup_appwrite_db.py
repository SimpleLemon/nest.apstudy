import logging
import os
import time
from appwrite.client import Client
from appwrite.exception import AppwriteException
from appwrite.permission import Permission
from appwrite.role import Role
from appwrite.services.tables_db import TablesDB
from appwrite.services.storage import Storage
from dotenv import load_dotenv

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
load_dotenv()
REQUIRED_ENV_VARS = [
    "APPWRITE_ENDPOINT",
    "APPWRITE_PROJECT_ID",
    "APPWRITE_API_KEY",
    "APPWRITE_DATABASE_ID",
]
MAX_APPWRITE_VARCHAR_SIZE = 16381
PROFILE_AVATAR_BUCKET_ID = "profile_avatars"
PROFILE_AVATAR_MAX_FILE_SIZE = 10 * 1024 * 1024
PROFILE_AVATAR_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp"]
FILE_SHARE_BUCKET_ID = "file_share_files"
FILE_SHARE_MAX_FILE_SIZE = 50 * 1024 * 1024

def _require_env():
    missing = [key for key in REQUIRED_ENV_VARS if not os.environ.get(key)]
    if missing:
        raise SystemExit(
            "Missing required environment variables: " + ", ".join(missing)
        )

def _init_client():
    client = Client()
    client.set_endpoint(os.environ["APPWRITE_ENDPOINT"])
    client.set_project(os.environ["APPWRITE_PROJECT_ID"])
    client.set_key(os.environ["APPWRITE_API_KEY"])
    return client

# ---------------------------------------------------------------------------
# Polling helpers
# ---------------------------------------------------------------------------

def _wait_for_column(tablesdb, database_id, table_id, key, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            column = tablesdb.get_column(
                database_id=database_id,
                table_id=table_id,
                key=key,
            )
        except AppwriteException:
            time.sleep(0.5)
            continue
        if column.status == "available":
            return
        time.sleep(0.5)
    logger.warning(
        "Column %s on %s not available after %ss",
        key,
        table_id,
        timeout,
    )

def _wait_for_index(tablesdb, database_id, table_id, key, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            index = tablesdb.get_index(
                database_id=database_id,
                table_id=table_id,
                key=key,
            )
        except AppwriteException:
            time.sleep(0.5)
            continue
        if index.status == "available":
            return
        time.sleep(0.5)
    logger.warning(
        "Index %s on %s not available after %ss",
        key,
        table_id,
        timeout,
    )

# ---------------------------------------------------------------------------
# Introspection helpers
# ---------------------------------------------------------------------------

def _list_existing_tables(tablesdb, database_id):
    """Return a dict of {table_id: table_object} for all tables in the DB."""
    try:
        response = tablesdb.list_tables(database_id=database_id)
    except AppwriteException:
        logger.exception("Failed to list tables")
        raise
    return {table.id: table for table in response.tables}

def _list_columns(tablesdb, database_id, table_id):
    """Return a set of column keys that already exist on a table."""
    try:
        response = tablesdb.list_columns(
            database_id=database_id,
            table_id=table_id,
        )
    except AppwriteException:
        logger.exception("Failed to list columns for %s", table_id)
        return set()
    return {column.key for column in response.columns}

def _list_indexes(tablesdb, database_id, table_id):
    """Return a set of index keys that already exist on a table."""
    try:
        response = tablesdb.list_indexes(
            database_id=database_id,
            table_id=table_id,
        )
    except AppwriteException:
        logger.exception("Failed to list indexes for %s", table_id)
        return set()
    return {index.key for index in response.indexes}

# ---------------------------------------------------------------------------
# Ensure helpers
# ---------------------------------------------------------------------------

def _ensure_table(tablesdb, database_id, table_id, name, permissions, row_security):
    try:
        tablesdb.create_table(
            database_id=database_id,
            table_id=table_id,
            name=name,
            permissions=permissions,
            row_security=row_security,
            enabled=True,
        )
        logger.info("Created table: %s", table_id)
    except AppwriteException as exc:
        if exc.code == 409:
            logger.info("Table already exists: %s", table_id)
            return
        raise

def _ensure_column(tablesdb, database_id, table_id, existing_columns, spec):
    key = spec["key"]
    if key in existing_columns:
        return
    attr_type = spec["type"]
    xrequired = spec.get("xrequired", False)
    xdefault = spec.get("xdefault")
    array = spec.get("array", False)
    encrypt = spec.get("encrypt", False)
    try:
        if attr_type == "string":
            # Legacy "string" type maps to varchar for backward compat
            requested_size = int(spec["size"])
            size = max(1, min(requested_size, MAX_APPWRITE_VARCHAR_SIZE))
            if size != requested_size:
                logger.warning(
                    "Clamping varchar size for %s.%s from %s to %s (Appwrite max)",
                    table_id,
                    key,
                    requested_size,
                    size,
                )
            tablesdb.create_varchar_column(
                database_id=database_id,
                table_id=table_id,
                key=key,
                size=size,
                required=xrequired,
                default=xdefault,
                array=array,
            )
        elif attr_type == "varchar":
            requested_size = int(spec["size"])
            size = max(1, min(requested_size, MAX_APPWRITE_VARCHAR_SIZE))
            tablesdb.create_varchar_column(
                database_id=database_id,
                table_id=table_id,
                key=key,
                size=size,
                required=xrequired,
                default=xdefault,
                array=array,
            )
        elif attr_type == "text":
            # Off-page storage, up to 16,383 chars, no size param needed
            tablesdb.create_text_column(
                database_id=database_id,
                table_id=table_id,
                key=key,
                required=xrequired,
                default=xdefault,
                array=array,
                encrypt=encrypt,
            )
        elif attr_type == "mediumtext":
            # Off-page storage, up to 4,194,303 chars
            tablesdb.create_mediumtext_column(
                database_id=database_id,
                table_id=table_id,
                key=key,
                required=xrequired,
                default=xdefault,
                array=array,
                encrypt=encrypt,
            )
        elif attr_type == "longtext":
            # Off-page storage, up to 1,073,741,823 chars
            tablesdb.create_longtext_column(
                database_id=database_id,
                table_id=table_id,
                key=key,
                required=xrequired,
                default=xdefault,
                array=array,
                encrypt=encrypt,
            )
        elif attr_type == "integer":
            tablesdb.create_integer_column(
                database_id=database_id,
                table_id=table_id,
                key=key,
                required=xrequired,
                min=spec.get("min"),
                max=spec.get("max"),
                default=xdefault,
                array=array,
            )
        elif attr_type == "float":
            tablesdb.create_float_column(
                database_id=database_id,
                table_id=table_id,
                key=key,
                required=xrequired,
                min=spec.get("min"),
                max=spec.get("max"),
                default=xdefault,
                array=array,
            )
        elif attr_type == "boolean":
            tablesdb.create_boolean_column(
                database_id=database_id,
                table_id=table_id,
                key=key,
                required=xrequired,
                default=xdefault,
                array=array,
            )
        elif attr_type == "datetime":
            tablesdb.create_datetime_column(
                database_id=database_id,
                table_id=table_id,
                key=key,
                required=xrequired,
                default=xdefault,
                array=array,
            )
        elif attr_type == "email":
            tablesdb.create_email_column(
                database_id=database_id,
                table_id=table_id,
                key=key,
                required=xrequired,
                default=xdefault,
                array=array,
            )
        elif attr_type == "url":
            tablesdb.create_url_column(
                database_id=database_id,
                table_id=table_id,
                key=key,
                required=xrequired,
                default=xdefault,
                array=array,
            )
        else:
            raise ValueError(f"Unknown column type: {attr_type}")
    except AppwriteException as exc:
        if exc.code == 409:
            return
        raise
    _wait_for_column(tablesdb, database_id, table_id, key)
    existing_columns.add(key)

def _ensure_index(tablesdb, database_id, table_id, existing_indexes, spec):
    key = spec["key"]
    if key in existing_indexes:
        return
    try:
        tablesdb.create_index(
            database_id=database_id,
            table_id=table_id,
            key=key,
            type=spec["type"],
            columns=spec["columns"],
            orders=spec.get("orders"),
        )
    except AppwriteException as exc:
        if exc.code == 409:
            return
        raise
    _wait_for_index(tablesdb, database_id, table_id, key)
    existing_indexes.add(key)

def _list_existing_buckets(storage):
    try:
        response = storage.list_buckets()
    except AppwriteException:
        logger.exception("Failed to list storage buckets")
        return set()
    return {bucket.id for bucket in response.buckets}

def _ensure_profile_avatar_bucket(storage):
    existing_buckets = _list_existing_buckets(storage)
    if PROFILE_AVATAR_BUCKET_ID in existing_buckets:
        logger.info("Storage bucket already exists: %s", PROFILE_AVATAR_BUCKET_ID)
        return

    try:
        storage.create_bucket(
            bucket_id=PROFILE_AVATAR_BUCKET_ID,
            name="Profile Avatars",
            permissions=[Permission.read(Role.any())],
            file_security=True,
            enabled=True,
            maximum_file_size=PROFILE_AVATAR_MAX_FILE_SIZE,
            allowed_file_extensions=PROFILE_AVATAR_EXTENSIONS,
            encryption=True,
            antivirus=True,
        )
        logger.info("Created storage bucket: %s", PROFILE_AVATAR_BUCKET_ID)
    except AppwriteException as exc:
        if exc.code == 409:
            logger.info("Storage bucket already exists: %s", PROFILE_AVATAR_BUCKET_ID)
            return
        raise

def _ensure_file_share_bucket(storage):
    existing_buckets = _list_existing_buckets(storage)
    if FILE_SHARE_BUCKET_ID in existing_buckets:
        logger.info("Storage bucket already exists: %s", FILE_SHARE_BUCKET_ID)
        return

    try:
        storage.create_bucket(
            bucket_id=FILE_SHARE_BUCKET_ID,
            name="File Share Files",
            permissions=[],
            file_security=True,
            enabled=True,
            maximum_file_size=FILE_SHARE_MAX_FILE_SIZE,
            encryption=True,
            antivirus=True,
        )
        logger.info("Created storage bucket: %s", FILE_SHARE_BUCKET_ID)
    except AppwriteException as exc:
        if exc.code == 409:
            logger.info("Storage bucket already exists: %s", FILE_SHARE_BUCKET_ID)
            return
        raise

# ---------------------------------------------------------------------------
# Apply a full table spec
# ---------------------------------------------------------------------------

def _apply_table(tablesdb, database_id, spec, create_table=True):
    table_id = spec["id"]
    if create_table:
        _ensure_table(
            tablesdb,
            database_id,
            table_id=table_id,
            name=spec["name"],
            permissions=spec["permissions"],
            row_security=spec["row_security"],
        )
    existing_columns = _list_columns(tablesdb, database_id, table_id)
    for column_spec in spec["columns"]:
        _ensure_column(tablesdb, database_id, table_id, existing_columns, column_spec)
    existing_indexes = _list_indexes(tablesdb, database_id, table_id)
    for index_spec in spec["indexes"]:
        _ensure_index(tablesdb, database_id, table_id, existing_indexes, index_spec)

# ---------------------------------------------------------------------------
# Table Specifications
# ---------------------------------------------------------------------------

TABLE_SPECS = [
    {
        "id": "users",
        "name": "users",
        "permissions": [],
        "row_security": True,
        "columns": [
            {"key": "google_id", "type": "string", "size": 255, "xrequired": True},
            {"key": "public_user_id", "type": "string", "size": 10},
            {"key": "email", "type": "email", "xrequired": True},
            {"key": "name", "type": "string", "size": 255},
            {"key": "picture_url", "type": "url"},
            {"key": "school", "type": "string", "size": 255},
            {"key": "major", "type": "string", "size": 255},
            {"key": "graduation_year", "type": "string", "size": 16},
            {"key": "banner_color", "type": "string", "size": 7, "xdefault": "#fecae1"},
            {"key": "avatar_file_id", "type": "string", "size": 64},
            {"key": "avatar_source", "type": "string", "size": 16},
            {"key": "onboarding_complete", "type": "boolean", "xdefault": False},
            {"key": "onboarding_step", "type": "integer", "xdefault": 1},
            {"key": "education_level", "type": "string", "size": 32},
            {"key": "class_year", "type": "string", "size": 64},
            {"key": "emory_student", "type": "boolean"},
            {"key": "emory_email", "type": "email"},
            {"key": "created_at", "type": "datetime", "xrequired": True},
            {"key": "last_login", "type": "datetime"},
            {"key": "provider", "type": "string", "size": 32},
        ],
        "indexes": [
            {"key": "idx_users_google_id", "type": "unique", "columns": ["google_id"]},
            {"key": "idx_users_email", "type": "unique", "columns": ["email"]},
            {"key": "idx_users_public_user_id", "type": "key", "columns": ["public_user_id"]},
        ],
    },
    {
        "id": "user_settings",
        "name": "user_settings",
        "permissions": [],
        "row_security": True,
        "columns": [
            {"key": "user_id", "type": "string", "size": 64, "xrequired": True},
            {"key": "canvas_ical_url", "type": "url"},
            {"key": "other_ical_urls_json", "type": "text"},
            {"key": "ics_secret_token", "type": "string", "size": 255},
            {"key": "feed_refresh_minutes", "type": "integer", "xdefault": 15},
            {"key": "preferred_calendar_view", "type": "string", "size": 16, "xdefault": "week"},
            {"key": "interface_theme", "type": "string", "size": 32, "xdefault": "obsidian-dark"},
            {"key": "theme", "type": "string", "size": 16, "xdefault": "dark"},
            {"key": "sidebar_default", "type": "string", "size": 16, "xdefault": "expanded"},
            {"key": "email_notifications", "type": "boolean", "xdefault": True},
            {"key": "product_updates", "type": "boolean", "xdefault": True},
            {"key": "language", "type": "string", "size": 16, "xdefault": "en"},
            {"key": "timezone", "type": "string", "size": 64, "xdefault": ""},
            {"key": "created_at", "type": "datetime", "xrequired": True},
            {"key": "updated_at", "type": "datetime"},
        ],
        "indexes": [
            {"key": "idx_user_settings_user_id", "type": "unique", "columns": ["user_id"]},
            {"key": "idx_user_settings_user_id_key", "type": "key", "columns": ["user_id"]},
            {"key": "idx_user_settings_token", "type": "unique", "columns": ["ics_secret_token"]},
        ],
    },
    {
        "id": "user_courses",
        "name": "user_courses",
        "permissions": [],
        "row_security": True,
        "columns": [
            {"key": "user_id", "type": "string", "size": 64, "xrequired": True},
            {"key": "term", "type": "string", "size": 64, "xrequired": True},
            {"key": "subject", "type": "string", "size": 64, "xrequired": True},
            {"key": "catalog", "type": "string", "size": 64, "xrequired": True},
            {"key": "course_name", "type": "string", "size": 255},
            {"key": "section_number", "type": "string", "size": 64},
            {"key": "instructor_name", "type": "string", "size": 255},
            {"key": "source", "type": "string", "size": 32, "xdefault": "settings"},
            {"key": "crn", "type": "string", "size": 64},
            {"key": "added_at", "type": "datetime", "xrequired": True},
            {"key": "color_key", "type": "string", "size": 32},
            {"key": "course_overrides_json", "type": "text"},
            {"key": "updated_at", "type": "datetime"},
        ],
        "indexes": [
            {"key": "idx_user_courses_user_id", "type": "key", "columns": ["user_id"]},
            {"key": "idx_user_courses_term", "type": "key", "columns": ["term"]},
            {"key": "idx_user_courses_subject", "type": "key", "columns": ["subject"]},
            {"key": "idx_user_courses_catalog", "type": "key", "columns": ["catalog"]},
            {"key": "idx_user_courses_crn", "type": "key", "columns": ["crn"]},
            {"key": "idx_user_courses_source", "type": "key", "columns": ["source"]},
            {"key": "idx_user_courses_unique", "type": "unique", "columns": ["user_id", "term", "subject", "catalog", "crn"]},
        ],
    },
    {
        "id": "course_seat_tracks",
        "name": "course_seat_tracks",
        "permissions": [],
        "row_security": True,
        "columns": [
            {"key": "user_id", "type": "string", "size": 64, "xrequired": True},
            {"key": "term", "type": "string", "size": 64, "xrequired": True},
            {"key": "subject", "type": "string", "size": 64, "xrequired": True},
            {"key": "catalog", "type": "string", "size": 64, "xrequired": True},
            {"key": "crn", "type": "string", "size": 64},
            {"key": "section_id", "type": "string", "size": 255},
            {"key": "course_code", "type": "string", "size": 64},
            {"key": "course_title", "type": "string", "size": 255},
            {"key": "last_status", "type": "string", "size": 64},
            {"key": "last_seats_available", "type": "integer"},
            {"key": "enabled", "type": "boolean", "xdefault": True},
            {"key": "last_checked_at", "type": "datetime"},
            {"key": "last_notified_at", "type": "datetime"},
            {"key": "created_at", "type": "datetime", "xrequired": True},
            {"key": "updated_at", "type": "datetime"},
        ],
        "indexes": [
            {"key": "idx_course_tracks_user_id", "type": "key", "columns": ["user_id"]},
            {"key": "idx_course_tracks_enabled", "type": "key", "columns": ["enabled"]},
            {"key": "idx_course_tracks_section", "type": "key", "columns": ["section_id"]},
            {"key": "idx_course_tracks_lookup", "type": "key", "columns": ["term", "subject", "catalog"]},
            {"key": "idx_course_tracks_last_checked", "type": "key", "columns": ["last_checked_at"]},
            {"key": "idx_course_tracks_unique", "type": "unique", "columns": ["user_id", "term", "subject", "catalog", "crn"]},
        ],
    },
    {
        "id": "calendar_cache",
        "name": "calendar_cache",
        "permissions": [],
        "row_security": True,
        "columns": [
            {"key": "user_id", "type": "string", "size": 64, "xrequired": True},
            {"key": "feed_url", "type": "string", "size": 2048},
            {"key": "feed_url_hash", "type": "string", "size": 64},
            {"key": "event_uid", "type": "string", "size": 255},
            {"key": "event_title", "type": "string", "size": 2048},
            {"key": "event_start", "type": "datetime"},
            {"key": "event_end", "type": "datetime"},
            {"key": "is_all_day", "type": "boolean", "xdefault": False},
            {"key": "event_type", "type": "string", "size": 64},
            {"key": "course_name", "type": "string", "size": 255},
            {"key": "raw_description", "type": "text"},
            {"key": "fetched_at", "type": "datetime"},
        ],
        "indexes": [
            {"key": "idx_calendar_cache_user_id", "type": "key", "columns": ["user_id"]},
            {"key": "idx_calendar_cache_feed_hash", "type": "key", "columns": ["feed_url_hash"]},
            {"key": "idx_calendar_cache_user_feed", "type": "key", "columns": ["user_id", "feed_url_hash"]},
            {"key": "idx_calendar_cache_event_start", "type": "key", "columns": ["event_start"]},
            {"key": "idx_calendar_cache_fetched_at", "type": "key", "columns": ["fetched_at"]},
            {"key": "idx_calendar_cache_unique_uid", "type": "unique", "columns": ["user_id", "feed_url_hash", "event_uid"]},
        ],
    },
    {
        "id": "calendar_feeds",
        "name": "calendar_feeds",
        "permissions": [],
        "row_security": True,
        "columns": [
            {"key": "user_id", "type": "string", "size": 64, "xrequired": True},
            {"key": "feed_url", "type": "string", "size": 2048, "xrequired": True},
            {"key": "feed_url_hash", "type": "string", "size": 64, "xrequired": True},
            {"key": "calendar_name", "type": "string", "size": 255},
            {"key": "etag_header", "type": "string", "size": 1024},
            {"key": "last_modified_header", "type": "string", "size": 1024},
            {"key": "last_fetch_http_code", "type": "integer"},
            {"key": "last_fetched", "type": "datetime"},
            {"key": "created_at", "type": "datetime", "xrequired": True},
            {"key": "updated_at", "type": "datetime"},
        ],
        "indexes": [
            {"key": "idx_calendar_feeds_user_id", "type": "key", "columns": ["user_id"]},
            {"key": "idx_calendar_feeds_feed_hash", "type": "key", "columns": ["feed_url_hash"]},
            {"key": "idx_calendar_feeds_last_fetched", "type": "key", "columns": ["last_fetched"]},
            {"key": "idx_calendar_feeds_unique", "type": "unique", "columns": ["user_id", "feed_url_hash"]},
        ],
    },
    {
        "id": "user_calendar_preferences",
        "name": "user_calendar_preferences",
        "permissions": [],
        "row_security": True,
        "columns": [
            {"key": "user_id", "type": "string", "size": 64, "xrequired": True},
            {"key": "calendar_name", "type": "string", "size": 255, "xrequired": True},
            {"key": "display_name", "type": "string", "size": 255},
            {"key": "color_hex", "type": "string", "size": 7, "xdefault": "#6366f1"},
            {"key": "visible", "type": "boolean", "xdefault": True},
            {"key": "created_at", "type": "datetime", "xrequired": True},
            {"key": "updated_at", "type": "datetime"},
        ],
        "indexes": [
            {"key": "idx_user_calendar_prefs_user_id", "type": "key", "columns": ["user_id"]},
            {"key": "idx_user_calendar_prefs_name", "type": "key", "columns": ["calendar_name"]},
            {"key": "idx_user_calendar_prefs_unique", "type": "unique", "columns": ["user_id", "calendar_name"]},
        ],
    },
    {
        "id": "user_events",
        "name": "user_events",
        "permissions": [],
        "row_security": True,
        "columns": [
            {"key": "user_id", "type": "string", "size": 64, "xrequired": True},
            {"key": "title", "type": "string", "size": 255, "xrequired": True},
            {"key": "description", "type": "text"},
            {"key": "start", "type": "datetime", "xrequired": True},
            {"key": "end", "type": "datetime", "xrequired": True},
            {"key": "is_all_day", "type": "boolean", "xdefault": False},
            {"key": "color", "type": "string", "size": 7},
            {"key": "calendar_id", "type": "string", "size": 255},
            {"key": "created_at", "type": "datetime", "xrequired": True},
            {"key": "updated_at", "type": "datetime"},
        ],
        "indexes": [
            {"key": "idx_user_events_user_id", "type": "key", "columns": ["user_id"]},
            {"key": "idx_user_events_start", "type": "key", "columns": ["start"]},
            {"key": "idx_user_events_calendar", "type": "key", "columns": ["calendar_id"]},
        ],
    },
    {
        "id": "user_calendar_sources",
        "name": "user_calendar_sources",
        "permissions": [],
        "row_security": True,
        "columns": [
            {"key": "user_id", "type": "string", "size": 64, "xrequired": True},
            {"key": "source_id", "type": "string", "size": 255, "xrequired": True},
            {"key": "kind", "type": "string", "size": 32, "xdefault": "local"},
            {"key": "default_name", "type": "string", "size": 255},
            {"key": "created_at", "type": "datetime", "xrequired": True},
            {"key": "updated_at", "type": "datetime"},
        ],
        "indexes": [
            {"key": "idx_user_calendar_sources_user", "type": "key", "columns": ["user_id"]},
            {"key": "idx_user_calendar_sources_source", "type": "key", "columns": ["source_id"]},
            {"key": "idx_user_calendar_sources_unique", "type": "unique", "columns": ["user_id", "source_id"]},
        ],
    },
    {
        "id": "user_event_overrides",
        "name": "user_event_overrides",
        "permissions": [],
        "row_security": True,
        "columns": [
            {"key": "user_id", "type": "string", "size": 64, "xrequired": True},
            {"key": "event_ref", "type": "string", "size": 255, "xrequired": True},
            {"key": "hidden", "type": "boolean", "xdefault": False},
            {"key": "title", "type": "string", "size": 255},
            {"key": "description", "type": "text"},
            {"key": "start", "type": "datetime"},
            {"key": "end", "type": "datetime"},
            {"key": "is_all_day", "type": "boolean"},
            {"key": "calendar_id", "type": "string", "size": 255},
            {"key": "color", "type": "string", "size": 7},
            {"key": "created_at", "type": "datetime", "xrequired": True},
            {"key": "updated_at", "type": "datetime"},
        ],
        "indexes": [
            {"key": "idx_user_event_overrides_user", "type": "key", "columns": ["user_id"]},
            {"key": "idx_user_event_overrides_ref", "type": "key", "columns": ["event_ref"]},
            {"key": "idx_user_event_overrides_calendar", "type": "key", "columns": ["calendar_id"]},
            {"key": "idx_user_event_overrides_unique", "type": "unique", "columns": ["user_id", "event_ref"]},
        ],
    },
    {
        "id": "shared_files",
        "name": "shared_files",
        "permissions": [],
        "row_security": True,
        "columns": [
            {"key": "user_id", "type": "string", "size": 64, "xrequired": True},
            {"key": "folder_id", "type": "string", "size": 64},
            {"key": "original_filename", "type": "string", "size": 255, "xrequired": True},
            {"key": "stored_path", "type": "string", "size": 512, "xrequired": True},
            {"key": "storage_backend", "type": "string", "size": 32, "xdefault": "appwrite"},
            {"key": "storage_bucket_id", "type": "string", "size": 64},
            {"key": "storage_file_id", "type": "string", "size": 64},
            {"key": "file_size_bytes", "type": "integer", "xrequired": True},
            {"key": "mime_type", "type": "string", "size": 127},
            {"key": "share_code", "type": "string", "size": 10},
            {"key": "is_public", "type": "boolean", "xdefault": False},
            {"key": "expires_at", "type": "datetime", "xrequired": True},
            {"key": "created_at", "type": "datetime", "xrequired": True},
            {"key": "updated_at", "type": "datetime"},
            {"key": "downloaded_count", "type": "integer", "xdefault": 0},
        ],
        "indexes": [
            {"key": "idx_shared_files_user_id", "type": "key", "columns": ["user_id"]},
            {"key": "idx_shared_files_folder_id", "type": "key", "columns": ["folder_id"]},
            {"key": "idx_shared_files_user_folder", "type": "key", "columns": ["user_id", "folder_id"]},
            {"key": "idx_shared_files_expires_at", "type": "key", "columns": ["expires_at"]},
            {"key": "idx_shared_files_created_at", "type": "key", "columns": ["created_at"]},
            {"key": "idx_shared_files_storage_file", "type": "key", "columns": ["storage_file_id"]},
            {"key": "idx_shared_files_share_code", "type": "key", "columns": ["share_code"]},
            {"key": "idx_shared_files_is_public", "type": "key", "columns": ["is_public"]},
            {"key": "idx_shared_files_share_code_unique", "type": "unique", "columns": ["share_code"]},
        ],
    },
    {
        "id": "file_folders",
        "name": "file_folders",
        "permissions": [],
        "row_security": True,
        "columns": [
            {"key": "user_id", "type": "string", "size": 64, "xrequired": True},
            {"key": "name", "type": "string", "size": 255, "xrequired": True},
            {"key": "parent_folder_id", "type": "string", "size": 64},
            {"key": "is_public", "type": "boolean", "xdefault": False},
            {"key": "share_code", "type": "string", "size": 10},
            {"key": "order", "type": "integer"},
            {"key": "created_at", "type": "datetime", "xrequired": True},
            {"key": "updated_at", "type": "datetime"},
        ],
        "indexes": [
            {"key": "idx_file_folders_user_id", "type": "key", "columns": ["user_id"]},
            {"key": "idx_file_folders_parent", "type": "key", "columns": ["parent_folder_id"]},
            {"key": "idx_file_folders_user_parent", "type": "key", "columns": ["user_id", "parent_folder_id"]},
            {"key": "idx_file_folders_order", "type": "key", "columns": ["order"]},
            {"key": "idx_file_folders_share_code", "type": "key", "columns": ["share_code"]},
            {"key": "idx_file_folders_is_public", "type": "key", "columns": ["is_public"]},
            {"key": "idx_file_folders_share_code_unique", "type": "unique", "columns": ["share_code"]},
        ],
    },
    {
        "id": "note_folders",
        "name": "note_folders",
        "permissions": [],
        "row_security": True,
        "columns": [
            {"key": "user_id", "type": "string", "size": 64, "xrequired": True},
            {"key": "name", "type": "string", "size": 255, "xrequired": True},
            {"key": "parent_folder_id", "type": "string", "size": 64},
            {"key": "icon", "type": "string", "size": 32},
            {"key": "order", "type": "integer"},
            {"key": "created_at", "type": "datetime", "xrequired": True},
            {"key": "updated_at", "type": "datetime"},
        ],
        "indexes": [
            {"key": "idx_note_folders_user_id", "type": "key", "columns": ["user_id"]},
            {"key": "idx_note_folders_parent", "type": "key", "columns": ["parent_folder_id"]},
            {"key": "idx_note_folders_order", "type": "key", "columns": ["order"]},
        ],
    },
    {
        "id": "notes",
        "name": "notes",
        "permissions": [],
        "row_security": True,
        "columns": [
            {"key": "user_id", "type": "string", "size": 64, "xrequired": True},
            {"key": "folder_id", "type": "string", "size": 64},
            {"key": "title", "type": "string", "size": 255},
            # OFF-PAGE: longtext stores only a 20-byte pointer in the row,
            # supporting up to ~1 billion characters for rich note content.
            {"key": "content", "type": "longtext"},
            {"key": "content_type", "type": "string", "size": 16, "xdefault": "markdown"},
            {"key": "is_pinned", "type": "boolean", "xdefault": False},
            {"key": "is_archived", "type": "boolean", "xdefault": False},
            {"key": "order", "type": "integer"},
            {"key": "created_at", "type": "datetime", "xrequired": True},
            {"key": "updated_at", "type": "datetime"},
        ],
        "indexes": [
            {"key": "idx_notes_user_folder_order", "type": "key", "columns": ["user_id", "folder_id", "order"]},
            {"key": "idx_notes_user_order", "type": "key", "columns": ["user_id", "order"]},
            {"key": "idx_notes_user_pinned", "type": "key", "columns": ["user_id", "is_pinned"]},
            {"key": "idx_notes_user_archived", "type": "key", "columns": ["user_id", "is_archived"]},
        ],
    },
]

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    _require_env()
    client = _init_client()
    tablesdb = TablesDB(client)
    storage = Storage(client)
    database_id = os.environ["APPWRITE_DATABASE_ID"]

    existing_tables = _list_existing_tables(tablesdb, database_id)
    for spec in TABLE_SPECS:
        if spec["id"] in existing_tables:
            logger.info("Table already exists: %s", spec["id"])
            _apply_table(tablesdb, database_id, spec, create_table=False)
        else:
            _apply_table(tablesdb, database_id, spec, create_table=True)
    _ensure_profile_avatar_bucket(storage)
    _ensure_file_share_bucket(storage)
    logger.info("Appwrite database setup complete.")

if __name__ == "__main__":
    main()
