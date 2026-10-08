import logging
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Literal, Mapping, Sequence, overload

from appwrite.exception import AppwriteException
from appwrite.query import Query
from appwrite.services.tables_db import TablesDB

from appwrite_client import tablesdb, DATABASE_ID
from services import database as sqlite_database
from services.database import Queries, RowListResponse, RowMapping
from services.row_utils import row_to_dict as _row_to_dict


logger = logging.getLogger(__name__)
DEFAULT_LIMIT = 100


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


def format_datetime(value: object) -> str | None:
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


def parse_datetime(value: object) -> datetime | None:
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
    def __init__(self, tables_db: TablesDB | None, database_id: str | None) -> None:
        self.tablesdb = tables_db
        self.database_id = database_id

    def _require_configured(self) -> None:
        if self.tablesdb is None or not self.database_id:
            raise AttributeError("Appwrite TablesDB list_rows is not configured.")

    def list_rows(self, table_id: str, queries: Queries | None = None) -> RowListResponse:
        self._require_configured()
        return _row_list_to_dict(
            self.tablesdb.list_rows(
                database_id=self.database_id,
                table_id=table_id,
                queries=queries or [],
            )
        )

    @overload
    def get_row(
        self, table_id: str, row_id: str, *, allow_missing: Literal[False] = False,
    ) -> RowMapping: ...

    @overload
    def get_row(
        self, table_id: str, row_id: str, *, allow_missing: bool,
    ) -> RowMapping | None: ...

    def get_row(self, table_id: str, row_id: str, *, allow_missing: bool = False) -> RowMapping | None:
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

    def create_row(
        self, table_id: str, row_id: str, data: RowMapping,
        permissions: Sequence[str] | None = None,
    ) -> RowMapping:
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

    def update_row(
        self, table_id: str, row_id: str, data: RowMapping,
        permissions: Sequence[str] | None = None,
    ) -> RowMapping:
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

    def delete_row(self, table_id: str, row_id: str) -> None:
        self._require_configured()
        self.tablesdb.delete_row(
            database_id=self.database_id,
            table_id=table_id,
            row_id=row_id,
        )


APPWRITE_REPOSITORY = AppwriteRepository(tablesdb, DATABASE_ID)


@contextmanager
def _sqlite_boundary(operation: str, table_id: str):
    """Log database failures once while retaining the original traceback."""
    try:
        yield
    except AppwriteException:
        logger.exception("SQLite %s failed: %s", operation, table_id)
        raise


def list_rows_safe(table_id: str, queries: Queries | None = None) -> RowListResponse:
    with _sqlite_boundary("list_rows", table_id):
        return sqlite_database.list_rows(table_id, queries)


def list_rows_all(
    table_id: str, queries: Queries | None = None, limit: int = DEFAULT_LIMIT,
) -> list[RowMapping]:
    sqlite_database.validate_page_limit(limit)
    rows: list[RowMapping] = []
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


@overload
def get_row_safe(
    table_id: str, row_id: object, *, allow_missing: Literal[False] = False,
) -> RowMapping: ...


@overload
def get_row_safe(
    table_id: str, row_id: object, *, allow_missing: bool,
) -> RowMapping | None: ...


def get_row_safe(table_id: str, row_id: object, *, allow_missing: bool = False) -> RowMapping | None:
    with _sqlite_boundary("get_row", table_id):
        return sqlite_database.get_row(table_id, row_id, allow_missing=allow_missing)


def create_row_safe(
    table_id: str, row_id: object, data: Mapping[str, Any] | None,
    permissions: Sequence[str] | None = None,
) -> RowMapping:
    with _sqlite_boundary("create_row", table_id):
        return sqlite_database.create_row(table_id, row_id=row_id, data=data)


def insert_row_ignore_safe(
    table_id: str, row_id: object, data: Mapping[str, Any] | None,
    permissions: Sequence[str] | None = None,
) -> bool:
    with _sqlite_boundary("insert_row_ignore", table_id):
        return sqlite_database.insert_row_ignore(table_id, row_id=row_id, data=data)


def update_row_safe(
    table_id: str, row_id: object, data: Mapping[str, Any] | None,
    permissions: Sequence[str] | None = None,
) -> RowMapping:
    with _sqlite_boundary("update_row", table_id):
        return sqlite_database.update_row(table_id, row_id, data=data)


def delete_row_safe(table_id: str, row_id: object) -> None:
    with _sqlite_boundary("delete_row", table_id):
        sqlite_database.delete_row(table_id, row_id)


def delete_rows_by_query(table_id: str, queries: Queries) -> int:
    rows = list_rows_all(table_id, queries=queries)
    for row in rows:
        row_id = row.get("$id") or row.get("id")
        if row_id:
            delete_row_safe(table_id, row_id)
    return len(rows)


def first_row(table_id: str, queries: Queries | None = None) -> RowMapping | None:
    query_list = list(queries or [])
    query_list.append(Query.limit(1))
    response = list_rows_safe(table_id, query_list)
    rows = response.get("rows", [])
    return rows[0] if rows else None


def list_appwrite_rows_safe(table_id: str, queries: Queries | None = None) -> RowListResponse:
    try:
        return APPWRITE_REPOSITORY.list_rows(table_id, queries)
    except AppwriteException:
        logger.exception("Appwrite list_rows failed: %s", table_id)
        raise


def list_appwrite_rows_all(
    table_id: str, queries: Queries | None = None, limit: int = DEFAULT_LIMIT,
) -> list[RowMapping]:
    sqlite_database.validate_page_limit(limit)
    rows: list[RowMapping] = []
    offset = 0
    while True:
        query_list = list(queries or [])
        query_list.append(Query.limit(limit))
        query_list.append(Query.offset(offset))
        response = list_appwrite_rows_safe(table_id, query_list)
        batch = response.get("rows", [])
        rows.extend(batch)
        if len(batch) < limit:
            break
        offset += limit
    return rows
