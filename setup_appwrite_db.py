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
# Delete helpers
# ---------------------------------------------------------------------------

def _delete_index_if_exists(tablesdb, database_id, table_id, key):
    existing_indexes = _list_indexes(tablesdb, database_id, table_id)
    if key not in existing_indexes:
        return
    try:
        tablesdb.delete_index(
            database_id=database_id,
            table_id=table_id,
            key=key,
        )
        logger.info("Deleted index: %s.%s", table_id, key)
    except AppwriteException as exc:
        if exc.code == 404:
            return
        raise


def _delete_column_if_exists(tablesdb, database_id, table_id, key):
    existing_columns = _list_columns(tablesdb, database_id, table_id)
    if key not in existing_columns:
        return
    try:
        tablesdb.delete_column(
            database_id=database_id,
            table_id=table_id,
            key=key,
        )
        logger.info("Deleted column: %s.%s", table_id, key)
    except AppwriteException as exc:
        if exc.code == 404:
            return
        raise

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
            {"key": "email", "type": "email", "xrequired": True},
            {"key": "name", "type": "string", "size": 255},
            {"key": "username", "type": "string", "size": 32},
            {"key": "picture_url", "type": "url"},
            {"key": "school", "type": "string", "size": 255},
            {"key": "school_key", "type": "string", "size": 255},
            {"key": "school_source", "type": "string", "size": 32},
            {"key": "scorecard_id", "type": "string", "size": 32},
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
            {"key": "idx_users_username", "type": "unique", "columns": ["username"]},
            {"key": "idx_users_school_key", "type": "key", "columns": ["school_key"]},
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
            {"key": "task_sound_enabled", "type": "boolean", "xdefault": True},
            {"key": "chat_sound_enabled", "type": "boolean", "xdefault": True},
            {"key": "language", "type": "string", "size": 16, "xdefault": "en"},
            {"key": "timezone", "type": "string", "size": 64, "xdefault": ""},
            {"key": "dashboard_layout_json", "type": "text"},
            {"key": "dashboard_checklist_hidden_signature", "type": "string", "size": 64},
            {"key": "notes_page_setup_json", "type": "longtext"},
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
        "id": "calendar_shares",
        "name": "calendar_shares",
        "permissions": [],
        "row_security": True,
        "columns": [
            {"key": "user_id", "type": "string", "size": 64, "xrequired": True},
            {"key": "share_code", "type": "string", "size": 16, "xrequired": True},
            {"key": "is_active", "type": "boolean", "xdefault": True},
            {"key": "include_all_calendars", "type": "boolean", "xdefault": True},
            {"key": "calendar_ids_json", "type": "text"},
            {"key": "date_scope", "type": "string", "size": 16, "xdefault": "all"},
            {"key": "fixed_start", "type": "datetime"},
            {"key": "fixed_end", "type": "datetime"},
            {"key": "rolling_days", "type": "integer"},
            {"key": "created_at", "type": "datetime", "xrequired": True},
            {"key": "updated_at", "type": "datetime"},
        ],
        "indexes": [
            {"key": "idx_calendar_shares_user", "type": "key", "columns": ["user_id"]},
            {"key": "idx_calendar_shares_code", "type": "key", "columns": ["share_code"]},
            {"key": "idx_calendar_shares_active", "type": "key", "columns": ["is_active"]},
            {"key": "idx_calendar_shares_code_unique", "type": "unique", "columns": ["share_code"]},
        ],
    },
    {
        "id": "daily_quotes",
        "name": "daily_quotes",
        "permissions": [],
        "row_security": True,
        "columns": [
            {"key": "quote_date", "type": "string", "size": 10, "xrequired": True},
            {"key": "quote_text", "type": "text", "xrequired": True},
            {"key": "author", "type": "string", "size": 255},
            {"key": "source", "type": "string", "size": 32, "xdefault": "zenquotes"},
            {"key": "source_url", "type": "string", "size": 2048},
            {"key": "raw_payload", "type": "text"},
            {"key": "fetched_at", "type": "datetime"},
            {"key": "created_at", "type": "datetime", "xrequired": True},
            {"key": "updated_at", "type": "datetime"},
        ],
        "indexes": [
            {"key": "idx_daily_quotes_date", "type": "unique", "columns": ["quote_date"]},
            {"key": "idx_daily_quotes_fetched_at", "type": "key", "columns": ["fetched_at"]},
        ],
    },
    {
        "id": "task_lists",
        "name": "task_lists",
        "permissions": [],
        "row_security": True,
        "columns": [
            {"key": "user_id", "type": "string", "size": 64, "xrequired": True},
            {"key": "name", "type": "string", "size": 120, "xrequired": True},
            {"key": "description", "type": "text"},
            {"key": "order", "type": "integer"},
            {"key": "collapsed", "type": "boolean", "xdefault": False},
            {"key": "hidden", "type": "boolean", "xdefault": False},
            {"key": "sort_mode", "type": "string", "size": 16, "xdefault": "default"},
            {"key": "created_at", "type": "datetime", "xrequired": True},
            {"key": "updated_at", "type": "datetime"},
        ],
        "indexes": [
            {"key": "idx_task_lists_user", "type": "key", "columns": ["user_id"]},
            {"key": "idx_task_lists_user_hidden", "type": "key", "columns": ["user_id", "hidden"]},
            {"key": "idx_task_lists_order", "type": "key", "columns": ["order"]},
        ],
    },
    {
        "id": "tasks",
        "name": "tasks",
        "permissions": [],
        "row_security": True,
        "columns": [
            {"key": "user_id", "type": "string", "size": 64, "xrequired": True},
            {"key": "list_id", "type": "string", "size": 64, "xrequired": True},
            {"key": "title", "type": "string", "size": 255, "xrequired": True},
            {"key": "priority", "type": "string", "size": 16, "xdefault": "none"},
            {"key": "deadline_at", "type": "datetime"},
            {"key": "deadline_time", "type": "string", "size": 5},
            {"key": "timezone", "type": "string", "size": 64},
            {"key": "recurrence_json", "type": "text"},
            {"key": "order", "type": "integer"},
            {"key": "completed", "type": "boolean", "xdefault": False},
            {"key": "completed_at", "type": "datetime"},
            {"key": "starred", "type": "boolean", "xdefault": False},
            {"key": "created_at", "type": "datetime", "xrequired": True},
            {"key": "updated_at", "type": "datetime"},
        ],
        "indexes": [
            {"key": "idx_tasks_user", "type": "key", "columns": ["user_id"]},
            {"key": "idx_tasks_list", "type": "key", "columns": ["list_id"]},
            {"key": "idx_tasks_user_list", "type": "key", "columns": ["user_id", "list_id"]},
            {"key": "idx_tasks_user_starred", "type": "key", "columns": ["user_id", "starred"]},
            {"key": "idx_tasks_deadline", "type": "key", "columns": ["deadline_at"]},
            {"key": "idx_tasks_order", "type": "key", "columns": ["order"]},
        ],
    },
    {
        "id": "task_completions",
        "name": "task_completions",
        "permissions": [],
        "row_security": True,
        "columns": [
            {"key": "user_id", "type": "string", "size": 64, "xrequired": True},
            {"key": "task_id", "type": "string", "size": 64, "xrequired": True},
            {"key": "occurrence_key", "type": "string", "size": 64, "xrequired": True},
            {"key": "completed_at", "type": "datetime", "xrequired": True},
        ],
        "indexes": [
            {"key": "idx_task_completions_user", "type": "key", "columns": ["user_id"]},
            {"key": "idx_task_completions_task", "type": "key", "columns": ["task_id"]},
            {"key": "idx_task_completions_occurrence", "type": "key", "columns": ["occurrence_key"]},
            {"key": "idx_task_completions_unique", "type": "unique", "columns": ["user_id", "task_id", "occurrence_key"]},
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
            {"key": "page_setup_json", "type": "longtext"},
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
    {
        "id": "chat_channels",
        "name": "chat_channels",
        "permissions": [],
        "row_security": True,
        "columns": [
            {"key": "kind", "type": "string", "size": 32, "xrequired": True},
            {"key": "name", "type": "string", "size": 120, "xrequired": True},
            {"key": "label", "type": "string", "size": 160},
            {"key": "section", "type": "string", "size": 32, "xdefault": "nest"},
            {"key": "school_key", "type": "string", "size": 255},
            {"key": "school_name", "type": "string", "size": 255},
            {"key": "discord_channel_id", "type": "string", "size": 32},
            {"key": "read_only", "type": "boolean", "xdefault": False},
            {"key": "approved", "type": "boolean", "xdefault": True},
            {"key": "created_at", "type": "datetime", "xrequired": True},
            {"key": "updated_at", "type": "datetime"},
        ],
        "indexes": [
            {"key": "idx_chat_channels_kind", "type": "key", "columns": ["kind"]},
            {"key": "idx_chat_channels_school", "type": "key", "columns": ["school_key"]},
            {"key": "idx_chat_channels_discord", "type": "key", "columns": ["discord_channel_id"]},
            {"key": "idx_chat_channels_approved", "type": "key", "columns": ["approved"]},
        ],
    },
    {
        "id": "chat_messages",
        "name": "chat_messages",
        "permissions": [],
        "row_security": True,
        "columns": [
            {"key": "channel_id", "type": "string", "size": 64},
            {"key": "thread_id", "type": "string", "size": 64},
            {"key": "source", "type": "string", "size": 32, "xdefault": "appwrite"},
            {"key": "external_id", "type": "string", "size": 255},
            {"key": "user_id", "type": "string", "size": 64},
            {"key": "author_name", "type": "string", "size": 120},
            {"key": "author_username", "type": "string", "size": 64},
            {"key": "author_avatar_url", "type": "string", "size": 2048},
            {"key": "content", "type": "longtext"},
            {"key": "rendered_html", "type": "longtext"},
            {"key": "link_preview_json", "type": "text"},
            {"key": "discord_message_id", "type": "string", "size": 32},
            {"key": "discord_webhook_id", "type": "string", "size": 32},
            {"key": "created_at", "type": "datetime", "xrequired": True},
            {"key": "updated_at", "type": "datetime"},
            {"key": "deleted_at", "type": "datetime"},
            {"key": "deleted_by", "type": "string", "size": 64},
        ],
        "indexes": [
            {"key": "idx_chat_messages_channel", "type": "key", "columns": ["channel_id"]},
            {"key": "idx_chat_messages_thread", "type": "key", "columns": ["thread_id"]},
            {"key": "idx_chat_messages_user", "type": "key", "columns": ["user_id"]},
            {"key": "idx_chat_messages_created", "type": "key", "columns": ["created_at"]},
            {"key": "idx_chat_messages_external", "type": "key", "columns": ["external_id"]},
        ],
    },
    {
        "id": "chat_dm_threads",
        "name": "chat_dm_threads",
        "permissions": [],
        "row_security": True,
        "columns": [
            {"key": "participant_a", "type": "string", "size": 64, "xrequired": True},
            {"key": "participant_b", "type": "string", "size": 64, "xrequired": True},
            {"key": "participant_key", "type": "string", "size": 140, "xrequired": True},
            {"key": "last_message_at", "type": "datetime"},
            {"key": "created_at", "type": "datetime", "xrequired": True},
            {"key": "updated_at", "type": "datetime"},
        ],
        "indexes": [
            {"key": "idx_chat_dm_participant_a", "type": "key", "columns": ["participant_a"]},
            {"key": "idx_chat_dm_participant_b", "type": "key", "columns": ["participant_b"]},
            {"key": "idx_chat_dm_participant_key", "type": "unique", "columns": ["participant_key"]},
            {"key": "idx_chat_dm_last_message", "type": "key", "columns": ["last_message_at"]},
        ],
    },
    {
        "id": "chat_blocks",
        "name": "chat_blocks",
        "permissions": [],
        "row_security": True,
        "columns": [
            {"key": "blocker_id", "type": "string", "size": 64, "xrequired": True},
            {"key": "blocked_id", "type": "string", "size": 64, "xrequired": True},
            {"key": "block_key", "type": "string", "size": 140, "xrequired": True},
            {"key": "created_at", "type": "datetime", "xrequired": True},
        ],
        "indexes": [
            {"key": "idx_chat_blocks_blocker", "type": "key", "columns": ["blocker_id"]},
            {"key": "idx_chat_blocks_blocked", "type": "key", "columns": ["blocked_id"]},
            {"key": "idx_chat_blocks_key", "type": "unique", "columns": ["block_key"]},
        ],
    },
    {
        "id": "chat_presence",
        "name": "chat_presence",
        "permissions": [],
        "row_security": True,
        "columns": [
            {"key": "user_id", "type": "string", "size": 64, "xrequired": True},
            {"key": "scope_type", "type": "string", "size": 16, "xrequired": True},
            {"key": "scope_id", "type": "string", "size": 64, "xrequired": True},
            {"key": "presence_key", "type": "string", "size": 160, "xrequired": True},
            {"key": "last_seen_at", "type": "datetime", "xrequired": True},
        ],
        "indexes": [
            {"key": "idx_chat_presence_scope", "type": "key", "columns": ["scope_type", "scope_id"]},
            {"key": "idx_chat_presence_user", "type": "key", "columns": ["user_id"]},
            {"key": "idx_chat_presence_seen", "type": "key", "columns": ["last_seen_at"]},
            {"key": "idx_chat_presence_key", "type": "unique", "columns": ["presence_key"]},
        ],
    },
    {
        "id": "chat_read_states",
        "name": "chat_read_states",
        "permissions": [],
        "row_security": True,
        "columns": [
            {"key": "user_id", "type": "string", "size": 64, "xrequired": True},
            {"key": "scope_type", "type": "string", "size": 16, "xrequired": True},
            {"key": "scope_id", "type": "string", "size": 64, "xrequired": True},
            {"key": "read_key", "type": "string", "size": 160, "xrequired": True},
            {"key": "last_read_message_id", "type": "string", "size": 64},
            {"key": "last_read_at", "type": "datetime"},
        ],
        "indexes": [
            {"key": "idx_chat_read_user", "type": "key", "columns": ["user_id"]},
            {"key": "idx_chat_read_scope", "type": "key", "columns": ["scope_type", "scope_id"]},
            {"key": "idx_chat_read_key", "type": "unique", "columns": ["read_key"]},
        ],
    },
    {
        "id": "chat_events",
        "name": "chat_events",
        "permissions": [],
        "row_security": True,
        "columns": [
            {"key": "scope_type", "type": "string", "size": 32, "xrequired": True},
            {"key": "scope_id", "type": "string", "size": 160, "xrequired": True},
            {"key": "event_type", "type": "string", "size": 64, "xrequired": True},
            {"key": "message_id", "type": "string", "size": 64},
            {"key": "thread_id", "type": "string", "size": 64},
            {"key": "channel_id", "type": "string", "size": 64},
            {"key": "actor_id", "type": "string", "size": 64},
            {"key": "created_at", "type": "datetime", "xrequired": True},
        ],
        "indexes": [
            {"key": "idx_chat_events_scope", "type": "key", "columns": ["scope_type", "scope_id"]},
            {"key": "idx_chat_events_type", "type": "key", "columns": ["event_type"]},
            {"key": "idx_chat_events_created", "type": "key", "columns": ["created_at"]},
            {"key": "idx_chat_events_actor", "type": "key", "columns": ["actor_id"]},
        ],
    },
    {
        "id": "chat_link_previews",
        "name": "chat_link_previews",
        "permissions": [],
        "row_security": True,
        "columns": [
            {"key": "url_hash", "type": "string", "size": 64, "xrequired": True},
            {"key": "url", "type": "string", "size": 2048, "xrequired": True},
            {"key": "title", "type": "string", "size": 255},
            {"key": "description", "type": "string", "size": 512},
            {"key": "image_url", "type": "string", "size": 2048},
            {"key": "site_name", "type": "string", "size": 255},
            {"key": "content_type", "type": "string", "size": 128},
            {"key": "created_at", "type": "datetime", "xrequired": True},
            {"key": "updated_at", "type": "datetime"},
        ],
        "indexes": [
            {"key": "idx_chat_link_hash", "type": "unique", "columns": ["url_hash"]},
        ],
    },
    {
        "id": "chat_bridge_config",
        "name": "chat_bridge_config",
        "permissions": [],
        "row_security": True,
        "columns": [
            {"key": "config_key", "type": "string", "size": 120, "xrequired": True},
            {"key": "config_value", "type": "text"},
            {"key": "created_at", "type": "datetime", "xrequired": True},
            {"key": "updated_at", "type": "datetime"},
        ],
        "indexes": [
            {"key": "idx_chat_bridge_config_key", "type": "unique", "columns": ["config_key"]},
        ],
    },
    {
        "id": "admin_requests",
        "name": "admin_requests",
        "permissions": [],
        "row_security": True,
        "columns": [
            {"key": "request_type", "type": "string", "size": 64, "xrequired": True},
            {"key": "label", "type": "string", "size": 160, "xrequired": True},
            {"key": "status", "type": "string", "size": 32, "xdefault": "pending"},
            {"key": "school_key", "type": "string", "size": 255},
            {"key": "school_name", "type": "string", "size": 255},
            {"key": "requested_by", "type": "string", "size": 64},
            {"key": "request_count", "type": "integer", "xdefault": 1},
            {"key": "last_requested_at", "type": "datetime"},
            {"key": "resolved_by", "type": "string", "size": 64},
            {"key": "resolved_at", "type": "datetime"},
            {"key": "created_at", "type": "datetime", "xrequired": True},
            {"key": "updated_at", "type": "datetime"},
        ],
        "indexes": [
            {"key": "idx_admin_requests_type", "type": "key", "columns": ["request_type"]},
            {"key": "idx_admin_requests_status", "type": "key", "columns": ["status"]},
            {"key": "idx_admin_requests_school", "type": "key", "columns": ["school_key"]},
            {"key": "idx_admin_requests_created", "type": "key", "columns": ["created_at"]},
        ],
    },
]

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def _cleanup_users_table(tablesdb, database_id):
    table_id = "users"
    _delete_index_if_exists(tablesdb, database_id, table_id, "idx_users_public_user_id")
    _delete_column_if_exists(tablesdb, database_id, table_id, "public_user_id")

def main():
    _require_env()
    client = _init_client()
    tablesdb = TablesDB(client)
    storage = Storage(client)
    database_id = os.environ["APPWRITE_DATABASE_ID"]

    existing_tables = _list_existing_tables(tablesdb, database_id)
    if "users" in existing_tables:
        _cleanup_users_table(tablesdb, database_id)
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
