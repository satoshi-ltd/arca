import React, { useEffect, useState } from "react";
import { Image, Text, View } from "react-native";
import { Icon, useDesign } from "./components";
import { fileIcon } from "../../desktop/src/file-icons.js";
import { HEAD_BYTES, canRenderImage, headPreview, previewKind } from "./file-preview.js";

export function RowThumb({ entry, enabled = true }) {
  const { s } = useDesign();
  if (!enabled || entry.directory || !entry.uri || !canRenderImage(entry.path))
    return <Icon name={fileIcon(entry.path, entry.directory)} />;
  return (
    <View style={s.rowThumb}>
      <Image
        source={{ uri: entry.uri }}
        resizeMethod="resize"
        style={s.rowThumbImage}
        accessibilityIgnoresInvertColors
      />
    </View>
  );
}

export function FilePreview({ entry, files }) {
  const { s } = useDesign();
  const kind = entry?.path ? previewKind(entry.path) : "none";
  const [head, setHead] = useState(null);
  useEffect(() => {
    setHead(null);
    if (kind !== "text" || !entry?.uri || !files?.read) return;
    let live = true;
    files
      .read(entry.uri, 0, HEAD_BYTES)
      .then((bytes) => live && setHead(headPreview(bytes, entry.size || bytes.length)))
      .catch(() => live && setHead({ kind: "none" }));
    return () => {
      live = false;
    };
  }, [entry?.uri, kind]);
  if (!entry?.uri || kind === "none" || kind === "audio") return null;
  if (kind === "image" && canRenderImage(entry.path))
    return (
      <View style={s.previewStage}>
        <Image
          source={{ uri: entry.uri }}
          resizeMode="contain"
          resizeMethod="resize"
          style={s.previewImage}
          accessibilityLabel={entry.path.split("/").pop()}
        />
      </View>
    );
  if (kind === "text" && head?.kind === "text")
    return (
      <View style={s.previewStage}>
        <Text style={s.previewText} selectable={false}>
          {head.lines.join("\n")}
          {head.truncated ? "\n…" : ""}
        </Text>
      </View>
    );
  return null;
}
