import type { NodeBlocker } from "@openfield/canvas";
import { type ProviderSummary, safeParseModelKey, t } from "@openfield/core";

// What a blocked node's band says (apps/web blocker-copy.ts), for runs compiled on the server, so an
// agent hears the same reason a person reads on the node.

export function blockerMessage(blocker: NodeBlocker, providers: readonly ProviderSummary[]): string {
  const company = (model: string | null) => {
    const providerId = model ? safeParseModelKey(model)?.providerId : undefined;
    const provider = providers.find((p) => p.id === providerId);
    return provider?.meta.displayName ?? providerId ?? "";
  };
  switch (blocker.kind) {
    case "no_key":
      return t("canvas.nodes.blocked.noKey", { company: company(blocker.model) });
    case "company_off":
      return t("canvas.nodes.blocked.companyOff", { company: company(blocker.model) });
    case "model_unavailable":
      return t("canvas.nodes.blocked.unavailable");
    case "references_unsupported":
      return t("canvas.nodes.blocked.noReferences");
    case "too_many_references":
      return t("canvas.nodes.blocked.tooManyReferences", { max: blocker.max });
    case "end_frame_unsupported":
      return t("canvas.nodes.blocked.noEndFrame");
    case "no_prompt":
      return t("canvas.nodes.blocked.noPrompt");
    case "missing_input":
      return t("canvas.nodes.blocked.missingInput");
    case "needs_more":
      return blocker.what === "prompts"
        ? t("canvas.nodes.blocked.morePrompts", { min: blocker.min })
        : t("canvas.nodes.blocked.moreModels", { min: blocker.min });
    case "too_many_jobs":
      return t("canvas.nodes.blocked.tooManyJobs", { max: blocker.max });
    case "missing_asset":
      return t("canvas.nodes.blocked.missingAsset");
    case "upstream_failed":
      return t("canvas.nodes.blocked.upstreamFailed");
    case "upstream_blocked":
      return t("canvas.nodes.blocked.upstreamBlocked");
    case "loop":
      return t("canvas.nodes.blocked.loop");
  }
}
