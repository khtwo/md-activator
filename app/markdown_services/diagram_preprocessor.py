"""Standalone mermaid / maxGraph diagram-block collaborator.

``DiagramPreprocessor`` owns the diagram-block concern that formerly lived on
``DiagramBlockMixin`` (shared ``self`` with ``MarkdownRenderer``): scanning a
markdown source for mermaid and maxGraph blocks, wrapping them in the render-time
HTML envelopes (``data-mermaid-line`` / ``data-maxgraph-line`` etc.), and the
write-back rewrites that edit a single block's text in place (node / edge titles
and node geometry).

The concern is pure and stateless: every operation is a deterministic function of
its string / block arguments. It owns **no** renderer state, so it is built and
unit-tested without ever constructing a ``MarkdownRenderer``.

The one collaborator it needs is the fence / diagram-info utility set
(``_is_maxgraph_info``, ``_find_closing_fence``, ``_maxgraph_style_mode``) that
already lives on the standalone
:class:`~app.markdown_services.code_block_extractor.CodeBlockExtractor`. That
extractor is injected here and handed to ``MaxGraphBlockPreparation`` (the only
collaborator that scans fences); when omitted a fresh, dependency-free
``CodeBlockExtractor`` is constructed, so the no-arg form
(``DiagramPreprocessor()``) is fully usable in isolation.

``MarkdownRenderer`` composes one of these (sharing its single
``CodeBlockExtractor``) and the render pipeline calls it directly via
``self._diagram_preprocessor`` (the former ``DiagramBlockMixin`` shim layer has
been removed). The ``WritebackService`` collaborator holds its own reference to
the same instance for the write-back rewrites, so the per-render orchestration
and write-back callers share one source of truth.
"""

from __future__ import annotations

from .code_block_extractor import CodeBlockExtractor
from .maxgraph_block_preparation import MaxGraphBlockPreparation
from .maxgraph_xml_rewriter import MaxGraphXmlRewriter
from .mermaid_block_preparation import MermaidBlockPreparation
from .mermaid_edge_title_rewriter import MermaidEdgeTitleRewriter
from .mermaid_node_title_rewriter import MermaidNodeTitleRewriter
from .mermaid_structure_rewriter import MermaidStructureRewriter


class DiagramPreprocessor:
    """Mermaid / maxGraph block scanning, preparation, and write-back as a collaborator.

    Pure and stateless: holds no renderer state. The only dependency is the
    fence / diagram-info utility set, supplied as a
    :class:`~app.markdown_services.code_block_extractor.CodeBlockExtractor`. It
    defaults to a fresh, dependency-free instance so the collaborator is usable
    in isolation (``DiagramPreprocessor()``); ``MarkdownRenderer`` injects its
    shared extractor so the single source of truth is preserved.
    """

    def __init__(self, code_block_extractor: CodeBlockExtractor | None = None) -> None:
        # The fence/diagram-info helpers (_is_maxgraph_info, _find_closing_fence,
        # _maxgraph_style_mode) live on the editable-code-block collaborator and are
        # used by MaxGraphBlockPreparation below. They are pure, so an injected
        # instance and a default one behave identically; the renderer injects its
        # shared instance to keep one source of truth.
        self._code_block_extractor = code_block_extractor or CodeBlockExtractor()
        # The mermaid block scanning / preparation cluster is a pure, stateless
        # concern with no dependency on this preprocessor; it lives on its own
        # collaborator and the mermaid-scanning surface below forwards to it.
        self._mermaid_block_preparation = MermaidBlockPreparation()
        # The maxGraph block scanning / preparation cluster is likewise a pure,
        # stateless concern; it lives on its own collaborator and reaches the
        # fence/diagram-info helpers through the shared CodeBlockExtractor injected
        # above. The maxGraph-scanning surface below forwards to it.
        self._maxgraph_block_preparation = MaxGraphBlockPreparation(self._code_block_extractor)
        # The mermaid node-title write-back cluster (node label rewrites + label
        # formatting) is a pure, stateless concern with no dependency on this
        # preprocessor; it lives on its own collaborator. The node-title surface
        # below forwards to it. Its state path reuses _format_mermaid_edge_label_raw,
        # which stays here (the edge-title cluster still owns it), so that exact
        # callable is injected to keep one source of truth.
        self._mermaid_node_title_rewriter = MermaidNodeTitleRewriter(
            self._format_mermaid_edge_label_raw
        )
        # The mermaid edge-title write-back cluster (flowchart / er / class / state
        # link-label rewrites) is a pure, stateless concern with no dependency on
        # this preprocessor; it lives on its own collaborator. The edge-title
        # surface below forwards to it. It reuses the node-title label formatter
        # (_format_mermaid_label, on MermaidNodeTitleRewriter) and the raw edge-label
        # formatter (_format_mermaid_edge_label_raw, which STAYS here to avoid a
        # circular dependency), so both are injected as callables to keep one source
        # of truth.
        self._mermaid_edge_title_rewriter = MermaidEdgeTitleRewriter(
            self._mermaid_node_title_rewriter._format_mermaid_label,
            self._format_mermaid_edge_label_raw,
        )
        # The mermaid structure write-back cluster (add node / add edge source synthesis) is a
        # pure, stateless concern; it lives on its own collaborator and reuses the same two label
        # formatters (injected to keep one source of truth). The structure surface below forwards
        # to it.
        self._mermaid_structure_rewriter = MermaidStructureRewriter(
            self._mermaid_node_title_rewriter._format_mermaid_label,
            self._format_mermaid_edge_label_raw,
        )
        # The maxGraph XML write-back cluster (node geometry / node + edge title
        # rewrites and the low-level XML serialization helpers) is a pure, stateless
        # concern with no dependency on this preprocessor; it lives on its own
        # collaborator with no constructor dependencies. The maxGraph write-back
        # surface below forwards to it.
        self._maxgraph_xml_rewriter = MaxGraphXmlRewriter()

    # ------------------------------------------------------------------ #
    # Mermaid block scanning / preparation (delegated to MermaidBlockPreparation)
    # ------------------------------------------------------------------ #
    def _iter_mermaid_blocks(self, lines: list[str]):
        """Forward to the mermaid block-preparation collaborator. Preserved on this
        instance because the render orchestration and ``WritebackService`` call it here."""
        return self._mermaid_block_preparation._iter_mermaid_blocks(lines)

    def _prepare_mermaid_blocks(self, source: str, original_source: str | None = None) -> str:
        """Forward to the mermaid block-preparation collaborator. Preserved on this
        instance because the render pipeline calls it here."""
        return self._mermaid_block_preparation._prepare_mermaid_blocks(source, original_source)

    # ------------------------------------------------------------------ #
    # maxGraph block scanning / preparation (delegated to MaxGraphBlockPreparation)
    # ------------------------------------------------------------------ #
    def _prepare_maxgraph_blocks(self, source: str, original_source: str | None = None) -> str:
        """Forward to the maxGraph block-preparation collaborator. Preserved on this
        instance because the render pipeline calls it here."""
        return self._maxgraph_block_preparation._prepare_maxgraph_blocks(source, original_source)

    def _iter_maxgraph_blocks(self, lines: list[str]):
        """Forward to the maxGraph block-preparation collaborator. Preserved on this
        instance because ``WritebackService`` calls it here (source-toggle read/update)."""
        return self._maxgraph_block_preparation._iter_maxgraph_blocks(lines)

    # ------------------------------------------------------------------ #
    # maxGraph write-back rewrites (delegated to MaxGraphXmlRewriter)
    # ------------------------------------------------------------------ #
    def _update_maxgraph_block_node_position(self, block_text: str, node_id: str, x: float, y: float) -> str:
        """Forward to the maxGraph XML rewriter collaborator. Preserved on this
        instance because the render pipeline, ``WritebackService``, and the
        position-editing tests call it here."""
        return self._maxgraph_xml_rewriter._update_maxgraph_block_node_position(
            block_text, node_id, x, y
        )

    def _update_maxgraph_block_node_title(self, block_text: str, node_id: str, title: str) -> str:
        """Forward to the maxGraph XML rewriter collaborator. Preserved on this
        instance because the render pipeline, ``WritebackService``, and the
        title-editing tests call it here."""
        return self._maxgraph_xml_rewriter._update_maxgraph_block_node_title(
            block_text, node_id, title
        )

    def _update_maxgraph_block_edge_title(self, block_text: str, edge_id: str, title: str) -> str:
        """Forward to the maxGraph XML rewriter collaborator. Preserved on this
        instance because the render pipeline, ``WritebackService``, and the
        edge-title-editing tests call it here."""
        return self._maxgraph_xml_rewriter._update_maxgraph_block_edge_title(
            block_text, edge_id, title
        )

    def _add_maxgraph_block_node(
        self, block_text: str, node_id: str, title: str, x: float, y: float
    ) -> str:
        """Forward to the maxGraph XML rewriter collaborator (add a vertex)."""
        return self._maxgraph_xml_rewriter._add_maxgraph_block_node(
            block_text, node_id, title, x, y
        )

    def _add_maxgraph_block_edge(
        self, block_text: str, edge_id: str, title: str, source_id: str, target_id: str
    ) -> str:
        """Forward to the maxGraph XML rewriter collaborator (add an edge)."""
        return self._maxgraph_xml_rewriter._add_maxgraph_block_edge(
            block_text, edge_id, title, source_id, target_id
        )

    def _delete_maxgraph_block_node(self, block_text: str, node_id: str) -> str:
        """Forward to the maxGraph XML rewriter collaborator (delete a vertex)."""
        return self._maxgraph_xml_rewriter._delete_maxgraph_block_node(block_text, node_id)

    def _delete_maxgraph_block_nodes(self, block_text: str, node_ids: list[str]) -> str:
        """Forward to the maxGraph XML rewriter collaborator (delete a group of vertices)."""
        return self._maxgraph_xml_rewriter._delete_maxgraph_block_nodes(block_text, node_ids)

    def _delete_maxgraph_block_edge(self, block_text: str, edge_id: str) -> str:
        """Forward to the maxGraph XML rewriter collaborator (delete an edge)."""
        return self._maxgraph_xml_rewriter._delete_maxgraph_block_edge(block_text, edge_id)

    def _replace_maxgraph_block(self, new_block_text: str) -> str:
        """Forward to the maxGraph XML rewriter collaborator (validate + return a block snapshot)."""
        return self._maxgraph_xml_rewriter._replace_maxgraph_block(new_block_text)

    # ------------------------------------------------------------------ #
    # Mermaid node-title write-back (delegated to MermaidNodeTitleRewriter)
    # ------------------------------------------------------------------ #
    def _update_mermaid_block_node_title(
        self, block_text: str, diagram_type: str, node_id: str, title: str
    ) -> str:
        """Forward to the mermaid node-title rewriter collaborator. Preserved on this
        instance because the render pipeline, ``WritebackService``, and the
        title-editing tests call it here."""
        return self._mermaid_node_title_rewriter._update_mermaid_block_node_title(
            block_text, diagram_type, node_id, title
        )

    # ------------------------------------------------------------------ #
    # Mermaid edge-title write-back (delegated to MermaidEdgeTitleRewriter)
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
        """Forward to the mermaid edge-title rewriter collaborator. Preserved on this
        instance because the render pipeline, ``WritebackService``, and the
        edge-title-editing tests call it here."""
        return self._mermaid_edge_title_rewriter._update_mermaid_block_edge_title(
            block_text, diagram_type, source, target, occurrence, edge_index, title
        )

    # ------------------------------------------------------------------ #
    # Mermaid structure write-back (delegated to MermaidStructureRewriter)
    # ------------------------------------------------------------------ #
    def _generate_mermaid_node_id(self, block_text: str) -> str:
        """Forward to the mermaid structure rewriter collaborator (unique New_<n> id)."""
        return self._mermaid_structure_rewriter._generate_mermaid_node_id(block_text)

    def _add_mermaid_block_node(
        self, block_text: str, diagram_type: str, node_id: str, title: str = "New"
    ) -> str:
        """Forward to the mermaid structure rewriter collaborator (append a node declaration)."""
        return self._mermaid_structure_rewriter._add_mermaid_block_node(
            block_text, diagram_type, node_id, title
        )

    def _add_mermaid_block_edge(
        self, block_text: str, diagram_type: str, source: str, target: str
    ) -> str:
        """Forward to the mermaid structure rewriter collaborator (append an edge line)."""
        return self._mermaid_structure_rewriter._add_mermaid_block_edge(
            block_text, diagram_type, source, target
        )

    def _delete_mermaid_block_nodes(
        self, block_text: str, diagram_type: str, node_ids: list[str]
    ) -> str:
        """Forward to the mermaid structure rewriter collaborator (delete nodes + cascade edges)."""
        return self._mermaid_structure_rewriter._delete_mermaid_block_nodes(
            block_text, diagram_type, node_ids
        )

    def _delete_mermaid_block_edge(
        self,
        block_text: str,
        diagram_type: str,
        source: str,
        target: str,
        occurrence: int,
        edge_index: int,
    ) -> str:
        """Forward to the mermaid structure rewriter collaborator (delete one edge)."""
        return self._mermaid_structure_rewriter._delete_mermaid_block_edge(
            block_text, diagram_type, source, target, occurrence, edge_index
        )

    def _format_mermaid_edge_label_raw(self, title: str) -> str:
        # Stays here (the edge-title cluster's raw formatter) rather than moving to
        # MermaidEdgeTitleRewriter: it is the single source of truth injected into
        # both MermaidNodeTitleRewriter and MermaidEdgeTitleRewriter, so keeping it
        # here avoids a circular dependency between those two collaborators.
        return title.replace("\r\n", "\n").replace("\r", "\n").replace("\n", "<br>").strip()
