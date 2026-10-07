import { cn } from "@openfield/ui";
import { ReactFlowProvider } from "@xyflow/react";
import { useEffect } from "react";
import { AddNodeMenu } from "../nodes/add-node-menu";
import { NodeInspector } from "../nodes/inspector";
import { CanvasStoreProvider, useCanvas, useCanvasStoreApi, useReadOnly, useUi } from "../store";
import { AgentPill, FollowFrame } from "./chrome/agent-pill";
import { ConflictBanner } from "./chrome/conflict-banner";
import { ContextToolbar } from "./chrome/context-toolbar";
import { FindBar } from "./chrome/find-bar";
import { NothingInView } from "./chrome/nothing-in-view";
import { StartOptions } from "./chrome/start-options";
import { Toolbar } from "./chrome/toolbar";
import { TopBarLeft, TopBarRight } from "./chrome/top-bar";
import { ZoomCluster } from "./chrome/zoom-cluster";
import { DeleteCanvasDialog, FrameDeleteDialog, SaveVersionDialog, ShortcutsDialog } from "./dialogs";
import { CanvasFlow } from "./flow/canvas-flow";
import { useEditorUi, useMain, useSession } from "./session";
import { useEditorCommands } from "./use-commands";
import { useShortcuts } from "./use-shortcuts";
import { PreviewBar } from "./versions/preview-bar";
import { VersionsDrawer } from "./versions/versions-drawer";

// The editor screen (design jfnDN and friends): the pane with its chrome on top. While a version is
// previewed, the pane and its chrome show that version's read-only store; the drawer, the name and
// the save state keep showing the live canvas.

const DRAWER_WIDTH = 354;
const EDGE = 12;

export function EditorView() {
  const session = useSession();
  const preview = useEditorUi((s) => s.preview);
  const flowKey = useEditorUi((s) => s.flowKey);
  const store = preview?.store ?? session.main;
  return (
    <CanvasStoreProvider store={store}>
      <ReactFlowProvider key={`${preview?.version.id ?? "live"}:${flowKey}`}>
        <EditorSurface previewing={preview !== null} />
      </ReactFlowProvider>
    </CanvasStoreProvider>
  );
}

function EditorSurface({ previewing }: { previewing: boolean }) {
  const commands = useEditorCommands();
  useShortcuts(commands);
  const tool = useUi((ui) => ui.tool);
  const findOpen = useUi((ui) => ui.findOpen);
  const addMenu = useUi((ui) => ui.addMenu !== null);
  const readOnly = useReadOnly();
  const empty = useCanvas((s) => s.doc.order.length === 0);
  const multi = useCanvas((s) => s.selection.nodeIds.length > 1);
  const drawer = useMain((s) => s.ui.drawer);
  const placing = tool === "note" || tool === "shape" || tool === "text" || tool === "frame";

  return (
    <div
      className={cn(
        "of-canvas relative size-full min-h-0 flex-1 overflow-hidden bg-canvas",
        tool === "pan" && "of-tool-pan",
        placing && "of-tool-place",
      )}
      data-multi={multi || undefined}
    >
      <CanvasFlow className="absolute inset-0" />
      {empty && !readOnly && !addMenu ? <StartOptions commands={commands} /> : null}
      <FollowFrame />
      <TopBarLeft />
      <TopBarRight />
      {previewing ? <PreviewBar /> : <AgentPill />}
      <div className="pointer-events-none absolute inset-x-0 top-64 z-10 flex flex-col items-center gap-12 mac-window:top-92">
        <ConflictBanner />
        <NothingInView onBack={commands.fit} />
      </div>
      {findOpen ? <FindBar right={drawer ? EDGE + DRAWER_WIDTH + EDGE : EDGE} /> : null}
      {readOnly ? null : <ContextToolbar commands={commands} />}
      {previewing ? null : <Toolbar commands={commands} />}
      <ZoomCluster commands={commands} />
      <DrawerHost previewing={previewing} />
      {addMenu && !readOnly ? <AddNodeMenu /> : null}
      <FrameDeleteDialog commands={commands} />
      <DeleteCanvasDialog />
      <SaveVersionDialog />
      <ShortcutsDialog />
    </div>
  );
}

/** The right-side drawer host (§7.11): node settings or version history, one at a time. */
function DrawerHost({ previewing }: { previewing: boolean }) {
  const session = useSession();
  const store = useCanvasStoreApi();
  const drawer = useMain((s) => s.ui.drawer);
  const editing = drawer?.panel === "inspector" && !previewing ? drawer.nodeId : null;
  // The node being edited stays clear of the drawer, at the same zoom.
  useEffect(() => {
    if (editing) store.getState().viewController.revealNode(editing, { right: EDGE + DRAWER_WIDTH + EDGE });
  }, [editing, store]);
  if (!drawer) return null;
  if (drawer.panel === "versions") {
    return (
      <div className="absolute top-64 right-12 bottom-12 z-20 w-354 mac-window:top-92">
        <VersionsDrawer />
      </div>
    );
  }
  if (previewing || !drawer.nodeId) return null;
  return (
    <div className="absolute top-64 right-12 z-20 max-h-[calc(100%-76px)] w-354 overflow-y-auto mac-window:top-92 mac-window:max-h-[calc(100%-104px)]">
      <CanvasStoreProvider store={session.main}>
        <NodeInspector nodeId={drawer.nodeId} />
      </CanvasStoreProvider>
    </div>
  );
}
