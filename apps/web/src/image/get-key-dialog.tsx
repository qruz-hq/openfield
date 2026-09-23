import { type MessageKey, type ProviderSummary, t } from "@openfield/core";
import {
  Button,
  Modal,
  ModalClose,
  ModalContent,
  ModalDescription,
  ProviderLogo,
  Step,
  Steps,
  Surface,
} from "@openfield/ui";
import { ArrowUpRight } from "lucide-react";
import { logoFor } from "../lib/provider";

// Dialog · Where to get a key: one block per company with a link to its key page.

const GUIDES: Record<string, { for: MessageKey; go: MessageKey; steps: MessageKey[] }> = {
  openai: {
    for: "getKey.openai.for",
    go: "getKey.openai.go",
    steps: ["getKey.openai.step1", "getKey.openai.step2", "getKey.openai.step3"],
  },
  google: {
    for: "getKey.google.for",
    go: "getKey.google.go",
    steps: ["getKey.google.step1", "getKey.google.step2", "getKey.google.step3"],
  },
};

/** Companies we can walk someone through, in the order the server lists them. */
export const guidedProviders = (providers: readonly ProviderSummary[] | undefined) =>
  (providers ?? []).filter((p) => p.id in GUIDES);

export function GetKeyDialog({
  open,
  onOpenChange,
  providers,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providers: readonly ProviderSummary[];
}) {
  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent title={t("getKey.title")} closeLabel={t("actions.close")} className="w-560">
        <div className="flex w-full flex-col gap-12">
          <ModalDescription>{t(providers.length > 1 ? "getKey.intro" : "getKey.introOne")}</ModalDescription>
          {providers.map((provider) => {
            const guide = GUIDES[provider.id]!;
            const logo = logoFor(provider.id);
            return (
              <Surface key={provider.id} variant="block" className="w-full">
                <div className="flex w-full items-center justify-between gap-12">
                  <div className="flex items-center gap-12">
                    {logo ? <ProviderLogo provider={logo} variant="tile" /> : null}
                    <div className="flex flex-col gap-2">
                      <span className="text-body-strong text-text-primary">{provider.meta.displayName}</span>
                      <span className="text-caption text-text-tertiary">{t(guide.for)}</span>
                    </div>
                  </div>
                  <Button asChild variant="secondary" size="s" icon={ArrowUpRight}>
                    <a href={provider.meta.consoleUrl} target="_blank" rel="noreferrer">
                      {t(guide.go)}
                    </a>
                  </Button>
                </div>
                <Steps className="w-full flex-col items-start gap-8 pt-4 pl-5">
                  {guide.steps.map((step, i) => (
                    <Step key={step} state="upcoming" number={i + 1} label={t(step)} />
                  ))}
                </Steps>
              </Surface>
            );
          })}
        </div>
        <div className="flex w-full items-center justify-between gap-16">
          <p className="flex-1 text-small leading-[1.45] text-text-tertiary">{t("getKey.cost")}</p>
          <ModalClose asChild>
            <Button>{t("actions.done")}</Button>
          </ModalClose>
        </div>
      </ModalContent>
    </Modal>
  );
}
