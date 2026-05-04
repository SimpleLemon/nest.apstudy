"""
SQLite schema -> Appwrite collection mapping reference

Table: users
- id INTEGER PRIMARY KEY -> Appwrite integer attribute: id (unique), use $id for Appwrite doc id
- google_id VARCHAR(255) UNIQUE NOT NULL -> string(255) attribute: google_id (unique)
- email VARCHAR(255) UNIQUE NOT NULL -> string(255) attribute: email (unique)
- name VARCHAR(255) -> string(255) attribute: name
- picture_url TEXT -> text attribute: picture_url
- onboarding_complete BOOLEAN NOT NULL DEFAULT 0 -> boolean attribute: onboarding_complete
- onboarding_step INTEGER NOT NULL DEFAULT 1 -> integer attribute: onboarding_step
- education_level VARCHAR(32) -> string(32) attribute: education_level
- class_year VARCHAR(64) -> string(64) attribute: class_year
- emory_student BOOLEAN -> boolean attribute: emory_student
- emory_email VARCHAR(255) -> string(255) attribute: emory_email
- created_at DATETIME NOT NULL -> datetime attribute: created_at
- last_login DATETIME -> datetime attribute: last_login

Table: user_settings
- user_id INTEGER PRIMARY KEY FK users.id -> integer attribute: user_id (unique)
- canvas_ical_url TEXT -> text attribute: canvas_ical_url
- other_ical_urls_json TEXT -> text attribute: other_ical_urls_json
- ics_secret_token VARCHAR(255) UNIQUE -> string(255) attribute: ics_secret_token (unique)
- feed_refresh_minutes INTEGER NOT NULL DEFAULT 15 -> integer attribute: feed_refresh_minutes
- preferred_calendar_view VARCHAR(16) NOT NULL DEFAULT 'week' -> string(16) attribute: preferred_calendar_view
- interface_theme VARCHAR(32) DEFAULT 'system-match' -> string(32) attribute: interface_theme
- created_at DATETIME NOT NULL -> datetime attribute: created_at
- updated_at DATETIME -> datetime attribute: updated_at

Table: user_courses
- id INTEGER PRIMARY KEY -> integer attribute: id (unique)
- user_id INTEGER FK users.id -> integer attribute: user_id
- term VARCHAR(64) NOT NULL -> string(64) attribute: term
- subject VARCHAR(64) NOT NULL -> string(64) attribute: subject
- catalog VARCHAR(64) NOT NULL -> string(64) attribute: catalog
- course_name VARCHAR(255) -> string(255) attribute: course_name
- section_number VARCHAR(64) -> string(64) attribute: section_number
- instructor_name VARCHAR(255) -> string(255) attribute: instructor_name
- source VARCHAR(32) NOT NULL DEFAULT 'settings' -> string(32) attribute: source
- crn VARCHAR(64) -> string(64) attribute: crn
- added_at DATETIME NOT NULL -> datetime attribute: added_at
- UNIQUE (user_id, term, subject, catalog, crn)

Table: calendar_cache
- id INTEGER PRIMARY KEY -> integer attribute: id (unique)
- user_id INTEGER FK users.id -> integer attribute: user_id
- event_uid VARCHAR(255) -> string(255) attribute: event_uid
- event_title TEXT -> text attribute: event_title
- event_start DATETIME -> datetime attribute: event_start
- event_end DATETIME -> datetime attribute: event_end
- is_all_day BOOLEAN NOT NULL DEFAULT 0 -> boolean attribute: is_all_day
- event_type VARCHAR(64) -> string(64) attribute: event_type
- course_name VARCHAR(255) -> string(255) attribute: course_name
- raw_description TEXT -> text attribute: raw_description
- fetched_at DATETIME -> datetime attribute: fetched_at
- UNIQUE (user_id, event_uid)

Table: user_calendar_preferences
- id INTEGER PRIMARY KEY -> integer attribute: id (unique)
- user_id INTEGER FK users.id -> integer attribute: user_id
- calendar_name VARCHAR(255) -> string(255) attribute: calendar_name
- color_hex VARCHAR(7) NOT NULL DEFAULT '#6366f1' -> string(7) attribute: color_hex
- visible BOOLEAN NOT NULL DEFAULT 1 -> boolean attribute: visible
- created_at DATETIME -> datetime attribute: created_at
- updated_at DATETIME -> datetime attribute: updated_at
- UNIQUE (user_id, calendar_name)

Table: user_events
- id INTEGER PRIMARY KEY -> integer attribute: id (unique)
- user_id INTEGER FK users.id -> integer attribute: user_id
- title VARCHAR(255) NOT NULL -> string(255) attribute: title
- description TEXT -> text attribute: description
- start DATETIME NOT NULL -> datetime attribute: start
- end DATETIME NOT NULL -> datetime attribute: end
- is_all_day BOOLEAN NOT NULL DEFAULT 0 -> boolean attribute: is_all_day
- color VARCHAR(7) -> string(7) attribute: color
- created_at DATETIME NOT NULL -> datetime attribute: created_at
- updated_at DATETIME -> datetime attribute: updated_at

Table: shared_files
- id VARCHAR(36) PRIMARY KEY -> string(36) attribute: id (unique), use $id for Appwrite doc id
- user_id INTEGER FK users.id -> integer attribute: user_id
- original_filename VARCHAR(255) NOT NULL -> string(255) attribute: original_filename
- stored_path VARCHAR(512) NOT NULL -> string(512) attribute: stored_path
- file_size_bytes INTEGER NOT NULL -> integer attribute: file_size_bytes
- mime_type VARCHAR(127) -> string(127) attribute: mime_type
- share_code VARCHAR(10) UNIQUE -> string(10) attribute: share_code (unique)
- is_public BOOLEAN NOT NULL DEFAULT 0 -> boolean attribute: is_public
- expires_at DATETIME NOT NULL -> datetime attribute: expires_at
- created_at DATETIME NOT NULL -> datetime attribute: created_at
- downloaded_count INTEGER NOT NULL DEFAULT 0 -> integer attribute: downloaded_count
"""

# Appwrite client initialization is added in Phase 3.
