from __future__ import annotations

import argparse
import os
from collections.abc import Sequence
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

from .markdown_service import MarkdownRenderer

APP_ROOT = Path(__file__).resolve().parents[1]


def resolve_content_root(root_arg: str | None = None) -> Path:
    root_value = root_arg if root_arg is not None else os.getenv("MD_VIEWER_ROOT")
    root_path = Path(root_value).expanduser() if root_value else Path.cwd()
    return root_path.resolve()


CONTENT_ROOT = resolve_content_root()

app = FastAPI(title="MD Activator", docs_url=None, redoc_url=None)
app.mount("/assets", StaticFiles(directory=APP_ROOT / "to-html"), name="assets")
app.mount("/static", StaticFiles(directory=APP_ROOT / "app" / "static"), name="static")
templates = Jinja2Templates(directory=str(APP_ROOT / "app" / "templates"))
renderer = MarkdownRenderer(CONTENT_ROOT)


def configure_content_root(root: Path) -> Path:
    if not root.is_dir():
        raise ValueError(f"Content root does not exist or is not a folder: {root}")
    renderer.root_dir = root
    os.environ["MD_VIEWER_ROOT"] = str(root)
    return root


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Start the MD Activator local markdown server.")
    parser.add_argument(
        "--cd",
        metavar="FOLDER",
        help="Serve markdown from FOLDER instead of the current folder.",
    )
    parser.add_argument("--host", default="127.0.0.1", help="Bind host. Defaults to 127.0.0.1.")
    parser.add_argument("-p", "--port", type=int, default=8000, help="Bind port. Defaults to 8000.")
    reload_group = parser.add_mutually_exclusive_group()
    reload_group.add_argument("--reload", dest="reload", action="store_true", help="Enable Uvicorn reload.")
    reload_group.add_argument("--no-reload", dest="reload", action="store_false", help="Disable Uvicorn reload.")
    parser.set_defaults(reload=False)
    parser.add_argument("--no-use-colors", action="store_true", help="Disable Uvicorn color output.")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)

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


def viewer_response(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(request, "index.html", {"content_root": str(renderer.root_dir)})


@app.get("/", response_class=HTMLResponse)
def index(request: Request) -> HTMLResponse:
    return viewer_response(request)


@app.get("/api/render")
def render_markdown(
    path: str | None = Query(default=None, description="Relative path to markdown file"),
    base: str | None = Query(default=None, description="Current markdown path for resolving relative links"),
) -> dict:
    try:
        result = renderer.render(path=path, base=base)
        return {
            "path": result.relative_path,
            "html": result.html,
            "links": result.links,
            "files": result.files,
            "fileOptions": result.file_options,
        }
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


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
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/{markdown_path:path}", response_class=HTMLResponse)
def direct_markdown_path(markdown_path: str, request: Request) -> HTMLResponse:
    try:
        content_path = renderer.resolve_content_path(markdown_path)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="Not found") from exc

    if not markdown_path.lower().endswith(".md") and not content_path.is_dir():
        raise HTTPException(status_code=404, detail="Not found")
    return viewer_response(request)


if __name__ == "__main__":
    raise SystemExit(main())
