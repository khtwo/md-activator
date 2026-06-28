"""Idle auto-shutdown for single-file (``--open``) server sessions.

An ``--open`` server is a throwaway, single-file viewing session: once the user is
done it should not linger and hold the port. This module implements the inactivity
watchdog described in ``doc/specification/changes/2026-06-16-open-idle-auto-shutdown``:

- The idle clock does not start until the server receives its first HTTP request
  ("first access"); before then the server waits indefinitely for the user to open it.
- After the first access, any incoming HTTP request resets the timer. Once no request
  arrives for the idle window the server shuts itself down gracefully.

The window is passed from the launcher process to the uvicorn-imported ``app.main``
module via an environment variable (the same cross-process channel ``MD_VIEWER_ROOT``
uses), because module globals set in ``main()`` are not visible to the freshly imported
``app.main``.

Side-effecting callables (``sleep``, ``monotonic``, ``shutdown``) are injectable so the
watchdog can be unit tested without a real clock or a real server.
"""

from __future__ import annotations

import asyncio
import os
import signal
import time
from collections.abc import Mapping
from typing import Awaitable, Callable

# Default idle window: shut down after two minutes with no requests (post first access).
OPEN_IDLE_SHUTDOWN_SECONDS = 120.0
# How often the watchdog wakes to check for inactivity.
OPEN_IDLE_SHUTDOWN_CHECK_INTERVAL = 5.0
# Env var carrying the window from the launcher process to the imported ``app.main``.
OPEN_IDLE_SHUTDOWN_ENV = "MD_VIEWER_OPEN_IDLE_SHUTDOWN_SECONDS"


def resolve_idle_timeout(env: Mapping[str, str] = os.environ) -> float | None:
    """Return the configured idle window in seconds, or ``None`` when disabled.

    The feature is enabled only when the env var is set to a positive number; an unset,
    zero, negative, or non-numeric value disables it (returns ``None``).
    """
    raw = env.get(OPEN_IDLE_SHUTDOWN_ENV)
    if raw is None:
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def request_server_shutdown() -> None:
    """Ask the running uvicorn server to shut down gracefully.

    Raising ``SIGINT`` in-process triggers uvicorn's installed signal handler, which sets
    ``Server.should_exit``. Uvicorn polls that flag in its main loop (every ~100 ms) even
    when idle, so the shutdown fires without needing any inbound traffic, and the normal
    ASGI lifespan shutdown runs. ``signal.raise_signal`` is in-process and works on both
    Windows and POSIX (unlike ``os.kill(pid, SIGINT)`` on Windows).
    """
    signal.raise_signal(signal.SIGINT)


class InactivityMonitor:
    """Tracks request activity and triggers shutdown after an idle window.

    The clock is gated on the first recorded activity, so a server that has never been
    accessed is never shut down.
    """

    def __init__(
        self,
        timeout: float,
        *,
        shutdown: Callable[[], None] = request_server_shutdown,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        monotonic: Callable[[], float] = time.monotonic,
        check_interval: float = OPEN_IDLE_SHUTDOWN_CHECK_INTERVAL,
    ) -> None:
        self._timeout = timeout
        self._shutdown = shutdown
        self._sleep = sleep
        self._monotonic = monotonic
        self._check_interval = check_interval
        self._activated = False
        self._last_activity = 0.0

    def record_activity(self) -> None:
        """Mark that a request was received: start (or extend) the idle window."""
        self._activated = True
        self._last_activity = self._monotonic()

    def should_shutdown(self, now: float) -> bool:
        """True only once a first request was seen and the idle window has fully elapsed."""
        if not self._activated:
            return False
        return (now - self._last_activity) >= self._timeout

    async def run(self) -> None:
        """Poll until the idle window elapses, then shut down once and stop."""
        while True:
            await self._sleep(self._check_interval)
            if self.should_shutdown(self._monotonic()):
                self._shutdown()
                return
