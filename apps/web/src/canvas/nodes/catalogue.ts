import { AssetsNode } from "./assets/assets-node";
import { assetsSpec } from "./assets/spec";
import { GenerateInspector } from "./generate/generate-inspector";
import { GenerateNode } from "./generate/generate-node";
import { generateSpec } from "./generate/spec";
import { PromptNode } from "./prompt/prompt-node";
import { promptSpec } from "./prompt/spec";
import { defineNode, type NodeDefinition } from "./registry";
import { uploadSpec } from "./upload/spec";
import { UploadNode } from "./upload/upload-node";
import { variationsSpec } from "./variations/spec";
import { VariationsInspector } from "./variations/variations-inspector";
import { VariationsNode } from "./variations/variations-node";

// Data node definitions, in catalogue order: Prompt, Upload, Assets, Generate, Variations. Each is
// its pure spec (./<type>/spec.ts, which the engine and its tests use) plus its React parts.
// Edit (M4-19) and Style (M4-20) join this list when they ship; until then a saved node of either
// type opens as the editor's placeholder and saves back unchanged.

export const DATA_NODES: readonly NodeDefinition[] = [
  defineNode({ ...promptSpec, Component: PromptNode }),
  defineNode({ ...uploadSpec, Component: UploadNode }),
  defineNode({ ...assetsSpec, Component: AssetsNode }),
  defineNode({ ...generateSpec, Component: GenerateNode, Inspector: GenerateInspector }),
  defineNode({ ...variationsSpec, Component: VariationsNode, Inspector: VariationsInspector }),
];
