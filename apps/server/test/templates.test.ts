import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canvasDocumentSchema, generateNodeParamsSchema } from "@openfield/core/canvas";
import { BUNDLED_TEMPLATES_DIR, TEMPLATE_SUFFIX } from "../src/canvas/templates";

// M4-14: the bundled starter templates are ordinary canvas documents, written by us, with no
// images inside. Each must validate and wire only ports the node types of this build have.

/** Port ids per node type (§7.5, §7.6). Edges store these, so they must never drift. */
const PORTS: Record<string, { in: string[]; out: string[] }> = {
  prompt: { in: ["text"], out: ["text"] },
  "image.upload": { in: [], out: ["images"] },
  "image.asset": { in: [], out: ["images"] },
  "image.generate": { in: ["prompt", "input_images"], out: ["images"] },
  "image.variations": { in: ["image", "prompt"], out: ["images"] },
  frame: { in: [], out: [] },
  note: { in: [], out: [] },
};

const files = readdirSync(BUNDLED_TEMPLATES_DIR).filter((f) => f.endsWith(TEMPLATE_SUFFIX));

describe("bundled templates", () => {
  test("the three this build ships", () => {
    expect(files.sort()).toEqual([
      "compare-two-styles.ofcanvas.json",
      "from-a-reference.ofcanvas.json",
      "storyboard.ofcanvas.json",
    ]);
  });

  for (const file of files) {
    test(`${file} is a valid canvas that wires real ports`, () => {
      const raw = JSON.parse(readFileSync(join(BUNDLED_TEMPLATES_DIR, file), "utf8"));
      const doc = canvasDocumentSchema.parse(raw);
      expect(doc.name.length).toBeGreaterThan(0);

      const byId = new Map(doc.nodes.map((n) => [n.id, n]));
      for (const node of doc.nodes) {
        // Only node types this build can show; no results, so no images from anyone's library.
        expect(Object.keys(PORTS)).toContain(node.type);
        expect(node.result).toBeNull();
        if (node.type === "image.generate") {
          const params = generateNodeParamsSchema.parse(node.params);
          // The model is chosen when the template is used, from what the person has keys for.
          expect(params.model).toBeUndefined();
        }
        // A frame comes before the nodes inside it, as React Flow needs.
        if (node.parentId) {
          expect(doc.nodes.findIndex((n) => n.id === node.parentId)).toBeLessThan(doc.nodes.indexOf(node));
          expect(byId.get(node.parentId)?.type).toBe("frame");
        }
      }
      for (const edge of doc.edges) {
        expect(edge.kind).toBe("data");
        expect(PORTS[byId.get(edge.source)!.type]!.out).toContain(edge.sourceHandle);
        expect(PORTS[byId.get(edge.target)!.type]!.in).toContain(edge.targetHandle);
      }
    });
  }

  test("every template id and document id is distinct", () => {
    const ids = files.map((f) => JSON.parse(readFileSync(join(BUNDLED_TEMPLATES_DIR, f), "utf8")).id);
    expect(new Set(ids).size).toBe(files.length);
  });
});
