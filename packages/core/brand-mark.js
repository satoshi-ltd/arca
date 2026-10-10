export const brandColors = { tile: "#244d3e", arch: "#eff5df", door: "#accb80" };
export const brandModule = 60;
export const brandTile = { x: 8, y: 8, width: 496, height: 496, rx: 116 };
export const brandDrawings = {
  display: {
    viewBox: "0 0 512 512",
    tile: brandTile,
    arch: "M136 380V242a120 120 0 0 1 240 0v138h-60V242a60 60 0 0 0-120 0v138z",
    door: { x: 226, y: 284, width: 60, height: 96, rx: 6 },
  },
  small: {
    viewBox: "0 0 512 512",
    tile: brandTile,
    arch: "M136 380V242a120 120 0 0 1 240 0v138h-68V242a52 52 0 0 0-104 0v138z",
    door: { x: 226, y: 280, width: 60, height: 100, rx: 4 },
  },
  pixel: {
    viewBox: "0 0 16 16",
    tile: { x: 0, y: 0, width: 16, height: 16, rx: 3.6 },
    arch: "M4 12V8a4 4 0 0 1 8 0v4h-2V8a2 2 0 0 0-4 0v4z",
    door: { x: 7, y: 9, width: 2, height: 3, rx: 0 },
  },
};
export const brandGlyphBox = "116 100 280 296";
export const brandSplashBox = "0 -5 512 512";
export const brandDraw = [
  "M166 380V242A90 90 0 0 1 256 152h2",
  "M346 380V242A90 90 0 0 0 256 152h-2",
];
export const brandDrawLength = 138 + 45 * Math.PI + 2;
export function brandDrawing(size) {
  if (size < 24) return brandDrawings.pixel;
  if (size < 48) return brandDrawings.small;
  return brandDrawings.display;
}
