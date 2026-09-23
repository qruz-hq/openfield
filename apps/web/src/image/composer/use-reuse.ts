import { isModelKey, type ModelKey, t } from "@openfield/core";
import { useCallback } from "react";
import { notify } from "../../lib/notify";
import { focusPrompt } from "./focus";
import { useComposer } from "./store";

/**
 * Reuse (§0.1): load a run's prompt and model into the composer without running it.
 * Whatever was there before comes back with Undo.
 */
export function useReuse() {
  return useCallback(({ prompt, model }: { prompt: string; model: string }) => {
    const before = useComposer.getState();
    const snapshot = { prompt: before.prompt, model: before.model };
    useComposer.setState({ prompt, ...(isModelKey(model) ? { model: model as ModelKey } : {}) });
    focusPrompt();
    if (snapshot.prompt.trim() && snapshot.prompt !== prompt) {
      notify(t("composer.reused"), {
        duration: 8000,
        action: { label: t("actions.undo"), onClick: () => useComposer.setState(snapshot) },
      });
    }
  }, []);
}
