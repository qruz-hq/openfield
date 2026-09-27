import { assetsSpec } from "@openfield/canvas/nodes/assets/spec";
import { generateSpec } from "@openfield/canvas/nodes/generate/spec";
import { promptSpec } from "@openfield/canvas/nodes/prompt/spec";
import { uploadSpec } from "@openfield/canvas/nodes/upload/spec";
import { variationsSpec } from "@openfield/canvas/nodes/variations/spec";
import { Images, LayoutGrid, Sparkles, Type, Upload } from "lucide-react";
import { AssetsNode } from "./assets/assets-node";
import { generateBox, generateRest } from "./generate/card-media";
import { GenerateInspector } from "./generate/generate-inspector";
import { GenerateNode } from "./generate/generate-node";
import { PromptNode } from "./prompt/prompt-node";
import { defineNode, type NodeDefinition } from "./registry";
import { UploadNode } from "./upload/upload-node";
import { VariationsInspector } from "./variations/variations-inspector";
import { VariationsNode } from "./variations/variations-node";

// Data node definitions, in catalogue order: Prompt, Upload, Assets, Generate, Variations. Each is
// its pure spec (@openfield/canvas, which the engine, its tests and the server use) plus its icon
// and React parts.
// Edit (M4-19) and Style (M4-20) join this list when they ship; until then a saved node of either
// type opens as the editor's placeholder and saves back unchanged.

export const DATA_NODES: readonly NodeDefinition[] = [
  defineNode({ ...promptSpec, icon: Type, Component: PromptNode }),
  defineNode({ ...uploadSpec, icon: Upload, Component: UploadNode }),
  defineNode({ ...assetsSpec, icon: Images, Component: AssetsNode }),
  defineNode({
    ...generateSpec,
    icon: Sparkles,
    box: generateBox,
    rest: generateRest,
    Component: GenerateNode,
    Inspector: GenerateInspector,
  }),
  defineNode({
    ...variationsSpec,
    icon: LayoutGrid,
    Component: VariationsNode,
    Inspector: VariationsInspector,
  }),
];
