import { absolutePosition, type DocSlice } from "../store";

// Find in canvas (⌘F, §7.4): node titles, prompt and note text, and model names. Matches come back
// in reading order, top to bottom then left to right, so ↵ walks the canvas the way you'd read it.

export interface FindSources {
  /** The type's own label, for nodes without a title. */
  label(type: string): string;
  modelName(key: string): string | undefined;
}

function textsOf(doc: DocSlice, id: string, sources: FindSources): string[] {
  const frame = doc.nodes[id];
  if (!frame) return [];
  const params = doc.params[id] ?? {};
  const out = [frame.title ?? sources.label(frame.type)];
  for (const field of ["text", "prompt"]) {
    const value = params[field];
    if (typeof value === "string") out.push(value);
  }
  if (Array.isArray(params.prompts)) for (const p of params.prompts) if (typeof p === "string") out.push(p);
  const models = [params.model, ...(Array.isArray(params.models) ? params.models : [])];
  for (const key of models) {
    if (typeof key !== "string") continue;
    out.push(sources.modelName(key) ?? key);
  }
  return out;
}

export function findMatches(doc: DocSlice, query: string, sources: FindSources): string[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const hits = doc.order.filter((id) =>
    textsOf(doc, id, sources).some((text) => text.toLocaleLowerCase().includes(needle)),
  );
  return hits
    .map((id) => ({ id, at: absolutePosition(doc, id) }))
    .sort((a, b) => a.at.y - b.at.y || a.at.x - b.at.x)
    .map((h) => h.id);
}
