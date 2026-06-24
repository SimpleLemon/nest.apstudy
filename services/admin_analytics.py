"""Admin analytics storage, aggregation, and optional GA4 reporting."""

import os
import uuid
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

from services import database

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover - Python 3.8 fallback is not used in CI.
    ZoneInfo = None


RANGE_OPTIONS = {
    "24h": {"label": "Last 24 hours", "hours": 24, "granularity": "hour"},
    "7d": {"label": "Last 7 days", "days": 7, "granularity": "day"},
    "14d": {"label": "Last 14 days", "days": 14, "granularity": "day"},
    "30d": {"label": "Last 30 days", "days": 30, "granularity": "day"},
    "60d": {"label": "Last 60 days", "days": 60, "granularity": "day"},
    "all": {"label": "All time", "granularity": "day"},
}

DEFAULT_GA4_PROPERTY_ID = "446578226"
GA4_ACCOUNT_ID = "318602205"
GA4_HOSTNAME = "nest.apstudy.org"


def utcnow():
    return datetime.now(timezone.utc)


def parse_utc(value):
    if not value:
        return None
    if isinstance(value, datetime):
        parsed = value
    else:
        text = str(value)
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError:
            return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def iso_utc(value):
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def resolve_timezone(tz_name):
    if ZoneInfo is None:
        return timezone.utc, "UTC"
    try:
        tz = ZoneInfo((tz_name or "").strip() or "UTC")
        return tz, getattr(tz, "key", None) or (tz_name or "UTC")
    except Exception:
        return timezone.utc, "UTC"


def normalize_range(range_key):
    return range_key if range_key in RANGE_OPTIONS else "30d"


def _floor_hour(value):
    return value.replace(minute=0, second=0, microsecond=0)


def _floor_day(value):
    return value.replace(hour=0, minute=0, second=0, microsecond=0)


def _floor_month(value):
    return value.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def _add_bucket(value, granularity, amount=1):
    if granularity == "hour":
        return value + timedelta(hours=amount)
    if granularity == "month":
        month_index = value.month - 1 + amount
        year = value.year + month_index // 12
        month = month_index % 12 + 1
        return value.replace(year=year, month=month, day=1)
    return value + timedelta(days=amount)


def _bucket_key(value, granularity):
    if granularity == "hour":
        return _floor_hour(value).strftime("%Y-%m-%dT%H:00")
    if granularity == "month":
        return _floor_month(value).strftime("%Y-%m")
    return _floor_day(value).strftime("%Y-%m-%d")


def _bucket_label(value, granularity):
    if granularity == "hour":
        return value.strftime("%-I %p") if os.name != "nt" else value.strftime("%I %p").lstrip("0")
    if granularity == "month":
        return value.strftime("%b %Y")
    return value.strftime("%b %-d") if os.name != "nt" else value.strftime("%b %d").replace(" 0", " ")


def _first_user_created_at(users):
    values = [parse_utc(user.get("created_at")) for user in users]
    values = [value for value in values if value]
    return min(values) if values else utcnow()


def _range_window(range_key, tz, users, now=None):
    range_key = normalize_range(range_key)
    now_utc = now or utcnow()
    local_now = now_utc.astimezone(tz)
    config = RANGE_OPTIONS[range_key]
    granularity = config["granularity"]
    if range_key == "24h":
        end_local = _floor_hour(local_now)
        start_local = end_local - timedelta(hours=config["hours"] - 1)
    elif range_key == "all":
        first_local = _first_user_created_at(users).astimezone(tz)
        start_local = _floor_day(first_local)
        end_local = _floor_day(local_now)
        if (end_local.date() - start_local.date()).days > 180:
            granularity = "month"
            start_local = _floor_month(start_local)
            end_local = _floor_month(end_local)
    else:
        end_local = _floor_day(local_now)
        start_local = end_local - timedelta(days=config["days"] - 1)
    return {
        "range": range_key,
        "granularity": granularity,
        "start_local": start_local,
        "end_local": end_local,
        "start_utc": start_local.astimezone(timezone.utc),
        "end_utc": _add_bucket(end_local, granularity).astimezone(timezone.utc),
        "now_utc": now_utc,
    }


def _bucket_series(window):
    buckets = []
    current = window["start_local"]
    final = window["end_local"]
    granularity = window["granularity"]
    while current <= final:
        buckets.append({
            "key": _bucket_key(current, granularity),
            "label": _bucket_label(current, granularity),
            "start": iso_utc(current.astimezone(timezone.utc)),
        })
        current = _add_bucket(current, granularity)
    return buckets


def _rows(table_id, *, path=None):
    try:
        with database.db_connection(path) as conn:
            database.table_columns(conn, table_id)
            return [dict(row) for row in conn.execute(f'SELECT * FROM "{table_id}"').fetchall()]
    except Exception:
        return []


def _count_table(table_id, *, start_utc=None, end_utc=None, column="created_at", path=None):
    try:
        with database.db_connection(path) as conn:
            columns = database.table_columns(conn, table_id)
            if column not in columns:
                return 0
            sql = f'SELECT COUNT(*) AS total FROM "{table_id}"'
            params = []
            where = []
            if start_utc:
                where.append(f'"{column}" >= ?')
                params.append(iso_utc(start_utc))
            if end_utc:
                where.append(f'"{column}" < ?')
                params.append(iso_utc(end_utc))
            if where:
                sql += " WHERE " + " AND ".join(where)
            return int(conn.execute(sql, params).fetchone()["total"] or 0)
    except Exception:
        return 0


def record_site_open(user_id, path, *, endpoint=None, now=None, db_path=None):
    """Record an authenticated page view and distinct activity rollup."""
    if not user_id:
        return False
    now_utc = now or utcnow()
    created_at = iso_utc(now_utc)
    hour_start = iso_utc(_floor_hour(now_utc))
    day_start = iso_utc(_floor_day(now_utc))
    rows = [
        (
            f"{user_id}:hour:{hour_start}",
            str(user_id),
            "hour",
            hour_start,
            created_at,
        ),
        (
            f"{user_id}:day:{day_start}",
            str(user_id),
            "day",
            day_start,
            created_at,
        ),
    ]
    try:
        with database.db_connection(db_path) as conn:
            conn.execute(
                """
                INSERT INTO analytics_events (id, user_id, event_type, path, endpoint, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                [uuid.uuid4().hex, str(user_id), "page_view", path or "", endpoint or "", created_at],
            )
            conn.executemany(
                """
                INSERT INTO user_activity_buckets (id, user_id, bucket_granularity, bucket_start, last_seen_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(user_id, bucket_granularity, bucket_start)
                DO UPDATE SET last_seen_at = excluded.last_seen_at
                """,
                rows,
            )
        return True
    except Exception:
        return False


def _filter_created(rows, window, *, all_time=False, key="created_at"):
    if all_time:
        return list(rows)
    start = window["start_utc"]
    end = window["end_utc"]
    selected = []
    for row in rows:
        created_at = parse_utc(row.get(key))
        if created_at and start <= created_at < end:
            selected.append(row)
    return selected


def _normalize_provider(user):
    provider = str((user or {}).get("provider") or "").strip().lower()
    if provider in {"google", "discord", "github"}:
        return provider
    if (user or {}).get("google_id"):
        return "google"
    return "other"


def _uni_type(user):
    school = f"{user.get('school') or ''} {user.get('school_key') or ''}".lower()
    level = str(user.get("education_level") or "").strip().lower()
    if user.get("emory_student") or "emory" in school or "oxford" in school:
        return "emory"
    if "high" in level or "secondary" in level:
        return "high_school"
    if "graduate" in level or "master" in level or "phd" in level or "doctor" in level:
        return "graduate"
    if "university" in level or "college" in level or "undergraduate" in level:
        return "university"
    return "other"


def _total_user_growth(users, buckets, window, tz):
    granularity = window["granularity"]
    created_values = [parse_utc(user.get("created_at")) for user in users]
    created_values = sorted(value for value in created_values if value)
    index = 0
    values = []
    for bucket in buckets:
        local_start = parse_utc(bucket["start"]).astimezone(tz)
        bucket_end = _add_bucket(local_start, granularity).astimezone(timezone.utc)
        while index < len(created_values) and created_values[index] < bucket_end:
            index += 1
        values.append({"key": bucket["key"], "label": bucket["label"], "value": index})
    return values


def _active_users(events, daily_active_rows, buckets, window, tz):
    active_by_bucket = defaultdict(set)
    granularity = window["granularity"]
    start = window["start_utc"] - timedelta(days=1)
    end = window["end_utc"] + timedelta(days=1)
    bucket_keys = {bucket["key"] for bucket in buckets}
    for event in events:
        if event.get("event_type") != "page_view" or not event.get("user_id"):
            continue
        created_at = parse_utc(event.get("created_at"))
        if not created_at or created_at < start or created_at >= end:
            continue
        key = _bucket_key(created_at.astimezone(tz), granularity)
        if key in bucket_keys:
            active_by_bucket[key].add(event["user_id"])

    if granularity != "hour":
        for row in daily_active_rows:
            user_id = row.get("user_id")
            active_date = row.get("active_date")
            if not user_id or not active_date:
                continue
            try:
                active_at = datetime.fromisoformat(str(active_date)).replace(tzinfo=tz)
            except ValueError:
                continue
            key = _bucket_key(active_at, granularity)
            if key in bucket_keys:
                active_by_bucket[key].add(user_id)

    return [
        {"key": bucket["key"], "label": bucket["label"], "value": len(active_by_bucket[bucket["key"]])}
        for bucket in buckets
    ]


def _page_views(events, buckets, window, tz):
    counts = Counter()
    top_pages = Counter()
    bucket_keys = {bucket["key"] for bucket in buckets}
    for event in _filter_created(events, window):
        if event.get("event_type") != "page_view":
            continue
        created_at = parse_utc(event.get("created_at"))
        if not created_at:
            continue
        key = _bucket_key(created_at.astimezone(tz), window["granularity"])
        if key in bucket_keys:
            counts[key] += 1
        path = event.get("path") or "/"
        top_pages[path] += 1
    series = [
        {"key": bucket["key"], "label": bucket["label"], "value": counts[bucket["key"]]}
        for bucket in buckets
    ]
    return series, [{"label": label, "value": value} for label, value in top_pages.most_common(6)]


def _breakdown(items, labels):
    counter = Counter(items)
    return [{"key": key, "label": label, "value": counter.get(key, 0)} for key, label in labels]


def _breakdown_growth_series(users, buckets, window, tz, classify_fn, labels):
    granularity = window["granularity"]
    by_category = {key: [] for key, _ in labels}
    for user in users:
        created_at = parse_utc(user.get("created_at"))
        if not created_at:
            continue
        category = classify_fn(user)
        if category in by_category:
            by_category[category].append(created_at)
    for key in by_category:
        by_category[key].sort()

    series = []
    for key, label in labels:
        created_values = by_category[key]
        index = 0
        points = []
        for bucket in buckets:
            local_start = parse_utc(bucket["start"]).astimezone(tz)
            bucket_end = _add_bucket(local_start, granularity).astimezone(timezone.utc)
            while index < len(created_values) and created_values[index] < bucket_end:
                index += 1
            points.append({"key": bucket["key"], "label": bucket["label"], "value": index})
        series.append({"key": key, "label": label, "points": points})
    return series


def _ga4_payload(range_key, window):
    property_id = (os.environ.get("GA4_PROPERTY_ID") or DEFAULT_GA4_PROPERTY_ID).strip()
    credentials = (os.environ.get("GOOGLE_APPLICATION_CREDENTIALS") or "").strip()
    if not credentials:
        return {"configured": False, "status": "not_configured", "message": "GOOGLE_APPLICATION_CREDENTIALS is not configured."}

    try:
        from google.analytics.data_v1beta import BetaAnalyticsDataClient
        from google.analytics.data_v1beta.types import DateRange, Dimension, Filter, FilterExpression, Metric, RunReportRequest, RunRealtimeReportRequest
    except Exception:
        return {"configured": False, "status": "missing_dependency", "message": "google-analytics-data is not installed."}

    try:
        client = BetaAnalyticsDataClient()
        start_date = window["start_local"].date().isoformat()
        end_date = window["end_local"].date().isoformat()
        hostname_filter = FilterExpression(
            filter=Filter(
                field_name="hostName",
                string_filter=Filter.StringFilter(
                    match_type=Filter.StringFilter.MatchType.EXACT,
                    value=GA4_HOSTNAME,
                ),
            )
        )
        report = client.run_report(
            RunReportRequest(
                property=f"properties/{property_id}",
                dimensions=[Dimension(name="date")],
                metrics=[
                    Metric(name="activeUsers"),
                    Metric(name="screenPageViews"),
                    Metric(name="eventCount"),
                ],
                date_ranges=[DateRange(start_date=start_date, end_date=end_date)],
                dimension_filter=hostname_filter,
            )
        )
        # Realtime API does not support hostName filters; scope historical reports only.
        realtime = client.run_realtime_report(
            RunRealtimeReportRequest(
                property=f"properties/{property_id}",
                dimensions=[Dimension(name="country")],
                metrics=[Metric(name="activeUsers")],
            )
        )
    except Exception as exc:
        return {"configured": True, "status": "error", "message": str(exc)[:300]}

    rows = []
    totals = {"activeUsers": 0, "screenPageViews": 0, "eventCount": 0}
    for row in report.rows:
        date_value = row.dimension_values[0].value
        metrics = [int(metric.value or 0) for metric in row.metric_values]
        rows.append({
            "date": date_value,
            "activeUsers": metrics[0],
            "screenPageViews": metrics[1],
            "eventCount": metrics[2],
        })
        totals["activeUsers"] += metrics[0]
        totals["screenPageViews"] += metrics[1]
        totals["eventCount"] += metrics[2]

    countries = []
    realtime_total = 0
    for row in realtime.rows:
        active = int(row.metric_values[0].value or 0)
        realtime_total += active
        countries.append({"country": row.dimension_values[0].value or "Unknown", "activeUsers": active})

    return {
        "configured": True,
        "status": "ok",
        "range": range_key,
        "propertyId": property_id,
        "hostName": GA4_HOSTNAME,
        "totals": totals,
        "series": rows,
        "realtime": {"activeUsers": realtime_total, "countries": countries[:8]},
    }


def analytics_payload(range_key="30d", tz_name="UTC", *, include_ga=True, now=None, path=None):
    tz, resolved_tz = resolve_timezone(tz_name)
    range_key = normalize_range(range_key)
    users = _rows("users", path=path)
    events = _rows("analytics_events", path=path)
    daily_active_rows = _rows("daily_active_users", path=path)
    window = _range_window(range_key, tz, users, now=now)
    buckets = _bucket_series(window)
    all_time = range_key == "all"
    selected_users = _filter_created(users, window, all_time=all_time)
    page_view_series, top_pages = _page_views(events, buckets, window, tz)

    provider_labels = [
        ("google", "Google"),
        ("discord", "Discord"),
        ("github", "GitHub"),
        ("other", "Other"),
    ]
    uni_labels = [
        ("emory", "Emory (Main/Oxford)"),
        ("university", "University (All)"),
        ("high_school", "High School"),
        ("graduate", "Graduate"),
        ("other", "Other"),
    ]

    onboarding_total = len(selected_users)
    onboarding_complete = sum(1 for user in selected_users if user.get("onboarding_complete"))
    engagement_counts = {
        "tasks": _count_table("tasks", start_utc=None if all_time else window["start_utc"], end_utc=None if all_time else window["end_utc"], path=path),
        "courses": _count_table("user_courses", start_utc=None if all_time else window["start_utc"], end_utc=None if all_time else window["end_utc"], column="added_at", path=path),
        "notes": _count_table("notes", start_utc=None if all_time else window["start_utc"], end_utc=None if all_time else window["end_utc"], path=path),
        "files": _count_table("shared_files", start_utc=None if all_time else window["start_utc"], end_utc=None if all_time else window["end_utc"], path=path),
        "chat_messages": _count_table("chat_messages", start_utc=None if all_time else window["start_utc"], end_utc=None if all_time else window["end_utc"], path=path),
    }

    return {
        "range": range_key,
        "rangeLabel": RANGE_OPTIONS[range_key]["label"],
        "timezone": resolved_tz,
        "granularity": window["granularity"],
        "start": iso_utc(window["start_utc"]),
        "end": iso_utc(window["end_utc"]),
        "buckets": buckets,
        "cards": {
            "totalUsers": len(users),
            "activeUsers": max((point["value"] for point in _active_users(events, daily_active_rows, buckets, window, tz)), default=0),
            "pageViews": sum(point["value"] for point in page_view_series),
            "onboardingRate": round((onboarding_complete / onboarding_total) * 100, 1) if onboarding_total else 0,
        },
        "series": {
            "totalUsers": _total_user_growth(users, buckets, window, tz),
            "activeUsers": _active_users(events, daily_active_rows, buckets, window, tz),
            "pageViews": page_view_series,
            "oauth": _breakdown_growth_series(users, buckets, window, tz, _normalize_provider, provider_labels),
            "uniType": _breakdown_growth_series(users, buckets, window, tz, _uni_type, uni_labels),
        },
        "breakdowns": {
            "oauth": _breakdown((_normalize_provider(user) for user in selected_users), provider_labels),
            "uniType": _breakdown((_uni_type(user) for user in selected_users), uni_labels),
        },
        "engagement": {
            "topPages": top_pages,
            "onboarding": {
                "complete": onboarding_complete,
                "incomplete": max(0, onboarding_total - onboarding_complete),
                "total": onboarding_total,
            },
            "featureUsage": [{"label": key.replace("_", " ").title(), "value": value} for key, value in engagement_counts.items()],
        },
        "ga4": _ga4_payload(range_key, window) if include_ga else {"configured": False, "status": "disabled"},
    }
