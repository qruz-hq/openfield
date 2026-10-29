import { type CostEstimate, editOpParamsSchema, isTerminalState, t } from "@openfield/core";
import { useQueries } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type EditInput, isTurnedPhoto, useEditRun } from "../../api/hooks/edit";
import { assetDetailQuery } from "../../api/hooks/library";
import { errorMessage } from "../../api/raw";
import { notify, notifyError } from "../../lib/notify";
import { comparedResult, type ResultSlot, type RunOutcome, resultSlots, runOutcome } from "./plan";
import { useEditSession } from "./session";
import { useSpendGuard } from "./spend-guard";

// The Edit tab's runs, held by the detail view so a run carries on while the person looks at Info
// and comes back. The panel starts them; the media area shows them (the results strip, the
// Generating label); this keeps the last request, so Try again sends it once more. Both go past
// the monthly spending limit first, and only one goes at a time.

export interface EditRequest {
  input: EditInput;
  /** How many images it asks for, held in the results strip until the run says. */
  count: number;
  /** The mask's version when it was read, to know whether the mask saved for it still matches. */
  maskVersion: number;
  /** What it asked for, to tell whether the edit has moved on since. */
  prompt: string;
  /** Keep the rest of the image was asked for. */
  composite: boolean;
  /** The edit's references when it was asked for, to tell whether the edit has moved on since. */
  references: readonly string[];
  /** What Generate showed, for the spending limit. */
  estimate: CostEstimate | undefined;
}

export interface EditRunner {
  /** The run's images, or their places while it's being asked for. */
  slots: ResultSlot[];
  outcome: RunOutcome;
  /** Saving the mask, asking for the edit, or running it: the form rests. */
  busy: boolean;
  /** A result the rest of the image couldn't be put back on exactly, though it was asked. */
  notKept: boolean;
  /**
   * The new image picked in the results strip, else the first one; null when the original is
   * picked, undefined before there's anything to pick.
   */
  shown: string | null | undefined;
  show: (assetId: string | null) => void;
  /** The new image the media area compares with the original; null while it paints. */
  compared: string | null;
  /**
   * Generate: past the spending limit with `estimate`, then `prepare` builds the request (it reads
   * the mask), and the run is asked for. Does nothing while another is on its way or running.
   */
  submit: (estimate: CostEstimate | undefined, prepare: () => Promise<EditRequest | null>) => void;
  retry: () => void;
  stop: () => void;
  /** Forgets the run, as when another image is shown. */
  reset: () => void;
  /** The spending limit's dialog, for the view to render. */
  dialog: ReactNode;
}

export function useEditRunner(): EditRunner {
  const {
    run,
    starting,
    start,
    stop,
    reset: resetRun,
  } = useEditRun({ onStopFailed: (error) => notifyError(errorMessage(error)) });
  const guard = useSpendGuard();
  const last = useRef<EditRequest | null>(null);
  // Undefined until the person picks: the first new image. Null is the original.
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  // From Generate (or Try again) to the end of its run, so a second click does nothing. A ref, as
  // that click can land before any render. The button stays as it is meanwhile: turning it off
  // would drop its focus to the page.
  const inFlight = useRef(false);

  const generate = useCallback(
    (request: EditRequest) => {
      last.current = request;
      setPicked(undefined);
      useEditSession.getState().setTurned(false);
      start(request.input, {
        onSuccess: ({ maskAssetId }) => {
          if (maskAssetId) useEditSession.getState().setSavedMask(maskAssetId, request.maskVersion);
        },
        onError: (error) => {
          inFlight.current = false;
          // A phone photo stored on its side: the panel says so in place of the form.
          if (isTurnedPhoto(error)) useEditSession.getState().setTurned(true);
          else notifyError(errorMessage(error));
        },
      });
    },
    [start],
  );

  const { check } = guard;
  const submit = useCallback(
    (estimate: CostEstimate | undefined, prepare: () => Promise<EditRequest | null>) => {
      if (inFlight.current) return;
      inFlight.current = true;
      void check(
        estimate,
        async () => {
          const request = await prepare().catch(() => null);
          if (request) generate(request);
          else inFlight.current = false;
        },
        () => {
          inFlight.current = false;
        },
      );
    },
    [check, generate],
  );

  // The same request again, by the mask it saved while the mask hasn't changed.
  const retry = useCallback(() => {
    const request = last.current;
    if (!request) return;
    const saved = useEditSession.getState().savedMask;
    const mask = saved && saved.version === request.maskVersion ? saved.assetId : request.input.mask;
    submit(request.estimate, async () => ({
      ...request,
      input: { ...request.input, ...(mask !== undefined && { mask }) },
    }));
  }, [submit]);

  // The run has ended: Generate can go again.
  useEffect(() => {
    if (run && isTerminalState(run.jobSet.status)) inFlight.current = false;
  }, [run]);

  const count = last.current?.count ?? 0;
  const slots = useMemo(
    () =>
      run
        ? resultSlots(run)
        : starting
          ? Array.from({ length: count }, (_, i) => ({
              jobId: `asking-${i}`,
              state: "working" as const,
              assetId: null,
            }))
          : [],
    [run, starting, count],
  );
  const outcome = useMemo(() => runOutcome(run), [run]);

  // New images from the mask, words and references as they were asked for: those are in the
  // library now, so leaving the edit as it is loses nothing.
  useEffect(() => {
    const request = last.current;
    if (outcome.kind !== "saved" || !request) return;
    useEditSession.getState().setKept({
      maskVersion: request.maskVersion,
      prompt: request.prompt,
      references: request.references,
    });
  }, [outcome.kind]);

  // None of it worked: say so once, with Try again (design WWx6tU4fem).
  const told = useRef<string | null>(null);
  useEffect(() => {
    if (!run || outcome.kind !== "failed" || told.current === run.jobSet.id) return;
    told.current = run.jobSet.id;
    notify(t("edit.generate.failed"), {
      tone: "danger",
      action: { label: t("actions.tryAgain"), onClick: retry },
    });
  }, [run, outcome.kind, retry]);

  // Whether the rest of the image was put back: each new image's details say (opParams.edit).
  const done = slots.flatMap((s) => (s.state === "done" && s.assetId ? [s.assetId] : []));
  const asked = last.current?.composite ?? false;
  const details = useQueries({
    queries: done.map((id) => ({ ...assetDetailQuery(id), enabled: asked })),
  });
  const notKept =
    asked &&
    details.some((detail) => {
      const edit = editOpParamsSchema.safeParse(detail.data?.asset.opParams?.edit);
      return edit.success && !edit.data.composite.applied && edit.data.composite.reason !== "off";
    });

  const reset = useCallback(() => {
    last.current = null;
    inFlight.current = false;
    setPicked(undefined);
    resetRun();
  }, [resetRun]);

  const shown = picked === undefined ? done[0] : picked;
  return {
    slots,
    outcome,
    busy: starting || outcome.kind === "working",
    notKept,
    shown,
    show: setPicked,
    compared: comparedResult(outcome, shown),
    submit,
    retry,
    stop,
    reset,
    dialog: guard.dialog,
  };
}
