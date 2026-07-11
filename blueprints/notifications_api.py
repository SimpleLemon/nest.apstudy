import os

from flask import Blueprint, jsonify, render_template, request
from flask_login import current_user, login_required

from services import notifications

notifications_bp = Blueprint("notifications", __name__)

@notifications_bp.get("/notifications")
@login_required
def center_page():
    return render_template("notifications.html", user=current_user)


@notifications_bp.get("/api/notifications/preferences")
@login_required
def get_preferences():
    return jsonify({"preferences": notifications.preferences(current_user.id), "devices": notifications.list_subscriptions(current_user.id), "vapid_public_key": os.environ.get("VAPID_PUBLIC_KEY", "")})


@notifications_bp.patch("/api/notifications/preferences")
@login_required
def patch_preferences():
    try: payload = notifications.update_preferences(current_user.id, request.get_json(silent=True) or {})
    except (ValueError, TypeError) as exc: return jsonify({"error": str(exc)}), 400
    return jsonify({"preferences": payload})


@notifications_bp.post("/api/notifications/subscriptions")
@login_required
def subscribe():
    payload = request.get_json(silent=True) or {}
    try: row_id = notifications.upsert_subscription(current_user.id, payload.get("subscription") or {}, payload.get("device_name"), request.user_agent.string)
    except PermissionError as exc: return jsonify({"error": str(exc)}), 409
    except ValueError as exc: return jsonify({"error": str(exc)}), 400
    return jsonify({"id": row_id, "devices": notifications.list_subscriptions(current_user.id)}), 201


@notifications_bp.delete("/api/notifications/subscriptions/<subscription_id>")
@login_required
def unsubscribe(subscription_id):
    notifications.delete_subscription(current_user.id, subscription_id=subscription_id)
    return jsonify({"devices": notifications.list_subscriptions(current_user.id)})

@notifications_bp.patch("/api/notifications/subscriptions/<subscription_id>")
@login_required
def rename_subscription(subscription_id):
    try: devices = notifications.rename_subscription(current_user.id, subscription_id, (request.get_json(silent=True) or {}).get("device_name"))
    except ValueError as exc: return jsonify({"error": str(exc)}), 400
    return jsonify({"devices": devices})


@notifications_bp.post("/api/notifications/subscriptions/current/delete")
@login_required
def unsubscribe_current():
    notifications.delete_subscription(current_user.id, endpoint=(request.get_json(silent=True) or {}).get("endpoint"))
    return jsonify({"ok": True})


@notifications_bp.post("/api/notifications/test")
@login_required
def test_notification():
    notification_id, result = notifications.notify(current_user.id, "test", "Nest notifications are working", "This browser can receive notifications even when Nest is closed.", "/settings#notifications", dedupe_key=None)
    return jsonify({"notification_id": notification_id, **result}), 200 if result["accepted"] else 503


@notifications_bp.get("/api/notifications")
@login_required
def feed():
    return jsonify(notifications.list_feed(current_user.id, category=request.args.get("category"), unread=request.args.get("unread") == "1", limit=request.args.get("limit", 50), before=request.args.get("before")))


@notifications_bp.post("/api/notifications/read")
@login_required
def read():
    payload = request.get_json(silent=True) or {}
    return jsonify({"unread_count": notifications.mutate_feed(current_user.id, payload.get("ids"), read=payload.get("read", True), category=payload.get("category"))})


@notifications_bp.delete("/api/notifications")
@login_required
def delete():
    payload = request.get_json(silent=True) or {}
    return jsonify({"unread_count": notifications.mutate_feed(current_user.id, payload.get("ids"), delete=True, category=payload.get("category"))})


@notifications_bp.get("/api/notifications/unread-count")
@login_required
def count():
    return jsonify({"unread_count": notifications.unread_count(current_user.id)})
