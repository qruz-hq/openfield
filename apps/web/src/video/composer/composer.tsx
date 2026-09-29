import { type AspectRatio, isModelKey, type ModelListItem, newId, t } from "@openfield/core";
import { aspectLabel, resolveControl } from "@openfield/providers/manifest";
import { AspectGlyph, Chip } from "@openfield/ui";
import {
  Gauge,
  type LucideIcon,
  RectangleHorizontal,
  RectangleVertical,
  Scan,
  Square,
  Timer,
  Volume2,
  VolumeX,
} from "lucide-react";
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { announceStarted } from "../../api/events";
import { useGenerate } from "../../api/hooks/job-sets";
import { useProviders } from "../../api/hooks/keys";
import { findModel, useModels } from "../../api/hooks/models";
import { useRunSpeed } from "../../api/hooks/provider-settings";
import { errorMessage } from "../../api/raw";
import { GenerateButton, type GenerateSpeed } from "../../image/composer/generate-button";
import { ModelSelect } from "../../image/composer/model-select";
import { DisabledChip, OptionChip } from "../../image/composer/option-chip";
import { aspectChoices } from "../../lib/control-choices";
import { notify, notifyError } from "../../lib/notify";
import { companyName } from "../../lib/provider";
import { askToNotifyOnce } from "../../lib/system-notify";
import { focusPrompt, registerPrompt } from "./focus";
import { FrameTile } from "./frame-tile";
import { useVideoComposer } from "./store";
import {
  carryVideoValues,
  expectedVideoSize,
  resolveFor,
  videoGenerateBody,
  videoGenerateState,
} from "./video-values";

// Composer / Video (design pgLPU, TH72Y): the same 1120×146 shell as the image composer, its own
// chips (Model, Aspect, Resolution, Length, Sound) and, in the aside, Start and End frame tiles
// before Generate. Seed and Still camera live in the canvas node's Advanced section only: the page
// composer never shows them, matching the design (§0.3).

const PROMPT_MAX = 112;

function aspectIcon(ratio: AspectRatio | undefined): LucideIcon {
  if (!ratio || ratio === "auto") return Scan;
  const [w, h] = ratio.split(":").map(Number) as [number, number];
  return w === h ? Square : w > h ? RectangleHorizontal : RectangleVertical;
}

export function VideoComposer({ firstRun = false }: { firstRun?: boolean }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [search, setSearch] = useSearchParams();
  const models = useModels("video").data ?? [];
  const providers = useProviders().data;
  const runSpeedFor = useRunSpeed();
  const composer = useVideoComposer();
  const generate = useGenerate();
  const prompt = useRef<HTMLTextAreaElement>(null);

  const anyReady = models.some((m) => m.ready);
  const model = findModel(models, composer.model) ?? models.find((m) => m.ready) ?? models[0];
  const picked = anyReady || composer.model ? model : undefined;
  const caps = (model ?? models[0])?.capabilities.video;
  const resolved = model ? resolveFor(model, composer) : undefined;
  const run = picked ? runSpeedFor(picked) : undefined;
  const speed = run?.speed ?? "standard";
  const state = videoGenerateState({
    model: picked,
    anyReady,
    prompt: composer.prompt,
    resolved,
    speed,
  });
  const generateSpeed: GenerateSpeed | undefined =
    !picked || !run
      ? undefined
      : run.fellBack
        ? {
            fallback: run.name,
            tip: t("speed.fallbackHint", {
              model: picked.displayName,
              speed: run.requestedName,
              standard: run.name,
            }),
          }
        : run.speed !== "standard"
          ? {
              name: run.name,
              tip: t("speed.tooltip", {
                speed: run.name,
                company: companyName(providers, picked.providerId),
              }),
            }
          : undefined;

  const switchTo = (next: ModelListItem) => {
    const before = {
      model: composer.model,
      aspect: composer.aspect,
      resolution: composer.resolution,
      seconds: composer.seconds,
      sound: composer.sound,
    };
    const carried = carryVideoValues(next, before);
    composer.switchModel(next.key, carried.values);
    setSearch(
      (params) => {
        params.set("model", next.key);
        return params;
      },
      { replace: true },
    );
    if (carried.adjusted.length) {
      const changes = carried.adjusted
        .map((a) => t("composer.change", { from: a.from, to: a.to }))
        .join(", ");
      notify(t("composer.adjusted", { count: carried.adjusted.length, model: next.displayName, changes }), {
        duration: 8000,
        action: { label: t("actions.undo"), onClick: () => useVideoComposer.setState(before) },
      });
    }
  };

  const deepLinked = useRef(false);
  useEffect(() => {
    const wanted = search.get("model");
    if (deepLinked.current || !wanted || !models.length) return;
    deepLinked.current = true;
    const target = isModelKey(wanted) ? findModel(models, wanted) : undefined;
    if (target) useVideoComposer.setState({ model: target.key });
    else if (model) notify(t("composer.chips.model.unknown", { model: model.displayName }));
  }, [search, models, model]);

  useEffect(() => {
    if ((location.state as { focusComposer?: boolean } | null)?.focusComposer) focusPrompt();
  }, [location.state]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure whenever the prompt changes
  useLayoutEffect(() => {
    const el = prompt.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, PROMPT_MAX)}px`;
  }, [composer.prompt]);

  const submit = () => {
    if (state.kind === "no-key" && firstRun) return;
    if (state.kind === "no-key" || state.kind === "needs-key") {
      navigate("/settings/api-keys", { state: { focusKey: true } });
      return;
    }
    if (state.kind === "blocked" || !model || !resolved) {
      focusPrompt();
      return;
    }
    if (speed === "batch") askToNotifyOnce();
    const body = videoGenerateBody(model, resolved, composer.prompt, newId());
    generate.mutate(
      { body, placeholder: expectedVideoSize(resolved), speed, modality: "video" },
      { onSuccess: announceStarted, onError: (error) => notifyError(errorMessage(error)) },
    );
  };

  const onPromptKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape") event.currentTarget.blur();
  };

  const onToolbarKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const stops = [
      ...event.currentTarget.querySelectorAll<HTMLElement>(
        'button:not(:disabled):not([tabindex="-1"]), [tabindex="0"]',
      ),
    ];
    const at = stops.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    event.preventDefault();
    stops[(at + (event.key === "ArrowRight" ? 1 : -1) + stops.length) % stops.length]?.focus();
  };

  const aspectControl = model ? resolveControl(model.capabilities, "aspect") : undefined;
  const notes = resolved?.notes.filter((n) => n.level === "warning").map((n) => n.message) ?? [];

  return (
    <div className="fixed bottom-16 left-1/2 z-40 flex min-h-146 w-[min(1120px,calc(100vw-160px))] -translate-x-1/2 rounded-26 bg-surface p-2">
      <form
        aria-label={t("composer.label")}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className="flex min-w-0 flex-1 gap-12 rounded-24 bg-elevated p-22 inset-ring inset-ring-border transition-shadow has-[textarea:focus]:inset-ring-accent-line"
      >
        <div className="flex min-w-0 flex-1 flex-col justify-between gap-12">
          <div className="flex min-h-32 w-full items-center gap-12">
            <textarea
              ref={(el) => {
                prompt.current = el;
                registerPrompt(el);
              }}
              rows={1}
              value={composer.prompt}
              onChange={(event) => composer.setPrompt(event.target.value)}
              onKeyDown={onPromptKey}
              placeholder={t("video.placeholder")}
              aria-label={t("video.placeholder")}
              spellCheck
              className="min-h-20 min-w-0 flex-1 resize-none overflow-y-auto bg-transparent text-body leading-20 text-text-primary outline-none placeholder:text-text-tertiary focus-visible:outline-none"
            />
          </div>
          <div
            role="toolbar"
            aria-label={t("composer.chips.toolbar")}
            onKeyDown={onToolbarKey}
            className="-m-4 flex items-center gap-8 overflow-x-auto p-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            <ModelSelect models={models} selected={picked} onSelect={switchTo} />
            {aspectControl && resolved ? (
              aspectControl.state === "unsupported" ? (
                <DisabledChip
                  icon={aspectIcon(resolved.aspect)}
                  value={aspectLabel(resolved.aspect)}
                  reason={aspectControl.reason ?? ""}
                />
              ) : (
                <OptionChip
                  icon={aspectIcon(resolved.aspect)}
                  label={t("composer.chips.aspect.label")}
                  value={resolved.aspect}
                  valueLabel={aspectLabel(resolved.aspect)}
                  width="w-240"
                  options={aspectChoices(aspectControl).map((choice) => ({
                    ...choice,
                    leading: <AspectGlyph ratio={choice.value} />,
                  }))}
                  onChange={(aspect) => composer.setValues({ aspect })}
                />
              )
            ) : null}
            {caps && resolved ? (
              <OptionChip
                icon={Gauge}
                label={t("composer.chips.resolution.label")}
                value={resolved.video.resolution}
                valueLabel={resolved.video.resolution}
                width="w-240"
                options={caps.resolutions.map((r) => ({ value: r, title: r }))}
                onChange={(resolution) => composer.setValues({ resolution })}
              />
            ) : null}
            {caps && resolved ? (
              <OptionChip
                icon={Timer}
                label={t("video.chips.duration.label")}
                value={String(resolved.video.seconds)}
                valueLabel={t("video.chips.duration.value", { seconds: resolved.video.seconds })}
                width="w-240"
                options={caps.durations.map((s) => ({
                  value: String(s),
                  title: t("video.chips.duration.value", { seconds: s }),
                }))}
                onChange={(value) => composer.setValues({ seconds: Number(value) })}
              />
            ) : null}
            {caps ? (
              caps.audio.supported ? (
                <Chip
                  icon={resolved?.video.audio ? Volume2 : VolumeX}
                  label={t("video.chips.sound.label")}
                  value={resolved?.video.audio ? t("video.chips.sound.on") : t("video.chips.sound.off")}
                  aria-pressed={resolved?.video.audio ?? false}
                  onClick={() => composer.setValues({ sound: !(resolved?.video.audio ?? false) })}
                />
              ) : (
                <DisabledChip
                  icon={VolumeX}
                  value={t("video.chips.sound.label")}
                  reason={t("video.chips.sound.unsupported", { model: model?.displayName ?? "" })}
                />
              )
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-10 self-stretch">
          <FrameTile
            kind="start"
            assetId={composer.startFrame?.assetId}
            onPick={composer.setStartFrame}
            onRemove={() => composer.setStartFrame(null)}
            disabled={!caps?.frames.start}
          />
          {caps?.frames.end ? (
            <FrameTile
              kind="end"
              assetId={composer.endFrame?.assetId}
              onPick={composer.setEndFrame}
              onRemove={() => composer.setEndFrame(null)}
              disabled={!composer.startFrame}
            />
          ) : null}
          <GenerateButton
            state={state}
            firstRun={firstRun}
            working={generate.isPending}
            batch={1}
            speed={generateSpeed}
            onGenerate={submit}
          />
        </div>
      </form>
      {notes.length ? (
        <p className="pointer-events-none absolute -top-28 left-22 text-caption text-text-tertiary">
          {notes.join(" ")}
        </p>
      ) : null}
    </div>
  );
}
