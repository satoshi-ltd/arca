import { StickyDetailSide } from "./StickyDetailSide";
import { Scaffold } from "./components";
import { Section } from "./components";
import { ErrorNotice } from "./Notice";
import React from "react";
import { Text, View } from "react-native";
import { Badge, Button, Card, Icon, useDesign } from "./components";
import { bytes } from "./format";

export function FileHistory({
  target,
  history,
  volume,
  date,
  locked,
  connected,
  restore,
  reviewConflict,
  canResolve,
  loadMore,
  openFolder,
  loading = false,
  error = "",
  localEntry,
  retry,
  author,
}) {
  const { s, c, wide } = useDesign();
  const current = history.versions[0];
  return (
    <>
      <ErrorNotice error={error} retry={retry} />
      {!connected && (
        <Text style={s.caption}>
          Offline. Local files are available; connect to load hub revisions.
        </Text>
      )}
      {target.path.includes(".conflict-") &&
        current &&
        !current.deleted &&
        !current.resolved && (
          <Card title="Conflict copy">
            <Text style={s.text}>
              Two versions were kept. Choose which content to use for the
              original file.
            </Text>
            {!canResolve && (
              <Text style={s.caption}>
                Select this folder for synchronization before resolving
                conflicts.
              </Text>
            )}
            <Button
              label="Resolve conflict…"
              icon="conflict"
              disabled={locked || !connected || !canResolve}
              onPress={reviewConflict}
            />
          </Card>
        )}
      <View style={[s.group, s.statsGrid]}>
        {[
          [
            "Status on hub",
            current
              ? current.deleted
                ? "Deleted"
                : current.resolved
                  ? "Resolved"
                  : "Available"
              : loading
                ? "Loading…"
                : "Not verified",
          ],
          [
            current ? "File size" : "Local file size",
            current || localEntry
              ? bytes(current?.size ?? localEntry?.size)
              : "Unknown",
          ],
          ["Latest revision", current ? `rev ${current.rev}` : "Unknown"],
          ["Last changed", current ? date(current.created) : "Unknown"],
        ].map(([label, value], index) => (
          <View
            key={label}
            style={[s.statCell, index % (wide ? 4 : 2) > 0 && s.statDivider]}
          >
            <Text style={s.caption}>{label}</Text>
            <Text style={wide ? s.statValue : s.heading}>{value}</Text>
          </View>
        ))}
      </View>
      <View style={s.detailGrid}>
        <View style={s.detailMain}>
          <Section>
            <Text style={s.eyebrow}>FILE REVISIONS</Text>
            {!!history.versions.length && (
              <View style={s.group}>
                {history.versions.map((row, index) => (
                  <View
                    key={row.rev}
                    style={[s.settingRow, index > 0 && s.separator]}
                  >
                    <View style={s.row}>
                      <Icon
                        name={row.deleted ? "trash" : "revision"}
                        size={18}
                        color={row.deleted ? c.mute : c.accent}
                      />
                      <View style={[s.flex, s.stack]}>
                        <Text style={s.rowTitle}>{date(row.created)}</Text>
                        <Text style={s.caption}>
                          {row.deleted ? "Deleted" : bytes(row.size)}
                          {author ? ` · ${author(row.author)}` : ""}
                        </Text>
                      </View>
                      {wide && <Text style={s.mono}>rev {row.rev}</Text>}
                      {row.rev === target.currentRev ? (
                        <Badge>Current</Badge>
                      ) : (
                        !row.deleted && (
                          <Button
                            quiet
                            label="Restore"
                            icon="restore"
                            disabled={locked || !connected}
                            onPress={() => restore(row)}
                          />
                        )
                      )}
                    </View>
                  </View>
                ))}
              </View>
            )}
          </Section>
          {loading && <Scaffold kind="history" label="Loading file history" />}
          {!loading && !error && connected && !history.versions.length && (
            <Text style={s.caption}>No retained revisions.</Text>
          )}
          {history.next && (
            <Button
              label="Load older revisions"
              busy={locked}
              onPress={loadMore}
            />
          )}
        </View>
        <StickyDetailSide>
          <Section>
            <Text style={s.eyebrow}>FILE LOCATION</Text>
            <Card title={volume?.name || "Shared folder"}>
              <Text selectable style={s.mono}>
                {target.path}
              </Text>
              {openFolder && (
                <Button
                  label="View folder"
                  icon="folders"
                  onPress={openFolder}
                />
              )}
            </Card>
          </Section>
        </StickyDetailSide>
      </View>
    </>
  );
}
