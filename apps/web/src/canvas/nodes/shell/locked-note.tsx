import { t } from "@openfield/core";
import { Button } from "@openfield/ui";
import { Lock, LockOpen } from "lucide-react";
import { useReadOnly } from "../../store/context";
import { useLockActions } from "./use-lock";

// Canvas / Inspector / Locked note (design P4Cv8): at the top of a locked node's side sheet, over
// settings that can't change until it's unlocked. Unlock frees the frame that locks it too.

export function LockedNote({ nodeId }: { nodeId: string }) {
  const { unlock } = useLockActions(nodeId);
  const readOnly = useReadOnly();
  return (
    <div
      data-locked-note
      className="flex w-full items-center gap-10 rounded-10 bg-accent-soft py-8 pr-8 pl-12 inset-ring inset-ring-accent-line"
    >
      <Lock size={14} aria-hidden className="shrink-0 text-accent" />
      <p className="min-w-0 flex-1 text-caption leading-[1.4] text-text-primary">{t("canvas.lock.note")}</p>
      <Button variant="secondary" size="s" icon={LockOpen} disabled={readOnly} onClick={unlock}>
        {t("canvas.lock.unlock")}
      </Button>
    </div>
  );
}
