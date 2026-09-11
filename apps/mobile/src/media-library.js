import * as MediaLibrary from "expo-media-library";
import { native } from "./private-network";

export const mediaLibrary = {
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
    };
  },
  export: (id, destination) => native.exportGalleryAsset(id, destination),
};
