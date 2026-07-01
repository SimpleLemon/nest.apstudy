PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    google_id TEXT NOT NULL,
    email TEXT NOT NULL,
    name TEXT,
    username TEXT,
    picture_url TEXT,
    school TEXT,
    school_key TEXT,
    school_source TEXT,
    scorecard_id TEXT,
    major TEXT,
    graduation_year TEXT,
    banner_color TEXT DEFAULT '#fecae1',
    avatar_file_id TEXT,
    avatar_source TEXT,
    onboarding_complete INTEGER NOT NULL DEFAULT 0,
    onboarding_step INTEGER NOT NULL DEFAULT 1,
    education_level TEXT,
    class_year TEXT,
    emory_student INTEGER,
    emory_email TEXT,
    created_at TEXT NOT NULL,
    last_login TEXT,
    provider TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_school_key ON users(school_key);

CREATE TABLE IF NOT EXISTS user_settings (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    canvas_ical_url TEXT,
    other_ical_urls_json TEXT,
    ics_secret_token TEXT,
    feed_refresh_minutes INTEGER NOT NULL DEFAULT 15,
    preferred_calendar_view TEXT NOT NULL DEFAULT 'week',
    interface_theme TEXT DEFAULT 'obsidian-dark',
    theme TEXT DEFAULT 'dark',
    sidebar_default TEXT DEFAULT 'expanded',
    email_notifications INTEGER NOT NULL DEFAULT 1,
    product_updates INTEGER NOT NULL DEFAULT 1,
    task_sound_enabled INTEGER NOT NULL DEFAULT 1,
    chat_sound_enabled INTEGER NOT NULL DEFAULT 1,
    language TEXT DEFAULT 'en',
    timezone TEXT DEFAULT '',
    dashboard_layout_json TEXT,
    dashboard_checklist_hidden_signature TEXT,
    notes_page_setup_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_settings_user_id ON user_settings(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_settings_token ON user_settings(ics_secret_token);

CREATE TABLE IF NOT EXISTS user_courses (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    term TEXT NOT NULL,
    subject TEXT NOT NULL,
    catalog TEXT NOT NULL,
    course_name TEXT,
    section_number TEXT,
    instructor_name TEXT,
    source TEXT NOT NULL DEFAULT 'settings',
    crn TEXT DEFAULT '',
    added_at TEXT NOT NULL,
    color_key TEXT,
    course_overrides_json TEXT,
    updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_user_courses_user_id ON user_courses(user_id);
CREATE INDEX IF NOT EXISTS idx_user_courses_term ON user_courses(term);
CREATE INDEX IF NOT EXISTS idx_user_courses_subject ON user_courses(subject);
CREATE INDEX IF NOT EXISTS idx_user_courses_catalog ON user_courses(catalog);
CREATE INDEX IF NOT EXISTS idx_user_courses_crn ON user_courses(crn);
CREATE INDEX IF NOT EXISTS idx_user_courses_source ON user_courses(source);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_courses_unique
    ON user_courses(user_id, term, subject, catalog, crn);

CREATE TABLE IF NOT EXISTS course_seat_tracks (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    term TEXT NOT NULL,
    subject TEXT NOT NULL,
    catalog TEXT NOT NULL,
    crn TEXT DEFAULT '',
    section_id TEXT,
    course_code TEXT,
    course_title TEXT,
    last_status TEXT,
    last_seats_available INTEGER,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_checked_at TEXT,
    last_notified_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_course_tracks_user_id ON course_seat_tracks(user_id);
CREATE INDEX IF NOT EXISTS idx_course_tracks_enabled ON course_seat_tracks(enabled);
CREATE INDEX IF NOT EXISTS idx_course_tracks_section ON course_seat_tracks(section_id);
CREATE INDEX IF NOT EXISTS idx_course_tracks_lookup ON course_seat_tracks(term, subject, catalog);
CREATE INDEX IF NOT EXISTS idx_course_tracks_last_checked ON course_seat_tracks(last_checked_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_course_tracks_unique
    ON course_seat_tracks(user_id, term, subject, catalog, crn);

CREATE TABLE IF NOT EXISTS calendar_cache (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    feed_url TEXT,
    feed_url_hash TEXT,
    event_uid TEXT,
    event_title TEXT,
    event_start TEXT,
    event_end TEXT,
    is_all_day INTEGER NOT NULL DEFAULT 0,
    event_type TEXT,
    course_name TEXT,
    raw_description TEXT,
    fetched_at TEXT,
    UNIQUE(user_id, feed_url_hash, event_uid)
);

CREATE INDEX IF NOT EXISTS idx_calendar_cache_user_id ON calendar_cache(user_id);
CREATE INDEX IF NOT EXISTS idx_calendar_cache_feed_hash ON calendar_cache(feed_url_hash);
CREATE INDEX IF NOT EXISTS idx_calendar_cache_user_feed ON calendar_cache(user_id, feed_url_hash);
CREATE INDEX IF NOT EXISTS idx_calendar_cache_event_start ON calendar_cache(event_start);
CREATE INDEX IF NOT EXISTS idx_calendar_cache_fetched_at ON calendar_cache(fetched_at);

CREATE TABLE IF NOT EXISTS calendar_feeds (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    feed_url TEXT NOT NULL,
    feed_url_hash TEXT NOT NULL,
    calendar_name TEXT,
    etag_header TEXT,
    last_modified_header TEXT,
    last_fetch_http_code INTEGER,
    last_fetched TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT,
    UNIQUE(user_id, feed_url_hash)
);

CREATE INDEX IF NOT EXISTS idx_calendar_feeds_user_id ON calendar_feeds(user_id);
CREATE INDEX IF NOT EXISTS idx_calendar_feeds_feed_hash ON calendar_feeds(feed_url_hash);
CREATE INDEX IF NOT EXISTS idx_calendar_feeds_last_fetched ON calendar_feeds(last_fetched);

CREATE TABLE IF NOT EXISTS user_calendar_preferences (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    calendar_name TEXT NOT NULL,
    display_name TEXT,
    color_hex TEXT DEFAULT '#6366f1',
    visible INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT,
    UNIQUE(user_id, calendar_name)
);

CREATE INDEX IF NOT EXISTS idx_user_calendar_prefs_user_id ON user_calendar_preferences(user_id);
CREATE INDEX IF NOT EXISTS idx_user_calendar_prefs_name ON user_calendar_preferences(calendar_name);

CREATE TABLE IF NOT EXISTS user_events (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    start TEXT NOT NULL,
    end TEXT NOT NULL,
    is_all_day INTEGER NOT NULL DEFAULT 0,
    color TEXT,
    calendar_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_user_events_user_id ON user_events(user_id);
CREATE INDEX IF NOT EXISTS idx_user_events_start ON user_events(start);
CREATE INDEX IF NOT EXISTS idx_user_events_calendar ON user_events(calendar_id);

CREATE TABLE IF NOT EXISTS user_calendar_sources (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    kind TEXT DEFAULT 'local',
    default_name TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT,
    UNIQUE(user_id, source_id)
);

CREATE INDEX IF NOT EXISTS idx_user_calendar_sources_user ON user_calendar_sources(user_id);
CREATE INDEX IF NOT EXISTS idx_user_calendar_sources_source ON user_calendar_sources(source_id);

CREATE TABLE IF NOT EXISTS user_event_overrides (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    event_ref TEXT NOT NULL,
    hidden INTEGER NOT NULL DEFAULT 0,
    title TEXT,
    description TEXT,
    start TEXT,
    end TEXT,
    is_all_day INTEGER,
    calendar_id TEXT,
    color TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT,
    UNIQUE(user_id, event_ref)
);

CREATE INDEX IF NOT EXISTS idx_user_event_overrides_user ON user_event_overrides(user_id);
CREATE INDEX IF NOT EXISTS idx_user_event_overrides_ref ON user_event_overrides(event_ref);
CREATE INDEX IF NOT EXISTS idx_user_event_overrides_calendar ON user_event_overrides(calendar_id);

CREATE TABLE IF NOT EXISTS calendar_shares (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    share_code TEXT NOT NULL UNIQUE,
    is_active INTEGER NOT NULL DEFAULT 1,
    include_all_calendars INTEGER NOT NULL DEFAULT 1,
    calendar_ids_json TEXT,
    date_scope TEXT NOT NULL DEFAULT 'all',
    fixed_start TEXT,
    fixed_end TEXT,
    rolling_days INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_calendar_shares_user ON calendar_shares(user_id);
CREATE INDEX IF NOT EXISTS idx_calendar_shares_code ON calendar_shares(share_code);
CREATE INDEX IF NOT EXISTS idx_calendar_shares_active ON calendar_shares(is_active);

CREATE TABLE IF NOT EXISTS daily_quotes (
    id TEXT PRIMARY KEY,
    quote_date TEXT NOT NULL,
    quote_text TEXT NOT NULL,
    author TEXT,
    source TEXT DEFAULT 'zenquotes',
    source_url TEXT,
    raw_payload TEXT,
    fetched_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_quotes_date ON daily_quotes(quote_date);
CREATE INDEX IF NOT EXISTS idx_daily_quotes_fetched_at ON daily_quotes(fetched_at);

CREATE TABLE IF NOT EXISTS task_lists (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    "order" INTEGER,
    collapsed INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0,
    sort_mode TEXT DEFAULT 'default',
    created_at TEXT NOT NULL,
    updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_task_lists_user ON task_lists(user_id);
CREATE INDEX IF NOT EXISTS idx_task_lists_user_hidden ON task_lists(user_id, hidden);
CREATE INDEX IF NOT EXISTS idx_task_lists_order ON task_lists("order");

CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    list_id TEXT NOT NULL,
    title TEXT NOT NULL,
    priority TEXT DEFAULT 'none',
    deadline_at TEXT,
    deadline_time TEXT,
    timezone TEXT,
    recurrence_json TEXT,
    "order" INTEGER,
    completed INTEGER NOT NULL DEFAULT 0,
    completed_at TEXT,
    starred INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_list ON tasks(list_id);
CREATE INDEX IF NOT EXISTS idx_tasks_user_list ON tasks(user_id, list_id);
CREATE INDEX IF NOT EXISTS idx_tasks_user_starred ON tasks(user_id, starred);
CREATE INDEX IF NOT EXISTS idx_tasks_deadline ON tasks(deadline_at);
CREATE INDEX IF NOT EXISTS idx_tasks_order ON tasks("order");

CREATE TABLE IF NOT EXISTS task_completions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    occurrence_key TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    UNIQUE(user_id, task_id, occurrence_key)
);

CREATE INDEX IF NOT EXISTS idx_task_completions_user ON task_completions(user_id);
CREATE INDEX IF NOT EXISTS idx_task_completions_task ON task_completions(task_id);
CREATE INDEX IF NOT EXISTS idx_task_completions_occurrence ON task_completions(occurrence_key);

CREATE TABLE IF NOT EXISTS shared_files (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    folder_id TEXT,
    original_filename TEXT NOT NULL,
    stored_path TEXT NOT NULL,
    storage_backend TEXT DEFAULT 'appwrite',
    storage_bucket_id TEXT,
    storage_file_id TEXT,
    file_size_bytes INTEGER NOT NULL,
    mime_type TEXT,
    share_code TEXT UNIQUE,
    is_public INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT,
    downloaded_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_shared_files_user_id ON shared_files(user_id);
CREATE INDEX IF NOT EXISTS idx_shared_files_folder_id ON shared_files(folder_id);
CREATE INDEX IF NOT EXISTS idx_shared_files_user_folder ON shared_files(user_id, folder_id);
CREATE INDEX IF NOT EXISTS idx_shared_files_expires_at ON shared_files(expires_at);
CREATE INDEX IF NOT EXISTS idx_shared_files_created_at ON shared_files(created_at);
CREATE INDEX IF NOT EXISTS idx_shared_files_storage_file ON shared_files(storage_file_id);
CREATE INDEX IF NOT EXISTS idx_shared_files_share_code ON shared_files(share_code);
CREATE INDEX IF NOT EXISTS idx_shared_files_is_public ON shared_files(is_public);

CREATE TABLE IF NOT EXISTS file_folders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    parent_folder_id TEXT,
    is_public INTEGER NOT NULL DEFAULT 0,
    share_code TEXT UNIQUE,
    "order" INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_file_folders_user_id ON file_folders(user_id);
CREATE INDEX IF NOT EXISTS idx_file_folders_parent ON file_folders(parent_folder_id);
CREATE INDEX IF NOT EXISTS idx_file_folders_user_parent ON file_folders(user_id, parent_folder_id);
CREATE INDEX IF NOT EXISTS idx_file_folders_order ON file_folders("order");
CREATE INDEX IF NOT EXISTS idx_file_folders_share_code ON file_folders(share_code);
CREATE INDEX IF NOT EXISTS idx_file_folders_is_public ON file_folders(is_public);

CREATE TABLE IF NOT EXISTS note_folders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    parent_folder_id TEXT,
    icon TEXT,
    "order" INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_note_folders_user_id ON note_folders(user_id);
CREATE INDEX IF NOT EXISTS idx_note_folders_parent ON note_folders(parent_folder_id);
CREATE INDEX IF NOT EXISTS idx_note_folders_order ON note_folders("order");

CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    folder_id TEXT,
    title TEXT,
    content TEXT,
    page_setup_json TEXT,
    content_type TEXT DEFAULT 'markdown',
    is_pinned INTEGER NOT NULL DEFAULT 0,
    is_archived INTEGER NOT NULL DEFAULT 0,
    "order" INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_notes_user_folder_order ON notes(user_id, folder_id, "order");
CREATE INDEX IF NOT EXISTS idx_notes_user_order ON notes(user_id, "order");
CREATE INDEX IF NOT EXISTS idx_notes_user_pinned ON notes(user_id, is_pinned);
CREATE INDEX IF NOT EXISTS idx_notes_user_archived ON notes(user_id, is_archived);

CREATE TABLE IF NOT EXISTS chat_channels (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    label TEXT,
    section TEXT DEFAULT 'nest',
    school_key TEXT,
    school_name TEXT,
    discord_channel_id TEXT,
    read_only INTEGER NOT NULL DEFAULT 0,
    approved INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_chat_channels_kind ON chat_channels(kind);
CREATE INDEX IF NOT EXISTS idx_chat_channels_school ON chat_channels(school_key);
CREATE INDEX IF NOT EXISTS idx_chat_channels_discord ON chat_channels(discord_channel_id);
CREATE INDEX IF NOT EXISTS idx_chat_channels_approved ON chat_channels(approved);

CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT,
    thread_id TEXT,
    source TEXT DEFAULT 'appwrite',
    external_id TEXT,
    user_id TEXT,
    author_name TEXT,
    author_username TEXT,
    author_avatar_url TEXT,
    content TEXT,
    rendered_html TEXT,
    link_preview_json TEXT,
    discord_message_id TEXT,
    discord_webhook_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT,
    deleted_at TEXT,
    deleted_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_channel ON chat_messages(channel_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_user ON chat_messages(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created ON chat_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_chat_messages_external ON chat_messages(external_id);

CREATE TABLE IF NOT EXISTS chat_dm_threads (
    id TEXT PRIMARY KEY,
    participant_a TEXT NOT NULL,
    participant_b TEXT NOT NULL,
    participant_key TEXT NOT NULL UNIQUE,
    last_message_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_chat_dm_participant_a ON chat_dm_threads(participant_a);
CREATE INDEX IF NOT EXISTS idx_chat_dm_participant_b ON chat_dm_threads(participant_b);
CREATE INDEX IF NOT EXISTS idx_chat_dm_last_message ON chat_dm_threads(last_message_at);

CREATE TABLE IF NOT EXISTS chat_blocks (
    id TEXT PRIMARY KEY,
    blocker_id TEXT NOT NULL,
    blocked_id TEXT NOT NULL,
    block_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_blocks_blocker ON chat_blocks(blocker_id);
CREATE INDEX IF NOT EXISTS idx_chat_blocks_blocked ON chat_blocks(blocked_id);

CREATE TABLE IF NOT EXISTS chat_presence (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    scope_type TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    presence_key TEXT NOT NULL UNIQUE,
    last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_presence_scope ON chat_presence(scope_type, scope_id);
CREATE INDEX IF NOT EXISTS idx_chat_presence_user ON chat_presence(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_presence_seen ON chat_presence(last_seen_at);

CREATE TABLE IF NOT EXISTS chat_read_states (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    scope_type TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    read_key TEXT NOT NULL UNIQUE,
    last_read_message_id TEXT,
    last_read_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_chat_read_user ON chat_read_states(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_read_scope ON chat_read_states(scope_type, scope_id);

CREATE TABLE IF NOT EXISTS chat_events (
    id TEXT PRIMARY KEY,
    scope_type TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    message_id TEXT,
    thread_id TEXT,
    channel_id TEXT,
    actor_id TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_events_scope ON chat_events(scope_type, scope_id);
CREATE INDEX IF NOT EXISTS idx_chat_events_type ON chat_events(event_type);
CREATE INDEX IF NOT EXISTS idx_chat_events_created ON chat_events(created_at);
CREATE INDEX IF NOT EXISTS idx_chat_events_actor ON chat_events(actor_id);

CREATE TABLE IF NOT EXISTS chat_link_previews (
    id TEXT PRIMARY KEY,
    url_hash TEXT NOT NULL UNIQUE,
    url TEXT NOT NULL,
    title TEXT,
    description TEXT,
    image_url TEXT,
    site_name TEXT,
    content_type TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS chat_bridge_config (
    id TEXT PRIMARY KEY,
    config_key TEXT NOT NULL UNIQUE,
    config_value TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS admin_requests (
    id TEXT PRIMARY KEY,
    request_type TEXT NOT NULL,
    label TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    school_key TEXT,
    school_name TEXT,
    requested_by TEXT,
    request_count INTEGER DEFAULT 1,
    last_requested_at TEXT,
    resolved_by TEXT,
    resolved_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_admin_requests_type ON admin_requests(request_type);
CREATE INDEX IF NOT EXISTS idx_admin_requests_status ON admin_requests(status);
CREATE INDEX IF NOT EXISTS idx_admin_requests_school ON admin_requests(school_key);
CREATE INDEX IF NOT EXISTS idx_admin_requests_created ON admin_requests(created_at);

CREATE TABLE IF NOT EXISTS dashboard_widgets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    widget_type TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    config_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_dashboard_widgets_user ON dashboard_widgets(user_id);
CREATE INDEX IF NOT EXISTS idx_dashboard_widgets_user_position ON dashboard_widgets(user_id, position);

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES ('001_initial_schema', datetime('now'));
