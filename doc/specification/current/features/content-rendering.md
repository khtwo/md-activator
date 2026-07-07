# Content Rendering

_[← Application Features index](../application-features.md)._ How file source is converted to rendered HTML: the Markdown pipeline, front matter, YAML/JSON trees, image rendering, file download links, and link discovery/linkification. (Diagram fences are covered in [diagram-rendering.md](diagram-rendering.md); checkbox/button/progress transforms in [interactive-controls.md](interactive-controls.md).)

## Markdown Rendering
- Markdown conversion uses the Python `markdown` package.
- Enabled extensions are `fenced_code`, `tables`, `toc`, `sane_lists`, and a viewer-owned table-class extension (`MarkdownTableClassExtension`) that tags every rendered `<table>` with the `markdown-table` class — the styling hook described under "Markdown pipe-table structures" below. This matches the extension set recorded in `scope.md`.
- Rendered HTML is not sanitized: raw HTML and scripts embedded in the source markdown pass through to the page unchanged. The viewer is intended for local, operator-trusted markdown only — see the "Rendered HTML safety" trust boundary in `scope.md` for the full security stance and its rationale.
- Files are read as UTF-8 text.
- Non-diagram fenced code blocks are rendered with original source line and occurrence index metadata so the browser can update the original fenced section precisely, even when earlier markdown content is transformed into generated HTML before display.
- A non-diagram fenced code block whose info string has no recognized language token (empty, whitespace-only, or a first token that is not a valid language identifier) is rendered with `class="language-text"` — Prism's no-highlight language — so it gains the shared code styling and renders as plain text. A fence with a recognized language still renders `class="language-<token>"`. The default applies only at render time; the markdown source fence info string is not modified, and editing/saving such a block does not write `text` into it.
- When saved editable content belongs to a backtick-fenced code block, the server rewrites both wrapper fence lines to use a backtick run that is one character longer than the longest consecutive backtick run in the saved content, with a minimum wrapper length of 3 backticks. The opening fence keeps its existing info string.
- Markdown pipe-table structures are rendered as semantic HTML tables with a viewer-owned styling hook so the browser can present them as polished reading tables without changing markdown source content.
- Two-space-indented child list markers are normalized before Markdown conversion so common nested unordered and ordered lists render as semantic nested lists with visible indentation.
- A top-level ordered list that follows an unordered list remains a separate ordered list and displays item numbers.
- A list that immediately follows a paragraph line, with no intervening blank line, starts its own list block on a new line instead of being absorbed into the preceding paragraph — matching the official Markdown (CommonMark) rule that a list interrupts a paragraph. Because the `sane_lists` extension otherwise suppresses paragraph-interrupting lists, a separating blank line is inserted before the interrupting list marker before Markdown conversion. This separator insertion is sequenced after checkbox and code-block source-line metadata has been captured, so the added blank lines never shift the original file line numbers that checkbox and code-block write-back target — every interactive marker below an interrupting list stays aligned with its line in the saved file.
- A bullet marker (`-`, `*`, or `+` followed by a space and at least one non-space character) interrupts a paragraph. An ordered marker interrupts a paragraph only when it starts at `1` (`1.` or `1)` followed by a space and content); an ordered marker that starts at any other number stays paragraph prose, matching CommonMark. An empty list marker (a bullet or number with no following content) does not interrupt a paragraph.
- Lines that already belong to a list — the block began with a list marker — are left unchanged, so tight lists and their lazy-continuation lines are preserved and never split into separate blocks. Blocks already separated by a blank line, and fenced code blocks, are never altered.

## Front Matter Rendering
- A leading YAML front-matter block is detected when the file's first physical line is exactly `---` (after trimming surrounding whitespace) and a later line is exactly `---`; the block is the lines between those two delimiters. A file that does not start with `---`, whose opening `---` has no closing `---`, or whose delimited block contains no non-blank content line, has no front matter and is rendered unchanged through the normal Markdown pipeline.
- A detected block renders as a two-column key/value HTML table placed at the very top of the rendered markdown body, before the rest of the rendered content. The table carries the `markdown-table` and `front-matter-table` classes so it reuses the rendered-table styling in light and dark themes; keys render in `<th>` header cells and values in `<td>` cells. This matches how GitHub and the built-in VS Code preview present front matter, and replaces the prior behavior where the block leaked into the body as a paragraph wrapped in horizontal rules.
- Each content line is split into a key and value on its first `:`, so values retain any later colons (for example timestamps). A line with no `:` becomes a key with an empty value, and a sequence item written as `- item` carries no key and keeps its text as the value. A line that has deeper-indented child lines renders those children as a nested key/value table inside its value cell; a line's children are the following lines with strictly greater leading-space indentation.
- Keys and values are HTML-escaped. The block is not parsed, validated, or reformatted as YAML and pulls in no YAML library, matching the line-based YAML tree renderer; content that is not valid YAML still renders as a best-effort key/value table rather than raising.
- The block is removed from the Markdown body by blanking it in place: every front-matter line, including both `---` delimiters and the content lines between them, is replaced by an empty line. Because no lines are added or removed, body content below the block keeps its exact 1-based file line numbers, so checkbox and code-block write-back line numbers and Mermaid/maxGraph source-block anchors remain correct. Blanking also keeps front-matter text such as a `[x]` inside a value out of the Markdown body, where it would otherwise be transformed into a checkbox marker.
- The `/api/render` response shape is unchanged for files with front matter. Front-matter values are treated as metadata and are not linkified or added to the discovered `links` list.

## YAML Rendering
- Files with a `.yml` or `.yaml` extension are rendered as a collapsible indentation tree instead of through the Markdown pipeline. Extension matching is case-insensitive.
- The file is read as UTF-8 text and split into physical lines. A line's tree depth is its number of leading spaces; a line is a child of the nearest preceding line that has strictly fewer leading spaces.
- A line that has at least one deeper-indented non-blank descendant line is a branch and renders a leading `+`/`-` toggle control. A line with no deeper line is a leaf and renders its content aligned with branch content but without a toggle.
- All branch nodes are expanded by default: the toggle shows `-`, carries `aria-expanded="true"`, and the child block is visible. Activating a toggle collapses the node — its child block is hidden and the toggle shows `+`; activating it again re-expands it. Collapse state is a browser-session, view-only concern and is never written back to the file.
- Blank lines are preserved as empty rows in document order and do not, by themselves, make the preceding line a branch.
- Line text is HTML-escaped before rendering. YAML is not parsed, validated, or reformatted, so comments, key ordering, and original formatting are preserved as written; content that is not valid YAML still renders as its indentation tree rather than producing an error.
- An empty or whitespace-only file renders an empty-state message instead of a tree.
- The `/api/render` response shape is unchanged for `.yml`/`.yaml` files: it returns the same `path`, `renderVersion`, `html`, and (when requested) `fileOptions` fields. The `links` list is empty for YAML files. YAML renders use the same in-process render cache and render-version rules as markdown files.

## JSON Rendering
- Files with a `.json` or `.jsonl` extension are rendered as a collapsible, pretty-printed value tree instead of through the Markdown pipeline. Extension matching is case-insensitive.
- The file is read as UTF-8 text and parsed as JSON. A `.json` file is parsed as a single JSON value. A `.jsonl` file is parsed as one JSON value per non-blank physical line (JSON Lines); each line's value is rendered as its own top-level entry in source order, with no comma between records.
- The parsed value is re-formatted with indentation regardless of the original file's whitespace: each object member renders as a `"key": value` row and each array element as a `value` row, one per row, with nesting depth shown by indentation. Sibling members and elements are comma-separated, with no trailing comma after the last sibling, matching standard pretty-printed JSON.
- A value that is a non-empty object or array is a branch: it renders a leading `+`/`-` toggle control before its opening bracket (`{` or `[`), its members/elements render as nested rows, and a matching closing bracket row (`}` or `]`) aligns under the opening row. A scalar (string, number, `true`, `false`, `null`) and an empty object `{}` or empty array `[]` are leaves and render without a toggle.
- All branch nodes are expanded by default: the toggle shows `-`, carries `aria-expanded="true"`, and the child block is visible. Activating a toggle collapses the node — its child rows and closing-bracket row are hidden, a `…` placeholder closes the bracket inline after the opening row (followed by the sibling comma when the collapsed branch is not the last sibling), and the toggle shows `+`; activating it again re-expands it. Collapse state is a browser-session, view-only concern and is never written back to the file.
- Object keys and scalar values are HTML-escaped before rendering. The rendered tree is a read-only view and is never written back to the file.
- A `.json` file whose content is not valid JSON, or a `.jsonl` file with any invalid line, renders an error state that names the JSON decode error (a `.jsonl` parse error is prefixed with the offending line number) and shows the original file text instead of raising.
- An empty or whitespace-only file renders an empty-state message instead of a tree.
- The `/api/render` response shape is unchanged for `.json`/`.jsonl` files: it returns the same `path`, `renderVersion`, `html`, and (when requested) `fileOptions` fields. The `links` list is empty for JSON files. JSON renders use the same in-process render cache and render-version rules as markdown files.

## Markdown Image Rendering
- Markdown image syntax whose target is an internet URL is rendered as a browser image using the URL unchanged.
- Markdown image syntax whose target is a local image path is rendered as a browser image whose `src` uses a protected local image endpoint, but only when that path resolves to a file that exists inside the configured content root.
- Bare local image path references, inline-code local image paths, and bare internet image URLs outside fenced code blocks are converted into rendered browser images.
- A local image reference (markdown image syntax, inline-code path, or bare path) whose target file does not exist inside the content root — because the file is missing or the path escapes the content root — is not rendered as an image. Instead the image path text is shown as written and no `<img>` element is emitted. This existence check applies to local file paths only; internet image URLs are always rendered as images and are never checked for existence (no network request is made at render time).
- Local image paths are resolved relative to the rendered markdown file and must remain inside the configured content root before the server returns image bytes.
- Supported image file extensions are `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`, and `.svg`.
- Fenced code blocks remain literal and must not auto-render image references.
- Rendered images are constrained to the markdown body width (`max-width: 100%`) while preserving their aspect ratio.

## Markdown File Download Links
- Local non-`.md`, non-`.yml`, non-`.yaml`, non-`.json`, non-`.jsonl`, non-image file path references outside fenced code blocks are converted into clickable download links. `.yml`/`.yaml` references are excluded here because they open in the viewer as YAML trees, and `.json`/`.jsonl` references are excluded because they open in the viewer as JSON trees, instead of downloading.
- Supported references include inline-code file paths, bare file paths, and existing markdown links whose destination is a local non-`.md` file path.
- Converted links keep the visible file location text and use the protected file download endpoint as the target.
- Adjacent rendered links in paragraphs or list items use added horizontal spacing so separate link items are visually distinct.
- Local file paths are resolved relative to the rendered markdown file and must remain inside the configured content root.
- A protected file download link is emitted only when the resolved local file exists and is a file.
- Missing local file references remain unchanged, including existing markdown link destinations.
- Fenced code blocks remain literal and must not auto-link file references.
- Rendered image behavior remains unchanged; local image references continue to render as images rather than generic file download links.

## Markdown Link Discovery
The renderer extracts unique markdown links whose target path ends in `.md`. URL fragments are ignored for link discovery. Only local references are discovered: a markdown link whose target carries a URL scheme or network host (for example a full `http`/`https` URL, even one ending in `.md`) is excluded from the discovered links.

## Path Reference Linkification
The renderer converts bare full `http` and `https` URL references outside fenced
code blocks into clickable links. A full URL that ends in `.md` remains a
single external URL link rather than becoming an in-app local markdown link. A
trailing run of common sentence punctuation (`.`, `,`, `;`, `:`, `!`, `?`), or a
trailing `)`, `]`, or `>`, immediately after a bare URL is kept outside the link
target. The bare-URL pass does not match a URL whose scheme immediately follows
a `<` or `[`, so URLs already written as Markdown link labels or autolinks
(`<...>`) are not re-wrapped; a URL already written as a Markdown link target
(`](...)`) is left untouched by the emitter's link-target guard. A bare URL that
opens inside prose parentheses — `(https://example.com)` — is linkified, with the
closing `)` kept outside the link target.

The renderer converts local `.md`, `.yml`, `.yaml`, `.json`, and `.jsonl` path references into clickable in-app viewer links when they are:
- Inline-code path references, such as `` `docs/example.md` ``, `` `config/app.yml` ``, or `` `data/records.json` ``.
- Bare path references, such as `docs/example.md`, `config/app.yaml`, or `data/records.jsonl`.

`.yml` and `.yaml` references match case-insensitively and open in the viewer (rendered as a YAML tree) rather than as file downloads. `.json` and `.jsonl` references likewise match case-insensitively and open in the viewer (rendered as a JSON tree) rather than as file downloads.

These local-path passes do not require the referenced file to exist on disk: a matching `.md`, `.yml`, `.yaml`, `.json`, or `.jsonl` reference becomes a viewer link unconditionally (unlike non-viewer download references, which stay literal when the file is missing). The local-path passes also leave references that are already part of a Markdown link untouched: an inline-code or bare path immediately followed by `](` (used as a link label) or immediately preceded by `](` (already a link target) is not re-wrapped.

A bare reference that opens inside prose parentheses — for example `(../../doc/work-order/work-order.md #1)` — is linkified like the same reference in open prose: the `../../doc/work-order/work-order.md` part becomes a viewer link while the leading `(` and the trailing whitespace-then-`#1)` stay literal. An opening `(` alone does not suppress linkification; only a Markdown link target (`](...)`) is protected, by the immediately-preceding-`](` guard above. The reference token ends at the first whitespace, and a trailing `)` immediately after the reference is kept outside the link target. This applies uniformly to the viewer-path, download-file, and local-image bare passes.

The renderer must not convert a `.md` suffix that is part of a full `http` or
`https` URL into a separate local markdown link; the full URL text remains
intact in the rendered paragraph.

Fenced code blocks remain literal.

## Invariants & design constraints
_Maintainer rules the behavior above depends on — recorded so a future change does not silently break them. Migrated from working memory 2026-07-02; see change package `../../changes/2026-07-02-memory-invariants-backfill/`._

- **File-line-number preservation.** Rendered HTML embeds absolute 1-based file line numbers: checkbox markers carry `data-checkbox-line`, non-diagram code blocks carry source-line/occurrence metadata, and Mermaid/maxGraph containers carry `data-*-line` anchors. Write-back re-reads the file and indexes `lines[line - 1]`. Therefore **any transform applied to content at or above interactive markers must preserve the file's line count** — blank lines in place (replace content with `""`, keep the `\n`), never add or delete lines. Front-matter blanking and the paragraph/list separator insertion both obey this (and the separator pass is sequenced *after* checkbox/code-block metadata capture). Adding or removing a line above a marker desyncs every downstream checkbox toggle, code-block edit, and diagram anchor. Change packages: `../../changes/2026-06-15-checkbox-codeblock-line-stability/`, `../../changes/2026-06-15-frontmatter-table/`.
- **Code-block HTML has a single source.** Non-diagram fenced code-block HTML is emitted by the viewer's own code-block extractor during pre-processing (it pulls each closed non-diagram fence into a placeholder and pre-renders it), **not** by the `markdown` package's `fenced_code` extension, which is effectively bypassed for real code blocks. To change rendered code-block markup (classes, default language, escaping) edit the extractor's emitter, not the extension or the `markdown.markdown(...)` call.
