# Nest.APStudy

Nest.APStudy is a Flask web application for AP Study course planning and student productivity. It combines local Emory course data with Appwrite-backed user accounts, dashboards, calendars, tasks, notes, chat, file sharing, and related admin tools.

## Current Status

This project is under active development. The repository contains working Flask blueprints, Jinja templates, static JavaScript and CSS, Appwrite integration, local course JSON data for Spring 2026 and Fall 2026, and automated Python/JavaScript tests. Some features depend on external Appwrite, OAuth, Discord, or calendar-feed configuration that is intentionally not committed.

## Repository Layout

- `app.py` creates the Flask application with `app:create_app()`.
- `blueprints/` contains the Flask route modules.
- `templates/` contains Jinja templates.
- `static/css/` and `static/js/` contain frontend assets.
- `Spring_2026/` and `Fall_2026/` contain local course data.
- `services/` contains background and integration services.
- `tests/` contains Python and JavaScript tests.

## Requirements

- Python 3.11 or newer is recommended.
- Node.js and npm are required for Tailwind and JavaScript tests.
- Appwrite credentials are required for live auth, storage, and database workflows.

## Setup

Create a virtual environment and install Python dependencies:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Install Node dependencies:

```bash
npm install
```

Create a local `.env` file for secrets and environment-specific settings. Do not commit it. Common variables include:

```bash
FLASK_SECRET_KEY=
APPWRITE_ENDPOINT=
APPWRITE_PROJECT_ID=
APPWRITE_API_KEY=
APPWRITE_DATABASE_ID=
```

Additional integrations may use variables such as `DISCORD_BOT_TOKEN`, `GITHUB_WEBHOOK_SECRET`, and OAuth provider settings.

## Running Locally

Run the Flask app with the application factory:

```bash
flask --app app:create_app run --host 127.0.0.1 --port 8000
```

Or run the local development entrypoint:

```bash
python app.py
```

Build Tailwind CSS:

```bash
npm run build:css
```

Watch Tailwind CSS during frontend work:

```bash
npm run watch:css
```

## Tests

Run the full test suite:

```bash
npm test
```

Run Python tests only:

```bash
python -m unittest
```

Run JavaScript tests only:

```bash
npm run test:js
```

## Secrets And Local Data

Secrets, OAuth client files, local environment files, uploads, virtual environments, build outputs, and agent/tool histories are excluded through `.gitignore`. If a credential is ever committed by mistake, rotate it immediately and remove it from Git history; adding a file to `.gitignore` only prevents future tracking.

## License

This project is source-available under the Business Source License 1.1. See `LICENSE` for details.
