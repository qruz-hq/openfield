import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ICONS = resolve(import.meta.dir, "../apps/desktop/src-tauri/icons");

describe("desktop icons", () => {
  // generating-macos/ can only be remade on macOS 26, so a new logo rendered anywhere else would
  // leave the Dock jumping to the old one on every run (scripts/desktop-icons.ts).
  test("the macOS busy frames were made from the current app icon", () => {
    const icon = createHash("sha256")
      // A Windows checkout may turn the line endings into CRLF; the hash is of the file as written.
      .update(readFileSync(join(ICONS, "app-icon.svg"), "utf8").replaceAll("\r\n", "\n"))
      .digest("hex");
    expect(readFileSync(join(ICONS, "generating-macos/source.sha256"), "utf8").trim()).toBe(icon);
  });
});
