from __future__ import annotations

import argparse
import asyncio
import os
from collections.abc import Sequence
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from typing import Awaitable, Callable

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, Field

from . import auto_shutdown, port_selection
from .auto_shutdown import InactivityMonitor
from .markdown_service import MarkdownRenderer
from .markdown_services.mermaid_repair import repair_mermaid_source
from .markdown_services.models import VIEWER_SUFFIXES
from .new_files import (
    DEFAULT_SPAN_DAYS,
    SPAN_DAYS_ENV,
    NewFilesService,
    contains_confirm_marker,
    contains_unchecked_confirm,
    resolve_span_days,
)
from .notify import schedule_announcement, schedule_change_notification

APP_ROOT = Path(__file__).resolve().parents[1]


def resolve_content_root(root_arg: str | None = None) -> Path:
    root_value = root_arg if root_arg is not None else os.getenv("MD_VIEWER_ROOT")
    root_path = Path(root_value).expanduser() if root_value else Path.cwd()
    return root_path.resolve()


CONTENT_ROOT = resolve_content_root()
SAVE_PERMISSION_ERROR_DETAIL = "Unable to save markdown file: permission denied"
RENDER_CACHE_CLEAN_INTERVAL_SECONDS = 10.0
LOCAL_STATIC_FILES = (
    "style.css",
    "theme-dark.css",
    "file-dropdown.css",
    "mermaid-zoom-pan.css",
    "max-graph.css",
    "search.css",
    "yaml-view.css",
    "json-view.css",
    "zoom-pan.js",
    "max-graph-constants.js",
    "max-graph-dom.js",
    "max-graph-add.js",
    "max-graph-style.js",
    "max-graph-routing-endpoints.js",
    "max-graph-routing-paths.js",
    "max-graph-history.js",
    "max-graph-routing-context.js",
    "max-graph-routing-scoring.js",
    "max-graph-routing-candidates.js",
    "max-graph-routing-shifts.js",
    "max-graph-routing.js",
    "max-graph-label-boxes.js",
    "max-graph-labels.js",
    "max-graph-label-segments.js",
    "max-graph-render.js",
    "max-graph-interactions.js",
    "max-graph-selection.js",
    "max-graph.js",
    "max-graph-source-toggle.js",
    "mermaid-zoom-pan.js",
    "mermaid-title-edit.js",
    "mermaid-selection.js",
    "mermaid-add.js",
    "app-support.js",
    "mermaid-repair.js",
    "mermaid-source-toggle.js",
    "search.js",
    "yaml-view.js",
    "json-view.js",
    "content-font-scale.js",
    "new-files.css",
    "new-files.js",
    "app.js",
)

renderer = MarkdownRenderer(CONTENT_ROOT)
# Tracks recently-active markdown files for the toolbar notification icon. Constructed in the
# serving process (same import timing as ``renderer``) so its populated-day span anchors at
# server start; the span comes from MD_VIEWER_SPAN_DAYS (set by ``main()`` from ``--span``),
# because uvicorn re-imports this module and would not see a ``main()`` global. See
# app/new_files.py.
# Single notification surface for recently-active markdown files. Files that still carry an
# unchecked `[ ] Confirm` marker are tagged `needs_review` and floated to the front of the
# list (review-first); confirming one (checking its box) clears the flag on the next scan.
new_files_service = NewFilesService(
    CONTENT_ROOT,
    span_days=resolve_span_days(),
    priority_filter=contains_unchecked_confirm,
    # Mark confirmation-type files (any `Confirm` marker, checked or unchecked) so their desktop
    # *change* notification fires only when the confirmation status flips, not on ordinary edits.
    confirm_filter=contains_confirm_marker,
    # Raise a native desktop notification (offloaded to a daemon thread so a toast never blocks
    # the poll) when the detector finds .md files created/changed after the session baseline.
    notifier=schedule_change_notification,
)

# Active only in single-file (``--open``) mode; see app/auto_shutdown.py. The HTTP
# middleware records request activity against it and the lifespan watchdog reads it.
_inactivity_monitor: InactivityMonitor | None = None


async def clean_render_cache_periodically(
    *,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> None:
    while True:
        await sleep(RENDER_CACHE_CLEAN_INTERVAL_SECONDS)
        renderer.clean_render_cache()
        renderer.clean_folder_metadata_cache()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global _inactivity_monitor
    cleanup_task = asyncio.create_task(clean_render_cache_periodically())
    shutdown_task: asyncio.Task | None = None
    idle_timeout = auto_shutdown.resolve_idle_timeout()
    if idle_timeout is not None:
        _inactivity_monitor = InactivityMonitor(idle_timeout)
        shutdown_task = asyncio.create_task(_inactivity_monitor.run())
    try:
        yield
    finally:
        cleanup_task.cancel()
        with suppress(asyncio.CancelledError):
            await cleanup_task
        if shutdown_task is not None:
            shutdown_task.cancel()
            with suppress(asyncio.CancelledError):
                await shutdown_task
        _inactivity_monitor = None


app = FastAPI(title="MD Activator", docs_url=None, redoc_url=None, lifespan=lifespan)


@app.middleware("http")
async def _record_request_activity(request: Request, call_next):
    monitor = _inactivity_monitor
    if monitor is not None:
        monitor.record_activity()
    return await call_next(request)
app.mount("/assets", StaticFiles(directory=APP_ROOT / "to-html"), name="assets")
app.mount("/static", StaticFiles(directory=APP_ROOT / "app" / "static"), name="static")
templates = Jinja2Templates(directory=str(APP_ROOT / "app" / "templates"))


def configure_content_root(root: Path) -> Path:
    if not root.is_dir():
        raise ValueError(f"Content root does not exist or is not a folder: {root}")
    renderer.root_dir = root
    # Point the new-file scan at the served folder. The viewed registry itself lives at a
    # fixed per-user path (shared across folders); this only updates the root it uses to
    # translate between relative listing paths and the absolute paths it stores.
    new_files_service.root_dir = root
    os.environ["MD_VIEWER_ROOT"] = str(root)
    return root


def resolve_open_target(open_arg: str) -> tuple[Path, str]:
    """Resolve a ``--open`` markdown file to its (content_root, url-relative path).

    The content root is the file's parent folder and the relative path is the file name
    (relative to that parent, posix-normalized). Raises ``ValueError`` when the target is
    not an existing ``.md`` file.
    """
    target = Path(open_arg).expanduser().resolve()
    if not target.is_file():
        raise ValueError(f"--open target is not a file: {target}")
    if target.suffix.lower() != ".md":
        raise ValueError(f"--open target must be a .md file: {target}")
    return target.parent, target.name


def local_static_asset_version() -> str:
    static_dir = APP_ROOT / "app" / "static"
    return str(max((static_dir / name).stat().st_mtime_ns for name in LOCAL_STATIC_FILES))


def _positive_int(raw: str) -> int:
    """argparse type for ``--span``: an integer >= 1 (rejects non-integer / non-positive)."""
    try:
        value = int(raw)
    except ValueError:
        raise argparse.ArgumentTypeError(f"must be an integer, got {raw!r}")
    if value < 1:
        raise argparse.ArgumentTypeError(f"must be >= 1, got {value}")
    return value


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Start the MD Activator local markdown server.")
    parser.add_argument(
        "--cd",
        metavar="FOLDER",
        help="Serve markdown from FOLDER instead of the current folder.",
    )
    parser.add_argument(
        "--open",
        dest="open_file",
        metavar="FILE",
        help=(
            "Serve the folder containing FILE (a .md file) and announce it once the server "
            "is ready: on Windows a toast whose click opens FILE in the default browser, on "
            "macOS/Linux the file opens in the default browser directly. When no browser can "
            "be opened (e.g. a headless session) the URL is printed to the console instead. "
            "Takes precedence over --cd for content-root selection."
        ),
    )
    parser.add_argument(
        "--span",
        type=_positive_int,
        default=DEFAULT_SPAN_DAYS,
        metavar="DAYS",
        help=(
            "New-`.md`-file notification time span, in populated days (only days containing "
            f"markdown-file activity count). Integer >= 1; defaults to {DEFAULT_SPAN_DAYS}."
        ),
    )
    parser.add_argument("--host", default="127.0.0.1", help="Bind host. Defaults to 127.0.0.1.")
    parser.add_argument(
        "-p",
        "--port",
        type=int,
        default=None,
        help=(
            "Bind port. When omitted, defaults to 8000; if 8000 is busy, the first "
            "available port from 20000 is used instead. An explicit port is used as-is."
        ),
    )
    reload_group = parser.add_mutually_exclusive_group()
    reload_group.add_argument("--reload", dest="reload", action="store_true", help="Enable Uvicorn reload.")
    reload_group.add_argument("--no-reload", dest="reload", action="store_false", help="Disable Uvicorn reload.")
    parser.set_defaults(reload=False)
    parser.add_argument("--no-use-colors", action="store_true", help="Disable Uvicorn color output.")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    # Resolve the bind port before the --open branch so the announcement and uvicorn share
    # it. Only the default (no explicit --port) auto-falls-back; an explicit port keeps
    # exact bind-or-fail semantics (the VS Code extension passes its own chosen port).
    if args.port is None:
        try:
            args.port = port_selection.select_port(args.host)
        except port_selection.PortSelectionError as exc:
            parser.error(str(exc))
        if args.port != port_selection.PREFERRED_PORT:
            print(
                f"MD Activator: port {port_selection.PREFERRED_PORT} is in use; "
                f"using port {args.port}."
            )

    # Hand the span to the serving process: uvicorn re-imports ``app.main`` (a different
    # module object), so the module-level service is constructed from this env var, not args.
    os.environ[SPAN_DAYS_ENV] = str(args.span)

    if args.open_file is not None:
        try:
            content_root, relative_path = resolve_open_target(args.open_file)
        except ValueError as exc:
            parser.error(str(exc))
        configure_content_root(content_root)
        # Enable idle auto-shutdown for this single-file session. Passed via env var so the
        # uvicorn-imported ``app.main`` (a different module object) picks it up in lifespan.
        os.environ[auto_shutdown.OPEN_IDLE_SHUTDOWN_ENV] = str(auto_shutdown.OPEN_IDLE_SHUTDOWN_SECONDS)
        # Force single-process mode: with --reload, uvicorn's parent reloader owns the bound
        # socket and is not stopped by the worker's in-process shutdown signal, so it would
        # linger holding the port. Auto-reload only watches app source (irrelevant to viewing
        # one file), so disabling it lets the idle watchdog fully terminate and free the port.
        if args.reload:
            print("MD Activator: --open runs single-process; ignoring --reload.")
            args.reload = False
        schedule_announcement(host=args.host, port=args.port, relative_path=relative_path)
    else:
        try:
            configure_content_root(resolve_content_root(args.cd))
        except ValueError as exc:
            parser.error(str(exc))

    import uvicorn

    uvicorn.run(
        "app.main:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
        use_colors=not args.no_use_colors,
    )
    return 0


class CheckboxUpdateRequest(BaseModel):
    path: str
    line: int
    index: int
    checked: bool


class CodeBlockUpdateRequest(BaseModel):
    path: str
    line: int
    index: int
    content: str


class MaxGraphNodePositionUpdateRequest(BaseModel):
    path: str
    line: int
    index: int
    node_id: str = Field(alias="nodeId")
    x: float
    y: float


class MaxGraphNodePositionItem(BaseModel):
    node_id: str = Field(alias="nodeId")
    x: float
    y: float


class MaxGraphNodesPositionUpdateRequest(BaseModel):
    path: str
    line: int
    index: int
    nodes: list[MaxGraphNodePositionItem]


class MaxGraphNodeTitleUpdateRequest(BaseModel):
    path: str
    line: int
    index: int
    node_id: str = Field(alias="nodeId")
    title: str


class MaxGraphEdgeTitleUpdateRequest(BaseModel):
    path: str
    line: int
    index: int
    edge_id: str = Field(alias="edgeId")
    title: str


class MaxGraphNodeAddRequest(BaseModel):
    path: str
    line: int
    index: int
    node_id: str = Field(alias="nodeId")
    title: str
    x: float
    y: float


class MaxGraphNodeDeleteRequest(BaseModel):
    path: str
    line: int
    index: int
    node_id: str = Field(alias="nodeId")


class MaxGraphNodesDeleteRequest(BaseModel):
    path: str
    line: int
    index: int
    node_ids: list[str] = Field(alias="nodeIds")


class MaxGraphEdgeAddRequest(BaseModel):
    path: str
    line: int
    index: int
    edge_id: str = Field(alias="edgeId")
    title: str
    source_id: str = Field(alias="sourceId")
    target_id: str = Field(alias="targetId")


class MaxGraphEdgeDeleteRequest(BaseModel):
    path: str
    line: int
    index: int
    edge_id: str = Field(alias="edgeId")


class MaxGraphBlockRestoreRequest(BaseModel):
    path: str
    line: int
    index: int
    xml: str


class MaxGraphBlockUpdateRequest(BaseModel):
    path: str
    line: int
    index: int
    xml: str


class MermaidNodeTitleUpdateRequest(BaseModel):
    path: str
    line: int
    index: int
    diagram_type: str = Field(alias="diagramType")
    node_id: str = Field(alias="nodeId")
    title: str


class MermaidEdgeTitleUpdateRequest(BaseModel):
    path: str
    line: int
    index: int
    diagram_type: str = Field(alias="diagramType")
    source: str = ""
    target: str = ""
    occurrence: int = 0
    edge_index: int = Field(default=0, alias="edgeIndex")
    title: str


class MermaidNodeAddRequest(BaseModel):
    path: str
    line: int
    index: int
    diagram_type: str = Field(alias="diagramType")


class MermaidEdgeAddRequest(BaseModel):
    path: str
    line: int
    index: int
    diagram_type: str = Field(alias="diagramType")
    source_id: str = Field(alias="sourceId")
    target_id: str = Field(alias="targetId")


class MermaidNodesDeleteRequest(BaseModel):
    path: str
    line: int
    index: int
    diagram_type: str = Field(alias="diagramType")
    node_ids: list[str] = Field(alias="nodeIds")


class MermaidEdgeDeleteRequest(BaseModel):
    path: str
    line: int
    index: int
    diagram_type: str = Field(alias="diagramType")
    source: str = ""
    target: str = ""
    occurrence: int = 0
    edge_index: int = Field(default=0, alias="edgeIndex")


class MermaidBlockRestoreRequest(BaseModel):
    path: str
    line: int
    index: int
    source: str


class MermaidBlockUpdateRequest(BaseModel):
    path: str
    line: int
    index: int
    source: str


class MermaidDiagnoseRequest(BaseModel):
    source: str


class MermaidFixRequest(BaseModel):
    path: str
    line: int
    index: int


def viewer_response(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(
        request,
        "index.html",
        {
            "content_root": str(renderer.root_dir),
            "static_asset_version": local_static_asset_version(),
        },
    )


@app.get("/", response_class=HTMLResponse)
def index(request: Request) -> HTMLResponse:
    return viewer_response(request)


@app.get("/api/render")
def render_markdown(
    path: str | None = Query(default=None, description="Relative path to markdown file"),
    base: str | None = Query(default=None, description="Current markdown path for resolving relative links"),
    include_file_options: bool = Query(
        default=True,
        alias="includeFileOptions",
        description="Include file/folder dropdown metadata in the render response.",
    ),
    if_render_version: str | None = Query(
        default=None,
        alias="ifRenderVersion",
        description="Return a no-change signal when this token matches the current markdown file version.",
    ),
) -> dict:
    try:
        if if_render_version:
            current_render_version = renderer.current_render_version(path=path, base=base)
            if current_render_version and current_render_version == if_render_version:
                return {"status": "no-change"}

        result = renderer.render(path=path, base=base, include_file_options=include_file_options)
        # Opening an .md file as the main document marks it viewed (bold -> normal in the
        # notification dropdown). Folder/empty renders resolve to a non-.md path and are skipped.
        if result.relative_path.lower().endswith(".md"):
            new_files_service.mark_viewed(result.relative_path)
        payload = {
            "path": result.relative_path,
            "renderVersion": result.render_version,
            "html": result.html,
            "links": result.links,
        }
        if include_file_options:
            payload["fileOptions"] = result.file_options
        return payload
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/new-files")
def list_new_files(
    page: int = Query(default=1, ge=1, description="1-based page number (10 files per page)."),
    detect: bool = Query(
        default=False,
        description="When true, rescan the tree and refresh the cache before responding "
        "(the detector). When false, serve the cached list without scanning.",
    ),
    if_list_version: str = Query(
        default="",
        alias="ifListVersion",
        description="Caller's last-known list version; on a detect request that still "
        "matches, the server returns a no-change indicator instead of the list.",
    ),
) -> dict:
    """Recently-created (last 2 days) markdown files, review-needing ones first then newest,
    paged for the badge. Each item carries ``needsReview``; the payload carries
    ``reviewCount`` and ``attentionCount`` (the badge value).

    Paging serves a cache slice (no scan); only ``detect=true`` rescans (R9). A detect
    request whose ``ifListVersion`` still matches gets a small no-change indicator (R10).
    """
    if detect:
        new_files_service.detect()
        if if_list_version and new_files_service.list_version() == if_list_version:
            return {"status": "no-change", "listVersion": if_list_version}
    return new_files_service.page(page=page)


@app.post("/api/new-files/mark-all-viewed")
def mark_all_new_files_viewed() -> dict:
    """Mark every file in the current list (all pages) viewed, then return the refreshed first
    page so the badge and per-row ``viewed`` flags update in one round-trip.

    Review files are marked viewed too but keep needing review, so ``attentionCount`` retains
    the review count (viewed is not reviewed). Takes no request body.
    """
    new_files_service.mark_all_viewed()
    return new_files_service.page(page=1)


@app.get("/api/image/{image_path:path}")
def render_image(image_path: str) -> FileResponse:
    try:
        return FileResponse(renderer.resolve_image_path(image_path))
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/file/{file_path:path}")
def download_file(file_path: str) -> FileResponse:
    try:
        resolved = renderer.resolve_download_path(file_path)
        return FileResponse(resolved, filename=resolved.name)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/checkbox")
def update_checkbox(payload: CheckboxUpdateRequest) -> dict:
    try:
        result = renderer.update_checkbox(
            path=payload.path,
            line=payload.line,
            index=payload.index,
            checked=payload.checked,
        )
        return {
            "path": result.relative_path,
            "line": result.line,
            "index": result.index,
            "checked": result.checked,
        }
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=SAVE_PERMISSION_ERROR_DETAIL) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/code-block")
def update_code_block(payload: CodeBlockUpdateRequest) -> dict:
    try:
        result = renderer.update_code_block(
            path=payload.path,
            line=payload.line,
            index=payload.index,
            content=payload.content,
        )
        return {
            "path": result.relative_path,
            "line": result.line,
            "index": result.index,
        }
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=SAVE_PERMISSION_ERROR_DETAIL) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/maxgraph-node")
def update_maxgraph_node_position(payload: MaxGraphNodePositionUpdateRequest) -> dict:
    try:
        result = renderer.update_maxgraph_node_position(
            path=payload.path,
            line=payload.line,
            index=payload.index,
            node_id=payload.node_id,
            x=payload.x,
            y=payload.y,
        )
        return {
            "path": result.relative_path,
            "line": result.line,
            "index": result.index,
            "nodeId": result.node_id,
            "x": result.x,
            "y": result.y,
        }
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=SAVE_PERMISSION_ERROR_DETAIL) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/maxgraph-nodes")
def update_maxgraph_nodes_position(payload: MaxGraphNodesPositionUpdateRequest) -> dict:
    try:
        result = renderer.update_maxgraph_nodes_position(
            path=payload.path,
            line=payload.line,
            index=payload.index,
            moves=[(item.node_id, item.x, item.y) for item in payload.nodes],
        )
        return {
            "path": result.relative_path,
            "line": result.line,
            "index": result.index,
            "nodes": [
                {"nodeId": node.node_id, "x": node.x, "y": node.y} for node in result.nodes
            ],
        }
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=SAVE_PERMISSION_ERROR_DETAIL) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/maxgraph-node-title")
def update_maxgraph_node_title(payload: MaxGraphNodeTitleUpdateRequest) -> dict:
    try:
        result = renderer.update_maxgraph_node_title(
            path=payload.path,
            line=payload.line,
            index=payload.index,
            node_id=payload.node_id,
            title=payload.title,
        )
        return {
            "path": result.relative_path,
            "line": result.line,
            "index": result.index,
            "nodeId": result.node_id,
            "title": result.title,
        }
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=SAVE_PERMISSION_ERROR_DETAIL) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/maxgraph-edge-title")
def update_maxgraph_edge_title(payload: MaxGraphEdgeTitleUpdateRequest) -> dict:
    try:
        result = renderer.update_maxgraph_edge_title(
            path=payload.path,
            line=payload.line,
            index=payload.index,
            edge_id=payload.edge_id,
            title=payload.title,
        )
        return {
            "path": result.relative_path,
            "line": result.line,
            "index": result.index,
            "edgeId": result.edge_id,
            "title": result.title,
        }
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=SAVE_PERMISSION_ERROR_DETAIL) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/maxgraph-node-add")
def add_maxgraph_node(payload: MaxGraphNodeAddRequest) -> dict:
    try:
        result = renderer.add_maxgraph_node(
            path=payload.path,
            line=payload.line,
            index=payload.index,
            node_id=payload.node_id,
            title=payload.title,
            x=payload.x,
            y=payload.y,
        )
        return {
            "path": result.relative_path,
            "line": result.line,
            "index": result.index,
            "nodeId": result.node_id,
            "title": result.title,
            "x": result.x,
            "y": result.y,
        }
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=SAVE_PERMISSION_ERROR_DETAIL) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/maxgraph-node-delete")
def delete_maxgraph_node(payload: MaxGraphNodeDeleteRequest) -> dict:
    try:
        result = renderer.delete_maxgraph_node(
            path=payload.path,
            line=payload.line,
            index=payload.index,
            node_id=payload.node_id,
        )
        return {
            "path": result.relative_path,
            "line": result.line,
            "index": result.index,
            "nodeId": result.node_id,
        }
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=SAVE_PERMISSION_ERROR_DETAIL) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/maxgraph-nodes-delete")
def delete_maxgraph_nodes(payload: MaxGraphNodesDeleteRequest) -> dict:
    try:
        result = renderer.delete_maxgraph_nodes(
            path=payload.path,
            line=payload.line,
            index=payload.index,
            node_ids=payload.node_ids,
        )
        return {
            "path": result.relative_path,
            "line": result.line,
            "index": result.index,
            "nodeIds": result.node_ids,
        }
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=SAVE_PERMISSION_ERROR_DETAIL) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/maxgraph-edge-add")
def add_maxgraph_edge(payload: MaxGraphEdgeAddRequest) -> dict:
    try:
        result = renderer.add_maxgraph_edge(
            path=payload.path,
            line=payload.line,
            index=payload.index,
            edge_id=payload.edge_id,
            title=payload.title,
            source_id=payload.source_id,
            target_id=payload.target_id,
        )
        return {
            "path": result.relative_path,
            "line": result.line,
            "index": result.index,
            "edgeId": result.edge_id,
            "title": result.title,
            "sourceId": result.source_id,
            "targetId": result.target_id,
        }
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=SAVE_PERMISSION_ERROR_DETAIL) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/maxgraph-edge-delete")
def delete_maxgraph_edge(payload: MaxGraphEdgeDeleteRequest) -> dict:
    try:
        result = renderer.delete_maxgraph_edge(
            path=payload.path,
            line=payload.line,
            index=payload.index,
            edge_id=payload.edge_id,
        )
        return {
            "path": result.relative_path,
            "line": result.line,
            "index": result.index,
            "edgeId": result.edge_id,
        }
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=SAVE_PERMISSION_ERROR_DETAIL) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/maxgraph-block-restore")
def restore_maxgraph_block(payload: MaxGraphBlockRestoreRequest) -> dict:
    try:
        result = renderer.restore_maxgraph_block(
            path=payload.path,
            line=payload.line,
            index=payload.index,
            xml=payload.xml,
        )
        return {
            "path": result.relative_path,
            "line": result.line,
            "index": result.index,
        }
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=SAVE_PERMISSION_ERROR_DETAIL) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/maxgraph-block-source")
def get_maxgraph_block_source(path: str, line: int, index: int) -> dict:
    # Read-only prefill for the source-toggle editor; no write, no cache side effects, so the
    # permission (403) branch never applies here.
    try:
        result = renderer.get_maxgraph_block_source(path=path, line=line, index=index)
        return {
            "path": result.relative_path,
            "line": result.line,
            "index": result.index,
            "xml": result.xml,
        }
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/maxgraph-block-update")
def update_maxgraph_block(payload: MaxGraphBlockUpdateRequest) -> dict:
    try:
        result = renderer.update_maxgraph_block(
            path=payload.path,
            line=payload.line,
            index=payload.index,
            xml=payload.xml,
        )
        return {
            "path": result.relative_path,
            "line": result.line,
            "index": result.index,
            "previousXml": result.previous_xml,
            "xml": result.xml,
        }
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=SAVE_PERMISSION_ERROR_DETAIL) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/mermaid-node-title")
def update_mermaid_node_title(payload: MermaidNodeTitleUpdateRequest) -> dict:
    try:
        result = renderer.update_mermaid_node_title(
            path=payload.path,
            line=payload.line,
            index=payload.index,
            diagram_type=payload.diagram_type,
            node_id=payload.node_id,
            title=payload.title,
        )
        return {
            "path": result.relative_path,
            "line": result.line,
            "index": result.index,
            "diagramType": result.diagram_type,
            "nodeId": result.node_id,
            "title": result.title,
        }
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=SAVE_PERMISSION_ERROR_DETAIL) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/mermaid-edge-title")
def update_mermaid_edge_title(payload: MermaidEdgeTitleUpdateRequest) -> dict:
    try:
        result = renderer.update_mermaid_edge_title(
            path=payload.path,
            line=payload.line,
            index=payload.index,
            diagram_type=payload.diagram_type,
            source=payload.source,
            target=payload.target,
            occurrence=payload.occurrence,
            edge_index=payload.edge_index,
            title=payload.title,
        )
        return {
            "path": result.relative_path,
            "line": result.line,
            "index": result.index,
            "diagramType": result.diagram_type,
            "source": result.source,
            "target": result.target,
            "occurrence": result.occurrence,
            "edgeIndex": result.edge_index,
            "title": result.title,
        }
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=SAVE_PERMISSION_ERROR_DETAIL) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/mermaid-node-add")
def add_mermaid_node(payload: MermaidNodeAddRequest) -> dict:
    try:
        result = renderer.add_mermaid_node(
            path=payload.path,
            line=payload.line,
            index=payload.index,
            diagram_type=payload.diagram_type,
        )
        return {
            "path": result.relative_path,
            "line": result.line,
            "index": result.index,
            "diagramType": result.diagram_type,
            "nodeId": result.node_id,
            "previousSource": result.previous_source,
            "source": result.source,
        }
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=SAVE_PERMISSION_ERROR_DETAIL) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/mermaid-edge-add")
def add_mermaid_edge(payload: MermaidEdgeAddRequest) -> dict:
    try:
        result = renderer.add_mermaid_edge(
            path=payload.path,
            line=payload.line,
            index=payload.index,
            diagram_type=payload.diagram_type,
            source_id=payload.source_id,
            target_id=payload.target_id,
        )
        return {
            "path": result.relative_path,
            "line": result.line,
            "index": result.index,
            "diagramType": result.diagram_type,
            "sourceId": result.source_id,
            "targetId": result.target_id,
            "previousSource": result.previous_source,
            "source": result.source,
        }
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=SAVE_PERMISSION_ERROR_DETAIL) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/mermaid-nodes-delete")
def delete_mermaid_nodes(payload: MermaidNodesDeleteRequest) -> dict:
    try:
        result = renderer.delete_mermaid_nodes(
            path=payload.path,
            line=payload.line,
            index=payload.index,
            diagram_type=payload.diagram_type,
            node_ids=payload.node_ids,
        )
        return {
            "path": result.relative_path,
            "line": result.line,
            "index": result.index,
            "diagramType": result.diagram_type,
            "nodeIds": result.node_ids,
            "previousSource": result.previous_source,
            "source": result.source,
        }
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=SAVE_PERMISSION_ERROR_DETAIL) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/mermaid-edge-delete")
def delete_mermaid_edge(payload: MermaidEdgeDeleteRequest) -> dict:
    try:
        result = renderer.delete_mermaid_edge(
            path=payload.path,
            line=payload.line,
            index=payload.index,
            diagram_type=payload.diagram_type,
            source=payload.source,
            target=payload.target,
            occurrence=payload.occurrence,
            edge_index=payload.edge_index,
        )
        return {
            "path": result.relative_path,
            "line": result.line,
            "index": result.index,
            "previousSource": result.previous_source,
            "source": result.source,
        }
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=SAVE_PERMISSION_ERROR_DETAIL) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/mermaid-block-restore")
def restore_mermaid_block(payload: MermaidBlockRestoreRequest) -> dict:
    try:
        result = renderer.restore_mermaid_block(
            path=payload.path,
            line=payload.line,
            index=payload.index,
            source=payload.source,
        )
        return {
            "path": result.relative_path,
            "line": result.line,
            "index": result.index,
        }
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=SAVE_PERMISSION_ERROR_DETAIL) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/mermaid-block-source")
def get_mermaid_block_source(path: str, line: int, index: int) -> dict:
    # Read-only prefill for the source-toggle editor; no write, no cache side effects, so the
    # permission (403) branch never applies here.
    try:
        result = renderer.get_mermaid_block_source(path=path, line=line, index=index)
        return {
            "path": result.relative_path,
            "line": result.line,
            "index": result.index,
            "source": result.source,
            "fenced": result.fenced,
        }
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/mermaid-block-update")
def update_mermaid_block(payload: MermaidBlockUpdateRequest) -> dict:
    try:
        result = renderer.update_mermaid_block(
            path=payload.path,
            line=payload.line,
            index=payload.index,
            source=payload.source,
        )
        return {
            "path": result.relative_path,
            "line": result.line,
            "index": result.index,
            "previousSource": result.previous_source,
            "source": result.source,
        }
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=SAVE_PERMISSION_ERROR_DETAIL) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/mermaid-diagnose")
def diagnose_mermaid(payload: MermaidDiagnoseRequest) -> dict:
    result = repair_mermaid_source(payload.source)
    return {
        "fixed": result.fixed,
        "fixedSource": result.fixed_source,
        "issues": [
            {"line": issue.line, "ruleId": issue.rule_id, "message": issue.message}
            for issue in result.issues
        ],
    }


@app.post("/api/mermaid-fix")
def fix_mermaid(payload: MermaidFixRequest) -> dict:
    try:
        result = renderer.repair_mermaid_block(
            path=payload.path,
            line=payload.line,
            index=payload.index,
        )
        return {
            "path": result.relative_path,
            "line": result.line,
            "index": result.index,
            "fixed": result.fixed,
            "issues": result.issues,
        }
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=SAVE_PERMISSION_ERROR_DETAIL) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/{markdown_path:path}", response_class=HTMLResponse)
def direct_markdown_path(markdown_path: str, request: Request) -> HTMLResponse:
    try:
        content_path = renderer.resolve_content_path(markdown_path)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="Not found") from exc

    if not markdown_path.lower().endswith(VIEWER_SUFFIXES) and not content_path.is_dir():
        raise HTTPException(status_code=404, detail="Not found")
    return viewer_response(request)


if __name__ == "__main__":
    raise SystemExit(main())
