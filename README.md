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
