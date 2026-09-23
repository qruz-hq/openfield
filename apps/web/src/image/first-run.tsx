import { type MessageKey, type ProviderSummary, t, tParts } from "@openfield/core";
import { Button, EmptyStatePage, ProviderLogo, Step, StepConnector, Steps } from "@openfield/ui";
import { KeyRound } from "lucide-react";
import { Fragment, type ReactNode, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { logoFor } from "../lib/provider";
import { focusPrompt } from "./composer/focus";
import { useComposer } from "./composer/store";
import { GetKeyDialog, guidedProviders } from "./get-key-dialog";

// First run: no key yet, so the feed is a welcome with one job: get a key in place (§2.10).
// Once a key works and nothing is made yet, the same frame offers a few prompts to start from.

const STEPS: MessageKey[] = ["firstRun.steps.addKey", "firstRun.steps.describe", "firstRun.steps.generate"];

function StepRow({ current }: { current: number }) {
  return (
    <Steps aria-label={t("firstRun.title")}>
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

/** A company inline in a sentence: logo, then its name. Trailing punctuation stays with the name. */
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

/** "Add a key from [Google]. It takes a minute.", laid out 6 apart like the design. */
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

export function FirstRun({ providers }: { providers: readonly ProviderSummary[] | undefined }) {
  const navigate = useNavigate();
  const [dialog, setDialog] = useState(false);
  const guided = guidedProviders(providers);

  return (
    <div className="flex w-full flex-1 flex-col items-center justify-center gap-56 px-16 pb-162">
      <EmptyStatePage
        title={t("firstRun.title")}
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
  "empty.ready.examples.teapot",
  "empty.ready.examples.forest",
  "empty.ready.examples.portrait",
];

/** Key added, nothing made yet: three prompts to start from, and the prompt has focus (§2.7). */
export function FirstImage() {
  const setPrompt = useComposer((s) => s.setPrompt);
  useEffect(() => focusPrompt(), []);
  return (
    <div className="flex w-full flex-1 flex-col items-center justify-center gap-56 px-16 pb-162">
      <EmptyStatePage title={t("empty.ready.title")} body={t("empty.ready.body")}>
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
