"""Provider query contracts shared by the admin projections."""

from typing import Protocol
from services.database import Queries, RowListResponse, RowMapping


class ListAdminRows(Protocol):
    def __call__(self, table_id: str, queries: Queries | None = None) -> list[RowMapping]: ...


class ListAdminPage(Protocol):
    def __call__(self, table_id: str, queries: Queries | None = None) -> RowListResponse: ...
