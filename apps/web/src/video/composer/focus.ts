// The Video composer's prompt field registers itself so other screens can hand focus to it
// (first run's starter prompts, Reuse). Kept separate from the image composer's registry: the two
// pages are never open at once, but each composer owns its own field.

let prompt: HTMLTextAreaElement | null = null;

export function registerPrompt(el: HTMLTextAreaElement | null) {
  prompt = el;
}

export function focusPrompt() {
  if (!prompt) return;
  prompt.focus();
  const end = prompt.value.length;
  prompt.setSelectionRange(end, end);
}
