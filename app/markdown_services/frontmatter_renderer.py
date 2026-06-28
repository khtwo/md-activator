"""Render a leading YAML *front matter* block as an HTML key/value table.

A Markdown document may open with a metadata block delimited by a ``---`` line
at the very start of the file and a closing ``---`` line, e.g.::

    ---
    ticket: TKT-0001
    status: open
    ---

    # Title

``FrontMatterRenderer`` detects that block and renders it as a two-column
key/value table — the way GitHub.com and the built-in VS Code preview show it —
instead of letting plain Markdown turn it into a visible paragraph wrapped in
stray ``<hr>`` rules (Python-Markdown) or a setext ``<h2>`` (CommonMark).

The block is removed from the Markdown body by **blanking it in place**: every
front-matter line (both ``---`` delimiters and the content between them) is
replaced by an empty line, so the body keeps its exact 1-based line numbers.
That preservation is essential — checkbox / code-block write-back and mermaid /
maxGraph anchors all map rendered elements back to absolute file line numbers
(``data-checkbox-line`` etc.), so shifting the body would silently corrupt those
edits. Blanking also keeps front-matter text (e.g. a ``[x]`` inside a value) out
of the Markdown body, where it would otherwise be mis-parsed as a control marker.

Like :class:`~app.markdown_services.yaml_tree_renderer.YamlTreeRenderer`, this is
deliberately a *line* renderer, not a YAML parser: it never imports a YAML
library, never validates, and degrades gracefully — a document that does not
start with ``---``, or whose opening ``---`` has no closing ``---``, or whose
block has no content lines, is reported as having no front matter and is left
untouched. Values keep their original text; only HTML-escaping is applied.

The collaborator is pure and stateless, so ``MarkdownRenderer`` composes a single
shared instance and calls :meth:`split` once per Markdown render, prepending the
returned table HTML to the rendered body.
"""

from __future__ import annotations

import html
from dataclasses import dataclass, field

_DELIMITER = "---"


@dataclass
class FrontMatterSplit:
    """Outcome of separating front matter from the Markdown body.

    ``table_html`` is the rendered table (``""`` when there is no front matter),
    ``body`` is the Markdown body with the block blanked in place (line count and
    positions preserved), and ``present`` flags whether a block was found.
    """

    table_html: str
    body: str
    present: bool


@dataclass
class _FmNode:
    indent: int
    key: str
    value: str
    children: list["_FmNode"] = field(default_factory=list)


class FrontMatterRenderer:
    """Detect leading ``---`` front matter and render it as an HTML table."""

    def split(self, text: str) -> FrontMatterSplit:
        lines = text.split("\n")
        closing = self._closing_index(lines)
        if closing is None:
            return FrontMatterSplit(table_html="", body=text, present=False)

        nodes = self._build_nodes(lines[1:closing])
        if not nodes:
            # Delimiters with no content lines: leave the document untouched
            # rather than silently swallowing the bare ``---`` rules.
            return FrontMatterSplit(table_html="", body=text, present=False)

        blanked = list(lines)
        for index in range(closing + 1):
            blanked[index] = ""
        return FrontMatterSplit(
            table_html=self._render_table(nodes),
            body="\n".join(blanked),
            present=True,
        )

    # ------------------------------------------------------------------ #
    # Detection
    # ------------------------------------------------------------------ #
    def _closing_index(self, lines: list[str]) -> int | None:
        if not lines or lines[0].strip() != _DELIMITER:
            return None
        for index in range(1, len(lines)):
            if lines[index].strip() == _DELIMITER:
                return index
        return None

    # ------------------------------------------------------------------ #
    # Line-based parsing (no YAML library)
    # ------------------------------------------------------------------ #
    def _build_nodes(self, content: list[str]) -> list[_FmNode]:
        roots: list[_FmNode] = []
        stack: list[_FmNode] = []

        for raw_line in content:
            if raw_line.strip() == "":
                continue
            indent = len(raw_line) - len(raw_line.lstrip(" "))
            key, value = self._split_key_value(raw_line.strip())
            # Attach under the nearest preceding line with strictly smaller
            # indentation; pop equal-or-deeper open ancestors first.
            while stack and stack[-1].indent >= indent:
                stack.pop()
            node = _FmNode(indent=indent, key=key, value=value)
            (stack[-1].children if stack else roots).append(node)
            stack.append(node)

        return roots

    def _split_key_value(self, stripped: str) -> tuple[str, str]:
        # Sequence items ("- item") carry no key; keep the text as the value.
        if stripped == "-":
            return "", ""
        if stripped.startswith("- "):
            return "", stripped[2:].strip()
        key, separator, value = stripped.partition(":")
        if not separator:
            return stripped, ""
        return key.strip(), value.strip()

    # ------------------------------------------------------------------ #
    # HTML rendering
    # ------------------------------------------------------------------ #
    def _render_table(self, nodes: list[_FmNode]) -> str:
        rows = "".join(self._render_row(node) for node in nodes)
        return f'<table class="markdown-table front-matter-table"><tbody>{rows}</tbody></table>'

    def _render_row(self, node: _FmNode) -> str:
        key_html = html.escape(node.key)
        value_html = html.escape(node.value)
        if node.children:
            nested = self._render_table(node.children)
            value_html = f"{value_html}{nested}" if value_html else nested
        return f"<tr><th>{key_html}</th><td>{value_html}</td></tr>"
