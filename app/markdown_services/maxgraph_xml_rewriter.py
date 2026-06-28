"""Standalone maxGraph XML write-back / serialization collaborator.

This concern was formerly inlined on ``DiagramPreprocessor``: rewriting a single
maxGraph block's XML text in place — moving a vertex's geometry (``x``/``y``),
relabelling a vertex (the ``value`` attribute), and relabelling an edge — plus the
low-level XML helpers those rewrites need (parsing the ``mxGraphModel`` / ``mxfile``
root, setting/inserting a tag attribute, escaping an attribute value, and
formatting a coordinate float).

The concern is pure and stateless: every operation is a deterministic function of
its string / numeric arguments. It owns **no** preprocessor or renderer state, so
it is built and unit-tested without ever constructing a ``DiagramPreprocessor``, a
``WritebackService``, or a ``MarkdownRenderer`` — the constructor takes no
dependencies at all.

``DiagramPreprocessor`` composes one of these and forwards the public/internal
maxGraph write-back surface (``_update_maxgraph_block_node_position``,
``_update_maxgraph_block_node_title``, ``_update_maxgraph_block_edge_title``) to it
via thin delegating shims, so the render pipeline and ``WritebackService`` keep
calling the same names on the ``DiagramPreprocessor`` instance.
"""

from __future__ import annotations

import html
import re
from xml.etree import ElementTree

# Node-title sizing metric. Kept in lock-step with the browser renderer's
# ``MAXGRAPH_NODE_LABEL_CHAR_WIDTH`` / ``MAXGRAPH_NODE_LABEL_HORIZONTAL_PADDING``
# (app/static/max-graph-constants.js) so the width persisted here matches how the
# browser wraps the title. ``MAX_WIDTH - HORIZONTAL_PADDING`` is the max content
# width (340), which is also the renderer's hard-wrap threshold for an unbreakable
# token.
MAXGRAPH_NODE_LABEL_CHAR_WIDTH = 7
MAXGRAPH_NODE_LABEL_HORIZONTAL_PADDING = 20
MAXGRAPH_NODE_MIN_WIDTH = 90
MAXGRAPH_NODE_MAX_WIDTH = 360
MAXGRAPH_NODE_FIXED_HEIGHT = 60


class MaxGraphXmlRewriter:
    """maxGraph block XML write-back and serialization as a collaborator.

    Pure and stateless: holds no preprocessor or renderer state and takes no
    constructor dependencies, so the collaborator is fully constructable and
    unit-testable in isolation (``MaxGraphXmlRewriter()`` — no
    ``DiagramPreprocessor``, no ``WritebackService``, no ``MarkdownRenderer``).
    """

    # ------------------------------------------------------------------ #
    # maxGraph write-back rewrites
    # ------------------------------------------------------------------ #
    def _update_maxgraph_block_node_position(self, block_text: str, node_id: str, x: float, y: float) -> str:
        root = self._parse_maxgraph_model(block_text)
        target_cell = next(
            (
                cell
                for cell in root.iter("mxCell")
                if cell.get("id") == node_id and cell.get("vertex") == "1" and cell.find("mxGeometry") is not None
            ),
            None,
        )
        if target_cell is None:
            raise ValueError("maxGraph vertex geometry not found for requested node")

        escaped_node_id = re.escape(node_id)
        cell_pattern = re.compile(
            rf"<mxCell\b(?=[^>]*\bid\s*=\s*([\"']){escaped_node_id}\1)"
            rf"(?=[^>]*\bvertex\s*=\s*([\"'])1\2)[^>]*>.*?</mxCell>",
            re.DOTALL,
        )
        cell_match = cell_pattern.search(block_text)
        if cell_match is None:
            raise ValueError("maxGraph vertex cell not found in source")

        cell_text = cell_match.group(0)
        geometry_pattern = re.compile(r"<mxGeometry\b[^>]*/?>", re.DOTALL)
        geometry_match = geometry_pattern.search(cell_text)
        if geometry_match is None:
            raise ValueError("maxGraph vertex geometry not found in source")

        updated_geometry = self._set_xml_attribute(geometry_match.group(0), "x", self._format_maxgraph_coordinate(x))
        updated_geometry = self._set_xml_attribute(updated_geometry, "y", self._format_maxgraph_coordinate(y))
        updated_cell_text = (
            cell_text[: geometry_match.start()] + updated_geometry + cell_text[geometry_match.end() :]
        )
        return block_text[: cell_match.start()] + updated_cell_text + block_text[cell_match.end() :]

    def _update_maxgraph_block_node_title(self, block_text: str, node_id: str, title: str) -> str:
        root = self._parse_maxgraph_model(block_text)
        target_cell = next(
            (
                cell
                for cell in root.iter("mxCell")
                if cell.get("id") == node_id and cell.get("vertex") == "1"
            ),
            None,
        )
        if target_cell is None:
            raise ValueError("maxGraph vertex not found for requested node")

        escaped_node_id = re.escape(node_id)
        cell_pattern = re.compile(
            rf"<mxCell\b(?=[^>]*\bid\s*=\s*([\"']){escaped_node_id}\1)"
            rf"(?=[^>]*\bvertex\s*=\s*([\"'])1\2)[^>]*(?:/>|>.*?</mxCell>)",
            re.DOTALL,
        )
        cell_match = cell_pattern.search(block_text)
        if cell_match is None:
            raise ValueError("maxGraph vertex cell not found in source")

        cell_text = cell_match.group(0)
        opening_tag_match = re.match(r"<mxCell\b[^>]*>", cell_text, re.DOTALL)
        if opening_tag_match is None:
            raise ValueError("maxGraph vertex cell not found in source")

        updated_opening_tag = self._set_xml_attribute(
            opening_tag_match.group(0),
            "value",
            self._escape_xml_attribute(title),
        )
        updated_cell_text = (
            updated_opening_tag + cell_text[opening_tag_match.end() :]
        )
        updated_cell_text = self._resize_vertex_geometry_to_title(updated_cell_text, title)
        return block_text[: cell_match.start()] + updated_cell_text + block_text[cell_match.end() :]

    def _resize_vertex_geometry_to_title(self, cell_text: str, title: str) -> str:
        """Auto-fit the vertex box to its title: width clamped to [90, 360] from the
        title's widest line, height fixed at 60. Title-derived, so undo (which replays
        the previous title) restores the matching size. Best-effort: a vertex cell with
        no ``<mxGeometry>`` (e.g. self-closing) is left at its title-only update."""
        geometry_match = re.search(r"<mxGeometry\b[^>]*/?>", cell_text, re.DOTALL)
        if geometry_match is None:
            return cell_text

        resized = self._set_xml_attribute(
            geometry_match.group(0),
            "width",
            self._format_maxgraph_coordinate(self._compute_maxgraph_node_title_width(title)),
        )
        resized = self._set_xml_attribute(
            resized, "height", self._format_maxgraph_coordinate(MAXGRAPH_NODE_FIXED_HEIGHT)
        )
        return cell_text[: geometry_match.start()] + resized + cell_text[geometry_match.end() :]

    def _compute_maxgraph_node_title_width(self, title: str) -> int:
        """Node width that fits ``title`` with as few wraps as possible, clamped to
        [90, 360]. Sized from the widest newline-separated line (not the concatenation)
        so author-inserted breaks are honored; clamping to the cap means a title too
        wide for one line at the cap wraps rather than growing the box further."""
        normalized = title.replace("\r\n", "\n").replace("\r", "\n")
        widest = max((len(line) for line in normalized.split("\n")), default=0)
        desired = widest * MAXGRAPH_NODE_LABEL_CHAR_WIDTH + MAXGRAPH_NODE_LABEL_HORIZONTAL_PADDING
        return min(max(desired, MAXGRAPH_NODE_MIN_WIDTH), MAXGRAPH_NODE_MAX_WIDTH)

    def _update_maxgraph_block_edge_title(self, block_text: str, edge_id: str, title: str) -> str:
        root = self._parse_maxgraph_model(block_text)
        target_cell = next(
            (
                cell
                for cell in root.iter("mxCell")
                if cell.get("id") == edge_id and cell.get("edge") == "1"
            ),
            None,
        )
        if target_cell is None:
            raise ValueError("maxGraph edge not found for requested title")

        escaped_edge_id = re.escape(edge_id)
        cell_pattern = re.compile(
            rf"<mxCell\b(?=[^>]*\bid\s*=\s*([\"']){escaped_edge_id}\1)"
            rf"(?=[^>]*\bedge\s*=\s*([\"'])1\2)[^>]*(?:/>|>.*?</mxCell>)",
            re.DOTALL,
        )
        cell_match = cell_pattern.search(block_text)
        if cell_match is None:
            raise ValueError("maxGraph edge cell not found in source")

        cell_text = cell_match.group(0)
        opening_tag_match = re.match(r"<mxCell\b[^>]*>", cell_text, re.DOTALL)
        if opening_tag_match is None:
            raise ValueError("maxGraph edge cell not found in source")

        updated_opening_tag = self._set_xml_attribute(
            opening_tag_match.group(0),
            "value",
            self._escape_xml_attribute(title),
        )
        updated_cell_text = (
            updated_opening_tag + cell_text[opening_tag_match.end() :]
        )
        return block_text[: cell_match.start()] + updated_cell_text + block_text[cell_match.end() :]

    # ------------------------------------------------------------------ #
    # maxGraph add / delete (create / undo)
    # ------------------------------------------------------------------ #
    def _add_maxgraph_block_node(
        self,
        block_text: str,
        node_id: str,
        title: str,
        x: float,
        y: float,
        width: float = 120,
        height: float = 60,
    ) -> str:
        if not node_id:
            raise ValueError("maxGraph node id is required")

        def build_cell(cell_indent: str, child_indent: str, newline: str) -> str:
            geometry = (
                f'<mxGeometry x="{self._format_maxgraph_coordinate(x)}" '
                f'y="{self._format_maxgraph_coordinate(y)}" '
                f'width="{self._format_maxgraph_coordinate(width)}" '
                f'height="{self._format_maxgraph_coordinate(height)}" as="geometry" />'
            )
            return (
                f'{cell_indent}<mxCell id="{node_id}" value="{self._escape_xml_attribute(title)}" '
                f'vertex="1" parent="1">{newline}'
                f"{child_indent}{geometry}{newline}"
                f"{cell_indent}</mxCell>"
            )

        # An empty / whitespace-only block has no model to insert into (it renders as an empty
        # canvas): scaffold a fresh pretty-printed mxGraphModel with the standard id="0"/id="1"
        # layer cells holding this first vertex, so the result parses and renders.
        if not block_text.strip():
            cell = build_cell("    ", "      ", "\n")
            return (
                "<mxGraphModel>\n"
                "  <root>\n"
                '    <mxCell id="0" />\n'
                '    <mxCell id="1" parent="0" />\n'
                f"{cell}\n"
                "  </root>\n"
                "</mxGraphModel>"
            )

        root = self._parse_maxgraph_model(block_text)
        if node_id in self._existing_cell_ids(root):
            raise ValueError("maxGraph cell id already exists")

        return self._insert_cell_before_root_close(block_text, build_cell)

    def _add_maxgraph_block_edge(
        self,
        block_text: str,
        edge_id: str,
        title: str,
        source_id: str,
        target_id: str,
    ) -> str:
        root = self._parse_maxgraph_model(block_text)
        if not edge_id:
            raise ValueError("maxGraph edge id is required")
        if edge_id in self._existing_cell_ids(root):
            raise ValueError("maxGraph cell id already exists")
        if not source_id or not target_id:
            raise ValueError("maxGraph edge requires a source and a target node")
        if source_id == target_id:
            raise ValueError("maxGraph edge source and target must differ")
        vertex_ids = self._existing_vertex_ids(root)
        if source_id not in vertex_ids or target_id not in vertex_ids:
            raise ValueError("maxGraph edge source/target must be existing vertices")

        def build_cell(cell_indent: str, child_indent: str, newline: str) -> str:
            # The right-angle (orthogonal) connector style: the renderer routes a cell whose
            # style has ``edgeStyle=orthogonalEdgeStyle`` with 90° segments instead of a
            # straight line.
            return (
                f'{cell_indent}<mxCell id="{edge_id}" value="{self._escape_xml_attribute(title)}" '
                f'style="edgeStyle=orthogonalEdgeStyle;" '
                f'edge="1" parent="1" source="{source_id}" target="{target_id}">{newline}'
                f'{child_indent}<mxGeometry relative="1" as="geometry" />{newline}'
                f"{cell_indent}</mxCell>"
            )

        return self._insert_cell_before_root_close(block_text, build_cell)

    def _delete_maxgraph_block_node(self, block_text: str, node_id: str) -> str:
        # Remove the vertex, then cascade-remove every edge connected to it, so deleting a node
        # never leaves a dangling edge (source/target pointing at a now-missing vertex). The
        # vertex is deleted first, so a missing node raises before any edge is touched. The undo
        # of an add reaches this with a freshly added, edgeless node (its edges, added later, are
        # already undone in LIFO order), so the cascade is then a no-op and the round-trip holds.
        root = self._parse_maxgraph_model(block_text)
        linked_edge_ids = self._linked_edge_ids(root, node_id)
        updated = self._delete_cell(block_text, node_id, "vertex", "maxGraph vertex not found")
        for edge_id in linked_edge_ids:
            updated = self._delete_cell(updated, edge_id, "edge", "maxGraph edge not found")
        return updated

    def _delete_maxgraph_block_nodes(self, block_text: str, node_ids: list[str]) -> str:
        # Group delete: remove every listed vertex and cascade-remove every edge connected to any
        # of them, so no dangling edge is left. The union of linked edges is deduped (order
        # preserved) so an edge whose BOTH endpoints are selected is removed exactly once rather
        # than double-deleted (which would raise on the second pass). Vertices are deleted first, so
        # a missing vertex raises before any edge is touched; the caller (_rewrite_maxgraph_block)
        # only writes the file when this returns, so a partial group delete never persists.
        root = self._parse_maxgraph_model(block_text)
        linked_edge_ids: list[str] = []
        seen_edge_ids: set[str] = set()
        for node_id in node_ids:
            for edge_id in self._linked_edge_ids(root, node_id):
                if edge_id not in seen_edge_ids:
                    seen_edge_ids.add(edge_id)
                    linked_edge_ids.append(edge_id)
        updated = block_text
        for node_id in node_ids:
            updated = self._delete_cell(updated, node_id, "vertex", "maxGraph vertex not found")
        for edge_id in linked_edge_ids:
            updated = self._delete_cell(updated, edge_id, "edge", "maxGraph edge not found")
        return updated

    def _linked_edge_ids(self, root: ElementTree.Element, node_id: str) -> list[str]:
        return [
            cell.get("id")
            for cell in root.iter("mxCell")
            if cell.get("id")
            and cell.get("edge") == "1"
            and node_id in (cell.get("source"), cell.get("target"))
        ]

    def _delete_maxgraph_block_edge(self, block_text: str, edge_id: str) -> str:
        return self._delete_cell(block_text, edge_id, "edge", "maxGraph edge not found")

    def _replace_maxgraph_block(self, new_block_text: str) -> str:
        """Replace a whole maxGraph block with a caller-supplied snapshot (used to undo a
        delete). The snapshot is validated to parse as an ``mxGraphModel`` (or an ``mxfile``
        wrapping one) before it is accepted, then returned verbatim so the block is restored
        exactly — node and its cascaded edges included."""
        self._parse_maxgraph_model(new_block_text)
        return new_block_text

    def _delete_cell(self, block_text: str, cell_id: str, kind: str, missing_message: str) -> str:
        escaped_id = re.escape(cell_id)
        cell_pattern = re.compile(
            rf"<mxCell\b(?=[^>]*\bid\s*=\s*([\"']){escaped_id}\1)"
            rf"(?=[^>]*\b{kind}\s*=\s*([\"'])1\2)[^>]*(?:/>|>.*?</mxCell>)",
            re.DOTALL,
        )
        cell_match = cell_pattern.search(block_text)
        if cell_match is None:
            raise ValueError(missing_message)

        start, end = cell_match.start(), cell_match.end()
        line_start = block_text.rfind("\n", 0, start) + 1
        before = block_text[line_start:start]
        trailing = re.match(r"[ \t]*(?:\r\n|\n)", block_text[end:])
        if before.strip() == "" and trailing is not None:
            # The cell occupies its own (indented) line: drop the leading indentation and the
            # one trailing newline too, so deleting a freshly added cell restores the block
            # byte-for-byte (pretty-printed XML).
            return block_text[:line_start] + block_text[end + trailing.end() :]
        # Inline / minified: remove exactly the cell, leaving its siblings on the line intact.
        return block_text[:start] + block_text[end:]

    def _insert_cell_before_root_close(self, block_text: str, build_cell) -> str:
        # Insert immediately before the model's </root>. The same surgical-string approach the
        # other rewrites use, so the rest of the block (formatting included) is preserved.
        close_index = block_text.rfind("</root>")
        if close_index == -1:
            raise ValueError("maxGraph <root> close not found")

        line_start = block_text.rfind("\n", 0, close_index) + 1
        line_prefix = block_text[line_start:close_index]
        if line_prefix.strip() == "":
            # Pretty-printed: </root> sits on its own (indented) line; add an indented,
            # multi-line cell as a new sibling line above it.
            cell_indent = line_prefix + "  "
            child_indent = cell_indent + "  "
            newline = "\r\n" if "\r\n" in block_text else "\n"
            cell_text = build_cell(cell_indent, child_indent, newline)
            return block_text[:line_start] + cell_text + newline + block_text[line_start:]
        # Minified / inline: insert a compact (single-line) cell right before </root>.
        cell_text = build_cell("", "", "")
        return block_text[:close_index] + cell_text + block_text[close_index:]

    def _existing_cell_ids(self, root: ElementTree.Element) -> set[str]:
        return {cell.get("id") for cell in root.iter("mxCell") if cell.get("id")}

    def _existing_vertex_ids(self, root: ElementTree.Element) -> set[str]:
        return {
            cell.get("id")
            for cell in root.iter("mxCell")
            if cell.get("id") and cell.get("vertex") == "1"
        }

    # ------------------------------------------------------------------ #
    # maxGraph XML helpers
    # ------------------------------------------------------------------ #
    def _parse_maxgraph_model(self, block_text: str) -> ElementTree.Element:
        try:
            root = ElementTree.fromstring(block_text)
        except ElementTree.ParseError as exc:
            raise ValueError("Invalid maxGraph XML") from exc
        if root.tag == "mxGraphModel":
            return root
        if root.tag == "mxfile" and root.find(".//mxGraphModel") is not None:
            return root
        raise ValueError("Expected mxGraphModel XML")

    def _set_xml_attribute(self, tag_text: str, name: str, value: str) -> str:
        attr_pattern = re.compile(rf"(\s{name}\s*=\s*)([\"'])(.*?)(\2)", re.DOTALL)
        if attr_pattern.search(tag_text):
            return attr_pattern.sub(
                lambda match: f"{match.group(1)}{match.group(2)}{value}{match.group(4)}",
                tag_text,
                count=1,
            )

        insert_at = tag_text.rfind("/>") if tag_text.rstrip().endswith("/>") else tag_text.rfind(">")
        if insert_at == -1:
            raise ValueError("Invalid maxGraph geometry source")
        return f'{tag_text[:insert_at]} {name}="{value}"{tag_text[insert_at:]}'

    def _escape_xml_attribute(self, value: str) -> str:
        return (
            html.escape(value, quote=True)
            .replace("\r\n", "&#10;")
            .replace("\r", "&#10;")
            .replace("\n", "&#10;")
        )

    def _format_maxgraph_coordinate(self, value: float) -> str:
        return f"{value:g}"
