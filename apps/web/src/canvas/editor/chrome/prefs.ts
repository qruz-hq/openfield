import { writeLocal } from "../../../lib/storage";

// Editor preferences kept on this computer across canvases and reloads. There's no ui_state
// table, so the minimap toggle (§7.4) lives in local storage.

const MINIMAP_KEY = "openfield.canvas.minimap";

export function minimapPref(): boolean {
  try {
    return window.localStorage.getItem(MINIMAP_KEY) === "1";
  } catch {
    return false;
  }
}

export function setMinimapPref(open: boolean) {
  writeLocal(MINIMAP_KEY, open ? "1" : "0");
}
