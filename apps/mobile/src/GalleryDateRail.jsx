import React, { useEffect, useRef, useState } from "react";
import { View, Text } from "react-native";
import { useDesign } from "./components";
import { timelineSegments } from "../../desktop/src/gallery-timeline-layout.js";
import { monthLabel, railMonthLabel } from "./gallery-timeline";

// One gesture chooses a month; fetching happens only when the finger is released.
export function GalleryDateRail({ dates, controller, onSeek, viewport }) {
  const { s } = useDesign();
  const [height, setHeight] = useState(1);
  const [position, setPosition] = useState(0);
  const segments = timelineSegments(
    dates.map((date) => date.count),
    Math.max(1, height - 32),
    4,
  );
  const [visible, setVisible] = useState(false);
  const [month, setMonth] = useState("");
  const [currentMonth, setCurrentMonth] = useState("");
  const [dragging, setDragging] = useState(false);
  const timer = useRef(null),
    rail = useRef(null),
    bounds = useRef({ top: 0, height: 1 });
  const held = useRef(false),
    chosen = useRef("");
  const hideLater = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setVisible(false), 2000);
  };
  useEffect(() => {
    controller.current = {
      update(value) {
        setCurrentMonth(value || dates[0]?.month);
      },
      show(value) {
        if (dates.length < 2) return;
        setVisible(true);
        setCurrentMonth(value || dates[0]?.month);
        if (!held.current) {
          setMonth(value || dates[0]?.month);
          hideLater();
        }
      },
    };
    return () => {
      controller.current = null;
    };
  }, [controller, dates]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const choose = (pageY) => {
    const y = Math.max(
      0,
      Math.min(height - 32, pageY - bounds.current.top - 16),
    );
    const index = segments.findIndex(
      (segment) => y < segment.top + segment.size,
    );
    chosen.current = dates[index < 0 ? dates.length - 1 : index]?.month;
    setPosition(y);
    setMonth(chosen.current);
  };
  const finish = () => {
    held.current = false;
    setDragging(false);
    if (chosen.current) onSeek(chosen.current);
    hideLater();
  };
  if (!visible || dates.length < 2) return null;
  let previousYear = "",
    lastTick = -Infinity;
  const years = [];
  const marks = dates.map((date, index) => {
    const top = segments[index].top;
    const year = date.month.slice(0, 4);
    if (year !== previousYear) years.push({ index, top });
    previousYear = year;
    const tick = top - lastTick >= 4;
    if (tick) lastTick = top;
    return { ...date, top, tick };
  });
  const shown = [];
  years.forEach((year, index) => {
    const oldest = index === years.length - 1;
    while (oldest && shown.length > 1 && year.top - shown.at(-1).top < 20)
      shown.pop();
    if (oldest || !shown.length || year.top - shown.at(-1).top >= 20)
      shown.push(year);
  });
  const labelMonth = dragging ? month : currentMonth;
  const labelTop = dragging
    ? position
    : segments[
        Math.max(
          0,
          dates.findIndex((date) => date.month === currentMonth),
        )
      ]?.top || 0;
  return (
    <View
      style={[s.dateRailOverlay, { top: viewport.y, height: viewport.height }]}
      pointerEvents="box-none"
    >
      {!!labelMonth && (
        <Text
          pointerEvents="none"
          numberOfLines={1}
          style={[s.dateRailBubble, { top: 16 + labelTop }]}
        >
          {dates[0]?.annual
            ? labelMonth.slice(0, 4)
            : railMonthLabel(labelMonth)}
        </Text>
      )}
      <View
        ref={rail}
        style={s.dateRail}
        onLayout={(event) => setHeight(event.nativeEvent.layout.height)}
        accessibilityRole="adjustable"
        accessibilityLabel="Photo date"
        accessibilityValue={{
          text: dates[0]?.annual
            ? labelMonth.slice(0, 4)
            : monthLabel(labelMonth),
        }}
        accessibilityActions={[
          {
            name: "increment",
            label: dates[0]?.annual ? "Older year" : "Older month",
          },
          {
            name: "decrement",
            label: dates[0]?.annual ? "Newer year" : "Newer month",
          },
        ]}
        onAccessibilityAction={(event) => {
          const index = Math.max(
            0,
            dates.findIndex((date) => date.month === labelMonth),
          );
          const next =
            dates[
              Math.max(
                0,
                Math.min(
                  dates.length - 1,
                  index +
                    (event.nativeEvent.actionName === "increment" ? 1 : -1),
                ),
              )
            ].month;
          setMonth(next);
          onSeek(next);
          hideLater();
        }}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderTerminationRequest={() => false}
        onResponderGrant={(event) => {
          held.current = true;
          setDragging(true);
          clearTimeout(timer.current);
          const y = event.nativeEvent.pageY;
          rail.current?.measureInWindow((x, top, width, height) => {
            bounds.current = { top, height: Math.max(1, height) };
            if (held.current) choose(y);
          });
        }}
        onResponderMove={(event) => choose(event.nativeEvent.pageY)}
        onResponderRelease={finish}
        onResponderTerminate={() => {
          held.current = false;
          setDragging(false);
          hideLater();
        }}
      >
        {marks.map((date, index) => (
          <View
            key={date.month}
            pointerEvents="none"
            style={[s.dateRailMark, { top: 16 + date.top }]}
          >
            {shown.some((year) => year.index === index) && (
              <Text style={s.dateRailYear}>{date.month.slice(0, 4)}</Text>
            )}
            {(date.tick ||
              currentMonth === date.month ||
              (dragging && month === date.month)) && (
              <View
                style={[
                  s.dateRailTick,
                  dragging && month === date.month && s.dateRailHovered,
                  currentMonth === date.month && s.dateRailCurrent,
                ]}
              />
            )}
          </View>
        ))}
      </View>
    </View>
  );
}
