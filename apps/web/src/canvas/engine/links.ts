import type { NodeEvaluation } from "@openfield/canvas/engine/evaluate";
import { joinPrompt } from "@openfield/canvas/engine/inputs";
import type { PortValue } from "@openfield/canvas/engine/types";
import { incomingEdges } from "@openfield/canvas/store/graph";
import type { DocSlice } from "@openfield/canvas/store/ops";

// What each link into a node hands on, link by link: the images a reference input gets and the
// words a prompt input gets. The card's reference strip, the side sheet's references and the
// linked prompt text all read these, so they can never disagree with each other or with a run.

/** One link into a reference input and the images it hands on, in the order the model gets them. */
export interface ImageLink {
  edgeId: string;
  /** The node it comes from. */
  nodeId: string;
  /** The input it goes into. */
  port: string;
  /** An asset id, or null for an image still to come from that node. */
  images: readonly (string | null)[];
}

/** One link into a prompt input and the words it hands on. */
export interface TextLink {
  edgeId: string;
  nodeId: string;
  text: string;
}

type Evaluated = ReadonlyMap<string, Pick<NodeEvaluation, "outputs" | "definition">>;

/**
 * The images one value stands for. A node upstream hands on its images as still to come, even when
 * it's up to date: its images now, then empty tiles where it has none yet.
 */
export function valueImages(doc: DocSlice, value: PortValue): (string | null)[] {
  if (value.kind === "asset") return [value.assetId];
  if (value.kind !== "pending") return [];
  const now = doc.results[value.nodeId]?.assetIds ?? [];
  const count = Math.max(0, value.expected);
  return Array.from({ length: count }, (_, i) => now[i] ?? null);
}

/** What a link hands on: its source's output on that port, as evaluated (evaluate.ts). */
function handedOn(doc: DocSlice, nodes: Evaluated, source: string, port: string): readonly PortValue[] {
  const upstream = nodes.get(source);
  if (!upstream) return [];
  // A type this build doesn't know hands on whatever images it already made.
  if (!upstream.definition)
    return (doc.results[source]?.assetIds ?? []).map((assetId) => ({ kind: "asset", assetId }));
  return upstream.outputs[port] ?? [];
}

/** Every link into `port`, in connection order, with the images it hands on. */
export function imageLinks(doc: DocSlice, nodes: Evaluated, nodeId: string, port: string): ImageLink[] {
  return incomingEdges(doc, nodeId, port).map((edge) => ({
    edgeId: edge.id,
    nodeId: edge.source,
    port,
    images: handedOn(doc, nodes, edge.source, edge.sourceHandle).flatMap((v) => valueImages(doc, v)),
  }));
}

/** Every link into `port` that hands on words, in connection order, as the joined prompt reads them. */
export function textLinks(doc: DocSlice, nodes: Evaluated, nodeId: string, port: string): TextLink[] {
  return incomingEdges(doc, nodeId, port).flatMap((edge) => {
    const words = handedOn(doc, nodes, edge.source, edge.sourceHandle).flatMap((v) =>
      v.kind === "text" ? [v.text] : [],
    );
    const text = joinPrompt(words);
    return text ? [{ edgeId: edge.id, nodeId: edge.source, text }] : [];
  });
}

/** The images a reference input sends: every link's on a multi input, only the first on a single one. */
export function sentImages(links: readonly ImageLink[], arity: "single" | "multi"): (string | null)[] {
  const all = links.flatMap((link) => link.images);
  return arity === "multi" ? all : all.slice(0, 1);
}
