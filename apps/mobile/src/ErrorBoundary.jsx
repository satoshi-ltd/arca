import React from "react";
import {
  Appearance,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as SplashScreen from "expo-splash-screen";
import { palettes } from "./palette.js";
import { native } from "./private-network.js";
import { safeDetails } from "../../desktop/src/notice-contract.js";

const sheet = (c) =>
  StyleSheet.create({
    root: {
      flex: 1,
      justifyContent: "center",
      padding: 24,
      gap: 16,
      backgroundColor: c.paper,
    },
    title: { color: c.ink, fontSize: 20, fontWeight: "600" },
    text: { color: c.soft, fontSize: 15, lineHeight: 22 },
    details: { maxHeight: 160 },
    trace: { color: c.mute, fontSize: 12 },
    actions: { flexDirection: "row", gap: 12 },
    button: {
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: c.line,
      backgroundColor: c.surface,
    },
    primary: { backgroundColor: c.accent, borderColor: c.accent },
    label: { color: c.ink, fontSize: 15, fontWeight: "600" },
    primaryLabel: { color: c.onAccent },
  });
const themes = { light: sheet(palettes.light), dark: sheet(palettes.dark) };

export class ErrorBoundary extends React.Component {
  state = { error: null, generation: 0 };
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch() {
    SplashScreen.hideAsync().catch(() => {});
  }
  reload = () =>
    this.setState(({ generation }) => ({
      error: null,
      generation: generation + 1,
    }));
  render() {
    const { error, generation } = this.state;
    if (!error)
      return (
        <React.Fragment key={generation}>{this.props.children}</React.Fragment>
      );
    const s = themes[Appearance.getColorScheme() === "dark" ? "dark" : "light"];
    const details = safeDetails(
      `${error?.message || error}\n${error?.stack || ""}`,
    );
    return (
      <View style={s.root}>
        <Text accessibilityRole="header" style={s.title}>
          Arca stopped unexpectedly
        </Text>
        <Text style={s.text}>
          Your files on this device are kept. Reload Arca to continue syncing.
        </Text>
        <ScrollView style={s.details}>
          <Text selectable style={s.trace}>
            {details}
          </Text>
        </ScrollView>
        <View style={s.actions}>
          <Pressable
            accessibilityRole="button"
            style={[s.button, s.primary]}
            onPress={this.reload}
          >
            <Text style={[s.label, s.primaryLabel]}>Reload</Text>
          </Pressable>
          {typeof native.copyText === "function" && (
            <Pressable
              accessibilityRole="button"
              style={s.button}
              onPress={() => native.copyText(details).catch(() => {})}
            >
              <Text style={s.label}>Copy details</Text>
            </Pressable>
          )}
        </View>
      </View>
    );
  }
}
