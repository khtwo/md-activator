# Interactive Checkbox Controls

_[← Application Features index](../application-features.md)._ The checkbox-marker-derived interactive controls — plain checkboxes, button options, single-choice groups, and read-only progress bars — and their write-back through `POST /api/checkbox` (see [server-api.md](server-api.md)).

## Checkbox Rendering
Supported task markers outside fenced code blocks are transformed before markdown conversion:
- `[]`
- `[ ]`
- `[x]`
- `[X]`

Bracketed text that is part of a markdown link target (`[text](url)`) or image (`![alt](url)`) is not treated as a checkbox marker, so links and images are left intact rather than rendered as checkbox inputs.
The rendered checkbox inputs are enabled and preserve checked state for `x` or `X`.
Checked rendered checkboxes use the browser or theme's normal checkbox color rather than a custom green accent and remain fully opaque so the checked state is obvious in light and dark themes.
Rendered checkbox inputs are user-toggleable. When a user checks a rendered checkbox, the corresponding marker in the markdown file is changed to `[x]`; when a user unchecks it, the marker is changed to `[ ]`.
When reading checkbox source markers, both `[]` and `[ ]` are treated as unchecked. When writing an unchecked checkbox marker, the renderer writes `[ ]`.
Each rendered checkbox carries its source line number and marker occurrence index so the browser can request a precise file update. The line number is the marker's original line in the saved file and stays stable even when earlier markdown content is transformed into generated HTML or separator lines are inserted before display, so write-back always targets the marker the user actually clicked rather than a shifted neighbor.
Checkbox content that appears on separate source lines in the markdown file remains visually separated on separate rendered lines.

## Button Option Rendering
Checkbox option lines whose option text is a bracketed label render as action buttons instead of checkbox inputs:
- `[] [Label]`
- `[ ] [Label]`
- `[x] [Label]`
- `[X] [Label]`

Button option rendering:
- Uses the text inside the option label brackets as the visible button text.
- Applies to standalone button option lines and inline checkbox option sequences, such as `[] Mockup 1 [x] Mockup 2 [] [Confirm]`.
- For inline checkbox option sequences, only the bracketed option label associated with that checkbox marker renders as a button; other non-bracketed checkbox options on the same line remain ordinary checkboxes.
- Inline checkbox option sequences use added horizontal spacing between adjacent checkbox or button options so option groups are visually distinct.
- Uses theme-aligned neutral button surfaces in light and dark themes rather than saturated primary-blue styling.
- Checked button options show a leading check icon before the button text.
- Unchecked button options show only the button text, with no leading check icon.
- Button option labels do not show the literal markdown marker text `[]` or `[x]`.
- Carries the same source line number and marker occurrence index metadata as ordinary checkboxes.
- The markdown marker (`[]`, `[ ]`, `[x]`, or `[X]`) is the only source of truth for whether a button option is unchecked or checked. Rendered button state and check-icon visibility are derived from that source marker, not from the markdown file name, URL, or prior browser state.
- When the button is clicked while unchecked, the marker in the markdown file changes to `[x]` and the API returns the current path.
- When the button is clicked while checked, the marker in the markdown file changes to `[ ]` and the API returns the current path.
- Button option clicks do not rename the markdown file.
- Renders each button option as a native `<button type="button">` that carries an `aria-pressed` state (`true` when checked, `false` when unchecked) so assistive technology can announce its toggle state.
- Button option syntax is not transformed inside fenced code blocks or progress step groups.

## Single Choice Option Groups
Contiguous standalone checkbox option lines outside fenced code blocks are rendered as one single-choice group when a standalone `single` or `single:` marker (matched case-insensitively, so `single`, `Single`, and `SINGLE` are equivalent) appears on the immediately previous source line.

Single choice group rendering:
- Consumes the `single` marker so it does not render as visible text.
- Uses each checkbox marker on contiguous standalone checkbox option lines as one option, including inline checkbox option sequences on those lines.
- Supports `[]`, `[ ]`, `[x]`, and `[X]` markers with optional unordered or ordered list prefixes before each marker.
- Renders non-bracketed option text as radio-style choices.
- Renders bracketed button option labels, such as `[] [Approve]`, with the existing button option style while applying single-choice behavior.
- Carries source line number and marker occurrence index metadata for each option so browser updates can target the original marker.
- Treats the first checked source marker as the selected option when multiple markers are checked before rendering.
- Leaves `single` as ordinary markdown text when it is not immediately followed by one or more standalone checkbox option lines.
- Exposes the group as an accessible radio group: the container carries `role="radiogroup"` with an `aria-label` of `Single choice options`; non-bracketed options render as native `<input type="radio">` controls using built-in radio semantics, and bracketed button options render as `<button type="button">` carrying an `aria-pressed` state reflecting selection.
- Does not transform fenced code block content.

Single choice write-back:
- When a user selects an unchecked option, the selected marker changes to `[x]` and all other checkbox markers in the same single-choice group change to `[ ]`.
- When a direct checkbox update unchecks a marker in a single-choice group, only that marker changes to `[ ]`.
- Single choice updates keep the `/api/checkbox` request and response shape unchanged.

## Progress Step Rendering
Contiguous checkbox option lines outside fenced code blocks are rendered as a step progress bar when either of the following holds (the `progress`/`progress:` marker is matched case-insensitively, like the `single` marker above):
- A standalone `progress` or `progress:` marker appears on the immediately previous source line.
- The first checkbox option line is prefixed with `progress` or `progress:`.

Progress step rendering:
- Consumes the `progress` marker so it does not render as visible text.
- Uses each contiguous checkbox line as one step, falling back to a `Step N` label (1-based step position) when a step line has no label text.
- Supports optional unordered or ordered list prefixes before each checkbox marker.
- Keeps each step checkbox state connected to its original source line and marker index for traceability, but renders progress steps as read-only indicators whose checkbox inputs are rendered disabled, so the browser issues no write-back and progress steps do not persist changes through the checkbox API.
- Treats checked steps as complete, the first unchecked step as current, and later unchecked steps as pending. If all steps are checked, all steps render complete.
- Shows labels below their dots with equal step widths, wrapping labels up to 3 lines and truncating overflow.
- Shows step nodes as circles. Completed active nodes use the same color as the active connector line with a smaller check mark inside the circle, including when the underlying state input is disabled for read-only behavior.
- Uses thin connector lines between step nodes so the line supports the dots without visually dominating them.
- When step content overflows horizontally, uses a thin horizontal scrollbar with a transparent track and a thumb color that matches the current light or dark theme.
- Exposes the progress bar as an accessible list: the container carries `role="list"` with an `aria-label` of `Step progress`, and each step carries `role="listitem"` with its own `aria-label` set to the step label (or the `Step N` fallback).
- Leaves ordinary checkbox lines unchanged when no progress marker is present.
- Does not transform fenced code block content.
