import { t } from "@openfield/core";
import { useEffect, useMemo, useRef } from "react";
import { subscribeEvents } from "../../api/events";
import {
  cancelCanvasNode,
  cancelCanvasRun,
  listCanvasRuns,
  postCanvasRun,
} from "../../api/hooks/canvas-runs";
import { useSettings } from "../../api/hooks/settings";
import { fetchSpentThisMonth } from "../../api/hooks/usage";
import { useLive } from "../../lib/live";
import { notify } from "../../lib/notify";
import { nodeRegistry } from "../nodes/registry";
import { useCanvas, useCanvasStoreApi } from "../store/context";
import { analyzeGraph } from "./analysis";
import { useEngineContextState } from "./context";
import { nodeTitle } from "./describe";
import { activeRuns, useEngineStore } from "./engine-store";
import {
  type FingerprintCache,
  isPendingFingerprint,
  knownFingerprints,
  planFingerprints,
  resolveFingerprints,
} from "./fingerprint";
import { createFollower } from "./follow";
import { busyNodes, createRunController } from "./run-controller";
import { RunDialogs } from "./run-dialogs";
import { NOOP_RUN_CONTROLLER } from "./types";

// The engine's React half, mounted once inside the canvas store provider. It keeps fingerprints and
// the live analysis current (one pass per frame after a change), installs the run controller,
// follows the event stream and catches up on runs when the canvas opens, when the stream comes back
// and when the document is reloaded under a run.

const sameMap = (a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
};

/** Busy nodes as one string, so the analysis reruns only when that set changes. */
const busyKey = (ids: ReadonlySet<string>) => [...ids].sort().join(",");

export function CanvasEngine() {
  const store = useCanvasStoreApi();
  const base = useEngineContextState();
  const missing = useCanvas((s) => s.missingAssets);
  const ready = base.ready;
  const ctx = useMemo(() => ({ ...base.ctx, missing }), [base.ctx, missing]);
  const settings = useSettings().data;
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const guardRef = useRef<number | null>(null);
  guardRef.current = settings?.spendGuardUsd ?? null;
  const cache = useRef<FingerprintCache>(new Map());

  // A fresh engine per canvas. On the way out only the open question is withdrawn: the analysis
  // stays until the next canvas opens, for the card picture that may still be taken (M4-15).
  useEffect(() => {
    useEngineStore.getState().reset();
    return () => useEngineStore.getState().withdraw();
  }, []);

  useEffect(() => {
    useEngineStore.getState().setContext(ctx);
  }, [ctx]);

  // Fingerprints and the live analysis: synchronously what's known, then the rest once hashed.
  useEffect(() => {
    if (!ready) return;
    let frame = 0;
    let pass = 0;
    const analyse = (fingerprints: Readonly<Record<string, string>>) => {
      const { doc, runtime } = store.getState();
      const engine = useEngineStore.getState();
      engine.setAnalysis(
        analyzeGraph(doc, nodeRegistry, ctx, fingerprints, engine.analysis, busyNodes(runtime)),
      );
    };
    const run = () => {
      frame = 0;
      const mine = ++pass;
      const state = store.getState();
      const plan = planFingerprints(state.doc, nodeRegistry, ctx);
      const known = knownFingerprints(plan, cache.current);
      if (!sameMap(known, state.fingerprints)) state.actions.setFingerprints(known);
      analyse(known);
      if (!Object.values(known).some(isPendingFingerprint)) return;
      void resolveFingerprints(plan, cache.current).then((full) => {
        // A newer pass is already on its way with newer inputs.
        if (mine !== pass) return;
        const latest = store.getState();
        if (!sameMap(full, latest.fingerprints)) latest.actions.setFingerprints(full);
        analyse(full);
      });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(run);
    };
    run();
    let busy = busyKey(busyNodes(store.getState().runtime));
    const unsubscribe = store.subscribe((state, previous) => {
      if (state.doc !== previous.doc) return schedule();
      if (state.runtime === previous.runtime) return;
      // What's running decides what Run all would send and what it costs.
      const next = busyKey(busyNodes(state.runtime));
      if (next !== busy) schedule();
      busy = next;
    });
    return () => {
      unsubscribe();
      cancelAnimationFrame(frame);
      pass++;
    };
  }, [store, ctx, ready]);

  // The run controller, and following runs on the event stream.
  useEffect(() => {
    if (!ready) return;
    const readOnly = store.getState().ui.readOnly;
    const follower = createFollower({
      store,
      registry: nodeRegistry,
      context: () => ctxRef.current,
      onFinished: (nodeId) => {
        const { doc, viewController } = store.getState();
        const frame = doc.nodes[nodeId];
        if (!frame || viewController.isNodeVisible(nodeId)) return;
        notify(t("canvas.run.finished", { name: nodeTitle(frame, nodeRegistry) }), {
          action: {
            label: t("canvas.run.jumpToNode"),
            onClick: () => store.getState().viewController.focusNode(nodeId),
          },
        });
      },
    });

    if (!readOnly) {
      store.getState().actions.installRunController(
        createRunController({
          store,
          registry: nodeRegistry,
          context: () => ctxRef.current,
          spendGuard: () => guardRef.current,
          spentThisMonth: fetchSpentThisMonth,
          fingerprints: async () => {
            const state = store.getState();
            const full = await resolveFingerprints(
              planFingerprints(state.doc, nodeRegistry, ctxRef.current),
              cache.current,
            );
            if (!sameMap(full, store.getState().fingerprints)) store.getState().actions.setFingerprints(full);
            return full;
          },
          api: { post: postCanvasRun, cancelRun: cancelCanvasRun, cancelNode: cancelCanvasNode },
        }),
      );
    }

    const unsubscribe = subscribeEvents((event) => {
      if (event.event === "asset.deleted") {
        // Images deleted while the canvas is open turn into placeholders and stay out of runs.
        const { doc, missingAssets, actions } = store.getState();
        const named = event.data.assetIds.filter(
          (id) =>
            !missingAssets.has(id) &&
            doc.order.some((n) => {
              const own = doc.params[n]?.assetIds;
              return (Array.isArray(own) && own.includes(id)) || doc.results[n]?.assetIds.includes(id);
            }),
        );
        if (named.length) actions.setMissingAssets(new Set([...missingAssets, ...named]));
        return;
      }
      follower.applyEvent(event);
    });

    // Catch up: runs still going, and runs that finished since this copy was saved.
    const catchUp = () => {
      const { canvasId, docMeta } = store.getState();
      listCanvasRuns(canvasId, docMeta.updatedAt)
        .then((runs) => {
          for (const run of runs) follower.applyRun(run, { live: false });
        })
        .catch(() => {
          // The stream brings the next frame anyway; nothing to tell the person.
        });
    };
    catchUp();
    let connected = useLive.getState().connected;
    const unsubscribeLive = useLive.subscribe((live) => {
      if (live.connected && !connected) catchUp();
      connected = live.connected;
    });
    // Reload or a restore replaced the document: hand the runs still going back to their nodes.
    const unsubscribeReload = store.subscribe((state, previous) => {
      if (state.docMeta === previous.docMeta) return;
      for (const run of activeRuns(useEngineStore.getState().runs)) follower.applyRun(run, { live: false });
    });

    return () => {
      unsubscribe();
      unsubscribeLive();
      unsubscribeReload();
      store.getState().actions.installRunController(NOOP_RUN_CONTROLLER);
    };
  }, [store, ready]);

  return <RunDialogs />;
}
