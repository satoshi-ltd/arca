import { AccessibilityInfo, Platform } from "react-native";
import { noticeAnnouncement } from "./notice-announce.js";

export const screenReaderOn = () => AccessibilityInfo.isScreenReaderEnabled().catch(() => false);
export const announceNotice = (item) => Platform.OS === "ios" && AccessibilityInfo.announceForAccessibility(noticeAnnouncement(item));
