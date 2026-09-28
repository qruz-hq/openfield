import { cn } from "@openfield/ui";
import { Fragment, useEffect } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { TextLink } from "../../engine/links";

// Words that come from a text node, wherever a card or its side sheet shows them (design H6ZURc).
// Each Prompt node's part is its own span; hovering it outlines it and lights the link it comes by
// and the node it comes from (flow/edges.tsx, node-shell.tsx), so it's clear where the words are
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

const light = (part: TextLink) => linkedText.setState({ edgeId: part.edgeId, nodeId: part.nodeId });

/** Puts the lights out, unless another part has taken them since. */
const dim = (edgeId: string) => {
  if (linkedText.getState().edgeId === edgeId) linkedText.setState(NONE);
};

export function LinkedText({ part, className }: { part: TextLink; className?: string }) {
  // A part that goes away while it's hovered (the link removed, the card collapsed) turns them off.
  useEffect(() => () => dim(part.edgeId), [part.edgeId]);
  return (
    <span
      data-linked-edge={part.edgeId}
      className={cn("of-linked", className)}
      onPointerEnter={() => light(part)}
      onPointerLeave={() => dim(part.edgeId)}
    >
      {part.text}
    </span>
  );
}

/**
 * A prompt as it's sent: each Prompt node's words in link order, then the node's own. `separator`
 * is what shows between them: a line break where the text keeps its lines (the side sheet), a space
 * where it runs on and is cut short (a card).
 */
export function LinkedPrompt({
  parts,
  own,
  separator,
}: {
  parts: readonly TextLink[];
  own: string;
  separator: "\n" | " ";
}) {
  const ownText = own.trim();
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={part.edgeId}>
          {i > 0 ? separator : null}
          <LinkedText part={part} />
        </Fragment>
      ))}
      {ownText ? (
        <>
          {parts.length ? separator : null}
          {ownText}
        </>
      ) : null}
    </>
  );
}
