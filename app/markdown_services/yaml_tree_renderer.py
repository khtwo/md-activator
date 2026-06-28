"""Collapsible indentation-tree renderer for ``.yml`` / ``.yaml`` files.

``YamlTreeRenderer`` turns raw YAML text into a nested ``<ul>`` tree where every
line that has at least one deeper-indented (non-blank) descendant becomes a
collapsible branch with a ``+``/``-`` toggle, and every other line is a leaf.

It is deliberately a *line/indentation* renderer, not a YAML parser: the file is
never parsed, validated, or reformatted, so comments, key ordering, and original
formatting survive exactly as written, and content that is not valid YAML still
renders as its indentation tree instead of raising. This keeps the viewer
dependency-free (no YAML library) and matches the requested behaviour — a
``+``/``-`` mark on lines with children, all nodes expanded by default.

The collaborator is pure and stateless: it owns no renderer state and has no
root dependency, so ``MarkdownRenderer`` composes a single shared instance and
dispatches ``.yml`` / ``.yaml`` renders to :meth:`render`.
"""

from __future__ import annotations

import html
from dataclasses import dataclass, field


@dataclass
class _YamlNode:
    indent: int
    content: str
    blank: bool = False
    children: list["_YamlNode"] = field(default_factory=list)

    @property
    def has_children(self) -> bool:
        return any(not child.blank for child in self.children)


class YamlTreeRenderer:
    """Render YAML text as a collapsible indentation tree (HTML)."""

    EMPTY_HTML = '<div class="yaml-view"><p class="yaml-empty">Empty YAML file.</p></div>'

    def render(self, text: str) -> str:
        roots = self._build_tree(text)
        # Empty or whitespace-only input yields no content lines (only blank
        # nodes, if any) — render the empty state instead of a tree of blanks.
        if not any(not node.blank for node in roots):
            return self.EMPTY_HTML
        body = "".join(self._render_node(node) for node in roots)
        return f'<div class="yaml-view"><ul class="yaml-tree">{body}</ul></div>'

    # ------------------------------------------------------------------ #
    # Tree construction
    # ------------------------------------------------------------------ #
    def _build_tree(self, text: str) -> list[_YamlNode]:
        roots: list[_YamlNode] = []
        stack: list[_YamlNode] = []
        pending_blanks: list[_YamlNode] = []

        for raw_line in text.splitlines():
            if raw_line.strip() == "":
                pending_blanks.append(_YamlNode(indent=0, content="", blank=True))
                continue

            indent = len(raw_line) - len(raw_line.lstrip(" "))
            # A line attaches under the nearest preceding line with strictly
            # smaller indentation; pop equal-or-deeper open ancestors first.
            while stack and stack[-1].indent >= indent:
                stack.pop()

            target = stack[-1].children if stack else roots
            # Flush blank lines into the block we are continuing, so a blank line
            # between two siblings keeps them siblings instead of breaking the run.
            target.extend(pending_blanks)
            pending_blanks = []

            node = _YamlNode(indent=indent, content=raw_line.strip())
            target.append(node)
            stack.append(node)

        # Trailing blank lines belong at the document (root) level.
        roots.extend(pending_blanks)
        return roots

    # ------------------------------------------------------------------ #
    # HTML rendering
    # ------------------------------------------------------------------ #
    def _render_node(self, node: _YamlNode) -> str:
        if node.blank:
            return (
                '<li class="yaml-node yaml-blank" aria-hidden="true">'
                '<div class="yaml-row"><span class="yaml-content"></span></div></li>'
            )

        content = html.escape(node.content)
        if node.has_children:
            children_html = "".join(self._render_node(child) for child in node.children)
            return (
                '<li class="yaml-node yaml-branch">'
                '<div class="yaml-row">'
                '<button type="button" class="yaml-toggle" aria-expanded="true" aria-label="Collapse">-</button>'
                f'<span class="yaml-content">{content}</span>'
                "</div>"
                f'<ul class="yaml-children">{children_html}</ul>'
                "</li>"
            )

        return (
            '<li class="yaml-node yaml-leaf">'
            '<div class="yaml-row">'
            '<span class="yaml-toggle-spacer" aria-hidden="true"></span>'
            f'<span class="yaml-content">{content}</span>'
            "</div>"
            "</li>"
        )
