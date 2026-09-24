import { t } from "@openfield/core";
import { Button, toastClassNames } from "@openfield/ui";
import { type ReactFlowState, useStore } from "@xyflow/react";
import { ScanEye } from "lucide-react";
import { useEffect, useState } from "react";

// "Nothing in view" (design cS9Pt, §7.4): once no node has been on screen for 400 ms, a toast-shaped
// pill at the top centre offers Back to nodes, which fits the view to the canvas.

const DELAY_MS = 400;

/** True when the canvas has nodes and none of them overlaps the visible area. */
const selectLost = (s: ReactFlowState): boolean => {
  const [tx, ty, zoom] = s.transform;
  const view = { x: -tx / zoom, y: -ty / zoom, w: s.width / zoom, h: s.height / zoom };
  if (!s.width || !s.height) return false;
  let any = false;
  for (const node of s.nodeLookup.values()) {
    if (node.hidden) continue;
    any = true;
    const w = node.measured.width ?? node.width ?? 0;
    const h = node.measured.height ?? node.height ?? 0;
    const { x, y } = node.internals.positionAbsolute;
    if (x < view.x + view.w && x + w > view.x && y < view.y + view.h && y + h > view.y) return false;
  }
  return any;
};

export function NothingInView({ onBack }: { onBack: () => void }) {
  const lost = useStore(selectLost);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!lost) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(true), DELAY_MS);
    return () => clearTimeout(timer);
  }, [lost]);

  if (!shown) return null;
  return (
    <div role="status" className={`${toastClassNames.toast} pointer-events-auto animate-pop-in`}>
      <ScanEye size={16} aria-hidden className="shrink-0 text-text-secondary" />
      <span className="text-small text-text-primary">{t("canvas.editor.nothingInView")}</span>
      <Button variant="ghost" size="s" onClick={onBack}>
        {t("canvas.editor.backToNodes")}
      </Button>
    </div>
  );
}
