from __future__ import annotations

import time
from pathlib import Path
from typing import Callable

import markdown

from .code_block_extractor import CodeBlockExtractor
from .controls_renderer import ControlsRenderer
from .diagram_preprocessor import DiagramPreprocessor
from .models import (
    FENCE_RE,
    FOLDER_METADATA_CACHE_MAX_SIZE,
    FOLDER_METADATA_CACHE_TTL_SECONDS,
    FolderMetadata,
    LIST_ITEM_START_RE,
    MarkdownTableClassExtension,
    NO_MARKDOWN_FOUND_HTML,
    PARAGRAPH_INTERRUPTING_LIST_MARKER_RE,
    PROGRESS_MARKER_LINE_RE,
    PROGRESS_PREFIX_RE,
    SINGLE_MARKER_LINE_RE,
    ProgressStep,
    RENDER_CACHE_EVICTION_WINDOW_SECONDS,
    RENDER_CACHE_IDLE_SECONDS,
    RENDER_CACHE_MAX_SIZE,
    RenderCoreResult,
    RenderResult,
    SingleChoiceOption,
    TWO_SPACE_CHILD_LIST_MARKER_RE,
    VIEWER_SUFFIXES,
    YAML_SUFFIXES,
    JSON_SUFFIXES,
)
from .link_rewriter import LinkRewriter
from .path_resolver import PathResolver
from .render_cache import RenderCacheStore
from .writeback_service import WritebackService
from .yaml_tree_renderer import YamlTreeRenderer
from .json_tree_renderer import JsonTreeRenderer
from .frontmatter_renderer import FrontMatterRenderer
from .models import (
    CheckboxUpdateResult,
    CodeBlockUpdateResult,
    MaxGraphBlockRestoreResult,
    MaxGraphEdgeAddResult,
    MaxGraphEdgeDeleteResult,
    MaxGraphEdgeTitleUpdateResult,
    MaxGraphNodeAddResult,
    MaxGraphNodeDeleteResult,
    MaxGraphNodePositionUpdateResult,
    MaxGraphNodesDeleteResult,
    MaxGraphNodesPositionUpdateResult,
    MaxGraphNodeTitleUpdateResult,
    MermaidBlockRestoreResult,
    MermaidEdgeAddResult,
    MermaidEdgeDeleteResult,
    MermaidEdgeTitleUpdateResult,
    MermaidNodeAddResult,
    MermaidNodesDeleteResult,
    MermaidNodeTitleUpdateResult,
    MermaidRepairWritebackResult,
)


class MarkdownRenderer:
    def __init__(
        self,
        root_dir: Path,
        *,
        clock: Callable[[], float] = time.monotonic,
        render_cache_max_size: int = RENDER_CACHE_MAX_SIZE,
        render_cache_idle_seconds: float = RENDER_CACHE_IDLE_SECONDS,
        render_cache_eviction_window_seconds: float = RENDER_CACHE_EVICTION_WINDOW_SECONDS,
        folder_metadata_cache_ttl_seconds: float = FOLDER_METADATA_CACHE_TTL_SECONDS,
        folder_metadata_cache_max_size: int = FOLDER_METADATA_CACHE_MAX_SIZE,
    ) -> None:
        self._root_dir = root_dir.resolve()
        self._clock = clock
        # Editable-code-block extraction / fence-detection collaborator. Pure and
        # stateless — no constructor deps and no root dependency, so the root_dir
        # setter does not need to propagate to it. The render pipeline calls it
        # directly via ``self._code_block_extractor`` (the former
        # EditableCodeBlockMixin shim layer has been removed); the diagram /
        # write-back collaborators hold their own reference to this same instance.
        self._code_block_extractor = CodeBlockExtractor()
        # Mermaid / maxGraph diagram-block collaborator. Pure and stateless — it
        # owns no renderer state and has no root dependency, so the root_dir setter
        # does not propagate to it. It shares the single CodeBlockExtractor so the
        # fence / diagram-info predicates have one source of truth. The render
        # pipeline calls it directly via ``self._diagram_preprocessor`` (the former
        # DiagramBlockMixin shim layer has been removed); the write-back mechanics
        # are owned by the WritebackService collaborator, which holds its own
        # reference to this same instance.
        self._diagram_preprocessor = DiagramPreprocessor(self._code_block_extractor)
        # Interactive-control rendering collaborator (checkbox markers,
        # single-choice radio groups, step-progress bars). Pure and stateless —
        # no constructor deps and no root dependency, so the root_dir setter does
        # not propagate to it. The renderer delegates the control mechanics to it
        # via the explicit delegations defined in the renderer body (the former
        # MarkdownControlsMixin shim layer has been removed).
        self._controls_renderer = ControlsRenderer()
        # YAML tree-view collaborator. Pure and stateless — no constructor deps and
        # no root dependency, so the root_dir setter does not propagate to it. The
        # render pipeline dispatches ``.yml`` / ``.yaml`` files to it directly via
        # ``self._yaml_tree_renderer`` instead of the Markdown pipeline.
        self._yaml_tree_renderer = YamlTreeRenderer()
        # JSON tree-view collaborator. Pure and stateless — no constructor deps and
        # no root dependency, so the root_dir setter does not propagate to it. The
        # render pipeline dispatches ``.json`` / ``.jsonl`` files to it directly via
        # ``self._json_tree_renderer`` instead of the Markdown pipeline.
        self._json_tree_renderer = JsonTreeRenderer()
        # Front-matter table collaborator. Pure and stateless — no constructor
        # deps and no root dependency, so the root_dir setter does not propagate
        # to it. The Markdown pipeline calls it via ``self._frontmatter_renderer``
        # to render a leading ``---`` ... ``---`` block as a key/value table and
        # blank that block out of the body in place, preserving body line numbers
        # (checkbox / code-block write-back, diagram anchors).
        self._frontmatter_renderer = FrontMatterRenderer()
        # Path-math and filesystem-traversal collaborator. Constructed with an
        # explicit root_dir dep; the renderer delegates resolution to it via the
        # explicit delegations defined in the renderer body (the former
        # PathResolutionMixin shim layer has been removed). The folder-rendering
        # orchestration that depends on render()/_folder_metadata stays on the
        # renderer and reaches the resolver via ``self._path_resolver``.
        self._path_resolver = PathResolver(self._root_dir)
        # Link/image/download rewriting collaborator. Constructed with the shared
        # PathResolver; because the resolver is passed by reference, the rewriter
        # observes root_dir changes made through the renderer's setter without any
        # extra propagation.
        self._link_rewriter = LinkRewriter(self._path_resolver)
        self._cache = RenderCacheStore(
            self._root_dir,
            clock=clock,
            render_cache_max_size=render_cache_max_size,
            render_cache_idle_seconds=render_cache_idle_seconds,
            render_cache_eviction_window_seconds=render_cache_eviction_window_seconds,
            folder_metadata_cache_ttl_seconds=folder_metadata_cache_ttl_seconds,
            folder_metadata_cache_max_size=folder_metadata_cache_max_size,
            # Bind dynamically so test monkeypatches of renderer._list_file_options
            # still take effect on the live cold-miss path.
            list_file_options_fn=lambda folder: self._list_file_options(folder),
        )
        # Markdown write-back collaborator (checkbox toggles, code-block edits,
        # mermaid / maxGraph node & edge title rewrites, node-position moves,
        # mermaid repair). Constructed with explicit collaborator deps only — it
        # never sees the renderer. It shares the renderer's PathResolver (so it
        # observes root_dir setter changes for free) and the renderer's cache
        # reference (it invalidates after every write but never owns a cache),
        # plus the single diagram / code-block / controls collaborators so the
        # block-rewrite and group-detection mechanics have one source of truth.
        # The renderer delegates each public update_* / repair method to it via
        # the orchestration shims below.
        self._writeback_service = WritebackService(
            path_resolver=self._path_resolver,
            cache=self._cache,
            diagram_preprocessor=self._diagram_preprocessor,
            code_block_extractor=self._code_block_extractor,
            controls_renderer=self._controls_renderer,
        )

    @property
    def root_dir(self) -> Path:
        return self._root_dir

    @root_dir.setter
    def root_dir(self, value: Path) -> None:
        resolved = value.resolve()
        if resolved != self._root_dir:
            self._root_dir = resolved
            # Propagate to the path resolver so resolution observes the new root.
            self._path_resolver.root_dir = resolved
            # Propagate to the cache collaborator; its setter clears BOTH caches.
            self._cache.root_dir = resolved

    @property
    def render_cache_size(self) -> int:
        return self._cache.render_cache_size

    @property
    def folder_metadata_cache_size(self) -> int:
        return self._cache.folder_metadata_cache_size

    # ------------------------------------------------------------------ #
    # Path-resolution delegation shims (formerly PathResolutionMixin)
    #
    # Explicit delegations to the PathResolver collaborator. The four public
    # resolution entry points stay on the renderer (the Facade) because
    # app/main.py calls them as ``renderer.resolve_*`` and tests reference the
    # same names on a renderer instance. The path-math / filesystem-traversal
    # mechanics live solely on the PathResolver collaborator (tested directly
    # there) and are reached via ``self._path_resolver``; the folder-rendering
    # orchestration below stays on the renderer because it depends on
    # ``self.render`` / ``self._folder_metadata`` and on the monkeypatchable
    # ``renderer._list_file_options`` hook.
    # ------------------------------------------------------------------ #
    def resolve_markdown_path(self, path: str | None, base: str | None = None) -> Path:
        return self._path_resolver.resolve_markdown_path(path=path, base=base)

    def resolve_image_path(self, path: str, base: str | None = None) -> Path:
        return self._path_resolver.resolve_image_path(path=path, base=base)

    def resolve_download_path(self, path: str, base: str | None = None) -> Path:
        return self._path_resolver.resolve_download_path(path=path, base=base)

    def resolve_content_path(self, path: str | None, base: str | None = None) -> Path:
        return self._path_resolver.resolve_content_path(path=path, base=base)

    # ------------------------------------------------------------------ #
    # Folder-rendering orchestration (stays on the renderer; depends on
    # render()/_folder_metadata and the monkeypatchable _list_file_options hook)
    # ------------------------------------------------------------------ #
    def _render_folder(self, folder: Path, *, include_file_options: bool = True) -> RenderResult:
        selected = self._path_resolver._folder_markdown_entrypoint(folder)
        if selected:
            return self.render(
                self._path_resolver._to_relative(selected),
                include_file_options=include_file_options,
            )

        return self._empty_folder_render(folder, include_file_options=include_file_options)

    def _empty_folder_render(self, folder: Path, *, include_file_options: bool = True) -> RenderResult:
        folder_metadata = self._folder_metadata(folder) if include_file_options else FolderMetadata([])
        return RenderResult(
            relative_path=self._path_resolver._to_relative(folder),
            render_version="",
            html=NO_MARKDOWN_FOUND_HTML,
            links=[],
            file_options=folder_metadata.file_options,
        )

    def _resolve_render_markdown_file(self, path: str | None, base: str | None = None) -> Path | None:
        content_path = self._path_resolver.resolve_content_path(path=path, base=base)
        if content_path.is_dir():
            return self._path_resolver._folder_markdown_entrypoint(content_path)

        if not content_path.exists() or not content_path.is_file():
            if content_path.name.lower() == "readme.md" and content_path.parent.is_dir():
                return self._path_resolver._folder_markdown_entrypoint(content_path.parent)
            raise FileNotFoundError(self._path_resolver._markdown_file_not_found_message(content_path))
        if content_path.suffix.lower() not in VIEWER_SUFFIXES:
            raise ValueError("Only .md, .yml, .yaml, .json, .jsonl files and folders are supported")
        return content_path

    def _list_file_options(self, folder: Path) -> list[dict[str, str | bool | int]]:
        # Stays on the renderer: monkeypatched by tests as renderer._list_file_options
        # and invoked from the caching orchestration (renderer._folder_metadata).
        options: list[dict[str, str | bool | int]] = []
        if folder.resolve() != self.root_dir:
            options.append(
                {
                    "label": "..",
                    "value": self._path_resolver._to_relative(folder.parent),
                    "kind": "parent",
                    "hasMarkdown": True,
                    "depth": 0,
                }
            )

        markdown_folders = self._path_resolver._folders_with_markdown_descendants(folder)
        options.extend(
            self._path_resolver._list_file_tree_options(
                folder=folder,
                depth=0,
                markdown_folders=markdown_folders,
            )
        )
        return options

    # ------------------------------------------------------------------ #
    # Interactive-control delegation shims (formerly MarkdownControlsMixin)
    #
    # Explicit delegations to the ControlsRenderer collaborator. These keep the
    # checkbox / single-choice / step-progress names resolvable on the renderer
    # instance so the render pipeline, sibling collaborators, and any test
    # monkeypatch of these names on a renderer still intercept on the live path.
    # ``inject_checkbox_html`` is public on the collaborator; the renderer keeps
    # the historical ``_inject_checkbox_html`` name as the delegation.
    # ------------------------------------------------------------------ #
    def _inject_checkbox_html(self, source: str) -> str:
        return self._controls_renderer.inject_checkbox_html(source)

    def _collect_single_choice_options(
        self,
        lines: list[str],
        start_index: int,
    ) -> tuple[list[SingleChoiceOption], int]:
        return self._controls_renderer._collect_single_choice_options(lines, start_index)

    def _parse_single_choice_options(self, line: str, line_number: int) -> list[SingleChoiceOption]:
        return self._controls_renderer._parse_single_choice_options(line, line_number=line_number)

    def _single_choice_group_for_marker(
        self,
        lines: list[str],
        target_line_index: int,
        target_marker_index: int,
    ) -> list[SingleChoiceOption]:
        return self._controls_renderer._single_choice_group_for_marker(
            lines, target_line_index, target_marker_index
        )

    def _single_choice_html(self, options: list[SingleChoiceOption]) -> str:
        return self._controls_renderer._single_choice_html(options)

    def _collect_progress_steps(
        self,
        lines: list[str],
        start_index: int,
        first_line_override: str | None = None,
    ) -> tuple[list[ProgressStep], int]:
        return self._controls_renderer._collect_progress_steps(
            lines, start_index, first_line_override=first_line_override
        )

    def _parse_progress_step(self, line: str, line_number: int, original_line: str) -> ProgressStep | None:
        return self._controls_renderer._parse_progress_step(
            line, line_number=line_number, original_line=original_line
        )

    def _checkbox_marker_index_at(self, line: str, marker_start: int) -> int | None:
        return self._controls_renderer._checkbox_marker_index_at(line, marker_start)

    def _checkbox_line_html(self, line: str, line_number: int) -> str:
        return self._controls_renderer._checkbox_line_html(line, line_number)

    def _step_progress_html(self, steps: list[ProgressStep]) -> str:
        return self._controls_renderer._step_progress_html(steps)

    # ------------------------------------------------------------------ #
    # Cache delegation shims (preserved public + cross-mixin self-callers)
    # ------------------------------------------------------------------ #
    def clean_render_cache(self) -> None:
        self._cache.clean_render_cache()

    def clear_render_cache(self) -> None:
        self._cache.clear_render_cache()

    def clean_folder_metadata_cache(self) -> None:
        self._cache.clean_folder_metadata_cache()

    def clear_folder_metadata_cache(self) -> None:
        self._cache.clear_folder_metadata_cache()

    def has_cached_render(self, path: str) -> bool:
        resolved = self._path_resolver.resolve_markdown_path(path)
        return self._cache.has_cached_render(resolved)

    def has_cached_folder_metadata(self, path: str) -> bool:
        resolved = self._path_resolver.resolve_content_path(path)
        return self._cache.has_cached_folder_metadata(resolved)

    def invalidate_render_cache(self, path: Path) -> None:
        self._cache.invalidate_render_cache(path.resolve())

    def _cached_render_core(self, md_path: Path, mtime_ns: int) -> RenderCoreResult | None:
        return self._cache._cached_render_core(md_path, mtime_ns)

    def _store_render_core(self, md_path: Path, mtime_ns: int, core: RenderCoreResult) -> None:
        self._cache._store_render_core(md_path, mtime_ns, core)

    # ------------------------------------------------------------------ #
    # Write-back delegation shims (preserved public surface)
    #
    # Each forwards to the WritebackService collaborator. They are kept on the
    # renderer because app/main.py calls them as ``renderer.update_*`` /
    # ``renderer.repair_mermaid_block`` and tests monkeypatch those same names on
    # the renderer instance (e.g. renderer.update_checkbox, renderer.update_code_block,
    # renderer.repair_mermaid_block) — the shims preserve those names so the
    # patches still intercept on the live call path.
    # ------------------------------------------------------------------ #
    def update_checkbox(self, path: str, line: int, index: int, checked: bool) -> CheckboxUpdateResult:
        return self._writeback_service.update_checkbox(path, line, index, checked)

    def update_code_block(self, path: str, line: int, index: int, content: str) -> CodeBlockUpdateResult:
        return self._writeback_service.update_code_block(path, line, index, content)

    def update_maxgraph_node_position(
        self,
        path: str,
        line: int,
        index: int,
        node_id: str,
        x: float,
        y: float,
    ) -> MaxGraphNodePositionUpdateResult:
        return self._writeback_service.update_maxgraph_node_position(path, line, index, node_id, x, y)

    def update_maxgraph_nodes_position(
        self,
        path: str,
        line: int,
        index: int,
        moves,
    ) -> MaxGraphNodesPositionUpdateResult:
        return self._writeback_service.update_maxgraph_nodes_position(path, line, index, moves)

    def update_maxgraph_node_title(
        self,
        path: str,
        line: int,
        index: int,
        node_id: str,
        title: str,
    ) -> MaxGraphNodeTitleUpdateResult:
        return self._writeback_service.update_maxgraph_node_title(path, line, index, node_id, title)

    def update_maxgraph_edge_title(
        self,
        path: str,
        line: int,
        index: int,
        edge_id: str,
        title: str,
    ) -> MaxGraphEdgeTitleUpdateResult:
        return self._writeback_service.update_maxgraph_edge_title(path, line, index, edge_id, title)

    def add_maxgraph_node(
        self,
        path: str,
        line: int,
        index: int,
        node_id: str,
        title: str,
        x: float,
        y: float,
    ) -> MaxGraphNodeAddResult:
        return self._writeback_service.add_maxgraph_node(path, line, index, node_id, title, x, y)

    def delete_maxgraph_node(
        self, path: str, line: int, index: int, node_id: str
    ) -> MaxGraphNodeDeleteResult:
        return self._writeback_service.delete_maxgraph_node(path, line, index, node_id)

    def delete_maxgraph_nodes(
        self, path: str, line: int, index: int, node_ids: list[str]
    ) -> MaxGraphNodesDeleteResult:
        return self._writeback_service.delete_maxgraph_nodes(path, line, index, node_ids)

    def add_maxgraph_edge(
        self,
        path: str,
        line: int,
        index: int,
        edge_id: str,
        title: str,
        source_id: str,
        target_id: str,
    ) -> MaxGraphEdgeAddResult:
        return self._writeback_service.add_maxgraph_edge(
            path, line, index, edge_id, title, source_id, target_id
        )

    def delete_maxgraph_edge(
        self, path: str, line: int, index: int, edge_id: str
    ) -> MaxGraphEdgeDeleteResult:
        return self._writeback_service.delete_maxgraph_edge(path, line, index, edge_id)

    def restore_maxgraph_block(
        self, path: str, line: int, index: int, xml: str
    ) -> MaxGraphBlockRestoreResult:
        return self._writeback_service.restore_maxgraph_block(path, line, index, xml)

    def update_mermaid_node_title(
        self,
        path: str,
        line: int,
        index: int,
        diagram_type: str,
        node_id: str,
        title: str,
    ) -> MermaidNodeTitleUpdateResult:
        return self._writeback_service.update_mermaid_node_title(
            path, line, index, diagram_type, node_id, title
        )

    def update_mermaid_edge_title(
        self,
        path: str,
        line: int,
        index: int,
        diagram_type: str,
        source: str,
        target: str,
        occurrence: int,
        edge_index: int,
        title: str,
    ) -> MermaidEdgeTitleUpdateResult:
        return self._writeback_service.update_mermaid_edge_title(
            path, line, index, diagram_type, source, target, occurrence, edge_index, title
        )

    def add_mermaid_node(
        self, path: str, line: int, index: int, diagram_type: str
    ) -> MermaidNodeAddResult:
        return self._writeback_service.add_mermaid_node(path, line, index, diagram_type)

    def add_mermaid_edge(
        self, path: str, line: int, index: int, diagram_type: str, source_id: str, target_id: str
    ) -> MermaidEdgeAddResult:
        return self._writeback_service.add_mermaid_edge(
            path, line, index, diagram_type, source_id, target_id
        )

    def delete_mermaid_nodes(
        self, path: str, line: int, index: int, diagram_type: str, node_ids: list[str]
    ) -> MermaidNodesDeleteResult:
        return self._writeback_service.delete_mermaid_nodes(path, line, index, diagram_type, node_ids)

    def delete_mermaid_edge(
        self,
        path: str,
        line: int,
        index: int,
        diagram_type: str,
        source: str,
        target: str,
        occurrence: int,
        edge_index: int,
    ) -> MermaidEdgeDeleteResult:
        return self._writeback_service.delete_mermaid_edge(
            path, line, index, diagram_type, source, target, occurrence, edge_index
        )

    def restore_mermaid_block(
        self, path: str, line: int, index: int, source: str
    ) -> MermaidBlockRestoreResult:
        return self._writeback_service.restore_mermaid_block(path, line, index, source)

    def repair_mermaid_block(self, path: str, line: int, index: int) -> MermaidRepairWritebackResult:
        return self._writeback_service.repair_mermaid_block(path, line, index)

    # ------------------------------------------------------------------ #
    # Link/image/download delegation shims (formerly LinkReferenceMixin)
    #
    # Explicit delegations to the LinkRewriter collaborator. These are the five
    # orchestration entry points the render pipeline drives via ``self`` in
    # ``_render_markdown_core``; they are kept on the renderer (rather than
    # inherited from a mixin) so the names stay resolvable on the instance and any
    # test monkeypatch of these names on a renderer still intercepts on the live
    # path. The remaining link helpers live solely on the LinkRewriter collaborator
    # (tested directly there) and are no longer surfaced on the renderer.
    # ------------------------------------------------------------------ #
    def _linkify_markdown_path_references(self, source: str) -> str:
        return self._link_rewriter._linkify_markdown_path_references(source)

    def _linkify_external_url_references(self, source: str) -> str:
        return self._link_rewriter._linkify_external_url_references(source)

    def _linkify_download_file_references(self, source: str, current_folder: Path) -> str:
        return self._link_rewriter._linkify_download_file_references(source, current_folder)

    def _render_image_references(self, source: str, current_folder: Path) -> str:
        return self._link_rewriter._render_image_references(source, current_folder)

    def _extract_markdown_links(self, source: str) -> list[str]:
        return self._link_rewriter._extract_markdown_links(source)

    def _folder_metadata(self, folder: Path) -> FolderMetadata:
        # Orchestration stays on the renderer so monkeypatching either
        # renderer._folder_metadata or renderer._list_file_options still bites.
        resolved_folder = folder.resolve()
        cached = self._cache._cached_folder_metadata(resolved_folder)
        if cached is not None:
            return cached

        metadata = FolderMetadata(file_options=self._list_file_options(resolved_folder))
        self._cache._store_folder_metadata(resolved_folder, metadata)
        return self._cache._copy_folder_metadata(metadata)

    def render(self, path: str | None, base: str | None = None, *, include_file_options: bool = True) -> RenderResult:
        md_path = self._resolve_render_markdown_file(path=path, base=base)
        if md_path is None:
            folder = self._path_resolver.resolve_content_path(path=path, base=base)
            return self._empty_folder_render(folder, include_file_options=include_file_options)

        core = self._render_markdown_file(md_path)
        folder_metadata = self._folder_metadata(md_path.parent) if include_file_options else FolderMetadata([])
        return RenderResult(
            relative_path=self._path_resolver._to_relative(md_path),
            render_version=self._render_version(md_path),
            html=core.html,
            links=list(core.links),
            file_options=folder_metadata.file_options,
        )

    def current_render_version(self, path: str | None, base: str | None = None) -> str | None:
        md_path = self._resolve_render_markdown_file(path=path, base=base)
        if md_path is None:
            return None
        return self._render_version(md_path)

    def _render_markdown_file(self, md_path: Path) -> RenderCoreResult:
        mtime_ns = md_path.stat().st_mtime_ns
        cached = self._cached_render_core(md_path, mtime_ns)
        if cached is not None:
            return cached

        core = self._render_markdown_core(md_path)
        self._store_render_core(md_path, mtime_ns, core)
        return core

    def _render_version(self, md_path: Path) -> str:
        return f"{self._path_resolver._to_relative(md_path)}:{md_path.stat().st_mtime_ns}"

    def _render_markdown_core(self, md_path: Path) -> RenderCoreResult:
        text = md_path.read_text(encoding="utf-8")
        suffix = md_path.suffix.lower()
        if suffix in YAML_SUFFIXES:
            return RenderCoreResult(html=self._yaml_tree_renderer.render(text), links=[])
        if suffix in JSON_SUFFIXES:
            return RenderCoreResult(
                html=self._json_tree_renderer.render(text, jsonl=(suffix == ".jsonl")),
                links=[],
            )
        # Render a leading YAML front-matter block as a table and blank it out of
        # the body in place. Blanking (not removing) keeps every body line at its
        # original file position, so checkbox / code-block line numbers and
        # mermaid / maxGraph anchors (computed from ``text`` below) stay correct.
        front_matter = self._frontmatter_renderer.split(text)
        text = front_matter.body
        preprocessed = self._normalize_two_space_child_list_indentation(text)
        preprocessed, editable_code_blocks = self._code_block_extractor._extract_editable_code_blocks(preprocessed)
        preprocessed = self._controls_renderer.inject_checkbox_html(preprocessed)
        # ``_separate_paragraph_interrupting_lists`` inserts blank separator lines,
        # so it must run AFTER the steps that emit absolute file line numbers
        # (code-block extraction and checkbox injection above); otherwise its
        # insertions shift every ``data-checkbox-line`` / ``data-code-block-line``
        # below the first interrupting list and write-back relocates the wrong
        # marker. The mermaid / maxGraph anchor steps below remap to ``text`` by
        # block order, so the post-insertion shift does not affect them.
        preprocessed = self._separate_paragraph_interrupting_lists(preprocessed)
        preprocessed = self._link_rewriter._linkify_markdown_path_references(preprocessed)
        preprocessed = self._link_rewriter._render_image_references(preprocessed, md_path.parent)
        preprocessed = self._link_rewriter._linkify_external_url_references(preprocessed)
        preprocessed = self._link_rewriter._linkify_download_file_references(preprocessed, md_path.parent)
        preprocessed = self._diagram_preprocessor._prepare_mermaid_blocks(preprocessed, original_source=text)
        preprocessed = self._diagram_preprocessor._prepare_maxgraph_blocks(preprocessed, original_source=text)
        preprocessed = self._code_block_extractor._restore_editable_code_blocks(preprocessed, editable_code_blocks)
        html = markdown.markdown(
            preprocessed,
            extensions=["fenced_code", "tables", "toc", "sane_lists", MarkdownTableClassExtension()],
        )
        if front_matter.table_html:
            html = front_matter.table_html + html
        links = self._link_rewriter._extract_markdown_links(preprocessed)

        return RenderCoreResult(html=html, links=links)

    def _normalize_two_space_child_list_indentation(self, source: str) -> str:
        transformed: list[str] = []
        in_fenced_block = False

        for line in source.splitlines():
            if FENCE_RE.match(line):
                in_fenced_block = not in_fenced_block
                transformed.append(line)
                continue

            if not in_fenced_block:
                line = TWO_SPACE_CHILD_LIST_MARKER_RE.sub(r"\g<indent>  \g<marker>", line)
            transformed.append(line)

        return "\n".join(transformed)

    def _separate_paragraph_interrupting_lists(self, source: str) -> str:
        # Official Markdown (CommonMark) lets a list interrupt a paragraph with no
        # intervening blank line. The ``sane_lists`` extension (enabled for its
        # list-type-separation behavior) suppresses that, absorbing the markers
        # into the preceding paragraph. To restore the spec behavior we insert a
        # separating blank line before a list marker that interrupts a paragraph,
        # while leaving lines that already belong to a list untouched so tight
        # lists and their lazy-continuation lines are preserved.
        transformed: list[str] = []
        in_fenced_block = False
        # Whether the current blank-line-delimited block is a list — true when the
        # block opened with a list marker or a list marker has interrupted it.
        block_is_list = False
        # Treat the start of the document like the line after a blank line.
        prev_blank = True

        for line in source.splitlines():
            if FENCE_RE.match(line):
                in_fenced_block = not in_fenced_block
                transformed.append(line)
                prev_blank = False
                block_is_list = False
                continue

            if in_fenced_block:
                transformed.append(line)
                continue

            if line.strip() == "":
                transformed.append(line)
                prev_blank = True
                block_is_list = False
                continue

            if self._is_list_control_marker(line):
                # ``single`` / ``progress`` directives own the checkbox series that
                # immediately follows them (the controls renderer requires that
                # adjacency). Treat the block as list-owning so the following items
                # are never separated from the marker by an inserted blank line.
                block_is_list = True
            elif prev_blank:
                # First line of a new block decides whether the block is a list.
                block_is_list = LIST_ITEM_START_RE.match(line) is not None
            elif not block_is_list and PARAGRAPH_INTERRUPTING_LIST_MARKER_RE.match(line):
                # A list marker is interrupting a paragraph: separate it so
                # ``sane_lists`` recognizes the list as its own block.
                transformed.append("")
                block_is_list = True

            transformed.append(line)
            prev_blank = False

        return "\n".join(transformed)

    @staticmethod
    def _is_list_control_marker(line: str) -> bool:
        # ``single`` / ``progress`` / ``progress: <text>`` directive lines that the
        # controls renderer expands into a single-choice group or step-progress bar
        # from the checkbox series on the lines directly below them.
        return bool(
            SINGLE_MARKER_LINE_RE.match(line)
            or PROGRESS_MARKER_LINE_RE.match(line)
            or PROGRESS_PREFIX_RE.match(line)
        )
