import logging
from datetime import datetime, timezone

from appwrite.exception import AppwriteException
from appwrite.query import Query

from appwrite_client import databases, DATABASE_ID


logger = logging.getLogger(__name__)
DEFAULT_LIMIT = 100


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


def list_documents_safe(collection_id, queries=None):
    try:
        return databases.list_documents(
            database_id=DATABASE_ID,
            collection_id=collection_id,
            queries=queries or [],
        )
    except AppwriteException as exc:
        logger.exception("Appwrite list_documents failed: %s", collection_id)
        raise


def list_documents_all(collection_id, queries=None, limit=DEFAULT_LIMIT):
    documents = []
    offset = 0
    while True:
        query_list = list(queries or [])
        query_list.append(Query.limit(limit))
        query_list.append(Query.offset(offset))
        response = list_documents_safe(collection_id, query_list)
        batch = response.get("documents", [])
        documents.extend(batch)
        if len(batch) < limit:
            break
        offset += limit
    return documents


def get_document_safe(collection_id, document_id):
    try:
        return databases.get_document(
            database_id=DATABASE_ID,
            collection_id=collection_id,
            document_id=document_id,
        )
    except AppwriteException as exc:
        logger.exception("Appwrite get_document failed: %s", collection_id)
        raise


def create_document_safe(collection_id, document_id, data, permissions=None):
    try:
        return databases.create_document(
            database_id=DATABASE_ID,
            collection_id=collection_id,
            document_id=document_id,
            data=data,
            permissions=permissions,
        )
    except AppwriteException as exc:
        logger.exception("Appwrite create_document failed: %s", collection_id)
        raise


def update_document_safe(collection_id, document_id, data):
    try:
        return databases.update_document(
            database_id=DATABASE_ID,
            collection_id=collection_id,
            document_id=document_id,
            data=data,
        )
    except AppwriteException as exc:
        logger.exception("Appwrite update_document failed: %s", collection_id)
        raise


def delete_document_safe(collection_id, document_id):
    try:
        databases.delete_document(
            database_id=DATABASE_ID,
            collection_id=collection_id,
            document_id=document_id,
        )
    except AppwriteException as exc:
        logger.exception("Appwrite delete_document failed: %s", collection_id)
        raise


def delete_documents_by_query(collection_id, queries):
    documents = list_documents_all(collection_id, queries=queries)
    for doc in documents:
        delete_document_safe(collection_id, doc.get("$id"))
    return len(documents)


def first_document(collection_id, queries=None):
    query_list = list(queries or [])
    query_list.append(Query.limit(1))
    response = list_documents_safe(collection_id, query_list)
    docs = response.get("documents", [])
    return docs[0] if docs else None
