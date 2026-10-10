import React, { useEffect, useRef, useState } from "react";
import {
  Animated,
  PanResponder,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useDesign, Icon } from "./components";
import { native } from "./private-network";
import { useLeaving, useMotion } from "./motion";
import { motion } from "./design-tokens.js";
import {
  noticeMetrics,
  safeDetails,
  errorNotice,
} from "../../desktop/src/notice-contract.js";
const iconNames = {
  "circle-check": "check-circle",
  "circle-alert": "alert",
  "triangle-alert": "conflict",
};
export function Notice({ item, onDismiss, onAction, disabled, leaving = false, onLeft }) {
  const { s, c } = useDesign();
  const { duration, easing } = useMotion();
  const [expanded, setExpanded] = useState(false),
    [copied, setCopied] = useState("");
  const progress = useRef(new Animated.Value(0)).current;
  const drag = useRef(new Animated.Value(0)).current;
  const lift = useRef(
    Animated.add(
      progress.interpolate({ inputRange: [0, 1], outputRange: [noticeMetrics.distance, 0] }),
      drag,
    ),
  ).current;
  useEffect(() => {
    Animated.timing(progress, {
      toValue: leaving ? 0 : 1,
      duration: duration(leaving ? motion.exit : motion.enter),
      easing,
      useNativeDriver: true,
    }).start(({ finished }) => finished && leaving && onLeft?.());
  }, [leaving]);
  const swap = useRef(new Animated.Value(1)).current;
  const shownAt = useRef(item.created);
  useEffect(() => {
    if (shownAt.current === item.created) return;
    shownAt.current = item.created;
    swap.setValue(0);
    Animated.timing(swap, { toValue: 1, duration: duration(motion.fast), easing, useNativeDriver: true }).start();
  }, [item.created]);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const settle = useRef(null);
  settle.current = () =>
    Animated.timing(drag, { toValue: 0, duration: duration(motion.fast), easing, useNativeDriver: true }).start();
  const swipe = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) =>
        g.dy > 12 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderMove: (_, g) => drag.setValue(Math.max(0, g.dy)),
      onPanResponderRelease: (_, g) => {
        if (g.dy > 32) dismiss.current();
        else settle.current();
      },
      onPanResponderTerminate: () => settle.current(),
    }),
  ).current;
  const info = item.kind === "info";
  return (
    <Animated.View
      style={[
        s.noticeCard,
        info && s.noticeInfo,
        { opacity: progress, transform: [{ translateY: lift }] },
      ]}
      pointerEvents={leaving ? "none" : "auto"}
      accessibilityLiveRegion={info ? "polite" : "assertive"}
    >
      <Animated.View style={[s.noticeMain, { opacity: swap }]} {...swipe.panHandlers}>
        <Icon
          name={iconNames[item.icon] || item.icon || "check-circle"}
          size={noticeMetrics.icon}
          color={
            info
              ? c.noticeInfoLink
              : item.kind === "warning"
                ? c.warning
                : c.danger
          }
        />
        <View style={s.flex}>
          <Text style={[s.noticeTitle, info && s.noticeInfoText]}>
            {item.title}
          </Text>
          {!!item.body && (
            <Text style={[s.noticeText, info && s.noticeInfoText]}>
              {item.body}
            </Text>
          )}
          {(item.action || !info) && (
            <View style={s.noticeActions}>
              {!!item.action && (
                <Pressable
                  accessibilityRole="button"
                  disabled={disabled}
                  onPress={() => onAction(item)}
                  style={s.noticeLinkTarget}
                >
                  <Text style={[s.noticeLink, info && s.noticeInfoLink]}>
                    {item.actionLabel}
                  </Text>
                </Pressable>
              )}
              {!info && (
                <Pressable
                  accessibilityRole="button"
                  onPress={onDismiss}
                  style={s.noticeLinkTarget}
                >
                  <Text style={[s.noticeLink, s.noticeMuted]}>Dismiss</Text>
                </Pressable>
              )}
            </View>
          )}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss notification"
          onPress={onDismiss}
          style={s.noticeClose}
          hitSlop={14}
        >
          <Icon name="close" size={16} color={info ? c.noticeInfoFg : c.mute} />
        </Pressable>
      </Animated.View>
      {!!item.details && (
        <View style={s.noticeDetails}>
          <View style={s.noticeDetailsHead}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded }}
              onPress={() => setExpanded(!expanded)}
              style={s.noticeDetailsToggle}
            >
              <Icon name={expanded ? "chevron-down" : "chevron"} size={14} />
              <Text style={s.noticeDetailsLabel}>Details</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              style={s.noticeLinkTarget}
              onPress={async () => {
                try {
                  if (!native.copyText) throw new Error();
                  await native.copyText(safeDetails(item.details));
                  setCopied("Copied");
                } catch {
                  setCopied("Copy unavailable");
                }
              }}
            >
              <Text style={s.noticeLink}>{copied || "Copy"}</Text>
            </Pressable>
          </View>
          {expanded && (
            <ScrollView style={s.noticeTraceScroll}>
              <Text selectable style={s.noticeTrace}>
                {safeDetails(item.details)}
              </Text>
            </ScrollView>
          )}
        </View>
      )}
    </Animated.View>
  );
}
const noticeKey = (item) => item.id;
export function NoticeStack({ items, onDismiss, onAction, disabled }) {
  const { s } = useDesign(),
    insets = useSafeAreaInsets(),
    { height } = useWindowDimensions();
  const [rows, left] = useLeaving(items, noticeKey);
  if (!rows.length) return null;
  return (
    <View
      pointerEvents="box-none"
      style={[
        s.noticeDock,
        {
          bottom: insets.bottom + noticeMetrics.inset,
          maxHeight:
            height - insets.top - insets.bottom - 2 * noticeMetrics.inset,
        },
      ]}
    >
      <ScrollView
        style={s.noticeStackScroll}
        contentContainerStyle={s.noticeStack}
        keyboardShouldPersistTaps="handled"
      >
        {rows.map(({ item, key, leaving }) => (
          <Notice
            key={key}
            item={item}
            disabled={disabled}
            leaving={leaving}
            onLeft={() => left(key)}
            onDismiss={() => !leaving && onDismiss(item.id)}
            onAction={onAction}
          />
        ))}
      </ScrollView>
    </View>
  );
}

export function ErrorNotice({ error, retry }) {
  const [dismissed, setDismissed] = useState("");
  const [leaving, setLeaving] = useState("");
  useEffect(() => {
    if (!error) setDismissed("");
    setLeaving("");
  }, [error]);
  if (!error || dismissed === error) return null;
  const item = errorNotice(error);
  return (
    <Notice
      item={{
        ...item,
        action: retry && item.action ? "retry" : null,
        actionLabel: "Retry now",
      }}
      leaving={leaving === error}
      onLeft={() => setDismissed(error)}
      onDismiss={() => setLeaving(error)}
      onAction={() => retry?.()}
    />
  );
}
