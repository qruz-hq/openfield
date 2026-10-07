import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CanvasTemplate } from "@openfield/core";
import { migrateCanvasDocument } from "@openfield/core/canvas";
import type { Logger } from "../log/logger";

// Starter templates (§7.3, M4-14): ordinary canvas documents. The bundled ones ship in
// apps/server/seed/templates; a person can drop their own into canvases/templates in the library.
// Both folders are read on every request, so a dropped-in file shows up without a restart.

export const TEMPLATE_SUFFIX = ".ofcanvas.json";

/** The bundled ones. The desktop app ships them beside its compiled server: OPENFIELD_TEMPLATES_DIR. */
export function bundledTemplatesDir(env: Record<string, string | undefined> = process.env): string {
  return env.OPENFIELD_TEMPLATES_DIR?.trim() || join(import.meta.dir, "../../seed/templates");
}

export const BUNDLED_TEMPLATES_DIR = bundledTemplatesDir();
const USER_PREFIX = "user-";

export class CanvasTemplates {
  constructor(
    private readonly dirs: { bundled: string; user: string },
    private readonly logger: Logger,
  ) {}

  list(): CanvasTemplate[] {
    return [...this.#read(this.dirs.bundled, "bundled"), ...this.#read(this.dirs.user, "user")];
  }

  get(id: string): CanvasTemplate | undefined {
    return this.list().find((t) => t.id === id);
  }

  #read(dir: string, source: CanvasTemplate["source"]): CanvasTemplate[] {
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(TEMPLATE_SUFFIX))
      .sort();
    const out: CanvasTemplate[] = [];
    for (const file of files) {
      const base = file.slice(0, -TEMPLATE_SUFFIX.length);
      try {
        const graph = migrateCanvasDocument(JSON.parse(readFileSync(join(dir, file), "utf8")));
        out.push({
          id: source === "user" ? `${USER_PREFIX}${base}` : base,
          source,
          name: graph.name,
          nodeCount: graph.nodes.length,
          graph,
        });
      } catch (error) {
        // A broken file is left out rather than breaking the whole tab.
        this.logger.warn("A canvas template couldn't be read, so it's hidden", { file, source, error });
      }
    }
    return out;
  }
}
