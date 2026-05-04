import logging
import os
import time

from appwrite.client import Client
from appwrite.exception import AppwriteException
from appwrite.permission import Permission
from appwrite.role import Role
from appwrite.services.databases import Databases
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


def _wait_for_attribute(databases, database_id, collection_id, key, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            attribute = databases.get_attribute(
                database_id=database_id,
                collection_id=collection_id,
                key=key,
            )
        except AppwriteException:
            time.sleep(0.5)
            continue

        if attribute.get("status") == "available":
            return

        time.sleep(0.5)

    logger.warning(
        "Attribute %s on %s not available after %ss",
        key,
        collection_id,
        timeout,
    )


def _wait_for_index(databases, database_id, collection_id, key, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            index = databases.get_index(
                database_id=database_id,
                collection_id=collection_id,
                key=key,
            )
        except AppwriteException:
            time.sleep(0.5)
            continue

        if index.get("status") == "available":
            return

        time.sleep(0.5)

    logger.warning(
        "Index %s on %s not available after %ss",
        key,
        collection_id,
        timeout,
    )


def _list_existing(databases, database_id):
    response = databases.list_collections(database_id=database_id)
    return {collection["$id"]: collection for collection in response.get("collections", [])}


def _list_attributes(databases, database_id, collection_id):
    try:
        response = databases.list_attributes(
            database_id=database_id,
            collection_id=collection_id,
        )
    except AppwriteException:
        return set()

    return {attribute["key"] for attribute in response.get("attributes", [])}


def _list_indexes(databases, database_id, collection_id):
    try:
        response = databases.list_indexes(
            database_id=database_id,
            collection_id=collection_id,
        )
    except AppwriteException:
        return set()

    return {index["key"] for index in response.get("indexes", [])}


def _ensure_collection(databases, database_id, collection_id, name, permissions, document_security):
    try:
        databases.create_collection(
            database_id=database_id,
            collection_id=collection_id,
            name=name,
            permissions=permissions,
            document_security=document_security,
            enabled=True,
        )
        logger.info("Created collection: %s", collection_id)
    except AppwriteException as exc:
        if exc.code == 409:
            logger.info("Collection exists: %s", collection_id)
            return
        raise


def _ensure_attribute(databases, database_id, collection_id, existing_attrs, spec):
    key = spec["key"]
    if key in existing_attrs:
        return

    attr_type = spec["type"]
    required = spec.get("required", False)
    default = spec.get("default")
    array = spec.get("array", False)

    try:
        if attr_type == "string":
            databases.create_string_attribute(
                database_id=database_id,
                collection_id=collection_id,
                key=key,
                size=spec["size"],
                required=required,
                default=default,
                array=array,
            )
        elif attr_type == "integer":
            databases.create_integer_attribute(
                database_id=database_id,
                collection_id=collection_id,
                key=key,
                required=required,
                min=None,
                max=None,
                default=default,
                array=array,
            )
        elif attr_type == "float":
            databases.create_float_attribute(
                database_id=database_id,
                collection_id=collection_id,
                key=key,
                required=required,
                min=None,
                max=None,
                default=default,
                array=array,
            )
        elif attr_type == "boolean":
            databases.create_boolean_attribute(
                database_id=database_id,
                collection_id=collection_id,
                key=key,
                required=required,
                default=default,
                array=array,
            )
        elif attr_type == "datetime":
            databases.create_datetime_attribute(
                database_id=database_id,
                collection_id=collection_id,
                key=key,
                required=required,
                default=default,
                array=array,
            )
        elif attr_type == "email":
            databases.create_email_attribute(
                database_id=database_id,
                collection_id=collection_id,
                key=key,
                required=required,
                default=default,
                array=array,
            )
        elif attr_type == "url":
            databases.create_url_attribute(
                database_id=database_id,
                collection_id=collection_id,
                key=key,
                required=required,
                default=default,
                array=array,
            )
        else:
            raise ValueError(f"Unknown attribute type: {attr_type}")
    except AppwriteException as exc:
        if exc.code == 409:
            return
        raise

    _wait_for_attribute(databases, database_id, collection_id, key)
    existing_attrs.add(key)


def _ensure_index(databases, database_id, collection_id, existing_indexes, spec):
    key = spec["key"]
    if key in existing_indexes:
        return

    try:
        databases.create_index(
            database_id=database_id,
            collection_id=collection_id,
            key=key,
            type=spec["type"],
            attributes=spec["attributes"],
            orders=spec.get("orders"),
        )
    except AppwriteException as exc:
        if exc.code == 409:
            return
        raise

    _wait_for_index(databases, database_id, collection_id, key)
    existing_indexes.add(key)


def _apply_collection(databases, database_id, spec, create_collection=True):
    collection_id = spec["id"]
    if create_collection:
        _ensure_collection(
            databases,
            database_id,
            collection_id=collection_id,
            name=spec["name"],
            permissions=spec["permissions"],
            document_security=spec["document_security"],
        )

    existing_attrs = _list_attributes(databases, database_id, collection_id)
    for attr_spec in spec["attributes"]:
        _ensure_attribute(databases, database_id, collection_id, existing_attrs, attr_spec)

    existing_indexes = _list_indexes(databases, database_id, collection_id)
    for index_spec in spec["indexes"]:
        _ensure_index(databases, database_id, collection_id, existing_indexes, index_spec)


def main():
    _require_env()

    client = _init_client()
    databases = Databases(client)
    database_id = os.environ["APPWRITE_DATABASE_ID"]

    collection_specs = [
        {
            "id": "users",
            "name": "users",
            "permissions": [],
            "document_security": True,
            "attributes": [
                {"key": "google_id", "type": "string", "size": 255, "required": True},
                {"key": "email", "type": "email", "required": True},
                {"key": "name", "type": "string", "size": 255},
                {"key": "picture_url", "type": "url"},
                {"key": "onboarding_complete", "type": "boolean", "required": True, "default": False},
                {"key": "onboarding_step", "type": "integer", "required": True, "default": 1},
                {"key": "education_level", "type": "string", "size": 32},
                {"key": "class_year", "type": "string", "size": 64},
                {"key": "emory_student", "type": "boolean"},
                {"key": "emory_email", "type": "email"},
                {"key": "created_at", "type": "datetime", "required": True},
                {"key": "last_login", "type": "datetime"},
            ],
            "indexes": [
                {"key": "idx_users_google_id", "type": "unique", "attributes": ["google_id"]},
                {"key": "idx_users_email", "type": "unique", "attributes": ["email"]},
            ],
        },
        {
            "id": "user_settings",
            "name": "user_settings",
            "permissions": [],
            "document_security": True,
            "attributes": [
                {"key": "user_id", "type": "string", "size": 64, "required": True},
                {"key": "canvas_ical_url", "type": "url"},
                {"key": "other_ical_urls_json", "type": "string", "size": 4096},
                {"key": "ics_secret_token", "type": "string", "size": 255},
                {"key": "feed_refresh_minutes", "type": "integer", "required": True, "default": 15},
                {"key": "preferred_calendar_view", "type": "string", "size": 16, "required": True, "default": "week"},
                {"key": "interface_theme", "type": "string", "size": 32, "default": "system-match"},
                {"key": "created_at", "type": "datetime", "required": True},
                {"key": "updated_at", "type": "datetime"},
            ],
            "indexes": [
                {"key": "idx_user_settings_user_id", "type": "unique", "attributes": ["user_id"]},
                {"key": "idx_user_settings_user_id_key", "type": "key", "attributes": ["user_id"]},
                {"key": "idx_user_settings_token", "type": "unique", "attributes": ["ics_secret_token"]},
            ],
        },
        {
            "id": "user_courses",
            "name": "user_courses",
            "permissions": [],
            "document_security": True,
            "attributes": [
                {"key": "user_id", "type": "string", "size": 64, "required": True},
                {"key": "term", "type": "string", "size": 64, "required": True},
                {"key": "subject", "type": "string", "size": 64, "required": True},
                {"key": "catalog", "type": "string", "size": 64, "required": True},
                {"key": "course_name", "type": "string", "size": 255},
                {"key": "section_number", "type": "string", "size": 64},
                {"key": "instructor_name", "type": "string", "size": 255},
                {"key": "source", "type": "string", "size": 32, "required": True, "default": "settings"},
                {"key": "crn", "type": "string", "size": 64},
                {"key": "added_at", "type": "datetime", "required": True},
            ],
            "indexes": [
                {"key": "idx_user_courses_user_id", "type": "key", "attributes": ["user_id"]},
                {"key": "idx_user_courses_term", "type": "key", "attributes": ["term"]},
                {"key": "idx_user_courses_subject", "type": "key", "attributes": ["subject"]},
                {"key": "idx_user_courses_catalog", "type": "key", "attributes": ["catalog"]},
                {"key": "idx_user_courses_crn", "type": "key", "attributes": ["crn"]},
                {"key": "idx_user_courses_source", "type": "key", "attributes": ["source"]},
                {
                    "key": "idx_user_courses_unique",
                    "type": "unique",
                    "attributes": ["user_id", "term", "subject", "catalog", "crn"],
                },
            ],
        },
        {
            "id": "calendar_cache",
            "name": "calendar_cache",
            "permissions": [],
            "document_security": True,
            "attributes": [
                {"key": "user_id", "type": "string", "size": 64, "required": True},
                {"key": "event_uid", "type": "string", "size": 255},
                {"key": "event_title", "type": "string", "size": 2048},
                {"key": "event_start", "type": "datetime"},
                {"key": "event_end", "type": "datetime"},
                {"key": "is_all_day", "type": "boolean", "required": True, "default": False},
                {"key": "event_type", "type": "string", "size": 64},
                {"key": "course_name", "type": "string", "size": 255},
                {"key": "raw_description", "type": "string", "size": 4096},
                {"key": "fetched_at", "type": "datetime"},
            ],
            "indexes": [
                {"key": "idx_calendar_cache_user_id", "type": "key", "attributes": ["user_id"]},
                {"key": "idx_calendar_cache_event_start", "type": "key", "attributes": ["event_start"]},
                {"key": "idx_calendar_cache_fetched_at", "type": "key", "attributes": ["fetched_at"]},
                {
                    "key": "idx_calendar_cache_unique_uid",
                    "type": "unique",
                    "attributes": ["user_id", "event_uid"],
                },
            ],
        },
        {
            "id": "user_calendar_preferences",
            "name": "user_calendar_preferences",
            "permissions": [],
            "document_security": True,
            "attributes": [
                {"key": "user_id", "type": "string", "size": 64, "required": True},
                {"key": "calendar_name", "type": "string", "size": 255, "required": True},
                {"key": "color_hex", "type": "string", "size": 7, "required": True, "default": "#6366f1"},
                {"key": "visible", "type": "boolean", "required": True, "default": True},
                {"key": "created_at", "type": "datetime", "required": True},
                {"key": "updated_at", "type": "datetime"},
            ],
            "indexes": [
                {"key": "idx_user_calendar_prefs_user_id", "type": "key", "attributes": ["user_id"]},
                {"key": "idx_user_calendar_prefs_name", "type": "key", "attributes": ["calendar_name"]},
                {
                    "key": "idx_user_calendar_prefs_unique",
                    "type": "unique",
                    "attributes": ["user_id", "calendar_name"],
                },
            ],
        },
        {
            "id": "user_events",
            "name": "user_events",
            "permissions": [],
            "document_security": True,
            "attributes": [
                {"key": "user_id", "type": "string", "size": 64, "required": True},
                {"key": "title", "type": "string", "size": 255, "required": True},
                {"key": "description", "type": "string", "size": 4096},
                {"key": "start", "type": "datetime", "required": True},
                {"key": "end", "type": "datetime", "required": True},
                {"key": "is_all_day", "type": "boolean", "required": True, "default": False},
                {"key": "color", "type": "string", "size": 7},
                {"key": "created_at", "type": "datetime", "required": True},
                {"key": "updated_at", "type": "datetime"},
            ],
            "indexes": [
                {"key": "idx_user_events_user_id", "type": "key", "attributes": ["user_id"]},
                {"key": "idx_user_events_start", "type": "key", "attributes": ["start"]},
            ],
        },
        {
            "id": "shared_files",
            "name": "shared_files",
            "permissions": [],
            "document_security": True,
            "attributes": [
                {"key": "user_id", "type": "string", "size": 64, "required": True},
                {"key": "original_filename", "type": "string", "size": 255, "required": True},
                {"key": "stored_path", "type": "string", "size": 512, "required": True},
                {"key": "file_size_bytes", "type": "integer", "required": True},
                {"key": "mime_type", "type": "string", "size": 127},
                {"key": "share_code", "type": "string", "size": 10},
                {"key": "is_public", "type": "boolean", "required": True, "default": False},
                {"key": "expires_at", "type": "datetime", "required": True},
                {"key": "created_at", "type": "datetime", "required": True},
                {"key": "downloaded_count", "type": "integer", "required": True, "default": 0},
            ],
            "indexes": [
                {"key": "idx_shared_files_user_id", "type": "key", "attributes": ["user_id"]},
                {"key": "idx_shared_files_expires_at", "type": "key", "attributes": ["expires_at"]},
                {"key": "idx_shared_files_created_at", "type": "key", "attributes": ["created_at"]},
                {"key": "idx_shared_files_share_code", "type": "key", "attributes": ["share_code"]},
                {"key": "idx_shared_files_is_public", "type": "key", "attributes": ["is_public"]},
                {"key": "idx_shared_files_share_code_unique", "type": "unique", "attributes": ["share_code"]},
            ],
        },
    ]

    existing_collections = _list_existing(databases, database_id)
    for spec in collection_specs:
        if spec["id"] in existing_collections:
            logger.info("Collection already exists: %s", spec["id"])
            _apply_collection(databases, database_id, spec, create_collection=False)
        else:
            _apply_collection(databases, database_id, spec, create_collection=True)

    logger.info("Appwrite database setup complete.")


if __name__ == "__main__":
    main()
