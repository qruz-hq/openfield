import type { AssetListItem } from "@openfield/core";
import { type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Media, type MediaHandle, type MediaInset } from "../media";
import { BrushOptions, EditToolbar, ShapeOptions, ZoomControl } from "./chrome";
import { usePaintSurface, useSpaceHeld } from "./paint-surface";
import { useEditSession } from "./session";

// An image in the detail view, on either tab. On Info it's Media as it always was. On Edit the same
// Media (so zoom and the loaded pixels carry over) takes the mask's layer and the pointer, with the
// toolbar, the tool's options and the zoom control floating over the media area.

/**
 * The Edit tab's room around the image (design f90S4YuAoH: a 680 tall image at 58 from the top of
 * 900): the image moves up to clear the options bar and the toolbar below it.
 */
const EDIT_INSET: MediaInset = { top: 58, right: 98, bottom: 162, left: 98 };

export interface ImageMediaHandle extends MediaHandle {
  /** Esc on the Edit tab: drops a stroke, lasso or box being drawn. True when there was one. */
  cancel: () => boolean;
}

interface ImageMediaProps {
  item: AssetListItem;
  expanded: boolean;
  label: string;
  /** The Edit tab is open on this image. */
  editing: boolean;
  onZoomedChange: (zoomed: boolean) => void;
  ref?: Ref<ImageMediaHandle>;
}

export function ImageMedia({ item, expanded, label, editing, onZoomedChange, ref }: ImageMediaProps) {
  const media = useRef<MediaHandle>(null);
  const [zoom, setZoom] = useState(0);
  const tool = useEditSession((s) => s.tool);
  const spaceHeld = useSpaceHeld(editing);
  const panning = editing && (tool === "pan" || spaceHeld);
  const paint = usePaintSurface({ width: item.width, height: item.height, zoom, panning, enabled: editing });

  // The mask is the image's stored size; an edit already open on it carries on.
  useEffect(() => {
    if (editing) useEditSession.getState().start(item.id, item.width, item.height);
  }, [editing, item.id, item.width, item.height]);

  useImperativeHandle(ref, () => ({
    zoomIn: () => media.current?.zoomIn(),
    zoomOut: () => media.current?.zoomOut(),
    fit: () => media.current?.fit(),
    toggle: () => media.current?.toggle(),
    cancel: paint.cancel,
  }));

  return (
    <>
      <Media
        ref={media}
        item={item}
        expanded={expanded}
        label={label}
        onZoomedChange={onZoomedChange}
        onZoomChange={setZoom}
        inset={editing ? EDIT_INSET : undefined}
        panAnywhere={panning}
        layer={editing ? paint.layer : null}
      >
        {editing ? paint.input : null}
      </Media>
      {editing ? (
        <>
          <ZoomControl
            zoom={zoom}
            onZoomIn={() => media.current?.zoomIn()}
            onZoomOut={() => media.current?.zoomOut()}
          />
          {tool === "brush" || tool === "eraser" ? (
            <BrushOptions />
          ) : tool === "lasso" || tool === "rect" ? (
            <ShapeOptions tool={tool} />
          ) : null}
          <EditToolbar />
        </>
      ) : null}
    </>
  );
}
