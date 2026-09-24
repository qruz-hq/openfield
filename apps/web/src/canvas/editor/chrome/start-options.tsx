import { type MessageKey, t } from "@openfield/core";
import { Surface } from "@openfield/ui";
import { LayoutTemplate, type LucideIcon, MousePointerClick, Type, Upload } from "lucide-react";
import { Fragment } from "react";
import { useNavigate } from "react-router";
import { deleteCanvas } from "../../../api/hooks/canvas-doc";
import { markOpenPicker } from "../../nodes/picker-intent";
import { useSession } from "../session";
import type { EditorCommands } from "../use-commands";

// Start options on an empty canvas (design jfnDN C80NA): a floating bar (padding 6, gap 4) of three
// 248 wide rows with 24 px divider lines, and under it, 16 below, the double-click hint.

interface Option {
  key: string;
  icon: LucideIcon;
  name: MessageKey;
  line: MessageKey;
}

const OPTIONS: Option[] = [
  { key: "prompt", icon: Type, name: "canvas.editor.start.prompt", line: "canvas.editor.start.promptLine" },
  { key: "upload", icon: Upload, name: "canvas.editor.start.upload", line: "canvas.editor.start.uploadLine" },
  {
    key: "template",
    icon: LayoutTemplate,
    name: "canvas.editor.start.template",
    line: "canvas.editor.start.templateLine",
  },
];

export function StartOptions({ commands }: { commands: EditorCommands }) {
  const navigate = useNavigate();
  const session = useSession();
  const pick = async (key: string) => {
    if (key === "template") {
      // Using a template makes a canvas of its own, so this one, still blank and untouched, goes
      // rather than staying behind in the index as an empty "Untitled".
      const { doc, history } = session.main.getState();
      const untouched = !doc.order.length && !history.past.length && doc.name === t("canvas.names.untitled");
      if (untouched) await deleteCanvas(session.canvasId).catch(() => {});
      navigate("/canvas?tab=templates");
      return;
    }
    // Upload opens the file dialog and Prompt takes the cursor, as from the add-node menu.
    const id = commands.addAtCentre(key === "prompt" ? "prompt" : "image.upload");
    if (id) markOpenPicker(id);
  };
  return (
    <div className="pointer-events-none absolute inset-0 z-[5] flex flex-col items-center justify-center gap-16 pb-20">
      <Surface variant="floating-bar" className="pointer-events-auto h-auto gap-4 p-6">
        {OPTIONS.map((option, i) => (
          <Fragment key={option.key}>
            {i > 0 ? (
              <hr aria-orientation="vertical" className="h-24 w-px shrink-0 border-0 bg-border" />
            ) : null}
            <button
              type="button"
              onClick={() => void pick(option.key)}
              className="flex h-48 w-248 cursor-pointer items-center gap-10 rounded-10 px-10 text-left transition-colors hover:bg-elevated-2"
            >
              <span className="flex size-24 shrink-0 items-center justify-center rounded-6 bg-elevated-2 inset-ring inset-ring-border">
                <option.icon size={14} aria-hidden className="text-text-secondary" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="text-small font-medium text-text-primary">{t(option.name)}</span>
                <span className="text-caption text-text-tertiary">{t(option.line)}</span>
              </span>
            </button>
          </Fragment>
        ))}
      </Surface>
      <p className="flex items-center gap-6 text-small text-text-tertiary">
        <MousePointerClick size={14} aria-hidden />
        {t("canvas.editor.start.hint")}
      </p>
    </div>
  );
}
