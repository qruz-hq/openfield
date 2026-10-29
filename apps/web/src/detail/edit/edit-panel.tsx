import {
  type AssetListItem,
  MASK_MAX_PIXELS,
  type ModelListItem,
  newId,
  type PixelSize,
  t,
} from "@openfield/core";
import {
  type EditBase,
  type EditPlan,
  editBody,
  editOpFor,
  editState,
  referenceInputsFor,
  resolveValues,
} from "@openfield/providers/manifest";
import { Button, cn, Divider, Spinner, Tooltip } from "@openfield/ui";
import { useQueries } from "@tanstack/react-query";
import {
  ArrowUpRight,
  CircleAlert,
  CircleCheck,
  ImageOff,
  type LucideIcon,
  Smartphone,
  Sparkles,
  Square,
} from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { useProviders } from "../../api/hooks/keys";
import { assetDetailQuery } from "../../api/hooks/library";
import { useModels } from "../../api/hooks/models";
import { useRunSpeed } from "../../api/hooks/provider-settings";
import { useSettings } from "../../api/hooks/settings";
import { type GenerateSpeed, tooltipFor } from "../../image/composer/generate-button";
import { useAddReference } from "../../image/composer/use-reference";
import { speedFallbackHint, tightCost } from "../../lib/cost";
import { notifyError } from "../../lib/notify";
import { companyName } from "../../lib/provider";
import { askedPrice } from "../../lib/remote-price";
import { KeepRest } from "./keep-rest";
import { encodeMaskPng } from "./mask-png";
import { ModelField } from "./model-field";
import { anyEditReady, pickEditModel, type SavedNote, savedNote, tooLargeToMask } from "./plan";
import { PromptCard } from "./prompt-card";
import type { EditRunner } from "./runner";
import { leaveEdit, useEditSession } from "./session";
import { SizeFields } from "./size-fields";
import { useTurnedPhoto } from "./turned";

// The Edit tab's side of the panel (design gpRcEBbVNM, Image edit / Panel), under the tabs: the
// prompt card, the model, the size fields, a divider, Keep the rest, then the footer at the bottom
// with what became of the last run and Generate. While a run goes the form rests at 45% and
// Generate gives way to its progress and Stop. A phone photo stored on its side gets a note in
// place of the form (Image edit / Rotated photo), and so does an image too large for a mask.

export interface EditPanelProps {
  item: AssetListItem;
  runner: EditRunner;
  /** Shows a new image in the view: Open new image. */
  onOpen: (assetId: string) => void;
}

export function EditPanel({ item, runner, onOpen }: EditPanelProps) {
  const models = useModels().data ?? [];
  const settings = useSettings().data;
  const providers = useProviders().data;
  const runSpeedFor = useRunSpeed();
  const picked = useEditSession((s) => s.model);
  const values = useEditSession((s) => s.values);
  const batch = useEditSession((s) => s.batch);
  // Painted enough for the server to change something, as it reads the mask.
  const masked = useEditSession((s) => s.mask.changes);
  const prompt = useEditSession((s) => s.prompt);
  const references = useEditSession((s) => s.references);
  const composite = useEditSession((s) => s.composite);
  const featherPx = useEditSession((s) => s.featherPx);
  const expandPx = useEditSession((s) => s.expandPx);
  const navigate = useNavigate();
  const turned = useTurnedPhoto(item, true);
  const tooLarge = tooLargeToMask(item);
  // A note stands in for the form: the image can't take a mask.
  const noted = turned || tooLarge;
  // Reading the mask into a PNG, before the run is asked for.
  const [preparing, setPreparing] = useState(false);

  const model = pickEditModel(models, picked, settings?.defaultModel, providers);
  const resolved = model ? resolveValues(model.capabilities, values, batch) : undefined;
  const base: EditBase = { assetId: item.id, width: item.width, height: item.height };
  const plan: EditPlan = { base, masked };
  const run = model ? runSpeedFor(model, editOpFor(model.capabilities, masked)) : undefined;
  const speed = run?.speed ?? "standard";
  const refs = model ? referenceInputsFor(model.capabilities, references) : [];
  // The references' sizes from their details, so their price is the one the run records.
  const referenceSizes = useQueries({
    queries: refs.map((ref) => assetDetailQuery(ref.assetId)),
    combine: (results) =>
      results.flatMap((r): PixelSize[] =>
        r.data ? [{ width: r.data.asset.width, height: r.data.asset.height }] : [],
      ),
  });
  const state = editState({
    model,
    anyReady: anyEditReady(models),
    prompt,
    resolved,
    edit: plan,
    references: refs.length,
    referenceSizes,
    speed,
    askPrice: askedPrice,
  });
  const generateSpeed: GenerateSpeed | undefined =
    !model || !run
      ? undefined
      : run.fellBack
        ? { fallback: run.name, tip: speedFallbackHint(model, run) }
        : run.speed !== "standard"
          ? {
              name: run.name,
              tip: t("speed.tooltip", { speed: run.name, company: companyName(providers, model.providerId) }),
            }
          : undefined;

  const busy = runner.busy || preparing;
  const saved = runner.outcome.kind === "saved";
  const session = useEditSession.getState();

  const pickModel = (next: ModelListItem) => {
    // A model whose company has no key leads to where the key goes, as in the composer (§3.4.1).
    // That leaves the edit, so it asks first when a mask or a prompt would be lost.
    if (!next.ready) leaveEdit(() => navigate("/settings/api-keys", { state: { focusKey: true } }));
    else session.setModel(next.key);
  };

  const submit = () => {
    if (state.kind !== "ready" || !model || !resolved || busy || noted) return;
    const session = useEditSession.getState();
    const editor = session.editor;
    if (!editor) return;
    // What the button showed is what runs, whatever changes while the limit is asked about.
    const settled = {
      composite: session.composite,
      expandPx: session.expandPx,
      featherPx: session.featherPx,
    };
    const words = session.prompt;
    const references = session.references;
    const estimate = state.estimate;
    runner.submit(estimate, async () => {
      const { maskVersion, savedMask } = useEditSession.getState();
      setPreparing(true);
      let mask: Blob | string;
      try {
        // The mask saved for the last run goes again by id while it hasn't changed.
        mask = savedMask?.version === maskVersion ? savedMask.assetId : await encodeMaskPng(editor.mask);
      } catch {
        notifyError(t("edit.generate.failed"));
        return null;
      } finally {
        setPreparing(false);
      }
      return {
        input: {
          baseAssetId: item.id,
          mask,
          body: (maskAssetId) =>
            editBody(model, resolved, words, newId(), {
              base,
              ...(maskAssetId && { mask: { assetId: maskAssetId, ...settled } }),
              references: refs,
            }),
        },
        count: resolved.batch,
        prompt: words,
        maskVersion,
        composite: settled.composite,
        references,
        estimate,
      };
    });
  };

  const note = savedNote(runner.outcome, runner.notKept);
  const hint =
    busy || noted
      ? null
      : state.kind === "blocked"
        ? state.reason
        : state.kind === "no-key" || state.kind === "needs-key"
          ? t("composer.generate.addKeyFirst")
          : null;
  const opened = runner.shown ?? runner.slots.find((s) => s.state === "done")?.assetId ?? null;
  const ready = state.kind === "ready" && !noted;
  const estimate = state.kind === "ready" ? state.estimate : undefined;
  const tip = ready ? tooltipFor(estimate, generateSpeed) : undefined;
  const generate = (
    <Button
      icon={Sparkles}
      price={ready && estimate ? tightCost(estimate) : undefined}
      disabled={!ready || preparing}
      onClick={submit}
      className="w-full"
    >
      {t(saved ? "edit.generate.again" : "edit.generate.label")}
    </Button>
  );

  return (
    <>
      {turned ? (
        <CantMaskNote
          assetId={item.id}
          icon={Smartphone}
          title={t("edit.turned.title")}
          body={t("edit.turned.body")}
        />
      ) : tooLarge ? (
        <CantMaskNote
          assetId={item.id}
          icon={ImageOff}
          title={t("edit.tooLarge.title")}
          body={t("edit.tooLarge.body", {
            width: item.width,
            height: item.height,
            megapixels: MASK_MAX_PIXELS / 1_000_000,
          })}
        />
      ) : (
        <>
          <PromptCard model={model} resting={busy} />
          <ModelField
            models={models}
            selected={model}
            base={base}
            composite={composite}
            resting={busy}
            onPick={pickModel}
          />
          <SizeFields
            model={model}
            resolved={resolved}
            base={base}
            masked={masked}
            composite={composite}
            speed={speed}
            resting={busy}
            onValues={session.setValues}
            onBatch={session.setBatch}
          />
          <Divider className="w-full" />
          <KeepRest
            composite={composite}
            featherPx={featherPx}
            expandPx={expandPx}
            resting={busy}
            afterRun={saved}
            onComposite={session.setComposite}
            onFeatherPx={session.setFeatherPx}
            onExpandPx={session.setExpandPx}
          />
        </>
      )}
      {/* Footer: a column at the panel's bottom, 10 apart. */}
      <div className="flex w-full flex-1 flex-col justify-end gap-10">
        {note && !busy && !noted ? <SavedNoteRow note={note} /> : null}
        {hint ? (
          <p className="w-full text-center text-caption font-normal text-text-tertiary">{hint}</p>
        ) : null}
        {saved && opened && !busy && !noted ? (
          <Button
            variant="secondary"
            size="l"
            icon={ArrowUpRight}
            onClick={() => onOpen(opened)}
            className="w-full"
          >
            {t("edit.generate.open")}
          </Button>
        ) : null}
        {runner.busy ? (
          <Working count={runner.slots.length} onStop={runner.stop} />
        ) : tip ? (
          <Tooltip content={tip}>{generate}</Tooltip>
        ) : (
          generate
        )}
      </div>
    </>
  );
}

/** Image edit / Saved note: the check, or the alert in danger when not all of it went as asked. */
function SavedNoteRow({ note }: { note: SavedNote }) {
  const Icon = note.tone === "done" ? CircleCheck : CircleAlert;
  return (
    <div role="status" className="flex w-full items-center gap-8 px-2">
      <Icon
        size={14}
        aria-hidden
        className={cn("shrink-0", note.tone === "done" ? "text-text-secondary" : "text-danger")}
      />
      <p className="min-w-0 flex-1 text-caption text-text-secondary">{note.text}</p>
    </div>
  );
}

/** Image edit / Generate / Working: the spinner, how many are on their way, and Stop. */
function Working({ count, onStop }: { count: number; onStop: () => void }) {
  return (
    <div className="flex h-40 w-full items-center gap-10">
      <Spinner size={16} className="text-text-secondary" />
      <span role="status" className="min-w-0 flex-1 text-small font-medium text-text-secondary">
        {t("edit.generate.working", { count })}
      </span>
      <Button variant="secondary" size="m" icon={Square} onClick={onStop}>
        {t("edit.generate.stop")}
      </Button>
    </div>
  );
}

/**
 * Image edit / Rotated photo, in place of the form: a phone photo stored on its side can't take a
 * mask yet (masks.turned), though it can still go into a new image as a reference. An image past
 * the mask's size limit says so the same way.
 */
function CantMaskNote({
  assetId,
  icon: Icon,
  title,
  body,
}: {
  assetId: string;
  icon: LucideIcon;
  title: string;
  body: string;
}) {
  const addReference = useAddReference();
  return (
    <div className="flex w-full shrink-0 flex-col items-center rounded-14 bg-surface px-16 py-28">
      {/* Message */}
      <div className="flex w-full flex-col items-center gap-12">
        <div className="flex size-40 items-center justify-center rounded-full bg-elevated-2">
          <Icon size={18} aria-hidden className="text-text-tertiary" />
        </div>
        <div className="flex w-full flex-col items-center gap-4">
          <p className="w-full text-center text-body-strong text-text-primary">{title}</p>
          <p className="w-full text-center text-small leading-[1.45] text-text-secondary">{body}</p>
        </div>
        <Button variant="ghost" size="s" onClick={() => addReference(assetId)}>
          {t("edit.turned.useAsReference")}
        </Button>
      </div>
    </div>
  );
}
