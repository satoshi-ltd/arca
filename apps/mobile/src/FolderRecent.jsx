import { Scaffold } from "./components";
import { ErrorNotice } from "./Notice";
import React, { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { client } from "./persistence";
import { Icon, Button, useDesign } from "./components";
import { bytes } from "./format";

const knownRecent = new Map();

// Recent means accepted hub revisions on every client, not filesystem mtimes.
export function FolderRecent({
  volume,
  scope,
  connected,
  updated,
  date,
  open,
  onLoading,
}) {
  const { s, c, wide } = useDesign();
  const key = `${scope}:${volume}`;
  const [loaded, setLoaded] = useState(null),
    [error, setError] = useState("");
  const page = loaded?.key === key ? loaded.value : knownRecent.get(key);
  const [attempt, retry] = useState(0);
  useEffect(() => {
    let active = true;
    setLoaded({ key, value: knownRecent.get(key) });
    onLoading?.(!!connected);
    setError("");
    if (connected)
      client
        .api(`/v1/activity?${new URLSearchParams({ volume, limit: "4" })}`)
        .then((value) => {
          if (active) {
            knownRecent.set(key, value);
            while (knownRecent.size > 40)
              knownRecent.delete(knownRecent.keys().next().value);
            setLoaded({ key, value });
          }
        })
        .catch((e) => {
          if (active) setError(e.message);
        })
        .finally(() => {
          if (active) onLoading?.(false);
        });
    return () => {
      active = false;
      onLoading?.(false);
    };
  }, [key, connected, updated, attempt, onLoading]);
  if (!connected && !page)
    return (
      <Text style={s.text}>
        Connect to view recent revisions. Local files remain in Files.
      </Text>
    );
  if (error && !page)
    return <ErrorNotice error={error} retry={() => retry((n) => n + 1)} />;
  if (!page) return <Scaffold kind="history" label="Loading recent changes" />;
  return (
    <View style={s.section}>
      {error && <ErrorNotice error={error} retry={() => retry((n) => n + 1)} />}
      {!connected && (
        <Text style={s.caption}>Offline · last known revisions</Text>
      )}
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
                      : `${bytes(row.size)}`}
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
