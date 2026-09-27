import { joinPrompt, textOf } from "../../engine/inputs";
import type { NodeEngine, PortSpec } from "../../engine/types";
import { readString } from "../params";
import type { NodeSpec } from "../registry";

// Prompt (design pFPMj): text written once and handed to any node with a text input. An
// upstream prompt is prepended, so prompts chain.

export const PROMPT_MAX = 4000;

export interface PromptParams {
  text: string;
}

export const PROMPT_PORTS: readonly PortSpec[] = [
  {
    id: "text",
    label: "canvas.nodes.ports.text",
    direction: "in",
    type: "text",
    arity: "single",
    items: "one",
    required: false,
    binding: { to: "prompt" },
  },
  {
    id: "text",
    label: "canvas.nodes.ports.text",
    direction: "out",
    type: "text",
    arity: "single",
    items: "one",
    required: false,
  },
];

export const promptEngine: NodeEngine<PromptParams> = {
  fingerprintParams: (node) => ({
    params: { text: node.params.text.trim() },
    model: null,
    manifestVersion: null,
    cacheable: true,
  }),
  outputs(node, inputs) {
    const text = joinPrompt([...textOf(inputs, "text"), node.params.text]);
    return { text: text ? [{ kind: "text", text }] : [] };
  },
  blocker: () => null,
};

export const promptSpec: NodeSpec<PromptParams> = {
  type: "prompt",
  typeVersion: 1,
  label: "canvas.nodes.prompt.label",
  description: "canvas.nodes.prompt.description",
  keywords: ["text", "words", "describe"],
  category: "utility",
  menu: { group: "utilities", order: 0 },
  size: { w: 296, h: 151 },
  minSize: { w: 240, h: 96 },
  resizable: true,
  annotation: false,
  ports: PROMPT_PORTS,
  defaults: () => ({ text: "" }),
  parseParams: (raw) => ({ text: readString(raw, "text") }),
  runnable: false,
  engine: promptEngine,
};
