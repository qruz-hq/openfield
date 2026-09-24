import { t } from "@openfield/core";
import {
  Button,
  Field,
  Input,
  Keycap,
  Modal,
  ModalContent,
  ModalDescription,
  ModalFooter,
  SectionLabel,
} from "@openfield/ui";
import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router";
import { createVersion, deleteCanvas } from "../../api/hooks/canvas-doc";
import { errorMessage } from "../../api/raw";
import { notify, notifyError } from "../../lib/notify";
import { useReturnFocus } from "../nodes/shell/focus";
import { useEditorUi, useMain, useSession } from "./session";
import { shortcutSheet } from "./shortcuts";
import type { EditorCommands } from "./use-commands";

// The editor's dialogs, all on Modal / Shell: frame delete, canvas delete, save version and the
// keyboard shortcuts sheet.

/** A frame that still holds nodes asks what happens to them (§7.9). */
export function FrameDeleteDialog({ commands }: { commands: EditorCommands }) {
  const session = useSession();
  const open = useEditorUi((s) => s.frameDelete !== null);
  return (
    <Modal open={open} onOpenChange={(next) => !next && session.ui.setState({ frameDelete: null })}>
      <ModalContent alert title={t("canvas.editor.frame.deleteTitle")} closeLabel={t("actions.close")}>
        <ModalDescription>{t("canvas.editor.frame.deleteBody")}</ModalDescription>
        <ModalFooter>
          <Button variant="secondary" onClick={() => commands.confirmFrameDelete("frame-only")}>
            {t("canvas.editor.frame.deleteFrameOnly")}
          </Button>
          <Button variant="danger" onClick={() => commands.confirmFrameDelete("with-contents")}>
            {t("canvas.editor.frame.deleteWithContents")}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

/** Deleting the canvas echoes its name and says its images stay (the delete dialog pattern, tYXOg). */
export function DeleteCanvasDialog() {
  const session = useSession();
  const navigate = useNavigate();
  const open = useEditorUi((s) => s.deleteCanvasOpen);
  const name = useMain((s) => s.doc.name);
  const [busy, setBusy] = useState(false);
  const close = () => session.ui.setState({ deleteCanvasOpen: false });

  const confirm = async () => {
    setBusy(true);
    try {
      session.autosave.dispose();
      await deleteCanvas(session.canvasId);
      close();
      navigate("/canvas", { replace: true });
    } catch (error) {
      notifyError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onOpenChange={(next) => !next && close()}>
      <ModalContent alert title={t("canvas.editor.delete.title", { name })} closeLabel={t("actions.close")}>
        <ModalDescription>{t("canvas.editor.delete.body")}</ModalDescription>
        <ModalFooter>
          <Button variant="secondary" onClick={close}>
            {t("actions.cancel")}
          </Button>
          <Button variant="danger" loading={busy} onClick={() => void confirm()}>
            {t("canvas.editor.delete.confirm")}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

/** Save version (⇧⌘S): a name, then a snapshot of what's saved once pending changes are in. */
export function SaveVersionDialog() {
  const session = useSession();
  const open = useEditorUi((s) => s.saveVersionOpen);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const close = () => {
    session.ui.setState({ saveVersionOpen: false });
    setLabel("");
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const name = label.trim();
    if (!name) return;
    setBusy(true);
    try {
      await session.autosave.flush();
      await createVersion(session.canvasId, { label: name, kind: "named" });
      notify(t("canvas.editor.versions.saved"), { tone: "success" });
      close();
    } catch (error) {
      notifyError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onOpenChange={(next) => !next && close()}>
      <ModalContent title={t("canvas.editor.versions.nameTitle")} closeLabel={t("actions.close")}>
        <form onSubmit={(e) => void submit(e)} className="flex w-full flex-col gap-20">
          <Field label={t("canvas.editor.versions.nameLabel")} className="px-0 py-0">
            <Input
              autoFocus
              value={label}
              maxLength={120}
              placeholder={t("canvas.editor.versions.namePlaceholder")}
              onChange={(e) => setLabel(e.target.value)}
            />
          </Field>
          <ModalFooter>
            <Button variant="secondary" onClick={close}>
              {t("actions.cancel")}
            </Button>
            <Button type="submit" disabled={!label.trim()} loading={busy}>
              {t("actions.save")}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}

/** Keyboard shortcuts (design l9YSIT, rBEgu): 840 wide, three columns, the ? hint underneath. */
export function ShortcutsDialog() {
  const session = useSession();
  const open = useMain((s) => s.ui.shortcutsOpen);
  const columns = shortcutSheet();
  const setOpen = (next: boolean) => session.main.getState().actions.setUi({ shortcutsOpen: next });
  // Opened with ?, so there's no trigger to go back to: focus returns to the node or pane it left.
  const returnFocus = useReturnFocus(open);
  return (
    <Modal open={open} onOpenChange={setOpen}>
      <ModalContent
        title={t("canvas.editor.shortcuts.title")}
        closeLabel={t("actions.close")}
        className="w-840"
        onCloseAutoFocus={returnFocus}
      >
        <div className="flex w-full gap-36">
          {columns.map((groups) => (
            <div key={groups[0]!.title} className="flex min-w-0 flex-1 flex-col gap-28">
              {groups.map((group) => (
                <section key={group.title} className="flex w-full flex-col gap-12">
                  <SectionLabel>{t(group.title)}</SectionLabel>
                  {group.rows.map((row) => (
                    <div key={row.label} className="flex w-full items-center justify-between gap-12">
                      <span className="text-small text-text-secondary">{t(row.label)}</span>
                      {/* JetBrains Mono has no ⌫; Inter draws it full size, as the design shows. */}
                      <Keycap className={row.keys === "⌫" ? "min-w-28 font-sans text-[13px]" : undefined}>
                        {row.keys}
                      </Keycap>
                    </div>
                  ))}
                </section>
              ))}
            </div>
          ))}
        </div>
        <div className="flex w-full flex-col gap-16">
          <hr className="h-px w-full border-0 bg-border" />
          <p className="flex items-center gap-6 text-caption text-text-tertiary">
            {t("canvas.editor.shortcuts.hintLead")}
            <Keycap>?</Keycap>
            {t("canvas.editor.shortcuts.hintTail")}
          </p>
        </div>
      </ModalContent>
    </Modal>
  );
}
