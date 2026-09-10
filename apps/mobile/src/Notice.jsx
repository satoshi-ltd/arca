import React, { useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
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
import {
  noticeMetrics,
  safeDetails,
  errorNotice,
} from "../../desktop/src/notice-contract.js";
const iconNames = {
  "circle-check": "check-circle",
  "circle-alert": "alert",
  "git-branch": "conflict",
};
export function Notice({ item, onDismiss, onAction, disabled }) {
  const { s, c } = useDesign();
  const [expanded, setExpanded] = useState(false),
    [copied, setCopied] = useState("");
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    let active = true;
    AccessibilityInfo.isReduceMotionEnabled().then((reduced) => {
      if (!active) return;
      Animated.timing(progress, {
        toValue: 1,
        duration: reduced ? 0 : noticeMetrics.duration,
        useNativeDriver: true,
      }).start();
    });
    return () => {
      active = false;
      progress.stopAnimation();
    };
  }, [progress]);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const swipe = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) =>
        g.dy > 12 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderRelease: (_, g) => {
        if (g.dy > 32) dismiss.current();
      },
    }),
  ).current;
  const info = item.kind === "info";
  return (
    <Animated.View
      style={[
        s.noticeCard,
        info && s.noticeInfo,
        {
          opacity: progress,
          transform: [
            {
              translateY: progress.interpolate({
                inputRange: [0, 1],
                outputRange: [noticeMetrics.distance, 0],
              }),
            },
          ],
        },
      ]}
      accessibilityLiveRegion={info ? "polite" : "assertive"}
    >
      <View style={s.noticeMain} {...swipe.panHandlers}>
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
      </View>
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
export function NoticeStack({ items, onDismiss, onAction, disabled }) {
  const { s } = useDesign(),
    insets = useSafeAreaInsets(),
    { height } = useWindowDimensions();
  if (!items.length) return null;
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
        {items.map((item) => (
          <Notice
            key={item.id + ":" + item.created}
            item={item}
            disabled={disabled}
            onDismiss={() => onDismiss(item.id)}
            onAction={onAction}
          />
        ))}
      </ScrollView>
    </View>
  );
}

export function ErrorNotice({ error, retry }) {
  const [dismissed, setDismissed] = useState("");
  useEffect(() => {
    if (!error) setDismissed("");
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
      onDismiss={() => setDismissed(error)}
      onAction={() => retry?.()}
    />
  );
}
