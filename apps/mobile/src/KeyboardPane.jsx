import React, { createContext, useEffect, useRef, useState } from "react";
import { Keyboard, Platform, ScrollView, StyleSheet, View } from "react-native";
import { keyboardOverlap, focusScrollDelta } from "./keyboard.js";

export const FieldFocus = createContext(null);

export function useKeyboardVisible() {
  const [visible, setVisible] = useState(Keyboard.isVisible());
  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", () =>
      setVisible(true),
    );
    const hide = Keyboard.addListener("keyboardDidHide", () =>
      setVisible(false),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return visible;
}

export function KeyboardPane({ children, style }) {
  const base = StyleSheet.flatten(style) || {};
  const basePadding =
    base.paddingBottom ?? base.paddingVertical ?? base.padding ?? 0;
  const pane = useRef(null);
  const keyboard = useRef(Keyboard.metrics());
  const [paddingBottom, setPadding] = useState(0);
  const measure = () =>
    pane.current?.measureInWindow((x, y, width, height) => {
      setPadding(keyboardOverlap(y, height, keyboard.current?.screenY));
    });
  useEffect(() => {
    const update = (event) => {
      keyboard.current = event.endCoordinates;
      measure();
    };
    const hide = () => {
      keyboard.current = null;
      setPadding(0);
    };
    const subscriptions = [
      Keyboard.addListener("keyboardDidShow", update),
      Keyboard.addListener("keyboardDidHide", hide),
    ];
    if (Platform.OS === "ios")
      subscriptions.push(
        Keyboard.addListener("keyboardWillChangeFrame", update),
        Keyboard.addListener("keyboardWillHide", hide),
      );
    return () => subscriptions.forEach((s) => s.remove());
  }, []);
  return (
    <View
      ref={pane}
      collapsable={false}
      onLayout={measure}
      style={[style, { paddingBottom: basePadding + paddingBottom }]}
    >
      {children}
    </View>
  );
}

// Used by every form, including sheets. Focus changes and viewport changes both
// reveal the field; no fixed keyboard height or delayed scroll timers.
export function KeyboardScrollView({ children, onScroll, onLayout, ...props }) {
  const scroll = useRef(null),
    focused = useRef(null),
    offset = useRef(0);
  const frame = useRef(null);
  const reveal = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const input = focused.current;
      if (!input || !scroll.current) return;
      scroll.current.measureInWindow((x, top, width, height) => {
        input.measureInWindow((ix, fieldTop, iw, fieldHeight) => {
          if (focused.current !== input || !height || !fieldHeight) return;
          const delta = focusScrollDelta(top, height, fieldTop, fieldHeight);
          if (Math.abs(delta) > 1)
            scroll.current?.scrollTo({
              y: Math.max(0, offset.current + delta),
              animated: false,
            });
        });
      });
    });
  };
  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", reveal);
    return () => {
      show.remove();
      cancelAnimationFrame(frame.current);
    };
  }, []);
  return (
    <ScrollView
      {...props}
      ref={scroll}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      scrollEventThrottle={16}
      onScroll={(event) => {
        offset.current = event.nativeEvent.contentOffset.y;
        onScroll?.(event);
      }}
      onLayout={(event) => {
        reveal();
        onLayout?.(event);
      }}
    >
      <FieldFocus.Provider
        value={{
          focus: (input) => {
            focused.current = input;
            reveal();
          },
          blur: (input) => {
            if (focused.current === input) focused.current = null;
          },
        }}
      >
        {children}
      </FieldFocus.Provider>
    </ScrollView>
  );
}
