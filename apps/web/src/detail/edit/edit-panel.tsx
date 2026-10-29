import { t } from "@openfield/core";
import { useEditSession } from "./session";

// The Edit tab's side of the panel (design gpRcEBbVNM, Image edit / Panel), under the tabs. Its
// footer sits at the bottom and says what the edit still needs.

export function EditPanel() {
  const empty = useEditSession((s) => s.mask.empty);
  const described = useEditSession((s) => s.prompt.trim() !== "");
  const hint = empty ? t("edit.generate.paintFirst") : described ? null : t("edit.generate.describeFirst");
  return (
    // Footer: a column at the panel's bottom, gap 10.
    <div className="flex w-full flex-1 flex-col justify-end gap-10">
      {hint ? <p className="w-full text-center text-caption font-normal text-text-tertiary">{hint}</p> : null}
    </div>
  );
}
