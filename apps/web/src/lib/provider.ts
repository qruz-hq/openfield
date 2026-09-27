import { type ProviderSummary, safeParseModelKey } from "@openfield/core";
import { PROVIDER_LOGOS, type ProviderLogoId } from "@openfield/ui";

/** The company's logo, when we ship one for it. */
export function logoFor(providerId: string | undefined): ProviderLogoId | undefined {
  return providerId && (PROVIDER_LOGOS as readonly string[]).includes(providerId)
    ? (providerId as ProviderLogoId)
    : undefined;
}

export const providerOfKey = (key: string) => safeParseModelKey(key)?.providerId;

/**
 * Whether a company is early (meta.stable false, §6.2): it shows only with Settings > Experimental
 * on, and its models are never picked for the person.
 */
export function isEarly(
  providers: readonly Pick<ProviderSummary, "id" | "meta">[] | undefined,
  providerId: string,
): boolean {
  return providers?.find((p) => p.id === providerId)?.meta.stable === false;
}

/** "Google" for "google", from the list the server sent; the id itself until that arrives. */
export function companyName(providers: readonly ProviderSummary[] | undefined, providerId: string): string {
  return providers?.find((p) => p.id === providerId)?.meta.displayName ?? providerId;
}
