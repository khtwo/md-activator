# Local Server & HTTP API

_[← Application Features index](../application-features.md)._ Server lifecycle and CLI, content-root selection and the content-root trust boundary, in-process render/folder caches, and every `/api/*` endpoint contract.

## Local Server
- `python -m app.main` starts the local app server.
- The server content root is selected in this precedence order: `--cd <folder>`, `MD_VIEWER_ROOT`, then the process working directory.
- `--cd <folder>` must resolve to an existing folder and starts the server with that folder as the configured content root.
- `--open <file>` starts the server in single-file mode: `<file>` must resolve to an existing regular `.md` file (otherwise the launcher reports a usage error and does not start the server), the configured content root is set to the file's parent folder, and the file's URL-relative path (relative to that parent, normalized with `/`) is announced once the server is listening. When `--open` is provided it determines the content root; any simultaneously supplied `--cd` is ignored for root selection (so the launchers, which always inject `--cd <content_root>`, do not conflict with `--open`). This reuses the same "file's parent folder as content root + markdown path relative to that root" rule the VS Code extension uses for standalone files (see "Preview command behavior").
- After the server is accepting connections, single-file mode announces the file exactly once. On Windows: a desktop toast titled `MD Activator` whose click opens the announced URL in the system default browser (Windows protocol activation; no in-process click listener). On non-Windows platforms (macOS/Linux): the announced URL is opened directly in the default browser via the standard-library `webbrowser`. The announced URL is printed to the console as a fallback whenever the chosen mechanism cannot deliver it — when the Windows toast cannot be produced, when no browser can be launched on macOS/Linux (e.g. a headless session, where `webbrowser.open` returns false), or when either call raises. The announced URL is `http://<host>:<port>/<url-quoted relative path>`, substituting `127.0.0.1` for a wildcard/unspecified bind host (`0.0.0.0`, `::`, or empty). The announcement runs on a background daemon thread and never blocks or crashes the server.
- Single-file (`--open`) mode auto-shuts-down on inactivity: the idle clock starts at the first received HTTP request ("first access"), and once no HTTP request of any kind arrives for 120 seconds (2 minutes) the server shuts itself down gracefully (the same clean lifespan shutdown as Ctrl+C). Any incoming request — page loads, `/api/*` calls, static-asset fetches, and the viewer's background auto-refresh poll (default every 3 s) — resets the timer, so while a browser tab stays open the server keeps running and it shuts down roughly one idle window after the last tab is closed. Auto-shutdown applies only to `--open` mode; servers started with `--cd`/`MD_VIEWER_ROOT`/cwd never auto-shut-down. `--open` forces uvicorn into single-process mode (reload disabled, overriding any `--reload`, just as it overrides `--cd`), so the idle shutdown fully terminates the launcher process and frees the bound port instead of leaving a parent reloader process behind; if `--reload` was requested, the launcher prints a one-line notice that it is disabled in single-file mode.
- The server also accepts `--host` (default `127.0.0.1`), `-p`/`--port`, `--reload`/`--no-reload` (Uvicorn auto-reload, defaulting to off when the app is started directly), and `--no-use-colors` (disable Uvicorn color output).
- Default-port auto-fallback: when no explicit `-p`/`--port` is given, the launcher probes the preferred port `8000` on the requested bind host (a plain TCP bind test, no `SO_REUSEADDR`; `AF_INET6` for IPv6 host literals). If 8000 is free it is used; otherwise the first available port in `20000–20999` (ascending) is selected and a one-line console notice `MD Activator: port 8000 is in use; using port <N>.` is printed. The resolved port is used for both the uvicorn bind and the `--open` ready announcement URL. An explicitly passed `--port` is used exactly as given — no probe, no fallback (a busy explicit port still fails at bind time), which the VS Code extension relies on (it picks its own free port and passes it explicitly). If the preferred port and the whole fallback range are busy, startup fails as a usage error (exit code 2) naming the exhausted range. The fallback range `20000–20999` sits below every supported OS's default ephemeral port range (Linux 32768+, Windows/macOS 49152+), so the scan does not contend with OS-assigned outbound ports.
- `--span <N>` sets the new-`.md`-file notification time span in **populated days** (integer `N ≥ 1`, default `3`); a non-integer or `N < 1` is a usage error (exit code 2). The span counts only days that contain markdown-file activity (see the populated-day rule in [file-navigation.md](file-navigation.md)). The value is forwarded to the serving process via the `MD_VIEWER_SPAN_DAYS` environment variable (an unset, non-integer, or `< 1` value resolves to the default), so it survives uvicorn re-importing the app module.
- `GET /` returns the viewer page shell from `app/templates/index.html`.
- `GET /<relative_md_path>` returns the viewer page shell for direct markdown file URLs. The same direct-URL shell is returned for `.yml`, `.yaml`, `.json`, and `.jsonl` file URLs.
- `GET /api/render` renders a markdown file and returns JSON.
- `/assets` serves bundled assets from `to-html/`.
- `/static` serves app assets from `app/static/`.
- The server keeps an in-process markdown render cache for resolved `.md` files.
- Cached file render entries store rendered HTML, discovered markdown links, the file's last modification timestamp, last access time, and recent access history.
- A cached markdown file render may be reused only when the resolved file's current last modification timestamp matches the cached timestamp.
- When the timestamp differs, the server renders the file normally, replaces the cache entry, and returns the new render content.
- Cached entries that have not been accessed for 60 seconds are removed.
- A backend app timer triggers cache cleanup every 10 seconds while the FastAPI app is running.
- The cache stores at most 100 markdown file entries. When full, it evicts the entry with the fewest accesses in the last 20 seconds, using the oldest last-access time as the tie-breaker.
- Folder-only empty render results are not cached.
- The server keeps a separate in-process folder metadata cache for render response navigation metadata.
- Folder metadata cache entries are keyed by resolved folder path, so different markdown files in the same folder reuse the same dropdown option list.
- Folder metadata cache entries store 3-level `fileOptions`, load time, and last access time.
- Render requests made when the file/folder dropdown opens use the same folder metadata cache. If the cache entry is still fresh under the 5-second rule, the server may reuse it instead of forcing an immediate disk rescan.
- Folder metadata cache entries may be reused for 5 seconds from load time. Request traffic updates last access time but does not extend the 5-second freshness window.
- Expired folder metadata is rebuilt with a single markdown-descendant scan for the current dropdown root rather than repeated descendant scans per visible folder.
- Folder metadata cache cleanup runs from the backend app timer and removes expired entries.
- The folder metadata cache stores at most 100 folder entries. When full, it evicts the oldest last-accessed folder metadata entry.
- Every successful write-back operation — checkbox, code-block, maxGraph node position, maxGraph multi-node group move, maxGraph node title, maxGraph edge title, maxGraph node add/delete, maxGraph edge add/delete, maxGraph block update, mermaid node title, mermaid edge title, mermaid block update, and mermaid repair — invalidates the affected file's cached render entry. (`GET /api/mermaid-block-source` and `GET /api/maxgraph-block-source` are read-only and have no cache side effects.)

## Markdown Render API
Endpoint: `GET /api/render`

Query parameters:
- `path`: optional relative markdown file or folder path. Defaults to the configured content root folder.
- `base`: optional current markdown path used to resolve relative markdown links.
- `includeFileOptions`: optional boolean. Defaults to `true`. When `false`, the response renders markdown content but does not rebuild or return `fileOptions` navigation metadata.
- `ifRenderVersion`: optional render-version token from the client's current full render payload. When it matches the resolved markdown file's current version, the response may return a no-change signal instead of a full render payload.

Successful response:
```json
{
  "path": "README.md",
  "renderVersion": "README.md:1760000000000000000",
  "html": "<h1 id=\"...\">...</h1>",
  "links": ["other.md"],
  "fileOptions": [
    {"label": "AGENTS.md", "value": "AGENTS.md", "kind": "file", "hasMarkdown": true, "depth": 0},
    {"label": "docs", "value": "docs", "kind": "folder", "hasMarkdown": true, "depth": 0},
    {"label": "guide.md", "value": "docs/guide.md", "kind": "file", "hasMarkdown": true, "depth": 1}
  ]
}
```

When `includeFileOptions=false`, successful changed-content responses include `path`, `renderVersion`, `html`, and `links`, and omit `fileOptions`.

A successful full render whose resolved `path` is a `.md` file additionally records that file as *viewed* for the New Markdown File Notifications feature; `no-change` responses and folder or empty renders do not record a view.

When `ifRenderVersion` matches the resolved markdown file's current `renderVersion`, successful responses return only:
```json
{
  "status": "no-change"
}
```

The no-change check is keyed on the *resolved* markdown file's current `renderVersion`, so it returns `no-change` whenever the request resolves to a markdown file whose version still matches the token — including requests that resolve through readme-first entry, the missing-`README.md`/`readme.md` folder fallback, or a folder that resolves to its entry markdown file. A request that resolves to no markdown file at all (a folder with no immediate `.md`, whose empty `No .md files found.` render carries no render version) always returns a full render payload, as does a changed file render.

Endpoint: `POST /api/checkbox`

Request body:
```json
{
  "path": "README.md",
  "line": 12,
  "index": 0,
  "checked": true
}
```

Successful response:
```json
{
  "path": "README-done.md",
  "line": 12,
  "index": 0,
  "checked": true
}
```

Errors:
- `400`: path escapes the content root, target is not a `.md` file, line/index is invalid, or the target no longer contains a supported checkbox marker.
- `403`: the server cannot write the markdown file because filesystem permissions deny the save. The response body is JSON with a user-visible `detail` message.
- `404`: target markdown file does not exist.

Endpoint: `POST /api/code-block`

Request body:
```json
{
  "path": "README.md",
  "line": 20,
  "index": 0,
  "content": "updated code block text"
}
```

Successful response:
```json
{
  "path": "README.md",
  "line": 20,
  "index": 0
}
```

Errors:
- `400`: path escapes the content root, target is not a `.md` file, line/index is invalid, or the target no longer contains a supported fenced code block.
- `403`: the server cannot write the markdown file because filesystem permissions deny the save. The response body is JSON with a user-visible `detail` message.
- `404`: target markdown file does not exist.

Endpoint: `GET /api/file/{file_path:path}`

Path parameters:
- `file_path`: relative non-`.md` file path inside the configured content root.

Successful response:
- Returns the file bytes as an attachment download.

Errors:
- `400`: path escapes the content root or targets a `.md` file.
- `404`: target file does not exist, or the path targets a folder (the endpoint serves only existing non-`.md` files, so a folder target is reported as not-found rather than as a bad request).

The viewer also exposes a local image endpoint and the diagram write-back / repair endpoints used by the rendered-diagram editors. They live inside the same content-root trust boundary and, except for the parse-only `/api/mermaid-diagnose`, use the same `400`/`403`/`404` error model as `/api/checkbox` and `/api/code-block`.

Endpoint: `GET /api/image/{image_path:path}`

Path parameters:
- `image_path`: relative image file path inside the configured content root.

Successful response:
- Returns the image file bytes (used as the `src` of rendered local images).

Errors:
- `400`: path escapes the content root, or the target is a non-image file (extension not one of `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`, `.svg`).
- `404`: target image file does not exist.

Endpoint: `POST /api/maxgraph-node`

Persists a dragged maxGraph entity box's new location.

Request body: `{ "path": "diagram.md", "line": 10, "index": 0, "nodeId": "n1", "x": 120.0, "y": 80.0 }`

Successful response: `{ "path": "diagram.md", "line": 10, "index": 0, "nodeId": "n1", "x": 120.0, "y": 80.0 }`

Errors: `400` (path escapes the content root, target is not a `.md` file, line/index is invalid, or the maxGraph block/cell cannot be located), `403` (filesystem permissions deny the save), `404` (target markdown file does not exist).

Endpoint: `POST /api/maxgraph-nodes`

Persists a group move of several dragged maxGraph entity boxes in one atomic write. Every listed vertex's `mxGeometry` `x`/`y` is rewritten in a single file write; if any listed vertex cannot be located, none are written.

Request body: `{ "path": "diagram.md", "line": 10, "index": 0, "nodes": [{ "nodeId": "n1", "x": 120.0, "y": 80.0 }, { "nodeId": "n2", "x": 240.0, "y": 80.0 }] }`

Successful response: `{ "path": "diagram.md", "line": 10, "index": 0, "nodes": [{ "nodeId": "n1", "x": 120.0, "y": 80.0 }, { "nodeId": "n2", "x": 240.0, "y": 80.0 }] }`

Errors: same `400`/`403`/`404` model as `POST /api/maxgraph-node` (the `400` also covers an empty `nodes` list, an empty `nodeId`, non-finite coordinates, or a `nodeId` that is not an existing vertex).

Endpoint: `POST /api/maxgraph-node-title`

Persists an inline maxGraph entity-box title edit. An empty (`""`) title is normalized to `_` before it is written (the response and auto-resize use the normalized value). As a side effect, the vertex is auto-resized to fit the new title: the cell's `mxGeometry` `height` is set to a fixed `60` and `width` to the title-fitted value clamped to `[90, 360]` (skipped when the cell has no `mxGeometry`).

Request body: `{ "path": "diagram.md", "line": 10, "index": 0, "nodeId": "n1", "title": "New title" }`

Successful response: `{ "path": "diagram.md", "line": 10, "index": 0, "nodeId": "n1", "title": "New title" }`

Errors: same `400`/`403`/`404` model as `POST /api/maxgraph-node`.

Endpoint: `POST /api/maxgraph-edge-title`

Persists an inline maxGraph edge-title edit. An empty (`""`) title is written as an empty `value` (`value=""`); it is not normalized to a placeholder (an untitled edge stays re-editable by double-clicking its connector line). The response returns the saved title verbatim.

Request body: `{ "path": "diagram.md", "line": 10, "index": 0, "edgeId": "e1", "title": "New label" }`

Successful response: `{ "path": "diagram.md", "line": 10, "index": 0, "edgeId": "e1", "title": "New label" }`

Errors: same `400`/`403`/`404` model as `POST /api/maxgraph-node`.

Endpoint: `POST /api/maxgraph-node-add`

Inserts a new maxGraph vertex (a node) into a maxGraph block. The new cell's `nodeId` is supplied by the caller (generated in the browser to be unique within the block, so undo/redo stays stable).

Request body: `{ "path": "diagram.md", "line": 10, "index": 0, "nodeId": "node-3", "title": "New", "x": 320, "y": 40 }`

Successful response: `{ "path": "diagram.md", "line": 10, "index": 0, "nodeId": "node-3", "title": "New", "x": 320, "y": 40 }`

Errors: same `400`/`403`/`404` model as `POST /api/maxgraph-node` (the `400` also covers a duplicate `nodeId`, an empty `nodeId`, or non-finite coordinates).

Endpoint: `POST /api/maxgraph-node-delete`

Removes a maxGraph vertex by id (also the reverse of `maxgraph-node-add`, used by undo). Removing the vertex **cascades**: every edge connected to it (an edge whose `source` or `target` is `nodeId`) is removed in the same operation, so no dangling edge is left in the block. (Undo-of-add reaches this path with a freshly added, edgeless node, so the cascade is then a no-op and the add→delete round-trip still restores the block byte-for-byte.)

Request body: `{ "path": "diagram.md", "line": 10, "index": 0, "nodeId": "node-3" }`

Successful response: `{ "path": "diagram.md", "line": 10, "index": 0, "nodeId": "node-3" }`

Errors: same `400`/`403`/`404` model as `POST /api/maxgraph-node` (the `400` also covers a `nodeId` that is not an existing vertex).

Endpoint: `POST /api/maxgraph-nodes-delete`

Removes several maxGraph vertices (a selected group) in one atomic write. Each listed vertex is removed and its connected edges **cascade** away (every edge whose `source` or `target` is any listed `nodeId`), so no dangling edge is left in the block; an edge whose both endpoints are listed is removed once. If any listed vertex cannot be located, none are removed. Used by the Delete button when one or more nodes are selected; the browser captures the pre-delete block XML so the whole group delete can be undone via `maxgraph-block-restore`.

Request body: `{ "path": "diagram.md", "line": 10, "index": 0, "nodeIds": ["n1", "n2"] }`

Successful response: `{ "path": "diagram.md", "line": 10, "index": 0, "nodeIds": ["n1", "n2"] }`

Errors: same `400`/`403`/`404` model as `POST /api/maxgraph-node` (the `400` also covers an empty `nodeIds` list, an empty `nodeId`, or a `nodeId` that is not an existing vertex).

Endpoint: `POST /api/maxgraph-edge-add`

Inserts a new maxGraph edge from `sourceId` to `targetId`. The caller supplies the unique `edgeId`.

Request body: `{ "path": "diagram.md", "line": 10, "index": 0, "edgeId": "edge-2", "title": "New", "sourceId": "start", "targetId": "end" }`

Successful response: `{ "path": "diagram.md", "line": 10, "index": 0, "edgeId": "edge-2", "title": "New", "sourceId": "start", "targetId": "end" }`

Errors: same `400`/`403`/`404` model as `POST /api/maxgraph-node` (the `400` also covers a duplicate `edgeId`, an empty `edgeId`, a `sourceId`/`targetId` that is not an existing vertex, or `sourceId == targetId`).

Endpoint: `POST /api/maxgraph-edge-delete`

Removes a maxGraph edge by id (the reverse of `maxgraph-edge-add`, used by undo).

Request body: `{ "path": "diagram.md", "line": 10, "index": 0, "edgeId": "edge-2" }`

Successful response: `{ "path": "diagram.md", "line": 10, "index": 0, "edgeId": "edge-2" }`

Errors: same `400`/`403`/`404` model as `POST /api/maxgraph-node` (the `400` also covers an `edgeId` that is not an existing edge).

Endpoint: `POST /api/maxgraph-block-restore`

Replaces a maxGraph block's entire XML body with a caller-supplied snapshot. Used to undo a delete: the browser captures the block XML before a delete and writes it back here on Ctrl+Z, restoring a deleted node together with all its cascaded edges (and any other cells) with full fidelity. The supplied `xml` is validated to parse as an `mxGraphModel` (or an `mxfile` wrapping one) before it is written.

Request body: `{ "path": "diagram.md", "line": 10, "index": 0, "xml": "<mxGraphModel>…</mxGraphModel>" }`

Successful response: `{ "path": "diagram.md", "line": 10, "index": 0 }`

Errors: same `400`/`403`/`404` model as `POST /api/maxgraph-node` (the `400` also covers empty `xml` or XML that is not a maxGraph model).

Endpoint: `GET /api/maxgraph-block-source`

Returns a maxGraph block's current on-disk body (used by the source-toggle editor's prefill; change package `2026-07-11-maxgraph-source-toggle`). Read-only: no write, no cache side effects. The prefill is disk truth, so an empty block yields an empty `xml` (never the browser's in-memory empty-canvas substitution). No `fenced` field — maxGraph blocks are fenced-only.

Query parameters: `path` (relative `.md` path), `line` (block anchor line), `index` (block occurrence index) — the same block identity carried by `data-maxgraph-line`/`data-maxgraph-index`.

Successful response: `{ "path": "diagram.md", "line": 10, "index": 0, "xml": "<block body>" }`

Errors: `400` (path escapes the content root, target is not a `.md` file, line/index is invalid, or the block cannot be located), `404` (target markdown file does not exist). No `403`: the endpoint never writes.

Endpoint: `POST /api/maxgraph-block-update`

Persists a maxGraph source-toggle editor save, replacing the block body with `xml` verbatim. Unlike `POST /api/maxgraph-block-restore` it performs **no XML validation** — render-gating is client-side, and a block whose XML is already broken may save a still-invalid partial fix — and an **empty body is a valid save** (the empty maxGraph canvas). The server applies a **round-trip boundary guard**: re-scanning the would-be file must find the same maxGraph block (same occurrence index and opening-fence anchor) whose content bounds exactly cover the replacement, so a body line that would terminate the fence early is rejected with `400` and nothing is written. Invalidates the file's cached render entry. The `previousXml`/`xml` snapshot pair feeds the shared undo history; `maxgraph-source-edit` undo/redo replays through this endpoint (not `maxgraph-block-restore`, which keeps validating and keeps rejecting an empty body).

Request body: `{ "path": "diagram.md", "line": 10, "index": 0, "xml": "<new block body>" }`

Successful response: `{ "path": "diagram.md", "line": 10, "index": 0, "previousXml": "<body before>", "xml": "<body after>" }`

Errors: same `400`/`403`/`404` model as `POST /api/maxgraph-node` (the `400` also covers the boundary guard).

Endpoint: `POST /api/mermaid-node-title`

Persists an inline Mermaid entity-box title edit.

Request body: `{ "path": "diagram.md", "line": 10, "index": 0, "diagramType": "flowchart", "nodeId": "A", "title": "New title" }`. `diagramType` must be one of `flowchart`, `er`, `class`, or `state`; `nodeId` and `title` must be non-empty.

Successful response: `{ "path": "diagram.md", "line": 10, "index": 0, "diagramType": "flowchart", "nodeId": "A", "title": "New title" }`

Errors: same `400`/`403`/`404` model as `POST /api/maxgraph-node` (the `400` also covers an unsupported `diagramType` or an empty `nodeId`/`title`).

Endpoint: `POST /api/mermaid-edge-title`

Persists an inline Mermaid edge-label edit. The edge is located per diagram type: by relationship/transition ordinal (`edgeIndex`) for erDiagram/classDiagram/stateDiagram, or by `source`/`target`/`occurrence` for flowchart. Omitted locators default to empty strings and `0`. `diagramType` must be one of `flowchart`, `er`, `class`, or `state` (the same short forms used by `POST /api/mermaid-node-title`). An empty (`""`) `title` clears the edge's label (the flowchart link drops back to a bare arrow; erDiagram/classDiagram/stateDiagram drop the `: label`), leaving the edge present and re-editable by double-clicking its connector line; a non-empty title is written verbatim.

Request body: `{ "path": "diagram.md", "line": 10, "index": 0, "diagramType": "flowchart", "source": "A", "target": "B", "occurrence": 0, "edgeIndex": 0, "title": "New label" }`

Successful response: echoes `path`, `line`, `index`, `diagramType`, `source`, `target`, `occurrence`, `edgeIndex`, and `title`.

Errors: same `400`/`403`/`404` model as `POST /api/maxgraph-node` (the `400` also covers an unsupported `diagramType`; an empty `title` is no longer an error — it clears the label).

Endpoint: `POST /api/mermaid-node-add`

Appends a new isolated node titled "New" to a Mermaid block and re-renders. The node id is **server-generated** and unique within the block (smallest unused `New_<n>`), because the client only sees rendered node ids (which can miss an id present in source but not rendered). Per-type synthesis: `<id>["New"]` for flowchart/erDiagram, `class <id>["New"]` for classDiagram, and a `<id> : New` description line for stateDiagram. When the block body is **empty or whitespace only**, the diagram-type header is scaffolded ahead of the node line (`flowchart TD`, `erDiagram`, `classDiagram`, or `stateDiagram-v2`) so the block becomes a valid diagram — the mermaid analog of the maxGraph empty-block scaffold (change package `2026-07-10-mermaid-empty-canvas`).

Request body: `{ "path": "diagram.md", "line": 10, "index": 0, "diagramType": "flowchart" }`. `diagramType` must be one of `flowchart`, `er`, `class`, or `state`.

Successful response: `{ "path", "line", "index", "diagramType", "nodeId": "New_1", "previousSource": "<block source before>", "source": "<block source after>" }`. The two source snapshots drive block-snapshot undo/redo (see `mermaid-block-restore`).

Errors: same `400`/`403`/`404` model as `POST /api/maxgraph-node` (the `400` also covers an unsupported `diagramType`).

Endpoint: `POST /api/mermaid-edge-add`

Appends a new edge between two existing nodes and re-renders. Per-type synthesis: a bare `<src> --> <tgt>` connector for flowchart/classDiagram/stateDiagram, or a `<src> }o--o{ <tgt> : ""` relationship (default zero-or-many cardinality, empty editable label) for erDiagram, since erDiagram syntactically requires a cardinality and a label token.

Request body: `{ "path": "diagram.md", "line": 10, "index": 0, "diagramType": "flowchart", "sourceId": "A", "targetId": "B" }`. `diagramType` as above; `sourceId`/`targetId` must be non-empty and distinct (a self-loop is rejected).

Successful response: echoes `path`, `line`, `index`, `diagramType`, `sourceId`, `targetId`, plus `previousSource` and `source` snapshots.

Errors: same `400`/`403`/`404` model as `POST /api/maxgraph-node` (the `400` also covers an unsupported `diagramType`, an empty endpoint, a self-loop, or an **empty/whitespace-only block body** — an empty block has no nodes to connect, so the first element must be a node).

Endpoint: `POST /api/mermaid-block-restore`

Replaces a Mermaid block's entire content with a caller-supplied source snapshot. Used to undo/redo a mermaid add **or delete**: the browser captures the block's before/after source from the add/delete response and writes the appropriate one back here on Ctrl+Z (before-source) / Ctrl+Y (after-source). Because mermaid edges have no stable id, this snapshot restore — not a delete-by-id — is how mermaid structural edits are reversed.

Request body: `{ "path": "diagram.md", "line": 10, "index": 0, "source": "<block source>" }`. An **empty (or whitespace-only) `source` is accepted** and restores the block to an empty body, which renders as the empty mermaid canvas — undoing the first add on an empty block depends on it (change package `2026-07-10-mermaid-empty-canvas`; previously a blank `source` was rejected).

Successful response: `{ "path": "diagram.md", "line": 10, "index": 0 }`

Errors: same `400`/`403`/`404` model as `POST /api/maxgraph-node`.

Endpoint: `GET /api/mermaid-block-source`

Returns a Mermaid block's current on-disk body (used by the source-toggle editor's prefill; change package `2026-07-11-mermaid-source-toggle`). Read-only: no write, no cache side effects. `fenced` distinguishes fenced from raw blocks so the editor can apply the empty-body rules client-side.

Query parameters: `path` (relative `.md` path), `line` (block anchor line), `index` (block occurrence index) — the same block identity carried by `data-mermaid-line`/`data-mermaid-index`, covering fenced and raw blocks.

Successful response: `{ "path": "diagram.md", "line": 10, "index": 0, "source": "<block body>", "fenced": true }`

Errors: `400` (path escapes the content root, target is not a `.md` file, line/index is invalid, or the block cannot be located), `404` (target markdown file does not exist). No `403`: the endpoint never writes.

Endpoint: `POST /api/mermaid-block-update`

Persists a source-toggle editor save, replacing the block body with caller-supplied text. Unlike `mermaid-block-restore` (verbatim snapshot writes for undo/redo), this interactive-edit endpoint guards the write: a **raw** block's new first line must still match the raw-declaration recognizer (an emptied raw block is likewise rejected), and a **round-trip boundary guard** re-scans the would-be file and requires the same block (same occurrence index, fenced/raw kind, and anchor) with content bounds exactly covering the replacement — text that would terminate the fence early (a line stripping to ``` ``` ``` / `~~~`), extend a raw block into following content, or otherwise shift block boundaries is a `400` and nothing is written. An empty (or whitespace-only) `source` on a **fenced** block is accepted and yields the empty-canvas body. The response's `previousSource`/`source` snapshot pair feeds the shared undo history (kind `mermaid-source-edit`, replayed through `mermaid-block-restore`).

Request body: `{ "path": "diagram.md", "line": 10, "index": 0, "source": "<new block body>" }`

Successful response: `{ "path": "diagram.md", "line": 10, "index": 0, "previousSource": "<body before>", "source": "<body after>" }`

Errors: same `400`/`403`/`404` model as `POST /api/maxgraph-node` (the `400` also covers the raw-declaration and boundary guards).

Endpoint: `POST /api/mermaid-nodes-delete`

Deletes one or more nodes from a Mermaid block and **cascades** the removal of their incident edges, in one write. A node id removes every content source line that names it as a whole token outside label/quoted regions (its declaration, `style`/`class` lines, and edge lines), and an entity/class/composite-state line that opens a `{ … }` body is removed through its matching `}`. The diagram-type declaration line is never removed. A **class** deletion that leaves nothing but the header appends an indented `direction TB` line, because the bundled mermaid cannot parse a bare `classDiagram` header — the persisted block must stay renderable (change package `2026-07-10-mermaid-empty-canvas`, addendum); the other node-bearing headers are valid alone and stay bare. (Limitations, recoverable via undo: a line naming multiple nodes — an `A --> B --> C` chain or `A & B --> C` — is removed wholesale, and a node existing only as an edge endpoint disappears with that edge.) Used by the Delete button when one or more nodes are selected, and by delete-pick mode for a clicked node (`nodeIds` of length 1; change package `2026-07-11-mermaid-delete-pick-node`).

Request body: `{ "path": "diagram.md", "line": 10, "index": 0, "diagramType": "flowchart", "nodeIds": ["A", "B"] }`. `diagramType` must be one of `flowchart`, `er`, `class`, or `state`; `nodeIds` must be non-empty.

Successful response: `{ …, "nodeIds": ["A", "B"], "previousSource": "<before>", "source": "<after>" }`.

Errors: same `400`/`403`/`404` model as `POST /api/maxgraph-node` (the `400` also covers an unsupported `diagramType` or empty `nodeIds`).

Endpoint: `POST /api/mermaid-edge-delete`

Deletes a single edge, located by the **same per-type identity the edge-title editor uses**: flowchart by `(source, target, occurrence)`, er/class/state by relationship/transition ordinal (`edgeIndex`). Its source line is removed. The complex links the edge-title editor refuses (flowchart `&` / chains / unparseable operators, state self-loops) are likewise non-deletable (`400`). Used by delete-pick mode when an edge is clicked (a clicked node goes through `POST /api/mermaid-nodes-delete` instead).

Request body: `{ "path": "diagram.md", "line": 10, "index": 0, "diagramType": "flowchart", "source": "A", "target": "B", "occurrence": 0, "edgeIndex": 0 }`.

Successful response: `{ "path", "line", "index", "previousSource": "<before>", "source": "<after>" }`.

Errors: same `400`/`403`/`404` model as `POST /api/maxgraph-node` (the `400` also covers an unsupported `diagramType` or an edge that cannot be located).

Endpoint: `POST /api/mermaid-diagnose`

Runs the high-confidence Mermaid repair-rule catalog over client-sent source. The server never parses Mermaid; the browser confirms a repair by re-parsing `fixedSource`.

Request body: `{ "source": "<mermaid source>" }`

Successful response: `{ "fixed": true, "fixedSource": "<repaired source>", "issues": [ { "line": 1, "ruleId": "reserved-word-end-as-node-id", "message": "..." } ] }`

This endpoint validates only the request body shape and otherwise always returns `200`; it does not raise the `400`/`403`/`404` errors.

Endpoint: `POST /api/mermaid-fix`

Applies a Quick Fix by re-deriving the repair from the on-disk source block (it does not trust client-sent text) and writing it back.

Request body: `{ "path": "diagram.md", "line": 10, "index": 0 }`

Successful response: `{ "path": "diagram.md", "line": 10, "index": 0, "fixed": true, "issues": [ ... ] }`

Errors: `400` (path escapes the content root, target is not a `.md` file, line/index is invalid, or the block cannot be located/repaired), `403` (filesystem permissions deny the save), `404` (target markdown file does not exist).

## Path Resolution
- Relative paths are resolved under the configured content root.
- Relative paths with `base` are resolved from the parent folder of `base`.
- Absolute paths are accepted only if they resolve inside the configured content root.
- Any path that resolves outside the configured content root — whether it arrived as a relative path (for example one using `..` segments), an absolute path, or a `base`-relative path — is rejected rather than resolved. The root itself and any descendant of the root are in-bounds; everything else raises a path-escape error that the HTTP endpoints surface as a `400`.
- Response paths use `/` separators regardless of operating system.
- User-visible missing markdown file messages use URL-relative paths and must not expose absolute server filesystem paths.
- Folder paths are accepted for navigation. The renderer opens an immediate `readme.md` file in that folder first, matched case-insensitively; when no readme file exists, it navigates to the first immediate `.md` file in that folder by case-insensitive filename sort order.
- Missing requested `README.md`/`readme.md` files are treated as folder entry into their containing folder, using the same immediate markdown fallback.
- If a folder contains no immediate `.md` file, the renderer does not search subfolders; the render response shows `No .md files found.` and uses the folder path as the current path.

## Invariants & design constraints
_Maintainer rules the behavior above depends on. Migrated from working memory 2026-07-02; see change package `../../changes/2026-07-02-memory-invariants-backfill/`._

- **Runtime config crosses process boundaries via environment variables, not module globals.** `python -m app.main` runs the file as `__main__`, but `uvicorn.run("app.main:app", …)` re-imports the same file as a distinct `app.main` module; the `app`/`renderer` uvicorn serves live in `app.main`, not in the `__main__` instance where `main()` runs. So launch config (`MD_VIEWER_ROOT` content root, `MD_VIEWER_SPAN_DAYS`, the `--open` idle-shutdown seconds) is passed as an **environment variable** read at import / in the lifespan — the only reliable cross-module channel. Setting a module global in `main()` and expecting the served app to see it does not work.
- **From-inside shutdown requires single-process mode.** The `--open` idle watchdog shuts the server down by calling `signal.raise_signal(signal.SIGINT)`; uvicorn polls `should_exit` even when idle, so this exits with no inbound traffic on Windows and POSIX — **but only in single-process mode.** Under `--reload` the parent reloader owns the bound socket and an in-process SIGINT stops only the worker (which the reloader never restarts), leaving the port held. This is why `--open` forces `--reload` off (see the Local Server section).
