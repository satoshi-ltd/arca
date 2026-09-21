import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AccessibilityInfo, Animated, Easing } from "react-native";
import { motion, motionDurations } from "./design-tokens.js";

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
