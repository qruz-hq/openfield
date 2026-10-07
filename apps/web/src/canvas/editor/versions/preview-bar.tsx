import { formatDateTime, t } from "@openfield/core";
import { Button, Surface } from "@openfield/ui";
import { ArrowLeft, History, Lock } from "lucide-react";
import { useState } from "react";
import { useEditorUi, useSession } from "../session";
import { versionTime } from "./rows";

// Preview bar (design e6PkJ, placed as L4tTB on mM53x): top centre while a version is shown.
// "Viewing a version from 10:42 AM" | Read only · Back to current · Restore this version.

const isToday = (at: string) => new Date(at).toDateString() === new Date().toDateString();

export function PreviewBar() {
  const session = useSession();
  const preview = useEditorUi((s) => s.preview);
  const [busy, setBusy] = useState(false);
  if (!preview) return null;
  const { version } = preview;
  const when = isToday(version.createdAt)
    ? versionTime(version.createdAt)
    : formatDateTime(version.createdAt);

  const restore = async () => {
    setBusy(true);
    try {
      await session.restoreVersion(version.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pointer-events-none absolute inset-x-0 top-12 z-20 flex justify-center mac-window:top-40">
      <Surface variant="floating-bar" role="status" className="pointer-events-auto gap-10 p-8">
        <span className="flex size-32 shrink-0 items-center justify-center rounded-8 bg-elevated-2">
          <History size={16} aria-hidden className="text-text-secondary" />
        </span>
        <span className="flex items-center gap-8 whitespace-nowrap text-body">
          <span className="font-medium text-text-primary">{t("canvas.editor.versions.viewing")}</span>
          <span className="text-text-secondary">{when}</span>
        </span>
        <hr aria-orientation="vertical" className="h-24 w-px shrink-0 border-0 bg-border" />
        <span className="flex items-center gap-6 whitespace-nowrap text-small text-text-tertiary">
          <Lock size={14} aria-hidden />
          {t("canvas.editor.versions.readOnly")}
        </span>
        <Button variant="secondary" size="s" icon={ArrowLeft} onClick={session.exitPreview}>
          {t("canvas.editor.versions.back")}
        </Button>
        <Button variant="primary" size="s" loading={busy} onClick={() => void restore()}>
          {t("canvas.editor.versions.restoreThis")}
        </Button>
      </Surface>
    </div>
  );
}
