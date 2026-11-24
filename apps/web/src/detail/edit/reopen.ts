import { rawFetch } from "../../api/raw";
import type { Reopened } from "../lineage";
import { decodeMaskPng } from "./mask-png";
import { useEditSession } from "./session";

// "Edit the original with this mask" (design Q6PqHq5KHS), or "with these marks": an edit started on
// the original with the saved mask painted in, or Sketch & point's marks placed again, and the
// words, model, sizes, references and Keep the rest that made the image. A saved mask is sent by its
// id until it's changed.

/**
 * Starts the edit on the original, ready for the Edit tab to pick up. False when the mask couldn't
 * be read: everything else is back, and the mask is left to paint again.
 */
export async function reopenEdit(plan: Reopened): Promise<boolean> {
  const { original, mask, marks } = plan;
  let coverage: Uint8Array | undefined;
  if (!marks && mask) {
    try {
      const res = await rawFetch(mask.fileUrl);
      if (!res.ok) throw new Error(`Mask ${res.status}`);
      coverage = await decodeMaskPng(await res.blob(), original.width, original.height);
    } catch {
      coverage = undefined;
    }
  }

  const session = useEditSession.getState();
  // A fresh edit: the one open now (on the edited image) has already been left.
  session.end();
  session.start(original.id, original.width, original.height, coverage);
  session.setPrompt(plan.prompt);
  if (plan.model) session.setModel(plan.model);
  // Exactly the sizes it ran at, not merged over the last edit's.
  useEditSession.setState({ values: plan.values });
  session.setBatch(plan.batch);
  session.setComposite(plan.composite.composite);
  session.setFeatherPx(plan.composite.featherPx);
  session.setExpandPx(plan.composite.expandPx);
  session.setReferences(plan.references);
  if (marks) {
    // All at once, so they're one step back on Undo's list rather than one per mark.
    useEditSession.setState((state) => ({
      mode: "sketch",
      marks,
      selectedMark: null,
      marksPast: [],
      marksFuture: [],
      marksVersion: state.marksVersion + 1,
      sketchComposite: plan.sketchComposite,
    }));
  } else {
    useEditSession.setState({ mode: "paint" });
    if (coverage && mask) session.setSavedMask(mask.id, useEditSession.getState().maskVersion);
  }
  // What made the image it came from: leaving before changing any of it loses nothing.
  const state = useEditSession.getState();
  state.setKept({
    maskVersion: state.maskVersion,
    marksVersion: state.marksVersion,
    prompt: state.prompt,
    references: state.references,
  });
  return marks !== null || coverage !== undefined;
}
