"""Account-synced Focus Mode routines, sessions, and completion history."""

import json
import re
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlencode, urlparse

import requests

from services.database import db_connection
from services.entitlements import check_limit, entitlements_for_user


ACTIVE_STATES = ("running", "paused")
PHASES = ("focus", "break")
SPOTIFY_PLAYLIST_RE = re.compile(
    r"^https://open\.spotify\.com/(?:embed/)?playlist/([A-Za-z0-9]+)(?:[/?#].*)?$",
    re.IGNORECASE,
)
YOUTUBE_PLAYLIST_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"}
YOUTUBE_PLAYLIST_ID_RE = re.compile(r"^[A-Za-z0-9_-]{10,}$")
SPOTIFY_LAYOUTS = {"below", "beside", "floating"}
SPOTIFY_FLOATING_SIZES = {"compact", "expanded"}
SPOTIFY_METADATA_TIMEOUT = 5


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


def playlist_provider(value):
    url = str(value or "").strip()
    if SPOTIFY_PLAYLIST_RE.match(url):
        return "spotify"
    try:
        parsed = urlparse(url)
    except (TypeError, ValueError):
        return None
    host = parsed.hostname.lower() if parsed.hostname else ""
    playlist_id = parse_qs(parsed.query).get("list", [""])[0]
    if (
        parsed.scheme == "https"
        and host in YOUTUBE_PLAYLIST_HOSTS
        and parsed.path.rstrip("/") == "/playlist"
        and YOUTUBE_PLAYLIST_ID_RE.fullmatch(playlist_id)
    ):
        return "youtube_music" if host == "music.youtube.com" else "youtube"
    return None


def normalize_playlist_url(value):
    url = str(value or "").strip()
    if not url:
        return None
    match = SPOTIFY_PLAYLIST_RE.match(url)
    if match:
        return f"https://open.spotify.com/playlist/{match.group(1)}"
    provider = playlist_provider(url)
    if provider in {"youtube", "youtube_music"}:
        parsed = urlparse(url)
        playlist_id = parse_qs(parsed.query)["list"][0]
        host = "music.youtube.com" if provider == "youtube_music" else "www.youtube.com"
        return f"https://{host}/playlist?{urlencode({'list': playlist_id})}"
    raise ValueError("Use a Spotify, YouTube, or YouTube Music playlist link.")


def normalize_spotify_url(value):
    """Backward-compatible storage boundary for playlist URLs."""
    return normalize_playlist_url(value)


def playlist_embed_url(value):
    normalized = normalize_playlist_url(value)
    if not normalized:
        return None
    provider = playlist_provider(normalized)
    if provider == "spotify":
        playlist_id = normalized.rsplit("/", 1)[-1]
        return f"https://open.spotify.com/embed/playlist/{playlist_id}?utm_source=generator&theme=0"
    playlist_id = parse_qs(urlparse(normalized).query)["list"][0]
    return f"https://www.youtube-nocookie.com/embed/videoseries?{urlencode({'list': playlist_id, 'enablejsapi': 1, 'playsinline': 1})}"


def spotify_embed_url(value):
    """Backward-compatible serialized field for the generalized playlist player."""
    return playlist_embed_url(value)


def _playlist_metadata(spotify_url):
    """Return public playlist metadata without requiring a provider connection."""
    provider = playlist_provider(spotify_url)
    provider_label = {
        "spotify": "Spotify",
        "youtube": "YouTube",
        "youtube_music": "YouTube Music",
    }.get(provider, "Playlist")
    fallback = {"title": f"{provider_label} playlist", "creator": provider_label, "thumbnail_url": None}
    try:
        if provider in {"youtube", "youtube_music"}:
            playlist_id = parse_qs(urlparse(spotify_url).query)["list"][0]
            public_url = f"https://www.youtube.com/playlist?{urlencode({'list': playlist_id})}"
            response = requests.get(
                "https://www.youtube.com/oembed",
                params={"url": public_url, "format": "json"},
                timeout=SPOTIFY_METADATA_TIMEOUT,
            )
            response.raise_for_status()
            payload = response.json()
            return {
                "title": str(payload.get("title") or fallback["title"]).strip()[:160],
                "creator": str(payload.get("author_name") or fallback["creator"]).strip()[:120],
                "thumbnail_url": str(payload.get("thumbnail_url") or "").strip() or None,
            }
        response = requests.get(
            "https://open.spotify.com/oembed",
            params={"url": spotify_url},
            timeout=SPOTIFY_METADATA_TIMEOUT,
        )
        response.raise_for_status()
        payload = response.json()
        title = str(payload.get("title") or fallback["title"]).strip()[:160]
        thumbnail_url = str(payload.get("thumbnail_url") or "").strip() or None

        embed_response = requests.get(
            playlist_embed_url(spotify_url),
            headers={"User-Agent": "Mozilla/5.0"},
            timeout=SPOTIFY_METADATA_TIMEOUT,
        )
        embed_response.raise_for_status()
        match = re.search(r'"subtitle":"((?:\\.|[^"\\])*)"', embed_response.text)
        creator = json.loads(f'"{match.group(1)}"') if match else fallback["creator"]
        return {
            "title": title or fallback["title"],
            "creator": str(creator or fallback["creator"]).strip()[:120],
            "thumbnail_url": thumbnail_url,
        }
    except (requests.RequestException, ValueError, TypeError, json.JSONDecodeError):
        return fallback


def _playlist_payload(row, *, active_url=None):
    playlist = _row_dict(row)
    playlist["provider"] = playlist_provider(playlist.get("spotify_url"))
    playlist["url"] = playlist.get("spotify_url")
    playlist["embed_url"] = playlist_embed_url(playlist.get("spotify_url"))
    playlist["spotify_embed_url"] = playlist["embed_url"]
    playlist["active"] = playlist.get("spotify_url") == active_url
    return playlist


def _mark_playlist_active(playlists, active_url):
    return [
        {**playlist, "active": playlist.get("spotify_url") == active_url}
        for playlist in (playlists or [])
    ]


def playlist(value):
    spotify_url = normalize_playlist_url(value)
    if not spotify_url:
        raise ValueError("Use a Spotify, YouTube, or YouTube Music playlist link.")
    return {
        "id": spotify_url.rsplit("/", 1)[-1],
        "spotify_url": spotify_url,
        "url": spotify_url,
        "provider": playlist_provider(spotify_url),
        "embed_url": playlist_embed_url(spotify_url),
        "spotify_embed_url": playlist_embed_url(spotify_url),
        **_playlist_metadata(spotify_url),
    }


def spotify_playlist(value):
    return playlist(value)


def _active_playlist_url(conn, user_id):
    row = conn.execute(
        "SELECT active_playlist_url FROM focus_player_preferences WHERE user_id=?",
        [str(user_id)],
    ).fetchone()
    if not row:
        return None
    return row["active_playlist_url"] or None


def _set_active_playlist_url(conn, user_id, spotify_url):
    now = _iso(_now())
    user_id = str(user_id)
    existing = conn.execute(
        "SELECT user_id FROM focus_player_preferences WHERE user_id=?",
        [user_id],
    ).fetchone()
    if existing:
        conn.execute(
            "UPDATE focus_player_preferences SET active_playlist_url=?, updated_at=? WHERE user_id=?",
            [spotify_url, now, user_id],
        )
        return
    conn.execute(
        """INSERT INTO focus_player_preferences
           (user_id,layout,floating_size,floating_x,floating_y,panel_width,panel_height,
            active_playlist_url,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        [user_id, "beside", "compact", 1.0, 1.0, 0, 0, spotify_url, now],
    )


def _user_playlist_count(conn, user_id):
    row = conn.execute(
        "SELECT COUNT(*) AS count FROM focus_playlists WHERE owner_type='user' AND user_id=?",
        [str(user_id)],
    ).fetchone()
    return int(row["count"] if row else 0)


def _list_user_playlists_conn(conn, user_id):
    user_id = str(user_id)
    active_url = _active_playlist_url(conn, user_id)
    return _list_playlists(
        conn, "user", user_id, active_url=active_url, user_id=user_id,
    )


def list_user_playlists(user_id):
    with db_connection() as conn:
        return _list_user_playlists_conn(conn, user_id)


def _add_user_playlist_conn(conn, user_id, url, entitlements):
    user_id = str(user_id)
    spotify_url = normalize_playlist_url(url)
    existing = conn.execute(
        """SELECT 1 FROM focus_playlists
           WHERE owner_type='user' AND owner_id=? AND spotify_url=?""",
        [user_id, spotify_url],
    ).fetchone()
    if existing:
        return _list_user_playlists_conn(conn, user_id)
    check_limit(
        entitlements,
        "max_focus_playlists",
        _user_playlist_count(conn, user_id),
    )
    position_row = conn.execute(
        """SELECT COALESCE(MAX(position), -1) + 1 AS next_position
           FROM focus_playlists WHERE owner_type='user' AND owner_id=?""",
        [user_id],
    ).fetchone()
    metadata = _playlist_metadata(spotify_url)
    conn.execute(
        """INSERT INTO focus_playlists
           (id,user_id,owner_type,owner_id,spotify_url,title,creator,thumbnail_url,position,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)""",
        [
            _identifier(), user_id, "user", user_id, spotify_url,
            metadata["title"], metadata["creator"], metadata.get("thumbnail_url"),
            int(position_row["next_position"]), _iso(_now()),
        ],
    )
    # Catch concurrent inserts that raced past the pre-check (requires IMMEDIATE lock).
    limit = (entitlements.get("limits") or {}).get("max_focus_playlists")
    if limit is not None and _user_playlist_count(conn, user_id) > int(limit):
        check_limit(entitlements, "max_focus_playlists", int(limit))
    if not _active_playlist_url(conn, user_id):
        _set_active_playlist_url(conn, user_id, spotify_url)
    return _list_user_playlists_conn(conn, user_id)


def add_user_playlist(user_id, url, *, entitlements=None):
    if entitlements is None:
        entitlements = entitlements_for_user(user_id)
    with db_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        return _add_user_playlist_conn(conn, user_id, url, entitlements)


def _remove_user_playlist_conn(conn, user_id, url):
    user_id = str(user_id)
    spotify_url = normalize_playlist_url(url)
    conn.execute(
        """DELETE FROM focus_playlists
           WHERE owner_type='user' AND owner_id=? AND spotify_url=?""",
        [user_id, spotify_url],
    )
    if _active_playlist_url(conn, user_id) == spotify_url:
        remaining = _list_user_playlists_conn(conn, user_id)
        next_active = remaining[0]["spotify_url"] if remaining else None
        _set_active_playlist_url(conn, user_id, next_active)
    return _list_user_playlists_conn(conn, user_id)


def remove_user_playlist(user_id, url):
    with db_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        return _remove_user_playlist_conn(conn, user_id, url)


def _set_active_playlist_conn(conn, user_id, url):
    user_id = str(user_id)
    spotify_url = normalize_playlist_url(url) if url else None
    if spotify_url:
        exists = conn.execute(
            """SELECT 1 FROM focus_playlists
               WHERE owner_type='user' AND owner_id=? AND spotify_url=?""",
            [user_id, spotify_url],
        ).fetchone()
        if not exists:
            raise ValueError("Add that playlist before selecting it.")
    _set_active_playlist_url(conn, user_id, spotify_url)
    return _user_playlist_source_conn(conn, user_id)


def set_active_playlist(user_id, url):
    with db_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        return _set_active_playlist_conn(conn, user_id, url)


def _user_playlist_source_conn(conn, user_id):
    active_url = _active_playlist_url(conn, user_id)
    playlists = _list_playlists(
        conn, "user", str(user_id), active_url=active_url, user_id=user_id,
    )
    return {"spotify_url": active_url, "playlists": playlists}


def user_playlist_source(user_id):
    with db_connection() as conn:
        return _user_playlist_source_conn(conn, user_id)


def playlist_entitlements(entitlements, *, user_id=None, usage=None):
    limits = entitlements.get("limits") or {}
    if usage is None:
        if user_id is not None:
            with db_connection() as conn:
                usage = _user_playlist_count(conn, user_id)
        else:
            usage = int((entitlements.get("usage") or {}).get("focus_playlists") or 0)
    return {
        "limit": limits.get("max_focus_playlists"),
        "usage": int(usage or 0),
    }


def _list_playlists(conn, owner_type, owner_id, *, active_url=None, legacy_url=None, user_id=None):
    rows = conn.execute(
        """SELECT * FROM focus_playlists WHERE owner_type=? AND owner_id=?
           ORDER BY position,created_at""",
        [owner_type, str(owner_id)],
    ).fetchall()
    if not rows and legacy_url and owner_type != "user":
        metadata = _playlist_metadata(legacy_url)
        conn.execute(
            """INSERT OR IGNORE INTO focus_playlists
               (id,user_id,owner_type,owner_id,spotify_url,title,creator,thumbnail_url,position,created_at)
               VALUES (?,?,?,?,?,?,?,?,0,?)""",
            [
                _identifier(), str(user_id), owner_type, str(owner_id), legacy_url,
                metadata["title"], metadata["creator"], metadata["thumbnail_url"], _iso(_now()),
            ],
        )
        rows = conn.execute(
            """SELECT * FROM focus_playlists WHERE owner_type=? AND owner_id=?
               ORDER BY position,created_at""",
            [owner_type, str(owner_id)],
        ).fetchall()
    return [_playlist_payload(row, active_url=active_url) for row in rows]


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


def _serialize_routine(row, conn=None, playlists=None):
    if not row:
        return None
    routine = _row_dict(row)
    routine["playlist_provider"] = playlist_provider(routine.get("spotify_url"))
    routine["spotify_embed_url"] = playlist_embed_url(routine.get("spotify_url"))
    routine["embed_url"] = routine["spotify_embed_url"]
    active_url = routine.get("spotify_url")
    if playlists is not None:
        routine["playlists"] = _mark_playlist_active(playlists, active_url)
    elif conn:
        active_url = active_url or _active_playlist_url(conn, routine["user_id"])
        routine["playlists"] = _list_playlists(
            conn, "user", routine["user_id"], active_url=active_url, user_id=routine["user_id"],
        )
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


def _serialize_session(row, now=None, conn=None, playlists=None):
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
    session["playlist_provider"] = playlist_provider(session.get("spotify_url"))
    session["spotify_embed_url"] = playlist_embed_url(session.get("spotify_url"))
    session["embed_url"] = session["spotify_embed_url"]
    active_url = session.get("spotify_url")
    if playlists is not None:
        session["playlists"] = _mark_playlist_active(
            playlists, active_url or (playlists[0].get("spotify_url") if playlists else None),
        )
    elif conn:
        active_url = active_url or _active_playlist_url(conn, session["user_id"])
        session["playlists"] = _list_playlists(
            conn, "user", session["user_id"], active_url=active_url, user_id=session["user_id"],
        )
    return session


def list_routines(user_id):
    with db_connection() as conn:
        library = _list_playlists(
            conn, "user", str(user_id), active_url=None, user_id=str(user_id),
        )
        rows = conn.execute(
            """SELECT * FROM focus_routines WHERE user_id=?
               ORDER BY COALESCE(last_used_at, updated_at, created_at) DESC, name COLLATE NOCASE""",
            [str(user_id)],
        ).fetchall()
        return [_serialize_routine(row, playlists=library) for row in rows]


def save_routine(user_id, payload, routine_id=None):
    values = _routine_payload(payload)
    now = _iso(_now())
    user_id = str(user_id)
    with db_connection() as conn:
        if not values["spotify_url"]:
            values["spotify_url"] = _active_playlist_url(conn, user_id)
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
        return _serialize_routine(row, conn=conn)


def delete_routine(user_id, routine_id):
    with db_connection() as conn:
        result = conn.execute(
            "DELETE FROM focus_routines WHERE id=? AND user_id=?",
            [str(routine_id), str(user_id)],
        )
        if result.rowcount:
            conn.execute(
                "DELETE FROM focus_playlists WHERE owner_type='routine' AND owner_id=?",
                [str(routine_id)],
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
        return _serialize_session(row, now=now, conn=conn)


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
        return _serialize_session(row, now=now, conn=conn)


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
        if not values["spotify_url"]:
            values["spotify_url"] = _active_playlist_url(conn, user_id)
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
        return _serialize_session(row, now=now, conn=conn)


def update_session(user_id, session_id, action, payload=None, *, entitlements=None):
    user_id = str(user_id)
    payload = payload or {}
    now = _now()
    if entitlements is None:
        entitlements = entitlements_for_user(user_id)
    with db_connection() as conn:
        if action in {"set_playlist", "remove_playlist", "restore_playlist"}:
            conn.execute("BEGIN IMMEDIATE")
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
            if spotify_url:
                _add_user_playlist_conn(conn, user_id, spotify_url, entitlements)
                _set_active_playlist_conn(conn, user_id, spotify_url)
            else:
                _set_active_playlist_url(conn, user_id, None)
            conn.execute(
                "UPDATE focus_sessions SET spotify_url=?,updated_at=? WHERE id=?",
                [spotify_url, _iso(now), row["id"]],
            )
        elif action == "remove_playlist":
            if row["state"] not in ACTIVE_STATES:
                raise ValueError("This Focus Mode session is no longer active.")
            spotify_url = normalize_spotify_url(payload.get("spotify_url"))
            _remove_user_playlist_conn(conn, user_id, spotify_url)
            active_url = _active_playlist_url(conn, user_id)
            conn.execute(
                "UPDATE focus_sessions SET spotify_url=?,updated_at=? WHERE id=?",
                [active_url, _iso(now), row["id"]],
            )
        elif action == "restore_playlist":
            if row["state"] not in ACTIVE_STATES:
                raise ValueError("This Focus Mode session is no longer active.")
            spotify_url = normalize_playlist_url(payload.get("spotify_url"))
            active_url = normalize_playlist_url(payload.get("active_spotify_url"))
            if spotify_url:
                _add_user_playlist_conn(conn, user_id, spotify_url, entitlements)
            selected_url = active_url or spotify_url
            if selected_url:
                _set_active_playlist_conn(conn, user_id, selected_url)
            else:
                _set_active_playlist_url(conn, user_id, None)
            session_url = _active_playlist_url(conn, user_id)
            conn.execute(
                "UPDATE focus_sessions SET spotify_url=?,updated_at=? WHERE id=?",
                [session_url, _iso(now), row["id"]],
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
        return _serialize_session(updated, now=now, conn=conn)


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


def player_preferences(user_id):
    with db_connection() as conn:
        row = conn.execute(
            """SELECT layout,floating_size,floating_x,floating_y,panel_width,panel_height
               FROM focus_player_preferences WHERE user_id=?""",
            [str(user_id)],
        ).fetchone()
    if not row:
        return {
            "layout": "beside",
            "floating_size": "compact",
            "floating_x": 1.0,
            "floating_y": 1.0,
            "panel_width": 0,
            "panel_height": 0,
        }
    return {
        "layout": row["layout"] if row["layout"] in SPOTIFY_LAYOUTS else "beside",
        "floating_size": row["floating_size"] if row["floating_size"] in SPOTIFY_FLOATING_SIZES else "compact",
        "floating_x": min(1.0, max(0.0, float(row["floating_x"]))),
        "floating_y": min(1.0, max(0.0, float(row["floating_y"]))),
        "panel_width": max(0, float(row["panel_width"])),
        "panel_height": max(0, float(row["panel_height"])),
    }


def save_player_preferences(user_id, payload):
    current = player_preferences(user_id)
    layout = str(payload.get("layout", current["layout"])).strip().lower()
    floating_size = str(payload.get("floating_size", current["floating_size"])).strip().lower()
    if layout not in SPOTIFY_LAYOUTS:
        raise ValueError("Player placement is not valid.")
    if floating_size not in SPOTIFY_FLOATING_SIZES:
        raise ValueError("Player size is not valid.")
    try:
        floating_x = float(payload.get("floating_x", current["floating_x"]))
        floating_y = float(payload.get("floating_y", current["floating_y"]))
        panel_width = float(payload.get("panel_width", current["panel_width"]))
        panel_height = float(payload.get("panel_height", current["panel_height"]))
    except (TypeError, ValueError) as exc:
        raise ValueError("Player position or size is not valid.") from exc
    floating_x = min(1.0, max(0.0, floating_x))
    floating_y = min(1.0, max(0.0, floating_y))
    panel_width = 0 if panel_width <= 0 else min(2400, max(240, panel_width))
    panel_height = 0 if panel_height <= 0 else min(1800, max(220, panel_height))
    now = _iso(_now())
    with db_connection() as conn:
        conn.execute(
            """INSERT INTO focus_player_preferences
               (user_id,layout,floating_size,floating_x,floating_y,panel_width,panel_height,updated_at)
               VALUES (?,?,?,?,?,?,?,?)
               ON CONFLICT(user_id) DO UPDATE SET layout=excluded.layout,
               floating_size=excluded.floating_size,floating_x=excluded.floating_x,
               floating_y=excluded.floating_y,panel_width=excluded.panel_width,
               panel_height=excluded.panel_height,updated_at=excluded.updated_at""",
            [str(user_id), layout, floating_size, floating_x, floating_y, panel_width, panel_height, now],
        )
    return player_preferences(user_id)


def snapshot(user_id, *, entitlements=None):
    if entitlements is None:
        entitlements = entitlements_for_user(user_id)
    user_id = str(user_id)
    now = _now()
    with db_connection() as conn:
        source = _user_playlist_source_conn(conn, user_id)
        library = source["playlists"]
        usage = len(library)

        row = conn.execute(
            """SELECT * FROM focus_sessions WHERE user_id=? AND state IN ('running','paused')
               ORDER BY started_at DESC LIMIT 1""",
            [user_id],
        ).fetchone()
        if row:
            row = _reconcile(conn, row, now=now)
        if row and row["state"] not in ACTIVE_STATES:
            row = None
        active_session = _serialize_session(row, now=now, playlists=library)

        routine_rows = conn.execute(
            """SELECT * FROM focus_routines WHERE user_id=?
               ORDER BY COALESCE(last_used_at, updated_at, created_at) DESC, name COLLATE NOCASE""",
            [user_id],
        ).fetchall()
        routines = [_serialize_routine(routine_row, playlists=library) for routine_row in routine_rows]

        history_rows = conn.execute(
            """SELECT e.*,s.routine_name FROM focus_session_events e
               LEFT JOIN focus_sessions s ON s.id=e.session_id
               WHERE e.user_id=? ORDER BY e.completed_at DESC LIMIT ?""",
            [user_id, 30],
        ).fetchall()
        history = [_row_dict(history_row) for history_row in history_rows]

        recent_rows = conn.execute(
            """SELECT focus_seconds,break_seconds,long_break_seconds,total_cycles,spotify_url,
                      MAX(started_at) AS last_used_at
               FROM focus_sessions WHERE user_id=?
               GROUP BY focus_seconds,break_seconds,long_break_seconds,total_cycles,spotify_url
               ORDER BY last_used_at DESC LIMIT ?""",
            [user_id, 6],
        ).fetchall()
        recent = [
            {
                "focus_minutes": int(recent_row["focus_seconds"]) // 60,
                "break_minutes": int(recent_row["break_seconds"] or 0) // 60,
                "long_break_minutes": int(recent_row["long_break_seconds"] or 0) // 60,
                "cycles": int(recent_row["total_cycles"] or 1),
                "spotify_url": recent_row["spotify_url"],
                "last_used_at": recent_row["last_used_at"],
            }
            for recent_row in recent_rows
        ]

        prefs_row = conn.execute(
            """SELECT layout,floating_size,floating_x,floating_y,panel_width,panel_height
               FROM focus_player_preferences WHERE user_id=?""",
            [user_id],
        ).fetchone()

    if not prefs_row:
        preferences = {
            "layout": "beside",
            "floating_size": "compact",
            "floating_x": 1.0,
            "floating_y": 1.0,
            "panel_width": 0,
            "panel_height": 0,
        }
    else:
        preferences = {
            "layout": prefs_row["layout"] if prefs_row["layout"] in SPOTIFY_LAYOUTS else "beside",
            "floating_size": (
                prefs_row["floating_size"]
                if prefs_row["floating_size"] in SPOTIFY_FLOATING_SIZES
                else "compact"
            ),
            "floating_x": min(1.0, max(0.0, float(prefs_row["floating_x"]))),
            "floating_y": min(1.0, max(0.0, float(prefs_row["floating_y"]))),
            "panel_width": max(0, float(prefs_row["panel_width"])),
            "panel_height": max(0, float(prefs_row["panel_height"])),
        }

    return {
        "active_session": active_session,
        "routines": routines,
        "history": history,
        "recent_selections": recent,
        "player_preferences": preferences,
        "playlists": library,
        "active_playlist_url": source["spotify_url"],
        "playlist_entitlements": playlist_entitlements(entitlements, usage=usage),
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
