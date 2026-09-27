import { isTerminalNode } from "@openfield/canvas/engine/runtime";
import { CANVAS_RUN_MAX_JOBS, t } from "@openfield/core";
import { Button, Spinner, Tooltip } from "@openfield/ui";
import { Play, Square } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { tightCost } from "../../lib/cost";
import { useCanvas, useCanvasStoreApi } from "../store/context";
import { selectAnyRunning } from "../store/selectors";
import { activeRuns, useEngineStore } from "./engine-store";

// The top bar's run controls (design byh7K, TW3j1, ghBKJ): Run all with the price of what would
// run, off when nothing on the canvas runs; while anything is in flight, a spinner, "2 of 6 done"
// and Stop come first. The editor places them after the save chip.

export function RunControls() {
  const store = useCanvasStoreApi();
  const canvasId = useCanvas((s) => s.canvasId);
  const ready = useCanvas((s) => s.runController.ready && !s.ui.readOnly);
  const running = useCanvas(selectAnyRunning);
  const analysis = useEngineStore((s) => s.analysis);
  // Busy while a run is being put together, not while its confirmation waits for an answer.
  const starting = useEngineStore((s) => s.starting && !s.dialog);
  const progress = useEngineStore(
    useShallow((s) => {
      const runs = activeRuns(s.runs).filter((r) => r.canvasId === canvasId);
      const nodes = runs.flatMap((r) => r.nodes);
      return {
        active: runs.length > 0,
        done: nodes.filter((n) => isTerminalNode(n.state)).length,
        total: nodes.length,
      };
    }),
  );

  const busy = running || progress.active;
  // More than a run can make: the server would refuse it, so the button says so before anything goes.
  const tooMany = analysis.jobs > CANVAS_RUN_MAX_JOBS;
  const price = analysis.pending > 0 && !tooMany ? tightCost(analysis.estimate) : undefined;
  const nothing = analysis.runnable === 0;
  const runAll = (
    <Button
      variant="primary"
      size="m"
      icon={Play}
      price={nothing ? undefined : price}
      disabled={!ready || nothing || starting}
      aria-disabled={tooMany || undefined}
      className={tooMany ? "opacity-40" : undefined}
      data-run-all
      onClick={(event) =>
        void store.getState().runController.run({ scope: "all", nodeIds: [], anchor: event.currentTarget })
      }
    >
      {t("canvas.run.runAll")}
    </Button>
  );

  return (
    <div className="flex items-center gap-12">
      {busy ? (
        <div className="flex h-40 items-center gap-10">
          <Spinner size={16} className="text-text-secondary" />
          {progress.total ? (
            <span className="text-small font-medium text-text-secondary">
              {t("canvas.run.progress", { done: progress.done, total: progress.total })}
            </span>
          ) : null}
          <Button
            variant="secondary"
            size="m"
            icon={Square}
            onClick={() => void store.getState().runController.stop()}
          >
            {t("canvas.run.stop")}
          </Button>
        </div>
      ) : null}
      {tooMany ? (
        <Tooltip content={t("canvas.errors.tooManyJobs", { max: CANVAS_RUN_MAX_JOBS })}>{runAll}</Tooltip>
      ) : (
        runAll
      )}
    </div>
  );
}
