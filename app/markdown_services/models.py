from __future__ import annotations

import re
from dataclasses import dataclass

from markdown.extensions import Extension
from markdown.treeprocessors import Treeprocessor


CHECKBOX_MARKER_RE = re.compile(r"(?<!!)\[(?P<mark> |x|X)?\](?!\()")
UNCHECKED_MARKER = "[ ]"
BUTTON_OPTION_LABEL_RE = re.compile(r"\s+\[(?P<label>[^\]\r\n]+)\](?!\()")
SINGLE_MARKER_LINE_RE = re.compile(r"^\s*single:?\s*$", re.IGNORECASE)
SINGLE_CHECKBOX_LINE_RE = re.compile(
    r"^\s*(?:[-*+]\s+|\d+[.)]\s+)?(?P<marker>\[(?P<mark> |x|X)?\])(?P<label>.*)$"
)
PROGRESS_MARKER_LINE_RE = re.compile(r"^\s*progress:?\s*$", re.IGNORECASE)
PROGRESS_PREFIX_RE = re.compile(r"^\s*progress:?\s+(?P<rest>.+)$", re.IGNORECASE)
PROGRESS_CHECKBOX_LINE_RE = re.compile(
    r"^\s*(?:[-*+]\s+|\d+[.)]\s+)?(?P<marker>\[(?P<mark> |x|X)?\])\s*(?P<label>.*)$"
)
TWO_SPACE_CHILD_LIST_MARKER_RE = re.compile(
    r"^(?P<indent> {2}(?: {4})*)(?P<marker>(?:[-*+]\s+|\d+[.)]\s+).*)$"
)
# A line that begins a list block: a bullet (-, *, +) or any ordered number
# followed by a space and at least one non-space character, at any indent. Used
# to decide whether a blank-line-delimited block is already a list.
LIST_ITEM_START_RE = re.compile(r"^\s*(?:[-*+]\s+|\d+[.)]\s+)\S")
# A list marker that may interrupt a paragraph per CommonMark: a bullet, or an
# ordered marker that starts at 1 (1. / 1)), followed by a space and content, at
# up to three leading spaces. Ordered markers starting at any other number and
# empty markers (no following content) do not interrupt a paragraph.
PARAGRAPH_INTERRUPTING_LIST_MARKER_RE = re.compile(r"^[ ]{0,3}(?:[-*+]\s+|1[.)]\s+)\S")
FENCED_CODE_START_RE = re.compile(r"^(?P<indent>[ \t]{0,3})(?P<fence>`{3,}|~{3,})(?P<info>.*)$")
BACKTICK_RUN_RE = re.compile(r"`+")
CODE_LANGUAGE_RE = re.compile(r"^[A-Za-z0-9_+.-]+$")
MD_LINK_RE = re.compile(r"\[[^\]]+\]\(([^)]+)\)")
INLINE_MD_PATH_RE = re.compile(r"`(?P<path>(?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_.-]+\.md)`")
BARE_MD_PATH_RE = re.compile(r"(?<![\w./:\[-])(?P<path>(?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_.-]+\.md)(?![\w./)\]-])")
INLINE_YAML_PATH_RE = re.compile(
    r"`(?P<path>(?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_.-]+\.ya?ml)`",
    re.IGNORECASE,
)
BARE_YAML_PATH_RE = re.compile(
    r"(?<![\w./:\[-])(?P<path>(?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_.-]+\.ya?ml)(?![\w./)\]-])",
    re.IGNORECASE,
)
INLINE_JSON_PATH_RE = re.compile(
    r"`(?P<path>(?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_.-]+\.jsonl?)`",
    re.IGNORECASE,
)
BARE_JSON_PATH_RE = re.compile(
    r"(?<![\w./:\[-])(?P<path>(?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_.-]+\.jsonl?)(?![\w./)\]-])",
    re.IGNORECASE,
)
BARE_HTTP_URL_RE = re.compile(r"(?<![<\[])(?P<url>https?://[^\s<>\])]+)", re.IGNORECASE)
MARKDOWN_LINK_RE = re.compile(r"(?<!!)\[(?P<label>[^\]]+)\]\((?P<href>[^)]+)\)")
INLINE_FILE_PATH_RE = re.compile(
    r"`(?P<path>(?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_.-]+\.[A-Za-z0-9][A-Za-z0-9_.-]*)`"
)
BARE_FILE_PATH_RE = re.compile(
    r"(?<![\w./:\[-])(?P<path>(?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_.-]+\.[A-Za-z0-9][A-Za-z0-9_.-]*)(?![\w./)\]-])"
)
IMAGE_MARKDOWN_RE = re.compile(r"!\[(?P<alt>[^\]]*)\]\((?P<href>[^)]+)\)")
INLINE_IMAGE_PATH_RE = re.compile(
    r"`(?P<path>(?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_.-]+\.(?:png|jpe?g|gif|webp|bmp|svg))`",
    re.IGNORECASE,
)
BARE_IMAGE_URL_RE = re.compile(
    r"(?P<url>https?://[^\s<>)]+?\.(?:png|jpe?g|gif|webp|bmp|svg)(?:[?#][^\s<>)]+)?)",
    re.IGNORECASE,
)
BARE_IMAGE_PATH_RE = re.compile(
    r"(?<![\w./:\[-])(?P<path>(?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_.-]+\.(?:png|jpe?g|gif|webp|bmp|svg))(?![\w./)\]-])",
    re.IGNORECASE,
)
FENCE_RE = re.compile(r"^\s*(```|~~~)")
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"}
# File extensions opened inside the viewer (rendered) rather than downloaded:
# markdown plus the YAML and JSON tree-view extensions.
YAML_SUFFIXES = (".yml", ".yaml")
JSON_SUFFIXES = (".json", ".jsonl")
VIEWER_SUFFIXES = (".md", *YAML_SUFFIXES, *JSON_SUFFIXES)
FILE_OPTION_TREE_VISIBLE_LEVELS = 3
RENDER_CACHE_IDLE_SECONDS = 60.0
RENDER_CACHE_MAX_SIZE = 100
RENDER_CACHE_EVICTION_WINDOW_SECONDS = 20.0
FOLDER_METADATA_CACHE_TTL_SECONDS = 5.0
FOLDER_METADATA_CACHE_MAX_SIZE = 100
EDITABLE_CODE_BLOCK_PLACEHOLDER = "@@MD_HTML_EDITOR_CODE_BLOCK_{index}@@"
# A fenced code block with no recognized language token renders with this language so it gains the
# shared Prism code styling; "text" is Prism's standard no-highlight language (plain, uncolored).
DEFAULT_CODE_LANGUAGE = "text"
NO_MARKDOWN_FOUND_HTML = "<p>No .md files found.</p>"
# A raw (unfenced) Mermaid block is recognized only when its first line is a genuine diagram
# declaration: the keyword alone, or with just its allowed first-line qualifier, and nothing else on
# the line. This prevents prose that merely begins with a diagram keyword — e.g. a wrapped markdown
# list line starting with "classDiagram ..." or a sentence starting with "graph"/"pie" — from being
# turned into a Mermaid container that then fails to parse.
MERMAID_START_RE = re.compile(
    r"^\s*(?:"
    r"(?:flowchart|graph)(?:[ \t]+(?:TB|TD|BT|RL|LR))?[ \t]*;?"
    r"|pie(?:[ \t]+showData)?(?:[ \t]+title[ \t]+\S.*)?"
    r"|gitGraph(?:[ \t]+(?:TB|BT|LR|RL))?[ \t]*:?"
    r"|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|mindmap|"
    r"timeline|quadrantChart|requirementDiagram|C4Context|C4Container|C4Component|C4Dynamic"
    r")[ \t]*$",
    re.IGNORECASE,
)
MERMAID_CONTINUATION_KEYWORDS = (
    "accdescr",
    "acctitle",
    "activate",
    "actor",
    "alt",
    "and",
    "autonumber",
    "break",
    "classdef",
    "click",
    "critical",
    "deactivate",
    "direction",
    "else",
    "end",
    "linkstyle",
    "loop",
    "note",
    "opt",
    "par",
    "participant",
    "rect",
    "style",
    "subgraph",
    "title",
)
MERMAID_OPERATORS = ("-->", "-.->", "==>", "---", "--", "->")
MAXGRAPH_NORMAL_INFO_LANGUAGES = {"maxgraph", "mxgraph"}
MAXGRAPH_COLOR_INFO_LANGUAGES = {"maxgraphcolor"}
MAXGRAPH_COLOR_ALL_INFO_LANGUAGES = {"maxgraphcolorall"}
MAXGRAPH_INFO_LANGUAGES = (
    MAXGRAPH_NORMAL_INFO_LANGUAGES | MAXGRAPH_COLOR_INFO_LANGUAGES | MAXGRAPH_COLOR_ALL_INFO_LANGUAGES
)


class MarkdownTableClassTreeprocessor(Treeprocessor):
    def run(self, root):
        for table in root.iter("table"):
            classes = table.get("class", "").split()
            if "markdown-table" not in classes:
                classes.append("markdown-table")
                table.set("class", " ".join(classes))
        return root


class MarkdownTableClassExtension(Extension):
    def extendMarkdown(self, md):
        md.treeprocessors.register(MarkdownTableClassTreeprocessor(md), "markdown_table_class", 15)


@dataclass
class RenderResult:
    relative_path: str
    render_version: str
    html: str
    links: list[str]
    file_options: list[dict[str, str | bool | int]]


@dataclass
class RenderCoreResult:
    html: str
    links: list[str]


@dataclass
class CachedRenderEntry:
    mtime_ns: int
    html: str
    links: list[str]
    last_accessed_at: float
    access_timestamps: list[float]


@dataclass
class FolderMetadata:
    file_options: list[dict[str, str | bool | int]]


@dataclass
class CachedFolderMetadataEntry:
    file_options: list[dict[str, str | bool | int]]
    loaded_at: float
    last_accessed_at: float


@dataclass
class CheckboxUpdateResult:
    relative_path: str
    line: int
    index: int
    checked: bool


@dataclass
class SingleChoiceOption:
    line: int
    marker_index: int
    checked: bool
    label: str
    is_button: bool


@dataclass
class ProgressStep:
    line: int
    marker_index: int
    checked: bool
    label: str


@dataclass
class CodeBlockUpdateResult:
    relative_path: str
    line: int
    index: int


@dataclass
class MaxGraphNodePositionUpdateResult:
    relative_path: str
    line: int
    index: int
    node_id: str
    x: float
    y: float


@dataclass
class MaxGraphNodePositionItemResult:
    node_id: str
    x: float
    y: float


@dataclass
class MaxGraphNodesPositionUpdateResult:
    relative_path: str
    line: int
    index: int
    nodes: list[MaxGraphNodePositionItemResult]


@dataclass
class MaxGraphNodeTitleUpdateResult:
    relative_path: str
    line: int
    index: int
    node_id: str
    title: str


@dataclass
class MaxGraphEdgeTitleUpdateResult:
    relative_path: str
    line: int
    index: int
    edge_id: str
    title: str


@dataclass
class MaxGraphNodeAddResult:
    relative_path: str
    line: int
    index: int
    node_id: str
    title: str
    x: float
    y: float


@dataclass
class MaxGraphNodeDeleteResult:
    relative_path: str
    line: int
    index: int
    node_id: str


@dataclass
class MaxGraphNodesDeleteResult:
    relative_path: str
    line: int
    index: int
    node_ids: list[str]


@dataclass
class MaxGraphEdgeAddResult:
    relative_path: str
    line: int
    index: int
    edge_id: str
    title: str
    source_id: str
    target_id: str


@dataclass
class MaxGraphEdgeDeleteResult:
    relative_path: str
    line: int
    index: int
    edge_id: str


@dataclass
class MaxGraphBlockRestoreResult:
    relative_path: str
    line: int
    index: int


MERMAID_NODE_DIAGRAM_TYPES = ("flowchart", "er", "class", "state")


@dataclass
class MermaidNodeTitleUpdateResult:
    relative_path: str
    line: int
    index: int
    diagram_type: str
    node_id: str
    title: str


@dataclass
class MermaidEdgeTitleUpdateResult:
    relative_path: str
    line: int
    index: int
    diagram_type: str
    source: str
    target: str
    occurrence: int
    edge_index: int
    title: str


@dataclass
class MermaidNodeAddResult:
    relative_path: str
    line: int
    index: int
    diagram_type: str
    node_id: str
    previous_source: str
    source: str


@dataclass
class MermaidEdgeAddResult:
    relative_path: str
    line: int
    index: int
    diagram_type: str
    source_id: str
    target_id: str
    previous_source: str
    source: str


@dataclass
class MermaidNodesDeleteResult:
    relative_path: str
    line: int
    index: int
    diagram_type: str
    node_ids: list[str]
    previous_source: str
    source: str


@dataclass
class MermaidEdgeDeleteResult:
    relative_path: str
    line: int
    index: int
    previous_source: str
    source: str


@dataclass
class MermaidBlockRestoreResult:
    relative_path: str
    line: int
    index: int


@dataclass
class MermaidRepairWritebackResult:
    relative_path: str
    line: int
    index: int
    fixed: bool
    issues: list[dict[str, object]]
