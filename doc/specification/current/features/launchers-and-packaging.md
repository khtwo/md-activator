# Launchers, VS Code Extension & Release Packaging

_[← Application Features index](../application-features.md)._ How the app is launched and packaged: the `start_md` launchers, the VS Code extension (manifest, preview command, server lifecycle, VSIX helper, packaging), and `release.bat`. The server lifecycle/CLI flags these drive are in [server-api.md](server-api.md).

## Supported platforms
The runtime app runs on Windows, macOS, and Linux:
- `start_md.bat` launches it from Windows (PowerShell/CMD); `start_md.sh` launches it from POSIX shells (macOS/Linux). Both share the same content-root, dependency-prep, `uv`-availability, and argument-forwarding behavior.
- The local server (`python -m app.main`), the markdown render/write pipeline, and the VS Code extension's spawned server are platform-neutral. The only Windows-specific runtime dependency, `win11toast` (the `--open` desktop toast), is gated behind `sys_platform == 'win32'` in `pyproject.toml` and imported lazily, so it is never required on macOS/Linux. The single-file idle auto-shutdown raises `SIGINT` in-process (works on both POSIX and Windows), and the VS Code extension spawns `uv` directly (not via `.bat`) and branches its process-tree termination on the platform.
- Windows-only surfaces, each with a documented fallback: the `--open` desktop toast (on macOS/Linux the file opens in the default browser directly, or the URL prints to the console — see [server-api.md](server-api.md)); and the maintainer build/release scripts below (`vsix_package.bat`, `set-release-version.bat`, `release.bat`), which are Windows batch wrappers with no POSIX equivalent. The release/version logic itself lives in the cross-platform `tools/release_version.py`; only the thin `.bat` wrappers are Windows-only, and none of them are needed to run the app.
- `.gitattributes` pins `*.sh` to `eol=lf` (so the `#!/usr/bin/env sh` shebang in `start_md.sh` survives checkout on any OS) and `*.bat` to `eol=crlf`.

## Launchers
`start_md.bat`:
- Accepts an optional content root argument.
- Defaults the content root to the current working directory.
- Verifies that `uv` is available before doing anything else; when `uv` is missing, prints a "uv was not found" message asking the user to install uv and exits with a non-zero code.
- Prepares the local runtime from the project dependency lock.
- Sets a project-local dependency cache.
- Starts the app through `python -m app.main`, passing `--cd <content_root>`.
- Starts with Uvicorn auto-reload enabled and `--no-use-colors` by default. Passing `--reload` or `--no-reload` clears the launcher's default reload flag so the caller's reload choice is the one forwarded to the app.
- Forwards additional app CLI arguments after the content root.

`start_md.sh`:
- Provides the same content-root, dependency preparation, `uv`-availability check, and argument forwarding behavior for POSIX shells.

## Installable Distribution (`uv tool install`)
The project is a buildable Python package, so the local web server can be installed as a standalone
command:
- `uv tool install git+https://github.com/khtwo/md-activator` (or `uv tool install <path>` against a
  release payload) builds a wheel and installs an `md-activator` console command into its own
  isolated tool environment.
- The console entry point is `md-activator = "app.main:main"` — the same `main()` that
  `python -m app.main` runs — so `md-activator [--cd FOLDER] [--open FILE] [--host …] [--port …] …`
  accepts the full server CLI (see [server-api.md](server-api.md)). With no `--cd`/`--open`, the
  content root defaults to the current working directory, so `md-activator` run inside a folder
  serves that folder.
- The wheel bundles every runtime asset needed to serve the editor: the `app/` package (including
  `app/static/**` and `app/templates/index.html`) plus the vendored `to-html/**` (mermaid, prismjs,
  quasar, vue). `to-html/` is force-included at the wheel root so the runtime's
  `APP_ROOT = Path(__file__).resolve().parents[1]` resolves it identically in the installed layout
  and in the source/release layout — no runtime code path differs between the two.
- The wheel excludes non-runtime artifacts: `__pycache__/`, `*.pyc`, the `app/graphify-out/`
  graphify dev cache, and the documentation-only `img/` tree (unused by the running server).
- Build backend: `hatchling`. Dependencies are the same `[project.dependencies]` the launchers use;
  the Windows-only `win11toast` stays gated behind `sys_platform == 'win32'`, so the install works
  on macOS/Linux. The install is read-only-safe: the server only reads its bundled assets, and its
  writable state (the per-user viewed registry and the user's content folder) lives outside the
  package.
- The same layout keeps the **development** workflow working: `uv sync` / `uv run python -m app.main`
  and the `start_md` launchers install the project as an editable package and resolve `to-html/` at
  the repo root exactly as before.

## VS Code Extension
The VS Code extension lives under `vscode-extension/` and packages MD Activator as a VS Code desktop extension.

Extension manifest:
- Uses publisher `khtwo` and extension name `md-activator`.
- Declares VS Code desktop compatibility with `engines.vscode` `^1.66.0`.
- Contributes command `mdActivator.openPreviewToSide` with an editor-title icon visible for markdown files — when the editor language id is `markdown` **or** the resource extension is a supported markdown extension (`.md`, `.markdown`, `.mdown`, `.mkdn`, case-insensitive, matching the extension's own `isMarkdownFilePath`). The extension-based fallback keeps the icon visible on markdown files whose language id is reassigned by VS Code's content-based language detection (e.g. a `SKILL.md` whose YAML frontmatter is detected as `yaml`).
- Contributes command `mdActivator.stopServer` for stopping the spawned local preview server.
- Contributes settings `mdActivator.portStart` and `mdActivator.uvPath`.
- Includes local VSIX listing metadata: display name, description, categories, keywords, README, changelog, icon, publisher ID, and license reference.

Preview command behavior:
- Determines the previewable markdown file the same way the editor-title icon decides visibility: the resolved file counts as markdown when the editor language id is `markdown` **or** its path has a supported markdown extension (`.md`, `.markdown`, `.mdown`, `.mkdn`, case-insensitive, matching the extension's own `isMarkdownFilePath`). This applies to both invocation paths — an editor-title icon click (which passes the clicked resource) and a Command Palette / keybinding invocation (which uses the active editor) — so a `.md` file whose language id VS Code reassigned by content-based language detection (e.g. a `SKILL.md`/`CLAUDE.md` whose YAML frontmatter is detected as `yaml`) is previewed rather than rejected. The command keeps refusing genuinely non-markdown resources (a non-`markdown` language id whose path is also not a supported markdown extension) with the "Open a markdown file..." error.
- When invoked from a workspace markdown file, uses that workspace folder as the content root.
- When invoked from a standalone markdown file outside a workspace, uses the file's parent folder as the content root.
- Computes the preview URL path as the markdown file path relative to the selected content root, normalized with `/` separators.
- Starts or reuses a local MD Activator server bound to `127.0.0.1`.
- Selects the first free TCP port at or above `mdActivator.portStart`, which defaults to `49152`.
- Runs the staged server payload through the configured `uv` command, allowing `uv run` to create or synchronize the staged Python environment on first launch.
- Before starting the server, verifies that the configured `uv` command can run and that `uv run --native-tls python --version` can resolve a Python runtime from the staged server environment.
- Opens a `WebviewPanel` in `ViewColumn.Beside` so the source markdown editor remains visible beside the rendered preview.
- Sets the panel tab title to `MD Activator - <basename>` of the previewed file at creation, and keeps it in sync with the file actually shown inside the preview: when the embedded viewer changes file, it posts a `md-activator:title` message that the webview wrapper relays to the extension host, which updates `panel.title` to `MD Activator - <simple name>` (or plain `MD Activator` when no file). The previous `MD Activator: <name>` colon form is replaced so the panel tab and the browser tab share one format.
- Enables webview scripts because the iframe loads the existing browser UI.
- Retains the webview context when the preview tab is hidden (`retainContextWhenHidden`) so the rendered preview keeps its state instead of reloading when the panel loses focus.
- Sets webview `portMapping` for the selected localhost port so the iframe targets the same dynamic port that the extension server actually uses.
- Renders a minimal webview wrapper whose iframe points to the MD Activator server and direct markdown URL path. The wrapper carries a nonce'd relay `<script>` (allowed by a `script-src 'nonce-…'` Content-Security-Policy entry) that calls `acquireVsCodeApi()` and forwards the iframe's `md-activator:title` messages to the extension host as `{ type: 'title', simpleName }`; it validates message shape only (the payload is a non-sensitive filename and a tab label is low-risk, so frame origin is not pinned).
- Relies on the existing browser UI auto-refresh for source-editor changes in v1.

Server lifecycle behavior:
- Reuses the existing spawned server when the requested content root matches the current server.
- Stops and replaces the spawned server when a preview requires a different content root.
- Writes stdout, stderr, selected port, content root, and startup failures to an `MD Activator` output channel.
- Stops the spawned server when `mdActivator.stopServer` runs or the extension deactivates.
- Reports missing active markdown editor, missing `uv`, missing Python/runtime setup, dependency sync failure, and server start failure through VS Code user-visible errors.

Root VSIX package helper:
- `vsix_package.bat` builds the local VS Code extension package into `vscode-extension/vsix-package/`.
- The output filename is `md-activator-<version>.vsix`, where `<version>` comes from `vscode-extension/package.json`.
- The helper rejects missing or unsafe version values that could escape the package folder.
- The helper fails when the expected VSIX output is not created.

Packaging behavior:
- A staging script copies the Python app runtime payload into `vscode-extension/server/`. Before copying, it verifies the required runtime entry points exist (`app/main.py`, `app/markdown_service.py`, `app/markdown_services/__init__.py`) and fails fast if any is missing; while copying directories it skips `__pycache__/` directories, `.pyc` files, and the `app/graphify-out/` graphify knowledge-graph cache (a development artifact), so they never reach the VSIX.
- The staged runtime includes `app/`, `to-html/`, `pyproject.toml`, `uv.lock`, `README.md`, `LICENSE`, `THIRD_PARTY_NOTICES.txt`, and launcher scripts.
- The extension package excludes development caches, tests, source-control files, documentation source, previous release output, and unstaged root files not needed at runtime.
- `@vscode/vsce` packages the extension as a local installable VSIX.
- Marketplace publishing is deferred until the local VSIX behavior is validated.

## Release Version Bump
`set-release-version.bat`:
- Accepts one required `<version>` argument and rejects missing or unsafe values
  (`.`, `..`, or values containing `\`, `/`, `:`) with a usage message and a non-zero
  exit code, consistent with `release.bat` and `vsix_package.bat`.
- Is a thin wrapper: after validating the argument shape it delegates to
  `tools/release_version.py`, which holds all string-editing logic.
- Reads the current version from `pyproject.toml` (the source of truth) and replaces
  that value with `<version>` at every anchored current-version reference: `pyproject.toml`,
  `vscode-extension/package.json`, the `md-activator` package block in `uv.lock`, the two
  root `"version"` fields in `vscode-extension/package-lock.json`, the
  `md-activator-<version>.vsix` references in `README.md`, `vscode-extension/README.md`,
  and `vscode-extension/vsix-package/README.md`, and the `Version: <version>` line in the
  vsix-package README.
- Edits lockfiles surgically (only the project's own root entry, keyed on
  `name = "md-activator"`), so a dependency that happens to share the old version number is
  left untouched. It does not run `uv lock` / `npm install`, so it introduces no unrelated
  dependency churn; a full re-resolve stays a separate maintainer choice.
- Treats `vscode-extension/CHANGELOG.md` as append-only: it prepends a new `## <version>`
  section above the existing entries, never rewriting a prior heading, and is idempotent when
  that section already exists.
- Drafts the new section's bullets from git commit subjects since the previous release. The
  boundary is the commit that set the current (pre-bump) version in `pyproject.toml` (found
  via git pickaxe, since the project does not tag releases); the bullets are the commit
  subjects in `<boundary>..HEAD`. Only commit subjects are used (never bodies), to limit
  what internal detail can surface.
- Includes user-facing changes (new features and fixes) and drops internal/mechanical
  commits via a keyword denylist (e.g. graphify, vsix, pyproject, lockfiles, changelog,
  spec/docs, tests, refactors, version-bump/tooling commits) and a sensitive denylist
  (e.g. secret, token, password, key, oauth, `.env`). Duplicate subjects are collapsed.
- The generated bullets are a reviewable DRAFT, not a guarantee: the keyword filter reduces
  but cannot guarantee removal of sensitive text, so the tool prints a reminder to review the
  CHANGELOG before releasing. The maintainer is the final safeguard.
- Falls back to a `- Release <version>.` placeholder when git is unavailable, the boundary
  cannot be resolved, or no user-facing commits are found — the bump never fails on changelog
  generation.
- Prints a per-file summary of how many references changed (and which files were skipped),
  and reminds the maintainer to rebuild the VSIX with `vsix_package.bat` and refresh the
  `SHA256:` line in `vsix-package/README.md`. The bumper cannot hash a not-yet-built
  package, so it deliberately leaves the `*.vsix` binary and its SHA256 untouched.

## Release Packaging
`release.bat`:
- Takes no version argument: it reads the current set release version from
  `pyproject.toml` (the source of truth) and packages that version. Run
  `set-release-version.bat <version>` first to change the version.
- Rejects any passed argument with a non-zero exit code and guidance to run
  `set-release-version.bat <version>` first.
- Derives the version through `tools/release_version.py --current` (the same
  `read_current_version` helper used by the bump tool), and fails with a non-zero exit
  code and a clear message if the current version cannot be read.
- Creates `release/<current-version>/` under the project root.
- Copies only the runtime application payload and explicitly required release
  metadata into the release folder.
- Includes these runtime directories: `app/` and `to-html/`.
- Includes these runtime/configuration files: `pyproject.toml` and `uv.lock`.
- Includes these required release metadata and launcher files: `LICENSE`,
  `README.md`, `THIRD_PARTY_NOTICES.txt`, `development_progress.md`,
  `start_md.bat`, and `start_md.sh`.
- Includes git metadata so the payload can be committed straight into a public git
  repository: `.gitattributes` (copied from the repo root, keeping the `*.sh`→LF /
  `*.bat`→CRLF line-ending rules so the shipped launchers stay correct on clone), and a
  `.gitignore` copied from the `release-assets/gitignore` template. The template is a
  curated, public-facing subset of the development `.gitignore` — it ignores only the
  artifacts a consumer generates by running the app or building the extension
  (`__pycache__/`, `.venv/`, `.uv-cache/`, `node_modules/`, the regenerated
  `vscode-extension/server/`, `.env*`, logs, editor/OS metadata) and deliberately omits
  the dev-harness/test-runner entries (e.g. `taskTypes`/pytest-temp/graphify caches) that
  are meaningless in a public consumer repository.
- Includes the `img/` directory contents.
- Includes the `vscode-extension/` directory so the release contains the local
  VS Code install package and extension metadata.
- Includes `vscode-extension/vsix-package/` with its VSIX and install notes.
- Requires the VS Code extension package inputs to be present: it fails with a
  "Missing required" message and a non-zero exit code when `vscode-extension/`,
  `vscode-extension/vsix-package/`, or a built `*.vsix` under
  `vscode-extension/vsix-package/` is absent.
- From the copied runtime directories it excludes Python cache (`__pycache__/`
  folders and `*.pyc` files) and the `app/graphify-out/` graphify knowledge-graph
  cache (a development artifact). Package `__init__.py` markers are **kept**, because
  `app/markdown_services/__init__.py` is load-bearing — `python -m app.main` imports
  it via `from .markdown_services import *`, so dropping it would break the released
  server.
- Includes the product documentation subset `doc/specification/current/` and
  `doc/requirements/`. The development-history change specs under
  `doc/specification/changes/` and the agent stack notes under `doc/tech-stack/`
  are excluded.
- Excludes development, source-control, test, AI-agent-harness, cache, virtual
  environment, package artifact, and prior release output folders such as `.git/`,
  `.venv/`, `.uv-cache/`, `tests/`, `taskTypes/`, `tools/`, `graphify-out/`,
  `package/`, and `release/`, plus the AI-harness files `CLAUDE.md` and `AGENTS.md`
  (the script copies an explicit allowlist, so unnamed dev/harness content is
  excluded by default).
- Excludes temporary or development-only VS Code extension content such as
  `vscode-extension/node_modules/`, `vscode-extension/server/`,
  `vscode-extension/test/`, `vscode-extension/.vscode/`, Python and tool cache
  folders (`__pycache__/`, `.pytest_cache/`, `.uv-cache/`), and loose
  `vscode-extension/*.vsix` files outside `vscode-extension/vsix-package/`.
- Fails with a "Missing required directory/file" message and a non-zero exit
  code when any required runtime source input (`app/`, `to-html/`, `img/`, or a
  required runtime/metadata/launcher file) is absent.
- Fails when `release/<current-version>/` already exists so a release cannot contain
  stale files from a previous run.
- Rejects an explicit argument with guidance, and still guards the derived version
  against values that would escape the `release/` folder.
- The payload is validated by a runnable smoke check: the test suite packages the
  real runtime and imports `app.main` from the produced payload, so a non-importable
  release (for example a missing package `__init__.py`) fails the build instead of
  shipping silently.
- The payload doubles as an installable-package source: because it carries
  `pyproject.toml`, `app/`, `to-html/`, and `README.md`, the committed
  `khtwo/md-activator` repository is directly usable with
  `uv tool install git+https://github.com/khtwo/md-activator` (see
  **Installable Distribution** above). This is guarded by a test that builds a wheel from
  the produced payload and asserts the `md-activator` entry point and bundled `to-html/`.
