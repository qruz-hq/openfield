import { t } from "@openfield/core";
import { Button, Modal, ModalClose, ModalContent, ModalDescription, ModalFooter } from "@openfield/ui";
import { useRef, useState } from "react";
import { create } from "zustand";

// The library's destructive confirmations on Modal / Shell (design IxNRM, sHp75, rfGxK, pm10A,
// uZPBB): a title, one plain line, Cancel and a red button. Anything in the library can ask one
// with confirm(); only one shows at a time.

export interface ConfirmRequest {
  title: string;
  body: string;
  confirmLabel: string;
  /** Runs on the red button. The dialog closes as soon as it's called. */
  onConfirm: () => void;
}

const useConfirmStore = create<{ request: ConfirmRequest | null; returnFocus: HTMLElement | null }>()(() => ({
  request: null,
  returnFocus: null,
}));

export function confirm(request: ConfirmRequest) {
  // A dialog with no trigger hands focus back nowhere, so it goes back to where the person was.
  const active = document.activeElement;
  useConfirmStore.setState({ request, returnFocus: active instanceof HTMLElement ? active : null });
}

export function ConfirmHost() {
  const request = useConfirmStore((s) => s.request);
  // The last request stays on screen while the dialog animates out.
  const [shown, setShown] = useState<ConfirmRequest | null>(null);
  if (request && request !== shown) setShown(request);
  const cancel = useRef<HTMLButtonElement>(null);
  const close = () => useConfirmStore.setState({ request: null });
  const current = request ?? shown;

  return (
    <Modal open={request !== null} onOpenChange={(open) => (open ? undefined : close())}>
      {current ? (
        <ModalContent
          alert
          title={current.title}
          closeLabel={t("actions.close")}
          // A destructive confirm starts on the safe choice.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancel.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const back = useConfirmStore.getState().returnFocus;
            if (back?.isConnected) back.focus({ preventScroll: true });
          }}
        >
          <ModalDescription>{current.body}</ModalDescription>
          <ModalFooter>
            <ModalClose asChild>
              <Button ref={cancel} variant="secondary" size="m">
                {t("actions.cancel")}
              </Button>
            </ModalClose>
            <Button
              variant="danger"
              size="m"
              onClick={() => {
                close();
                current.onConfirm();
              }}
            >
              {current.confirmLabel}
            </Button>
          </ModalFooter>
        </ModalContent>
      ) : null}
    </Modal>
  );
}
