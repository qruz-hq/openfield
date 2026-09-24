// A node picked from the add-node menu or the start options is ready to use at once: Upload and
// Assets open their picker, the way the reference canvas opens the file dialog, and a Prompt takes
// the cursor. The menu marks the new node; the node takes the mark once, on mount, while the click
// that made it still counts as the person's gesture.

/** The node types that act on the mark. */
export const OPENS_AT_ONCE: ReadonlySet<string> = new Set(["image.upload", "image.asset", "prompt"]);

const pending = new Set<string>();

export const markOpenPicker = (nodeId: string): void => {
  pending.add(nodeId);
};

/** True once for a node the menu just made. */
export const takeOpenPicker = (nodeId: string): boolean => pending.delete(nodeId);
