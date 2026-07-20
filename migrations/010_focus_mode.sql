CREATE TABLE IF NOT EXISTS focus_routines (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    focus_minutes INTEGER NOT NULL,
    break_minutes INTEGER NOT NULL DEFAULT 0,
    long_break_minutes INTEGER NOT NULL DEFAULT 0,
    cycles INTEGER NOT NULL DEFAULT 1,
    spotify_url TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT,
    last_used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_focus_routines_user
    ON focus_routines(user_id, last_used_at DESC, updated_at DESC);

CREATE TABLE IF NOT EXISTS focus_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    routine_id TEXT,
    routine_name TEXT,
    focus_seconds INTEGER NOT NULL,
    break_seconds INTEGER NOT NULL DEFAULT 0,
    long_break_seconds INTEGER NOT NULL DEFAULT 0,
    total_cycles INTEGER NOT NULL DEFAULT 1,
    completed_focus_cycles INTEGER NOT NULL DEFAULT 0,
    phase TEXT NOT NULL DEFAULT 'focus',
    state TEXT NOT NULL DEFAULT 'running',
    auto_start_next INTEGER NOT NULL DEFAULT 0,
    phase_started_at TEXT,
    phase_ends_at TEXT,
    paused_remaining_seconds INTEGER,
    spotify_url TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    ended_at TEXT,
    updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_focus_sessions_one_active
    ON focus_sessions(user_id) WHERE state IN ('running', 'paused');
CREATE INDEX IF NOT EXISTS idx_focus_sessions_user_history
    ON focus_sessions(user_id, started_at DESC);

CREATE TABLE IF NOT EXISTS focus_session_events (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    duration_seconds INTEGER NOT NULL,
    cycle_number INTEGER NOT NULL,
    completed_at TEXT NOT NULL,
    UNIQUE(session_id, phase, cycle_number)
);

CREATE INDEX IF NOT EXISTS idx_focus_events_user_history
    ON focus_session_events(user_id, completed_at DESC);
