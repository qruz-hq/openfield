import {
  isTerminalState,
  type JobSetWithJobs,
  type LayerSize,
  type LayersBody,
  type ModelKey,
} from "@openfield/core";
import { create } from "zustand";
import { queryClient } from "../../api/client";
import { followRun, type RunFollower } from "../../api/hooks/edit";
import { addJobSet } from "../../api/hooks/job-sets";
import { layerKeys, separateLayers } from "../../api/hooks/layers";
import { libraryKeys } from "../../api/hooks/library";

// The Layers tab's state that outlives the tab: a split keeps going after the view closes ("You can
// keep working"), and the order, hidden layers and selection of a stack stay as they were left
// while the app is open. Nothing here persists across a reload; the layers themselves are in the
// library by then.

export interface Separation {
  /** Null until the server answers. */
  runId: string | null;
  status: "running" | "failed" | "done";
}

export interface StackView {
  /** Layer ids, top first. Empty: the model's own order. */
  order: string[];
  hidden: string[];
  selected: string | null;
}

const FRESH_VIEW: StackView = { order: [], hidden: [], selected: null };

interface LayersState {
  /** Splits asked for in this session, by the image being split. */
  runs: Record<string, Separation>;
  /** How each stack is shown, by its run. */
  views: Record<string, StackView>;
  /** The form, carried across tabs and images like the Edit tab's model and sizes. */
  prompt: string;
  promptFor: string | null;
  model: ModelKey | null;
  size: LayerSize | null;
}

export const useLayers = create<LayersState>()(() => ({
  runs: {},
  views: {},
  prompt: "",
  promptFor: null,
  model: null,
  size: null,
}));

const followers = new Map<string, RunFollower>();

const setRun = (sourceId: string, run: Separation | null) =>
  useLayers.setState((s) => {
    const runs = { ...s.runs };
    if (run) runs[sourceId] = run;
    else delete runs[sourceId];
    return { runs };
  });

/** Starts a split of `body.image`, and follows it to its end even if the view closes. */
export function startSeparation(body: LayersBody): void {
  const sourceId = body.image;
  followers.get(sourceId)?.stop();
  setRun(sourceId, { runId: null, status: "running" });
  const finish = (set: JobSetWithJobs) => {
    if (!isTerminalState(set.jobSet.status)) return;
    followers.get(sourceId)?.stop();
    followers.delete(sourceId);
    const made = set.jobs.some((job) => job.status === "succeeded" && job.assetId);
    setRun(sourceId, { runId: set.jobSet.id, status: made ? "done" : "failed" });
    if (made) {
      // The image's children now hold the base, and its badge and Info section count the layers.
      void queryClient.invalidateQueries({ queryKey: libraryKeys.detail(sourceId) });
      void queryClient.invalidateQueries({ queryKey: layerKeys.stack(set.jobSet.id) });
    }
  };
  const follower = followRun({ onChange: finish });
  followers.set(sourceId, follower);
  separateLayers(body).then(
    (accepted) => {
      addJobSet(accepted);
      if (useLayers.getState().runs[sourceId]?.status === "running")
        setRun(sourceId, { runId: accepted.jobSet.id, status: "running" });
      follower.accept(accepted);
    },
    () => {
      follower.stop();
      followers.delete(sourceId);
      setRun(sourceId, { runId: null, status: "failed" });
    },
  );
}

export const viewOf = (runId: string | null): StackView =>
  (runId && useLayers.getState().views[runId]) || FRESH_VIEW;

export function useStackView(runId: string | null): StackView {
  return useLayers((s) => (runId && s.views[runId]) || FRESH_VIEW);
}

export function updateView(runId: string, change: (view: StackView) => Partial<StackView>): void {
  useLayers.setState((s) => {
    const view = s.views[runId] ?? FRESH_VIEW;
    return { views: { ...s.views, [runId]: { ...view, ...change(view) } } };
  });
}

/** The form's words belong to one image: another image starts with none. */
export function promptFor(assetId: string): string {
  const { prompt, promptFor: owner } = useLayers.getState();
  return owner === assetId ? prompt : "";
}
