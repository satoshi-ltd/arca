import React, { createContext, useContext } from "react";
import { Text as NativeText } from "react-native";
export const FontCap = createContext(0);
export function Text({ maxFontSizeMultiplier, ...props }) {
  const cap = useContext(FontCap);
  return <NativeText maxFontSizeMultiplier={maxFontSizeMultiplier ?? cap} {...props} />;
}
