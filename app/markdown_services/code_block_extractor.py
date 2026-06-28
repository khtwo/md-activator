"""Standalone editable-code-block / fence-detection collaborator.

``CodeBlockExtractor`` owns the markdown-preprocessing concern that pulls
editable (non-diagram) fenced code blocks out of the source, swaps in
placeholders, renders the extracted blocks to HTML, and later restores them.
It also provides the low-level fence-scanning utilities (closing-fence search,
line-ending detection, backtick-fence sizing, content splitting) and the
diagram-info predicates (mermaid / maxgraph detection) that several renderer
mixins reach for.

These mechanics formerly lived on ``EditableCodeBlockMixin`` (shared ``self``
with ``MarkdownRenderer``). The mixin was pure and stateless: it read no
``self._*`` state and only ever called sibling helpers. That makes the concern
trivially separable — ``CodeBlockExtractor`` takes **no** constructor
dependencies and can be built and unit-tested without ever constructing a
``MarkdownRenderer``.

``MarkdownRenderer`` composes one of these and the render pipeline calls it
directly via ``self._code_block_extractor`` (the former ``EditableCodeBlockMixin``
shim layer has been removed). The diagram-block and write-back collaborators hold
their own reference to the same instance, so the extract/restore orchestration and
the write-back fence callers share one source of truth.
"""

from __future__ import annotations

import html
import re

from .models import (
    BACKTICK_RUN_RE,
    CODE_LANGUAGE_RE,
    DEFAULT_CODE_LANGUAGE,
    EDITABLE_CODE_BLOCK_PLACEHOLDER,
    FENCED_CODE_START_RE,
    MAXGRAPH_COLOR_ALL_INFO_LANGUAGES,
    MAXGRAPH_COLOR_INFO_LANGUAGES,
    MAXGRAPH_NORMAL_INFO_LANGUAGES,
)


class CodeBlockExtractor:
    """Editable-code-block extraction / fence detection as an injectable collaborator.

    Pure and stateless: constructed with no dependencies and holds no renderer
    state. Every method is a deterministic function of its arguments.
    """

    def __init__(self) -> None:
        # No dependencies: the extraction concern is pure/stateless. The explicit
        # empty constructor documents that invariant and matches the spec
        # (``constructorParams: []``).
        pass

    # ------------------------------------------------------------------ #
    # Extraction / restoration
    # ------------------------------------------------------------------ #
    def _extract_editable_code_blocks(self, source: str) -> tuple[str, list[str]]:
        lines = source.splitlines()
        transformed: list[str] = []
        code_blocks: list[str] = []
        code_block_index = 0
        cursor = 0

        while cursor < len(lines):
            line = lines[cursor]
            match = FENCED_CODE_START_RE.match(line)
            if not match:
                transformed.append(line)
                cursor += 1
                continue

            closing_index = self._find_closing_fence(lines, cursor + 1, match.group("fence"))
            if closing_index is None:
                transformed.append(line)
                cursor += 1
                continue

            if self._is_diagram_info(match.group("info")):
                transformed.extend(lines[cursor : closing_index + 1])
                cursor = closing_index + 1
                continue

            placeholder = EDITABLE_CODE_BLOCK_PLACEHOLDER.format(index=len(code_blocks))
            code_blocks.append(
                self._code_block_html(
                    start_line=cursor + 1,
                    index=code_block_index,
                    info=match.group("info"),
                    content_lines=lines[cursor + 1 : closing_index],
                )
            )
            transformed.append(placeholder)
            transformed.extend("" for _ in range(closing_index - cursor))
            code_block_index += 1
            cursor = closing_index + 1

        return "\n".join(transformed), code_blocks

    def _restore_editable_code_blocks(self, source: str, code_blocks: list[str]) -> str:
        for index, code_block in enumerate(code_blocks):
            source = source.replace(EDITABLE_CODE_BLOCK_PLACEHOLDER.format(index=index), code_block)
        return source

    def _code_block_html(self, start_line: int, index: int, info: str, content_lines: list[str]) -> str:
        # An untyped fence (no recognized language token) defaults to the no-highlight "text"
        # language so every code block carries a language class and the shared Prism styling.
        language = self._code_language(info) or DEFAULT_CODE_LANGUAGE
        class_attr = f' class="language-{html.escape(language, quote=True)}"'
        content = html.escape("\n".join(content_lines))
        return (
            f'<pre data-code-block-line="{start_line}" data-code-block-index="{index}">'
            f"<code{class_attr}>{content}</code></pre>"
        )

    # ------------------------------------------------------------------ #
    # Info-string / diagram predicates
    # ------------------------------------------------------------------ #
    def _code_language(self, info: str) -> str:
        first_token = info.strip().split(maxsplit=1)[0] if info.strip() else ""
        if CODE_LANGUAGE_RE.match(first_token):
            return first_token
        return ""

    def _is_mermaid_info(self, info: str) -> bool:
        return self._code_language(info).lower() == "mermaid"

    def _is_maxgraph_info(self, info: str) -> bool:
        return bool(self._maxgraph_style_mode(info))

    def _maxgraph_style_mode(self, info: str) -> str:
        language = self._code_language(info).lower()
        if language in MAXGRAPH_COLOR_ALL_INFO_LANGUAGES:
            return "color-all"
        if language in MAXGRAPH_COLOR_INFO_LANGUAGES:
            return "color"
        if language in MAXGRAPH_NORMAL_INFO_LANGUAGES:
            return "normal"
        return ""

    def _is_diagram_info(self, info: str) -> bool:
        return self._is_mermaid_info(info) or self._is_maxgraph_info(info)

    # ------------------------------------------------------------------ #
    # Low-level fence / line utilities
    # ------------------------------------------------------------------ #
    def _find_closing_fence(self, lines: list[str], start: int, opening_fence: str) -> int | None:
        fence_char = opening_fence[0]
        fence_length = len(opening_fence)
        closing_re = re.compile(rf"^[ \t]{{0,3}}{re.escape(fence_char)}{{{fence_length},}}[ \t]*$")

        for index in range(start, len(lines)):
            if closing_re.match(self._line_text(lines[index])):
                return index
        return None

    def _line_text(self, line: str) -> str:
        return line.rstrip("\r\n")

    def _line_ending(self, line: str) -> str:
        if line.endswith("\r\n"):
            return "\r\n"
        if line.endswith("\n"):
            return "\n"
        return ""

    def _fence_line_indent(self, line: str) -> str:
        match = re.match(r"^[ \t]{0,3}", self._line_text(line))
        return match.group(0) if match else ""

    def _backtick_fence_for_content(self, content: str) -> str:
        longest_run = max((len(match.group(0)) for match in BACKTICK_RUN_RE.finditer(content)), default=0)
        return "`" * max(3, longest_run + 1)

    def _content_lines(self, content: str, existing_lines: list[str]) -> list[str]:
        line_ending = self._preferred_line_ending(existing_lines)
        normalized = content.replace("\r\n", "\n").replace("\r", "\n")
        if not normalized:
            return []

        content_parts = normalized.split("\n")
        if content_parts[-1] == "":
            content_parts = content_parts[:-1]
        return [f"{part}{line_ending}" for part in content_parts]

    def _preferred_line_ending(self, lines: list[str]) -> str:
        # Mirrors the original mixin exactly: when no line in ``lines`` carries a
        # newline the function falls through and returns ``None`` (not ``""``).
        # Preserved verbatim to keep behaviour byte-for-byte identical.
        for line in lines:
            if line.endswith("\r\n"):
                return "\r\n"
            if line.endswith("\n"):
                return "\n"
