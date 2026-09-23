import { t } from "@openfield/core";
import { readLocal, writeLocal } from "./storage";

// System notifications for finished Batch runs (§2.4). Browsers only ask from a click, so the
// first Batch Generate asks, once per browser. Denied or missing, the toast alone carries it.

const ASKED = "openfield.notifications.asked";

const supported = () => typeof window !== "undefined" && "Notification" in window;

/** Call inside the Generate click of a Batch run. Asks at most once, and never throws. */
export function askToNotifyOnce(): void {
  if (!supported() || Notification.permission !== "default" || readLocal(ASKED)) return;
  writeLocal(ASKED, "1");
  try {
    // Older Safari takes a callback and returns nothing.
    const asked = Notification.requestPermission() as Promise<NotificationPermission> | undefined;
    asked?.catch(() => {});
  } catch {
    // Some browsers refuse outright. The toast still shows.
  }
}

/** Shows "Openfield" with `body`. A repeat for the same run replaces the earlier one. */
export function systemNotify(body: string, opts: { tag: string; onClick: () => void }): void {
  if (!supported() || Notification.permission !== "granted") return;
  try {
    const notification = new Notification(t("app.name"), { body, tag: opts.tag });
    notification.onclick = () => {
      window.focus();
      opts.onClick();
      notification.close();
    };
  } catch {
    // Some browsers only allow notifications from a service worker.
  }
}
