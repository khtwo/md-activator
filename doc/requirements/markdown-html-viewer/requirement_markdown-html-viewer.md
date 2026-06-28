# Requirements: MD Activator

## Goal
Provide a lightweight local web viewer for browsing markdown files in a folder as rendered HTML, with targeted write-back for supported interactive markdown elements.

## Ability
The app can serve a browser UI, render `.md` files from a configured local content root, render supported diagram blocks, navigate between local markdown files, expose enough navigation metadata for the UI to show sibling markdown files and maintain browser history, persist supported checkbox and fenced-code edits back to the source markdown file, and provide a VS Code extension wrapper that opens the same viewer beside a markdown editor.

## Scope
In scope:
- Start a local FastAPI server from the project root.
- Serve markdown content from `--cd <folder>` when starting through the app CLI.
- Serve markdown content from the process working directory by default.
- Serve markdown content from `MD_VIEWER_ROOT` when that environment variable is set.
- Render markdown files as HTML in the browser UI.
- Enter the configured content root by default when no path is provided, rendering `README.md` first when it exists and otherwise rendering the first immediate `.md` file in the root folder by case-insensitive filename sort order.
- Resolve relative markdown links using the currently rendered markdown file as the base.
- Reject paths outside the configured content root.
- Reject non-`.md` render targets.
- Convert task markers at the beginning of a line into interactive checkbox controls.
- Convert full `http` and `https` URL references outside fenced code blocks into clickable links, including URLs that end in `.md`.
- Convert local `.md` path references outside fenced code blocks into clickable in-app links without splitting full `http` or `https` URLs that end in `.md`.
- Render fenced maxGraph-compatible diagram blocks whose info string is `maxgraph`, `mxgraph`, `maxgraphcolor`, or `maxgraphcolorall` and whose body is `mxGraphModel` XML or draw.io `mxfile` XML containing an `mxGraphModel`.
- Treat `maxgraph` and `mxgraph` fences as normal maxGraph style mode, supporting only `fontSize` from `mxCell` style attributes and always rendering rectangle vertex cells and orthogonal edge bends as rounded as if `rounded=1`; ignore any source `rounded` value in this mode. Treat `maxgraphcolor` fences as color maxGraph style mode, supporting `strokeColor`, `fontColor`, and `fontSize`, but not `fillColor`, and always rendering rectangle vertex cells and orthogonal edge bends as rounded as if `rounded=1`; ignore any source `rounded` value in this mode. Treat `maxgraphcolorall` fences as color-all maxGraph style mode, supporting color mode behavior plus `fillColor`, `labelBackgroundColor`, and explicit `rounded`. Edge styles `startArrow` and `endArrow` must independently support `none`, `classic`, `classicThin`, `block`, `blockThin`, `open`, `openThin`, `oval`, `diamond`, and `diamondThin`; `none` suppresses that side's marker, missing `startArrow` keeps no source marker, and missing `endArrow` keeps the default classic target marker. Unsupported arrow values fall back to the same side's missing-value default. Info string matching is case-insensitive.
- Use only the repo-local maxGraph-compatible browser renderer for diagram rendering. Runtime rendering must not depend on upstream `@maxgraph/core`, generated npm frontend bundles, CDN assets, internet access, or a separate maxGraph adapter.
- Allow maxGraph-compatible entity boxes to be dragged in the rendered canvas; while no prior in-drag preview render is still in progress and the dragged entity box position differs from the position used for the previous in-drag preview render, re-render the current browser canvas from an in-memory copy of the diagram at the latest dragged location at most once every 0.1 seconds without saving the markdown file. If a drag-preview timer tick fires while the previous preview render is still in progress, the browser must skip starting another render and wait for the next eligible timer tick. When a box is dropped, update that vertex's `mxGeometry x` and `y` attributes in the original markdown file and re-render the diagram from the saved markdown. Allow a rendered maxGraph-compatible entity box title to be edited inline with a multiline textarea sized to the entity box minus 4 points on width and height; when the title editor loses focus, replace that vertex cell's title in the original fenced XML and re-render from the saved markdown. Saved entity-title line breaks must render as distinct lines in the entity box instead of being collapsed into a single wrapped line, and automatic wrapping must use the available entity-box title width instead of a fixed short character count. Allow a rendered maxGraph-compatible edge title to be edited by double-clicking its label; the editor must be a 3-line textarea, Enter must insert new lines, blur must save changed text to the matching edge cell's `value` attribute in the original fenced XML and re-render from the saved markdown, unchanged edits must close without a save request, and saved edge-title line breaks must render as separate SVG text lines. Keep the latest 50 successful maxGraph entity-box location moves, entity-title changes, and edge-title changes for the current browser session so Ctrl+Z can undo prior saved maxGraph edits and Ctrl+Y can redo undone saved maxGraph edits.
- For maxGraph-compatible diagrams, ignore imported fixed link position metadata, including edge geometry points and `exitX`/`exitY` or `entryX`/`entryY` style coordinates; choose rendered link attachment points and orthogonal paths from the local routing rules, including same-side port spacing, same-side port order optimization across both incoming and outgoing links, routing multi-edge source fanout bundles before shorter feedback or loopback links when practical, and at least 1.5 arrow widths of clearance between shifted parallel connector segments when the route can provide that separation. Edge-label placement must prefer a clear horizontal segment that can hold the title width, and must otherwise keep practical visual clearance from nearby entity boxes and other rendered arrows or connector segments. The rendered SVG canvas and viewBox must include routed connector segments and final edge-label text block bounds so links and link titles are not cut off.
- Keep the browser URL synchronized with the current markdown file through direct relative URL paths, while continuing to accept legacy `?path=<relative_md_path>` URLs.
- When the browser URL selects a markdown file path that does not exist, replace the browser URL with `/`, render the default/available file from the configured content root, and keep a visible error message that names the missing file path without auto-hiding it.
- Keep browser UI error banners visible after any render, navigation, dropdown refresh, checkbox/code-block write-back, or maxGraph write-back failure; later loading attempts and successful operations must not auto-clear the banner, while a later error may replace the visible message.
- Let browser back and forward controls navigate between previously viewed markdown files.
- Show a left-aligned toolbar dropdown of `.md` files and markdown-bearing folders in the current file's folder.
- Refresh the file/folder dropdown structure only when the user opens the dropdown, not during timed auto refresh.
- Provide a VS Code desktop extension module under `vscode-extension/`.
- Contribute a VS Code editor-title preview command for markdown resources.
- Launch or reuse the local MD Activator server from the VS Code extension.
- Open the current markdown file in a side-by-side VS Code webview preview.
- Package the VS Code extension as a local installable VSIX for first local validation.
- Persist supported checkbox, button-option, and single-choice option changes to the source markdown file.
- Persist supported non-diagram fenced code block edits to the source markdown file.

Out of scope:
- General-purpose markdown editing beyond supported checkbox, button-option, single-choice option, non-diagram fenced code block, and maxGraph entity title/location write-back.
- File creation, rename, move, or deletion.
- Authentication, authorization, or multi-user access control.
- Serving arbitrary non-markdown content as render targets.
- Recursive file tree navigation.
- Search, indexing, tags, or document metadata management.
- Persistent user preferences.
- Hosted deployment or internet-facing operation.
- VS Code Web, browser-only Codespaces, native VS Code markdown renderer replacement, or Marketplace publishing for the first local VSIX milestone.

## Non-goals
- The app is not a full markdown CMS or note-taking system.
- The app is not responsible for sanitizing untrusted internet content for public hosting.
- The app is not required to support every markdown extension or custom syntax.
- The app is not required to run without JavaScript in the browser.

## Actors
- Local reader: opens a folder of markdown files and browses rendered documents.
- Local operator: starts the server and chooses the content root through `--cd`, the working directory, or `MD_VIEWER_ROOT`.
- Developer: modifies or validates the app through Python tests and local smoke checks.
- VS Code user: opens a markdown file in VS Code and launches MD Activator preview from the editor title.

## Functional Requirements
1. The server must expose `GET /` and return the single-page viewer shell.
2. The server must expose `GET /api/render` with optional `path`, `base`, `includeFileOptions`, and `ifRenderVersion` query parameters.
3. When `path` is omitted or blank, `/api/render` must render the configured content root as a folder, using the same readme-first and first-immediate-markdown fallback as folder navigation.
4. When `path` is relative and `base` is provided, the server must resolve `path` relative to the parent folder of `base`.
5. The server must return HTTP 400 when the requested path escapes the configured content root or does not target a `.md` file.
6. The server must return HTTP 404 when the requested `.md` file does not exist.
7. Successful render responses must include:
   - `path`: normalized relative markdown path using `/` separators.
   - `renderVersion`: an opaque token that changes when the rendered markdown file path or file version changes.
   - `html`: rendered markdown HTML.
   - `links`: unique markdown links discovered in the rendered source.
   - `fileOptions`: structured dropdown options for current-folder `.md` files and markdown-bearing folders.
8. The renderer must convert leading `[]`, `[ ]`, `[x]`, and `[X]` markers into interactive checkbox inputs.
9. When a standalone `single` or `single:` line immediately precedes one or more contiguous standalone checkbox option lines outside fenced code blocks, the renderer must consume the `single` marker and render the following option markers as a single-choice group, including inline checkbox option sequences on those lines.
10. Selecting an option in a single-choice group must write `[x]` to the selected marker and write `[ ]` to all other checkbox markers in the same group without changing the `/api/checkbox` request or response shape.
11. Checkbox write-back must use `[ ]` for unchecked markers across ordinary checkboxes, button options, and single-choice options. Checkbox rendering must continue to read both `[]` and `[ ]` as unchecked markers.
12. The renderer must convert inline-code and bare local `.md` path references into markdown links unless they are inside fenced code blocks or embedded in a full `http`/`https` URL.
13. The renderer must convert bare full `http` and `https` URL references into clickable links unless they are inside fenced code blocks or already inside markdown link syntax.
14. The browser UI must load the initial markdown file or folder from the direct URL path when present, fall back to `?path=` for legacy URLs, and otherwise enter the configured content root folder.
15. When the initial direct URL path, legacy `?path=`, or browser `popstate` path points to a missing markdown file, the browser UI must replace the URL with `/`, render the default/available file from the configured content root, and keep an error banner message that names the missing file path visible without auto-hiding it.
16. Browser UI error banners from render/navigation, file-option refresh, checkbox or button-option write-back, non-diagram code-block write-back, and maxGraph write-back failures must remain visible without auto-hiding. Later loading attempts and successful operations must not clear the current banner; a later error may replace the banner message.
17. The browser UI must intercept clicked local links whose `href` ends with `.md` and render them in-app.
18. The browser UI must not intercept clicked `http` or `https` links whose `href` ends with `.md`, including same-origin absolute URLs; the original absolute URL is the final navigation target and must not be prefixed as an app-relative path.
19. The browser UI must update the URL after in-app markdown navigation.
20. The browser UI must handle `popstate` so browser back and forward load the file named by the current URL.
21. The browser UI must display a left-aligned toolbar dropdown populated from the render response's navigation file/folder list.
22. Selecting a different dropdown item must render that markdown file in-app.
23. When a folder path is rendered, the server must render an immediate `readme.md` file in that folder first, matched case-insensitively; when no readme file exists, it must navigate to and render the first immediate `.md` file in that folder by case-insensitive filename sort order; when no immediate markdown file exists in the folder, it must return an empty render response for the folder without searching subfolders.
24. When a requested `README.md`/`readme.md` file is missing, the server must treat that request as entering the containing folder and apply the same readme-first and first-immediate-markdown fallback.
25. The launchers must prepare the local runtime, pass the chosen content root through `--cd`, and run the app CLI.
26. The VS Code extension must expose a `mdActivator.openPreviewToSide` command that appears as an editor-title icon only when the active resource language is markdown.
27. When the VS Code preview command is invoked for a file inside a workspace, the extension must use that workspace folder as the server content root and the markdown file's workspace-relative path as the preview path.
28. When the VS Code preview command is invoked for a standalone markdown file outside a workspace, the extension must use the file's parent folder as the content root and the file name as the preview path.
29. The VS Code extension must start the MD Activator server bound to `127.0.0.1`, selecting the first free TCP port at or above the configured `mdActivator.portStart` value, which defaults to `49152`.
30. The VS Code extension must open a webview in `ViewColumn.Beside` with an iframe that points to the running MD Activator server and the selected markdown path.
31. The VS Code extension must reuse a compatible running server for subsequent previews with the same content root and must stop the server on explicit stop command or extension deactivation.
32. The VS Code extension package must include command contributions, configuration contributions, README, changelog, icon, and a staged runtime payload sufficient to launch the existing Python app as a local installable VSIX.
33. Before starting the VS Code preview server, the extension must verify that the configured `uv` command can run and that `uv run python --version` can resolve a Python runtime from the staged server environment.
34. If a required local runtime component is missing or unusable, the VS Code extension must report a setup-focused error through VS Code and write command details to the `MD Activator` output channel.
35. When `includeFileOptions=false` is supplied to `/api/render`, the server must render markdown content without rebuilding or returning folder navigation metadata.
36. Timed browser auto refresh must call `/api/render` without refreshing dropdown file/folder metadata and must preserve the existing dropdown options.
37. Opening the file/folder dropdown must request dropdown file/folder metadata for the current path. The server may satisfy that request from a folder metadata cache entry that is still fresh under the 5-second cache rule; dropdown-open refresh is not a forced disk rescan.
38. When timed browser auto refresh supplies an `ifRenderVersion` value that matches the resolved markdown file's current `renderVersion`, `/api/render` must return `{"status": "no-change"}` without the full render result.
39. When timed browser auto refresh receives `{"status": "no-change"}`, the browser UI must not replace rendered HTML, rerun render post-processing, change URL history, or refresh dropdown metadata.
40. Fenced code blocks whose info string is `maxgraph`, `mxgraph`, `maxgraphcolor`, or `maxgraphcolorall` must be rendered as maxGraph-compatible diagrams when their body is `mxGraphModel` XML or draw.io `mxfile` XML containing an `mxGraphModel`; these diagram fences must not be exposed as editable code blocks, and diagram editing is limited to dragging entity boxes to update vertex location metadata, editing entity box titles to update vertex title metadata, and editing edge titles to update edge label metadata in the original fenced XML while preserving any `mxfile` wrapper. Info string matching is case-insensitive. `maxgraph` and `mxgraph` fences use normal style mode, where `fontSize` applies to node and edge labels. Normal mode must ignore any source `rounded` value and always render rectangle vertex cells and orthogonal edge bends as rounded as if `rounded=1`. `maxgraphcolor` fences use color style mode, where `strokeColor`, `fontColor`, and `fontSize` apply, but `fillColor` is ignored. In color mode, `strokeColor` applies to node shape stroke plus edge stroke and arrow color, `fontColor` applies to node and edge labels, and `fontSize` applies to node and edge labels. Color mode must ignore any source `rounded` value and always render rectangle vertex cells and orthogonal edge bends as rounded as if `rounded=1`. `maxgraphcolorall` fences use color-all style mode, where color mode behavior applies and `fillColor`, `labelBackgroundColor`, and explicit `rounded` are also supported; `fillColor` applies to node shape fill, `labelBackgroundColor` applies to node and edge label background boxes, and `rounded` applies to rectangle vertex cells and orthogonal edge bends. Straight edges are not visually changed by `rounded`. Edge styles `startArrow` and `endArrow` must independently control source and target markers on straight and orthogonal edges. Supported arrow values are `none`, `classic`, `classicThin`, `block`, `blockThin`, `open`, `openThin`, `oval`, `diamond`, and `diamondThin`; `none` suppresses that side's marker, `open` and `openThin` render unfilled stroked markers, `oval` renders a circle/oval marker, and the `Thin` variants render narrower versions of their base shape. Missing `startArrow` and unsupported `startArrow` values keep no source marker; missing `endArrow` and unsupported `endArrow` values keep the default classic target marker. Invalid `fontSize` values and unsupported or mode-gated style values must be ignored so CSS defaults remain in effect. While an entity box is being dragged, the browser must check the latest dragged position every 0.1 seconds and re-render the current canvas from an in-memory copy of the diagram when that position differs from the position used for the previous in-drag preview render, so connected routes and labels refresh without calling the markdown save API. When a rendered entity box title is edited inline, the editor must be a multiline textarea positioned inside the cell box with width and height equal to the cell box size minus 4 points, and Enter must insert a newline in the editor. When the editor loses focus, the browser must save the changed title back to the matching vertex cell in the original fenced XML block, then re-render from the saved markdown; unchanged title edits must close locally without a save request. Browser rendering must use the local SVG renderer in `app/static/max-graph.js` and `app/static/max-graph.css`; upstream `@maxgraph/core` adapter code, generated adapter bundles, CDN assets, internet downloads, and runtime adapter switches are not part of the supported rendering path. Edges whose style includes `edgeStyle=orthogonalEdgeStyle` must render as right-angled connector paths instead of straight connector lines. Imported fixed link position metadata, including edge geometry points and `exitX`/`exitY` or `entryX`/`entryY` style coordinates, must not lock rendered attachment sides or points. Orthogonal edges must approach the selected source and target sides perpendicularly. When multiple incoming or outgoing edges attach to the same entity side, their connection points must not overlap; this spacing rule is shared by all ports on that side regardless of whether each link is incoming or outgoing. If the usable side span can fit the points within the anchor margins, adjacent connection points must be separated by at least two arrow widths, placed with even clearance, and centered as one group around the side middle unless doing so would violate higher-priority node avoidance, link conflict, endpoint-clearance, or route-scoring rules. Routing may switch the relative positions of same-side connection points, regardless of whether each point is incoming or outgoing, when a different same-side order produces a better route under the normal route scoring rules without violating spacing. Orthogonal edge routing must shift internal horizontal or vertical lanes so rendered orthogonal connector segments do not overlap other collinear orthogonal connector segments, and the visual clearance between shifted parallel connector segments must be at least 1.5 times the rendered arrow width when a route can provide that separation. Orthogonal edge routing must not run links across non-endpoint entity nodes when an alternate orthogonal route is available. When the source and target nodes overlap vertically or horizontally and a single straight segment can connect compatible facing sides without breaking node avoidance, link conflict, or endpoint-clearance rules, the router must choose that straight segment instead of adding bends. Orthogonal connector segments must not partially or fully overlap already-routed collinear connector segments when a non-overlapping route is available; if every valid route conflicts, the router must choose the route with the fewest line overlaps before considering bends, crossings, or length. When multiple route candidates are available, routing must prefer candidates that avoid overlapping already-routed links; after node avoidance, link-overlap avoidance, endpoint clearance, and line-crossing avoidance, routing must prefer the candidate with the fewest right-angle turns. Among candidates with equal crossing counts, routing must prefer fewer bends, then the source side facing the target row or column, then centered attachment points, then even same-side attachment clearance, and then the shorter path. Orthogonal edge routes must keep enough straight run into the source and target arrow endpoints so adjacent perpendicular segments do not visually connect to the side of the arrowhead. Routing must evaluate alternate source and target attachment sides (left, right, top, bottom) and shifted attachment points along those sides when that can reduce bends without worsening node/link avoidance; when all higher-priority routing rules are equal, attachment points should stay closest to the middle of their selected side. Same-side spacing may move the rendered point along that selected side to prevent connection-point overlap, keep a same-side group evenly spaced and centered when practical, and keep a preferred side usable instead of escaping to a worse side solely because another same-side port already occupies the centered point. Rendered entity-box title lines must wrap from the available title width in the entity box rather than a fixed short character count. Edge-label segment selection must prefer a horizontal segment when the one-line title width fits and the best placement has practical clearance from cells, connectors, and existing text, choose the best-clearance and then longer segment when multiple horizontal segments qualify, and fall back to the longest rendered route segment when no horizontal segment can hold the title with practical clearance.
41. During maxGraph entity-box drag preview, a 0.1-second timer tick must first check whether the prior in-drag preview render is still in progress. If it is, the tick must not start another preview render; otherwise, the browser must render only when the latest dragged position differs from the position used for the previous completed preview render.
42. The browser UI must let users zoom rendered Mermaid and maxGraph diagram canvases in and out with the mouse wheel while the Ctrl or Cmd (`metaKey`) modifier is held. A plain wheel without the modifier must keep scrolling the page. Wheel zoom must zoom toward the cursor so the diagram content point under the pointer stays under the pointer, and the scale must be clamped between a minimum and maximum factor.
43. The browser UI must let users pan rendered Mermaid and maxGraph diagram canvases by dragging on an empty area of the canvas. On a maxGraph canvas, a drag starting on an entity box, an entity or edge title editor, or an edge label must keep its existing node-move or inline-edit behavior and must not start a pan.
44. Double-clicking an empty area of a rendered Mermaid or maxGraph diagram canvas must reset that diagram to the default view (scale 1, no pan offset).
45. Diagram zoom and pan must be view-only and must never be written back to the markdown file or any backend store. Each diagram's zoom and pan must persist within the browser session (keyed by diagram order) so timed auto refresh and in-app markdown re-render preserve the current view; a full browser page reload must reset every diagram to the default view.

## Non-Functional Requirements
- Security: file rendering must stay inside the configured content root.
- Privacy: markdown content is local to the configured folder; the app has no user accounts or telemetry.
- Compatibility: the primary supported local launch path is Python with FastAPI/Uvicorn and a modern JavaScript-enabled browser.
- VS Code compatibility: the extension targets VS Code desktop 1.66.0 or newer and requires local Python plus `uv` to be available through the configured `mdActivator.uvPath`.
- Maintainability: markdown resolution and rendering behavior belongs in `app/markdown_service.py`; HTTP routing belongs in `app/main.py`; browser interaction belongs in `app/static/app.js`.
- Dependency resilience: local static assets under `to-html/` must serve Vue, Quasar, Quasar Material Icons, Prism, and Mermaid assets. maxGraph-compatible XML rendering must run from local app JavaScript and must not require internet/CDN access. Quasar is the only UI component framework.
- Accessibility: generated task checkboxes are disabled controls, and toolbar dropdown controls keep accessible names even when visible labels are omitted.
- Validation: behavior must be covered by focused renderer and API tests where practical.

## Priority
Must:
- Render local `.md` files.
- Enforce content-root path safety.
- Support relative markdown navigation.
- Keep URL/history synchronized with current markdown file.
- Provide same-folder dropdown navigation.

Should:
- Render common markdown constructs including fenced code blocks and tables.
- Render supported diagram blocks, including Mermaid and maxGraph-compatible `mxGraphModel` or draw.io `mxfile` XML fences.
- Keep rendered tables within the markdown body content width; long table content must wrap instead of making the table wider than the body padding allows.
- Show clear errors when rendering fails.
- Keep run instructions simple for local use.
- Provide a Marketplace-ready VS Code extension package for desktop users.

Could:
- Add browser-level automated tests for URL/history and dropdown behavior.
- Add recursive folder navigation.

## Assumptions
- The app is intended for trusted local markdown folders.
- The configured content root is writable only for supported markdown write-back operations.
- Markdown files are UTF-8 encoded.
- Browser URLs use direct relative paths for current navigation and accept `?path=<relative_md_path>` as a legacy fallback.
- The local VSIX manifest uses publisher ID `khtwo` for packaging identity.
- Marketplace publishing is deferred until after local VSIX behavior is validated.

## Open Questions
- Should `.markdown` or other markdown-like extensions be supported?
- Should the file dropdown eventually recurse into subfolders?
- Should rendered HTML be sanitized if the app is ever exposed beyond localhost?

## Acceptance Criteria
1. Given the server is running with a content root containing `README.md`, when a user opens `/`, then the viewer shell is returned.
   Validation: API test with `TestClient`.
2. Given `README.md` exists in the content root, when `/api/render` is requested without `path`, then the response renders `README.md`.
   Validation: API test with `TestClient`.
3. Given the content root has no `README.md` but contains another immediate `.md` file, when `/api/render` is requested without `path`, then the response renders the first immediate markdown file by case-insensitive filename sort order and reports that markdown file as `path`.
   Validation: API test with `TestClient`.
4. Given the content root has no `README.md` but contains another immediate `.md` file, when `/api/render?path=README.md` is requested, then the response renders the first immediate markdown file by case-insensitive filename sort order and reports that markdown file as `path`.
   Validation: API test with `TestClient`.
5. Given a markdown file contains leading `[ ]` and `[x]` task markers, when it is rendered, then user-toggleable checkbox inputs appear in the HTML.
   Validation: renderer unit test.
6. Given a standalone `single` marker immediately precedes contiguous checkbox option lines, when the markdown is rendered, then the marker is hidden and the option lines render as one single-choice group.
   Validation: renderer unit test.
7. Given a single-choice group has multiple option markers, when one option is selected, then the selected marker is checked and all sibling option markers in that group are unchecked.
   Validation: renderer and API tests.
8. Given `docs/a.md` links to `b.md`, when the user opens `b.md` with `base=docs/a.md`, then the server resolves `docs/b.md`.
   Validation: renderer unit test.
9. Given a request path escapes the content root, when render is attempted, then rendering is rejected.
   Validation: renderer unit test and/or API test.
10. Given a markdown file has sibling `.md` files, when it is rendered, then `fileOptions` lists current-folder `.md` files and markdown-bearing folders as structured options.
   Validation: renderer and API tests.
11. Given the UI is at `/README.md`, when a markdown link to `AGENTS.md` is clicked, then the app renders `AGENTS.md` and updates the URL to a direct markdown path.
   Validation: browser smoke test or Playwright test when browser tooling is available.
12. Given the user navigated from `README.md` to `AGENTS.md`, when the browser Back button is used, then the app renders `README.md`.
   Validation: browser smoke test or Playwright test when browser tooling is available.
13. Given the current file has sibling markdown files, when the page renders, then the left-aligned toolbar dropdown lists those files.
   Validation: browser smoke test or Playwright test when browser tooling is available.
14. Given a folder contains both `readme.md` and another markdown file that sorts earlier by name, when the folder path is rendered, then the readme file is rendered.
   Validation: renderer/API test.
15. Given a folder has no immediate readme file and no immediate markdown file, when the folder path is rendered, then the response path remains the folder path and the render body shows `No .md files found.` even if nested subfolders contain markdown files.
   Validation: renderer/API test.
16. Given the browser is opened directly to `/missing.md`, `/?path=missing.md`, or a stale history entry for `missing.md`, when `/api/render` reports that the markdown file is missing, then the browser replaces the URL with `/`, renders the default/available content-root file, and shows an error banner naming `missing.md` as a file path that does not exist without auto-hiding it.
   Validation: static browser asset test and browser smoke test when practical.
17. Given the app CLI is started with `--cd <folder>`, when the server starts, then that folder is the configured content root.
   Validation: CLI/API test with server startup monkeypatched.
18. Given a markdown file contains a full `http` or `https` URL ending in `.md`, when it is rendered, then the full URL text is displayed as one clickable link and is not partially converted into a local markdown link.
   Validation: renderer unit test.
19. Given the user clicks a full `http` or `https` URL ending in `.md`, when the click reaches the browser UI, then the app leaves normal browser link navigation in control instead of rendering it in-app or prefixing it with the current app origin.
   Validation: static asset test or browser smoke test.
20. Given a markdown file is open in VS Code desktop, when the user views the editor title, then an MD Activator preview icon is available for that markdown resource.
   Validation: extension manifest/static test and manual VS Code smoke test.
21. Given the user clicks the VS Code preview icon for a workspace markdown file, when the extension starts the preview, then the original markdown editor remains open and an MD Activator webview opens beside it.
   Validation: extension unit/static test and manual VS Code smoke test.
22. Given port `49152` is unavailable, when the extension starts the server, then it selects a later free localhost port instead of failing on the first conflict.
   Validation: extension unit test for port selection.
23. Given `uv` cannot be executed, when the preview command runs, then the extension reports the startup failure through VS Code and writes detail to its output channel.
   Validation: extension unit test or manual smoke test with invalid `mdActivator.uvPath`.
24. Given Python cannot be resolved through `uv run python --version`, when the preview command runs, then the extension reports the missing Python/runtime setup failure through VS Code and writes command output to its output channel.
   Validation: extension unit test or manual smoke test with a Python-unavailable `uv` environment.
25. Given the extension package is built, when the VSIX is inspected, then publisher, display name, description, categories, keywords, README, changelog, icon, and staged server runtime are present.
   Validation: npm package/check script and `vsce package`.
26. Given timed auto refresh runs while a markdown file is open, when `/api/render` is requested, then the request skips file option metadata, preserves current dropdown options, and refreshes only rendered content.
   Validation: renderer/API regression tests and static browser asset test.
27. Given the user opens the file/folder dropdown, when the popup is shown, then the browser requests file option metadata for the current path and updates the dropdown options. The server rebuilds folder metadata only when no cache entry exists or the existing entry is older than the 5-second folder metadata cache window.
   Validation: static browser asset test and manual browser smoke test when practical.
28. Given timed auto refresh runs while the current markdown file has not changed, when `/api/render` receives a matching `ifRenderVersion`, then the response is `{"status": "no-change"}` and the browser skips re-rendering the markdown body.
   Validation: API regression test and static browser asset test.
29. Given a rendered markdown table contains long cell content, when the page is displayed, then the table stays within the markdown body content width and wraps long cell text instead of extending beyond the body padding.
   Validation: static browser asset test.
30. Given a markdown file contains a fenced `maxgraph`, `mxgraph`, `maxgraphcolor`, or `maxgraphcolorall` block with `mxGraphModel` XML or draw.io `mxfile` XML containing an `mxGraphModel`, when it is rendered, then the output contains a read-only diagram container and the source XML is not shown as an editable code block. Given a normal-mode or color-mode maxGraph block has any source `rounded` value, then rectangle cells and orthogonal edge bends render rounded as if `rounded=1`. Given a color-mode `maxgraphcolor` block has style attributes, then `strokeColor`, `fontColor`, and `fontSize` affect the rendered diagram while `fillColor` is ignored. Given a color-all-mode `maxgraphcolorall` block has style attributes, then color-mode attributes plus `fillColor`, `labelBackgroundColor`, and explicit `rounded` affect the rendered diagram.
   Validation: renderer unit test and static browser asset test.
31. Given a maxGraph XML edge style includes `edgeStyle=orthogonalEdgeStyle`, when the browser renders the diagram, then that edge is drawn with a right-angled SVG connector path while edges without that style remain straight. Given a straight or orthogonal maxGraph XML edge style includes `startArrow` or `endArrow`, when the browser renders the diagram, then source and target markers are controlled independently with supported values `none`, `classic`, `classicThin`, `block`, `blockThin`, `open`, `openThin`, `oval`, `diamond`, and `diamondThin`; `none` omits that side's marker, missing or unsupported `startArrow` keeps no source marker, and missing or unsupported `endArrow` keeps the default classic target marker.
   Validation: static browser asset test and browser smoke test when practical.
32. Given multiple maxGraph XML edges would connect to the same side of one entity, whether incoming, outgoing, or mixed, when the browser renders the diagram and the side has enough usable span, then those edges use distinct shifted attachment points along that side with adjacent points separated by at least two arrow widths, even clearance between adjacent points, and the connection-point group centered on the side middle when no higher-priority routing rule prevents it.
   Validation: static browser asset test and browser smoke test when practical.
33. Given a maxGraph XML edge style includes `entryX`/`entryY` or `exitX`/`exitY` port metadata, when the browser renders the diagram, then that imported position metadata is ignored and the edge attachment point is selected by local route optimization.
   Validation: static browser asset test and browser smoke test when practical.
34. Given multiple maxGraph XML orthogonal edges would route through the same horizontal or vertical lane, when the browser renders the diagram, then internal route lanes are shifted so no horizontal or vertical orthogonal connector segment overlaps another collinear segment, and shifted parallel segments keep at least 1.5 arrow widths of clearance when a route can provide that separation.
   Validation: static browser asset test and browser smoke test when practical.
35. Given a maxGraph XML orthogonal edge has a direct or low-bend route that would cross a non-endpoint entity node and another route that avoids that node, when the browser renders the diagram, then the chosen connector route avoids the non-endpoint node.
   Validation: static browser route test and browser smoke test when practical.
36. Given a maxGraph XML orthogonal edge has candidate routes with and without avoidable overlaps or crossings against already-routed links, when the browser renders the diagram, then the chosen route avoids those link conflicts when practical before comparing right-angle bend counts.
   Validation: static browser route test and browser smoke test when practical.
37. Given a maxGraph XML orthogonal edge can connect its selected attachment sides with one straight horizontal or vertical segment, when the browser renders the diagram, then the chosen route uses that direct segment instead of adding right-angle turns.
   Validation: static browser route test and browser smoke test when practical.
38. Given a maxGraph XML orthogonal edge has an alternate source/target side pair that can reduce right-angle turns without worsening node or link avoidance, when the browser renders the diagram, then the chosen route uses the lower-bend side pair.
   Validation: static browser route test and browser smoke test when practical.
39. Given a maxGraph XML orthogonal edge can use shifted attachment points along compatible sides to create a straight horizontal or vertical connector, when the browser renders the diagram, then the chosen route shifts those attachment points and uses the straight segment.
   Validation: static browser route test and browser smoke test when practical.
40. Given a maxGraph XML orthogonal edge enters an arrow endpoint after a perpendicular bend, when the browser renders the diagram, then the segment entering the arrow endpoint is long enough that the previous segment does not visually connect to the arrowhead side.
   Validation: static browser route test and browser smoke test when practical.
41. Given two connected maxGraph XML nodes overlap along the horizontal or vertical axis that allows a compatible straight orthogonal connector, when that direct route does not violate node, link, or endpoint-clearance rules, then the chosen route uses one straight segment without right-angle bends.
   Validation: static browser route test and browser smoke test when practical.
42. Given a maxGraph XML orthogonal edge has candidate routes with and without partial or full overlap against already-routed collinear link segments, when the browser renders the diagram, then the chosen route avoids the overlapping segment when a non-overlapping route exists.
   Validation: static browser route test and browser smoke test when practical.
43. Given multiple maxGraph XML orthogonal routes are otherwise equal after node avoidance, link conflict avoidance, endpoint clearance, and bend count, when the browser renders the diagram, then the chosen inferred attachment points remain closest to the middle of their selected node sides.
   Validation: static browser route test and browser smoke test when practical.
44. Given multiple maxGraph XML orthogonal edges attach to the same side of one entity, whether incoming, outgoing, or mixed, when switching their relative same-side connection-point order reduces route conflicts under the normal route scoring rules without violating spacing, then the browser chooses the better same-side order instead of preserving the original import order or centered-port order.
   Validation: static browser route test and browser smoke test when practical.
45. Given a maxGraph XML edge has a label value, when the browser renders the diagram, then the label is displayed as horizontal text on a rendered route segment, preferably on one line and at most three lines when wrapping fits better. If a horizontal route segment can hold the one-line title width and the best label placement on that segment has practical clearance from cells, connectors, and existing text, then the renderer must attach the label to that horizontal segment even when another route segment is longer. If multiple horizontal segments qualify, the renderer must choose the one with the best placement clearance and then the longer segment. If no horizontal segment can hold the title with practical clearance, the renderer must fall back to the longest rendered route segment. When an edge label must wrap, the renderer should choose word-break positions that keep the visible line widths similar and avoid leaving a very short final line when another valid wrapped layout fits the same label width cap. Labels on horizontal segments are placed above or below the segment without overlapping it; when the centered placement overlaps cells, other connectors, or text, the renderer must try shifted positions to the left and right along that segment and choose the placement with the least overlap. Labels on vertical segments are placed to the left or right when space is available, with horizontal label padding and margin set to 0 so the visible title text's inner edge sticks close to the vertical segment and leaves only 4 points of clearance; when the initial vertical placement is close to horizontal connector segments, entity boxes, other arrows or connector segments, cells, other connectors, or text, the renderer must try left/right side placements and shifted positions up and down along the segment and choose the placement that keeps practical clearance from nearby diagram elements while still staying farthest from nearby horizontal segments and minimizing overlap. A vertical-segment label may cross the vertical segment only when side placement would overlap other diagram elements. Label placement should avoid overlapping cells, other connector segments, and existing diagram text unless no practical placement is available. The rendered SVG canvas and viewBox dimensions must include routed connector segments and final edge-label text block bounds, including routes and labels placed outside the node bounds, so links and link titles are not cut off.
46. Given a rendered maxGraph XML edge title is double-clicked, when the browser opens the inline editor, then the editor is a textarea sized to show 3 lines and Enter inserts a newline. Given the editor loses focus with changed text, then the browser updates the matching edge cell's `value` attribute in the original fenced XML block, invalidates the render cache for that markdown file, and re-renders the diagram from the saved markdown. Given the saved edge title contains line breaks, then the rendered edge label displays those breaks as separate SVG text lines instead of collapsing them into spaces. Given the edge title is unchanged, then the editor closes without sending a save request.
47. Given a rendered maxGraph XML entity box is dragged to a new canvas location, when the latest dragged position differs from the position used for the previous in-drag preview render and 0.1 seconds have elapsed since the last preview check, then the browser re-renders the current canvas from the latest dragged location without sending a save request. Given the dragged position has not changed since the previous in-drag preview render, when the next 0.1-second preview check elapses, then the browser does not re-render the canvas or send a save request. Given the same entity box is then dropped, when the browser sends the update, then the original markdown file's matching fenced `maxgraph`, `mxgraph`, `maxgraphcolor`, or `maxgraphcolorall` block is updated by changing that vertex cell's `mxGeometry x` and `y` attributes, the render cache for that file is invalidated, and the browser re-renders the diagram from the saved markdown.
48. Given maxGraph XML entity-box moves, entity-title changes, or edge-title changes have been saved successfully in the current browser session, when the user presses Ctrl+Z outside a text-editing control, then the browser writes the previous location or title for the most recent saved maxGraph edit back to the markdown file and re-renders the diagram. Given one or more saved maxGraph edits have been undone, when the user presses Ctrl+Y outside a text-editing control, then the browser reapplies the next undone location or title and re-renders the diagram. A new successful maxGraph edit clears redo history, and only the latest 50 successful maxGraph edit records are retained.
   Validation: static browser drag/save/route/label test and browser smoke test when practical.
49. Given a rendered maxGraph XML entity box has a title, when the user double-clicks the entity box title or box, then the inline title editor is a multiline textarea positioned inside the cell box with width and height equal to the cell box size minus 4 points. Given the user presses Enter inside the editor, then the editor inserts a newline instead of saving or closing. Given the user edits the inline title editor and the editor loses focus, then the browser writes the changed title to the matching vertex cell's `value` attribute in the original fenced XML block, invalidates the render cache, and re-renders the diagram from the saved markdown. Given the saved title contains line breaks, then those breaks render as separate SVG text lines in the entity box. Given the entity box is wide enough for a title line, then automatic title wrapping keeps that text on one SVG text line instead of wrapping at a fixed short character count. Given the title text is unchanged when focus leaves the editor, then the editor closes without sending a save request or refreshing the markdown render.
   Validation: renderer/API unit test and static browser asset test.
50. Given a rendered Mermaid or maxGraph diagram, when the user holds Ctrl or Cmd and scrolls the mouse wheel over it, then the diagram zooms toward the cursor within the clamped scale bounds; when the user scrolls the wheel without the modifier, then the page scrolls and the diagram does not zoom.
51. Given a rendered Mermaid or maxGraph diagram, when the user drags on an empty area of the canvas, then the diagram pans; on a maxGraph canvas, when the user drags an entity box or double-clicks a title, then the existing node-move and inline-edit behavior runs instead of a pan.
52. Given a zoomed or panned Mermaid or maxGraph diagram, when the user double-clicks an empty area of that canvas, then the diagram returns to the default view.
53. Given a zoomed or panned diagram, when a timed auto refresh or in-app markdown re-render occurs, then the diagram keeps its zoom and pan and the markdown file is not modified; when the browser page is fully reloaded, then the diagram resets to the default view.
   Validation: static browser asset and probe tests for the shared zoom/pan controller and maxGraph/Mermaid wiring; manual browser smoke test.

## Validation Method
- Unit/API: `.\.venv\Scripts\python.exe -m pytest --basetemp=.pytest_tmp -q`
- Syntax: `.\.venv\Scripts\python.exe -m compileall app tests`
- Manual/browser: run the local app server and inspect `/README.md`, markdown link navigation, dropdown options, and browser back/forward.
- VS Code extension: run npm checks in `vscode-extension/`, package a local VSIX with `vsce package`, install it in VS Code desktop, and smoke test the editor-title preview.
