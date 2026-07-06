<p align="center">
  <img src="https://resources.apstudy.org/images/AP-Resources-Logo.png" width="128" height="128" alt="APStudy Logo">
</p>

<h1 align="center">Nest.APStudy</h1>

<p align="center">
  Free web platform for course planning and student productivity.
</p>

<p align="center">
  <a href="https://nest.apstudy.org"><b>🌐 Nest.APStudy.org</b></a><br>
  <sub>Combines local Emory course data with productivity tools all-in-one</sub>
</p>

---

## Overview

Nest.APStudy is a web platform for student course planning and productivity, combining local Emory course data with user accounts, dashboards, calendars, tasks, notes, chat, file sharing, and related admin tools. User data is stored in VPS-hosted SQLite databases, with Appwrite handling authentication and file storage.

> **Note:** This project is under active development. Some features depend on external Appwrite, OAuth, Discord, or calendar-feed configuration that is intentionally not committed.

## Quick Start

1. Clone the repository
2. Create a virtual environment and install dependencies
3. Configure your `.env` file with the required credentials
4. Run the Flask app locally

## Repository Layout

| Path | Description |
|------|-------------|
| `app.py` | Creates the Flask application with `app:create_app()` |
| `blueprints/` | Flask route modules |
| `templates/` | Jinja templates |
| `static/css/` and `static/js/` | Frontend assets |
| `Spring_2026/` and `Fall_2026/` | Local course data |
| `services/` | Background and integration services |
| `instance/` | SQLite databases (not committed — created on deploy) |

## Requirements

- Python 3.11+
- Node.js and npm (for Tailwind and JavaScript tests)
- Appwrite credentials (for auth and file storage)
- SQLite 3.45+ (included with Python; CLI installed on VPS for backups)

## Appwrite storage buckets

The server uploads binary files to Appwrite Storage. Create these buckets in the Appwrite console (or point the env vars at existing bucket IDs) before enabling the related features:

| Env var | Default bucket ID | Used for |
|---------|-------------------|----------|
| `APPWRITE_PROFILE_AVATAR_BUCKET_ID` | `profile_avatars` | Profile avatar uploads |
| `APPWRITE_FILE_SHARE_BUCKET_ID` | `file_share_files` | File share uploads |
| `APPWRITE_NOTES_MEDIA_BUCKET_ID` | `notes_media` | Inline images in notes |

Mirror the working `profile_avatars` bucket settings (file security, max size, MIME allowlist). The server API key (`APPWRITE_API_KEY`) needs Storage create, read, and delete access on each bucket. Notes images are limited to 10 MiB (JPEG, PNG, GIF, WebP).

Verify bucket configuration from the repository root:

```bash
python scripts/verify_appwrite_storage.py
python scripts/verify_appwrite_storage.py --probe-upload
```

The probe uploads and deletes a 1x1 PNG in `notes_media` to confirm write access. Check server logs for `Failed to upload note media (code=...)` if uploads still return 500.

## Setup & Deployment

<details>
  <summary>Python environment</summary>

Create a virtual environment and install Python dependencies:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```
</details>

<details>
  <summary>Running Locally</summary>
  
Run the Flask app with the application factory:

```bash
flask --app app:create_app run --host 127.0.0.1 --port 8000
```

Or run the local development entrypoint:

```bash
python app.py
```

## Tests

Run the full test suite:

```bash
npm test
```
</details>

## AI Disclosure

This project is planned, designed, and directed by the developer. All architectural designs, features, and project direction were and are human-driven. AI tools acted as implementation agents:
- GitHub Education Copilot: Used at the start of the project for basic implementation
- OpenAI Codex: Structured database, created pages, and wrote code according to developer guidance

## License

Licensed under the [Business Source License 1.1](LICENSE).
