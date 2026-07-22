"""Account-synced Focus Mode routines, sessions, and completion history."""

import re
import uuid
from datetime import datetime, timedelta, timezone

from services.database import db_connection


ACTIVE_STATES = ("running", "paused")
PHASES = ("focus", "break")
SPOTIFY_PLAYLIST_RE = re.compile(
    r"^https://open\.spotify\.com/(?:embed/)?playlist/([A-Za-z0-9]+)(?:[/?#].*)?$",
    re.IGNORECASE,
)


def _now():
    return datetime.now(timezone.utc)


def _iso(value):
    if value is None:
        return None
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse(value):
    if not value:
        return None
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _identifier():
    return uuid.uuid4().hex


def _bounded_integer(value, *, label, minimum, maximum):
    try:
        number = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{label} must be a whole number.") from exc
    if number < minimum or number > maximum:
        raise ValueError(f"{label} must be between {minimum} and {maximum}.")
    return number


def normalize_spotify_url(value):
    url = str(value or "").strip()
    if not url:
        return None
    match = SPOTIFY_PLAYLIST_RE.match(url)
    if not match:
        raise ValueError("Use a Spotify playlist link from open.spotify.com.")
    return f"https://open.spotify.com/playlist/{match.group(1)}"


def spotify_embed_url(value):
    normalized = normalize_spotify_url(value)
    if not normalized:
        return None
    playlist_id = normalized.rsplit("/", 1)[-1]
    return f"https://open.spotify.com/embed/playlist/{playlist_id}?utm_source=generator&theme=0"


def _routine_payload(payload):
    name = str(payload.get("name") or "").strip()[:60]
    if not name:
        raise ValueError("Enter a routine name.")
    focus_minutes = _bounded_integer(
        payload.get("focus_minutes"), label="Focus time", minimum=1, maximum=240
    )
    break_minutes = _bounded_integer(
        payload.get("break_minutes", 0), label="Break time", minimum=0, maximum=60
    )
    long_break_minutes = _bounded_integer(
        payload.get("long_break_minutes", break_minutes),
        label="Long break",
        minimum=0,
        maximum=90,
    )
    cycles = _bounded_integer(payload.get("cycles", 1), label="Cycles", minimum=1, maximum=12)
    if cycles > 1 and break_minutes == 0:
        raise ValueError("Choose a break time when using more than one focus cycle.")
    return {
        "name": name,
        "focus_minutes": focus_minutes,
        "break_minutes": break_minutes,
        "long_break_minutes": long_break_minutes,
        "cycles": cycles,
        "spotify_url": normalize_spotify_url(payload.get("spotify_url")),
    }


def _row_dict(row):
    return dict(row) if row else None


def _serialize_routine(row):
    if not row:
        return None
    routine = _row_dict(row)
    routine["spotify_embed_url"] = spotify_embed_url(routine.get("spotify_url"))
    return routine


def _phase_duration(row, phase=None):
    phase = phase or row["phase"]
    if phase == "focus":
        return int(row["focus_seconds"])
    completed_cycles = int(row["completed_focus_cycles"])
    if completed_cycles and completed_cycles % 4 == 0 and int(row["long_break_seconds"] or 0):
        return int(row["long_break_seconds"])
    return int(row["break_seconds"] or 0)


def _remaining_seconds(row, now=None):
    if not row:
        return 0
    if row["state"] == "paused":
        return max(0, int(row["paused_remaining_seconds"] or 0))
    ends_at = _parse(row["phase_ends_at"])
    if not ends_at:
        return 0
    return max(0, int((ends_at - (now or _now())).total_seconds() + 0.999))


def _serialize_session(row, now=None):
    if not row:
        return None
    session = _row_dict(row)
    session["auto_start_next"] = bool(session.get("auto_start_next"))
    session["remaining_seconds"] = _remaining_seconds(row, now=now)
    session["cycle_number"] = min(
        int(session.get("completed_focus_cycles") or 0) + 1,
        int(session.get("total_cycles") or 1),
    )
    session["phase_duration_seconds"] = _phase_duration(row)
    session["spotify_embed_url"] = spotify_embed_url(session.get("spotify_url"))
    return session


def list_routines(user_id):
    with db_connection() as conn:
        rows = conn.execute(
            """SELECT * FROM focus_routines WHERE user_id=?
               ORDER BY COALESCE(last_used_at, updated_at, created_at) DESC, name COLLATE NOCASE""",
            [str(user_id)],
        ).fetchall()
    return [_serialize_routine(row) for row in rows]


def save_routine(user_id, payload, routine_id=None):
    values = _routine_payload(payload)
    now = _iso(_now())
    user_id = str(user_id)
    with db_connection() as conn:
        if routine_id:
            existing = conn.execute(
                "SELECT id FROM focus_routines WHERE id=? AND user_id=?",
                [str(routine_id), user_id],
            ).fetchone()
            if not existing:
                raise LookupError("Focus routine not found.")
            conn.execute(
                """UPDATE focus_routines SET name=?,focus_minutes=?,break_minutes=?,
                   long_break_minutes=?,cycles=?,spotify_url=?,updated_at=? WHERE id=? AND user_id=?""",
                [
                    values["name"], values["focus_minutes"], values["break_minutes"],
                    values["long_break_minutes"], values["cycles"], values["spotify_url"],
                    now, str(routine_id), user_id,
                ],
            )
            saved_id = str(routine_id)
        else:
            saved_id = _identifier()
            conn.execute(
                """INSERT INTO focus_routines
                   (id,user_id,name,focus_minutes,break_minutes,long_break_minutes,cycles,
                    spotify_url,created_at,updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?)""",
                [
                    saved_id, user_id, values["name"], values["focus_minutes"],
                    values["break_minutes"], values["long_break_minutes"], values["cycles"],
                    values["spotify_url"], now, now,
                ],
            )
        row = conn.execute("SELECT * FROM focus_routines WHERE id=?", [saved_id]).fetchone()
    return _serialize_routine(row)


def delete_routine(user_id, routine_id):
    with db_connection() as conn:
        result = conn.execute(
            "DELETE FROM focus_routines WHERE id=? AND user_id=?",
            [str(routine_id), str(user_id)],
        )
    return result.rowcount > 0


def _insert_completion(conn, row, completed_at):
    cycle_number = max(1, int(row["completed_focus_cycles"]) + (1 if row["phase"] == "focus" else 0))
    conn.execute(
        """INSERT OR IGNORE INTO focus_session_events
           (id,user_id,session_id,phase,duration_seconds,cycle_number,completed_at)
           VALUES (?,?,?,?,?,?,?)""",
        [
            _identifier(), row["user_id"], row["id"], row["phase"],
            _phase_duration(row), cycle_number, _iso(completed_at),
        ],
    )


def _advance_row(conn, row, transition_at):
    _insert_completion(conn, row, transition_at)
    completed_cycles = int(row["completed_focus_cycles"])
    if row["phase"] == "focus":
        completed_cycles += 1
        if completed_cycles >= int(row["total_cycles"]):
            conn.execute(
                """UPDATE focus_sessions SET state='completed',completed_focus_cycles=?,
                   completed_at=?,ended_at=?,phase_ends_at=NULL,paused_remaining_seconds=NULL,
                   updated_at=? WHERE id=?""",
                [completed_cycles, _iso(transition_at), _iso(transition_at), _iso(_now()), row["id"]],
            )
            return conn.execute("SELECT * FROM focus_sessions WHERE id=?", [row["id"]]).fetchone()
        next_phase = "break"
    else:
        next_phase = "focus"

    provisional = dict(row)
    provisional["phase"] = next_phase
    provisional["completed_focus_cycles"] = completed_cycles
    next_duration = _phase_duration(provisional)
    auto_start = bool(row["auto_start_next"])
    next_state = "running" if auto_start else "paused"
    next_end = transition_at + timedelta(seconds=next_duration) if auto_start else None
    conn.execute(
        """UPDATE focus_sessions SET phase=?,state=?,completed_focus_cycles=?,
           phase_started_at=?,phase_ends_at=?,paused_remaining_seconds=?,updated_at=? WHERE id=?""",
        [
            next_phase, next_state, completed_cycles, _iso(transition_at), _iso(next_end),
            None if auto_start else next_duration, _iso(_now()), row["id"],
        ],
    )
    return conn.execute("SELECT * FROM focus_sessions WHERE id=?", [row["id"]]).fetchone()


def _reconcile(conn, row, now=None, force_once=False):
    now = now or _now()
    current = row
    for index in range(32):
        if not current or current["state"] != "running":
            break
        ends_at = _parse(current["phase_ends_at"])
        if not ends_at:
            break
        if ends_at > now and not (force_once and index == 0):
            break
        transition_at = min(ends_at, now) if not force_once else now
        current = _advance_row(conn, current, transition_at)
        force_once = False
    return current


def get_session(user_id, session_id, *, reconcile=True):
    now = _now()
    with db_connection() as conn:
        row = conn.execute(
            "SELECT * FROM focus_sessions WHERE id=? AND user_id=?",
            [str(session_id), str(user_id)],
        ).fetchone()
        if row and reconcile:
            row = _reconcile(conn, row, now=now)
    return _serialize_session(row, now=now)


def get_active_session(user_id, *, reconcile=True):
    now = _now()
    with db_connection() as conn:
        row = conn.execute(
            """SELECT * FROM focus_sessions WHERE user_id=? AND state IN ('running','paused')
               ORDER BY started_at DESC LIMIT 1""",
            [str(user_id)],
        ).fetchone()
        if row and reconcile:
            row = _reconcile(conn, row, now=now)
        if row and row["state"] not in ACTIVE_STATES:
            row = None
    return _serialize_session(row, now=now)


def _session_values(user_id, payload):
    routine = None
    routine_id = str(payload.get("routine_id") or "").strip() or None
    if routine_id:
        with db_connection() as conn:
            routine = conn.execute(
                "SELECT * FROM focus_routines WHERE id=? AND user_id=?",
                [routine_id, str(user_id)],
            ).fetchone()
        if not routine:
            raise LookupError("Focus routine not found.")

    source = dict(routine) if routine else {}
    for key in (
        "name", "focus_minutes", "break_minutes", "long_break_minutes", "cycles", "spotify_url"
    ):
        if key in payload:
            source[key] = payload.get(key)
    values = _routine_payload({
        "name": source.get("name") or "Custom focus",
        "focus_minutes": source.get("focus_minutes"),
        "break_minutes": source.get("break_minutes", 0),
        "long_break_minutes": source.get("long_break_minutes", source.get("break_minutes", 0)),
        "cycles": source.get("cycles", 1),
        "spotify_url": source.get("spotify_url"),
    })
    values["routine_id"] = routine_id
    values["auto_start_next"] = bool(payload.get("auto_start_next"))
    return values


def start_session(user_id, payload):
    user_id = str(user_id)
    values = _session_values(user_id, payload)
    now = _now()
    session_id = _identifier()
    focus_seconds = values["focus_minutes"] * 60
    with db_connection() as conn:
        existing = conn.execute(
            "SELECT id FROM focus_sessions WHERE user_id=? AND state IN ('running','paused') LIMIT 1",
            [user_id],
        ).fetchone()
        if existing:
            raise RuntimeError("A Focus Mode session is already active.")
        conn.execute(
            """INSERT INTO focus_sessions
               (id,user_id,routine_id,routine_name,focus_seconds,break_seconds,long_break_seconds,
                total_cycles,completed_focus_cycles,phase,state,auto_start_next,phase_started_at,
                phase_ends_at,spotify_url,started_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,0,'focus','running',?,?,?,?,?,?)""",
            [
                session_id, user_id, values["routine_id"], values["name"], focus_seconds,
                values["break_minutes"] * 60, values["long_break_minutes"] * 60,
                values["cycles"], int(values["auto_start_next"]), _iso(now),
                _iso(now + timedelta(seconds=focus_seconds)), values["spotify_url"], _iso(now), _iso(now),
            ],
        )
        if values["routine_id"]:
            conn.execute(
                "UPDATE focus_routines SET last_used_at=?,updated_at=? WHERE id=? AND user_id=?",
                [_iso(now), _iso(now), values["routine_id"], user_id],
            )
        row = conn.execute("SELECT * FROM focus_sessions WHERE id=?", [session_id]).fetchone()
    return _serialize_session(row, now=now)


def update_session(user_id, session_id, action, payload=None):
    user_id = str(user_id)
    payload = payload or {}
    now = _now()
    with db_connection() as conn:
        row = conn.execute(
            "SELECT * FROM focus_sessions WHERE id=? AND user_id=?",
            [str(session_id), user_id],
        ).fetchone()
        if not row:
            raise LookupError("Focus session not found.")
        if action == "pause":
            if row["state"] != "running":
                raise ValueError("Only a running timer can be paused.")
            remaining = _remaining_seconds(row, now=now)
            conn.execute(
                """UPDATE focus_sessions SET state='paused',phase_ends_at=NULL,
                   paused_remaining_seconds=?,updated_at=? WHERE id=?""",
                [remaining, _iso(now), row["id"]],
            )
        elif action == "resume":
            if row["state"] != "paused":
                raise ValueError("Only a paused timer can be resumed.")
            remaining = max(1, int(row["paused_remaining_seconds"] or _phase_duration(row)))
            conn.execute(
                """UPDATE focus_sessions SET state='running',phase_started_at=?,phase_ends_at=?,
                   paused_remaining_seconds=NULL,updated_at=? WHERE id=?""",
                [_iso(now), _iso(now + timedelta(seconds=remaining)), _iso(now), row["id"]],
            )
        elif action == "set_playlist":
            if row["state"] not in ACTIVE_STATES:
                raise ValueError("This Focus Mode session is no longer active.")
            spotify_url = normalize_spotify_url(payload.get("spotify_url"))
            conn.execute(
                "UPDATE focus_sessions SET spotify_url=?,updated_at=? WHERE id=?",
                [spotify_url, _iso(now), row["id"]],
            )
        elif action in {"advance", "complete_phase"}:
            if row["state"] == "paused":
                conn.execute(
                    """UPDATE focus_sessions SET state='running',phase_started_at=?,phase_ends_at=?,
                       paused_remaining_seconds=NULL,updated_at=? WHERE id=?""",
                    [_iso(now), _iso(now), _iso(now), row["id"]],
                )
                row = conn.execute("SELECT * FROM focus_sessions WHERE id=?", [row["id"]]).fetchone()
            if row["state"] != "running":
                raise ValueError("This Focus Mode session is no longer active.")
            row = _reconcile(conn, row, now=now, force_once=True)
        elif action in {"cancel", "exit"}:
            if row["state"] not in ACTIVE_STATES:
                raise ValueError("This Focus Mode session is no longer active.")
            conn.execute(
                """UPDATE focus_sessions SET state='cancelled',phase_ends_at=NULL,
                   paused_remaining_seconds=NULL,ended_at=?,updated_at=? WHERE id=?""",
                [_iso(now), _iso(now), row["id"]],
            )
        else:
            raise ValueError("Unsupported Focus Mode action.")
        updated = conn.execute("SELECT * FROM focus_sessions WHERE id=?", [row["id"]]).fetchone()
    return _serialize_session(updated, now=now)


def list_history(user_id, limit=30):
    limit = min(max(int(limit), 1), 100)
    with db_connection() as conn:
        rows = conn.execute(
            """SELECT e.*,s.routine_name FROM focus_session_events e
               LEFT JOIN focus_sessions s ON s.id=e.session_id
               WHERE e.user_id=? ORDER BY e.completed_at DESC LIMIT ?""",
            [str(user_id), limit],
        ).fetchall()
    return [_row_dict(row) for row in rows]


def recent_selections(user_id, limit=6):
    with db_connection() as conn:
        rows = conn.execute(
            """SELECT focus_seconds,break_seconds,long_break_seconds,total_cycles,spotify_url,
                      MAX(started_at) AS last_used_at
               FROM focus_sessions WHERE user_id=?
               GROUP BY focus_seconds,break_seconds,long_break_seconds,total_cycles,spotify_url
               ORDER BY last_used_at DESC LIMIT ?""",
            [str(user_id), min(max(int(limit), 1), 12)],
        ).fetchall()
    return [
        {
            "focus_minutes": int(row["focus_seconds"]) // 60,
            "break_minutes": int(row["break_seconds"] or 0) // 60,
            "long_break_minutes": int(row["long_break_seconds"] or 0) // 60,
            "cycles": int(row["total_cycles"] or 1),
            "spotify_url": row["spotify_url"],
            "last_used_at": row["last_used_at"],
        }
        for row in rows
    ]


def snapshot(user_id):
    return {
        "active_session": get_active_session(user_id),
        "routines": list_routines(user_id),
        "history": list_history(user_id),
        "recent_selections": recent_selections(user_id),
    }


def active_focus_user_ids(user_ids=None):
    requested = [str(value) for value in (user_ids or []) if str(value or "").strip()]
    clauses = ["state IN ('running','paused')"]
    args = []
    if requested:
        clauses.append(f"user_id IN ({','.join('?' for _ in requested)})")
        args.extend(requested)
    with db_connection() as conn:
        rows = conn.execute(
            f"SELECT * FROM focus_sessions WHERE {' AND '.join(clauses)} ORDER BY started_at DESC",
            args,
        ).fetchall()
        active = set()
        for row in rows:
            current = _reconcile(conn, row)
            if current and current["state"] in ACTIVE_STATES:
                active.add(str(current["user_id"]))
    return active


def is_focus_mode_active(user_id):
    return str(user_id) in active_focus_user_ids([user_id])
