"""Calendar operations with explicit identity and payload inputs; no HTTP handlers."""

import logging
from typing import Any, Callable, Mapping
from datetime import datetime
from appwrite.exception import AppwriteException
from appwrite.query import Query
from appwrite_client import COLLECTIONS
from appwrite_helpers import format_datetime
from appwrite_helpers import first_row, update_row_safe
from services.calendar_store import list_calendar_rows_all
from services.calendar_shares import _calendar_shares_collection, _calendar_share_payload
from services.calendar_feed_sources import _configured_feed_urls

logger = logging.getLogger(__name__)



def list_calendar_shares(
    user_id: str,
    *,
    dependencies: Mapping[str, Callable[..., Any]] | None = None,
) -> tuple[dict[str, Any], int]:
    dependencies = dependencies or {}
    list_calendar_rows_all_fn = dependencies.get('list_calendar_rows_all', list_calendar_rows_all)
    _calendar_shares_collection_fn = dependencies.get('_calendar_shares_collection', _calendar_shares_collection)
    _calendar_share_payload_fn = dependencies.get('_calendar_share_payload', _calendar_share_payload)
    try:
        shares = list_calendar_rows_all_fn(
            _calendar_shares_collection_fn(),
            [Query.equal('user_id', [user_id]), Query.order_desc('created_at')],
        )
    except AppwriteException:
        logger.exception('Failed to load calendar shares')
        return ({'error': 'Unable to load calendar shares.'}, 500)
    return ({'shares': [_calendar_share_payload_fn(share) for share in shares]}, 200)


def refresh_feed(
    user_id: str,
    *,
    dependencies: Mapping[str, Callable[..., Any]] | None = None,
) -> tuple[dict[str, Any], int]:
    """Refresh all configured owner feeds and persist their refresh timestamp."""
    dependencies = dependencies or {}
    first_row_fn = dependencies.get('first_row', first_row)
    update_row_safe_fn = dependencies.get('update_row_safe', update_row_safe)
    try:
        settings = first_row_fn(COLLECTIONS['user_settings'], [Query.equal('user_id', [user_id])])
    except AppwriteException:
        logger.exception('Failed to load user settings')
        return ({'error': 'Unable to refresh calendar feeds.'}, 500)
    feed_urls = _configured_feed_urls(settings)
    if not feed_urls:
        return ({'error': 'No calendar feed URLs configured. Visit Settings to add one.'}, 400)
    from services.feed_fetcher import fetch_and_cache_feeds
    try:
        count = fetch_and_cache_feeds(user_id, feed_urls, force=True)
        update_row_safe_fn(
            COLLECTIONS['user_settings'],
            settings.get('$id'),
            {'updated_at': format_datetime(datetime.utcnow())},
        )
        return ({'status': 'ok', 'events_cached': count}, 200)
    except AppwriteException:
        logger.exception('Failed to update settings after refresh')
        return ({'error': 'Unable to refresh calendar feeds.'}, 500)
    except Exception as e:
        logger.exception('Calendar refresh failed', extra={'user_id': user_id, 'feed_count': len(feed_urls)})
        return ({'error': f'Feed fetch failed: {str(e)}'}, 500)
