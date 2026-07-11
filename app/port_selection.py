"""Startup bind-port selection: default 8000 with a 20000+ availability fallback.

When the user does not pass an explicit ``--port``, the launcher (``app.main.main``)
resolves the bind port before starting uvicorn: the preferred port 8000 is probed on the
requested bind host, and when it is busy the first available port in the bounded
``20000-20999`` fallback range is used instead (see
``doc/specification/changes/2026-07-11-default-port-auto-fallback``). The fallback range
sits below every supported OS's default ephemeral port range (Linux 32768+,
Windows/macOS 49152+), so the scan does not contend with OS-assigned outbound ports.

An explicitly requested port never goes through this module — callers that pass
``--port`` (the VS Code extension picks its own free port and passes it explicitly)
keep exact bind-or-fail semantics.
"""

from __future__ import annotations

import socket
from typing import Callable

PREFERRED_PORT = 8000
FALLBACK_PORT_START = 20000
FALLBACK_PORT_END = 20999


class PortSelectionError(RuntimeError):
    """No bindable port among the preferred port and the whole fallback range."""


def is_port_available(host: str, port: int) -> bool:
    """Return True when a plain TCP socket can bind ``(host, port)`` right now.

    The probe must not set ``SO_REUSEADDR``: on Windows that flag allows binding over an
    in-use port, which would report busy ports as free. The probe-then-bind window is a
    benign race — uvicorn's own bind error remains the backstop.
    """
    # IPv6 host literals (``::1``, ``::``) need an AF_INET6 socket or bind always fails.
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    with socket.socket(family, socket.SOCK_STREAM) as probe:
        try:
            probe.bind((host, port))
        except OSError:
            return False
    return True


def select_port(
    host: str,
    *,
    preferred: int = PREFERRED_PORT,
    fallback_start: int = FALLBACK_PORT_START,
    fallback_end: int = FALLBACK_PORT_END,
    is_available: Callable[[str, int], bool] | None = None,
) -> int:
    """Return ``preferred`` when bindable on ``host``, else the first free fallback port."""
    # Resolved at call time (not as a default argument) so tests can monkeypatch the
    # module-level probe.
    probe = is_available if is_available is not None else is_port_available
    if probe(host, preferred):
        return preferred
    for port in range(fallback_start, fallback_end + 1):
        if probe(host, port):
            return port
    raise PortSelectionError(
        f"no available port: {preferred} and the fallback range "
        f"{fallback_start}-{fallback_end} are all in use"
    )
