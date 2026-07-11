// Per-block mermaid error detection, in-memory auto-repair, and an inline Quick Fix box.
// Mermaid owns rendering, so detection runs `mermaid.parse` on each block BEFORE `mermaid.run`.
// A failing block is sent to the server for diagnosis; a high-confidence repair is rendered in
// memory (the file is never touched by rendering), and a Quick Fix button writes the repair to the
// original `.md`. Unrepairable blocks show a clean message with the line instead of a raw mermaid
// error. Kept in its own file so app.js stays within its size budget; uses `requireApiPayload`
// from app-support.js, so this loads after it.

// Pure: render one diagnosed issue as a display line.
const formatMermaidRepairIssue = (issue) => {
  const line = Number(issue && issue.line);
  const message = (issue && issue.message) || 'Diagram error';
  return Number.isFinite(line) && line > 0 ? `line ${line}: ${message}` : message;
};

const diagnoseMermaidSource = async (source) => {
  const res = await fetch('/api/mermaid-diagnose', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source })
  });
  return requireApiPayload(res, 'Failed to diagnose mermaid diagram');
};

const saveMermaidFix = async ({ path, line, index }) => {
  const res = await fetch('/api/mermaid-fix', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, line, index })
  });
  return requireApiPayload(res, 'Failed to apply mermaid fix');
};

const readMermaidSource = (diagram) => (diagram.textContent || '').trim();

// A mermaid container that has already been rendered carries mermaid's `data-processed` marker and
// holds the rendered `<svg>`; its `textContent` is then the SVG's injected CSS (`#mermaid-<id>{...}`),
// not the diagram source. Re-running the parse/render passes over it — which happens when an in-app
// re-render leaves the rendered diagrams in the DOM, e.g. re-opening the already-loaded file from the
// new-files dropdown returns identical HTML so the `v-html` binding is not re-patched — would feed
// that CSS to `mermaid.parse` and surface a spurious "No diagram type detected" error. Skipping
// already-rendered containers keeps these passes idempotent, like the zoom/pan and title-edit passes.
const isRenderedMermaidDiagram = (diagram) =>
  (diagram.dataset && diagram.dataset.processed === 'true')
  || (typeof diagram.querySelector === 'function' && diagram.querySelector('svg') !== null);

// Inspect every mermaid block before `mermaid.run`. For a block that fails to parse: if the server
// returns a repair that now parses, swap the block text to the repaired source in memory (so
// `mermaid.run` renders the corrected diagram) and report it as `fixed`; otherwise strip the
// `mermaid` class so `mermaid.run` skips it and report it as `unfixable`. Returns the reports used
// to attach inline boxes after rendering.
const prepareMermaidRepairs = async () => {
  const reports = [];
  if (!window.mermaid || typeof mermaid.parse !== 'function') return reports;

  const diagrams = Array.from(document.querySelectorAll('.mermaid[data-mermaid-index]'))
    .filter((diagram) => !isRenderedMermaidDiagram(diagram));
  for (const diagram of diagrams) {
    const source = readMermaidSource(diagram);
    if (!source) {
      // An empty (or whitespace-only) block is an empty sketch canvas, not a parse error: render
      // the bare flowchart header in memory (the file is never touched — same contract as the
      // in-memory auto-repair) and tag the container so the add-controls pass can offer the first
      // Add Node with the matching 'flowchart' type. Persisting that first node scaffolds the same
      // header into the source block server-side.
      diagram.textContent = 'flowchart TD';
      diagram.classList.add('mermaid-empty-canvas');
      diagram.dataset.mermaidEmptyCanvas = 'true';
      continue;
    }
    if (source === 'classDiagram') {
      // Bare `classDiagram` is the one node-bearing header bundled mermaid 11.15.0 cannot parse
      // alone (flowchart/er/state header-only blocks are valid), so a hand-authored or legacy
      // node-less class block gets the same in-memory empty-canvas treatment, rendered with the
      // default direction line — the minimal form that parses. The app itself no longer writes
      // the bare header: deleting the last class node persists this same direction-line form.
      diagram.textContent = 'classDiagram\ndirection TB';
      diagram.classList.add('mermaid-empty-canvas');
      continue;
    }
    let parseError = null;
    try {
      await mermaid.parse(source);
      continue;
    } catch (e) {
      parseError = e;
    }

    let result = null;
    try {
      result = await diagnoseMermaidSource(source);
    } catch {
      result = null;
    }

    const base = {
      line: Number(diagram.dataset.mermaidLine),
      index: Number(diagram.dataset.mermaidIndex)
    };

    if (result && result.fixed) {
      let repairParses = false;
      try {
        await mermaid.parse(result.fixedSource);
        repairParses = true;
      } catch {
        repairParses = false;
      }
      if (repairParses) {
        diagram.textContent = result.fixedSource;
        reports.push({ ...base, kind: 'fixed', issues: result.issues || [] });
        continue;
      }
    }

    diagram.classList.remove('mermaid');
    diagram.classList.add('mermaid-unrendered');
    diagram.textContent = '';
    reports.push({
      ...base,
      kind: 'unfixable',
      issues: (result && result.issues) || [],
      reason: parseError && parseError.message ? String(parseError.message) : ''
    });
  }
  return reports;
};

// Render each prepared `.mermaid` block one container at a time so a render-time failure (a block
// that PASSED `mermaid.parse` but still throws inside `mermaid.run`) is contained to its own diagram
// instead of aborting the whole render and leaking a raw error up to `loadFile`'s catch (the
// persistent page banner). A failing block is converted to the same clean `unfixable` report as a
// parse failure; the inline box lives in the rendered content, so a later reload after the user fixes
// the source rebuilds the content and the box disappears on its own.
const renderMermaidBlocks = async () => {
  const reports = [];
  const diagrams = Array.from(document.querySelectorAll('.mermaid[data-mermaid-index]'))
    .filter((diagram) => !isRenderedMermaidDiagram(diagram));
  for (const diagram of diagrams) {
    try {
      await mermaid.run({ nodes: [diagram] });
    } catch (e) {
      diagram.classList.remove('mermaid');
      diagram.classList.add('mermaid-unrendered');
      diagram.textContent = '';
      reports.push({
        line: Number(diagram.dataset.mermaidLine),
        index: Number(diagram.dataset.mermaidIndex),
        kind: 'unfixable',
        issues: [],
        reason: e && e.message ? String(e.message) : ''
      });
    }
  }
  return reports;
};

const buildMermaidRepairBox = (report, onQuickFix) => {
  const box = document.createElement('div');
  box.className = `mermaid-repair-box mermaid-repair-${report.kind}`;

  const heading = document.createElement('div');
  heading.className = 'mermaid-repair-heading';
  heading.textContent = report.kind === 'fixed'
    ? 'Diagram auto-fixed for display — the source file is unchanged.'
    : 'Diagram could not be rendered.';
  box.appendChild(heading);

  const issueTexts = (report.issues && report.issues.length)
    ? report.issues.map(formatMermaidRepairIssue)
    : (report.reason ? [report.reason] : ['Unknown mermaid error']);
  const list = document.createElement('ul');
  list.className = 'mermaid-repair-issues';
  issueTexts.forEach((text) => {
    const item = document.createElement('li');
    item.className = 'mermaid-repair-issue';
    item.textContent = text;
    list.appendChild(item);
  });
  box.appendChild(list);

  if (report.kind === 'fixed') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mermaid-repair-quick-fix';
    button.textContent = 'Quick Fix';
    button.addEventListener('click', () => onQuickFix(report, button));
    box.appendChild(button);
  }
  return box;
};

const renderMermaidRepairBoxes = (reports, onQuickFix) => {
  (reports || []).forEach((report) => {
    const selector = `[data-mermaid-index="${report.index}"][data-mermaid-line="${report.line}"]`;
    const diagram = document.querySelector(`.mermaid${selector}, .mermaid-unrendered${selector}`);
    if (!diagram || diagram.dataset.mermaidRepairBox === 'true') return;
    diagram.dataset.mermaidRepairBox = 'true';
    diagram.insertAdjacentElement('afterend', buildMermaidRepairBox(report, onQuickFix));
  });
};

// App-layer glue: Quick Fix persists the repair to the originating `.md`, then reloads so the now
// valid diagram renders and the box clears.
const createMermaidRepair = ({ getPath, loadFile, showError }) => {
  const onQuickFix = async (report, button) => {
    if (button) button.disabled = true;
    try {
      await saveMermaidFix({ path: getPath(), line: report.line, index: report.index });
      await loadFile(getPath(), '', { replaceUrl: true });
    } catch (e) {
      if (button) button.disabled = false;
      showError(e);
    }
  };
  return { onQuickFix };
};

// Single entry point for app.js: detect + in-memory repair each block, render, then attach inline
// boxes. Kept here so app.js stays within its size budget.
const runMermaidWithRepair = async ({ getPath, loadFile, showError }) => {
  const reports = await prepareMermaidRepairs();
  const renderReports = await renderMermaidBlocks();
  const { onQuickFix } = createMermaidRepair({ getPath, loadFile, showError });
  renderMermaidRepairBoxes(reports.concat(renderReports), onQuickFix);
};
