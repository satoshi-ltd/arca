import AVFoundation
import Foundation
import ImageIO
import UniformTypeIdentifiers

enum Thumbnails {
  // cover: the short edge reaches size (grid tiles); otherwise the long edge fits within size (viewer).
  static func write(source: String, destination: String, size: Int, cover: Bool, video: Bool) async throws {
    guard let input = URL(string: source), input.isFileURL,
      let output = URL(string: destination), output.isFileURL,
      let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first,
      input.resolvingSymlinksInPath().path.hasPrefix(URL(fileURLWithPath: NSHomeDirectory()).resolvingSymlinksInPath().path + "/"),
      output.resolvingSymlinksInPath().path.hasPrefix(caches.resolvingSymlinksInPath().path + "/"),
      (32...4096).contains(size)
    else { throw failure("Invalid thumbnail request") }
    let image: CGImage
    if video {
      image = try await frame(input, size: size)
    } else {
      image = try still(input, size: size, cover: cover)
    }
    let partial = output.appendingPathExtension("part")
    try? FileManager.default.removeItem(at: partial)
    do {
      guard let target = CGImageDestinationCreateWithURL(partial as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else {
        throw failure("Could not create the thumbnail")
      }
      CGImageDestinationAddImage(target, image, [kCGImageDestinationLossyCompressionQuality: size > 1024 ? 0.85 : 0.75] as CFDictionary)
      guard CGImageDestinationFinalize(target) else { throw failure("Could not encode the thumbnail") }
      if FileManager.default.fileExists(atPath: output.path) { try FileManager.default.removeItem(at: output) }
      try FileManager.default.moveItem(at: partial, to: output)
    } catch {
      try? FileManager.default.removeItem(at: partial)
      throw error
    }
  }

  private static func still(_ url: URL, size: Int, cover: Bool) throws -> CGImage {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary) else {
      throw failure("Unsupported image")
    }
    var edge = size
    if cover, let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
      let width = properties[kCGImagePropertyPixelWidth] as? Int,
      let height = properties[kCGImagePropertyPixelHeight] as? Int,
      min(width, height) > 0 {
      edge = min(max(width, height), Int((Double(size) * Double(max(width, height)) / Double(min(width, height))).rounded(.up)))
    }
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceShouldCacheImmediately: true,
      kCGImageSourceThumbnailMaxPixelSize: edge,
    ]
    guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
      throw failure("Unsupported image")
    }
    return image
  }

  private static func frame(_ url: URL, size: Int) async throws -> CGImage {
    let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
    generator.appliesPreferredTrackTransform = true
    generator.maximumSize = CGSize(width: size * 2, height: size * 2)
    return try await generator.image(at: .zero).image
  }

  private static func failure(_ message: String) -> NSError {
    NSError(domain: "Arca", code: 3, userInfo: [NSLocalizedDescriptionKey: message])
  }
}
