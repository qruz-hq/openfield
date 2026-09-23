import { Database } from "bun:sqlite";

// One running Openfield per library folder. A second one would run crash recovery and the queue
// against the live instance's runs. SQLite's file lock does the job because the OS drops it when
// the process dies, even on kill -9, so there is never a stale lock to clean up.

export interface LibraryLock {
  release(): void;
}

/** Takes the lock on `file`, or returns null when another Openfield (in any process) holds it. */
export function lockLibrary(file: string): LibraryLock | null {
  const sqlite = new Database(file, { create: true });
  try {
    sqlite.exec("PRAGMA locking_mode = EXCLUSIVE");
    // Left open on purpose: the exclusive lock lasts until the connection closes.
    sqlite.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    sqlite.close();
    if ((error as { code?: string }).code === "SQLITE_BUSY") return null;
    throw error;
  }
  let held = true;
  return {
    release() {
      if (!held) return;
      held = false;
      sqlite.close();
    },
  };
}
