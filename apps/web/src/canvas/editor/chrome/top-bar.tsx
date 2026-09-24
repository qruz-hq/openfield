import { type MessageKey, t } from "@openfield/core";
import { BrandMark, cn, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@openfield/ui";
import {
  ChevronDown,
  CloudCheck,
  CloudOff,
  Copy,
  Download,
  History,
  Image,
  LayoutGrid,
  Loader,
  type LucideIcon,
  PencilLine,
  Settings,
  Trash2,
} from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { duplicateCanvas } from "../../../api/hooks/canvas-doc";
import { errorMessage } from "../../../api/raw";
import { notify, notifyError } from "../../../lib/notify";
import { RunControls } from "../../engine/run-controls";
import type { SaveFailure, SaveStatus } from "../../store/types";
import { useEditorUi, useMain, useSession } from "../session";

// Top bar (design JDH76 left, buf6z right). Left: the Openfield menu pill and the canvas name pill,
// each with its menu. Right: the save state, then the run controls.

const pill = "flex h-40 cursor-pointer items-center rounded-10 bg-elevated inset-ring inset-ring-border";

export function TopBarLeft() {
  return (
    <div className="absolute top-12 left-12 z-10 flex items-center gap-8">
      <AppMenu />
      <NamePill />
    </div>
  );
}

function AppMenu() {
  const navigate = useNavigate();
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label={t("canvas.editor.menu.open")}
          className={cn(pill, "gap-6 pr-8 pl-11")}
        >
          <BrandMark size={18} />
          <ChevronDown size={12} aria-hidden className="text-text-tertiary" />
        </button>
      </MenuTrigger>
      <MenuContent>
        <MenuItem icon={LayoutGrid} onSelect={() => navigate("/canvas")}>
          {t("canvas.editor.menu.allCanvases")}
        </MenuItem>
        <MenuItem icon={Image} onSelect={() => navigate("/image")}>
          {t("canvas.editor.menu.image")}
        </MenuItem>
        <MenuItem icon={Settings} onSelect={() => navigate("/settings")}>
          {t("canvas.editor.menu.settings")}
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

function NamePill() {
  const session = useSession();
  const navigate = useNavigate();
  const name = useMain((s) => s.doc.name);
  const renaming = useEditorUi((s) => s.renamingCanvas);
  const previewing = useEditorUi((s) => s.preview !== null);
  const [open, setOpen] = useState(false);

  const openVersions = () =>
    session.main.getState().actions.setUi({ drawer: { panel: "versions", nodeId: null } });

  const duplicate = async () => {
    try {
      await session.autosave.flush();
      const copy = await duplicateCanvas(session.canvasId);
      notify(t("canvas.editor.toasts.duplicated"));
      navigate(`/canvas/${copy.id}`);
    } catch (error) {
      notifyError(errorMessage(error));
    }
  };

  const exportFile = () => {
    const { document } = session.main.getState().actions.snapshot();
    const blob = new Blob([JSON.stringify(document, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = window.document.createElement("a");
    a.href = url;
    a.download = `${(name.trim() || t("canvas.names.untitled")).replace(/[\\/:*?"<>|]+/g, "-")}.ofcanvas.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  if (renaming && !previewing) return <NameInput initial={name} />;

  // Not modal, so the second click of a double-click reaches the pill: the first opens the menu,
  // the double-click closes it and starts renaming (§7.4).
  return (
    <Menu open={open} onOpenChange={setOpen} modal={false}>
      <MenuTrigger asChild>
        <button
          type="button"
          // The visible name comes first, so saying it activates the pill (label in name).
          aria-label={`${name}, ${t("canvas.editor.name.menu")}`}
          onDoubleClick={(e) => {
            if (previewing) return;
            e.preventDefault();
            setOpen(false);
            session.ui.setState({ renamingCanvas: true });
          }}
          className={cn(pill, "max-w-320 gap-8 pr-10 pl-12")}
        >
          <span className="min-w-0 truncate text-body-medium text-text-primary">{name}</span>
          <ChevronDown size={14} aria-hidden className="shrink-0 text-text-tertiary" />
        </button>
      </MenuTrigger>
      <MenuContent>
        <MenuItem icon={History} onSelect={openVersions}>
          {t("canvas.editor.name.versionHistory")}
        </MenuItem>
        <MenuItem
          icon={PencilLine}
          disabled={previewing}
          onSelect={() => session.ui.setState({ renamingCanvas: true })}
        >
          {t("canvas.editor.name.rename")}
        </MenuItem>
        <MenuItem icon={Copy} onSelect={() => void duplicate()}>
          {t("canvas.editor.name.duplicate")}
        </MenuItem>
        <MenuItem icon={Download} onSelect={exportFile}>
          {t("canvas.editor.name.export")}
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon={Trash2} danger onSelect={() => session.ui.setState({ deleteCanvasOpen: true })}>
          {t("canvas.editor.name.delete")}
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

function NameInput({ initial }: { initial: string }) {
  const session = useSession();
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    const next = value.trim();
    if (commit && next && next !== initial) {
      session.main.getState().actions.apply([{ op: "setName", name: next }], { label: "rename" });
    }
    session.ui.setState({ renamingCanvas: false });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  };

  return (
    <div
      className={cn(
        pill,
        "cursor-text pr-10 pl-12 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
      )}
    >
      {/* The mirror sizes the field to the name as it's typed. */}
      <div className="grid [&>*]:[grid-area:1/1]">
        <span aria-hidden className="invisible whitespace-pre text-body-medium">
          {value || " "}
        </span>
        <input
          ref={ref}
          value={value}
          maxLength={200}
          aria-label={t("canvas.editor.name.field")}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => finish(true)}
          onKeyDown={onKeyDown}
          className="w-full min-w-40 max-w-400 bg-transparent text-body-medium text-text-primary outline-none"
        />
      </div>
    </div>
  );
}

const SAVE_STATE: Record<SaveStatus, { icon: LucideIcon; label: MessageKey; spin?: boolean }> = {
  saved: { icon: CloudCheck, label: "canvas.editor.save.saved" },
  dirty: { icon: Loader, label: "canvas.editor.save.saving" },
  saving: { icon: Loader, label: "canvas.editor.save.saving", spin: true },
  offline: { icon: CloudOff, label: "canvas.editor.save.offline" },
  conflict: { icon: CloudOff, label: "canvas.editor.save.notSaved" },
  failed: { icon: CloudOff, label: "canvas.editor.save.notSaved" },
};

const FAILED: Record<SaveFailure, MessageKey> = {
  deleted: "canvas.editor.save.deleted",
  too_big: "canvas.editor.save.tooBig",
  refused: "canvas.editor.save.notSaved",
};

/** Save state (design B9bh4): "Saved", "Saving…" or "Offline. Trying again…". Always the real state. */
export function SaveState() {
  const status = useMain((s) => s.persist.status);
  const failure = useMain((s) => s.persist.failure);
  const { icon: Icon, spin } = SAVE_STATE[status];
  const label = status === "failed" && failure ? FAILED[failure] : SAVE_STATE[status].label;
  return (
    <div role="status" className="flex h-40 items-center gap-6 px-4 text-text-tertiary">
      <Icon size={14} aria-hidden className={cn("shrink-0", spin && "motion-safe:animate-spin")} />
      <span className="text-small font-medium">{t(label)}</span>
    </div>
  );
}

export function TopBarRight() {
  return (
    <div className="absolute top-12 right-12 z-10 flex h-40 items-center justify-end gap-12">
      <SaveState />
      <RunControls />
    </div>
  );
}
