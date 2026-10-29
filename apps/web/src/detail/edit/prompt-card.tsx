import { type ModelListItem, t } from "@openfield/core";
import { cn } from "@openfield/ui";
import { useCallback, useLayoutEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { ReferenceRow, useReferenceUploads } from "../../image/composer/references";
import { addReferencesTo, useEditSession } from "./session";

// Image edit / Prompt card (design WYVVphaWWT): the reference images in a row, then what to change.
// With none yet the row is just the + (Image edit / Prompt card / Empty). The references are the
// edit's own, never the composer's.

export function PromptCard({ model, resting }: { model: ModelListItem | undefined; resting: boolean }) {
  const prompt = useEditSession((s) => s.prompt);
  const store = useEditSession(
    useShallow((s) => ({
      references: s.references,
      setReferences: s.setReferences,
      removeReference: s.removeReference,
      moveReference: s.moveReference,
    })),
  );
  // An upload that finishes after this edit has ended (Esc, another image) belongs to none.
  const editor = useEditSession((s) => s.editor);
  const addToThisEdit = useCallback(
    (assetIds: readonly string[]) => addReferencesTo(editor, assetIds),
    [editor],
  );
  const uploads = useReferenceUploads(addToThisEdit);
  const text = useRef<HTMLTextAreaElement>(null);

  // Grows with what's written, as the design's text does; the panel scrolls past that.
  // biome-ignore lint/correctness/useExhaustiveDependencies: measure again whenever the text changes.
  useLayoutEffect(() => {
    const el = text.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [prompt]);

  return (
    <div
      inert={resting}
      className={cn(
        "flex w-full shrink-0 flex-col gap-12 rounded-14 bg-surface p-12",
        resting && "opacity-45",
      )}
    >
      <ReferenceRow
        store={store}
        model={model}
        pending={uploads.pending}
        onUpload={(files) => void uploads.upload(files)}
      />
      <textarea
        ref={text}
        rows={1}
        value={prompt}
        aria-label={t("edit.prompt.label")}
        placeholder={t("edit.prompt.placeholder")}
        onChange={(event) => useEditSession.getState().setPrompt(event.target.value)}
        className="block w-full resize-none overflow-hidden bg-transparent text-small leading-[1.5] text-text-primary outline-none placeholder:text-text-tertiary"
      />
    </div>
  );
}
