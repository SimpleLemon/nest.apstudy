"""Term lifecycle policy. Schedules are evaluated in UTC on every read."""

import json
import logging
import re
from datetime import datetime, timezone

from services.database import db_connection

logger = logging.getLogger(__name__)
PREFIX = "course_tracking_term:"
STATES = {"upcoming", "open", "closed"}
TERM_PATTERN = re.compile(r"^(Spring|Fall)_(20\d{2}|21\d{2})$")


class TermPolicyError(ValueError):
    pass


class TermPolicyConflict(TermPolicyError):
    pass


def validate_term(term):
    if not isinstance(term, str) or not TERM_PATTERN.fullmatch(term):
        raise TermPolicyError("Choose Spring or Fall and a year from 2000 to 2199.")
    return term


def parse_time(value):
    if value in (None, ""):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError("Missing timezone")
        return parsed.astimezone(timezone.utc)
    except (ValueError, TypeError, AttributeError) as exc:
        raise TermPolicyError("Schedule times must include a timezone.") from exc


def _default(term):
    return {"state": "closed" if term == "Fall_2026" else "upcoming",
            "opens_at": None, "closes_at": None, "revision": 0,
            "updated_at": None, "updated_by": None}


def evaluate_policy(term, policy, now=None):
    now = now or datetime.now(timezone.utc)
    state = policy["state"]
    if state not in STATES:
        raise TermPolicyError("Invalid saved tracking state.")
    opens = parse_time(policy.get("opens_at"))
    closes = parse_time(policy.get("closes_at"))
    if state != "closed":
        if closes and now >= closes:
            state = "closed"
        elif opens:
            state = "open" if now >= opens else "upcoming"
    return {**policy, "term": term, "label": term.replace("_", " "),
            "effective_state": state, "can_enable": state != "closed",
            "polling_enabled": state == "open", "available": True}


def _read(conn, term):
    row = conn.execute(
        "SELECT config_value FROM chat_bridge_config WHERE config_key = ?",
        (PREFIX + term,),
    ).fetchone()
    return json.loads(row["config_value"]) if row else _default(term)


def term_policy(term, *, now=None):
    """Fail closed on invalid terms, corrupt policy, or database failures."""
    try:
        validate_term(term)
        with db_connection() as conn:
            policy = evaluate_policy(term, _read(conn, term), now)
        catalog_available = term in _catalog_terms()
        return {**policy, "catalog_available": catalog_available,
                "polling_enabled": policy["polling_enabled"] and catalog_available}
    except Exception:
        logger.exception("Unable to read tracking policy for %s", term)
        return {**_default(term), "term": term, "label": str(term).replace("_", " "),
                "effective_state": "unavailable", "can_enable": False,
                "polling_enabled": False, "available": False}


def term_is_polling(term):
    return term_policy(term)["polling_enabled"]


def track_policy_fields(track, policy=None):
    policy = policy or term_policy(track.get("term"))
    enabled = bool(track.get("enabled"))
    state = policy["effective_state"]
    return {"term_policy": policy, "effective_enabled": enabled and policy["polling_enabled"],
            "tracking_state": ("paused" if not enabled else
                               "active" if policy["polling_enabled"] else
                               "queued" if state == "upcoming" else
                               "waiting_for_data" if state == "open" else state)}


def policy_error(policy):
    unavailable = not policy["available"]
    return {"error": ("Tracking settings are unavailable. Try again shortly." if unavailable else
                      f"{policy['label']} tracking has closed. It cannot be enabled."),
            "code": "course_tracking_unavailable" if unavailable else "course_tracking_closed",
            "term_policy": policy}, 503 if unavailable else 403


def _catalog_terms():
    from services.atlas_client import get_terms
    return {term for term in get_terms()["terms"] if TERM_PATTERN.fullmatch(term)}


def term_inventory():
    catalog = _catalog_terms()
    with db_connection() as conn:
        policies = {row["config_key"][len(PREFIX):]: json.loads(row["config_value"])
                    for row in conn.execute(
                        "SELECT config_key, config_value FROM chat_bridge_config WHERE config_key LIKE ?",
                        (PREFIX + "%",))}
        counts = [dict(row) for row in conn.execute(
            "SELECT term, enabled, count(*) AS count FROM course_seat_tracks GROUP BY term, enabled")]
    terms = catalog | set(policies) | {row["term"] for row in counts}
    year = datetime.now(timezone.utc).year
    terms.update(f"{season}_{y}" for season in ("Spring", "Fall") for y in (year, year + 1))
    result = []
    for term in sorted(terms, key=lambda value: (value.split("_")[-1], value.startswith("Fall")), reverse=True):
        if not TERM_PATTERN.fullmatch(term):
            continue
        policy = evaluate_policy(term, policies.get(term, _default(term)))
        policy["polling_enabled"] = policy["polling_enabled"] and term in catalog
        enabled = sum(row["count"] for row in counts if row["term"] == term and row["enabled"])
        paused = sum(row["count"] for row in counts if row["term"] == term and not row["enabled"])
        result.append({**policy, "catalog_available": term in catalog,
                       "active_count": enabled if policy["polling_enabled"] else 0,
                       "waiting_count": enabled if not policy["polling_enabled"] else 0,
                       "paused_count": paused})
    return result


def save_term_policy(term, payload, actor):
    validate_term(term)
    if not isinstance(payload, dict) or not isinstance(payload.get("state"), str) or payload["state"] not in STATES:
        raise TermPolicyError("Choose Upcoming, Open, or Closed.")
    revision = payload.get("expected_revision")
    if type(revision) is not int or revision < 0:
        raise TermPolicyError("Reload the term settings before saving.")
    opens = parse_time(payload.get("opens_at"))
    closes = parse_time(payload.get("closes_at"))
    state = payload["state"]
    if state == "closed" and (opens or closes):
        raise TermPolicyError("Clear schedule times when closing a term immediately.")
    if opens and closes and closes <= opens:
        raise TermPolicyError("Closing time must be after opening time.")
    if state == "upcoming" and closes and not opens:
        raise TermPolicyError("Set an opening time before scheduling an upcoming term to close.")
    now = datetime.now(timezone.utc).isoformat()
    policy = {"state": state, "opens_at": opens.isoformat() if opens else None,
              "closes_at": closes.isoformat() if closes else None,
              "revision": revision + 1, "updated_by": str(actor), "updated_at": now}
    with db_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        before = _read(conn, term)
        if before["revision"] != revision:
            raise TermPolicyConflict("Another admin changed this term. Reload its settings and try again.")
        conn.execute(
            "INSERT INTO chat_bridge_config (id, config_key, config_value, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?) ON CONFLICT(config_key) DO UPDATE SET "
            "config_value=excluded.config_value, updated_at=excluded.updated_at",
            (PREFIX + term, PREFIX + term, json.dumps(policy), now, now),
        )
    return term_policy(term), before
