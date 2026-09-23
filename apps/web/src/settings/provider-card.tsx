import {
  type ErrorCode,
  errorCopy,
  type KeyStatus,
  type MessageKey,
  type ModelListItem,
  type ProviderSummary,
  t,
} from "@openfield/core";
import {
  Button,
  KeyInput,
  Modal,
  ModalClose,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModelTag,
  ProviderLogo,
  StatusPill,
  type StatusPillStatus,
  Surface,
} from "@openfield/ui";
import { useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useCheckKey, useRemoveKey } from "../api/hooks/keys";
import { errorMessage } from "../api/raw";
import { defaultPrice } from "../lib/cost";
import { notify, notifyError } from "../lib/notify";
import { logoFor } from "../lib/provider";

// Settings / Provider card / {Connected, Not connected, Key rejected, Checking, Set outside}.

const REJECTED: readonly ErrorCode[] = ["auth_invalid", "auth_forbidden"];

type CheckResult = { ok: true; modelCount?: number } | { ok: false; code: ErrorCode };

type CardStatus = "connected" | "not-connected" | "rejected" | "checking" | "set-outside";

const PILL: Record<CardStatus, { pill: StatusPillStatus; label: MessageKey }> = {
  connected: { pill: "connected", label: "settings.apiKeys.status.connected" },
  "not-connected": { pill: "not-connected", label: "settings.apiKeys.status.notConnected" },
  rejected: { pill: "error", label: "settings.apiKeys.status.rejected" },
  checking: { pill: "checking", label: "settings.apiKeys.status.checking" },
  "set-outside": { pill: "set-outside", label: "settings.apiKeys.status.setOutside" },
};

/** The saved key as the server describes it: dots, then its last four characters. */
const maskedKey = (hint: string | null) => `${"•".repeat(24)}${(hint ?? "").replace(/^[.…•]+/, "")}`;

export interface ProviderCardProps {
  provider: ProviderSummary;
  status: KeyStatus | undefined;
  models: readonly ModelListItem[];
  /** Focus the key field on mount (first run lands here). */
  autoFocus?: boolean;
}

export function ProviderCard({ provider, status, models, autoFocus = false }: ProviderCardProps) {
  const navigate = useNavigate();
  const check = useCheckKey();
  const remove = useRemoveKey();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [result, setResult] = useState<CheckResult | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const helperId = useId();

  const company = provider.meta.displayName;
  const fields = provider.credentials.fields.filter((f) => f.secret);
  const present = status?.present ?? provider.credentialSource !== "unset";
  const outside = (status?.source ?? provider.credentialSource) === "env";
  // While a new key is being typed, a failed check is about that key, not the saved one.
  const savedCode = result && !editing ? (result.ok ? null : result.code) : (status?.lastErrorCode ?? null);
  const checking = check.isPending;

  const state: CardStatus = checking
    ? "checking"
    : outside
      ? "set-outside"
      : savedCode && REJECTED.includes(savedCode) && present
        ? "rejected"
        : present
          ? "connected"
          : "not-connected";
  const editable = !outside && !checking && (editing || state === "not-connected");
  const filled = fields.some((f) => (draft[f.name] ?? "").trim() !== "");

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const startEditing = () => {
    setEditing(true);
    setDraft({});
    setResult(null);
    // The field renders editable on the next frame.
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const runCheck = async () => {
    setResult(null);
    if (filled) setEditing(true);
    try {
      // A typed key goes with the check and is saved only if it works.
      const values = filled
        ? Object.fromEntries(
            Object.entries(draft)
              .map(([name, value]) => [name, value.trim()] as const)
              .filter(([, value]) => value !== ""),
          )
        : {};
      const res = await check.mutateAsync({ providerId: provider.id, values });
      if (res.ok) {
        setResult({ ok: true, modelCount: res.modelCount });
        setEditing(false);
        setDraft({});
        notify(t("firstRun.connected", { company }), {
          tone: "success",
          duration: 8000,
          action: {
            label: t("firstRun.startCreating"),
            onClick: () => navigate("/image", { state: { focusComposer: true } }),
          },
        });
      } else {
        // The typed key stays in the field so it can be fixed, never thrown away.
        setResult({ ok: false, code: res.error?.code ?? "unknown" });
      }
    } catch (error) {
      notifyError(errorMessage(error));
    }
  };

  const confirmRemoval = () => {
    setConfirmRemove(false);
    setEditing(false);
    setDraft({});
    setResult(null);
    remove.mutate(provider.id, { onError: (error) => notifyError(errorMessage(error)) });
  };

  const helper =
    state === "set-outside"
      ? { text: t("settings.apiKeys.setOutside"), tone: "text-text-tertiary" }
      : result && !result.ok
        ? { text: errorCopy(result.code).reason, tone: "text-danger" }
        : state === "rejected"
          ? { text: t("settings.apiKeys.rejected"), tone: "text-danger" }
          : result?.ok
            ? {
                text: t("settings.apiKeys.works", { count: result.modelCount ?? 0 }),
                tone: "text-text-secondary",
              }
            : null;

  const pasteInto = (name: string) => async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setDraft((d) => ({ ...d, [name]: text.trim() }));
    } catch {
      inputRef.current?.focus();
    }
  };

  const keyInputs = fields.map((field, i) => {
    const common = {
      ref: i === 0 ? inputRef : undefined,
      "aria-label": field.label || t("settings.apiKeys.field.placeholder"),
      "aria-describedby": helper ? helperId : undefined,
      revealLabel: t("settings.apiKeys.field.show"),
      hideLabel: t("settings.apiKeys.field.hide"),
    };
    if (state === "set-outside") {
      return (
        <KeyInput
          key={field.name}
          {...common}
          value=""
          locked
          lockedLabel={t("settings.apiKeys.field.locked")}
        />
      );
    }
    if (!editable) {
      // While a typed key is checked it stays in view, masked like a saved one (design bBpDj).
      const typed = checking ? draft[field.name]?.trim() : undefined;
      const masked = typed
        ? maskedKey(typed.slice(-4))
        : i === 0 && present
          ? maskedKey(status?.hint ?? provider.credentialHint)
          : undefined;
      return (
        <KeyInput
          key={field.name}
          {...common}
          value=""
          readOnly
          masked={masked}
          invalid={state === "rejected"}
          disabled={checking}
        />
      );
    }
    return (
      <KeyInput
        key={field.name}
        {...common}
        value={draft[field.name] ?? ""}
        onValueChange={(value) => setDraft((d) => ({ ...d, [field.name]: value }))}
        onKeyDown={(event) => {
          if (event.key === "Escape" && editing) setEditing(false);
        }}
        placeholder={t("settings.apiKeys.field.placeholder")}
        invalid={!!result && !result.ok && REJECTED.includes(result.code)}
        onPasteClick={pasteInto(field.name)}
        pasteLabel={t("settings.apiKeys.field.placeholder")}
      />
    );
  });

  const action = (() => {
    if (state === "checking") {
      return (
        <Button variant="secondary" size="field" disabled>
          {t("settings.apiKeys.status.checking")}
        </Button>
      );
    }
    if (state === "set-outside") {
      return (
        <Button variant="secondary" size="field" onClick={runCheck}>
          {t("settings.apiKeys.actions.check")}
        </Button>
      );
    }
    if (editable) {
      return (
        <>
          <Button size="field" onClick={filled ? runCheck : () => inputRef.current?.focus()}>
            {t(filled ? "settings.apiKeys.actions.check" : "settings.apiKeys.actions.add")}
          </Button>
          {editing ? (
            <Button variant="ghost" size="field" onClick={() => setEditing(false)}>
              {t("actions.cancel")}
            </Button>
          ) : null}
        </>
      );
    }
    if (state === "rejected") {
      return (
        <Button size="field" onClick={startEditing}>
          {t("settings.apiKeys.actions.change")}
        </Button>
      );
    }
    return (
      <>
        <Button variant="secondary" size="field" onClick={startEditing}>
          {t("settings.apiKeys.actions.change")}
        </Button>
        <Button variant="ghost" size="field" onClick={() => setConfirmRemove(true)}>
          {t("settings.apiKeys.actions.remove")}
        </Button>
      </>
    );
  })();

  // A form, so Enter in the key field runs Check key.
  const keyRow = (
    <form
      className="flex w-full items-center gap-8"
      onSubmit={(event) => {
        event.preventDefault();
        if (editable && filled) void runCheck();
      }}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-8">{keyInputs}</div>
      {action}
    </form>
  );

  const logo = logoFor(provider.id);

  return (
    <Surface variant="card" aria-labelledby={`${helperId}-name`} role="group">
      <div className="flex w-full items-center justify-between gap-12">
        <div className="flex items-center gap-12">
          {logo ? <ProviderLogo provider={logo} variant="tile" /> : null}
          <div className="flex flex-col gap-2">
            <span id={`${helperId}-name`} className="text-body-strong text-text-primary">
              {company}
            </span>
            <span className="text-caption text-text-tertiary">{t("settings.apiKeys.tagline")}</span>
          </div>
        </div>
        <StatusPill status={PILL[state].pill} role="status">
          {t(PILL[state].label)}
        </StatusPill>
      </div>
      {helper ? (
        <div className="flex w-full flex-col gap-6">
          {keyRow}
          <p id={helperId} className={`text-caption ${helper.tone}`}>
            {helper.text}
          </p>
        </div>
      ) : (
        keyRow
      )}
      {logo && models.length ? (
        <div className="flex w-full flex-wrap items-center gap-6">
          {models.map((model) => (
            <ModelTag key={model.key} provider={logo} name={model.displayName} price={defaultPrice(model)} />
          ))}
        </div>
      ) : null}

      <Modal open={confirmRemove} onOpenChange={setConfirmRemove}>
        <ModalContent
          alert
          title={t("settings.apiKeys.removeTitle", { company })}
          closeLabel={t("actions.close")}
        >
          <ModalDescription>{t("settings.apiKeys.removeBody")}</ModalDescription>
          <ModalFooter>
            <ModalClose asChild>
              <Button variant="secondary">{t("actions.cancel")}</Button>
            </ModalClose>
            <Button variant="danger" onClick={confirmRemoval}>
              {t("settings.apiKeys.actions.remove")}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Surface>
  );
}
