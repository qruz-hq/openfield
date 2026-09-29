import { t, type UsageSeriesGroup } from "@openfield/core";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useProviders } from "../../api/hooks/keys";
import { modelsQuery } from "../../api/hooks/models";
import { companyName } from "../../lib/provider";
import { OTHER, type SeriesView } from "./view";

// What a series is called, and which company logo sits beside it: a model's name, a company's,
// "2K · High", where the image was made, or the agent app that asked for it.

export interface SeriesLabel {
  name: string;
  /** The company whose logo goes beside the name. */
  providerId?: string | undefined;
}

export function useSeriesLabels(): (series: SeriesView) => SeriesLabel {
  const providers = useProviders();
  // Spending covers every run, images and videos both.
  const models = useQuery(modelsQuery("all"));

  // Quality ids are each model's own ("high", "medium"). Their names come from the models.
  const qualityNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const model of models.data?.models ?? []) {
      for (const level of model.capabilities.quality?.levels ?? []) {
        if (!names.has(level.id)) names.set(level.id, level.label);
      }
    }
    return names;
  }, [models.data]);

  const groupLabel = useCallback(
    (group: UsageSeriesGroup): SeriesLabel => {
      // An agent app's own name, such as "Claude Code", reads better than "Agents".
      if (group.place === "agent" && group.agent) return { name: group.agent };
      if (group.place) return { name: t(`settings.spending.places.${group.place}`) };
      if (group.modelId && group.providerId) {
        const model = models.data?.models.find(
          (m) => m.providerId === group.providerId && m.modelId === group.modelId,
        );
        return { name: model?.displayName ?? group.modelId, providerId: group.providerId };
      }
      if (group.providerId) {
        return { name: companyName(providers.data, group.providerId), providerId: group.providerId };
      }
      const quality = group.quality ? (qualityNames.get(group.quality) ?? capitalize(group.quality)) : null;
      const size = group.resolution ?? null;
      if (size && quality) return { name: t("settings.spending.sizeAndQuality", { size, quality }) };
      return { name: size ?? quality ?? t("settings.spending.defaultSize") };
    },
    [models.data, providers.data, qualityNames],
  );

  return useCallback(
    (series: SeriesView) =>
      series.key === OTHER ? { name: t("settings.spending.other") } : groupLabel(series.groups[0]!),
    [groupLabel],
  );
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
