"""Global command-palette search endpoint."""

from flask import Blueprint, jsonify, request
from flask_login import current_user, login_required

from services.global_search import GROUP_ORDER, search_global
from services.user_profile import is_emory_or_oxford_user


search_api_bp = Blueprint("search_api", __name__)
MAX_QUERY_LENGTH = 120
MIN_QUERY_LENGTH = 2


def _empty_payload(query, *, courses_enabled=False):
    return {
        "query": query,
        "total": 0,
        "courses_enabled": courses_enabled,
        "unavailable_categories": [],
        "groups": {group: [] for group in GROUP_ORDER},
        "minimum_query_length": MIN_QUERY_LENGTH,
    }


@search_api_bp.get("/api/search")
@login_required
def global_search():
    query = " ".join(str(request.args.get("q") or "").strip().split())
    if len(query) > MAX_QUERY_LENGTH:
        response = jsonify({"error": f"Search queries must be {MAX_QUERY_LENGTH} characters or fewer."})
        response.headers["Cache-Control"] = "no-store"
        return response, 400
    if len(query) < MIN_QUERY_LENGTH:
        response = jsonify(_empty_payload(
            query,
            courses_enabled=is_emory_or_oxford_user(current_user),
        ))
        response.headers["Cache-Control"] = "no-store"
        return response

    payload = search_global(current_user, query)
    payload["minimum_query_length"] = MIN_QUERY_LENGTH
    response = jsonify(payload)
    response.headers["Cache-Control"] = "no-store"
    return response
