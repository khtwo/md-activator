"""High-confidence, in-memory repair for a small catalog of common mermaid syntax pitfalls.

Pure functions: text in, text out. This module does NOT parse mermaid (Python cannot run the
grammar) — whether a repair actually resolves the render error is confirmed client-side by
re-parsing the returned ``fixed_source``. Each rule fires only when it is confident, so a valid
diagram is returned unchanged and an unrecognized error yields ``fixed=False`` with no rewrite.

The rule catalog is a registry so deferred rules (e.g. ``reserved-word-end-as-node-id``,
``ampersand-in-edge-label``) can be added later without touching the pipeline.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# R1 targets sequence-diagram note and message lines: a `;` in the text after the label colon is a
# statement separator and breaks parsing.
SEQUENCE_NOTE_RE = re.compile(r"^(?P<head>\s*[Nn]ote\s+(?:left of|right of|over)\b[^:]*:)(?P<text>.*)$")
SEQUENCE_ARROW = r"(?:-{1,2}>{1,2}|-{1,2}x|-{1,2}\))"
SEQUENCE_MESSAGE_RE = re.compile(
    rf"^(?P<head>\s*[^\s:]+\s*{SEQUENCE_ARROW}\s*[^\s:]+\s*:)(?P<text>.*)$"
)

# R2 targets a flowchart rectangle label `ID[...]` that is not already quoted and contains a char
# mermaid cannot parse unquoted. `(?!\()` skips the `[(` database shape and `[^\[\]]` skips the
# `[[` subroutine shape, so only plain rectangles are touched.
FLOWCHART_LABEL_RE = re.compile(
    r"(?<![\w)\]])(?P<id>[A-Za-z0-9_]+)\[(?P<content>(?!\()[^\[\]]*)\]"
)
FLOWCHART_LABEL_SPECIALS = ("(", ")", "<", ">")

# R3 targets the reserved word `end` used as a flowchart node id (`a --> end`, `end[Done]`), which
# breaks parsing. Matched only outside label/quote regions (those are masked first) and never on the
# subgraph closer line (a line that is exactly `end`).
END_NODE_ID_RE = re.compile(r"(?<![\w])end(?![\w])")
FLOWCHART_SHAPE_OPENERS = "[({"

# R4 targets a flowchart dotted-link inline label `-. text .->`. Mermaid uses `.` as the dotted-link
# delimiter (`-.` … `.->`), so a `.` inside the inline text collides with it and breaks parsing; the
# same label in the pipe form `-.->|text|` parses cleanly. The opener is `-.`, the closer is `.-`
# with an optional arrowhead (`>`/`x`/`o`); `[^|]` keeps the text on one side of any existing pipe.
FLOWCHART_DOTTED_INLINE_LABEL_RE = re.compile(r"-\.(?P<text>[^|]*?)\.-(?P<head>[>xo]?)")

RULE_SEMICOLON_SEQUENCE = "semicolon-in-sequence-text"
RULE_FLOWCHART_LABEL_SPECIALS = "unquoted-specials-in-flowchart-label"
RULE_END_NODE_ID = "reserved-word-end-as-node-id"
RULE_DOTTED_INLINE_LABEL = "period-in-dotted-inline-edge-label"

MESSAGE_SEMICOLON_SEQUENCE = (
    "A semicolon in sequence-diagram text acts as a statement separator, so the text after it was "
    "parsed as a new statement. Replaced the separator with a comma."
)
MESSAGE_FLOWCHART_LABEL_SPECIALS = (
    "A flowchart label with unquoted ( ) < > breaks parsing. Wrapped the label in quotes."
)
MESSAGE_END_NODE_ID = (
    "The flowchart node id 'end' is a reserved word and was renamed to 'end_' (its label is "
    "preserved)."
)
MESSAGE_DOTTED_INLINE_LABEL = (
    "A dotted-link inline label containing '.' collides with the dotted-link delimiter and breaks "
    "parsing. Moved the label into the pipe form -.->|label|."
)


@dataclass
class MermaidRepairIssue:
    line: int
    rule_id: str
    message: str


@dataclass
class MermaidRepairResult:
    fixed: bool
    fixed_source: str
    issues: list[MermaidRepairIssue] = field(default_factory=list)


def _diagram_type(lines: list[str]) -> str:
    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        lower = stripped.lower()
        if lower.startswith("sequencediagram"):
            return "sequence"
        if lower.startswith("flowchart") or lower.startswith("graph"):
            return "flowchart"
        return "other"
    return "other"


def _repair_semicolon_sequence(line: str, line_number: int):
    match = SEQUENCE_NOTE_RE.match(line) or SEQUENCE_MESSAGE_RE.match(line)
    if match is None:
        return None
    text = match.group("text")
    if ";" not in text:
        return None
    # Drop a trailing separator entirely; turn internal separators into commas.
    new_text = re.sub(r"\s*;\s*$", "", text)
    new_text = re.sub(r"\s*;\s*", ", ", new_text)
    new_line = match.group("head") + new_text
    issue = MermaidRepairIssue(line_number, RULE_SEMICOLON_SEQUENCE, MESSAGE_SEMICOLON_SEQUENCE)
    return new_line, issue


def _repair_flowchart_label_specials(line: str, line_number: int):
    changed = False

    def replace(match: re.Match[str]) -> str:
        nonlocal changed
        content = match.group("content")
        stripped = content.strip()
        already_quoted = len(stripped) >= 2 and stripped.startswith('"') and stripped.endswith('"')
        if already_quoted or not any(ch in content for ch in FLOWCHART_LABEL_SPECIALS):
            return match.group(0)
        changed = True
        escaped = content.replace('"', "#quot;")
        return f'{match.group("id")}["{escaped}"]'

    new_line = FLOWCHART_LABEL_RE.sub(replace, line)
    if not changed:
        return None
    issue = MermaidRepairIssue(
        line_number, RULE_FLOWCHART_LABEL_SPECIALS, MESSAGE_FLOWCHART_LABEL_SPECIALS
    )
    return new_line, issue


def _mask_flowchart_labels(line: str) -> str:
    """Return ``line`` with the contents of quoted strings and ``[]``/``()``/``{}`` shape regions
    replaced by spaces (same length, delimiters kept), so token matching ignores label text."""
    chars = list(line)
    depth = 0
    in_quote = False
    for index, char in enumerate(line):
        if in_quote:
            if char == '"':
                in_quote = False
            else:
                chars[index] = " "
            continue
        if char == '"':
            in_quote = True
        elif char in "[({":
            depth += 1
        elif char in "])}":
            depth = max(0, depth - 1)
        elif depth > 0:
            chars[index] = " "
    return "".join(chars)


def _repair_end_node_id(line: str, line_number: int):
    if line.strip() == "end":  # subgraph closer, not a node id
        return None
    masked = _mask_flowchart_labels(line)
    matches = list(END_NODE_ID_RE.finditer(masked))
    if not matches:
        return None

    new_line = line
    for match in reversed(matches):
        follower = line[match.end():match.end() + 1]
        has_shape = follower != "" and follower in FLOWCHART_SHAPE_OPENERS
        replacement = "end_" if has_shape else 'end_["end"]'
        new_line = new_line[: match.start()] + replacement + new_line[match.end():]

    issue = MermaidRepairIssue(line_number, RULE_END_NODE_ID, MESSAGE_END_NODE_ID)
    return new_line, issue


def _repair_dotted_inline_edge_label(line: str, line_number: int):
    # Mask node-shape / quoted regions first (mask keeps length), so a `-.`/`.->` sequence inside a
    # label is never matched as an edge — same protection R3 uses.
    masked = _mask_flowchart_labels(line)
    matches = list(FLOWCHART_DOTTED_INLINE_LABEL_RE.finditer(masked))
    if not matches:
        return None

    new_line = line
    changed = False
    for match in reversed(matches):
        # Read the real label/arrowhead from the original at the same offsets (mask is length-stable).
        label = line[match.start("text"): match.end("text")].strip()
        if not label or "." not in label:
            continue
        head = line[match.start("head"): match.end("head")]
        new_line = new_line[: match.start()] + f"-.-{head}|{label}|" + new_line[match.end():]
        changed = True

    if not changed:
        return None
    issue = MermaidRepairIssue(line_number, RULE_DOTTED_INLINE_LABEL, MESSAGE_DOTTED_INLINE_LABEL)
    return new_line, issue


_RULES_BY_TYPE = {
    "sequence": (_repair_semicolon_sequence,),
    "flowchart": (
        _repair_flowchart_label_specials,
        _repair_end_node_id,
        _repair_dotted_inline_edge_label,
    ),
}


def repair_mermaid_source(source: str) -> MermaidRepairResult:
    lines = source.splitlines()
    rules = _RULES_BY_TYPE.get(_diagram_type(lines), ())
    if not rules:
        return MermaidRepairResult(fixed=False, fixed_source=source, issues=[])

    issues: list[MermaidRepairIssue] = []
    out = list(lines)
    for index, line in enumerate(out):
        for rule in rules:
            outcome = rule(line, index + 1)
            if outcome is None:
                continue
            new_line, issue = outcome
            out[index] = new_line
            line = new_line
            issues.append(issue)

    if not issues:
        return MermaidRepairResult(fixed=False, fixed_source=source, issues=[])

    fixed_source = "\n".join(out)
    if source.endswith("\n"):
        fixed_source += "\n"
    return MermaidRepairResult(fixed=True, fixed_source=fixed_source, issues=issues)
