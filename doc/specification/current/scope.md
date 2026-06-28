# Scope: MD Activator

## System Boundary
The system is a local web application consisting of:
- A FastAPI HTTP server.
- A markdown rendering service.
- Static frontend assets and a Jinja-rendered page shell.
- A Vue/Quasar browser UI.
- A Windows launcher script.
- A POSIX shell launcher script.
- A VS Code desktop extension wrapper under `vscode-extension/`.

The content boundary is the configured content root:
- `--cd <folder>` when starting through the app CLI.
- `MD_VIEWER_ROOT` when set.
- The process working directory when `MD_VIEWER_ROOT` is not set.

## Supported Platforms
- The runtime app — the `start_md` launchers, the local FastAPI server and render/write pipeline, and the VS Code desktop extension — runs on Windows, macOS, and Linux.
- Windows-only surfaces, each with a documented fallback: the single-file `--open` desktop toast (on macOS/Linux the default browser opens directly, or the URL prints to the console when none is available), the optional `win11toast` dependency (gated by `sys_platform == 'win32'`), and the maintainer-only `.bat` build/release scripts (`vsix_package.bat`, `set-release-version.bat`, `release.bat`), which have no POSIX equivalent and are not needed to run the app. Detail in [features/launchers-and-packaging.md](features/launchers-and-packaging.md).

## In Scope
- Local HTTP serving for the viewer and render/write APIs.
- Rendering `.md` files from the configured content root.
- Defaulting to entering the configured content root folder, with readme-first and first-immediate-markdown selection.
- Resolving relative markdown paths against the current file when `base` is provided.
- Rejecting path traversal outside the content root.
- Rejecting non-`.md` render targets.
- Rendering markdown with fenced code blocks, tables, and table-of-contents-compatible header IDs.
- Rendering markdown image syntax, bare local image paths, and bare internet image URLs as images.
- Serving local image files through a constrained endpoint that only returns supported image files inside the configured content root.
- Preparing Mermaid fenced code blocks, raw Mermaid diagram blocks, and fenced maxGraph-compatible `mxGraphModel` or draw.io `mxfile` XML blocks for client-side diagram rendering.
- Converting supported task markers to interactive checkbox controls.
- Persisting supported checkbox, button-option, single-choice option, non-diagram fenced code block edits, and maxGraph entity/location title edits to source markdown files inside the configured content root.
- Discovering markdown links and same-folder files.
- Browser UI controls for same-folder file/folder selection, rendered-link navigation, direct URL paths, auto refresh, and theme selection.
- Restrained rendered-markdown heading sizes for readable long-form documents.
- Browser URL/history synchronization using direct relative paths with legacy `?path=` fallback.
- Local static serving of files under `to-html/` and `app/static/`.
- VS Code desktop editor-title preview command for markdown files.
- Side-by-side VS Code webview preview backed by the local FastAPI server.
- Local installable VSIX packaging metadata and staged runtime payload.

## Out of Scope
- General-purpose markdown editing beyond supported checkbox, button-option, single-choice option, and non-diagram fenced code block write-back.
- File creation, rename, move, or deletion.
- Recursive file tree explorer.
- Full-text search.
- User accounts, permissions, sharing, or collaboration.
- Server-side sessions or persistent app state.
- Hosted production deployment.
- Public internet exposure.
- Markdown synchronization with external services.
- VS Code Web, browser-only Codespaces, or web extension host support in v1.
- Native VS Code markdown rendering that bypasses the existing FastAPI/Vue renderer.
- Visual Studio Marketplace publishing in the first local validation milestone.

## External Dependencies
- Python runtime and packages listed in `pyproject.toml`.
- VS Code desktop 1.66.0 or newer.
- Node.js/npm for extension packaging.
- `uv` available to the VS Code extension through the configured command path.
- Local browser access to Vue, Quasar, Quasar Material Icons, Prism, Mermaid, and local app static maxGraph CSS/JS served by the app, with local app JavaScript providing authoritative maxGraph-compatible XML route selection and SVG rendering.
- Local app CSS and JavaScript served from `app/static/`.

## Trust and Security Boundary
The server must treat requested paths as untrusted input and must resolve them inside the configured content root before reading files. The app is intended for local trusted folders; exposing it to untrusted users or untrusted markdown content would require additional security analysis, especially around rendered HTML.

### Rendered HTML safety
The markdown renderer does **not** sanitize output. Source markdown is converted with `markdown.markdown(...)` using only the `fenced_code`, `tables`, `toc`, `sane_lists`, and table-class extensions; no HTML-sanitization extension or library (e.g. `bleach`/`nh3`) is applied, and raw HTML/script embedded in the source markdown passes through to the rendered page. Consequently:
- Rendered HTML is trusted exactly as much as the markdown file that produced it. Opening a markdown file is equivalent to executing any HTML/JavaScript it contains in the viewer's origin.
- The viewer is therefore safe **only** for content the operator already trusts (local, operator-authored folders). It is **not** safe to render markdown authored by untrusted parties.
- The output is **not** suitable for untrusted public hosting or multi-tenant exposure. Doing so would require introducing mandatory HTML sanitization and a re-analysis of the diagram/code-edit write-back endpoints, none of which exist today.

This is a deliberate, documented stance for the local-trusted-folder use case, consistent with the "Public internet exposure" and "Hosted production deployment" out-of-scope items above — not an unanalyzed gap.

## Operational Boundary
Standalone launchers do not manage process supervision, TLS, logs, or lifecycle beyond starting the local app server. If the default standalone port is occupied, operators must choose another port manually.

The VS Code extension manages its own spawned server lifecycle for preview sessions. It binds only to `127.0.0.1`, scans from port `49152` for a free port, logs process output to an extension output channel, and stops its spawned process on explicit stop or extension deactivation.

## Open Questions
- Should the project provide a documented alternate port workflow?
- Should root-folder file listing be available before the first successful render?
- ~~Should markdown HTML sanitization become mandatory for any non-local deployment?~~ Resolved: yes — mandatory HTML sanitization is a prerequisite for any non-local/untrusted deployment, which is currently out of scope. See "Rendered HTML safety" above.
- Should a later extension version support VS Code Web through a non-Python renderer or message-passing architecture?
