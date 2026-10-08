"""Tracking term operations and enablement gates, independent of HTTP."""

from collections.abc import Mapping, Sequence
from typing import Any

from services.course_tracking_terms import (
    TermPolicyConflict, TermPolicyError, policy_error, save_term_policy,
    term_inventory, term_policy,
)


def enabling_error(tracks: Sequence[Mapping[str, Any]], enabled: bool) -> tuple[dict[str, Any], int] | None:
    """Return the first policy denial before a batch writes any tracking rows."""
    if enabled:
        for term in {track.get("term") for track in tracks}:
            policy = term_policy(term)
            if not policy["can_enable"]:
                return policy_error(policy)
    return None
