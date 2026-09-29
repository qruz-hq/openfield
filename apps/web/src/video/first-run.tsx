import { type MessageKey, type ProviderSummary, t, tParts } from "@openfield/core";
import { Button, EmptyStatePage, ProviderLogo, Step, StepConnector, Steps } from "@openfield/ui";
import { KeyRound } from "lucide-react";
import { Fragment, type ReactNode, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { GetKeyDialog, guidedProviders } from "../image/get-key-dialog";
import { logoFor } from "../lib/provider";
import { focusPrompt } from "./composer/focus";
import { useVideoComposer } from "./composer/store";

// First run for Video (mirrors image/first-run.tsx, §2.10): no usable video key yet, so the feed
// is a welcome with one job, get a key in place. Only BytePlus makes videos today, so it's the
// only company this ever guides toward.

const STEPS: MessageKey[] = [
  "firstRunVideo.steps.addKey",
  "firstRunVideo.steps.describe",
  "firstRunVideo.steps.generate",
];

function StepRow({ current }: { current: number }) {
  return (
    <Steps aria-label={t("firstRunVideo.title")}>
      {STEPS.map((label, i) => (
        <Fragment key={label}>
          {i > 0 ? <StepConnector /> : null}
          <Step
            state={i < current ? "done" : i === current ? "current" : "upcoming"}
            number={i + 1}
            label={t(label)}
          />
        </Fragment>
      ))}
    </Steps>
  );
}

function Company({ provider, trailing }: { provider: ProviderSummary; trailing?: string }) {
  const logo = logoFor(provider.id);
  return (
    <span className="inline-flex items-center gap-6">
      {logo ? <ProviderLogo provider={logo} /> : null}
      <span className="font-medium text-text-primary">
        {provider.meta.displayName}
        {trailing}
      </span>
    </span>
  );
}

function CompanyLine({ providers }: { providers: readonly ProviderSummary[] }) {
  const [first, second] = providers;
  if (!first) return null;
  const parts = second
    ? tParts<ProviderSummary>("firstRun.body", { first, second })
    : tParts<ProviderSummary>("firstRun.bodyOne", { company: first });

  const nodes: ReactNode[] = [];
  parts.forEach((part, i) => {
    if (typeof part !== "string") {
      const next = parts[i + 1];
      const trailing = typeof next === "string" ? /^[.,]/.exec(next)?.[0] : undefined;
      nodes.push(<Company key={part.id} provider={part} trailing={trailing} />);
      return;
    }
    const text = (i > 0 && typeof parts[i - 1] !== "string" ? part.replace(/^[.,]/, "") : part).trim();
    if (text) nodes.push(<span key={text}>{text}</span>);
  });
  return <span className="inline-flex flex-wrap items-center justify-center gap-6">{nodes}</span>;
}

export function FirstVideoRun({ providers }: { providers: readonly ProviderSummary[] | undefined }) {
  const navigate = useNavigate();
  const [dialog, setDialog] = useState(false);
  const guided = guidedProviders(providers?.filter((p) => p.id === "byteplus"));

  return (
    <div className="flex w-full flex-1 flex-col items-center justify-center gap-56 px-16 pb-162">
      <EmptyStatePage
        title={t("firstRunVideo.title")}
        body={<CompanyLine providers={guided} />}
        actions={
          <>
            <Button
              size="xl"
              icon={KeyRound}
              onClick={() => navigate("/settings/api-keys", { state: { focusKey: true } })}
            >
              {t("firstRun.addKey")}
            </Button>
            {guided.length ? (
              <Button variant="ghost" onClick={() => setDialog(true)}>
                {t("firstRun.whereToGetKey")}
              </Button>
            ) : null}
          </>
        }
      />
      <StepRow current={0} />
      <GetKeyDialog open={dialog} onOpenChange={setDialog} providers={guided} />
    </div>
  );
}

const EXAMPLES: MessageKey[] = [
  "empty.readyVideo.examples.kite",
  "empty.readyVideo.examples.train",
  "empty.readyVideo.examples.waves",
];

/** Key added, nothing made yet: three prompts to start from, and the prompt has focus (§2.7). */
export function FirstVideo() {
  const setPrompt = useVideoComposer((s) => s.setPrompt);
  useEffect(() => focusPrompt(), []);
  return (
    <div className="flex w-full flex-1 flex-col items-center justify-center gap-56 px-16 pb-162">
      <EmptyStatePage title={t("empty.readyVideo.title")} body={t("empty.readyVideo.body")}>
        <ul className="grid w-full grid-cols-3 gap-12">
          {EXAMPLES.map((key) => (
            <li key={key}>
              <button
                type="button"
                onClick={() => {
                  setPrompt(t(key));
                  focusPrompt();
                }}
                className="flex h-full w-full cursor-pointer flex-col gap-8 rounded-14 bg-elevated p-12 text-left inset-ring inset-ring-border transition-shadow hover:inset-ring-border-strong"
              >
                <span className="text-small text-text-primary">{t(key)}</span>
                <span className="text-caption text-text-tertiary">{t("empty.ready.tryThis")}</span>
              </button>
            </li>
          ))}
        </ul>
      </EmptyStatePage>
      <StepRow current={1} />
    </div>
  );
}
