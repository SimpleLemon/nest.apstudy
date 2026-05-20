import logging
from datetime import datetime, timezone

from appwrite.exception import AppwriteException
from appwrite.query import Query

from appwrite_client import tablesdb, DATABASE_ID


logger = logging.getLogger(__name__)
DEFAULT_LIMIT = 100


def _row_to_dict(row):
    if isinstance(row, dict):
        return row

    if hasattr(row, "to_dict"):
        value = row.to_dict()
    elif hasattr(row, "model_dump"):
        value = row.model_dump(by_alias=True, mode="json")
    else:
        return row

    data = value.pop("data", None)
    if isinstance(data, dict):
        value.update(data)
    return value


def _row_list_to_dict(response):
    if isinstance(response, dict):
        rows = response.get("rows", [])
        value = {
            **response,
            "rows": [_row_to_dict(row) for row in rows],
        }
        return value

    if hasattr(response, "to_dict"):
        value = response.to_dict()
    elif hasattr(response, "model_dump"):
        value = response.model_dump(by_alias=True, mode="json")
    else:
        return response

    rows = getattr(response, "rows", value.get("rows", []))
    value["rows"] = [_row_to_dict(row) for row in rows]
    return value


def format_datetime(value):
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        else:
            value = value.astimezone(timezone.utc)
        return value.isoformat().replace("+00:00", "Z")
    return str(value)


def parse_datetime(value):
    if not value:
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        text = value
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        try:
            return datetime.fromisoformat(text)
        except ValueError:
            return None
    return None


class AppwriteRepository:
    def __init__(self, tables_db, database_id):
        self.tablesdb = tables_db
        self.database_id = database_id

    def _require_configured(self):
        if self.tablesdb is None or not self.database_id:
            raise AttributeError("Appwrite TablesDB list_rows is not configured.")

    def list_rows(self, table_id, queries=None):
        self._require_configured()
        return _row_list_to_dict(
            self.tablesdb.list_rows(
                database_id=self.database_id,
                table_id=table_id,
                queries=queries or [],
            )
        )

    def get_row(self, table_id, row_id, *, allow_missing=False):
        self._require_configured()
        try:
            return _row_to_dict(
                self.tablesdb.get_row(
                    database_id=self.database_id,
                    table_id=table_id,
                    row_id=row_id,
                )
            )
        except AppwriteException as exc:
            status_code = getattr(exc, "code", None)
            if status_code is None:
                status_code = getattr(exc, "response_code", None)
            if allow_missing and int(status_code or 0) == 404:
                return None
            raise

    def create_row(self, table_id, row_id, data, permissions=None):
        self._require_configured()
        return _row_to_dict(
            self.tablesdb.create_row(
                database_id=self.database_id,
                table_id=table_id,
                row_id=row_id,
                data=data,
                permissions=permissions,
            )
        )

    def update_row(self, table_id, row_id, data, permissions=None):
        self._require_configured()
        return _row_to_dict(
            self.tablesdb.update_row(
                database_id=self.database_id,
                table_id=table_id,
                row_id=row_id,
                data=data,
                permissions=permissions,
            )
        )

    def delete_row(self, table_id, row_id):
        self._require_configured()
        self.tablesdb.delete_row(
            database_id=self.database_id,
            table_id=table_id,
            row_id=row_id,
        )


DEFAULT_REPOSITORY = AppwriteRepository(tablesdb, DATABASE_ID)


def list_rows_safe(table_id, queries=None):
    try:
        return DEFAULT_REPOSITORY.list_rows(table_id, queries)
    except AppwriteException as exc:
        logger.exception("Appwrite list_rows failed: %s", table_id)
        raise


def list_rows_all(table_id, queries=None, limit=DEFAULT_LIMIT):
    rows = []
    offset = 0
    while True:
        query_list = list(queries or [])
        query_list.append(Query.limit(limit))
        query_list.append(Query.offset(offset))
        response = list_rows_safe(table_id, query_list)
        batch = response.get("rows", [])
        rows.extend(batch)
        if len(batch) < limit:
            break
        offset += limit
    return rows


def get_row_safe(table_id, row_id, *, allow_missing=False):
    try:
        return DEFAULT_REPOSITORY.get_row(table_id, row_id, allow_missing=allow_missing)
    except AppwriteException as exc:
        logger.exception("Appwrite get_row failed: %s", table_id)
        raise


def create_row_safe(table_id, row_id, data, permissions=None):
    try:
        return DEFAULT_REPOSITORY.create_row(table_id, row_id, data, permissions)
    except AppwriteException as exc:
        logger.exception("Appwrite create_row failed: %s", table_id)
        raise


def update_row_safe(table_id, row_id, data, permissions=None):
    try:
        return DEFAULT_REPOSITORY.update_row(table_id, row_id, data, permissions)
    except AppwriteException as exc:
        logger.exception("Appwrite update_row failed: %s", table_id)
        raise


def delete_row_safe(table_id, row_id):
    try:
        DEFAULT_REPOSITORY.delete_row(table_id, row_id)
    except AppwriteException as exc:
        logger.exception("Appwrite delete_row failed: %s", table_id)
        raise


def delete_rows_by_query(table_id, queries):
    rows = list_rows_all(table_id, queries=queries)
    for row in rows:
        row_id = row.get("$id") or row.get("id")
        if row_id:
            delete_row_safe(table_id, row_id)
    return len(rows)


def first_row(table_id, queries=None):
    query_list = list(queries or [])
    query_list.append(Query.limit(1))
    response = list_rows_safe(table_id, query_list)
    rows = response.get("rows", [])
    return rows[0] if rows else None
