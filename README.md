Startup command:
```if [[ -f /home/container/requirements.txt ]]; then pip install -U --prefix .local -r requirements.txt; fi; SCHEDULER_ENABLED=1 python -m gunicorn -w 1 -b 0.0.0.0:${SERVER_PORT} "app:create_app()"```

Tailwind import guard:
```python scripts/check_tailwind_imports.py```

source .venv/bin/activate
flask --app app:create_app run --host 127.0.0.1 --port 8000