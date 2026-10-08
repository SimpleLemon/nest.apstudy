"""Persistence and event ports shared by the chat service workflows."""

from typing import Any, Literal, Mapping, Protocol, Sequence, overload

from services.database import Queries, RowListResponse, RowMapping


class GetRow(Protocol):
    @overload
    def __call__(self, table_id: str, row_id: object, *, allow_missing: Literal[False] = False) -> RowMapping: ...

    @overload
    def __call__(self, table_id: str, row_id: object, *, allow_missing: bool) -> RowMapping | None: ...


class FirstRow(Protocol):
    def __call__(self, table_id: str, queries: Queries | None = None) -> RowMapping | None: ...


class ListRows(Protocol):
    def __call__(self, table_id: str, queries: Queries | None = None) -> RowListResponse: ...


class ListAllRows(Protocol):
    def __call__(self, table_id: str, queries: Queries | None = None, limit: int = 100) -> list[RowMapping]: ...


class CreateRow(Protocol):
    def __call__(self, table_id: str, row_id: str, data: Mapping[str, Any], permissions: Sequence[str] | None = None) -> RowMapping: ...


class InsertRow(Protocol):
    def __call__(self, table_id: str, row_id: str, data: Mapping[str, Any], permissions: Sequence[str] | None = None) -> bool: ...


class UpdateRow(Protocol):
    def __call__(self, table_id: str, row_id: object, data: Mapping[str, Any], permissions: Sequence[str] | None = None) -> RowMapping: ...


class EmitChatEvent(Protocol):
    def __call__(self, scope_type: str, scope_id: str, event_type: str, *, message_id: str | None = None, thread_id: str | None = None, channel_id: str | None = None, actor_id: str | None = None, readable_user_ids: Sequence[str] | None = None, channel: RowMapping | None = None) -> RowMapping | None: ...


class AttachmentBytes(Protocol):
    def __call__(self, row: RowMapping, *, preview: bool = False) -> bytes | None: ...


class BindAttachments(Protocol):
    def __call__(self, attachment_ids: Sequence[str], *, user_id: str, scope_type: str, scope_id: str, message_id: str) -> list[RowMapping]: ...


class SendChatWebhook(Protocol):
    def __call__(self, content: str, username: str, avatar_url: str | None = None, files: list[RowMapping] | None = None) -> tuple[RowMapping, RowMapping]: ...


class NotifyChatUser(Protocol):
    def __call__(self, user_id: str, category: str, title: str, body: str, target_url: str, *, source_ref: str, dedupe_key: str, tag: str, actor_user_id: str) -> object: ...
