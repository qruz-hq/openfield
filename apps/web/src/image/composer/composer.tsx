import {
  type AspectRatio,
  type Capabilities,
  formatLocale,
  isModelKey,
  type ModelListItem,
  newId,
  t,
} from "@openfield/core";
import { type ControlResolution, visibleControls } from "@openfield/providers/manifest";
import { AspectGlyph, StepperChip, Tooltip } from "@openfield/ui";
import {
  Dices,
  Gauge,
  Gem,
  type LucideIcon,
  RectangleHorizontal,
  RectangleVertical,
  Scan,
  Square,
} from "lucide-react";
import { type KeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { announceStarted } from "../../api/events";
import { useGenerate } from "../../api/hooks/job-sets";
import { useProviders } from "../../api/hooks/keys";
import { findModel, useModels } from "../../api/hooks/models";
import { useRunSpeed } from "../../api/hooks/provider-settings";
import { useSettings } from "../../api/hooks/settings";
import { errorMessage } from "../../api/raw";
import { aspectChoices, qualityChoices, resolutionChoices } from "../../lib/control-choices";
import {
  aspectLabel,
  carryValues,
  expectedSize,
  generateBody,
  generateState,
  qualityLabel,
  resolveValues,
} from "../../lib/controls";
import { speedFallbackHint } from "../../lib/cost";
import { notify, notifyError } from "../../lib/notify";
import { companyName, isEarly } from "../../lib/provider";
import { askToNotifyOnce } from "../../lib/system-notify";
import { focusPrompt, registerPrompt } from "./focus";
import { GenerateButton, type GenerateSpeed } from "./generate-button";
import { ModelSelect } from "./model-select";
import { DisabledChip, OptionChip } from "./option-chip";
import { useComposer } from "./store";

// Composer / Full: 1120×146, floating 16 above the bottom, and the prompt grows it upward (§3.1).
// Chips come from the model's manifest through resolveControl(). Controls that don't work yet
// (attach, Enhance, styles and characters) stay hidden rather than shown inert (§0.15).

const PROMPT_MAX = 112;

function aspectIcon(ratio: AspectRatio | undefined): LucideIcon {
  if (!ratio || ratio === "auto") return Scan;
  const [w, h] = ratio.split(":").map(Number) as [number, number];
  return w === h ? Square : w > h ? RectangleHorizontal : RectangleVertical;
}

const list = (items: string[]) =>
  new Intl.ListFormat(formatLocale(), { style: "short", type: "unit" }).format(items);

/**
 * With no model picked, chips borrow a model's options only to keep the bar's shape (design
 * X8MbHO). Anything that speaks for that model (Seed's reason, "~" marks, greyed options) stays out.
 */
function neutral(controls: (ControlResolution & { id: string })[]) {
  return controls
    .filter((c) => c.id !== "seed" && c.state !== "unsupported")
    .map(({ unavailable: _u, reason: _r, ...c }) => ({
      ...c,
      state: c.state === "emulated" || c.state === "partial" ? ("supported" as const) : c.state,
    }));
}

export function Composer({ firstRun = false }: { firstRun?: boolean }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [search, setSearch] = useSearchParams();
  const models = useModels().data ?? [];
  const settings = useSettings().data;
  const providers = useProviders().data;
  const runSpeedFor = useRunSpeed();
  const composer = useComposer();
  const generate = useGenerate();
  const prompt = useRef<HTMLTextAreaElement>(null);

  const anyReady = models.some((m) => m.ready);
  // The picked model, else the default the server chose when the first key worked, else any ready
  // one from a company that isn't early.
  const model =
    findModel(models, composer.model) ??
    findModel(models, settings?.defaultModel) ??
    models.find((m) => m.ready && !isEarly(providers, m.providerId));
  const picked = anyReady || composer.model ? model : undefined;
  // With no model yet, chips preview the first model's so the bar keeps its shape.
  const caps: Capabilities | undefined = (model ?? models[0])?.capabilities;
  const resolved = caps
    ? resolveValues(
        caps,
        { aspect: composer.aspect, resolution: composer.resolution, quality: composer.quality },
        composer.batch,
        settings?.defaultAspect,
      )
    : undefined;
  const controls = useMemo(() => {
    const all = caps ? visibleControls(caps) : [];
    return picked ? all : neutral(all);
  }, [caps, picked]);
  // Speed comes only from the company's settings (§0.3); prices here follow it.
  const run = picked ? runSpeedFor(picked) : undefined;
  const speed = run?.speed ?? "standard";
  const state = generateState({ model: picked, anyReady, prompt: composer.prompt, resolved, speed });
  const generateSpeed: GenerateSpeed | undefined =
    !picked || !run
      ? undefined
      : run.fellBack
        ? { fallback: run.name, tip: speedFallbackHint(picked, run) }
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
    const from = model?.capabilities;
    const before = {
      model: composer.model,
      aspect: composer.aspect,
      resolution: composer.resolution,
      quality: composer.quality,
      batch: composer.batch,
    };
    const carried = carryValues(next.capabilities, before, before.batch, { quality: qualityLabel }, from);
    composer.switchModel(next.key, carried.values, carried.batch);
    setSearch(
      (params) => {
        params.set("model", next.key);
        return params;
      },
      { replace: true },
    );
    if (carried.adjusted.length) {
      const changes = list(carried.adjusted.map((a) => t("composer.change", { from: a.from, to: a.to })));
      notify(t("composer.adjusted", { count: carried.adjusted.length, model: next.displayName, changes }), {
        duration: 8000,
        action: { label: t("actions.undo"), onClick: () => useComposer.setState(before) },
      });
    }
  };

  // Deep link: /image?model=<providerId>:<modelId> (§2.1). An unknown key falls back with a toast.
  const deepLinked = useRef(false);
  useEffect(() => {
    const wanted = search.get("model");
    if (deepLinked.current || !wanted || !models.length) return;
    deepLinked.current = true;
    const target = isModelKey(wanted) ? findModel(models, wanted) : undefined;
    if (target) useComposer.setState({ model: target.key });
    else if (model) notify(t("composer.chips.model.unknown", { model: model.displayName }));
  }, [search, models, model]);

  // "Start creating" and the first-image prompts hand focus here.
  useEffect(() => {
    if ((location.state as { focusComposer?: boolean } | null)?.focusComposer) focusPrompt();
  }, [location.state]);

  // Grow with the text from one line to 112px, then scroll inside (§3.2). Also runs when the
  // text changes from outside the field (Reuse, a starter prompt).
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure whenever the prompt changes
  useLayoutEffect(() => {
    const el = prompt.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, PROMPT_MAX)}px`;
  }, [composer.prompt]);

  const submit = () => {
    // First run has its own Add a key button, so Generate just waits (design dYvSS).
    if (state.kind === "no-key" && firstRun) return;
    if (state.kind === "no-key" || state.kind === "needs-key") {
      navigate("/settings/api-keys", { state: { focusKey: true } });
      return;
    }
    if (state.kind === "blocked" || !model || !resolved) {
      focusPrompt();
      return;
    }
    // Browsers only ask from a click, and a Batch run's finish is worth a system notification.
    if (speed === "batch") askToNotifyOnce();
    const body = generateBody(model, resolved, composer.prompt, newId());
    generate.mutate(
      { body, placeholder: expectedSize(model.capabilities, resolved), speed },
      {
        onSuccess: announceStarted,
        onError: (error) => notifyError(errorMessage(error)),
      },
    );
    // The prompt and every setting stay as they are, ready to run again (§3.6).
  };

  const onPromptKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape") event.currentTarget.blur();
  };

  // Chips are one toolbar: ←/→ move between them, Tab leaves (§3.3).
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

  const chip = (control: ControlResolution & { id: string }) => {
    if (!caps || !resolved) return null;
    const unsupported = control.state === "unsupported";
    switch (control.id) {
      case "aspect": {
        const icon = aspectIcon(resolved.aspect);
        const label = resolved.aspect ? aspectLabel(resolved.aspect) : "";
        if (unsupported)
          return <DisabledChip key="aspect" icon={icon} value={label} reason={control.reason ?? ""} />;
        return (
          <OptionChip
            key="aspect"
            icon={icon}
            label={t("composer.chips.aspect.label")}
            value={resolved.aspect}
            valueLabel={label}
            width="w-240"
            emulated={control.state === "emulated"}
            options={aspectChoices(control).map((choice) => ({
              ...choice,
              leading: <AspectGlyph ratio={choice.value} />,
            }))}
            onChange={(aspect) => composer.setValues({ aspect })}
          />
        );
      }
      case "resolution": {
        const value = resolved.resolution ?? "";
        if (unsupported)
          return <DisabledChip key="resolution" icon={Gauge} value={value} reason={control.reason ?? ""} />;
        return (
          <OptionChip
            key="resolution"
            icon={Gauge}
            label={t("composer.chips.resolution.label")}
            value={resolved.resolution}
            valueLabel={value}
            width="w-240"
            options={picked ? resolutionChoices(picked, control, resolved, speed) : []}
            onChange={(resolution) => composer.setValues({ resolution })}
          />
        );
      }
      case "quality": {
        const value = resolved.quality ? qualityLabel(caps, resolved.quality) : "";
        if (unsupported)
          return <DisabledChip key="quality" icon={Gem} value={value} reason={control.reason ?? ""} />;
        return (
          <OptionChip
            key="quality"
            icon={Gem}
            label={t("composer.chips.quality.label")}
            value={resolved.quality}
            valueLabel={value}
            width="w-300"
            options={picked ? qualityChoices(picked, control, resolved, speed) : []}
            onChange={(quality) => composer.setValues({ quality })}
          />
        );
      }
      case "batch": {
        const emulated = control.state === "emulated";
        const stepper = (
          <StepperChip
            key="batch"
            emulated={emulated}
            value={resolved.batch}
            min={1}
            max={control.max ?? caps.batch.max}
            onValueChange={composer.setBatch}
            label={t("composer.chips.batch.label")}
            decrementLabel={t("composer.chips.batch.fewer")}
            incrementLabel={t("composer.chips.batch.more")}
          />
        );
        return emulated ? (
          <Tooltip key="batch" content={t("composer.chips.batch.emulated")}>
            {stepper}
          </Tooltip>
        ) : (
          stepper
        );
      }
      case "seed":
        return unsupported ? (
          <DisabledChip
            key="seed"
            icon={Dices}
            value={t("composer.chips.seed.label")}
            reason={control.reason ?? ""}
          />
        ) : null;
      default:
        // Enhance, Avoid, Background, Advanced and the rest have no popover yet, so no chip.
        return null;
    }
  };

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
          {/* 32 tall like the design's row, whose attach button sets its height (P9NcBs). */}
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
              placeholder={t("composer.placeholder")}
              aria-label={t("composer.placeholder")}
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
            {controls.filter((c) => c.id !== "model").map(chip)}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-10 self-stretch">
          <GenerateButton
            state={state}
            firstRun={firstRun}
            working={generate.isPending}
            batch={resolved?.batch ?? 1}
            speed={generateSpeed}
            onGenerate={submit}
          />
        </div>
      </form>
    </div>
  );
}
