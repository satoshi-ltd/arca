import React, { useEffect, useRef, useState } from "react";
import { Animated, Modal, Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { BrandActivity, Icon, Section, useDesign } from "./components";
import { Cover } from "./MusicLibrary";
import { Rise, useLeaving, useMotion } from "./motion";
import { motion } from "./design-tokens.js";
import { FAVORITE_ICONS, PHONE_FAVORITES, favoriteKey } from "./favorites.js";

const NAV = [
  ["Folders", "folders"],
  ["Devices", "devices"],
  ["History", "history"],
  ["Settings", "settings"],
];
const DRAWER_WIDTH = 280;

function Lead({ entry, cover, icon }) {
  const { s, c } = useDesign();
  return cover !== undefined ? (
    <Cover uri={cover} size={32} icon={FAVORITE_ICONS[entry.kind]} />
  ) : (
    <View style={s.tile}>
      <Icon name={icon || FAVORITE_ICONS[entry.kind]} size={16} color={c.accent} />
    </View>
  );
}

function EditRow({ label, caption, divider, remove, dense = false }) {
  const { s, c } = useDesign();
  return (
    <View style={[dense ? s.drawerItem : [s.folderRow, s.groupedFolderRow], divider && !dense && s.separator]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Remove ${label}`}
        onPress={remove}
        style={({ pressed }) => [s.favoriteControl, pressed && s.pressed]}
      >
        <Icon name="circle-minus" color={c.danger} />
      </Pressable>
      <View style={[s.flex, s.stack]}>
        <Text numberOfLines={1} style={dense ? s.navLabel : s.rowTitle}>
          {label}
        </Text>
        {!!caption && (
          <Text numberOfLines={1} style={s.caption}>
            {caption}
          </Text>
        )}
      </View>
    </View>
  );
}

function SectionHead({ label, editing, setEditing, editable }) {
  const { s } = useDesign();
  return (
    <View style={s.favoritesHead}>
      <Text style={s.eyebrow}>{label}</Text>
      {editable && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={editing ? "Done editing Favorites" : "Edit Favorites"}
          hitSlop={12}
          onPress={() => setEditing(!editing)}
        >
          <Text style={s.favoritesEdit}>{editing ? "Done" : "Edit"}</Text>
        </Pressable>
      )}
    </View>
  );
}

export function FavoritesSection({ items, describe, open, remove }) {
  const { s, c } = useDesign();
  const [editing, setEditing] = useState(false);
  const [all, setAll] = useState(false);
  const [rows, left] = useLeaving(items, favoriteKey);
  useEffect(() => {
    if (!items.length) setEditing(false);
  }, [items.length]);
  if (!rows.length) return null;
  const shown = editing || all ? rows : rows.slice(0, PHONE_FAVORITES);
  return (
    <Section>
      <SectionHead label="FAVORITES" editing={editing} setEditing={setEditing} editable />
      <View style={s.group}>
        {shown.map(({ item: entry, key, leaving }, index) => {
          const { label, caption, cover, icon } = describe(entry);
          return (
            <Rise key={key} leaving={leaving} onLeft={() => left(key)}>
              {editing ? (
                <EditRow
                  label={label}
                  caption={caption}
                  divider={index > 0}
                  remove={() => remove(entry)}
                />
              ) : (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={caption ? `Open ${label}, ${caption}` : `Open ${label}`}
                  onPress={() => open(entry)}
                  style={({ pressed }) => [
                    s.folderRow,
                    s.groupedFolderRow,
                    index > 0 && s.separator,
                    pressed && s.pressed,
                  ]}
                >
                  <Lead entry={entry} cover={cover} icon={icon} />
                  <View style={[s.flex, s.stack]}>
                    <Text numberOfLines={1} style={s.rowTitle}>
                      {label}
                    </Text>
                    {!!caption && (
                      <Text numberOfLines={1} style={s.caption}>
                        {caption}
                      </Text>
                    )}
                  </View>
                  <Icon name="chevron" color={c.mute} />
                </Pressable>
              )}
            </Rise>
          );
        })}
        {!editing && !all && items.length > PHONE_FAVORITES && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Show all ${items.length} favorites`}
            onPress={() => setAll(true)}
            style={({ pressed }) => [s.folderRow, s.groupedFolderRow, s.separator, pressed && s.pressed]}
          >
            <Text style={[s.rowTitle, s.active, s.flex]}>Show all</Text>
            <Text style={s.caption}>{items.length}</Text>
          </Pressable>
        )}
      </View>
    </Section>
  );
}

export function FavoritesDrawer({
  visible,
  onClose,
  view,
  select,
  items,
  describe,
  open,
  remove,
}) {
  const { s, c } = useDesign();
  const { duration, easing } = useMotion();
  const [rows, left] = useLeaving(items, favoriteKey);
  const progress = useRef(new Animated.Value(0)).current;
  const [shown, setShown] = useState(visible);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (visible) setShown(true);
    Animated.timing(progress, {
      toValue: visible ? 1 : 0,
      duration: duration(visible ? motion.enter : motion.exit),
      easing,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished && !visible) {
        setShown(false);
        setEditing(false);
      }
    });
  }, [visible]);
  if (!shown) return null;
  const go = (action) => {
    onClose();
    action();
  };
  return (
    <Modal
      visible
      transparent
      animationType="none"
      supportedOrientations={["portrait", "landscape-left", "landscape-right"]}
      presentationStyle="overFullScreen"
      onRequestClose={onClose}
    >
      <View style={s.modalRoot} pointerEvents={visible ? "auto" : "none"}>
        <Animated.View style={[s.modalBackdrop, { opacity: progress }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close favorites"
            style={s.flex}
            onPress={onClose}
          />
        </Animated.View>
        <Animated.View
          style={[
            s.drawer,
            {
              transform: [
                {
                  translateX: progress.interpolate({
                    inputRange: [0, 1],
                    outputRange: [-DRAWER_WIDTH, 0],
                  }),
                },
              ],
            },
          ]}
        >
          <SafeAreaView edges={["top", "bottom", "left"]} style={s.drawerBody}>
            <View style={s.brand}>
              <BrandActivity />
              <Text style={s.heading}>arca</Text>
            </View>
            {NAV.map(([tab, icon]) => (
              <Pressable
                key={tab}
                accessibilityRole="tab"
                accessibilityLabel={tab}
                accessibilityState={{ selected: view === tab }}
                onPress={() => go(() => select(tab))}
                style={({ pressed }) => [s.drawerItem, view === tab && s.navSelected, pressed && s.pressed]}
              >
                <Icon name={icon} color={view === tab ? c.accent : c.mute} />
                <Text numberOfLines={1} style={[s.navLabel, s.flex, view === tab && s.active]}>
                  {tab}
                </Text>
              </Pressable>
            ))}
            {rows.length > 0 && (
              <ScrollView style={s.flex} contentContainerStyle={s.drawerList}>
                <SectionHead label="FAVORITES" editing={editing} setEditing={setEditing} editable />
                {rows.map(({ item: entry, key, leaving }) => {
                  const { label, icon, state } = describe(entry);
                  return (
                    <Rise key={key} leaving={leaving} onLeft={() => left(key)}>
                      {editing ? (
                        <EditRow dense label={label} remove={() => remove(entry)} />
                      ) : (
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={state ? `${label}, ${state}` : label}
                          onPress={() => go(() => open(entry))}
                          style={({ pressed }) => [s.drawerItem, pressed && s.pressed]}
                        >
                          <Icon name={icon || FAVORITE_ICONS[entry.kind]} color={c.mute} />
                          <Text numberOfLines={1} style={[s.navLabel, s.flex]}>
                            {label}
                          </Text>
                          {!!state && (
                            <View style={[s.favoriteDot, state === "Conflict" && s.favoriteDotWarning]} />
                          )}
                        </Pressable>
                      )}
                    </Rise>
                  );
                })}
              </ScrollView>
            )}
          </SafeAreaView>
        </Animated.View>
      </View>
    </Modal>
  );
}
