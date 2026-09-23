import { createJSONStorage } from "zustand/middleware";

// localStorage can throw (private windows, blocked site data). Persisted stores fall back to
// memory, so the app still works, it just forgets on reload.

const memory = new Map<string, string>();

const guarded: Storage = {
  get length() {
    return memory.size;
  },
  clear: () => memory.clear(),
  key: (index) => [...memory.keys()][index] ?? null,
  getItem(name) {
    try {
      return window.localStorage.getItem(name);
    } catch {
      return memory.get(name) ?? null;
    }
  },
  setItem(name, value) {
    try {
      window.localStorage.setItem(name, value);
    } catch {
      memory.set(name, value);
    }
  },
  removeItem(name) {
    try {
      window.localStorage.removeItem(name);
    } catch {
      memory.delete(name);
    }
  },
};

// Debounced writes wait here. Leaving or hiding the page writes them at once, so a reload
// straight after typing keeps every character.
const pending = new Map<string, string>();
let timer: ReturnType<typeof setTimeout> | undefined;

function flush() {
  clearTimeout(timer);
  timer = undefined;
  for (const [name, value] of pending) guarded.setItem(name, value);
  pending.clear();
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
}

function debounced(delayMs: number): Storage {
  return {
    get length() {
      return guarded.length;
    },
    clear: () => {
      pending.clear();
      guarded.clear();
    },
    key: (index) => guarded.key(index),
    getItem: (name) => pending.get(name) ?? guarded.getItem(name),
    setItem(name, value) {
      pending.set(name, value);
      clearTimeout(timer);
      timer = setTimeout(flush, delayMs);
    },
    removeItem(name) {
      pending.delete(name);
      guarded.removeItem(name);
    },
  };
}

/** Storage for persisted stores. `debounceMs` batches rapid changes, like typing, into one write. */
export const safeStorage = <T>(opts: { debounceMs?: number } = {}) =>
  createJSONStorage<T>(() => (opts.debounceMs ? debounced(opts.debounceMs) : guarded));

export function writeLocal(name: string, value: string) {
  guarded.setItem(name, value);
}

export function readLocal(name: string): string | null {
  return guarded.getItem(name);
}
