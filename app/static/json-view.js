// Expand/collapse interaction for the server-rendered JSON tree view.
//
// The tree markup (.json-view > .json-tree, with .json-branch nodes carrying a
// .json-toggle button, a .json-children block, and a .json-close-row) is produced
// server-side by the Python JsonTreeRenderer. All nodes are expanded by default;
// this only flips a node's collapsed state when its toggle is clicked. Collapsing
// adds the .json-collapsed class (CSS hides .json-children and the closing-bracket
// row and reveals the inline '…' preview) and shows '+'; expanding removes it and
// shows '-'. View-only — nothing is written back to the file.
//
// Both helpers are pure functions over the passed element/event so the node-eval
// test probe can exercise the toggle logic without a real DOM.

const toggleJsonNode = (toggleButton) => {
  const node = toggleButton && typeof toggleButton.closest === 'function'
    ? toggleButton.closest('.json-node.json-branch')
    : null;
  if (!node) return false;

  const collapsed = node.classList.toggle('json-collapsed');
  toggleButton.textContent = collapsed ? '+' : '-';
  toggleButton.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  toggleButton.setAttribute('aria-label', collapsed ? 'Expand' : 'Collapse');
  return true;
};

const handleJsonToggleClick = (event) => {
  const target = event && event.target;
  const toggleButton = target && typeof target.closest === 'function'
    ? target.closest('button.json-toggle')
    : null;
  if (!toggleButton) return false;
  if (typeof event.preventDefault === 'function') event.preventDefault();
  return toggleJsonNode(toggleButton);
};
