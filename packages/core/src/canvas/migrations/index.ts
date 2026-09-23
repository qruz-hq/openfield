import { t } from "../../i18n";
import { CANVAS_SCHEMA_VERSION, type CanvasDocument, canvasDocumentSchema } from "../schema";

// Document migrations for canvases.schema_version bumps (R14). Each entry upgrades a document
// from version N to N + 1. None exist yet: version 1 is the first shape.

type RawDocument = Record<string, unknown>;

export const CANVAS_MIGRATIONS: Record<number, (doc: RawDocument) => RawDocument> = {};

export class CanvasVersionError extends Error {
  constructor(readonly version: number | null) {
    super(version === null ? "Not a canvas document" : t("canvas.errors.newerVersion"));
    this.name = "CanvasVersionError";
  }
}

/** Reads N from "openfield.canvas/N". */
export function canvasDocumentVersion(input: unknown): number | null {
  if (typeof input !== "object" || input === null) return null;
  const schema = (input as RawDocument).schema;
  if (typeof schema !== "string") return null;
  const match = /^openfield\.canvas\/(\d+)$/.exec(schema);
  return match ? Number(match[1]) : null;
}

/** Brings any older document up to the current version, then validates it. */
export function migrateCanvasDocument(input: unknown): CanvasDocument {
  let version = canvasDocumentVersion(input);
  if (version === null || version > CANVAS_SCHEMA_VERSION) throw new CanvasVersionError(version);
  let doc = input as RawDocument;
  while (version < CANVAS_SCHEMA_VERSION) {
    const step = CANVAS_MIGRATIONS[version];
    if (!step) throw new Error(`No canvas migration from version ${version}`);
    doc = step(doc);
    version += 1;
    doc = { ...doc, schema: `openfield.canvas/${version}` };
  }
  return canvasDocumentSchema.parse(doc);
}
