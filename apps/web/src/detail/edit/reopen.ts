import { rawFetch } from "../../api/raw";
import type { Reopened } from "../lineage";
import { decodeMaskPng } from "./mask-png";
import { useEditSession } from "./session";

// "Edit the original with this mask" (design Q6PqHq5KHS): an edit started on the original with the
// saved mask painted in, and the words, model, sizes, references and Keep the rest that made the
// image. The mask is already saved, so Generate sends it by its id until it's changed.

/**
 * Starts the edit on the original, ready for the Edit tab to pick up. False when the mask couldn't
 * be read: everything else is back, and the mask is left to paint again.
 */
export async function reopenEdit(plan: Reopened): Promise<boolean> {
  const { original, mask } = plan;
  let coverage: Uint8Array | undefined;
  try {
    const res = await rawFetch(mask.fileUrl);
    if (!res.ok) throw new Error(`Mask ${res.status}`);
    coverage = await decodeMaskPng(await res.blob(), original.width, original.height);
  } catch {
    coverage = undefined;
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
  if (coverage) session.setSavedMask(mask.id, useEditSession.getState().maskVersion);
  return coverage !== undefined;
}
