import { assetsSpec } from "./assets/spec";
import { generateSpec } from "./generate/spec";
import type { NodeSpec } from "./params";
import { promptSpec } from "./prompt/spec";
import { uploadSpec } from "./upload/spec";
import { variationsSpec } from "./variations/spec";

// The data node types without their React parts, in catalogue order. The engine's tests build a
// registry from these; the app's registry adds the components in ./catalogue.ts.

export const DATA_SPECS: readonly NodeSpec<object>[] = [
  promptSpec,
  uploadSpec,
  assetsSpec,
  generateSpec,
  variationsSpec,
] as unknown as readonly NodeSpec<object>[];
