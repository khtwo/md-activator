"""Standalone maxGraph block scanning / preparation collaborator.

This concern was formerly inlined on ``DiagramPreprocessor``: scanning a markdown
source for maxGraph blocks (``` ```maxGraph ``` / ``` ```maxGraphColor ``` fenced
blocks), and wrapping each block in the render-time HTML envelope
(``<div class="maxgraph-diagram" ... data-maxgraph-line=... data-maxgraph-index=...
data-maxgraph-style-mode=...>``) with HTML-escaped content inside a
``<template class="maxgraph-diagram-source">`` and an empty
``<div class="maxgraph-diagram-canvas"></div>``.

The concern is pure and stateless: every operation is a deterministic function of
its string arguments. The transformed-line list is constructed fresh on each
``_prepare_maxgraph_blocks`` call, so no state is held across calls. It owns **no**
renderer or preprocessor state, so it is built and unit-tested without ever
constructing a ``DiagramPreprocessor`` or a ``MarkdownRenderer``.

The one collaborator it needs is the fence / diagram-info utility set
(``_is_maxgraph_info``, ``_find_closing_fence``, ``_maxgraph_style_mode``) that
already lives on the standalone
:class:`~app.markdown_services.code_block_extractor.CodeBlockExtractor`. It is
injected explicitly via the constructor — the collaborator never reaches for a
``DiagramPreprocessor`` to obtain it.

``DiagramPreprocessor`` composes one of these (sharing its single
``CodeBlockExtractor``) and forwards the public/internal maxGraph-scanning surface
(``_maxgraph_anchor_lines``, ``_prepare_maxgraph_blocks``) to it via thin
delegating shims, so the render pipeline keeps calling the same names on the
``DiagramPreprocessor`` instance.
"""

from __future__ import annotations

import html

from .code_block_extractor import CodeBlockExtractor
from .models import (
    FENCED_CODE_START_RE,
)


class MaxGraphBlockPreparation:
    """maxGraph block scanning and render-time preparation as a collaborator.

    Pure and stateless: holds no renderer or preprocessor state. The only
    dependency is the fence / diagram-info utility set, supplied as a
    :class:`~app.markdown_services.code_block_extractor.CodeBlockExtractor` via the
    constructor, so the collaborator is fully constructable and unit-testable in
    isolation (no ``DiagramPreprocessor``, no ``MarkdownRenderer``).
    """

    def __init__(self, code_block_extractor: CodeBlockExtractor) -> None:
        # The fence/diagram-info helpers (_is_maxgraph_info, _find_closing_fence,
        # _maxgraph_style_mode) live on the editable-code-block collaborator. They
        # are pure, so an injected instance behaves identically wherever it comes
        # from; the renderer injects its shared instance to keep one source of truth.
        self._code_block_extractor = code_block_extractor

    # ------------------------------------------------------------------ #
    # maxGraph block scanning / preparation
    # ------------------------------------------------------------------ #
    def _maxgraph_anchor_lines(self, source: str) -> list[int]:
        """1-based opening-fence line of each maxGraph block in ``source``, in source order."""
        lines = source.splitlines()
        anchors: list[int] = []
        index = 0
        while index < len(lines):
            match = FENCED_CODE_START_RE.match(lines[index])
            if match and self._code_block_extractor._is_maxgraph_info(match.group("info")):
                closing_index = self._code_block_extractor._find_closing_fence(
                    lines, index + 1, match.group("fence")
                )
                if closing_index is not None:
                    anchors.append(index + 1)
                    index = closing_index + 1
                    continue
            index += 1
        return anchors

    def _iter_maxgraph_blocks(self, lines: list[str]):
        """Yield ``(block_index, anchor_line, content_start, content_end)`` for each maxGraph
        fenced block in ``lines`` (text lines, no terminators): the 1-based opening-fence
        anchor (the ``data-maxgraph-line`` identity) and the 0-based ``[content_start,
        content_end)`` body bounds. The maxGraph analog of ``_iter_mermaid_blocks``, shared by
        the source-toggle read/update write-backs and their round-trip boundary guard."""
        block_index = 0
        cursor = 0
        while cursor < len(lines):
            match = FENCED_CODE_START_RE.match(lines[cursor])
            if not match:
                cursor += 1
                continue
            closing_index = self._code_block_extractor._find_closing_fence(
                lines, cursor + 1, match.group("fence")
            )
            if closing_index is None:
                break
            if not self._code_block_extractor._is_maxgraph_info(match.group("info")):
                cursor = closing_index + 1
                continue
            yield block_index, cursor + 1, cursor + 1, closing_index
            block_index += 1
            cursor = closing_index + 1

    def _prepare_maxgraph_blocks(self, source: str, original_source: str | None = None) -> str:
        lines = source.splitlines()
        transformed: list[str] = []
        block_index = 0

        # As with mermaid, ``data-maxgraph-line`` must reference the original file so write-back can
        # relocate the block; map each block back to its original opening-fence line by source order.
        original_anchors = (
            self._maxgraph_anchor_lines(original_source) if original_source is not None else None
        )
        remap = original_anchors is not None and len(original_anchors) == len(
            self._maxgraph_anchor_lines(source)
        )

        index = 0
        while index < len(lines):
            line = lines[index]
            match = FENCED_CODE_START_RE.match(line)
            if not match or not self._code_block_extractor._is_maxgraph_info(match.group("info")):
                transformed.append(line)
                index += 1
                continue

            closing_index = self._code_block_extractor._find_closing_fence(
                lines, index + 1, match.group("fence")
            )
            if closing_index is None:
                transformed.append(line)
                index += 1
                continue

            emit_line = original_anchors[block_index] if remap else index + 1
            self._append_maxgraph_block(
                transformed,
                lines[index + 1 : closing_index],
                emit_line,
                block_index,
                self._code_block_extractor._maxgraph_style_mode(match.group("info")),
            )
            block_index += 1
            index = closing_index + 1

        return "\n".join(transformed)

    def _append_maxgraph_block(
        self,
        transformed: list[str],
        maxgraph_lines: list[str],
        line: int,
        index: int,
        style_mode: str,
    ) -> None:
        transformed.append(
            '<div class="maxgraph-diagram" role="img" aria-label="maxGraph diagram" '
            f'data-maxgraph-line="{line}" data-maxgraph-index="{index}" '
            f'data-maxgraph-style-mode="{style_mode}">'
        )
        transformed.append('<template class="maxgraph-diagram-source">')
        transformed.extend(html.escape(maxgraph_line) for maxgraph_line in maxgraph_lines)
        transformed.append("</template>")
        transformed.append('<div class="maxgraph-diagram-canvas"></div>')
        transformed.append("</div>")
