"""Standalone mermaid structure write-back collaborator (Phase 2: add node / add edge).

Synthesizes a new node / edge **source line** for a single mermaid block, dispatching on the
diagram type (``flowchart`` / ``er`` / ``class`` / ``state``). Unlike maxGraph (which mutates an
XML model with stable ids and geometry), mermaid is text-to-SVG with auto-layout, so adding a
node / edge is appending a source line and letting mermaid re-layout. The per-type synthesized
forms were verified to render on the bundled mermaid 11.15.0 before being locked in:

* add node (id ``New_<n>``, label "New"):
    - flowchart  : ``<id>["New"]``
    - er         : ``<id>["New"]``      (renders a visible entity box, recoverable id entity-<id>)
    - class      : ``class <id>["New"]``
    - state      : ``<id> : New``       (a description line that both declares and labels the state)
* add edge (source ``S``, target ``T``):
    - flowchart / class / state : ``S --> T``   (a bare connector; titled later via the edge editor)
    - er                        : ``S }o--o{ T : ""``  (er needs a cardinality + label token)

The concern is pure and stateless: every operation is a deterministic function of its string
arguments, so the no-arg form (``MermaidStructureRewriter()``) is fully usable in isolation. The
two label formatters it reuses (``_format_mermaid_label`` from the node-title cluster and the raw
edge-label formatter) are injected as optional callables that default to behaviour-identical
internal implementations, mirroring ``MermaidNodeTitleRewriter``.

``DiagramPreprocessor`` composes one of these and forwards ``_add_mermaid_block_node`` /
``_add_mermaid_block_edge`` / ``_generate_mermaid_node_id`` to it via thin delegating shims, so the
render pipeline and ``WritebackService`` keep calling the same names on the ``DiagramPreprocessor``
instance.
"""

from __future__ import annotations

import re
from collections.abc import Callable

from .mermaid_edge_title_rewriter import (
    MERMAID_CLASS_RELATION_RE,
    MERMAID_ER_RELATION_RE,
    MERMAID_FLOWCHART_LINK_RE,
    MERMAID_FLOWCHART_SHAPE_PATTERN,
    MERMAID_STATE_TRANSITION_RE,
)

# Label / quoted regions whose inner text must be ignored when looking for a structural node-id
# reference on a line (so `B` inside `A["go to B"]` is not treated as an edge to `B`). Ordered so the
# outer bracket forms consume any quotes they wrap. `{...}` is the *balanced* inline form (a flowchart
# decision node); an unbalanced `{` that opens an entity/class/composite-state body is left intact so
# the body can be removed through its matching close brace.
_MERMAID_LABEL_REGION_RES = tuple(
    re.compile(pattern)
    for pattern in (r'"[^"]*"', r"\[[^\]]*\]", r"\([^)]*\)", r"\{[^{}]*\}", r"\|[^|]*\|")
)

# Per-type one-relationship-per-line grammar reused from the edge-title rewriter for edge deletion.
_MERMAID_RELATION_RE_BY_TYPE = {
    "er": MERMAID_ER_RELATION_RE,
    "class": MERMAID_CLASS_RELATION_RE,
    "state": MERMAID_STATE_TRANSITION_RE,
}


# The node-bearing diagram types whose structure (nodes / edges) this collaborator can synthesize;
# the same set the title rewriters edit. Other types (sequence, gantt, pie, ...) are unsupported.
MERMAID_STRUCTURE_DIAGRAM_TYPES = ("flowchart", "er", "class", "state")

# Header line scaffolded when the first node is added to an empty (or whitespace-only) block —
# the mermaid analog of the maxGraph empty-block `mxGraphModel` scaffold. The browser's empty-canvas
# preview substitutes the same `flowchart TD` header, so preview and first-persisted state agree.
_MERMAID_HEADER_BY_TYPE = {
    "flowchart": "flowchart TD",
    "er": "erDiagram",
    "class": "classDiagram",
    "state": "stateDiagram-v2",
}


class MermaidStructureRewriter:
    """Mermaid add-node / add-edge source synthesis as a collaborator.

    Pure and stateless. The only dependencies are the two label formatters reused from the
    node/edge-title clusters, supplied as optional callables that default to behaviour-identical
    internal implementations so the no-arg form stands alone in isolation.
    """

    def __init__(
        self,
        format_label: Callable[[str], str] | None = None,
        format_edge_label_raw: Callable[[str], str] | None = None,
    ) -> None:
        self._format_mermaid_label = format_label or self._default_format_label
        self._format_edge_label_raw = (
            format_edge_label_raw or self._default_format_edge_label_raw
        )

    # ------------------------------------------------------------------ #
    # Unique node id generation
    # ------------------------------------------------------------------ #
    def _generate_mermaid_node_id(self, block_text: str) -> str:
        """Smallest ``New_<n>`` (n >= 1) not already present in ``block_text`` as a whole token.

        The source is the only reliable uniqueness scope: the client only sees rendered node ids,
        which can miss an id present in source but not rendered.
        """
        text = block_text or ""
        index = 1
        while re.search(rf"(?<![\w-])New_{index}(?![\w-])", text):
            index += 1
        return f"New_{index}"

    # ------------------------------------------------------------------ #
    # Add node
    # ------------------------------------------------------------------ #
    def _add_mermaid_block_node(
        self, block_text: str, diagram_type: str, node_id: str, title: str = "New"
    ) -> str:
        if diagram_type not in MERMAID_STRUCTURE_DIAGRAM_TYPES:
            raise ValueError(f"Unsupported mermaid diagram type: {diagram_type!r}")
        if not node_id:
            raise ValueError("mermaid node id is required")
        declaration = self._node_declaration(diagram_type, node_id, title)
        if not block_text.strip():
            # First node on an empty block: scaffold the diagram-type header so the block becomes
            # a valid diagram (the empty-canvas rule; mirrors the maxGraph empty-block scaffold).
            return f"{_MERMAID_HEADER_BY_TYPE[diagram_type]}\n  {declaration}\n"
        return self._append_block_line(block_text, declaration)

    def _node_declaration(self, diagram_type: str, node_id: str, title: str) -> str:
        if diagram_type == "state":
            # A description line `<id> : <text>` both declares and labels the state (raw, unquoted).
            return f"{node_id} : {self._format_edge_label_raw(title)}"
        label = self._format_mermaid_label(title)  # quoted, e.g. "New"
        if diagram_type == "class":
            return f"class {node_id}[{label}]"
        # flowchart and er both take a `<id>["label"]` declaration that renders a labeled box.
        return f"{node_id}[{label}]"

    # ------------------------------------------------------------------ #
    # Add edge
    # ------------------------------------------------------------------ #
    def _add_mermaid_block_edge(
        self, block_text: str, diagram_type: str, source: str, target: str
    ) -> str:
        if diagram_type not in MERMAID_STRUCTURE_DIAGRAM_TYPES:
            raise ValueError(f"Unsupported mermaid diagram type: {diagram_type!r}")
        if not source or not target:
            raise ValueError("mermaid edge requires a source and a target node")
        if source == target:
            raise ValueError("mermaid edge cannot be a self-loop")
        if not block_text.strip():
            # An empty block has no node declarations, so an edge line alone would not render;
            # the first element must be a node (which scaffolds the header).
            raise ValueError("cannot add an edge to an empty mermaid block")
        if diagram_type == "er":
            # er syntactically requires a cardinality and a label token; the default is a
            # zero-or-many to zero-or-many relationship with an empty, editable label.
            line = f'{source} }}o--o{{ {target} : ""'
        else:
            # flowchart / class / state: a bare connector the author can title via the edge editor.
            line = f"{source} --> {target}"
        return self._append_block_line(block_text, line)

    # ------------------------------------------------------------------ #
    # Delete node(s) (with incident-edge cascade)
    # ------------------------------------------------------------------ #
    def _mask_label_regions(self, text: str) -> str:
        """Replace the inner content of label / quoted regions with same-length filler, so a node id
        that appears only inside a label is not mistaken for a structural reference. Delimiters and
        line length are preserved; an unbalanced ``{`` (a block opener) is left intact."""
        masked = text
        for region in _MERMAID_LABEL_REGION_RES:
            masked = region.sub(
                lambda m: m.group(0)[0] + ("x" * (len(m.group(0)) - 2)) + m.group(0)[-1], masked
            )
        return masked

    def _delete_mermaid_block_nodes(
        self, block_text: str, diagram_type: str, node_ids: list[str]
    ) -> str:
        if diagram_type not in MERMAID_STRUCTURE_DIAGRAM_TYPES:
            raise ValueError(f"Unsupported mermaid diagram type: {diagram_type!r}")
        ids = [node_id for node_id in node_ids if node_id]
        if not ids:
            raise ValueError("mermaid node ids are required")
        patterns = [re.compile(rf"(?<![\w-]){re.escape(node_id)}(?![\w-])") for node_id in ids]

        lines = block_text.splitlines(keepends=True)
        kept: list[str] = []
        index = 0
        total = len(lines)
        while index < total:
            masked = self._mask_label_regions(lines[index].rstrip("\r\n"))
            # The first content line is the diagram-type declaration and is never removed.
            references = index != 0 and any(pattern.search(masked) for pattern in patterns)
            if not references:
                kept.append(lines[index])
                index += 1
                continue
            # A removed line that opens an unbalanced `{` body (entity / class / composite state) is
            # dropped through its matching close brace.
            depth = masked.count("{") - masked.count("}")
            index += 1
            while depth > 0 and index < total:
                body = self._mask_label_regions(lines[index].rstrip("\r\n"))
                depth += body.count("{") - body.count("}")
                index += 1
        remaining = "".join(kept)
        if diagram_type == "class" and not "".join(kept[1:]).strip():
            # Bundled mermaid 11.15.0 cannot parse a bare `classDiagram` header (the other
            # node-bearing headers are valid alone), so deleting the last class node must leave
            # the minimal renderable zero-node form — the default direction, no visual change —
            # rather than persist a block the renderer cannot parse.
            return self._append_block_line(remaining, "direction TB")
        return remaining

    # ------------------------------------------------------------------ #
    # Delete edge (reusing the edge-title per-type location grammar)
    # ------------------------------------------------------------------ #
    def _delete_mermaid_block_edge(
        self,
        block_text: str,
        diagram_type: str,
        source: str,
        target: str,
        occurrence: int,
        edge_index: int,
    ) -> str:
        if diagram_type == "flowchart":
            return self._delete_flowchart_edge(block_text, source, target, occurrence)
        relation_re = _MERMAID_RELATION_RE_BY_TYPE.get(diagram_type)
        if relation_re is None:
            raise ValueError(f"Unsupported mermaid diagram type: {diagram_type!r}")
        return self._delete_relation_line(block_text, relation_re, edge_index)

    @staticmethod
    def _delete_relation_line(block_text: str, relation_re: re.Pattern[str], edge_index: int) -> str:
        lines = block_text.splitlines(keepends=True)
        count = 0
        for line_index, raw_line in enumerate(lines):
            if relation_re.match(raw_line.rstrip("\r\n")) is None:
                continue
            if count == edge_index:
                del lines[line_index]
                return "".join(lines)
            count += 1
        raise ValueError("mermaid edge not found for the requested index")

    @staticmethod
    def _delete_flowchart_edge(block_text: str, source: str, target: str, occurrence: int) -> str:
        if not source or not target:
            raise ValueError("flowchart edge endpoints are required")
        link_finder = re.compile(
            rf"(?<![\w-]){re.escape(source)}(?:{MERMAID_FLOWCHART_SHAPE_PATTERN})?"
            rf"(?P<link>[^\n]*?){re.escape(target)}(?:{MERMAID_FLOWCHART_SHAPE_PATTERN})?(?![\w-])"
        )
        count = 0
        for match in link_finder.finditer(block_text):
            if MERMAID_FLOWCHART_LINK_RE.match(match.group("link")) is None:
                continue
            if count == occurrence:
                start = block_text.rfind("\n", 0, match.start()) + 1
                end = block_text.find("\n", match.end())
                end = len(block_text) if end == -1 else end + 1
                return block_text[:start] + block_text[end:]
            count += 1
        raise ValueError("flowchart edge not found for the requested endpoints")

    # ------------------------------------------------------------------ #
    # Shared append
    # ------------------------------------------------------------------ #
    def _append_block_line(self, block_text: str, line: str) -> str:
        # Append on its own two-space-indented line, ensuring the prior block content ends with a
        # newline first (mirrors the title rewriters' append convention).
        suffix = "" if block_text.endswith("\n") else "\n"
        return f"{block_text}{suffix}  {line}\n"

    # ------------------------------------------------------------------ #
    # Default label formatters (DiagramPreprocessor injects its own)
    # ------------------------------------------------------------------ #
    def _default_format_label(self, title: str) -> str:
        # Behaviour-identical to MermaidNodeTitleRewriter._format_mermaid_label.
        normalized = title.replace("\r\n", "\n").replace("\r", "\n").replace("\n", "<br>")
        return '"' + normalized.replace('"', "#quot;") + '"'

    def _default_format_edge_label_raw(self, title: str) -> str:
        # Behaviour-identical to DiagramPreprocessor._format_mermaid_edge_label_raw.
        return title.replace("\r\n", "\n").replace("\r", "\n").replace("\n", "<br>").strip()
