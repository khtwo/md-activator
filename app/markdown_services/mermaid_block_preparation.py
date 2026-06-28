"""Standalone mermaid block scanning / preparation collaborator.

This concern was formerly inlined on ``DiagramPreprocessor``: scanning a markdown
source for mermaid blocks (both ```` ```mermaid ```` fenced blocks and raw,
unfenced diagram declarations such as ``flowchart LR``), and wrapping each block
in the render-time HTML envelope (``<div class="mermaid" data-mermaid-line=...
data-mermaid-index=...>``) with HTML-escaped content.

The concern is pure and stateless: every operation is a deterministic function of
its string / line-list arguments. It owns **no** renderer or preprocessor state,
so it is built and unit-tested without ever constructing a ``DiagramPreprocessor``
or a ``MarkdownRenderer`` — the no-arg form (``MermaidBlockPreparation()``) is
fully usable in isolation.

``DiagramPreprocessor`` composes one of these and forwards the public/internal
mermaid-scanning surface (``_iter_mermaid_blocks``, ``_mermaid_anchor_lines``,
``_prepare_mermaid_blocks``) to it via thin delegating shims, so the render
pipeline and the write-back callers keep calling the same names on the
``DiagramPreprocessor`` instance.
"""

from __future__ import annotations

import html

from .models import (
    FENCE_RE,
    MERMAID_CONTINUATION_KEYWORDS,
    MERMAID_OPERATORS,
    MERMAID_START_RE,
)


class MermaidBlockPreparation:
    """Mermaid block scanning and render-time preparation as a collaborator.

    Pure and stateless: holds no renderer or preprocessor state and takes no
    constructor dependencies, so the no-arg form
    (``MermaidBlockPreparation()``) is fully usable in isolation.
    """

    def __init__(self) -> None:
        # Stateless: no collaborators, no shared self. Constructed without any
        # DiagramPreprocessor / MarkdownRenderer so the concern is unit-testable
        # in isolation.
        pass

    # ------------------------------------------------------------------ #
    # Mermaid block scanning / preparation
    # ------------------------------------------------------------------ #
    def _iter_mermaid_blocks(self, lines: list[str]):
        """Yield ``(block_index, anchor_line, content_start, content_end, is_fenced)`` for each
        mermaid block, in source order. ``anchor_line`` is the 1-based locator line (the opening
        fence for fenced blocks, the first content line for raw blocks); ``content_start`` and
        ``content_end`` are 0-based content bounds with ``content_end`` exclusive. ``lines`` are
        text lines without line endings. Both render and write-back use this single scanner so
        the emitted ``data-mermaid-line``/``data-mermaid-index`` match what write-back relocates.
        """
        block_index = 0
        index = 0
        total = len(lines)

        while index < total:
            line = lines[index]
            stripped = line.strip()

            if stripped.lower() in {"```mermaid", "~~~mermaid"}:
                closing_fence = stripped[:3]
                content_start = index + 1
                cursor = content_start
                while cursor < total and lines[cursor].strip() != closing_fence:
                    cursor += 1

                if cursor >= total:
                    # Unterminated fence: matches the render path, which does not treat it as a block.
                    return

                yield (block_index, index + 1, content_start, cursor, True)
                block_index += 1
                index = cursor + 1
                continue

            if MERMAID_START_RE.match(line):
                content_start = index
                cursor = index + 1
                while cursor < total and self._is_raw_mermaid_continuation(lines[cursor]):
                    cursor += 1

                yield (block_index, index + 1, content_start, cursor, False)
                block_index += 1
                index = cursor
                continue

            index += 1

    def _mermaid_anchor_lines(self, source: str) -> list[int]:
        """1-based anchor line of each mermaid block in ``source``, in source order."""
        return [anchor_line for (_, anchor_line, *_rest) in self._iter_mermaid_blocks(source.splitlines())]

    def _prepare_mermaid_blocks(self, source: str, original_source: str | None = None) -> str:
        lines = source.splitlines()
        blocks = {
            (content_start - 1 if is_fenced else content_start): (
                block_index,
                anchor_line,
                content_start,
                content_end,
                content_end + 1 if is_fenced else content_end,
            )
            for (block_index, anchor_line, content_start, content_end, is_fenced) in (
                self._iter_mermaid_blocks(lines)
            )
        }

        # The emitted ``data-mermaid-line`` must reference the original file, because write-back
        # relocates the block there. Earlier preprocessing (e.g. checkbox/progress expansion) can
        # shift line numbers in ``source``, so map each block back to its original anchor line by
        # source order. Fall back to the local anchor when the original is unavailable or the block
        # counts differ (so an unexpected mismatch never emits a wrong line).
        original_anchors = (
            self._mermaid_anchor_lines(original_source) if original_source is not None else None
        )
        remap = original_anchors is not None and len(original_anchors) == len(blocks)

        transformed: list[str] = []
        index = 0
        while index < len(lines):
            block = blocks.get(index)
            if block is None:
                transformed.append(lines[index])
                index += 1
                continue

            block_index, anchor_line, content_start, content_end, after = block
            emit_line = original_anchors[block_index] if remap else anchor_line
            self._append_mermaid_block(
                transformed, lines[content_start:content_end], emit_line, block_index
            )
            index = after

        return "\n".join(transformed)

    def _append_mermaid_block(
        self, transformed: list[str], mermaid_lines: list[str], line: int, index: int
    ) -> None:
        transformed.append(f'<div class="mermaid" data-mermaid-line="{line}" data-mermaid-index="{index}">')
        transformed.extend(html.escape(mermaid_line) for mermaid_line in mermaid_lines)
        transformed.append("</div>")

    # ------------------------------------------------------------------ #
    # Raw-mermaid continuation predicate
    # ------------------------------------------------------------------ #
    def _is_raw_mermaid_continuation(self, line: str) -> bool:
        stripped = line.strip()
        if not stripped:
            return True
        if line.startswith((" ", "\t")):
            return True
        if stripped.startswith("#") or FENCE_RE.match(line):
            return False

        lower = stripped.lower()
        if lower.startswith(MERMAID_CONTINUATION_KEYWORDS):
            return True
        return any(operator in stripped for operator in MERMAID_OPERATORS)
