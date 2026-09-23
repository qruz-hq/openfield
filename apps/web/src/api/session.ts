import { SESSION_HEADER } from "@openfield/core";

// The server mints a token at boot and puts it in index.html as
// <meta name="openfield-session" content="…">. Every /api and /files request carries it (§0.6).

let cached: string | undefined;

const readMeta = (doc: Document) =>
  doc.querySelector<HTMLMetaElement>('meta[name="openfield-session"]')?.content ?? "";

export function sessionToken(): string {
  cached ??= readMeta(document);
  return cached;
}

export function sessionHeaders(): Record<string, string> {
  return { [SESSION_HEADER]: sessionToken() };
}

let renewing: Promise<boolean> | null = null;

/**
 * After a server restart the old token is refused. This page can read the new one from index.html,
 * which a page on another site can't, so it carries on without a reload. True when it changed.
 */
export function renewSessionToken(): Promise<boolean> {
  renewing ??= (async () => {
    try {
      const res = await fetch("/", { cache: "no-store", headers: { accept: "text/html" } });
      if (!res.ok) return false;
      const token = readMeta(new DOMParser().parseFromString(await res.text(), "text/html"));
      if (!token || token === cached) return false;
      cached = token;
      return true;
    } catch {
      return false;
    } finally {
      renewing = null;
    }
  })();
  return renewing;
}
