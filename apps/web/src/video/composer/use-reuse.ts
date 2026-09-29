import { isModelKey, type ModelKey, t } from "@openfield/core";
import { useCallback } from "react";
import { notify } from "../../lib/notify";
import { focusPrompt } from "./focus";
import { useVideoComposer } from "./store";

/**
 * Reuse (§0.1): a run's prompt and model into the Video composer without running it. Frames don't
 * carry over: a failed or past run's start and end frame stay with it, not the next one. Whatever
 * was there before comes back with Undo.
 */
export function useVideoReuse() {
  return useCallback(({ prompt, model }: { prompt: string; model: string }) => {
    const before = useVideoComposer.getState();
    const snapshot = { prompt: before.prompt, model: before.model };
    useVideoComposer.setState({ prompt, ...(isModelKey(model) ? { model: model as ModelKey } : {}) });
    focusPrompt();
    if (snapshot.prompt.trim() && snapshot.prompt !== prompt) {
      notify(t("composer.reused"), {
        duration: 8000,
        action: { label: t("actions.undo"), onClick: () => useVideoComposer.setState(snapshot) },
      });
    }
  }, []);
}
