import React, { useEffect, useRef, useState } from "react";
import { Animated, Text, View } from "react-native";
import { Icon, useDesign } from "./components";
import { SCRUB_THUMB as THUMB, scrubYears } from "./gallery-layout";

const READING_GUIDE = 80;

// Only the thumb takes touches (edge photos stay tappable); a native-scroll-bound position stops it following the finger.
export function GalleryDateRail({ model, viewport, controller }) {
  const { s, c } = useDesign();
  const [visible, setVisible] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [label, setLabel] = useState("");
  const thumb = useRef(new Animated.Value(0)).current;
  const timer = useRef(null),
    frame = useRef(null),
    pending = useRef(null),
    held = useRef(false),
    shown = useRef(false),
    top = useRef(0),
    grab = useRef({ pageY: 0, top: 0 }),
    current = useRef(model);
  current.current = model;
  const travel = Math.max(1, viewport.height - THUMB);
  const travelRef = useRef(travel);
  travelRef.current = travel;
  const place = (value) => {
    top.current = value;
    thumb.setValue(value);
  };
  const follow = (offset) => {
    const target = current.current;
    if (!target || target.end <= target.start) return;
    place(
      Math.min(1, Math.max(0, (offset - target.start) / (target.end - target.start))) *
        travelRef.current,
    );
  };
  const hideLater = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      shown.current = false;
      setVisible(false);
    }, 1500);
  };
  useEffect(() => {
    controller.current = {
      reveal(offset) {
        if (!held.current) {
          follow(offset);
          hideLater();
        }
        if (!shown.current) {
          shown.current = true;
          setVisible(true);
        }
      },
    };
    return () => {
      controller.current = null;
    };
  }, [controller]);
  useEffect(() => {
    if (model && !held.current) follow(model.offset());
  }, [model, travel]);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      cancelAnimationFrame(frame.current);
    },
    [],
  );
  const at = (y) => {
    const sections = current.current?.sections || [];
    let found = sections[0];
    for (const section of sections) {
      if (section.offset > y + READING_GUIDE) break;
      found = section;
    }
    return found;
  };
  const release = () => {
    held.current = false;
    cancelAnimationFrame(frame.current);
    frame.current = null;
    if (pending.current !== null) current.current?.scrollTo(pending.current);
    pending.current = null;
    setDragging(false);
    current.current?.scrub(false);
    hideLater();
  };
  if (
    !model?.sections.length ||
    model.end - model.start <= viewport.height ||
    (!visible && !dragging)
  )
    return null;
  const index = Math.max(0, model.sections.indexOf(at(model.offset())));
  const move = (step) => {
    const target = model.sections[index + step];
    if (target) model.scrollTo(Math.min(model.end, target.offset));
  };
  return (
    <View
      style={[s.dateRailOverlay, { top: viewport.y, height: viewport.height }]}
      pointerEvents="box-none"
    >
      {dragging && <View pointerEvents="none" style={s.scrubTrack} />}
      {dragging &&
        scrubYears(model.sections, model.start, model.end, travel).map(
          (year) => (
            <Text
              key={year.key}
              pointerEvents="none"
              style={[s.scrubYear, { top: year.top }]}
            >
              {year.year}
            </Text>
          ),
        )}
      {dragging && !!label && (
        <Animated.View
          pointerEvents="none"
          style={[
            s.scrubBubble,
            { transform: [{ translateY: Animated.add(thumb, THUMB / 2 - 16) }] },
          ]}
        >
          <Text numberOfLines={1} style={s.scrubBubbleText}>
            {label}
          </Text>
        </Animated.View>
      )}
      <Animated.View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel="Photo date"
        accessibilityValue={{ text: model.sections[index]?.label || "" }}
        accessibilityActions={[
          { name: "increment", label: model.annual ? "Older year" : "Older month" },
          { name: "decrement", label: model.annual ? "Newer year" : "Newer month" },
        ]}
        onAccessibilityAction={(event) =>
          move(event.nativeEvent.actionName === "increment" ? 1 : -1)
        }
        hitSlop={{ top: 12, bottom: 12, left: 24, right: 8 }}
        style={[s.scrubThumb, { transform: [{ translateY: thumb }] }]}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderTerminationRequest={() => false}
        onResponderGrant={(event) => {
          held.current = true;
          clearTimeout(timer.current);
          grab.current = { pageY: event.nativeEvent.pageY, top: top.current };
          setDragging(true);
          setLabel(at(model.offset())?.label || "");
          model.scrub(true);
        }}
        onResponderMove={(event) => {
          const target = current.current;
          if (!target) return;
          const next = Math.min(
            travelRef.current,
            Math.max(
              0,
              grab.current.top + event.nativeEvent.pageY - grab.current.pageY,
            ),
          );
          place(next);
          const y =
            target.start + (next / travelRef.current) * (target.end - target.start);
          pending.current = y;
          frame.current ||= requestAnimationFrame(() => {
            frame.current = null;
            if (pending.current !== null) current.current?.scrollTo(pending.current);
          });
          setLabel(at(y)?.label || "");
        }}
        onResponderRelease={release}
        onResponderTerminate={release}
      >
        <View style={s.flipped}>
          <Icon name="chevron-down" size={16} color={c.onAccent} />
        </View>
        <Icon name="chevron-down" size={16} color={c.onAccent} />
      </Animated.View>
    </View>
  );
}
