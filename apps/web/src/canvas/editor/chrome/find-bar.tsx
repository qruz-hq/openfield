import { t } from "@openfield/core";
import { cn, IconButton, SearchInput, Surface } from "@openfield/ui";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useRef } from "react";
import { useModels } from "../../../api/hooks/models";
import { nodeRegistry } from "../../nodes/registry";
import { useCanvas, useCanvasStoreApi } from "../../store";
import { findMatches } from "../find";
import { useEditorUi, useSession } from "../session";

// Find bar (design oAqjk): top right under the run controls. A 44 tall floating bar, padding 6,
// gap 4: the search field (200 wide), "2 of 5" in mono, previous, next and close. ↵ and ⇧↵ step
// through matches; each one is ringed and centred, never zooming past 100%.

export function FindBar({ right }: { right: number }) {
  const session = useSession();
  const store = useCanvasStoreApi();
  const doc = useCanvas((s) => s.doc);
  const query = useEditorUi((s) => s.findQuery);
  const index = useEditorUi((s) => s.findIndex);
  const models = useModels("all").data;
  const input = useRef<HTMLInputElement>(null);

  const matches = useMemo(
    () =>
      findMatches(doc, query, {
        label: (type) => {
          const def = nodeRegistry.get(type);
          return def ? t(def.label) : "";
        },
        modelName: (key) => models?.find((m) => m.key === key)?.displayName,
      }),
    [doc, query, models],
  );
  const current = matches.length ? Math.min(index, matches.length - 1) : -1;
  const hit = current >= 0 ? matches[current]! : null;

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  useEffect(() => {
    session.ui.setState({ findHit: hit });
    if (hit) store.getState().viewController.focusNode(hit);
  }, [hit, session, store]);

  useEffect(() => () => session.ui.setState({ findHit: null }), [session]);

  const step = (by: number) => {
    if (!matches.length) return;
    session.ui.setState({ findIndex: (current + by + matches.length) % matches.length });
  };
  const close = () => store.getState().actions.setUi({ findOpen: false });

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  return (
    <Surface
      variant="floating-bar"
      role="search"
      aria-label={t("canvas.editor.find.label")}
      style={{ right }}
      className="absolute top-64 z-10 h-44 w-fit gap-4 rounded-12 p-6 mac-window:top-92"
    >
      <SearchInput
        ref={input}
        value={query}
        placeholder={t("canvas.editor.find.placeholder")}
        aria-label={t("canvas.editor.find.label")}
        onChange={(e) => session.ui.setState({ findQuery: e.target.value, findIndex: 0 })}
        onKeyDown={onKeyDown}
        boxClassName="w-200"
      />
      {query.trim() ? (
        <span
          aria-live="polite"
          className={cn("shrink-0 px-2 text-text-tertiary", matches.length ? "text-mono-12" : "text-caption")}
        >
          {matches.length
            ? t("canvas.editor.find.count", { current: current + 1, total: matches.length })
            : t("canvas.editor.find.none")}
        </span>
      ) : null}
      <IconButton
        icon={ChevronUp}
        label={t("canvas.editor.find.previous")}
        disabled={!matches.length}
        onClick={() => step(-1)}
      />
      <IconButton
        icon={ChevronDown}
        label={t("canvas.editor.find.next")}
        disabled={!matches.length}
        onClick={() => step(1)}
      />
      <IconButton icon={X} label={t("canvas.editor.find.close")} onClick={close} />
    </Surface>
  );
}
