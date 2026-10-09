import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AccessibilityInfo, Animated, Easing } from "react-native";
import { geometry, motion, motionDurations } from "./design-tokens.js";
import { createListMotion } from "./list-motion.js";
import { flightTransform, takeFlight } from "./flight.js";

export function useReduceMotion() {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let active = true;
    AccessibilityInfo.isReduceMotionEnabled().then(
      (value) => active && setReduce(value),
    );
    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReduce,
    );
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);
  return reduce;
}
export function useMotion() {
  const reduce = useReduceMotion();
  return useMemo(
    () => ({
      reduce,
      ...motionDurations(reduce),
      duration: (ms) => (reduce ? 0 : ms),
      easing: Easing.bezier(...motion.ease),
    }),
    [reduce],
  );
}
// Keeps the last truthy value until `release` runs, so a sheet can animate out after its state is cleared.
export function useRetained(value) {
  const [kept, setKept] = useState(value);
  useEffect(() => {
    if (value) setKept(value);
  }, [value]);
  const release = useCallback(() => setKept(null), []);
  return [value || kept, release];
}
export function ScreenEnter({ kind = "fade", style, children }) {
  const { duration, easing } = useMotion();
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(progress, {
      toValue: 1,
      duration: duration(motion.enter),
      easing,
      useNativeDriver: true,
    }).start();
  }, []);
  const push =
    kind === "forward" ? motion.push : kind === "back" ? -motion.push : 0;
  const offset = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [push, 0],
  });
  return (
    <Animated.View
      style={[
        style,
        {
          opacity: progress,
          transform: [{ translateX: offset }],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}
export function useListMotion(ids) {
  const note = useRef(null);
  if (!note.current) note.current = createListMotion();
  note.current.note(ids);
  return note.current.take;
}
export function Rise({ mode: entering, index: slot = 0, tint: tintColor, children }) {
  const first = useRef({ mode: entering, index: slot }).current;
  const { mode, index } = first;
  const { duration, easing, reduce } = useMotion();
  const progress = useRef(new Animated.Value(mode && !reduce ? 0 : 1)).current;
  const tint = useRef(new Animated.Value(mode === "arrival" && !reduce ? 0.7 : 0)).current;
  useEffect(() => {
    if (!mode || reduce) return;
    Animated.timing(progress, {
      toValue: 1,
      delay: index * motion.stagger,
      duration: duration(motion.enter),
      easing,
      useNativeDriver: true,
    }).start();
    if (mode === "arrival")
      Animated.timing(tint, {
        toValue: 0,
        duration: duration(motion.settle),
        useNativeDriver: true,
      }).start();
  }, []);
  return (
    <Animated.View
      style={{
        opacity: progress,
        transform: [
          {
            translateY: progress.interpolate({
              inputRange: [0, 1],
              outputRange: [motion.distance, 0],
            }),
          },
        ],
      }}
    >
      {children}
      {mode === "arrival" && (
        <Animated.View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: 0,
            right: 0,
            bottom: 0,
            left: 0,
            borderRadius: geometry.cardRadius,
            backgroundColor: tintColor,
            opacity: tint,
          }}
        />
      )}
    </Animated.View>
  );
}
export function useFlight(key) {
  const { duration, easing } = useMotion();
  const frame = useRef(null);
  const progress = useRef(new Animated.Value(1)).current;
  const [from] = useState(() => (key ? takeFlight(key) : null));
  const [state, setState] = useState({ ready: !from, shape: null });
  useEffect(() => {
    if (!from) return;
    const give = setTimeout(() => setState({ ready: true, shape: null }), 300);
    if (!duration(motion.shared) || !frame.current?.measureInWindow) {
      clearTimeout(give);
      return setState({ ready: true, shape: null });
    }
    frame.current.measureInWindow((x, y, width, height) => {
      clearTimeout(give);
      const shape = flightTransform(from, { x, y, width, height });
      setState({ ready: true, shape });
      if (!shape) return;
      progress.setValue(0);
      Animated.timing(progress, {
        toValue: 1,
        duration: duration(motion.shared),
        easing,
        useNativeDriver: true,
      }).start();
    });
  }, []);
  const { shape } = state;
  return {
    frame,
    style: {
      opacity: state.ready ? 1 : 0,
      transform: shape
        ? [
            { translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [shape.dx, 0] }) },
            { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [shape.dy, 0] }) },
            { scale: progress.interpolate({ inputRange: [0, 1], outputRange: [shape.scale, 1] }) },
          ]
        : [],
    },
  };
}
