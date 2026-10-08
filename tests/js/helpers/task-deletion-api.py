"""Run the real authenticated deletion route against an in-memory row fixture."""
import json
import sys
from unittest.mock import patch

from flask import Flask
from flask_login import LoginManager, UserMixin
import blueprints.tasks_api as tasks_api

fixture = json.load(sys.stdin)
tasks = fixture["tasks"]
completions = fixture["completions"]
app = Flask(__name__)
app.secret_key = "task-deletion-cross-layer-test"
app.register_blueprint(tasks_api.tasks_api_bp)
login = LoginManager(app)


class FixtureUser(UserMixin):
    id = "user-1"


@login.user_loader
def load_user(user_id):
    return FixtureUser() if user_id == "user-1" else None


def get_row(table, row_id, **_options):
    if table == tasks_api.TASK_LISTS_TABLE_ID:
        return {"$id": "school", "user_id": "user-1"} if row_id == "school" else None
    return next((task for task in tasks if task["$id"] == row_id), None)


def delete_row(table, row_id):
    rows = tasks if table == tasks_api.TASKS_TABLE_ID else completions
    rows[:] = [row for row in rows if row["$id"] != row_id]


with app.test_client() as client:
    with client.session_transaction() as session:
        session["_user_id"] = "user-1"
        session["_fresh"] = True
    with patch.object(tasks_api, "get_row_safe", side_effect=get_row), \
            patch.object(tasks_api, "list_rows_all", return_value=tasks), \
            patch.object(tasks_api, "_completion_rows_for_task", side_effect=lambda _user, task_id: [row for row in completions if row["task_id"] == task_id]), \
            patch.object(tasks_api, "delete_row_safe", side_effect=delete_row):
        response = client.delete("/api/task-lists/school/completed-tasks", json=fixture["body"])
    print(json.dumps({"status": response.status_code, "payload": response.get_json(), "tasks": tasks, "completions": completions}))
