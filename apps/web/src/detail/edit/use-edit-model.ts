import type { ModelListItem } from "@openfield/core";
import { useProviders } from "../../api/hooks/keys";
import { useModels } from "../../api/hooks/models";
import { useSettings } from "../../api/hooks/settings";
import { pickEditModel, sketching } from "./plan";
import { useEditSession } from "./session";

/**
 * The model the Edit tab runs: the one picked, else the person's default that can edit. With it,
 * whether Sketch & point is what's open, which the panel and the media area both follow.
 */
export function useEditModel(): { model: ModelListItem | undefined; sketch: boolean } {
  const models = useModels().data ?? [];
  const settings = useSettings().data;
  const providers = useProviders().data;
  const picked = useEditSession((s) => s.model);
  const mode = useEditSession((s) => s.mode);
  const model = pickEditModel(models, picked, settings?.defaultModel, providers);
  return { model, sketch: sketching(mode, model) };
}
