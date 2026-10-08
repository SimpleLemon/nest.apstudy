"""Feature row operations that retain the upload object's SQLite transaction."""

import sqlite3
from typing import Any, Literal, Mapping, overload

from services import database
from services.database import RowMapping
from services.storage_errors import StorageNotFound, StorageValidationError


def _table(conn: sqlite3.Connection, table_id: str) -> str:
    database.table_columns(conn, table_id)
    return database._quote_identifier(table_id)


def _write(conn: sqlite3.Connection) -> None:
    if not conn.in_transaction:
        raise StorageValidationError("Feature changes require an active SQLite transaction.")


@overload
def get_row(
    conn: sqlite3.Connection, table_id: str, row_id: object, *,
    allow_missing: Literal[False] = False,
) -> RowMapping: ...


@overload
def get_row(
    conn: sqlite3.Connection, table_id: str, row_id: object, *, allow_missing: bool,
) -> RowMapping | None: ...


def get_row(
    conn: sqlite3.Connection, table_id: str, row_id: object, *, allow_missing: bool = False,
) -> RowMapping | None:
    table = _table(conn, table_id)
    row = conn.execute(f"SELECT * FROM {table} WHERE id = ?", (str(row_id),)).fetchone()
    if row is None:
        if allow_missing:
            return None
        raise StorageNotFound("Upload feature record was not found.")
    return database._row_to_dict(table_id, row)


def insert_row(
    conn: sqlite3.Connection, table_id: str, row_id: object, data: Mapping[str, Any] | None,
) -> RowMapping:
    _write(conn)
    table = _table(conn, table_id)
    row_id = database._row_id(row_id)
    payload = {"id": row_id, **database._clean_payload(conn, table_id, data)}
    columns = ", ".join(database._quote_identifier(column) for column in payload)
    placeholders = ", ".join("?" for _ in payload)
    conn.execute(f"INSERT INTO {table} ({columns}) VALUES ({placeholders})", list(payload.values()))
    return get_row(conn, table_id, row_id)


def update_row(
    conn: sqlite3.Connection, table_id: str, row_id: object, data: Mapping[str, Any] | None,
) -> RowMapping:
    _write(conn)
    table = _table(conn, table_id)
    payload = database._clean_payload(conn, table_id, data)
    if payload:
        assignments = ", ".join(f"{database._quote_identifier(column)} = ?" for column in payload)
        cursor = conn.execute(f"UPDATE {table} SET {assignments} WHERE id = ?", [*payload.values(), str(row_id)])
        if not cursor.rowcount:
            raise StorageNotFound("Upload feature record was not found.")
    return get_row(conn, table_id, row_id)


def delete_row(conn: sqlite3.Connection, table_id: str, row_id: object) -> bool:
    _write(conn)
    table = _table(conn, table_id)
    cursor = conn.execute(f"DELETE FROM {table} WHERE id = ?", (str(row_id),))
    return cursor.rowcount > 0
