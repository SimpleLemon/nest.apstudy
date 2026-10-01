"""Pace guild member reads using Discord's reported rate-limit windows."""

import math
import threading
import time

import requests

from services.discord_constants import DISCORD_API_BASE


MAX_MEMBER_LOOKUP_ATTEMPTS = 3
RATE_LIMIT_MARGIN_SECONDS = 0.05


def _seconds(value):
    try:
        value = float(value)
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) and value >= 0 else None


class DiscordMemberLookup:
    """Serialize member reads in the scheduler process and retain cooldowns.

    Different members of one guild share the member-read route's quota. The
    scheduler's existing process lock ensures only one worker runs role sync.
    """

    def __init__(self, *, clock=time.monotonic, sleep=time.sleep, wall_clock=time.time):
        self._clock = clock
        self._sleep = sleep
        self._wall_clock = wall_clock
        self._lock = threading.Lock()
        self._guild_ready_at = {}
        self._global_ready_at = 0.0

    def get(self, guild_id, discord_user_id, *, headers):
        with self._lock:
            for _ in range(MAX_MEMBER_LOOKUP_ATTEMPTS):
                ready_at = max(self._global_ready_at, self._guild_ready_at.get(guild_id, 0))
                delay = ready_at - self._clock()
                if delay > 0:
                    self._sleep(delay)
                response = requests.get(
                    f"{DISCORD_API_BASE}/guilds/{guild_id}/members/{discord_user_id}",
                    headers=headers,
                    timeout=8,
                )
                self._record_cooldown(guild_id, response)
                if response.status_code != 429:
                    return response
            return response

    def _record_cooldown(self, guild_id, response):
        headers = response.headers
        reset_after = _seconds(headers.get("X-RateLimit-Reset-After"))
        if reset_after is None:
            reset_at = _seconds(headers.get("X-RateLimit-Reset"))
            if reset_at is not None:
                reset_after = max(0.0, reset_at - self._wall_clock())

        delay = reset_after if _seconds(headers.get("X-RateLimit-Remaining")) == 0 else None
        global_limit = False
        if response.status_code == 429:
            try:
                payload = response.json()
            except ValueError:
                payload = {}
            if not isinstance(payload, dict):
                payload = {}
            delays = [
                _seconds(headers.get("Retry-After")),
                _seconds(payload.get("retry_after")),
                reset_after,
            ]
            delay = max((value for value in delays if value is not None), default=1.0)
            global_limit = (
                payload.get("global") is True
                or headers.get("X-RateLimit-Global") == "true"
                or headers.get("X-RateLimit-Scope") == "global"
            )

        if delay is not None:
            ready_at = self._clock() + delay + RATE_LIMIT_MARGIN_SECONDS
            self._guild_ready_at[guild_id] = max(self._guild_ready_at.get(guild_id, 0), ready_at)
            if global_limit:
                self._global_ready_at = max(self._global_ready_at, ready_at)
