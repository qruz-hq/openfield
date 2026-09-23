import { t } from "@openfield/core";
import { Toast, type ToastProps } from "@openfield/ui";
import { toast } from "sonner";

// Every toast is the design's Feedback / Toast: icon, message, optional action and a close button.

export interface NotifyOptions {
  tone?: ToastProps["tone"];
  /** Second line, in the tertiary color. */
  description?: string;
  action?: { label: string; onClick: () => void };
  duration?: number;
}

export function notify(
  message: string,
  { tone = "neutral", description, action, duration }: NotifyOptions = {},
) {
  return toast.custom(
    (id) => (
      <Toast
        tone={tone}
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
