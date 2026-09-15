// Shared Lucide file-type registry for web, desktop and mobile.
// Extension hints are visual only; they never decide how a file is executed.
export const fileIconTypes = [
  {
    icon: "file-text",
    extensions: [
      "txt",
      "md",
      "mdx",
      "markdown",
      "rtf",
      "log",
      "doc",
      "docx",
      "odt",
    ],
  },
  { icon: "file-type", extensions: ["pdf"] },
  { icon: "book-open", extensions: ["epub", "mobi", "azw", "azw3", "fb2"] },
  {
    icon: "package",
    extensions: [
      "apk",
      "aab",
      "ipa",
      "exe",
      "msi",
      "dmg",
      "pkg",
      "deb",
      "rpm",
      "appimage",
    ],
  },
  {
    icon: "image",
    extensions: [
      "jpg",
      "jpeg",
      "png",
      "gif",
      "webp",
      "avif",
      "heic",
      "heif",
      "svg",
      "bmp",
      "tif",
      "tiff",
      "ico",
      "dng",
      "raw",
    ],
  },
  {
    icon: "file-video",
    extensions: [
      "mp4",
      "mov",
      "m4v",
      "webm",
      "mkv",
      "avi",
      "mpeg",
      "mpg",
      "3gp",
    ],
  },
  {
    icon: "file-audio",
    extensions: ["mp3", "m4a", "wav", "flac", "ogg", "opus", "aac", "aiff"],
  },
  {
    icon: "file-archive",
    extensions: ["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "tgz"],
  },
  { icon: "sheet", extensions: ["csv", "tsv", "xls", "xlsx", "ods"] },
  { icon: "presentation", extensions: ["ppt", "pptx", "odp", "key"] },
  {
    icon: "file-code",
    extensions: [
      "js",
      "jsx",
      "ts",
      "tsx",
      "html",
      "css",
      "json",
      "yaml",
      "yml",
      "xml",
      "py",
      "rb",
      "go",
      "rs",
      "java",
      "kt",
      "swift",
      "sh",
      "sql",
      "toml",
    ],
  },
];
const fileIconsByExtension = new Map(
  fileIconTypes.flatMap(({ icon, extensions }) =>
    extensions.map((extension) => [extension, icon]),
  ),
);
export function fileIcon(name, directory = false) {
  if (directory) return "folder";
  const basename = String(name || "")
    .split(/[\\/]/)
    .pop();
  const dot = basename.lastIndexOf(".");
  return dot > 0
    ? fileIconsByExtension.get(basename.slice(dot + 1).toLowerCase()) || "file"
    : "file";
}
