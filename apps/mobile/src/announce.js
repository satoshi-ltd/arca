import { AccessibilityInfo, Platform } from "react-native";
import { noticeAnnouncement } from "./notice-announce.js";

export const announceNotice = (item) => Platform.OS === "ios" && AccessibilityInfo.announceForAccessibility(noticeAnnouncement(item));
