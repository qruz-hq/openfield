import { canonicalJson, hashCanonical } from "@openfield/core";
import type { NodeRegistry } from "../nodes/registry";
import { incomingEdges, isLocked, topoOrder } from "../store/graph";
import type { DocSlice } from "../store/ops";
import type { EngineContext, EngineNode, FingerprintInput } from "./types";

// Fingerprints (§0.11, M4-16): sha256 over typeId, typeVersion, normalized params, model key,
// manifest version and the upstream fingerprints in port order. The digest is async, so every
// node also gets a synchronous key built the same way from its upstream keys. Staleness can then
// show within the frame: a key seen before maps straight to its digest, a new one reads as
// "pending" (never equal to a saved result) until the digest lands.
//
// A locked node's images don't change, so its fingerprint is the one they were made with: nodes
// after it stay up to date whatever happens above it, and unlocking brings its own back.

export const PENDING_PREFIX = "pending:";
export const isPendingFingerprint = (fp: string | undefined): boolean => !!fp?.startsWith(PENDING_PREFIX);

interface Entry {
  id: string;
  /** Canonical JSON of this node's own inputs, upstream nodes referenced by their keys. */
  local: string;
  key: string;
  base: Omit<FingerprintInput, "upstream">;
  /** [port, upstream node ids in edge order] in the type's port order. */
  upstream: [string, string[]][];
  /** A locked node's: the fingerprint its images were made with. */
  fixed?: string;
}

export interface FingerprintPlan {
  /** Data nodes in dependency order. Nodes in or behind a loop get none. */
  order: string[];
  entries: ReadonlyMap<string, Entry>;
}

/** cyrb53, twice with different seeds: a fast 106-bit sync hash for keys. Not for security. */
function syncHash(text: string): string {
  const run = (seed: number) => {
    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  };
  return `${run(0)}.${run(0x9e3779b9)}`;
}

export function engineNode(
  doc: DocSlice,
  id: string,
  registry: NodeRegistry,
  ctx: EngineContext,
): EngineNode {
  const frame = doc.nodes[id]!;
  const raw = doc.params[id] ?? {};
  const def = registry.get(frame.type);
  return {
    id,
    type: frame.type,
    typeVersion: frame.typeVersion,
    title: frame.title,
    params: def ? (def.parseParams(raw, ctx) as Record<string, unknown>) : { ...raw },
    result: doc.results[id] ?? null,
  };
}

/** The synchronous half: what every data node's fingerprint is made of. */
export function planFingerprints(doc: DocSlice, registry: NodeRegistry, ctx: EngineContext): FingerprintPlan {
  const { order } = topoOrder(doc);
  const entries = new Map<string, Entry>();
  const out: string[] = [];

  for (const id of order) {
    const frame = doc.nodes[id];
    if (!frame) continue;
    const def = registry.get(frame.type);
    if (def?.annotation) continue;
    const node = engineNode(doc, id, registry, ctx);

    const fixed = isLocked(doc, id) ? node.result?.fingerprint : null;
    if (fixed) {
      const local = canonicalJson({ locked: fixed });
      const base = {
        typeId: frame.type,
        typeVersion: frame.typeVersion,
        params: {},
        modelKey: null,
        manifestVersion: null,
      };
      entries.set(id, { id, local, key: syncHash(local), base, upstream: [], fixed });
      out.push(id);
      continue;
    }

    let base: Entry["base"];
    let ports: string[];
    if (def?.engine) {
      const fp = def.engine.fingerprintParams(node, ctx);
      base = {
        typeId: frame.type,
        typeVersion: frame.typeVersion,
        params: fp.params,
        modelKey: fp.model,
        manifestVersion: fp.manifestVersion,
      };
      ports = def.ports.filter((p) => p.direction === "in").map((p) => p.id);
    } else {
      // A type this build doesn't know still passes its result on, so its images count too.
      base = {
        typeId: frame.type,
        typeVersion: frame.typeVersion,
        params: { params: node.params, result: node.result?.assetIds ?? [] },
        modelKey: null,
        manifestVersion: null,
      };
      ports = [...new Set(incomingEdges(doc, id).map((e) => e.targetHandle))].sort();
    }

    const upstream: [string, string[]][] = ports.map((port) => [
      port,
      incomingEdges(doc, id, port)
        .map((e) => e.source)
        .filter((source) => entries.has(source)),
    ]);
    const local = canonicalJson({
      ...base,
      upstream: upstream.map(([port, ids]) => [port, ids.map((s) => entries.get(s)!.key)]),
    });
    entries.set(id, { id, local, key: syncHash(local), base, upstream });
    out.push(id);
  }
  return { order: out, entries };
}

/** Digests keyed by a node's local canonical input. Survives passes, so unchanged nodes cost nothing. */
export type FingerprintCache = Map<string, string>;

/** Typing makes a new entry per keystroke for a node and everything below it; old ones go first. */
const CACHE_LIMIT = 20_000;

/** What's known right now: digests where cached, a pending marker for nodes still hashing. */
export function knownFingerprints(plan: FingerprintPlan, cache: FingerprintCache): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of plan.order) {
    const entry = plan.entries.get(id)!;
    out[id] = entry.fixed ?? cache.get(entry.local) ?? `${PENDING_PREFIX}${entry.key}`;
  }
  return out;
}

/** Every digest, hashing only what the cache doesn't have yet. */
export async function resolveFingerprints(
  plan: FingerprintPlan,
  cache: FingerprintCache,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const id of plan.order) {
    const entry = plan.entries.get(id)!;
    let digest = entry.fixed ?? cache.get(entry.local);
    if (!digest) {
      const input: FingerprintInput = {
        ...entry.base,
        upstream: entry.upstream.map(([port, ids]) => [port, ids.map((s) => out[s]!)] as const),
      };
      digest = await hashCanonical(input);
      cache.set(entry.local, digest);
      if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    }
    out[id] = digest;
  }
  return out;
}
