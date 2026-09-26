import { type ProviderSummary, safeParseModelKey, t } from "@openfield/core";
import { companyName } from "../../../lib/provider";
import type { NodeBlocker } from "../../engine/types";

// The words and the fix for each blocker (the hatched band, §7.5). Fixes are what a person can do
// from here: add a key, pick another model, or turn the company back on.

export type BlockerFix = "add_key" | "pick_model" | "open_settings";

export interface BlockerCopy {
  message: string;
  fix: BlockerFix | null;
  /** The button's label, when there is a fix. */
  action: string | null;
}

/** The company behind a model key, by its display name. */
export const companyOf = (providers: readonly ProviderSummary[] | undefined, model: string | null) => {
  const providerId = model ? safeParseModelKey(model)?.providerId : undefined;
  return providerId ? companyName(providers, providerId) : "";
};

export function blockerCopy(
  blocker: NodeBlocker,
  providers: readonly ProviderSummary[] | undefined,
): BlockerCopy {
  const fix = (kind: BlockerFix, action: string, message: string): BlockerCopy => ({
    message,
    fix: kind,
    action,
  });
  const plain = (message: string): BlockerCopy => ({ message, fix: null, action: null });
  switch (blocker.kind) {
    case "no_key":
      return fix(
        "add_key",
        t("canvas.nodes.blocked.noKeyAction"),
        t("canvas.nodes.blocked.noKey", { company: companyOf(providers, blocker.model) }),
      );
    case "company_off":
      return fix(
        "open_settings",
        t("canvas.nodes.blocked.openSettings"),
        t("canvas.nodes.blocked.companyOff", { company: companyOf(providers, blocker.model) }),
      );
    case "model_unavailable":
      return fix("pick_model", t("canvas.nodes.blocked.pickModel"), t("canvas.nodes.blocked.unavailable"));
    case "references_unsupported":
      return fix("pick_model", t("canvas.nodes.blocked.pickModel"), t("canvas.nodes.blocked.noReferences"));
    case "too_many_references":
      return fix(
        "pick_model",
        t("canvas.nodes.blocked.pickModel"),
        t("canvas.nodes.blocked.tooManyReferences", { max: blocker.max }),
      );
    case "no_prompt":
      return plain(t("canvas.nodes.blocked.noPrompt"));
    case "missing_input":
      return plain(t("canvas.nodes.blocked.missingInput"));
    case "needs_more":
      return plain(
        blocker.what === "prompts"
          ? t("canvas.nodes.blocked.morePrompts", { min: blocker.min })
          : t("canvas.nodes.blocked.moreModels", { min: blocker.min }),
      );
    case "too_many_jobs":
      return plain(t("canvas.nodes.blocked.tooManyJobs", { max: blocker.max }));
    case "missing_asset":
      return plain(t("canvas.nodes.blocked.missingAsset"));
    case "upstream_failed":
      return plain(t("canvas.nodes.blocked.upstreamFailed"));
    case "upstream_blocked":
      return plain(t("canvas.nodes.blocked.upstreamBlocked"));
    case "loop":
      return plain(t("canvas.nodes.blocked.loop"));
  }
}
