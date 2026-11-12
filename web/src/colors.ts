// One colour per file type, shared by the drawer folders and the viewer plate.
const KIND_COLOR: Record<string, string> = {
  pdf: "#1f3de0", doc: "#d91f26", slides: "#0d6b3d", sheet: "#5b2a7a", text: "#141414", image: "#f2e30c", other: "#7b7a76",
};
export const kindColor = (k?: string) => KIND_COLOR[k ?? "other"] ?? KIND_COLOR.other;
export const inkFor = (k?: string) => (k === "image" ? "#141414" : "#ffffff");

/**
 * Temporary: every file gets a stable pseudo-random colour from this palette (same file → same colour
 * in the drawer and the viewer). Swap `fileColor` for `kindColor` (or anything smarter) to colour-coordinate later.
 */
const PALETTE: [string, string][] = [
  ["#1f3de0", "#fff"], ["#d91f26", "#fff"], ["#0d6b3d", "#fff"], ["#5b2a7a", "#fff"], ["#f2e30c", "#141414"], ["#141414", "#fff"],
  ["#ff6a1a", "#141414"], ["#0fa3a3", "#fff"], ["#e0508c", "#fff"], ["#f5b81c", "#141414"], ["#2a9d4a", "#fff"],
  ["#7a5cff", "#fff"], ["#14307a", "#fff"], ["#c8d82a", "#141414"], ["#ff8fa3", "#141414"],
];
const slot = (id: number) => Math.abs(Math.imul(id + 1, 2654435761) >>> 0) % PALETTE.length;
export const fileColor = (id: number) => PALETTE[slot(id)][0];
export const fileInk = (id: number) => PALETTE[slot(id)][1];
