const TEXT = /\.(txt|md|markdown|mdx|json|jsonc|ya?ml|toml|ini|cfg|conf|csv|tsv|log|xml|html?|css|scss|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|c|h|cc|cpp|hpp|java|kt|swift|sh|bash|zsh|sql|env|gitignore|arcaignore)$/i;

export const HEAD_BYTES = 4096;
export const HEAD_LINES = 24;

export function previewKind(path) {
  return /\.(jpe?g|png|webp|gif|avif|hei[cf])$/i.test(path)
    ? "image"
    : /\.(mp4|mov|m4v|webm)$/i.test(path)
      ? "video"
      : /\.(mp3|m4a|flac|wav|ogg|opus|aac|aiff?)$/i.test(path)
        ? "audio"
        : TEXT.test(path)
          ? "text"
          : "none";
}

export const canRenderImage = (path) =>
  previewKind(path) === "image" && !/\.(hei[cf]|avif)$/i.test(path);

function decode(bytes) {
  if (typeof TextDecoder === "function") return new TextDecoder("utf-8").decode(bytes);
  let out = "";
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

export function headPreview(bytes, size) {
  if (!bytes || bytes.includes(0)) return { kind: "none" };
  const cut = size > bytes.length;
  let text = decode(bytes);
  if (cut) text = text.replace(/�$/, "");
  const lines = text.split(/\r\n|\r|\n/);
  if (!cut && lines.at(-1) === "") lines.pop();
  return {
    kind: "text",
    lines: lines.slice(0, HEAD_LINES),
    truncated: cut || lines.length > HEAD_LINES,
  };
}
