import { AppState, Platform } from "react-native";
import * as MediaLibrary from "expo-media-library/legacy";
import { native } from "./private-network";

export const mediaLibrary = {
  foreground: () => AppState.currentState === "active",
  canRemove: () =>
    typeof native.exportGalleryAssetForRemoval === "function" &&
    (Platform.OS === "ios" ||
      (Platform.OS === "android" &&
        Platform.Version >= 30 &&
        typeof native.trashGalleryAssets === "function")),
  exportForRemoval: (id, destination) =>
    native.exportGalleryAssetForRemoval(id, destination),
  async remove(ids) {
    if (AppState.currentState !== "active")
      throw new Error("Keep Arca open while reviewing originals.");
    if (Platform.OS === "android") return native.trashGalleryAssets(ids);
    return (await MediaLibrary.deleteAssetsAsync(ids)) ? ids : [];
  },
  permission(videos, request = false) {
    return MediaLibrary[
      request ? "requestPermissionsAsync" : "getPermissionsAsync"
    ](false, videos ? ["photo", "video"] : ["photo"]);
  },
  albums: () => MediaLibrary.getAlbumsAsync({ includeSmartAlbums: true }),
  page(source) {
    return MediaLibrary.getAssetsAsync({
      first: 100,
      ...(source.after ? { after: source.after } : {}),
      ...(source.albumId ? { album: source.albumId } : {}),
      mediaType: source.videos ? ["photo", "video"] : ["photo"],
      sortBy: [["creationTime", false]],
    });
  },
  async preview(id) {
    // Never fetch a cloud original just to render the gallery screen.
    const asset = await MediaLibrary.getAssetInfoAsync(id, {
      shouldDownloadFromNetwork: false,
    });
    return {
      uri:
        asset.localUri ||
        (asset.uri?.startsWith("file:") || asset.uri?.startsWith("content:")
          ? asset.uri
          : null),
      video: asset.mediaType === "video",
      modificationTime: asset.modificationTime,
    };
  },
  export: (id, destination) => native.exportGalleryAsset(id, destination),
};
