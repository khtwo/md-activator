# Application Features

This document is the **routing index** for MD Activator's current, durable feature specification. The detailed behavior lives in domain-specific files under [`features/`](features/), each one cohesive around a single subsystem and kept loosely coupled to the others (cross-domain references are links, not duplicated text). This index intentionally holds no feature details itself — open the relevant domain file below.

When behavior changes become durable system truth, update the domain file whose area changed (and, for cross-cutting test additions, [Validation Coverage](features/validation-coverage.md)).

## Feature Domains

| Domain | Spec file | Covers |
| --- | --- | --- |
| Local Server & HTTP API | [features/server-api.md](features/server-api.md) | server lifecycle and CLI flags (`--cd`/`--open`/`--host`/`--port`/reload), content-root selection, in-process render and folder-metadata caches, every `/api/*` endpoint contract, and path resolution / content-root trust boundary |
| Content Rendering | [features/content-rendering.md](features/content-rendering.md) | the Markdown→HTML pipeline, front-matter table, YAML and JSON collapsible trees, image rendering, file download links, markdown link discovery, and bare-URL / path-reference linkification |
| Diagram Rendering & Editing | [features/diagram-rendering.md](features/diagram-rendering.md) | Mermaid rendering and auto-repair, the shared diagram zoom/pan controller, and maxGraph XML rendering, orthogonal routing, edge labels, and inline node/edge editing |
| Interactive Checkbox Controls | [features/interactive-controls.md](features/interactive-controls.md) | checkbox markers, button options, single-choice groups, read-only progress bars, and their `/api/checkbox` write-back |
| File Navigation & New-File Notifications | [features/file-navigation.md](features/file-navigation.md) | same-folder dropdown `fileOptions` metadata, the new-`.md`-file notification bell (scope/window, git-ignore exclusion, list cache, no-change protocol) with review-first sorting and confirm-to-dismiss, and the file-name search endpoint (`/api/search-files`: normalized name matching, all-files scope, containment, memoized live walk) |
| Browser UI, Typography & Navigation | [features/browser-ui.md](features/browser-ui.md) | toolbar controls (navigation, dropdown, auto-refresh, theme, font scale, bell, file-name search), error banner, reading typography and table styling, URL/history navigation, and in-preview content search |
| Launchers, VS Code Extension & Release Packaging | [features/launchers-and-packaging.md](features/launchers-and-packaging.md) | `start_md.bat`/`start_md.sh`, the VS Code extension (manifest, preview command, server lifecycle, VSIX helper), and `release.bat` packaging |
| Validation Coverage | [features/validation-coverage.md](features/validation-coverage.md) | a summary of what the committed test suite currently covers across all domains |

## How to navigate cross-domain references
Some behavior spans domains; the detail lives in one file and the others link to it:
- HTTP endpoint contracts (including the diagram write-back/repair and `/api/checkbox` endpoints) are all defined in **Local Server & HTTP API**; the rendering and control domains describe what they persist and link there.
- The notification bell and same-folder dropdown have their backend behavior in **File Navigation & New-File Notifications**, while the toolbar controls that present them are in **Browser UI, Typography & Navigation**.
- Diagram zoom/pan is shared by Mermaid and maxGraph and is specified once in **Diagram Rendering & Editing**.
- The rendered-HTML safety boundary and other system boundaries are in [`scope.md`](scope.md).

## Related specification documents
- [Current spec index](index.md): source-of-truth rule, document map, and maintenance guidance.
- [Scope](scope.md): system boundary, in-scope behavior, non-goals, external dependencies, and trust boundaries.
- [Use Cases](use-cases.md): actor-centered flows, alternatives, exceptions, and implied tests.
- [Requirements](../../requirements/markdown-html-viewer/requirement_markdown-html-viewer.md): product requirements and acceptance criteria.
