import { t } from "@openfield/core";
import { Button, cn, Divider, GroupLabel, IconButton, Spinner, Surface } from "@openfield/ui";
import { BookmarkPlus, History, X } from "lucide-react";
import { useMemo } from "react";
import { useCanvasVersions } from "../../../api/hooks/canvas-doc";
import { useAuthedImage } from "../../../api/hooks/images";
import { thumbPath } from "../../nodes/shell/thumb";
import { useEditorUi, useMain, useSession } from "../session";
import { groupVersions, type VersionRow } from "./rows";

// Version history (design mM53x, drawer pmK69 on Surface / Panel / Side): 354 wide, padding 12,
// gap 12. Header, Save version, the day-grouped list, then the footnote. Picking a row previews
// it read-only in the pane; the picked row offers Restore.

export function VersionsDrawer() {
  const session = useSession();
  const versions = useCanvasVersions(session.canvasId, true);
  const previewing = useEditorUi((s) => s.preview?.version.id ?? null);
  const nodeCount = useMain((s) => s.doc.order.length);
  const edgeCount = useMain((s) => s.doc.edgeOrder.length);
  const coverAssetId = useMain((s) => newestImage(s.doc.order, s.doc.results));

  const groups = useMemo(
    () => groupVersions(versions.data ?? [], { nodeCount, edgeCount, coverAssetId }),
    [versions.data, nodeCount, edgeCount, coverAssetId],
  );

  const close = () => {
    session.exitPreview();
    session.main.getState().actions.closeDrawer();
  };

  return (
    <Surface
      variant="panel"
      role="complementary"
      aria-label={t("canvas.editor.versions.title")}
      className="h-full w-354"
    >
      <div className="flex w-full items-center gap-8 pt-2 pr-2 pl-6">
        <History size={16} aria-hidden className="shrink-0 text-text-secondary" />
        <h2 className="min-w-0 flex-1 text-body-strong text-text-primary">
          {t("canvas.editor.versions.title")}
        </h2>
        <IconButton icon={X} label={t("canvas.editor.versions.close")} onClick={close} />
      </div>
      <Button
        variant="secondary"
        icon={BookmarkPlus}
        className="w-full"
        onClick={() => session.ui.setState({ saveVersionOpen: true })}
      >
        {t("canvas.editor.versions.save")}
      </Button>
      <div className="flex min-h-0 w-full flex-1 flex-col gap-4 overflow-y-auto">
        {groups.map((group) => (
          <section key={group.key} className="flex w-full flex-col gap-4">
            <GroupLabel>{group.label}</GroupLabel>
            <div className="flex w-full flex-col gap-2 px-4">
              {group.rows.map((row) => (
                <Row
                  key={row.version?.id ?? "current"}
                  row={row}
                  selected={row.version ? row.version.id === previewing : previewing === null}
                />
              ))}
            </div>
          </section>
        ))}
        {versions.isPending ? (
          <div className="flex justify-center py-12 text-text-tertiary">
            <Spinner size={16} />
          </div>
        ) : null}
        {versions.isError ? (
          <div className="flex items-center justify-between gap-8 px-12 py-8">
            <span className="text-small text-text-secondary">{t("canvas.editor.versions.loadFailed")}</span>
            <Button variant="secondary" size="s" onClick={() => void versions.refetch()}>
              {t("actions.tryAgain")}
            </Button>
          </div>
        ) : null}
      </div>
      <Divider />
      <p className="w-full text-caption leading-[1.45] text-text-tertiary">
        {t("canvas.editor.versions.footnote")}
      </p>
    </Surface>
  );
}

function Row({ row, selected }: { row: VersionRow; selected: boolean }) {
  const session = useSession();
  const version = row.version;
  const open = () => {
    if (!version) session.exitPreview();
    else void session.previewVersion(version);
  };
  return (
    <div
      className={cn(
        "group flex min-h-56 w-full items-center gap-10 rounded-10 px-8 transition-colors",
        selected && version ? "bg-accent-soft" : "hover:bg-elevated-2",
      )}
    >
      <button
        type="button"
        onClick={open}
        aria-current={selected || undefined}
        className="flex min-h-56 min-w-0 flex-1 cursor-pointer items-center gap-10 py-8 text-left"
      >
        <Thumb assetId={row.coverAssetId} />
        <span className="flex min-w-0 flex-1 flex-col gap-2">
          <span className="truncate text-small font-medium text-text-primary">{row.title}</span>
          {/* A named version's time and counts wrap beside Restore rather than being cut off. */}
          <span className="line-clamp-2 text-caption text-text-tertiary">{row.meta}</span>
        </span>
      </button>
      {selected && version ? (
        <Button variant="ghost" size="s" onClick={() => void session.restoreVersion(version.id)}>
          {t("canvas.editor.versions.restore")}
        </Button>
      ) : null}
    </div>
  );
}

/** 40×40, radius 8, a 1 px $border line. Without an image, a small dotted tile like the pane. */
function Thumb({ assetId }: { assetId: string | null }) {
  const image = useAuthedImage(assetId ? thumbPath(assetId, 40) : null);
  return (
    <span className="relative size-40 shrink-0 overflow-hidden rounded-8 bg-canvas inset-ring inset-ring-border">
      {assetId && image.status === "ready" ? (
        <img src={image.src} alt="" className="size-full object-cover" />
      ) : (
        <span className="absolute inset-0 bg-[radial-gradient(var(--of-grid-dot)_1px,transparent_1px)] bg-size-[8px_8px]" />
      )}
    </span>
  );
}

/** The newest image any node made, for the current canvas's row. */
export function newestImage(
  order: readonly string[],
  results: Readonly<Record<string, { assetIds: readonly string[]; ranAt: string | null } | null>>,
): string | null {
  let best: { id: string; at: string } | null = null;
  for (const id of order) {
    const result = results[id];
    const asset = result?.assetIds[0];
    if (!asset) continue;
    const at = result.ranAt ?? "";
    if (!best || at > best.at) best = { id: asset, at };
  }
  return best?.id ?? null;
}
