import { frameSpec, noteSpec, shapeSpec, textSpec } from "./annotations";
import { assetsSpec } from "./assets/spec";
import { generateSpec } from "./generate/spec";
import { promptSpec } from "./prompt/spec";
import { createNodeRegistry, type NodeRegistry, type NodeSpec } from "./registry";
import { uploadSpec } from "./upload/spec";
import { variationsSpec } from "./variations/spec";

// The node types without their React parts, in catalogue order. The engine's tests and the server
// build a registry from these; the web app's registry adds icons and components (its catalogue.ts).

export const DATA_SPECS: readonly NodeSpec<object>[] = [
  promptSpec,
  uploadSpec,
  assetsSpec,
  generateSpec,
  variationsSpec,
] as unknown as readonly NodeSpec<object>[];

export const ANNOTATION_SPECS: readonly NodeSpec<object>[] = [
  noteSpec,
  frameSpec,
  textSpec,
  shapeSpec,
] as unknown as readonly NodeSpec<object>[];

/** Every node type this build knows, for code that runs without the editor (the server). */
export const specRegistry: NodeRegistry = createNodeRegistry([
  ...DATA_SPECS,
  ...ANNOTATION_SPECS,
] as unknown as readonly NodeSpec[]);
