import { t } from "@openfield/core";
import { Banner, Button } from "@openfield/ui";
import { Copy } from "lucide-react";
import { useMain, useSession } from "../session";

// "Changed elsewhere" (design Ktpf7): another tab saved this canvas first. Nothing is lost either
// way: Keep mine saves this tab's copy over it, Reload takes the other one (§7.8).

export function ConflictBanner() {
  const session = useSession();
  const conflict = useMain((s) => s.persist.conflict);
  if (!conflict) return null;
  return (
    <Banner
      icon={Copy}
      message={t("canvas.editor.conflict.message")}
      className="pointer-events-auto w-560 max-w-[calc(100vw-32px)]"
      actions={
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            size="s"
            className="h-28"
            onClick={() => session.main.getState().actions.keepMine()}
          >
            {t("canvas.editor.conflict.keepMine")}
          </Button>
          <Button variant="secondary" size="s" className="h-28" onClick={() => session.reloadFrom(conflict)}>
            {t("canvas.editor.conflict.reload")}
          </Button>
        </div>
      }
    />
  );
}
