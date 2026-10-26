export const brandColors = { tile: "#244d3e", arch: "#eff5df", door: "#b5d38a" };
export const brandModule = 60;
export const brandTile = { x: 8, y: 8, width: 496, height: 496, rx: 128 };
export const brandDoor = "M228 380V294a28 28 0 0 1 56 0v86z";
export const brandDrawings = {
  display: {
    viewBox: "0 0 512 512",
    tile: brandTile,
    arch: "M144 380V233a112 112 0 0 1 224 0v147h-52V233a60 60 0 0 0-120 0v147z",
    door: brandDoor,
  },
  small: {
    viewBox: "0 0 512 512",
    tile: brandTile,
    arch: "M144 380V233a112 112 0 0 1 224 0v147h-60V233a52 52 0 0 0-104 0v147z",
    door: brandDoor,
  },
  pixel: {
    viewBox: "0 0 16 16",
    tile: { x: 0, y: 0, width: 16, height: 16, rx: 4 },
    arch: "M4 12V8a4 4 0 0 1 8 0v4h-2V8a2 2 0 0 0-4 0v4z",
    door: "M7 12V10a1 1 0 0 1 2 0v2z",
  },
};
export const brandGlyphBox = "116 100 280 296";
export const brandSplashBox = "0 -5 512 512";
export const brandDrawWidth = 52;
export const brandDraw = [
  "M170 380V233A86 86 0 0 1 256 147h2",
  "M342 380V233A86 86 0 0 0 256 147h-2",
];
export const brandDrawLength = 147 + 43 * Math.PI + 2;
export function brandDrawing(size) {
  if (size < 24) return brandDrawings.pixel;
  if (size < 48) return brandDrawings.small;
  return brandDrawings.display;
}
