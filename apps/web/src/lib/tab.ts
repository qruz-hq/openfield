// This tab's id (§7.11): new on every page load, so a duplicated tab is never taken for its original.
// The server knows the tab by it while its event stream is open, and sends ui.navigate to it.

function mint(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `tab-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export const tabId: string = mint();
