"""Standalone mermaid node-title write-back collaborator.

This concern was formerly inlined on ``DiagramPreprocessor``: rewriting a single
mermaid block's text so a node carries a new title / label. It dispatches on the
diagram type (``flowchart`` / ``er`` / ``class`` / ``state``) to the matching
per-type label setter, formats the label (newlines to ``<br>``, double quotes to
the mermaid ``#quot;`` entity), and preserves whatever node shape the source
already uses.

The concern is pure and stateless: every operation is a deterministic function of
its string arguments. It owns **no** renderer or preprocessor state, so it is
built and unit-tested without ever constructing a ``DiagramPreprocessor``, a
``WritebackService``, or a ``MarkdownRenderer`` — the no-arg form
(``MermaidNodeTitleRewriter()``) is fully usable in isolation.

The one helper the state path needs is the raw edge-label formatter
(``_format_mermaid_edge_label_raw``), which deliberately STAYS on
``DiagramPreprocessor`` (the edge-title cluster still uses it). It is pure and
stateless, so it is supplied as an injected callable; when omitted an internal,
behaviour-identical implementation is used, keeping the collaborator
dependency-free in isolation.

``DiagramPreprocessor`` composes one of these and forwards
``_update_mermaid_block_node_title`` to it via a thin delegating shim (so the
render pipeline, ``WritebackService``, and the title-editing tests keep calling
the same name on the ``DiagramPreprocessor`` instance), injecting its own
``_format_mermaid_edge_label_raw`` so the state path stays a single source of
truth.
"""

from __future__ import annotations

import re
from collections.abc import Callable


# Flowchart node shape delimiter pairs, ordered so multi-character openers are tried before the
# single-character ones they share a prefix with. The label-set logic preserves whichever shape a
# node already uses; ties at the same match start prefer the longer opener (e.g. `[[` over `[`).
MERMAID_FLOWCHART_SHAPES = (
    ("([", ")]"),
    ("[[", "]]"),
    ("[(", ")]"),
    ("((", "))"),
    ("[/", "/]"),
    ("[/", "\\]"),
    ("[\\", "\\]"),
    ("[\\", "/]"),
    ("{{", "}}"),
    ("[", "]"),
    ("(", ")"),
    ("{", "}"),
    (">", "]"),
)


class MermaidNodeTitleRewriter:
    """Mermaid node-title (label) write-back as a collaborator.

    Pure and stateless: holds no renderer or preprocessor state. The only
    dependency is the raw edge-label formatter the state path reuses, supplied as
    an optional callable that defaults to a behaviour-identical internal
    implementation, so the no-arg form (``MermaidNodeTitleRewriter()``) is fully
    usable in isolation.
    """

    def __init__(
        self, format_edge_label_raw: Callable[[str], str] | None = None
    ) -> None:
        # The state path reuses the raw edge-label formatter that lives on
        # DiagramPreprocessor (where the edge-title cluster still owns it). It is
        # pure, so an injected reference and the internal default behave
        # identically; DiagramPreprocessor injects its own so there is one source
        # of truth, while the no-arg form stays dependency-free in isolation.
        self._format_edge_label_raw = (
            format_edge_label_raw or self._default_format_edge_label_raw
        )

    # ------------------------------------------------------------------ #
    # Mermaid node-title write-back
    # ------------------------------------------------------------------ #
    def _update_mermaid_block_node_title(
        self, block_text: str, diagram_type: str, node_id: str, title: str
    ) -> str:
        if not node_id:
            raise ValueError("mermaid node id is required")
        if diagram_type == "flowchart":
            return self._set_flowchart_node_label(block_text, node_id, title)
        if diagram_type == "er":
            return self._set_er_entity_label(block_text, node_id, title)
        if diagram_type == "class":
            return self._set_class_node_label(block_text, node_id, title)
        if diagram_type == "state":
            return self._set_state_node_label(block_text, node_id, title)
        raise ValueError(f"Unsupported mermaid diagram type: {diagram_type!r}")

    def _format_mermaid_label(self, title: str) -> str:
        # Mermaid line breaks use <br>; a quoted label keeps brackets, spaces, and punctuation
        # parseable. Literal double quotes are written as the mermaid #quot; entity.
        normalized = title.replace("\r\n", "\n").replace("\r", "\n").replace("\n", "<br>")
        return '"' + normalized.replace('"', "#quot;") + '"'

    def _set_flowchart_node_label(self, block_text: str, node_id: str, title: str) -> str:
        formatted = self._format_mermaid_label(title)
        escaped_id = re.escape(node_id)

        best: tuple[int, str, re.Match[str]] | None = None
        for open_delim, close_delim in MERMAID_FLOWCHART_SHAPES:
            pattern = re.compile(
                rf'(?<![\w\-])({escaped_id})({re.escape(open_delim)})("[^"]*"|.*?)({re.escape(close_delim)})',
                re.DOTALL,
            )
            match = pattern.search(block_text)
            if match is None:
                continue
            if best is None or match.start() < best[0] or (
                match.start() == best[0] and len(open_delim) > len(best[1])
            ):
                best = (match.start(), open_delim, match)

        if best is not None:
            match = best[2]
            replacement = f"{match.group(1)}{match.group(2)}{formatted}{match.group(4)}"
            return block_text[: match.start()] + replacement + block_text[match.end() :]

        bare = re.compile(rf"(?<![\w\-])({escaped_id})(?![\w\-])")
        match = bare.search(block_text)
        if match is None:
            raise ValueError("flowchart node not found for requested title")
        return block_text[: match.start()] + f"{match.group(1)}[{formatted}]" + block_text[match.end() :]

    def _set_er_entity_label(self, block_text: str, node_id: str, title: str) -> str:
        formatted = self._format_mermaid_label(title)
        escaped_id = re.escape(node_id)

        alias = re.compile(rf'(?<![\w\-])({escaped_id})\[(?:"[^"]*"|[^\]]*)\]')
        match = alias.search(block_text)
        if match is not None:
            return block_text[: match.start()] + f"{match.group(1)}[{formatted}]" + block_text[match.end() :]

        header = re.compile(rf"(?<![\w\-])({escaped_id})(\s*)(\{{)")
        match = header.search(block_text)
        if match is not None:
            replacement = f"{match.group(1)}[{formatted}]{match.group(2)}{{"
            return block_text[: match.start()] + replacement + block_text[match.end() :]

        token = re.compile(rf"(?<![\w\-])({escaped_id})(?![\w\-\[])")
        match = token.search(block_text)
        if match is None:
            raise ValueError("erDiagram entity not found for requested title")
        return block_text[: match.start()] + f"{match.group(1)}[{formatted}]" + block_text[match.end() :]

    def _set_class_node_label(self, block_text: str, node_id: str, title: str) -> str:
        formatted = self._format_mermaid_label(title)
        escaped_id = re.escape(node_id)

        alias = re.compile(rf'(\bclass\s+{escaped_id})\[(?:"[^"]*"|[^\]]*)\]')
        match = alias.search(block_text)
        if match is not None:
            return block_text[: match.start()] + f"{match.group(1)}[{formatted}]" + block_text[match.end() :]

        declaration = re.compile(rf"(\bclass\s+{escaped_id})(?![\w\-\[])")
        match = declaration.search(block_text)
        if match is not None:
            return block_text[: match.start()] + f"{match.group(1)}[{formatted}]" + block_text[match.end() :]

        token = re.compile(rf"(?<![\w\-]){escaped_id}(?![\w\-])")
        if token.search(block_text) is None:
            raise ValueError("classDiagram class not found for requested title")

        suffix = "" if block_text.endswith("\n") else "\n"
        return f"{block_text}{suffix}  class {node_id}[{formatted}]\n"

    def _set_state_node_label(self, block_text: str, node_id: str, title: str) -> str:
        if not node_id:
            raise ValueError("stateDiagram state id is required")
        escaped_id = re.escape(node_id)

        # 1. Existing quoted alias `state "..." as <id>`: replace the quoted token (quotes kept).
        alias = re.compile(rf'\bstate\s+("(?:[^"]*)")\s+as\s+{escaped_id}(?![\w-])')
        match = alias.search(block_text)
        if match is not None:
            formatted = self._format_mermaid_label(title)
            return block_text[: match.start(1)] + formatted + block_text[match.end(1) :]

        raw = self._format_edge_label_raw(title)

        # 2. Existing description line `<id> : <text>`. A transition (`<id> --> ... : ...`) never
        #    matches because `-->` sits between the id and the colon.
        description = re.compile(
            rf"(?m)^(?P<head>[ \t]*{escaped_id}(?![\w-])[ \t]*:[ \t]*)(?P<label>.*?)(?P<trail>[ \t]*)$"
        )
        match = description.search(block_text)
        if match is not None:
            return block_text[: match.start("label")] + raw + block_text[match.end("label") :]

        # 3. The state shows its bare id; append a description line. Require the id to appear first.
        token = re.compile(rf"(?<![\w-]){escaped_id}(?![\w-])")
        if token.search(block_text) is None:
            raise ValueError("stateDiagram state not found for requested title")
        suffix = "" if block_text.endswith("\n") else "\n"
        return f"{block_text}{suffix}  {node_id} : {raw}\n"

    # ------------------------------------------------------------------ #
    # Raw edge-label formatter (default; DiagramPreprocessor injects its own)
    # ------------------------------------------------------------------ #
    def _default_format_edge_label_raw(self, title: str) -> str:
        # Behaviour-identical to DiagramPreprocessor._format_mermaid_edge_label_raw; used only
        # when no formatter is injected so the no-arg state path stands alone in isolation.
        return title.replace("\r\n", "\n").replace("\r", "\n").replace("\n", "<br>").strip()
