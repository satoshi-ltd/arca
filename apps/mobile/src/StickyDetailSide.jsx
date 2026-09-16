import React, { useContext, useEffect, useMemo, useRef, useState } from "react";
import { Animated, ScrollView, View } from "react-native";
import { ScrollPosition } from "./KeyboardPane";
import { useDesign } from "./components";

// Keep the original column in layout; move only its contents on the native driver.
export function StickyDetailSide({ children }) {
  const { s, wide } = useDesign();
  const position = useContext(ScrollPosition);
  const column = useRef(null);
  const [bounds, setBounds] = useState({ top: 0, height: 0 });
  const [sideHeight, setSideHeight] = useState(0);
  const measure = () =>
    position?.measure(column.current, (next) => {
      setBounds((old) =>
        old.top === next.top && old.height === next.height ? old : next,
      );
    });
  useEffect(() => {
    if (wide) measure();
  }, [position, wide, sideHeight]);
  const motion = useMemo(() => {
    const travel = Math.max(0, bounds.height - sideHeight);
    return {
      transform: [
        {
          translateY:
            position && travel > 0
              ? position.scrollY.interpolate({
                  inputRange: [bounds.top, bounds.top + travel],
                  outputRange: [0, travel],
                  extrapolate: "clamp",
                })
              : 0,
        },
      ],
    };
  }, [position, bounds, sideHeight]);
  const viewportStyle = useMemo(
    () => ({ maxHeight: position?.viewport.height || undefined }),
    [position?.viewport.height],
  );
  if (!wide || !position) return <View style={s.detailSide}>{children}</View>;
  return (
    <View
      ref={column}
      collapsable={false}
      style={s.detailSide}
      onLayout={measure}
    >
      <Animated.View style={motion}>
        <ScrollView
          nestedScrollEnabled
          keyboardShouldPersistTaps="handled"
          style={[s.stickySideScroll, viewportStyle]}
          contentContainerStyle={s.stickySideContent}
          onLayout={(event) => setSideHeight(event.nativeEvent.layout.height)}
        >
          {children}
        </ScrollView>
      </Animated.View>
    </View>
  );
}
