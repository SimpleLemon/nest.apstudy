import logging
import os
import time

from appwrite.client import Client
from appwrite.exception import AppwriteException
from appwrite.permission import Permission
from appwrite.role import Role
from appwrite.services.tables_db import TablesDB
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

    try:
        if attr_type == "string":
            tablesdb.create_varchar_column(
                database_id=database_id,
                table_id=table_id,
                key=key,
                size=spec["size"],
                required=xrequired,
                default=xdefault,
                array=array,
            )
        elif attr_type == "integer":
            tablesdb.create_integer_column(
                database_id=database_id,
                table_id=table_id,
                key=key,
                required=xrequired,
                min=None,
                max=None,
                default=xdefault,
                array=array,
            )
        elif attr_type == "float":
            tablesdb.create_float_column(
                database_id=database_id,
                table_id=table_id,
                key=key,
                required=xrequired,
                min=None,
                max=None,
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
# Main
# ---------------------------------------------------------------------------


def main():
    _require_env()

    client = _init_client()
    tablesdb = TablesDB(client)
    database_id = os.environ["APPWRITE_DATABASE_ID"]

    table_specs = [
        {
            "id": "users",
            "name": "users",
            "permissions": [],
            "row_security": True,
            "columns": [
                {"key": "google_id", "type": "string", "size": 255, "xrequired": True},
                {"key": "email", "type": "email", "xrequired": True},
                {"key": "name", "type": "string", "size": 255},
                {"key": "picture_url", "type": "url"},
                {"key": "school", "type": "string", "size": 255},
                {"key": "major", "type": "string", "size": 255},
                {"key": "graduation_year", "type": "string", "size": 16},
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
                {"key": "other_ical_urls_json", "type": "string", "size": 4096},
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
            "id": "calendar_cache",
            "name": "calendar_cache",
            "permissions": [],
            "row_security": True,
            "columns": [
                {"key": "user_id", "type": "string", "size": 64, "xrequired": True},
                {"key": "event_uid", "type": "string", "size": 255},
                {"key": "event_title", "type": "string", "size": 2048},
                {"key": "event_start", "type": "datetime"},
                {"key": "event_end", "type": "datetime"},
                {"key": "is_all_day", "type": "boolean", "xdefault": False},
                {"key": "event_type", "type": "string", "size": 64},
                {"key": "course_name", "type": "string", "size": 255},
                {"key": "raw_description", "type": "string", "size": 4096},
                {"key": "fetched_at", "type": "datetime"},
            ],
            "indexes": [
                {"key": "idx_calendar_cache_user_id", "type": "key", "columns": ["user_id"]},
                {"key": "idx_calendar_cache_event_start", "type": "key", "columns": ["event_start"]},
                {"key": "idx_calendar_cache_fetched_at", "type": "key", "columns": ["fetched_at"]},
                {"key": "idx_calendar_cache_unique_uid", "type": "unique", "columns": ["user_id", "event_uid"]},
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
                {"key": "description", "type": "string", "size": 4096},
                {"key": "start", "type": "datetime", "xrequired": True},
                {"key": "end", "type": "datetime", "xrequired": True},
                {"key": "is_all_day", "type": "boolean", "xdefault": False},
                {"key": "color", "type": "string", "size": 7},
                {"key": "created_at", "type": "datetime", "xrequired": True},
                {"key": "updated_at", "type": "datetime"},
            ],
            "indexes": [
                {"key": "idx_user_events_user_id", "type": "key", "columns": ["user_id"]},
                {"key": "idx_user_events_start", "type": "key", "columns": ["start"]},
            ],
        },
        {
            "id": "shared_files",
            "name": "shared_files",
            "permissions": [],
            "row_security": True,
            "columns": [
                {"key": "user_id", "type": "string", "size": 64, "xrequired": True},
                {"key": "original_filename", "type": "string", "size": 255, "xrequired": True},
                {"key": "stored_path", "type": "string", "size": 512, "xrequired": True},
                {"key": "file_size_bytes", "type": "integer", "xrequired": True},
                {"key": "mime_type", "type": "string", "size": 127},
                {"key": "share_code", "type": "string", "size": 10},
                {"key": "is_public", "type": "boolean", "xdefault": False},
                {"key": "expires_at", "type": "datetime", "xrequired": True},
                {"key": "created_at", "type": "datetime", "xrequired": True},
                {"key": "downloaded_count", "type": "integer", "xdefault": 0},
            ],
            "indexes": [
                {"key": "idx_shared_files_user_id", "type": "key", "columns": ["user_id"]},
                {"key": "idx_shared_files_expires_at", "type": "key", "columns": ["expires_at"]},
                {"key": "idx_shared_files_created_at", "type": "key", "columns": ["created_at"]},
                {"key": "idx_shared_files_share_code", "type": "key", "columns": ["share_code"]},
                {"key": "idx_shared_files_is_public", "type": "key", "columns": ["is_public"]},
                {"key": "idx_shared_files_share_code_unique", "type": "unique", "columns": ["share_code"]},
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
                {"key": "created_at", "type": "datetime", "xrequired": True},
                {"key": "updated_at", "type": "datetime"},
            ],
            "indexes": [
                {"key": "idx_note_folders_user_id", "type": "key", "columns": ["user_id"]},
                {"key": "idx_note_folders_parent", "type": "key", "columns": ["parent_folder_id"]},
                {"key": "idx_note_folders_unique_user_name", "type": "unique", "columns": ["user_id", "name"]},
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
                {"key": "content", "type": "string", "size": 65535},
                {"key": "created_at", "type": "datetime", "xrequired": True},
                {"key": "updated_at", "type": "datetime"},
            ],
            "indexes": [
                {"key": "idx_notes_user_id", "type": "key", "columns": ["user_id"]},
                {"key": "idx_notes_folder_id", "type": "key", "columns": ["folder_id"]},
                {"key": "idx_notes_created_at", "type": "key", "columns": ["created_at"]},
            ],
        },
    ]

    existing_tables = _list_existing_tables(tablesdb, database_id)
    for spec in table_specs:
        if spec["id"] in existing_tables:
            logger.info("Table already exists: %s", spec["id"])
            _apply_table(tablesdb, database_id, spec, create_table=False)
        else:
            _apply_table(tablesdb, database_id, spec, create_table=True)

    logger.info("Appwrite database setup complete.")


if __name__ == "__main__":
    main()
