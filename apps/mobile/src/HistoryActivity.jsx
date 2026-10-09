import React, { useContext, useEffect, useMemo, useRef, useState } from "react";
import { PanResponder, Pressable, Text, View } from "react-native";
import { Icon, Section, useDesign } from "./components";
import { ScrollPosition } from "./KeyboardPane";
import { STRIP_DAYS, awayText, barIndexAt, dayName } from "./history-activity.js";

export function ActivityStrip({ bars, onJump }) {
  const { s } = useDesign();
  const position = useContext(ScrollPosition);
  const [held, setHeld] = useState(null);
  const [spoken, setSpoken] = useState(bars.length - 1);
  const width = useRef(0);
  const heldRef = useRef(null);
  const latest = useRef({ bars, onJump, position });
  latest.current = { bars, onJump, position };
  const responder = useMemo(() => {
    const at = (event) =>
      barIndexAt(event.nativeEvent.locationX, width.current, STRIP_DAYS);
    const move = (event) => {
      heldRef.current = at(event);
      setHeld(heldRef.current);
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (event) => {
        latest.current.position?.setGestureActive(true);
        move(event);
      },
      onPanResponderMove: move,
      onPanResponderRelease: () => {
        const index = heldRef.current;
        heldRef.current = null;
        setHeld(null);
        latest.current.position?.setGestureActive(false);
        if (index != null) latest.current.onJump(latest.current.bars[index].key);
      },
      onPanResponderTerminate: () => {
        heldRef.current = null;
        setHeld(null);
        latest.current.position?.setGestureActive(false);
      },
    });
  }, []);
  const shown = held;
  const step = (delta) =>
    setSpoken((old) => Math.min(bars.length - 1, Math.max(0, old + delta)));
  return (
    <View style={s.activityStrip}>
      <View style={s.activityHead}>
        <Text style={s.eyebrow}>LAST 30 DAYS</Text>
        {shown != null ? (
          <View style={s.activityChip}>
            <Text style={s.activityChipText}>{bars[shown].caption}</Text>
          </View>
        ) : (
          <View style={s.activityLegend}>
            <View style={s.dayDevice}>
              <View style={[s.activityDot, s.activityLegendChanges]} />
              <Text style={s.activityLegendText}>Changes</Text>
            </View>
            <View style={s.dayDevice}>
              <View style={[s.activityDot, s.activityConflict]} />
              <Text style={s.activityLegendText}>Conflict</Text>
            </View>
            <View style={s.dayDevice}>
              <View style={[s.activityDot, s.activityDeleted]} />
              <Text style={s.activityLegendText}>Deleted</Text>
            </View>
          </View>
        )}
      </View>
      <View
        {...responder.panHandlers}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel="Last 30 days of activity"
        accessibilityValue={{ min: 0, max: bars.length - 1, now: spoken, text: bars[spoken].caption }}
        accessibilityActions={[
          { name: "increment" },
          { name: "decrement" },
          { name: "activate", label: "Jump to day" },
        ]}
        onAccessibilityAction={(event) => {
          const name = event.nativeEvent.actionName;
          if (name === "increment") step(1);
          else if (name === "decrement") step(-1);
          else if (name === "activate") onJump(bars[spoken].key);
        }}
        onLayout={(event) => {
          width.current = event.nativeEvent.layout.width;
        }}
        style={s.activityBars}
      >
        {bars.map((bar, index) => (
          <View
            key={bar.key}
            pointerEvents="none"
            style={[s.activityBar, shown === index && s.activityBarHeld]}
          >
            {!!bar.mark && (
              <View
                style={[
                  s.activityDot,
                  bar.mark === "conflict" ? s.activityConflict : s.activityDeleted,
                ]}
              />
            )}
            <View
              style={[
                s.activityFill,
                { height: bar.level ? 4 * bar.level : 2 },
                (bar.today || shown === index) && s.activityFillStrong,
              ]}
            />
          </View>
        ))}
      </View>
      <View style={s.activityAxis}>
        <Text style={s.caption}>{dayName(bars[0].key)}</Text>
        <Text style={s.caption}>{dayName(bars[Math.floor(bars.length / 2)].key)}</Text>
        <Text style={[s.caption, s.activityToday]}>Today</Text>
      </View>
    </View>
  );
}

export function AwayBanner({ notice, nameOf, onDismiss }) {
  const { s } = useDesign();
  return (
    <View style={[s.card, s.awayBanner]} accessibilityRole="alert">
      <Icon name="history" />
      <View style={[s.flex, s.stack]}>
        <Text style={s.rowTitle}>Changed while you were away</Text>
        <Text style={s.caption}>{awayText(notice, nameOf)}</Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Dismiss"
        onPress={onDismiss}
        style={s.awayDismiss}
      >
        <Icon name="close" />
      </Pressable>
    </View>
  );
}

export function DayGroup({ dayKey, landing, onLanded, header, summary, children }) {
  const { s } = useDesign();
  const ref = useRef(null);
  const position = useContext(ScrollPosition);
  useEffect(() => {
    if (landing !== dayKey) return;
    if (!position) {
      onLanded();
      return;
    }
    if (!ref.current) {
      onLanded();
      return;
    }
    const id = requestAnimationFrame(() =>
      position.measure(ref.current, ({ top }) => {
        position.scrollTo(Math.max(0, top - 8));
        onLanded();
      }),
    );
    return () => cancelAnimationFrame(id);
  }, [landing, dayKey]);
  return (
    <View ref={ref} collapsable={false} style={s.section}>
      {header}
      {!!summary && (
        <View style={s.daySummary}>
          <Text style={s.rowTitle}>{summary.text}</Text>
          {summary.devices.map((d) => (
            <View key={d.id} style={s.dayDevice}>
              <Icon name="devices" size={12} />
              <Text style={s.caption}>{`${d.name} ${d.count}`}</Text>
            </View>
          ))}
        </View>
      )}
      {children}
    </View>
  );
}
