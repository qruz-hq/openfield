import { type CostEstimate, formatMoney, formatPrice, t, tParts } from "@openfield/core";
import { Button, Modal, ModalClose, ModalContent, ModalDescription, ModalFooter } from "@openfield/ui";
import { type ReactNode, useCallback, useRef, useState } from "react";
import { useSettings } from "../../api/hooks/settings";
import { fetchSpentThisMonth } from "../../api/hooks/usage";

// The monthly spending limit for the Edit tab's Generate (§6.9): a run that would take this month
// past the limit set in Settings > Spending asks first (Dialog / Spend limit, design d2drT0), as a
// canvas run does. Under the limit, or with none set, Generate runs at once.

interface Ask {
  cost: number;
  limit: number;
  go: () => void;
}

export function useSpendGuard() {
  const limit = useSettings().data?.spendGuardUsd ?? null;
  const [ask, setAsk] = useState<Ask | null>(null);

  const check = useCallback(
    async (estimate: CostEstimate | undefined, go: () => void) => {
      if (limit === null) return go();
      // An unknown price counts as nothing on top, as on the canvas.
      const cost = estimate && estimate.confidence !== "unknown" ? estimate.max : 0;
      const spent = await fetchSpentThisMonth().catch(() => 0);
      if (spent + cost >= limit) setAsk({ cost, limit, go });
      else go();
    },
    [limit],
  );

  const dialog = (
    <SpendGuardDialog
      ask={ask}
      onClose={() => setAsk(null)}
      onConfirm={() => {
        ask?.go();
        setAsk(null);
      }}
    />
  );
  return { check, dialog };
}

/**
 * A sentence with its amount in mono, wherever the language puts it. `spaced` trims the words for a
 * row that spaces them itself (the title's 6 gap).
 */
const withMono = (parts: ReactNode[], spaced = false) =>
  parts.map((part, i) => {
    if (typeof part !== "string") return part;
    const text = spaced ? part.trim() : part;
    // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed sentence.
    return text ? <span key={i}>{text}</span> : null;
  });

function SpendGuardDialog({
  ask,
  onClose,
  onConfirm,
}: {
  ask: Ask | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  // The last one stays on screen while the dialog animates out.
  const shown = useRef<Ask | null>(null);
  if (ask) shown.current = ask;
  const current = ask ?? shown.current;
  const mono = (value: string) => (
    <span key="amount" className="font-mono">
      {value}
    </span>
  );
  return (
    <Modal open={ask !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      {current ? (
        <ModalContent
          title={
            <span className="flex items-center gap-6">
              {withMono(
                tParts<ReactNode>("spendGuard.title", { cost: mono(formatPrice(current.cost)) }),
                true,
              )}
            </span>
          }
          closeLabel={t("actions.close")}
        >
          <ModalDescription>
            {withMono(tParts<ReactNode>("spendGuard.body", { limit: mono(formatMoney(current.limit)) }))}
          </ModalDescription>
          <ModalFooter>
            <ModalClose asChild>
              <Button variant="secondary" size="m">
                {t("spendGuard.cancel")}
              </Button>
            </ModalClose>
            <Button size="m" onClick={onConfirm}>
              {t("spendGuard.confirm")}
            </Button>
          </ModalFooter>
        </ModalContent>
      ) : null}
    </Modal>
  );
}
