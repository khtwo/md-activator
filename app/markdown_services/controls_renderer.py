"""Standalone collaborator for interactive-control rendering.

This module owns the mechanics of turning checkbox markers, single-choice radio
groups, and step-progress bars into HTML. It was extracted out of the former
``MarkdownControlsMixin`` (since removed) as part of decomposing the
``MarkdownRenderer`` god-object into composed collaborators.

Design notes:

* ``ControlsRenderer`` is **pure and stateless** — it has no constructor
  dependencies and holds no renderer state, no root_dir, and no cross-mixin
  collaborators. Every method is a deterministic function of its arguments, so
  the class can be constructed and unit-tested in isolation
  (``ControlsRenderer()``) without ever building a ``MarkdownRenderer``.
* The only utility it needs from the former sibling mixins was
  ``_line_text`` (strip a trailing ``\\r``/``\\n``). That is a trivial pure
  string operation, so it lives here as a private helper rather than being
  injected — keeping the collaborator free of any cross-mixin call path.
* The renderer retains thin explicit delegations (defined directly in the
  ``MarkdownRenderer`` body) for every name that the render pipeline, sibling
  collaborators, or tests reference on the renderer instance, forwarding to a
  single ``ControlsRenderer`` instance so the collaborator is the one source of
  truth.
"""

from __future__ import annotations

import html

from .models import (
    BUTTON_OPTION_LABEL_RE,
    CHECKBOX_MARKER_RE,
    FENCE_RE,
    PROGRESS_CHECKBOX_LINE_RE,
    PROGRESS_MARKER_LINE_RE,
    PROGRESS_PREFIX_RE,
    SINGLE_CHECKBOX_LINE_RE,
    SINGLE_MARKER_LINE_RE,
    ProgressStep,
    SingleChoiceOption,
)


class ControlsRenderer:
    """Renders interactive markdown controls to HTML. Pure / stateless."""

    # ------------------------------------------------------------------ #
    # Top-level orchestration over a full source block
    # ------------------------------------------------------------------ #
    def inject_checkbox_html(self, source: str) -> str:
        lines = source.splitlines()
        transformed: list[str] = []
        in_fenced_block = False
        line_index = 0

        while line_index < len(lines):
            line = lines[line_index]
            if FENCE_RE.match(line):
                in_fenced_block = not in_fenced_block
                transformed.append(line)
                line_index += 1
                continue

            if in_fenced_block:
                transformed.append(line)
                line_index += 1
                continue

            if SINGLE_MARKER_LINE_RE.match(line):
                single_options, next_index = self._collect_single_choice_options(lines, line_index + 1)
                if single_options:
                    transformed.append(self._single_choice_html(single_options))
                    line_index = next_index
                    continue

            if PROGRESS_MARKER_LINE_RE.match(line):
                progress_steps, next_index = self._collect_progress_steps(lines, line_index + 1)
                if progress_steps:
                    transformed.append(self._step_progress_html(progress_steps))
                    line_index = next_index
                    continue

            prefix_match = PROGRESS_PREFIX_RE.match(line)
            if prefix_match:
                progress_steps, next_index = self._collect_progress_steps(
                    lines,
                    line_index,
                    first_line_override=prefix_match.group("rest"),
                )
                if progress_steps:
                    transformed.append(self._step_progress_html(progress_steps))
                    line_index = next_index
                    continue

            transformed.append(self._checkbox_line_html(line, line_index + 1))
            line_index += 1
        return "\n".join(transformed)

    # ------------------------------------------------------------------ #
    # Single-choice (radio group) parsing + rendering
    # ------------------------------------------------------------------ #
    def _collect_single_choice_options(
        self,
        lines: list[str],
        start_index: int,
    ) -> tuple[list[SingleChoiceOption], int]:
        options: list[SingleChoiceOption] = []
        line_index = start_index
        while line_index < len(lines):
            line = self._line_text(lines[line_index])
            parsed_options = self._parse_single_choice_options(line, line_number=line_index + 1)
            if not parsed_options:
                break
            options.extend(parsed_options)
            line_index += 1
        return options, line_index

    def _parse_single_choice_options(self, line: str, line_number: int) -> list[SingleChoiceOption]:
        match = SINGLE_CHECKBOX_LINE_RE.match(line)
        if not match:
            return []

        marker_start = line.find(match.group("marker"))
        marker_matches = list(CHECKBOX_MARKER_RE.finditer(line))
        first_option_index = next(
            (index for index, marker_match in enumerate(marker_matches) if marker_match.start() == marker_start),
            None,
        )
        if first_option_index is None:
            return []

        options: list[SingleChoiceOption] = []
        for marker_index, marker_match in enumerate(marker_matches[first_option_index:], start=first_option_index):
            next_marker = marker_matches[marker_index + 1] if marker_index + 1 < len(marker_matches) else None
            label_end = next_marker.start() if next_marker else len(line)

            button_label_match = BUTTON_OPTION_LABEL_RE.match(line, marker_match.end())
            is_button = bool(button_label_match and not line[button_label_match.end() : label_end].strip())
            label = (
                button_label_match.group("label").strip()
                if is_button and button_label_match
                else line[marker_match.end() : label_end].strip()
            )

            options.append(
                SingleChoiceOption(
                    line=line_number,
                    marker_index=marker_index,
                    checked=(marker_match.group("mark") or "").lower() == "x",
                    label=label,
                    is_button=is_button,
                )
            )

        return options

    def _single_choice_group_for_marker(
        self,
        lines: list[str],
        target_line_index: int,
        target_marker_index: int,
    ) -> list[SingleChoiceOption]:
        in_fenced_block = False
        line_index = 0

        while line_index < len(lines):
            line = self._line_text(lines[line_index])
            if FENCE_RE.match(line):
                in_fenced_block = not in_fenced_block
                line_index += 1
                continue

            if in_fenced_block:
                line_index += 1
                continue

            if SINGLE_MARKER_LINE_RE.match(line):
                options, next_index = self._collect_single_choice_options(lines, line_index + 1)
                if options:
                    if any(
                        option.line == target_line_index + 1 and option.marker_index == target_marker_index
                        for option in options
                    ):
                        return options
                    line_index = next_index
                    continue

            line_index += 1

        return []

    def _single_choice_html(self, options: list[SingleChoiceOption]) -> str:
        group_name = f"single-choice-{options[0].line}"
        selected_option = next((option for option in options if option.checked), None)
        rendered = [
            '<div class="single-choice-options" role="radiogroup" '
            f'aria-label="Single choice options" data-single-choice-group="{group_name}">'
        ]

        for option in options:
            selected = option is selected_option
            checked_attr = " checked" if selected else ""
            escaped_label = html.escape(option.label)
            if option.is_button:
                checked_value = "true" if selected else "false"
                rendered.append(
                    f'<button type="button" class="checkbox-option-button single-choice-button" '
                    f'data-checkbox-line="{option.line}" data-checkbox-index="{option.marker_index}" '
                    f'data-checkbox-single="true" data-checkbox-checked="{checked_value}" '
                    f'aria-pressed="{checked_value}">{escaped_label}</button>'
                )
                continue

            rendered.append(
                f'<label class="single-choice-option">'
                f'<input type="radio" name="{group_name}" data-checkbox-line="{option.line}" '
                f'data-checkbox-index="{option.marker_index}" data-checkbox-single="true"{checked_attr}> '
                f'<span class="single-choice-option-label">{escaped_label}</span>'
                f"</label>"
            )

        rendered.append("</div>")
        return "\n".join(rendered)

    # ------------------------------------------------------------------ #
    # Step-progress parsing + rendering
    # ------------------------------------------------------------------ #
    def _collect_progress_steps(
        self,
        lines: list[str],
        start_index: int,
        first_line_override: str | None = None,
    ) -> tuple[list[ProgressStep], int]:
        steps: list[ProgressStep] = []
        line_index = start_index
        while line_index < len(lines):
            line = first_line_override if line_index == start_index and first_line_override is not None else lines[line_index]
            parsed = self._parse_progress_step(line, line_number=line_index + 1, original_line=lines[line_index])
            if parsed is None:
                break
            steps.append(parsed)
            line_index += 1
        return steps, line_index

    def _parse_progress_step(self, line: str, line_number: int, original_line: str) -> ProgressStep | None:
        match = PROGRESS_CHECKBOX_LINE_RE.match(line)
        if not match:
            return None

        marker_start = original_line.find(match.group("marker"))
        marker_index = self._checkbox_marker_index_at(original_line, marker_start)
        if marker_index is None:
            return None

        return ProgressStep(
            line=line_number,
            marker_index=marker_index,
            checked=(match.group("mark") or "").lower() == "x",
            label=match.group("label").strip(),
        )

    def _checkbox_marker_index_at(self, line: str, marker_start: int) -> int | None:
        if marker_start < 0:
            return None

        for marker_index, match in enumerate(CHECKBOX_MARKER_RE.finditer(line)):
            if match.start() == marker_start:
                return marker_index
        return None

    def _step_progress_html(self, steps: list[ProgressStep]) -> str:
        current_index = next((index for index, step in enumerate(steps) if not step.checked), len(steps) - 1)
        rendered_steps = [
            '<div class="step-progress" '
            f'style="--step-count: {len(steps)};" role="list" aria-label="Step progress">'
        ]

        for index, step in enumerate(steps):
            state = "complete" if step.checked else "current" if index == current_index else "pending"
            classes = ["step-progress-step", f"step-progress-step--{state}"]
            if index > 0 and index <= current_index:
                classes.append("step-progress-step--line-left-active")
            if index < len(steps) - 1 and index < current_index:
                classes.append("step-progress-step--line-right-active")

            checked_attr = " checked" if step.checked else ""
            escaped_label = html.escape(step.label or f"Step {index + 1}")
            label_attr = html.escape(step.label or f"Step {index + 1}", quote=True)
            rendered_steps.append(
                f'<label class="{" ".join(classes)}" role="listitem">'
                '<span class="step-progress-line step-progress-line--left"></span>'
                f'<input class="step-progress-checkbox" type="checkbox" data-checkbox-line="{step.line}" '
                f'data-checkbox-index="{step.marker_index}"{checked_attr} disabled aria-disabled="true" '
                f'aria-label="{label_attr}">'
                '<span class="step-progress-dot" aria-hidden="true"></span>'
                '<span class="step-progress-line step-progress-line--right"></span>'
                f'<span class="step-progress-label">{escaped_label}</span>'
                "</label>"
            )

        rendered_steps.append("</div>")
        return "\n".join(rendered_steps)

    # ------------------------------------------------------------------ #
    # Inline checkbox marker rendering
    # ------------------------------------------------------------------ #
    def _checkbox_line_html(self, line: str, line_number: int) -> str:
        marker_index = 0
        rendered_parts: list[str] = []
        cursor = 0

        for match in CHECKBOX_MARKER_RE.finditer(line):
            rendered_parts.append(line[cursor : match.start()])
            checked = (match.group("mark") or "").lower() == "x"
            button_label_match = BUTTON_OPTION_LABEL_RE.match(line, match.end())
            if button_label_match:
                checked_value = "true" if checked else "false"
                escaped_label = html.escape(button_label_match.group("label").strip())
                rendered_parts.append(
                    f'<button type="button" class="checkbox-option-button" data-checkbox-line="{line_number}" '
                    f'data-checkbox-index="{marker_index}" data-checkbox-checked="{checked_value}" '
                    f'aria-pressed="{checked_value}">{escaped_label}</button>'
                )
                cursor = button_label_match.end()
            else:
                checked_attr = " checked" if checked else ""
                rendered_parts.append(
                    f'<input type="checkbox" data-checkbox-line="{line_number}" '
                    f'data-checkbox-index="{marker_index}"{checked_attr}>'
                )
                cursor = match.end()
            marker_index += 1

        rendered_parts.append(line[cursor:])
        rendered_line = "".join(rendered_parts)
        if marker_index:
            rendered_line = f"{rendered_line}  "
        return rendered_line

    # ------------------------------------------------------------------ #
    # Pure line utility (formerly supplied by a sibling mixin via self).
    # Kept local so this collaborator has no cross-mixin call path.
    # ------------------------------------------------------------------ #
    def _line_text(self, line: str) -> str:
        return line.rstrip("\r\n")
