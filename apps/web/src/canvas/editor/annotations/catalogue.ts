import type { NodeDefinition } from "../../nodes/registry";
import { frameNode } from "./frame-node";
import { noteNode } from "./note-node";
import { shapeNode } from "./shape-node";
import { textNode } from "./text-node";

// Annotation node definitions: Note, Frame, Text, Shape. Owned by the editor agent. They never run
// and carry no data ports; Note and Frame are in the add-node menu, Text and Shape come from the
// toolbar.

export const ANNOTATION_NODES: readonly NodeDefinition[] = [noteNode, frameNode, textNode, shapeNode];
