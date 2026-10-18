/**
 * Pixel-art palette, shared by the worker (validation) and the browser
 * (editor + board rendering). Built separately to public/palette.js by
 * build.mjs so app.js can import the exact same list without a bundle step.
 *
 * Index 0 is the transparent sentinel and is never drawn.
 */
export const ART_PALETTE: readonly string[] = [
  "transparent",
  "#000000",
  "#ffffff",
  "#404040",
  "#808080",
  "#c0c0c0",
  "#2c2c54",
  "#4778b3",
  "#38a1f3",
  "#a3e2fb",
  "#1b6437",
  "#3fa34d",
  "#8be08b",
  "#17b8a6",
  "#0e7a6d",
  "#ffd43b",
  "#fff3bf",
  "#f59f00",
  "#e8590c",
  "#9c4021",
  "#c9776a",
  "#862e2e",
  "#e03131",
  "#fa8a8a",
  "#ee5ba8",
  "#ffe3e3",
  "#5f3dc4",
  "#a882ff",
  "#6c2b8f",
  "#d9a441",
  "#f5f0e6",
  "#6b4226",
  "#b8f2c9",
];

/** 32 colors + the transparent sentinel. Must match the RLE codec bounds. */
export const ART_PALETTE_SIZE = ART_PALETTE.length;

/** Bump when the palette changes so clients re-quantize stored drawings. */
export const ART_PALETTE_VERSION = 1;
