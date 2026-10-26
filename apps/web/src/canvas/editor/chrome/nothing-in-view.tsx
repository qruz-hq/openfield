import { t } from "@openfield/core";
import { Button, toastClassNames } from "@openfield/ui";
import { type InternalNode, type ReactFlowState, useStoreApi } from "@xyflow/react";
import { ScanEye } from "lucide-react";
import { useEffect, useState } from "react";

// "Nothing in view" (design cS9Pt, §7.4): once no node has been on screen for 400 ms, a toast-shaped
// pill at the top centre offers Back to nodes, which fits the view to the canvas.

const DELAY_MS = 400;

/** How often, at most, a moving view is checked: the pill waits 400 ms anyway. */
const CHECK_MS = 150;

/**
 * True when the canvas has nodes and none of them overlaps the visible area. `hint` is the node
 * that was in view last time: checked first, it usually answers at once.
 */
const isLost = (s: ReactFlowState, hint: { id: string | null }): boolean => {
  const [tx, ty, zoom] = s.transform;
  const view = { x: -tx / zoom, y: -ty / zoom, w: s.width / zoom, h: s.height / zoom };
  if (!s.width || !s.height) return false;
  const inView = (node: InternalNode) => {
    const w = node.measured.width ?? node.width ?? 0;
    const h = node.measured.height ?? node.height ?? 0;
    const { x, y } = node.internals.positionAbsolute;
    return x < view.x + view.w && x + w > view.x && y < view.y + view.h && y + h > view.y;
  };
  const last = hint.id ? s.nodeLookup.get(hint.id) : undefined;
  if (last && !last.hidden && inView(last)) return false;
  let any = false;
  for (const node of s.nodeLookup.values()) {
    if (node.hidden) continue;
    any = true;
    if (inView(node)) {
      hint.id = node.id;
      return false;
    }
  }
  return any;
};

export function NothingInView({ onBack }: { onBack: () => void }) {
  const flow = useStoreApi();
  const [lost, setLost] = useState(false);
  const [shown, setShown] = useState(false);

  // Checked off React Flow's store at most every CHECK_MS, not on every frame of a pan.
  useEffect(() => {
    const hint = { id: null as string | null };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let due = 0;
    const check = () => {
      timer = undefined;
      due = Date.now() + CHECK_MS;
      setLost(isLost(flow.getState(), hint));
    };
    check();
    const unsubscribe = flow.subscribe(() => {
      if (timer) return;
      timer = setTimeout(check, Math.max(0, due - Date.now()));
    });
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, [flow]);

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
