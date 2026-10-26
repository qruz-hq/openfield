import { t } from "@openfield/core";
import { Toast, type ToastProps } from "@openfield/ui";
import { toast } from "sonner";

// Every toast is the design's Feedback / Toast: icon, message, optional action and a close button.

export interface NotifyOptions {
  tone?: ToastProps["tone"];
  /** Another icon than the tone's own. */
  icon?: ToastProps["icon"];
  /** Second line, in the tertiary color. */
  description?: string;
  action?: { label: string; onClick: () => void };
  duration?: number;
}

export function notify(
  message: string,
  { tone = "neutral", icon, description, action, duration }: NotifyOptions = {},
) {
  return toast.custom(
    (id) => (
      <Toast
        tone={tone}
        icon={icon}
        message={message}
        description={description}
        actionLabel={action?.label}
        onAction={
          action
            ? () => {
                action.onClick();
                toast.dismiss(id);
              }
            : undefined
        }
        onClose={() => toast.dismiss(id)}
        closeLabel={t("actions.close")}
      />
    ),
    duration === undefined ? undefined : { duration },
  );
}

export const notifyError = (message: string) => notify(message, { tone: "danger" });

export interface ProgressState {
  message: string;
  description?: string;
  /** 0 to 1. Undefined while the size isn't known yet. */
  progress?: number;
}

export interface ProgressToast {
  /** Redraws the toast. Calls closer than PROGRESS_REDRAW_MS apart are folded into one. */
  update: (next: Partial<ProgressState>) => void;
  /** Takes the toast away. */
  close: () => void;
}

/** Bytes can move thousands of times a second; the toast redraws ten times a second at most. */
const PROGRESS_REDRAW_MS = 100;

/**
 * A toast that stays while long work runs: a spinner, what's happening, the progress line along
 * its bottom and Cancel. It has no close button, so the only way to make it go is to cancel.
 */
export function notifyProgress(initial: ProgressState, onCancel: () => void): ProgressToast {
  let state = initial;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let drawnAt = 0;
  let id: string | number | undefined;

  // The same id redraws the toast in place.
  const draw = () => {
    timer = null;
    if (closed) return;
    drawnAt = Date.now();
    id = toast.custom(
      () => (
        <Toast
          tone="progress"
          message={state.message}
          description={state.description}
          actionLabel={t("actions.cancel")}
          onAction={onCancel}
          progress={state.progress}
        />
      ),
      { ...(id !== undefined && { id }), duration: Number.POSITIVE_INFINITY },
    );
  };
  draw();

  return {
    update(next) {
      state = { ...state, ...next };
      if (closed || timer) return;
      const wait = PROGRESS_REDRAW_MS - (Date.now() - drawnAt);
      if (wait <= 0) draw();
      else timer = setTimeout(draw, wait);
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      if (id !== undefined) toast.dismiss(id);
    },
  };
}
