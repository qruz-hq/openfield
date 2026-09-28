import { cn } from "@openfield/ui";
import { useEffect } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { TextLink } from "../../engine/links";

// What comes in by a link, wherever a card or its side sheet shows it (design H6ZURc): a Prompt
// node's words, a link's reference images. Hovering one outlines it as one block and lights the link
// it comes by and the node it comes from (flow/edges.tsx, node-shell.tsx), so it's clear where it's
// from. Outside the document: nothing here is saved or undone.

interface Lit {
  edgeId: string | null;
  nodeId: string | null;
}

const NONE: Lit = { edgeId: null, nodeId: null };

export const linkedText = createStore<Lit>(() => NONE);

/** The link whose words are hovered. */
export const useLinkLit = (edgeId: string) => useStore(linkedText, (s) => s.edgeId === edgeId);

/** The node whose words are hovered. */
export const useSourceLit = (nodeId: string) => useStore(linkedText, (s) => s.nodeId === nodeId);

/** A link, as the lights need it: the edge it comes by and the node it comes from. */
export type LinkEnds = Pick<TextLink, "edgeId" | "nodeId">;

const light = (link: LinkEnds) => linkedText.setState({ edgeId: link.edgeId, nodeId: link.nodeId });

/** Puts the lights out, unless another part has taken them since. */
const dim = (edgeId: string) => {
  if (linkedText.getState().edgeId === edgeId) linkedText.setState(NONE);
};

/**
 * Hover handlers for anything that comes in by `link`, for elements that keep their own markup
 * (a reference link's thumbnails). Give the element the `of-linked` class for the outline.
 */
export function useLinkHover(link: LinkEnds) {
  const { edgeId, nodeId } = link;
  // One that goes away while it's hovered (the link removed, the card collapsed) turns them off.
  useEffect(() => () => dim(edgeId), [edgeId]);
  return {
    "data-linked-edge": edgeId,
    onPointerEnter: () => light({ edgeId, nodeId }),
    onPointerLeave: () => dim(edgeId),
  };
}

/** A Prompt node's words: one block, so the outline goes round the whole part, not each line. */
export function LinkedText({ part, className }: { part: TextLink; className?: string }) {
  const hover = useLinkHover(part);
  return (
    <span {...hover} className={cn("of-linked of-linked-words", className)}>
      {part.text}
    </span>
  );
}

/**
 * A prompt as it's sent: each Prompt node's words in link order, then the node's own, each on its
 * own line as the model gets them (PROMPT_JOINER). The parts are blocks, so they start their own
 * lines; the text around keeps the line breaks inside them (white-space: pre-line or pre-wrap).
 */
export function LinkedPrompt({ parts, own }: { parts: readonly TextLink[]; own: string }) {
  const ownText = own.trim();
  return (
    <>
      {parts.map((part) => (
        <LinkedText key={part.edgeId} part={part} />
      ))}
      {ownText || null}
    </>
  );
}
