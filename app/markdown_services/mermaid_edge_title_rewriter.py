"""Standalone mermaid edge-title write-back collaborator.

This concern was formerly inlined on ``DiagramPreprocessor``: rewriting a single
mermaid block's text so an *edge* (relationship / transition / flowchart link)
carries a new label. It dispatches on the diagram type
(``flowchart`` / ``er`` / ``class`` / ``state``) to the matching per-type label
setter, preserving whatever link shape / cardinality the source already uses and
refusing rather than corrupting the source when the edge cannot be located.

The concern is pure and stateless: every operation is a deterministic function of
its string arguments. It owns **no** renderer or preprocessor state, so it is
built and unit-tested without ever constructing a ``DiagramPreprocessor``, a
``WritebackService``, or a ``MarkdownRenderer`` — the no-arg form
(``MermaidEdgeTitleRewriter()``) is fully usable in isolation.

It reaches for two sibling helpers, both supplied as injected callables so the
collaborator never depends on ``DiagramPreprocessor``:

* ``format_mermaid_label`` — the mermaid node-title label formatter
  (newlines to ``<br>``, double quotes to the mermaid ``#quot;`` entity, wrapped
  in quotes). Used for flowchart pipe labels and er relationship labels. It lives
  on :class:`~app.markdown_services.mermaid_node_title_rewriter.MermaidNodeTitleRewriter`;
  ``DiagramPreprocessor`` injects that instance's method so there is one source of
  truth. When omitted a behaviour-identical internal default is used.
* ``format_edge_label_raw`` — the raw edge-label formatter (newlines to ``<br>``,
  trimmed). This deliberately STAYS on ``DiagramPreprocessor`` (it is also
  injected into ``MermaidNodeTitleRewriter``); injecting it here as a callable
  rather than depending on the preprocessor avoids a circular dependency. When
  omitted a behaviour-identical internal default is used.

``DiagramPreprocessor`` composes one of these and forwards
``_update_mermaid_block_edge_title`` to it via a thin delegating shim (so the
render pipeline, ``WritebackService``, and the edge-title tests keep calling the
same name on the ``DiagramPreprocessor`` instance), injecting its own label
formatters so the formatting path stays a single source of truth.
"""

from __future__ import annotations

import re
from collections.abc import Callable


# A single flowchart node shape, used to skip a node's label when locating the link between two
# nodes (so dashes/targets inside a label are not mistaken for the connector).
MERMAID_FLOWCHART_SHAPE_PATTERN = (
    r"(?:\[\[.*?\]\]|\(\(.*?\)\)|\(\[.*?\]\)|\[\(.*?\)\]|\{\{.*?\}\}"
    r"|\[/.*?[/\\]\]|\[\\.*?[/\\]\]|\[.*?\]|\(.*?\)|\{.*?\}|>.*?\])"
)

# Strict grammar for a single flowchart link (the text captured between two node references). It
# matches either an inline-labelled link (`-- text -->`), or a bare operator optionally followed by
# a `|label|` pipe. Anything else (e.g. a region containing `&` or an intervening node) fails to
# match, so the edge rewrite refuses rather than corrupting the source.
MERMAID_FLOWCHART_LINK_RE = re.compile(
    r"^\s*(?:"
    r"(?P<open>--+|==+|-\.)\s*(?P<text>\S(?:.*?\S)?|\S)\s*(?P<close>[-.=]{2,}[->ox]?)"
    r"|(?P<bare>[<ox]?[-.=]{2,}[->ox]?)"
    r")(?:\|(?P<pipe>[^|]*)\|)?\s*$"
)

# An erDiagram relationship line: `LEFT <card>--<card> RIGHT : label`. The label after the colon is
# replaced; `head`/`trail` preserve the surrounding text and whitespace.
MERMAID_ER_RELATION_RE = re.compile(
    r"^(?P<head>\s*[A-Za-z0-9_-]+\s*[|}{o]+(?:--|\.\.)[|}{o]+\s+[A-Za-z0-9_-]+\s*:\s*)"
    r"(?P<label>.*?)(?P<trail>\s*)$"
)

# A classDiagram relationship line: two class names joined by a relation operator, optionally with
# cardinality strings and a `: label`. Member lines like `Animal : +int age` do not match because
# they lack a relation operator between two names.
MERMAID_CLASS_RELATION_RE = re.compile(
    r"^\s*[\w~]+(?:\s+\"[^\"]*\")?\s*[<>|o*.\-]{2,}\s*(?:\"[^\"]*\"\s+)?[\w~]+"
    r"\s*(?::\s*(?P<label>.*?))?\s*$"
)

# A stateDiagram transition line: `SRC --> TGT` with an optional `: label`. SRC/TGT are a state id
# or the `[*]` start/end marker; state transitions only ever use `-->`. A self-loop (`X --> X`)
# matches too: it is non-editable from the browser, but it still consumes an ordinal in mermaid's
# `edge<N>` numbering, so counting it keeps the backend ordinal aligned with what the browser sends.
MERMAID_STATE_TRANSITION_RE = re.compile(
    r"^\s*(?:\[\*\]|[\w-]+)\s*-->\s*(?:\[\*\]|[\w-]+)\s*(?::\s*(?P<label>.*?))?\s*$"
)


class MermaidEdgeTitleRewriter:
    """Mermaid edge-title (label) write-back as a collaborator.

    Pure and stateless: holds no renderer or preprocessor state. Its only
    dependencies are the two label formatters, supplied as optional callables
    that default to behaviour-identical internal implementations, so the no-arg
    form (``MermaidEdgeTitleRewriter()``) is fully usable in isolation.
    """

    def __init__(
        self,
        format_mermaid_label: Callable[[str], str] | None = None,
        format_edge_label_raw: Callable[[str], str] | None = None,
    ) -> None:
        # The node-title label formatter (flowchart pipe labels, er relationship
        # labels) lives on MermaidNodeTitleRewriter. It is pure, so an injected
        # reference and the internal default behave identically; DiagramPreprocessor
        # injects that instance's method so there is one source of truth, while the
        # no-arg form stays dependency-free in isolation.
        self._format_mermaid_label = (
            format_mermaid_label or self._default_format_mermaid_label
        )
        # The raw edge-label formatter STAYS on DiagramPreprocessor (it is also
        # injected into MermaidNodeTitleRewriter). It is pure, so an injected
        # reference and the internal default behave identically; injecting it as a
        # callable here rather than depending on the preprocessor avoids a circular
        # dependency.
        self._format_edge_label_raw = (
            format_edge_label_raw or self._default_format_edge_label_raw
        )

    # ------------------------------------------------------------------ #
    # Mermaid edge-title write-back
    # ------------------------------------------------------------------ #
    def _update_mermaid_block_edge_title(
        self,
        block_text: str,
        diagram_type: str,
        source: str,
        target: str,
        occurrence: int,
        edge_index: int,
        title: str,
    ) -> str:
        if diagram_type == "flowchart":
            return self._set_flowchart_edge_label(block_text, source, target, occurrence, title)
        if diagram_type == "er":
            return self._set_er_relationship_label(block_text, edge_index, title)
        if diagram_type == "class":
            return self._set_class_relationship_label(block_text, edge_index, title)
        if diagram_type == "state":
            return self._set_state_transition_label(block_text, edge_index, title)
        raise ValueError(f"Unsupported mermaid diagram type: {diagram_type!r}")

    def _format_mermaid_edge_label_raw(self, title: str) -> str:
        return self._format_edge_label_raw(title)

    def _set_flowchart_edge_label(
        self, block_text: str, source: str, target: str, occurrence: int, title: str
    ) -> str:
        if not source or not target:
            raise ValueError("flowchart edge endpoints are required")

        link_finder = re.compile(
            rf"(?<![\w-]){re.escape(source)}(?:{MERMAID_FLOWCHART_SHAPE_PATTERN})?"
            rf"(?P<link>[^\n]*?){re.escape(target)}(?:{MERMAID_FLOWCHART_SHAPE_PATTERN})?(?![\w-])"
        )

        count = 0
        for match in link_finder.finditer(block_text):
            link_region = match.group("link")
            parsed = MERMAID_FLOWCHART_LINK_RE.match(link_region)
            if parsed is None:
                continue
            if count == occurrence:
                new_link = self._rewrite_flowchart_link(link_region, parsed, title)
                return block_text[: match.start("link")] + new_link + block_text[match.end("link") :]
            count += 1

        raise ValueError("flowchart edge not found for the requested endpoints")

    def _rewrite_flowchart_link(self, region: str, parsed: re.Match[str], title: str) -> str:
        if parsed.group("pipe") is not None:
            formatted = self._format_mermaid_label(title)
            return re.sub(r"\|[^|]*\|", f"|{formatted}|", region, count=1)

        lead = region[: len(region) - len(region.lstrip())]
        trail = region[len(region.rstrip()) :]
        if parsed.group("text") is not None:
            raw = self._format_edge_label_raw(title)
            return f"{lead}{parsed.group('open')} {raw} {parsed.group('close')}{trail}"

        formatted = self._format_mermaid_label(title)
        return f"{lead}{region.strip()}|{formatted}|{trail}"

    def _set_er_relationship_label(self, block_text: str, edge_index: int, title: str) -> str:
        lines = block_text.splitlines(keepends=True)
        count = 0
        for line_index, raw_line in enumerate(lines):
            text = raw_line.rstrip("\r\n")
            ending = raw_line[len(text) :]
            match = MERMAID_ER_RELATION_RE.match(text)
            if match is None:
                continue
            if count == edge_index:
                formatted = self._format_mermaid_label(title)
                lines[line_index] = f"{match.group('head')}{formatted}{match.group('trail')}{ending}"
                return "".join(lines)
            count += 1

        raise ValueError("erDiagram relationship not found for the requested index")

    def _set_class_relationship_label(self, block_text: str, edge_index: int, title: str) -> str:
        lines = block_text.splitlines(keepends=True)
        count = 0
        for line_index, raw_line in enumerate(lines):
            text = raw_line.rstrip("\r\n")
            ending = raw_line[len(text) :]
            match = MERMAID_CLASS_RELATION_RE.match(text)
            if match is None:
                continue
            if count == edge_index:
                raw_label = self._format_edge_label_raw(title)
                if match.group("label") is not None:
                    lines[line_index] = f"{text[: match.start('label')]}{raw_label}{ending}"
                else:
                    lines[line_index] = f"{text.rstrip()} : {raw_label}{ending}"
                return "".join(lines)
            count += 1

        raise ValueError("classDiagram relationship not found for the requested index")

    def _set_state_transition_label(self, block_text: str, edge_index: int, title: str) -> str:
        lines = block_text.splitlines(keepends=True)
        count = 0
        for line_index, raw_line in enumerate(lines):
            text = raw_line.rstrip("\r\n")
            ending = raw_line[len(text) :]
            match = MERMAID_STATE_TRANSITION_RE.match(text)
            if match is None:
                continue
            if count == edge_index:
                raw_label = self._format_edge_label_raw(title)
                if match.group("label") is not None:
                    lines[line_index] = f"{text[: match.start('label')]}{raw_label}{ending}"
                else:
                    lines[line_index] = f"{text.rstrip()} : {raw_label}{ending}"
                return "".join(lines)
            count += 1

        raise ValueError("stateDiagram transition not found for the requested index")

    # ------------------------------------------------------------------ #
    # Default label formatters (used only when none are injected, so the no-arg
    # form stands alone in isolation; DiagramPreprocessor injects its own).
    # ------------------------------------------------------------------ #
    def _default_format_mermaid_label(self, title: str) -> str:
        # Behaviour-identical to MermaidNodeTitleRewriter._format_mermaid_label:
        # newlines -> <br>, then literal double quotes written as the mermaid
        # #quot; entity, wrapped in quotes.
        normalized = title.replace("\r\n", "\n").replace("\r", "\n").replace("\n", "<br>")
        return '"' + normalized.replace('"', "#quot;") + '"'

    def _default_format_edge_label_raw(self, title: str) -> str:
        # Behaviour-identical to DiagramPreprocessor._format_mermaid_edge_label_raw.
        return title.replace("\r\n", "\n").replace("\r", "\n").replace("\n", "<br>").strip()
