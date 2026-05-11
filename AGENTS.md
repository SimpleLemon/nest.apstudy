# Agent Notes

## Project Shape

- Flask app using the application factory at `app:create_app()` in `app.py`.
- Jinja templates live in `templates/`; some standalone notes views also live in `notes/`.
- Static assets live under `static/`, with CSS in `static/css/` and JavaScript in `static/js/`.
- Appwrite integration is present through `appwrite_client.py`, `appwrite_helpers.py`, `models.py`, and related blueprints.
- Course data is stored as a large local JSON corpus under `Spring_2026/` and `Fall_2026/`.
- Scheduled/background services live under `services/`.

## Run And Build
```bash
SCHEDULER_ENABLED=1 python -m python -m flask --app app:create_app run --host 0.0.0.0 --port 8000"
```

- Local Flask entrypoint:

```bash
python app.py
```

- Python dependencies are listed in `requirements.txt`.
- Node/Tailwind dependencies are listed in `package.json`.
- Build Tailwind CSS with:

```bash
npm run build:css
```

- Watch Tailwind CSS with:

```bash
npm run watch:css
```

## Repo Conventions

- Preserve the existing Flask blueprint structure and Jinja/static asset organization.
- Keep user-facing UI changes consistent with the existing CSS files and templates.
- Treat the worktree as potentially dirty; do not revert or overwrite unrelated user changes.

## Current Environment Notes

- The workspace path is `/workspaces/emory.apstudy`.
- The sandbox runner may fail if `bubblewrap` is unavailable; harmless read-only commands may need approval to run outside the sandbox.
- A previous init found many modified and untracked files, including app, blueprint, static, and template files. Assume those are user-owned unless proven otherwise.
