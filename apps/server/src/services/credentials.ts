import {
  type CredentialField,
  type CredentialSource,
  type CredentialValues,
  type ErrorCode,
  type KeyPutBody,
  type KeyStatus,
  type KeyTestResponse,
  t,
} from "@openfield/core";
import { type Db, getProvider, listKeyStatus, recordKeyCheck, setProviderCredential } from "@openfield/db";
import { type CallContext, isProviderError, type Provider, ProviderError } from "@openfield/providers/server";
import { ConfigFileError, type ConfigStore, type ProviderConfig } from "../config/config-file";
import { ApiFailure } from "../http/errors";

// Keys live in config.json (0600) or the environment, never in the database or a response
// (§6.11). Precedence per field: environment variable, then config.json, then unset.

export interface ResolvedCredentials {
  values: CredentialValues;
  /** Every required field has a value. */
  present: boolean;
  source: CredentialSource;
  /** The variable in effect when a key comes from the environment. */
  envVar: string | null;
  /** Last four characters of the main secret. */
  hint: string | null;
  /** Fields set by the environment. Settings shows them read-only and never overwrites them. */
  envFields: string[];
}

const REJECTED: readonly ErrorCode[] = ["auth_invalid", "auth_forbidden"];

const hintOf = (value: string | undefined): string | null => (value ? value.slice(-4) : null);

export class CredentialService {
  /** Keys being checked before they're saved. The log hides them too. */
  readonly #checking = new Set<string>();

  constructor(
    private readonly providers: readonly Provider[],
    private readonly config: ConfigStore,
    private readonly env: Record<string, string | undefined>,
    private readonly db: Db,
  ) {}

  provider(id: string): Provider {
    const provider = this.providers.find((p) => p.meta.id === id);
    if (!provider)
      throw new ApiFailure(404, "not_found", `No company called "${id}"`, { field: "providerId" });
    return provider;
  }

  /** `stored` stands in for config.json, for checking a key before it's saved. */
  resolve(
    providerId: string,
    stored: ProviderConfig = this.config.provider(providerId),
  ): ResolvedCredentials {
    const provider = this.provider(providerId);
    const values: CredentialValues = {};
    const envFields: string[] = [];
    let envVar: string | null = null;
    let fromFile = false;

    for (const field of fieldsOf(provider)) {
      const fromEnv = field.envVars.find((name) => this.env[name]?.trim());
      if (fromEnv) {
        values[field.name] = this.env[fromEnv]!.trim();
        envFields.push(field.name);
        envVar ??= fromEnv;
        continue;
      }
      const saved = stored[field.name];
      if (saved) {
        values[field.name] = saved;
        fromFile = true;
      }
    }

    const secrets = provider.credentials.fields.filter((f) => f.secret);
    const present = provider.credentials.fields.filter((f) => f.required).every((f) => values[f.name]);
    const source: CredentialSource = envFields.length ? "env" : fromFile ? "file" : "unset";
    return { values, present, source, envVar, hint: hintOf(values[secrets[0]?.name ?? ""]), envFields };
  }

  status(providerId: string): KeyStatus {
    const cred = this.resolve(providerId);
    const row = listKeyStatus(this.db).find((r) => r.providerId === providerId);
    return {
      providerId,
      present: cred.present,
      source: cred.source,
      hint: cred.hint,
      envVar: cred.envVar,
      lastOkAt: row?.lastOkAt ?? null,
      lastErrorCode: row?.lastError ?? null,
    };
  }

  /**
   * A key that can make images: set, and not rejected on every check so far. A key that worked
   * once and then fails stays usable, so its runs fail with a clear reason instead (§2.10).
   */
  usable(providerId: string): boolean {
    if (!this.resolve(providerId).present) return false;
    const row = getProvider(this.db, providerId);
    return !(row && row.lastOkAt === null && row.lastError !== null && REJECTED.includes(row.lastError));
  }

  statusAll(): KeyStatus[] {
    return this.providers.map((p) => this.status(p.meta.id));
  }

  /** Every loaded secret, from every variable that holds one, for the log redaction filter. */
  secrets(): string[] {
    const out: string[] = [...this.#checking];
    for (const provider of this.providers) {
      const stored = this.config.provider(provider.meta.id);
      for (const field of provider.credentials.fields) {
        if (!field.secret) continue;
        for (const name of field.envVars) {
          const value = this.env[name]?.trim();
          if (value) out.push(value);
        }
        const saved = stored[field.name];
        if (saved) out.push(saved);
      }
    }
    return out;
  }

  /** PUT /api/settings/keys/:providerId. Answers with status only. */
  save(providerId: string, body: KeyPutBody): KeyStatus {
    this.#write(providerId, this.candidate(providerId, body));
    return this.status(providerId);
  }

  /** The values a save would store, checked but not written. Throws what PUT would answer. */
  candidate(providerId: string, body: KeyPutBody): ProviderConfig {
    const provider = this.provider(providerId);
    const fields = new Map(fieldsOf(provider).map((f) => [f.name, f]));
    for (const name of Object.keys(body)) {
      if (!fields.has(name))
        throw new ApiFailure(400, "bad_request", `Unknown field "${name}"`, { field: name });
    }
    const locked = Object.keys(body).filter((name) => this.resolve(providerId).envFields.includes(name));
    if (locked.length) {
      throw new ApiFailure(
        409,
        "conflict",
        "This key is set outside Openfield, so it can't be changed here.",
      );
    }

    const next = { ...this.config.provider(providerId), ...body };
    const problem = provider.validateCredentials(presentValues(next)).find((d) => d.level === "error");
    if (problem) throw new ApiFailure(400, "bad_request", problem.message, { field: problem.field });
    return next;
  }

  #write(providerId: string, values: ProviderConfig): void {
    saving(() =>
      this.config.update((draft) => {
        draft.providers[providerId] = values;
      }),
    );
    this.sync(providerId);
  }

  /** DELETE /api/settings/keys/:providerId. A key set by the environment stays in effect. */
  remove(providerId: string): KeyStatus {
    const provider = this.provider(providerId);
    const secretNames = new Set(provider.credentials.fields.map((f) => f.name));
    const kept = Object.fromEntries(
      Object.entries(this.config.provider(providerId)).filter(([name]) => !secretNames.has(name)),
    );
    saving(() =>
      this.config.update((draft) => {
        if (Object.keys(kept).length) draft.providers[providerId] = kept;
        else delete draft.providers[providerId];
      }),
    );
    this.sync(providerId);
    return this.status(providerId);
  }

  /**
   * POST /api/settings/keys/:providerId/test: one free call that proves the key works. With a
   * candidate, that key is checked instead and written only when it works, so a rejected key never
   * lands in config.json or counts as usable (§2.10 step 5).
   */
  async test(
    providerId: string,
    ctx: CallContext | null,
    candidate?: ProviderConfig,
  ): Promise<KeyTestResponse> {
    const provider = this.provider(providerId);
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    if (!ctx) {
      const err = new ProviderError("auth_missing");
      return { ok: false, latencyMs: 0, error: { code: err.code, message: err.userMessage } };
    }
    const checking = provider.credentials.fields
      .filter((f) => f.secret)
      .flatMap((f) => candidate?.[f.name] ?? []);
    for (const value of checking) this.#checking.add(value);
    let modelCount: number | undefined;
    try {
      ({ modelCount } = await provider.verifyCredentials(ctx));
    } catch (err) {
      const failure = isProviderError(err) ? err : new ProviderError("unknown", { cause: err });
      // A failed candidate says nothing about the key that's saved.
      if (!candidate) recordKeyCheck(this.db, providerId, { ok: false, code: failure.code });
      return { ok: false, latencyMs: elapsed(), error: { code: failure.code, message: failure.userMessage } };
    } finally {
      for (const value of checking) this.#checking.delete(value);
    }
    if (candidate) this.#write(providerId, candidate);
    recordKeyCheck(this.db, providerId, { ok: true });
    return { ok: true, latencyMs: elapsed(), ...(modelCount !== undefined && { modelCount }) };
  }

  /** Records where each key comes from, and its hint, in the providers table. Never the key. */
  sync(providerId?: string): void {
    const ids = providerId ? [providerId] : this.providers.map((p) => p.meta.id);
    for (const id of ids) {
      const cred = this.resolve(id);
      const row = getProvider(this.db, id);
      if (!row || (row.credentialSource === cred.source && row.credentialHint === cred.hint)) continue;
      const ref = cred.source === "env" ? cred.envVar : cred.source === "file" ? `config.json#${id}` : null;
      setProviderCredential(this.db, id, { source: cred.source, ref, hint: cred.hint });
    }
  }
}

/** A config.json write, with a reply the page can show when it fails. */
function saving(write: () => void): void {
  try {
    write();
  } catch (error) {
    if (!(error instanceof ConfigFileError)) throw error;
    throw new ApiFailure(500, "internal", error.message, {
      userMessage: t(error.reason === "private" ? "errors.keyNotPrivate" : "errors.keyNotSaved"),
    });
  }
}

const presentValues = (values: ProviderConfig): CredentialValues =>
  Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null)) as CredentialValues;

function fieldsOf(provider: Provider): CredentialField[] {
  return [...provider.credentials.fields, ...(provider.credentials.options ?? [])];
}
