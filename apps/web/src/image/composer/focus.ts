// The prompt field registers itself so other screens can hand focus to it
// (first run's "Start creating", Reuse, a starter prompt).

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
