import { type CanvasSummary, t } from "@openfield/core";
import {
  Button,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Modal,
  ModalClose,
  ModalContent,
  ModalDescription,
  ModalFooter,
} from "@openfield/ui";
import { ArrowUpRight, Copy, Download, Ellipsis, History, PencilLine, Trash2 } from "lucide-react";
import { type KeyboardEvent, useId, useRef, useState } from "react";
import { Link } from "react-router";
import { CardPreview } from "./card-preview";
import { editedLabel } from "./edited";

// Canvas card (KkAp5 qF0K4): the 16:9 preview, the name and when it was last edited. Hover or
// focus shows the ⋯ button; right-click opens the same menu (ZcDZ4). Rename edits the name in place.

export interface CardActions {
  open: (id: string) => void;
  openVersions: (id: string) => void;
  rename: (summary: CanvasSummary, name: string) => void;
  duplicate: (id: string) => void;
  exportFile: (id: string) => void;
  remove: (summary: CanvasSummary) => Promise<void>;
}

export const canvasPath = (id: string) => `/canvas/${id}`;

const isApple = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);
// Written the way the editor writes its shortcuts (editor/shortcuts.ts).
export const duplicateShortcut = () => (isApple() ? "⌘D" : "Ctrl+D");
const isDuplicateKey = (event: KeyboardEvent) =>
  (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "d";

export function CanvasCard({
  summary,
  now,
  actions,
}: {
  summary: CanvasSummary;
  now: number;
  actions: CardActions;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const nameId = useId();
  const editedId = useId();
  const name = summary.name.trim() || t("canvas.names.untitled");

  const onKeyDown = (event: KeyboardEvent) => {
    if (renaming || deleting || !isDuplicateKey(event)) return;
    event.preventDefault();
    setMenuOpen(false);
    actions.duplicate(summary.id);
  };

  return (
    <article
      aria-labelledby={nameId}
      className="group/card flex min-w-0 flex-col gap-10"
      data-open={menuOpen || undefined}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => {
        // Portaled menus and dialogs still bubble here; leave those alone.
        if (renaming || deleting || !event.currentTarget.contains(event.target as Node)) return;
        event.preventDefault();
        // On a Mac this fires while the button is still down. Opening now would let the release
        // pick whichever item lands under the pointer, so wait for it.
        if (event.buttons & 2) window.addEventListener("pointerup", () => setMenuOpen(true), { once: true });
        else setMenuOpen(true);
      }}
    >
      <div className="relative aspect-video w-full rounded-12 bg-canvas">
        <Link
          to={canvasPath(summary.id)}
          aria-labelledby={nameId}
          aria-describedby={editedId}
          draggable={false}
          // The link clips the picture, so its focus ring outside isn't clipped.
          className="absolute inset-0 overflow-hidden rounded-12"
        >
          <CardPreview summary={summary} />
        </Link>
        {/* The frame's 1px stroke, drawn over the picture as the design does. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-12 inset-ring inset-ring-border transition-shadow group-hover/card:inset-ring-border-strong group-data-open/card:inset-ring-border-strong"
        />
        <Menu open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
          <MenuTrigger asChild>
            <IconButton
              variant="overlay"
              size={32}
              icon={Ellipsis}
              label={t("canvas.index.card.more", { name })}
              className="absolute top-8 right-8 opacity-0 transition-opacity group-focus-within/card:opacity-100 group-hover/card:opacity-100 data-[state=open]:opacity-100"
            />
          </MenuTrigger>
          <MenuContent
            align="end"
            sideOffset={4}
            // Rename moves focus into the name field; don't pull it back to the ⋯ button.
            onCloseAutoFocus={(event) => {
              if (renaming || deleting) event.preventDefault();
            }}
          >
            <MenuItem icon={ArrowUpRight} onSelect={() => actions.open(summary.id)}>
              {t("canvas.index.card.open")}
            </MenuItem>
            <MenuItem icon={PencilLine} onSelect={() => setRenaming(true)}>
              {t("canvas.index.card.rename")}
            </MenuItem>
            <MenuItem
              icon={Copy}
              shortcut={duplicateShortcut()}
              onSelect={() => actions.duplicate(summary.id)}
            >
              {t("canvas.index.card.duplicate")}
            </MenuItem>
            <MenuItem icon={Download} onSelect={() => actions.exportFile(summary.id)}>
              {t("canvas.index.card.export")}
            </MenuItem>
            <MenuItem icon={History} onSelect={() => actions.openVersions(summary.id)}>
              {t("canvas.index.card.versions")}
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={Trash2} danger onSelect={() => setDeleting(true)}>
              {t("canvas.index.card.delete")}
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
      <div className="flex w-full min-w-0 flex-col gap-2">
        {renaming ? (
          <RenameField
            name={name}
            onDone={(next) => {
              setRenaming(false);
              if (next !== null && next !== summary.name) actions.rename(summary, next);
            }}
          />
        ) : (
          <p
            id={nameId}
            title={name}
            onDoubleClick={() => actions.open(summary.id)}
            className="w-full truncate text-body-medium text-text-primary"
          >
            {name}
          </p>
        )}
        <p id={editedId} className="text-caption text-text-tertiary">
          {editedLabel(summary.updatedAt, now)}
        </p>
      </div>
      <DeleteDialog
        open={deleting}
        name={name}
        onOpenChange={setDeleting}
        onConfirm={() => actions.remove(summary)}
      />
    </article>
  );
}

/** The name, editable in place. Enter or leaving the field saves; Escape keeps the old name. */
function RenameField({ name, onDone }: { name: string; onDone: (name: string | null) => void }) {
  const done = useRef(false);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    const trimmed = value?.trim() ?? "";
    onDone(trimmed ? trimmed : null);
  };
  return (
    <input
      // biome-ignore lint/a11y/noAutofocus: the person just asked to rename this card.
      autoFocus
      defaultValue={name}
      maxLength={200}
      aria-label={t("canvas.index.card.renameLabel")}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={(event) => finish(event.currentTarget.value)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") finish(event.currentTarget.value);
        if (event.key === "Escape") finish(null);
      }}
      className="-mx-4 -my-2 w-[calc(100%+8px)] min-w-0 rounded-6 bg-elevated px-4 py-2 text-body-medium text-text-primary outline-none inset-ring inset-ring-border-strong"
    />
  );
}

function DeleteDialog({
  open,
  name,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  name: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent
        alert
        title={t("canvas.index.delete.title", { name })}
        closeLabel={t("actions.close")}
        // A destructive confirm starts on the safe choice.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancel.current?.focus();
        }}
      >
        <ModalDescription>{t("canvas.index.delete.body")}</ModalDescription>
        <ModalFooter>
          <ModalClose asChild>
            <Button ref={cancel} variant="secondary" size="m">
              {t("actions.cancel")}
            </Button>
          </ModalClose>
          <Button
            variant="danger"
            size="m"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                onOpenChange(false);
              } catch {
                // The toast has said why; the dialog stays so the person can try again.
              } finally {
                setBusy(false);
              }
            }}
          >
            {t("canvas.index.delete.confirm")}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
