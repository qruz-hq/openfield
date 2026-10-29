import type { CardView } from "../generate/card-state";

// What the Edit card (design nRuORN2ZyA) changes in the shared card states (generate/card-state.ts).
// Before it has made anything it shows the image coming in, which is no result of its own: no pill
// says it's up to date, and Run waits at rest as on an empty Generate. Waiting for a mask, the card
// is covered (Canvas / Node / Image edit / No mask): the image at full strength under the scrim,
// Paint mask in the middle, and only the top bar on hover (the bottom one stays away, nodes.css).

export interface EditCardInput {
  /** It has images it made. */
  own: boolean;
  /** No mask yet, and nothing running: Paint mask covers the card. */
  covered: boolean;
}

export function editCardView(view: CardView, { own, covered }: EditCardInput): CardView {
  if (covered) {
    return {
      ...view,
      phase: "empty",
      noPill: true,
      pillAtRest: false,
      media: view.media === "placeholder" ? "placeholder" : "image",
      emptyGlyph: false,
      message: false,
      action: "run",
      bottomAtRest: false,
      stripes: false,
    };
  }
  if (own || view.phase !== "done") return view;
  // The image coming in, ready to run.
  return { ...view, phase: "empty", noPill: true, bottomAtRest: true };
}
