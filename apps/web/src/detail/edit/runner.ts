import { editOpParamsSchema, t } from "@openfield/core";
import { useQueries } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type EditInput, isTurnedPhoto, useEditRun } from "../../api/hooks/edit";
import { useCancelJobSet } from "../../api/hooks/job-sets";
import { assetDetailQuery } from "../../api/hooks/library";
import { errorMessage } from "../../api/raw";
import { notify, notifyError } from "../../lib/notify";
import { type ResultSlot, type RunOutcome, resultSlots, runOutcome } from "./plan";
import { useEditSession } from "./session";

// The Edit tab's runs, held by the detail view so a run carries on while the person looks at Info
// and comes back. The panel starts them; the media area shows them (the results strip, the
// Generating label); this keeps the last request, so Try again sends it once more.

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
  generate: (request: EditRequest) => void;
  retry: () => void;
  stop: () => void;
  /** Forgets the run, as when another image is shown. */
  reset: () => void;
  /**
   * The last run made new images from the mask and prompt as they are now, so leaving loses
   * nothing that isn't in the library.
   */
  settled: () => boolean;
}

export function useEditRunner(): EditRunner {
  const { run, starting, start, reset: resetRun } = useEditRun();
  const { mutate: cancel } = useCancelJobSet();
  const last = useRef<EditRequest | null>(null);
  // Undefined until the person picks: the first new image. Null is the original.
  const [picked, setPicked] = useState<string | null | undefined>(undefined);

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
          // A phone photo stored on its side: the panel says so in place of the form.
          if (isTurnedPhoto(error)) useEditSession.getState().setTurned(true);
          else notifyError(errorMessage(error));
        },
      });
    },
    [start],
  );

  // The same request again, by the mask it saved while the mask hasn't changed.
  const retry = useCallback(() => {
    const request = last.current;
    if (!request) return;
    const saved = useEditSession.getState().savedMask;
    const mask = saved && saved.version === request.maskVersion ? saved.assetId : request.input.mask;
    generate({ ...request, input: { ...request.input, ...(mask !== undefined && { mask }) } });
  }, [generate]);

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
    setPicked(undefined);
    resetRun();
  }, [resetRun]);

  const runId = run?.jobSet.id;
  const stop = useCallback(() => {
    if (runId) cancel(runId, { onError: (error) => notifyError(errorMessage(error)) });
  }, [runId, cancel]);

  return {
    slots,
    outcome,
    busy: starting || outcome.kind === "working",
    notKept,
    shown: picked === undefined ? done[0] : picked,
    show: setPicked,
    generate,
    retry,
    stop,
    reset,
    settled: () => {
      const request = last.current;
      const { maskVersion, prompt } = useEditSession.getState();
      return (
        outcome.kind === "saved" &&
        request !== null &&
        request.maskVersion === maskVersion &&
        request.prompt === prompt
      );
    },
  };
}
