import {
  type Capabilities,
  formatLocale,
  isEarly,
  isModelKey,
  type ModelListItem,
  newId,
  t,
} from "@openfield/core";
import {
  type ControlResolution,
  carryValues,
  expectedSize,
  generateBody,
  generateState,
  qualityLabel,
  referenceInputsFor,
  resolveValues,
  visibleControls,
} from "@openfield/providers/manifest";
import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { announceStarted } from "../../api/events";
import { useGenerate } from "../../api/hooks/job-sets";
import { useProviders } from "../../api/hooks/keys";
import { findModel, useModels } from "../../api/hooks/models";
import { useRunSpeed } from "../../api/hooks/provider-settings";
import { useSettings } from "../../api/hooks/settings";
import { errorMessage } from "../../api/raw";
import { speedFallbackHint } from "../../lib/cost";
import { notify, notifyError } from "../../lib/notify";
import { companyName } from "../../lib/provider";
import { askedPrice } from "../../lib/remote-price";
import { askToNotifyOnce } from "../../lib/system-notify";
import { ControlChip } from "./control-chip";
import { focusPrompt, registerPrompt } from "./focus";
import { GenerateButton, type GenerateSpeed } from "./generate-button";
import { ModelSelect } from "./model-select";
import { ReferenceRow, referenceNote, useReferenceUploads } from "./references";
import { useComposer } from "./store";

// Composer / Full: 1120×146, floating 16 above the bottom, and the prompt grows it upward (§3.1).
// Chips come from the model's manifest through resolveControl(). Controls that don't work yet
// (Enhance, styles and characters) stay hidden rather than shown inert (§0.15). Reference images
// sit in a row above the prompt and come in through the + after them, a drop on the composer, or
// a paste into the prompt (§3.2).

const PROMPT_MAX = 112;

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
  const uploads = useReferenceUploads(composer.addReferences);
  const [dropping, setDropping] = useState(false);

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
  const state = generateState({
    model: picked,
    anyReady,
    prompt: composer.prompt,
    resolved,
    speed,
    askPrice: askedPrice,
  });
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
    const references = referenceInputsFor(model.capabilities, composer.references);
    const body = generateBody(model, resolved, composer.prompt, newId(), references);
    generate.mutate(
      { body, placeholder: expectedSize(model.capabilities, resolved), speed, modality: "image" },
      {
        onSuccess: announceStarted,
        onError: (error) => notifyError(errorMessage(error)),
      },
    );
    // The prompt and every setting stay as they are, ready to run again (§3.6).
  };

  // Pasted images become references; any text in the same paste still lands in the prompt.
  const onPromptPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files];
    if (!files.length) return;
    if (!event.clipboardData.getData("text/plain")) event.preventDefault();
    void uploads.upload(files);
  };

  const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes("Files");
  const onDragOver = (event: DragEvent<HTMLFormElement>) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    setDropping(true);
  };
  const onDragLeave = (event: DragEvent<HTMLFormElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false);
  };
  const onDrop = (event: DragEvent<HTMLFormElement>) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    setDropping(false);
    void uploads.upload([...event.dataTransfer.files]);
  };

  const note = referenceNote(picked, composer.references.length);

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

  return (
    <div className="fixed bottom-16 left-1/2 z-40 flex min-h-146 w-[min(1120px,calc(100vw-160px))] -translate-x-1/2 rounded-26 bg-surface p-2">
      <form
        aria-label={t("composer.label")}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className="relative flex min-w-0 flex-1 gap-12 rounded-24 bg-elevated p-22 inset-ring inset-ring-border transition-shadow has-[textarea:focus]:inset-ring-accent-line"
      >
        <div className="flex min-w-0 flex-1 flex-col justify-between gap-12">
          {/* The references and the + first, above the prompt, like a Generate node's card (iy0ZN). */}
          <div className="flex w-full min-w-0 flex-col gap-12">
            <ReferenceRow
              store={composer}
              model={picked}
              pending={uploads.pending}
              onUpload={uploads.upload}
            />
            <textarea
              ref={(el) => {
                prompt.current = el;
                registerPrompt(el);
              }}
              rows={1}
              value={composer.prompt}
              onChange={(event) => composer.setPrompt(event.target.value)}
              onKeyDown={onPromptKey}
              onPaste={onPromptPaste}
              placeholder={t("composer.placeholder")}
              aria-label={t("composer.placeholder")}
              spellCheck
              className="min-h-20 w-full min-w-0 resize-none overflow-y-auto bg-transparent text-body leading-20 text-text-primary outline-none placeholder:text-text-tertiary focus-visible:outline-none"
            />
          </div>
          <div
            role="toolbar"
            aria-label={t("composer.chips.toolbar")}
            onKeyDown={onToolbarKey}
            className="-m-4 flex items-center gap-8 overflow-x-auto p-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            <ModelSelect models={models} selected={picked} onSelect={switchTo} />
            {caps && resolved
              ? controls
                  .filter((c) => c.id !== "model")
                  .map((control) => (
                    <ControlChip
                      key={control.id}
                      control={control}
                      caps={caps}
                      resolved={resolved}
                      model={picked}
                      speed={speed}
                      onValues={composer.setValues}
                      onBatch={composer.setBatch}
                    />
                  ))
              : null}
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
        {dropping ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-24 border-2 border-dashed border-accent bg-elevated/90 text-small font-medium text-text-primary">
            {t("composer.dropOverlay")}
          </div>
        ) : null}
      </form>
      {note ? (
        <p className="pointer-events-none absolute -top-28 left-22 text-caption text-text-tertiary">{note}</p>
      ) : null}
    </div>
  );
}
