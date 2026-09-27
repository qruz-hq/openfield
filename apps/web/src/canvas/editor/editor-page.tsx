import "@xyflow/react/dist/base.css";
import "./editor.css";
import { type CanvasDetail, t } from "@openfield/core";
import { Button, EmptyStatePage, Spinner } from "@openfield/ui";
import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import {
  createVersion,
  fetchVersion,
  patchCanvas,
  restoreVersion,
  useCanvasDetail,
} from "../../api/hooks/canvas-doc";
import { ApiError, errorMessage } from "../../api/raw";
import { notify, notifyError } from "../../lib/notify";
import { setCanvasPresence } from "../../lib/presence";
import { CanvasEngine } from "../engine";
import { rememberImageSizes } from "../nodes/generate/card-media";
import { CanvasStoreProvider, createCanvasStore } from "../store";
import { type Autosave, createAutosave } from "./autosave";
import { minimapPref } from "./chrome/prefs";
import { EditorView } from "./editor-view";
import { startLiveSync } from "./live-sync";
import { createPreviewCapture } from "./preview-capture";
import { createEditorUi, type EditorSession, EditorSessionProvider } from "./session";

// /canvas/:id (§7.4). Loads the canvas, then keeps one editor session for it: the canvas store,
// autosave, and the engine (runs, fingerprints), with the pane and its chrome on top.

export function EditorPage() {
  const { id = "" } = useParams();
  const detail = useCanvasDetail(id);

  if (detail.isPending) {
    return (
      <div className="flex size-full items-center justify-center bg-canvas text-text-tertiary">
        <Spinner size={18} label={t("app.loading")} />
      </div>
    );
  }
  if (detail.isError) {
    const missing = detail.error instanceof ApiError && detail.error.status === 404;
    return (
      <div className="flex size-full items-center justify-center bg-canvas px-16">
        <EmptyStatePage
          title={t(missing ? "canvas.editor.notFound" : "canvas.editor.loadFailed")}
          body={missing ? undefined : errorMessage(detail.error)}
          actions={
            <>
              <Button variant="secondary" asChild>
                <Link to="/canvas">{t("canvas.editor.backToCanvases")}</Link>
              </Button>
              {missing ? null : (
                <Button onClick={() => void detail.refetch()}>{t("actions.tryAgain")}</Button>
              )}
            </>
          }
        />
      </div>
    );
  }
  return <EditorSessionRoot key={detail.data.id} detail={detail.data} />;
}

/** Long enough for fingerprints and the first images to arrive. */
const OPEN_CAPTURE_DELAY_MS = 2_000;

function createSession(detail: CanvasDetail): { session: EditorSession; attach: () => () => void } {
  const canvasId = detail.id;
  // Image cards open at their images' exact shape, before any thumbnail loads.
  rememberImageSizes(detail.assetSizes);
  const main = createCanvasStore(detail);
  main.getState().actions.setUi({ minimapOpen: minimapPref() });
  const ui = createEditorUi();
  const capture = createPreviewCapture(main, { previewAt: detail.previewAt ?? null });

  // Autosave starts with the page and stops with it (twice over in development's strict mode), so
  // the session holds a stand-in that forwards to whichever one is running.
  let live: Autosave | null = null;
  const autosave: Autosave = {
    flush: (opts) => live?.flush(opts) ?? Promise.resolve(),
    dispose: () => {
      live?.dispose();
      live = null;
    },
  };
  const attach = () => {
    // Edits made on the server (an agent's) land in this copy as they happen (§7.11).
    const sync = startLiveSync(session);
    const current = createAutosave(main, {
      save: (body, opts) => patchCanvas(canvasId, body, opts),
      onSaved: () => capture.request(),
      caughtUp: (graphVersion) => sync.caughtUp(graphVersion),
    });
    // The server knows this canvas is open here, and what's selected, for "the canvas I have open".
    setCanvasPresence(canvasId, main.getState().selection.nodeIds);
    const unsubscribeSelection = main.subscribe((next, prev) => {
      if (next.selection.nodeIds !== prev.selection.nodeIds)
        setCanvasPresence(canvasId, next.selection.nodeIds);
    });
    live = current;
    capture.resume();
    // A card picture older than the canvas's results (a run finished while it was closed) is
    // retaken once the canvas has settled on screen.
    const settle = setTimeout(() => capture.request(), OPEN_CAPTURE_DELAY_MS);
    return () => {
      clearTimeout(settle);
      sync.stop();
      unsubscribeSelection();
      setCanvasPresence(null);
      if (live === current) live = null;
      // Leaving the route: save what's left, then stop, and bring the index card up to date. A
      // remount in the meantime (development's strict mode) means the editor never left.
      void current.flush().finally(() => {
        current.dispose();
        if (live === null) capture.leave();
      });
    };
  };

  const session: EditorSession = {
    canvasId,
    main,
    ui,
    autosave,
    capture,

    reloadFrom(next) {
      rememberImageSizes(next.assetSizes);
      main.getState().actions.loadDetail(next);
      ui.setState((s) => ({ flowKey: s.flowKey + 1, preview: null, findHit: null, frameDelete: null }));
    },

    async previewVersion(version) {
      try {
        const snapshot = await fetchVersion(canvasId, version.id);
        const store = createCanvasStore(
          {
            id: canvasId,
            name: main.getState().doc.name,
            graph: snapshot.graph,
            graphVersion: 1,
            updatedAt: snapshot.createdAt,
          },
          { readOnly: true },
        );
        store.getState().actions.setUi({ minimapOpen: main.getState().ui.minimapOpen });
        // The inspector edits the live canvas, so it closes while a version has the pane.
        const { actions, ui: mainUi } = main.getState();
        if (mainUi.drawer?.panel === "inspector") actions.closeDrawer();
        actions.setUi({ addMenu: null, connecting: null, findOpen: false });
        ui.setState({ preview: { version, store }, findHit: null });
      } catch (error) {
        notifyError(errorMessage(error));
      }
    },

    exitPreview() {
      if (ui.getState().preview) ui.setState({ preview: null, findHit: null });
    },

    async restoreVersion(versionId) {
      try {
        await autosave.flush();
        const next = await restoreVersion(canvasId, versionId);
        session.reloadFrom(next);
        // Keep the history open: the snapshot taken before the restore is now at the top.
        main.getState().actions.setUi({ drawer: { panel: "versions", nodeId: null } });
        notify(t("canvas.editor.versions.restored"), { tone: "success" });
      } catch (error) {
        notifyError(errorMessage(error));
      }
    },

    async snapshot(kind) {
      await autosave.flush();
      await createVersion(canvasId, { kind });
    },
  };
  return { session, attach };
}

function EditorSessionRoot({ detail }: { detail: CanvasDetail }) {
  const [{ session, attach }] = useState(() => createSession(detail));
  const [params, setParams] = useSearchParams();

  // "Version history" on an index card opens the canvas with its history drawer (?panel=versions).
  useEffect(() => {
    if (params.get("panel") !== "versions") return;
    session.main.getState().actions.setUi({ drawer: { panel: "versions", nodeId: null } });
    setParams({}, { replace: true });
  }, [params, setParams, session]);

  // An agent's show (?focus=a,b): those nodes, selected and in view once the pane is ready.
  useEffect(() => {
    const focus = params.get("focus");
    if (!focus) return;
    const { doc, actions } = session.main.getState();
    const nodeIds = focus.split(",").filter((id) => doc.nodes[id]);
    actions.setSelection({ nodeIds, edgeIds: [] });
    if (nodeIds.length) session.ui.setState({ focusNodes: nodeIds });
    setParams({}, { replace: true });
  }, [params, setParams, session]);

  useEffect(() => {
    const detach = attach();
    const { autosave } = session;
    // Blur, hide and reload save at once; a reload sends what it can as the page goes.
    const flush = () => void autosave.flush();
    const onHide = () => {
      if (document.visibilityState === "hidden") flush();
    };
    const onLeave = () => void autosave.flush({ keepalive: true });
    window.addEventListener("blur", flush);
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onLeave);
    window.addEventListener("beforeunload", onLeave);
    return () => {
      window.removeEventListener("blur", flush);
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onLeave);
      window.removeEventListener("beforeunload", onLeave);
      detach();
    };
  }, [attach, session]);

  return (
    <EditorSessionProvider session={session}>
      <CanvasStoreProvider store={session.main}>
        <CanvasEngine />
        <EditorView />
      </CanvasStoreProvider>
    </EditorSessionProvider>
  );
}
