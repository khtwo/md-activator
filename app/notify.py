"""Single-file launch announcement (``--open``).

When the server is started against one markdown file, this module waits for the
server to accept connections and then announces the file's URL: a Windows desktop
toast whose click opens the URL in the default browser, or a console line on other
platforms / when the toast cannot be produced.

Side-effecting callables (``wait``, ``announce``, ``toast``, ``emit``) are injectable
so the behavior can be unit tested without a real server, socket, or toast.
"""

from __future__ import annotations

import socket
import sys
import threading
import time
from typing import Callable
from urllib.parse import quote

IS_WINDOWS = sys.platform == "win32"

# Bind hosts that are not directly clickable; the announced URL uses loopback instead.
WILDCARD_HOSTS = {"", "0.0.0.0", "::"}

DEFAULT_WAIT_TIMEOUT = 15.0
DEFAULT_WAIT_INTERVAL = 0.1
DEFAULT_CONNECT_TIMEOUT = 0.5


def _clickable_host(host: str) -> str:
    return "127.0.0.1" if host in WILDCARD_HOSTS else host


def build_open_url(host: str, port: int, relative_path: str) -> str:
    """Build the announced URL, using loopback for wildcard hosts and URL-quoting the path."""
    quoted = quote(relative_path.replace("\\", "/"))
    return f"http://{_clickable_host(host)}:{port}/{quoted}"


def wait_for_server(
    host: str,
    port: int,
    timeout: float = DEFAULT_WAIT_TIMEOUT,
    interval: float = DEFAULT_WAIT_INTERVAL,
    connect_timeout: float = DEFAULT_CONNECT_TIMEOUT,
) -> bool:
    """Poll until the bound socket accepts a TCP connection, or the timeout elapses.

    Works under ``--reload`` because the worker subprocess binds the socket regardless
    of which process started the poll.
    """
    target_host = _clickable_host(host)
    deadline = time.monotonic() + timeout
    while True:
        try:
            with socket.create_connection((target_host, port), timeout=connect_timeout):
                return True
        except OSError:
            if time.monotonic() >= deadline:
                return False
            time.sleep(interval)


def _default_toast(title: str, body: str, *, on_click: str) -> None:
    # Imported lazily: win11toast is a Windows-only optional dependency.
    from win11toast import notify as _notify

    _notify(title, body, on_click=on_click)


def _default_open_browser(url: str) -> bool:
    # Imported lazily to keep the (Windows toast) path from importing webbrowser. The
    # module-level open() returns True when a browser was launched and False when none
    # could be (e.g. a headless session) — it does not raise in that case.
    import webbrowser

    return webbrowser.open(url)


def announce_ready(
    url: str,
    file_label: str,
    *,
    is_windows: bool = IS_WINDOWS,
    toast: Callable[..., None] | None = None,
    open_browser: Callable[[str], bool] | None = None,
    emit: Callable[[str], None] = print,
) -> None:
    """Announce the ready file.

    Windows: a desktop toast whose click opens the browser. Other platforms: open the URL
    in the default browser (desktop macOS/Linux). When the toast cannot be produced, no
    browser can be launched (e.g. a headless session), or either call fails, fall back to
    printing the URL to the console.
    """
    if is_windows:
        toast_fn = toast if toast is not None else _default_toast
        try:
            toast_fn("MD Activator", f"Open {file_label}", on_click=url)
            return
        except Exception:
            # Toast dependency missing or the toast call failed: fall back to the console.
            pass
    else:
        open_fn = open_browser if open_browser is not None else _default_open_browser
        try:
            if open_fn(url):
                return
        except Exception:
            # No launchable browser or webbrowser raised: fall back to the console.
            pass
    emit(f"MD Activator: open {file_label} -> {url}")


def schedule_announcement(
    *,
    host: str,
    port: int,
    relative_path: str,
    wait: Callable[..., bool] = wait_for_server,
    announce: Callable[..., None] = announce_ready,
) -> threading.Thread:
    """Start a daemon thread that waits for the server then announces ``relative_path``.

    Returns the thread (already started) so callers/tests can join it. Never blocks the
    server; the thread is a daemon so it does not keep the process alive on its own.
    """
    url = build_open_url(host, port, relative_path)

    def _run() -> None:
        if wait(host, port):
            announce(url, relative_path)

    thread = threading.Thread(target=_run, name="md-activator-announce", daemon=True)
    thread.start()
    return thread
