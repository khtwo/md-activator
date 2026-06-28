"""Collapsible pretty-printed tree renderer for ``.json`` / ``.jsonl`` files.

``JsonTreeRenderer`` parses raw JSON text and re-emits it as a nested ``<ul>``
tree that always renders with indentation regardless of the source file's
whitespace (so a minified one-line file still reads as pretty-printed JSON). Each
non-empty object or array becomes a collapsible branch with a ``+``/``-`` toggle;
scalars (string / number / ``true`` / ``false`` / ``null``) and empty containers
(``{}`` / ``[]``) are leaves with no toggle. All branches are expanded by default.

Unlike :class:`~app.markdown_services.yaml_tree_renderer.YamlTreeRenderer` (a
line/indentation renderer that never parses), this collaborator *parses* the
text — that is what makes "pretty look with indents" possible and what defines
which nodes "have children". A ``.json`` file is one JSON value; a ``.jsonl``
file is one JSON value per non-blank physical line (JSON Lines), each rendered as
its own top-level record. Invalid JSON renders an error state that names the
decode error and shows the original file text, rather than raising — keeping the
viewer resilient and the file readable.

The collaborator is pure and stateless: it owns no renderer state and has no root
dependency, so ``MarkdownRenderer`` composes a single shared instance and
dispatches ``.json`` / ``.jsonl`` renders to :meth:`render`.
"""

from __future__ import annotations

import html
import json


class _JsonRenderError(Exception):
    """Internal signal that the source text could not be parsed as JSON."""


class JsonTreeRenderer:
    """Render JSON / JSON Lines text as a collapsible pretty tree (HTML)."""

    EMPTY_HTML = '<div class="json-view"><p class="json-empty">Empty JSON file.</p></div>'

    def render(self, text: str, *, jsonl: bool = False) -> str:
        # Empty or whitespace-only input has no JSON value to show.
        if not text.strip():
            return self.EMPTY_HTML

        try:
            values = self._parse(text, jsonl=jsonl)
        except _JsonRenderError as exc:
            return self._error_html(text, str(exc))

        if not values:
            return self.EMPTY_HTML

        # ``.json`` yields a single value; each ``.jsonl`` record is an
        # independent top-level value, so none of them carry a trailing comma.
        body = "".join(
            self._render_value(value, key_html=None, is_last=True) for value in values
        )
        return f'<div class="json-view"><ul class="json-tree">{body}</ul></div>'

    # ------------------------------------------------------------------ #
    # Parsing
    # ------------------------------------------------------------------ #
    def _parse(self, text: str, *, jsonl: bool) -> list[object]:
        if not jsonl:
            try:
                return [json.loads(text)]
            except json.JSONDecodeError as exc:
                raise _JsonRenderError(str(exc)) from exc

        values: list[object] = []
        for number, line in enumerate(text.splitlines(), start=1):
            if not line.strip():
                continue
            try:
                values.append(json.loads(line))
            except json.JSONDecodeError as exc:
                raise _JsonRenderError(f"line {number}: {exc}") from exc
        return values

    # ------------------------------------------------------------------ #
    # Value rendering
    # ------------------------------------------------------------------ #
    def _render_value(self, value: object, *, key_html: str | None, is_last: bool) -> str:
        comma = "" if is_last else ","
        prefix = "" if key_html is None else f'{key_html}<span class="json-punct">: </span>'

        if isinstance(value, dict):
            return self._render_object(value, prefix=prefix, comma=comma)
        if isinstance(value, list):
            return self._render_array(value, prefix=prefix, comma=comma)
        return self._render_leaf(f"{prefix}{self._format_scalar(value)}{comma}")

    def _render_object(self, obj: dict, *, prefix: str, comma: str) -> str:
        if not obj:
            return self._render_leaf(f"{prefix}{{}}{comma}")
        items = list(obj.items())
        last = len(items) - 1
        children = "".join(
            self._render_value(value, key_html=self._format_key(key), is_last=(index == last))
            for index, (key, value) in enumerate(items)
        )
        return self._render_branch(prefix=prefix, open_bracket="{", close_bracket="}", comma=comma, children=children)

    def _render_array(self, arr: list, *, prefix: str, comma: str) -> str:
        if not arr:
            return self._render_leaf(f"{prefix}[]{comma}")
        last = len(arr) - 1
        children = "".join(
            self._render_value(value, key_html=None, is_last=(index == last))
            for index, value in enumerate(arr)
        )
        return self._render_branch(prefix=prefix, open_bracket="[", close_bracket="]", comma=comma, children=children)

    # ------------------------------------------------------------------ #
    # HTML fragments
    # ------------------------------------------------------------------ #
    def _render_branch(self, *, prefix: str, open_bracket: str, close_bracket: str, comma: str, children: str) -> str:
        # The collapsed preview ("… }") is hidden by CSS while expanded and
        # shown in place of the children + closing-bracket row when collapsed.
        preview = f'<span class="json-preview"> … {close_bracket}{comma}</span>'
        return (
            '<li class="json-node json-branch">'
            '<div class="json-row">'
            '<button type="button" class="json-toggle" aria-expanded="true" aria-label="Collapse">-</button>'
            f'<span class="json-content">{prefix}{open_bracket}{preview}</span>'
            "</div>"
            f'<ul class="json-children">{children}</ul>'
            '<div class="json-row json-close-row">'
            '<span class="json-toggle-spacer" aria-hidden="true"></span>'
            f'<span class="json-content">{close_bracket}{comma}</span>'
            "</div>"
            "</li>"
        )

    def _render_leaf(self, content: str) -> str:
        return (
            '<li class="json-node json-leaf">'
            '<div class="json-row">'
            '<span class="json-toggle-spacer" aria-hidden="true"></span>'
            f'<span class="json-content">{content}</span>'
            "</div>"
            "</li>"
        )

    def _error_html(self, text: str, message: str) -> str:
        return (
            '<div class="json-view">'
            f'<p class="json-error">Invalid JSON: {html.escape(message)}</p>'
            f'<pre class="json-raw">{html.escape(text)}</pre>'
            "</div>"
        )

    # ------------------------------------------------------------------ #
    # Token formatting
    # ------------------------------------------------------------------ #
    def _format_key(self, key: object) -> str:
        token = html.escape(json.dumps(key, ensure_ascii=False), quote=False)
        return f'<span class="json-key">{token}</span>'

    def _format_scalar(self, value: object) -> str:
        token = html.escape(json.dumps(value, ensure_ascii=False), quote=False)
        return f'<span class="{self._scalar_class(value)}">{token}</span>'

    @staticmethod
    def _scalar_class(value: object) -> str:
        if value is None:
            return "json-null"
        if isinstance(value, bool):
            return "json-boolean"
        if isinstance(value, str):
            return "json-string"
        return "json-number"
