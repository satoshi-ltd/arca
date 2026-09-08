import React, { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { client } from "./persistence";
import { Icon, Button, useDesign } from "./components";
import { bytes } from "./format";

// Recent means accepted hub revisions on every client, not filesystem mtimes.
export function FolderRecent({ volume, connected, updated, date, open }) {
  const { s, c, wide } = useDesign();
  const [page, setPage] = useState(null),
    [error, setError] = useState("");
  const [attempt, retry] = useState(0);
  useEffect(() => {
    let active = true;
    setPage(null);
    setError("");
    if (connected)
      client
        .api(`/v1/activity?${new URLSearchParams({ volume, limit: "4" })}`)
        .then((value) => {
          if (active) setPage(value);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    return () => {
      active = false;
    };
  }, [volume, connected, updated, attempt]);
  if (!connected)
    return (
      <Text style={s.text}>
        Connect to view recent revisions. Local files remain in Files.
      </Text>
    );
  if (error)
    return (
      <View style={s.section}>
        <Text accessibilityRole="alert" style={s.text}>
          {error}
        </Text>
        <Button label="Retry" onPress={() => retry((n) => n + 1)} />
      </View>
    );
  if (!page)
    return (
      <ActivityIndicator
        accessibilityLabel="Loading recent revisions"
        color={c.accent}
      />
    );
  return (
    <View style={s.section}>
      <View style={s.group}>
        {page.versions.map((row, index) => (
          <Pressable
            key={row.rev}
            accessibilityRole="button"
            accessibilityLabel={`View history for ${row.path}`}
            onPress={() => open(row)}
            style={[s.settingRow, s.row, index > 0 && s.separator]}
          >
            <Icon
              name={
                row.deleted
                  ? "trash"
                  : row.path.includes(".conflict-")
                    ? "conflict"
                    : "revision"
              }
              color={
                row.deleted
                  ? c.mute
                  : row.path.includes(".conflict-") && !row.resolved
                    ? c.warning
                    : c.accent
              }
            />
            <View style={[s.flex, s.stack]}>
              <Text
                numberOfLines={wide ? 1 : undefined}
                style={[s.rowTitle, row.deleted && s.deletedFile]}
              >
                {row.path}
              </Text>
              <Text style={s.caption}>
                {row.deleted
                  ? "Deleted · recoverable"
                  : row.resolved
                    ? "Resolved · copy kept"
                    : row.path.includes(".conflict-")
                      ? "Conflict copy retained"
                      : `${bytes(row.size)} · accepted revision`}
              </Text>
            </View>
            {wide && <Text style={s.mono}>rev {row.rev}</Text>}
            {wide && <Text style={s.caption}>{date(row.created)}</Text>}
            <Icon name="chevron" color={c.mute} />
          </Pressable>
        ))}
      </View>
      {!page.versions.length && <Text style={s.text}>No revisions yet.</Text>}
    </View>
  );
}
