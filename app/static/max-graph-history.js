const createMaxGraphEditHistory = (limit = MAXGRAPH_EDIT_HISTORY_LIMIT) => {
  const undoStack = [];
  const redoStack = [];

  return {
    record(edit) {
      undoStack.push(edit);
      while (undoStack.length > limit) undoStack.shift();
      redoStack.length = 0;
    },
    peekUndo() {
      return undoStack.length ? undoStack[undoStack.length - 1] : null;
    },
    commitUndo() {
      const edit = undoStack.pop() || null;
      if (edit) redoStack.push(edit);
      return edit;
    },
    peekRedo() {
      return redoStack.length ? redoStack[redoStack.length - 1] : null;
    },
    commitRedo() {
      const edit = redoStack.pop() || null;
      if (edit) undoStack.push(edit);
      return edit;
    },
    undoSize() {
      return undoStack.length;
    },
    redoSize() {
      return redoStack.length;
    }
  };
};
