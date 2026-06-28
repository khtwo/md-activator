# Current Specification Index

## Source-of-Truth Rule
Current application behavior is documented in this folder and in the requirements document linked below. Change-scoped specs under `doc/specification/changes/` describe the history and rationale for specific changes, but these current-state files should be updated when behavior changes become durable system truth.

## Documents
- [Requirements](../../requirements/markdown-html-viewer/requirement_markdown-html-viewer.md): product requirements, acceptance criteria, assumptions, and open questions.
- [Scope](scope.md): system boundary, in-scope behavior, non-goals, and external dependencies.
- [Features](application-features.md): routing index for current user-visible and API-visible capabilities, split into domain-specific specs under [`features/`](features/) (server & API, content rendering, diagrams, interactive controls, file navigation & notifications, browser UI, launchers & packaging, validation coverage).
- [Use Cases](use-cases.md): actor-centered flows, alternatives, exceptions, and implied tests.
- [Tech Stack](../../tech-stack/tech-stack.md): compact canonical stack index for normal work.
- [Tech Stack Detail](../../tech-stack/tech-stack-detail.md): detailed stack decision record and operational notes.

## Current System Summary
MD Activator is a local FastAPI application with a Vue/Quasar browser UI. It renders markdown files from a configured local content root, supports in-app navigation between `.md` files, exposes same-folder file metadata for dropdown navigation, keeps the browser URL synchronized with the current markdown file, and serves browser runtime libraries from local server assets rather than internet/CDN URLs.

## Documentation Maintenance
- Update requirements before changing durable user-visible behavior.
- Update use cases when a workflow, exception, or actor goal changes.
- Update feature specs when endpoint contracts, UI controls, rendering behavior, or navigation behavior changes.
- Update tech-stack artifacts when dependencies, runtime assumptions, CDN assets, or validation tools change.
- Keep task playbooks under `taskTypes/` read-only during normal software development sessions.

## Current Known Gaps
- End-to-end browser automation (e.g. Playwright driving the live page) is intentionally not used; by design the project has no browser-runtime test dependency. Browser-facing logic for URL/history and dropdown behavior is instead covered by committed Node-based probe tests that execute the extracted pure helpers (`tests/test_app_static_browser_controls.py`, `tests/test_app_static_url_parsing.py`), backed by static source-wiring assertions. The residual gap is that page-level wiring is verified by source substring assertions rather than a running browser.
- Rendered markdown HTML safety is documented: the renderer does not sanitize output, so the viewer is for local trusted content only and is not safe for untrusted/public hosting. See `scope.md` → "Rendered HTML safety".
