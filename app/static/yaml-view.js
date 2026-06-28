// Expand/collapse interaction for the server-rendered YAML tree view.
//
// The tree markup (.yaml-view > .yaml-tree, with .yaml-branch nodes carrying a
// .yaml-toggle button and a .yaml-children block) is produced server-side by the
// Python YamlTreeRenderer. All nodes are expanded by default; this only flips a
// node's collapsed state when its toggle is clicked. Collapsing adds the
// .yaml-collapsed class (CSS hides .yaml-children) and shows '+'; expanding
// removes it and shows '-'. View-only — nothing is written back to the file.
//
// Both helpers are pure functions over the passed element/event so the node-eval
// test probe can exercise the toggle logic without a real DOM.

const toggleYamlNode = (toggleButton) => {
  const node = toggleButton && typeof toggleButton.closest === 'function'
    ? toggleButton.closest('.yaml-node.yaml-branch')
    : null;
  if (!node) return false;

  const collapsed = node.classList.toggle('yaml-collapsed');
  toggleButton.textContent = collapsed ? '+' : '-';
  toggleButton.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  toggleButton.setAttribute('aria-label', collapsed ? 'Expand' : 'Collapse');
  return true;
};

const handleYamlToggleClick = (event) => {
  const target = event && event.target;
  const toggleButton = target && typeof target.closest === 'function'
    ? target.closest('button.yaml-toggle')
    : null;
  if (!toggleButton) return false;
  if (typeof event.preventDefault === 'function') event.preventDefault();
  return toggleYamlNode(toggleButton);
};
