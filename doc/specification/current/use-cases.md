# Use Cases: MD Activator

## System Boundary
The system begins when a local operator starts the local app server and ends at the browser UI and render/write APIs. The system reads markdown files from the configured content root and writes content files only for supported checkbox, button-option, single-choice option, and non-diagram fenced code block updates.

## Actors and Goals
- Local operator: start the viewer against a desired folder through `--cd`, `MD_VIEWER_ROOT`, or the process working directory.
- Local reader: read rendered markdown and navigate between files.
- VS Code user: open a markdown file in VS Code and preview it beside the editor through MD Activator.
- Developer: validate behavior through tests and local smoke checks.

## Preconditions
- Python dependencies are installed or can be installed by the launcher.
- VS Code extension preview requires VS Code desktop 1.66.0 or newer, Node extension host support, Python, and `uv`.
- The server process can read the configured content root.
- The browser can execute JavaScript.
- The requested markdown files are UTF-8 encoded.
- Markdown headings may be frequent in long documents and should remain readable without dominating the page.
- maxGraph-compatible diagrams are authored as fenced `maxgraph` or `mxgraph` blocks containing `mxGraphModel` XML.

## Primary Flow: Open and Read Default Markdown
1. Local operator starts the app directly or through a project launcher.
2. Local reader opens `/` in a browser.
3. Browser UI initializes by entering the content root folder unless a direct markdown URL path or `?path=` is present.
4. Browser UI calls `/api/render`.
5. Server resolves the markdown path inside the content root.
6. Server renders markdown and returns HTML, discovered links, and same-folder markdown files/folders.
7. Browser UI runs client-side diagram post-processing for supported Mermaid and maxGraph-compatible blocks.
8. Browser UI displays current path, rendered HTML, and dropdown options.

Postcondition:
- The selected markdown file is visible as rendered HTML; if the content root has no `README.md`, the first immediate markdown file in the root folder is selected instead.
- Browser URL identifies the current markdown file.

## Primary Flow: Navigate by Markdown Link
1. Local reader clicks a rendered link whose `href` ends with `.md`.
2. Browser UI prevents normal browser navigation.
3. Browser UI calls `/api/render` with the clicked path and current file as `base`.
4. Server resolves the target relative to the current file folder.
5. Server returns rendered target content.
6. Browser UI updates the rendered content, current path, dropdown options, and URL.

Postcondition:
- The linked markdown file is visible in the same page.
- Browser Back can return to the previous markdown file.

## Primary Flow: Navigate by Same-Folder Dropdown
1. Local reader opens the `Current folder` dropdown.
2. Browser UI refreshes file/folder dropdown metadata for the current path.
3. UI shows current `.md` files and markdown-bearing folders from the current folder.
4. Local reader selects a different `.md` file.
5. Browser UI calls `/api/render` for the selected relative path.
6. Browser UI updates content and URL after successful render.

Postcondition:
- The selected same-folder markdown file is visible as rendered HTML.

## Primary Flow: Navigate into a Folder
1. Local reader opens the `Current folder` dropdown.
2. Local reader selects a folder entry displayed with a `> ` prefix.
3. Browser UI calls `/api/render` for that folder path.
4. Server first looks for an immediate `readme.md` file in that folder, matched case-insensitively, then falls back to the first immediate `.md` file in that folder by case-insensitive filename sort order.
5. Server renders that markdown file and returns dropdown options for that folder.

Postcondition:
- The selected folder's readme markdown file is visible when present; otherwise the first immediate markdown file in the selected folder is visible as rendered HTML, and the current browser URL identifies that markdown file.

## Alternative Flow: Navigate into a Folder with No Immediate Markdown Files
1. Local reader selects a folder entry displayed with a `> ` prefix.
2. Browser UI calls `/api/render` for that folder path.
3. Server finds no immediate `.md` files in that folder.
4. Server does not search subfolders for a fallback markdown file.
5. Server returns a `No .md files found.` message and dropdown options for that folder.

Postcondition:
- The render area shows `No .md files found.` and no error banner is shown.

## Primary Flow: Navigate by Browser Back/Forward
1. Local reader has navigated between markdown files in-app.
2. Local reader presses browser Back or Forward.
3. Browser emits `popstate`.
4. Browser UI reads the direct markdown or folder URL path, falling back to `?path=` for old URLs.
5. Browser UI renders that markdown file without pushing a duplicate history entry.

Postcondition:
- Rendered content and visible current path match the browser URL.

## Primary Flow: Timed Auto Refresh
1. Local reader has a markdown file open in the browser UI.
2. The auto refresh timer reaches the selected interval boundary.
3. Browser UI calls `/api/render` for the current path with file option metadata disabled and includes the current render-version token when it has one for that path.
4. If the markdown file changed, the server renders the current markdown content and returns path, render version, HTML, and discovered links without rebuilding folder navigation metadata.
5. Browser UI replaces the rendered markdown content and preserves the existing file/folder dropdown options.
6. If the markdown file did not change, the server returns only a no-change signal.
7. Browser UI treats the no-change signal as a successful refresh and skips re-rendering the markdown body.

Postcondition:
- The rendered markdown content reflects the current file content, and the file/folder dropdown structure changes only after the user opens the dropdown.
- An unchanged auto refresh avoids transferring the full render payload and avoids client-side markdown-body replacement work.

## Primary Flow: Zoom and Pan a Diagram Canvas
1. Local reader views a rendered markdown page containing a Mermaid or maxGraph diagram.
2. Reader holds Ctrl (or Cmd) and scrolls the mouse wheel over the diagram; the diagram zooms in or out toward the cursor within clamped scale bounds, while a plain wheel without the modifier keeps scrolling the page.
3. Reader presses and drags on an empty area of the diagram canvas; the diagram pans within its frame. On a maxGraph canvas, pressing on an entity box instead moves that box and pressing on an entity or edge title still opens inline editing.
4. Reader double-clicks an empty area of the diagram canvas to reset that diagram to the default view.

Postcondition:
- The diagram view (zoom and pan) reflects the reader's interaction, is never written back to the markdown file, and persists across timed auto refresh and in-app markdown re-render for the rest of the browser session; a full page reload resets it to the default view.

## Alternative Flow: Open a Specific File by URL
1. Local reader opens `/<relative_md_path>`, such as `/README.md` or `/docs/guide.md`.
2. Browser UI reads the markdown path from the URL path.
3. Browser UI renders that file.

Postcondition:
- The specified markdown file is visible when it exists and is allowed.

## Alternative Flow: Open a Missing File by URL
1. Local reader opens `/<relative_md_path>` or `/?path=<relative_md_path>` for a markdown file that does not exist, or returns to such a stale URL through browser history.
2. Browser UI requests that markdown path through `/api/render`.
3. Server returns `404` for the missing markdown file.
4. Browser UI replaces the browser URL with `/`.
5. Browser UI renders the default/available file from the configured content root.
6. Browser UI shows a visible message naming the missing file path without auto-hiding it.

Postcondition:
- The browser URL is `/`, the content-root default/available file is visible, and an error banner states that the requested file path does not exist without auto-hiding.

## Alternative Flow: Open a Folder by URL
1. Local reader opens `/<relative_folder_path>`, such as `/docs`.
2. Browser UI reads the folder path from the URL path.
3. Browser UI requests render for that folder.
4. Server renders the immediate readme markdown file in the folder, falls back to the first immediate markdown file in the folder by case-insensitive filename order, or returns a `No .md files found.` message when none exists.

Postcondition:
- The direct folder URL follows the same behavior as selecting that folder from the dropdown.

## Alternative Flow: Open a Legacy Query URL
1. Local reader opens `/?path=<relative_md_path>`.
2. Browser UI reads `path` from the query string.
3. Browser UI renders that file and replaces the browser URL with the direct file URL.

Postcondition:
- Old bookmarked query URLs continue to work and become direct file URLs after load.

## Primary Flow: Preview Current Markdown in VS Code
1. VS Code user opens a `.md` file in VS Code desktop.
2. VS Code shows the MD Activator preview icon in the editor title because the resource language is markdown.
3. VS Code user clicks the preview icon.
4. Extension selects the workspace folder as content root, or the file's parent folder when the file is outside any workspace.
5. Extension selects a free localhost port starting at `49152`.
6. Extension starts or reuses the MD Activator server for that content root.
7. Extension opens a webview panel beside the markdown editor.
8. Webview iframe loads the MD Activator direct markdown URL for the current file.

Postcondition:
- The original markdown editor remains open on one side and the rendered MD Activator preview appears beside it.
- The preview uses the same render API, navigation behavior, auto-refresh, and write-back behavior as standalone browser use.

## Alternative Flow: VS Code Preview for Standalone Markdown File
1. VS Code user opens a markdown file that is not inside a VS Code workspace folder.
2. VS Code user clicks the MD Activator preview icon.
3. Extension uses the file's parent folder as the server content root.
4. Extension opens the file name as the preview path.

Postcondition:
- The standalone markdown file is rendered without requiring a workspace folder.

## Alternative Flow: VS Code Preview Port Conflict
1. VS Code user clicks the MD Activator preview icon.
2. Extension checks `mdActivator.portStart`, defaulting to `49152`.
3. The first candidate port is already occupied.
4. Extension scans later localhost ports until it finds a free port.
5. Extension starts the server on that free port and logs the selected port.

Postcondition:
- Preview starts without requiring the user to manually resolve the port conflict.

## Exception Flow: VS Code Missing uv
1. VS Code user clicks the MD Activator preview icon.
2. Extension tries to execute the configured `mdActivator.uvPath`.
3. The command is missing or cannot run.
4. Extension shows a VS Code error message and writes details to the `MD Activator` output channel.

Postcondition:
- No preview webview is opened for a server that cannot start.

## Exception Flow: VS Code Missing Python Runtime
1. VS Code user clicks the MD Activator preview icon.
2. Extension verifies the staged runtime by running `uv run --native-tls python --version`.
3. Python cannot be resolved or the runtime check exits with an error.
4. Extension shows a setup-focused VS Code error message and writes the command, exit code, stdout, and stderr to the `MD Activator` output channel.

Postcondition:
- No preview webview is opened for a server that cannot start.

## Exception Flow: VS Code Server Start Failure
1. VS Code user clicks the MD Activator preview icon.
2. Extension selects a content root and free port.
3. Dependency sync or server startup fails.
4. Extension reports the failure through VS Code and writes process output to the `MD Activator` output channel.

Postcondition:
- The failed process is cleaned up and the user can retry after fixing the environment.

## Primary Flow: VS Code Preview Write-Back
1. VS Code user opens MD Activator preview beside the source markdown editor.
2. User toggles a rendered checkbox or saves an editable non-diagram fenced code block in the preview.
3. Browser UI calls the existing MD Activator write API.
4. Server updates the markdown file inside the configured content root.
5. VS Code detects the changed file through normal filesystem behavior.

Postcondition:
- The source markdown file reflects the preview write-back, using the existing server-side update behavior.

## Exceptions
- Missing file: server returns `404`; UI displays an error that remains visible until another error replaces it.
- Missing file selected by browser URL: server returns `404`; browser UI replaces the URL with `/`, renders the default/available file from the configured content root, and displays a message naming the missing file path without auto-hiding it.
- Unsupported non-folder, non-markdown target: server returns `400`; UI displays an error that remains visible until another error replaces it.
- Path traversal or content-root escape: server returns `400`; UI displays an error that remains visible until another error replaces it.
- Missing default markdown: when the content root has no `README.md`, the server falls back to the first immediate markdown file in the root folder; when the root has no immediate markdown files, the UI shows `No .md files found.` without an error.
- Missing requested readme: when a stale client or URL requests a missing `README.md`/`readme.md`, the server falls back as though the containing folder had been requested.
- Browser cannot load required UI assets: UI does not initialize.
- VS Code preview invoked without an active markdown file: extension reports that a markdown editor must be active.
- VS Code extension deactivated while server is running: extension stops the spawned server process.

## Implied Requirements and Tests
- Render path resolution must be deterministic and content-root restricted.
  Test: renderer unit tests for base resolution and escape rejection.
- API responses must include enough metadata for UI navigation.
  Test: API test for `path`, `html`, and `fileOptions`.
- Browser navigation must avoid full-page reloads for local `.md` links.
  Test: browser-level smoke or Playwright test.
- Browser URLs should identify markdown files as direct paths rather than `?path=` query strings.
  Test: API shell routing for direct `.md` paths and static JavaScript regression check for URL parsing/history helpers.
- Browser URLs that identify missing markdown files should fall back to `/` while preserving a visible missing-path message without auto-hiding it.
  Test: static JavaScript regression check for missing file URL fallback.
- Browser error banners should stay visible across later loading attempts and successful operations for URL, render, dropdown refresh, checkbox/code-block write-back, and maxGraph write-back errors.
  Test: static JavaScript regression check for persistent browser error handling.
- Dropdown options must reflect the current folder and include immediate `.md` files plus markdown-bearing folders.
- Folder options must display as structured folder options and load the immediate readme markdown file in that folder when present, then fall back to the first immediate markdown file in the folder, or show `No .md files found.` if none exists.
- Mermaid fences and raw Mermaid diagram blocks must render through Mermaid JS rather than remain plain code blocks.
  Test: renderer unit tests for Mermaid container preparation; browser-level check for client rendering.
- Rendered Mermaid and maxGraph diagram canvases must support Ctrl/Cmd+wheel zoom-to-cursor with clamped scale, empty-area drag-to-pan, and double-click-to-reset, while a plain wheel keeps scrolling the page. maxGraph background pan must not interfere with entity-box drag or inline title editing. Zoom/pan is view-only and persists per diagram within the browser session across re-renders, resetting only on a full page reload.
  Test: static JavaScript/probe checks for the shared zoom/pan controller (Ctrl-gated zoom-to-cursor math, scale clamping, pan delta, double-click reset, session state store) plus static JavaScript/CSS checks for maxGraph and Mermaid wiring and the pan/node-drag disambiguation predicate.
- Fenced `maxgraph`, `mxgraph`, `maxgraphcolor`, and `maxgraphcolorall` blocks containing `mxGraphModel` XML or draw.io `mxfile` XML containing an `mxGraphModel` must render as diagrams rather than editable code blocks. `maxgraph` and `mxgraph` are normal style mode and support only `fontSize`; rectangle vertex cells and orthogonal edge bends must render rounded as if `rounded=1`, and any source `rounded` value must be ignored. `maxgraphcolor` is color style mode and supports `strokeColor`, `fontColor`, and `fontSize`; it must ignore `fillColor` and any source `rounded` value, while rectangle vertex cells and orthogonal edge bends still render rounded as if `rounded=1`. `maxgraphcolorall` is color-all style mode and supports `fillColor`, `strokeColor`, `fontColor`, `labelBackgroundColor`, `fontSize`, and `rounded`. `fillColor` colors node shape fill only in color-all mode, `strokeColor` colors node shape stroke plus edge stroke and visible arrow marker color in color and color-all modes, `fontColor` colors node and edge labels in color and color-all modes, `labelBackgroundColor` colors node and edge label backgrounds only in color-all mode, `fontSize` sizes node and edge labels, and `rounded` rounds rectangle vertex cells plus orthogonal edge bends only in color-all mode; straight edges are not visually changed by `rounded`. Edge styles `startArrow` and `endArrow` must independently control source and target markers on straight and orthogonal edges. Supported values are `none`, `classic`, `classicThin`, `block`, `blockThin`, `open`, `openThin`, `oval`, `diamond`, and `diamondThin`; `none` omits that side's marker, `open` and `openThin` render unfilled stroked markers, `oval` renders a circle/oval marker, and each `Thin` value renders a narrower version of its base shape. Missing or unsupported `startArrow` keeps no source marker, and missing or unsupported `endArrow` keeps the default classic target marker. Invalid `fontSize` and unsupported or mode-gated styles should be ignored. Entity boxes may be dragged in the rendered canvas; during a drag, the browser must check the latest dragged location every 0.1 seconds and re-render the current canvas from an in-memory diagram copy when that location differs from the location used for the previous in-drag preview render, without saving the markdown file. Dropping a moved box must write the box's new `mxGeometry x` and `y` location to the original markdown file and re-render the diagram from the saved source while preserving any `mxfile` wrapper. Entity box titles may be edited inline with a multiline textarea positioned inside the cell box and sized to the cell box width and height minus 4 points; Enter inside the textarea must insert a newline, saved title line breaks must render as separate SVG text lines inside the entity box, and automatic title wrapping must use the available entity-box title width instead of a fixed short character count. When the editor loses focus with changed text, the browser must write the title to the matching vertex cell's `value` attribute in the original fenced XML block and re-render from the saved markdown while preserving any `mxfile` wrapper, while unchanged title edits close without a save request. Edge titles may be edited by double-clicking the rendered edge label; the editor must be a 3-line textarea, Enter must insert a newline, changed text must be saved on blur to the matching edge cell value in the original fenced XML block, unchanged edits must close without a save request, and saved edge-title line breaks must render as separate SVG text lines. The browser must keep the latest 50 successful entity-box moves, entity-title changes, and edge-title changes in session edit history; Ctrl+Z outside text-editing controls must undo the most recent saved maxGraph edit by writing the previous location or title and re-rendering, and Ctrl+Y outside text-editing controls must redo the next undone edit by writing its later location or title and re-rendering. New successful maxGraph edits clear redo history. Edges styled with `edgeStyle=orthogonalEdgeStyle` must render as right-angled connectors, imported fixed link position metadata such as edge geometry points and `entryX`/`entryY` or `exitX`/`exitY` style coordinates must be ignored, orthogonal connectors must approach their selected sides perpendicularly, all same-side edge attachments must be shifted apart with at least two arrow widths of spacing when the side has enough usable span regardless of whether each link is incoming or outgoing, same-side connection-point groups must use even adjacent clearance and sit on the side middle when those placements do not violate higher-priority routing rules, same-side connection-point order may be switched across incoming and outgoing links when the alternate order improves route scoring without violating spacing, overlapping orthogonal connector lanes must be shifted apart with at least 1.5 arrow widths of visual clearance between shifted parallel connector segments when a route can provide that separation, orthogonal routes must avoid crossing non-endpoint entities when possible, must avoid partial or full overlap with other collinear links when a non-overlapping route exists, must avoid crossings with already-routed links when a non-crossing route exists, must prefer a single straight segment for vertically or horizontally overlapping connected nodes when that does not break higher-priority rules, prefer fewer right-angle turns after those avoidance rules, then the source side facing the target row or column, then centered attachment points, then even same-side attachment clearance, then shorter paths after those avoidance rules, keep enough straight run into arrow endpoints so adjacent perpendicular segments do not touch arrowhead sides, optimize endpoints by trying alternate sides and shifted attachment points when that reduces bends or keeps a preferred side usable without violating higher-priority rules, render edge labels as horizontal text on a rendered route segment, prefer a horizontal segment when the one-line title width fits and the best placement has practical clearance from cells, connectors, and existing text, choose the best-clearance and then longer segment when multiple horizontal segments qualify, and fall back to the longest rendered route segment when no horizontal segment can hold the title with practical clearance. Edge labels should prefer one line, allow two or three lines when needed, stay above or below horizontal segments, sit to the left or right of vertical segments when space is available with horizontal label padding and margin set to 0 and the visible title text's inner edge leaving only 4 points of clearance from the vertical segment, try left/right shifts along horizontal segments and left/right/up/down shifts along vertical segments when the first placement overlaps or sits close to cells, connectors, text, nearby entity boxes, nearby arrows or connector segments, or nearby horizontal segments, and choose the least-overlapping placement that keeps practical clearance from nearby diagram elements while still staying farthest from nearby horizontal segments unless overlap is unavoidable. The rendered maxGraph SVG canvas and viewBox should include routed connector segment bounds and final edge-label text block bounds so links and link titles are not clipped. When routing rules tie, link connection points should stay closest to the middle of their selected side.
  Test: renderer/API unit tests for maxGraph XML container preparation, style-mode metadata, dragged entity-box location write-back, entity-title write-back, and edge-title write-back; static JavaScript/CSS checks for client rendering, normal/color/color-all style gating, font size, forced normal/color rounding, rounded vertex cells and orthogonal edge bends, label background color in color-all mode, independent `startArrow`/`endArrow` marker styles and suppression, changed-position drag preview re-render without save, drag/drop save behavior, inline multiline title editor sizing, width-based title wrapping, rendered line breaks, entity-title blur save behavior, edge-title 3-line textarea editing, edge-title rendered line breaks, edge-title blur save behavior, unchanged title no-save behavior, 50-step maxGraph edit history for moves and title changes, Ctrl+Z/Ctrl+Y undo/redo binding, orthogonal edge support, ignored imported fixed link positions, perpendicular orthogonal approach, same-side connection spacing across incoming and outgoing links, same-side even-clearance and side-middle grouping, same-side port order optimization, overlapping route lane shifting with minimum visual clearance, node-avoiding route selection, avoidable line-overlap reduction, avoidable line-crossing reduction, direct straight-route selection, arrowhead endpoint clearance, side-pair selection, shifted attachment points, center-side tie breaking, edge route bounds, and edge label placement; browser-level check when available.
- During maxGraph entity-box drag preview, a 0.1-second timer tick must not start a new preview render while the previous preview render is still in progress. Once no preview render is in progress, the next eligible tick renders only if the latest dragged position differs from the position used for the previous completed preview render.
  Test: static JavaScript/probe check for the drag-preview in-flight render guard plus changed-position render gating.
- For diagrams where one maxGraph XML source entity fans out to many orthogonal target links, the renderer should route that fanout bundle before shorter feedback or loopback links when practical, then route later links around the established fanout corridor without relaxing node avoidance, link-conflict avoidance, or endpoint-clearance rules. If an incoming link to that high-fanout entity needs an early low-conflict corridor, the incoming link may be routed before the outgoing bundle so later fanout routes preserve lower crossings, non-overlapping segments, entity-box clearance, endpoint clearance, and fewer bends.
  Test: static JavaScript regressions with a far-left fanout source and feedback link around the target stack, plus pasted ontology layouts where an incoming Memory-to-Belief link must not be blocked by Belief's outgoing fanout routes.
- Dropdown options must exclude non-markdown files.
  Test: renderer/API test for `fileOptions`; browser-level check for UI binding.
- Auto refresh must not refresh dropdown file/folder structure.
  Test: renderer/API regression tests for skipped file options and static JavaScript check for auto-refresh request options.
- Unchanged auto refresh may return a no-change signal instead of a full render payload.
  Test: API regression test for `status: no-change` and static JavaScript check for no-change handling.
- Opening the file/folder dropdown must request dropdown file/folder metadata for the current path. The server may reuse a folder metadata cache entry that is still fresh under the 5-second rule; it must rebuild metadata when no fresh cache entry exists.
  Test: static JavaScript/template check for dropdown popup refresh wiring; renderer/API cache-boundary test; browser-level check when available.
- Rendered markdown headings must be smaller than browser defaults while preserving hierarchy.
  Test: static CSS regression check; browser-level visual smoke check.
- VS Code editor-title command must be contributed only for markdown resources.
  Test: extension manifest/static test.
- VS Code preview must open beside the source editor and use a dynamically selected localhost port.
  Test: extension helper tests plus manual VS Code smoke test.
- VS Code server staging must include the runtime payload required to launch the existing FastAPI app.
  Test: extension staging script test/check.

## Validation Method
- Unit/API validation with pytest.
- Manual browser validation for JavaScript history and dropdown behavior until browser automation is added.
- Extension validation with npm checks, local `vsce package`, local VSIX install, and manual VS Code desktop smoke testing.
