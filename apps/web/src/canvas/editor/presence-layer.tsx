// The seam for multiplayer (§7.11): mounted in the pane today and draws nothing. Once the document
// is backed by a shared doc, it becomes the other people's cursors and selections, with nothing
// above the reducer changing. There is one person in v1, so there's nobody to show.

export function PresenceLayer() {
  return null;
}
