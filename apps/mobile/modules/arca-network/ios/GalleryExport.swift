import Foundation
import Photos

private struct GalleryExportError: LocalizedError {
  let message: String
  var errorDescription: String? { message }
}

// Export current full-size resources, including rendered edits and Live Photo video.
// Never request PhotoKit mutations or render/recompress the image.
enum GalleryExport {
  static func export(id: String, destination: String) async throws -> [[String: String]] {
    let manager = FileManager.default
    guard let root = URL(string: destination), root.isFileURL,
      let documents = manager.urls(for: .documentDirectory, in: .userDomainMask).first,
      root.resolvingSymlinksInPath().path.hasPrefix(documents.resolvingSymlinksInPath().appendingPathComponent("arca").path + "/"),
      root.deletingLastPathComponent().lastPathComponent == "gallery-stage" else {
      throw GalleryExportError(message: "Invalid gallery staging path")
    }
    guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject else {
      throw GalleryExportError(message: "Photo is no longer accessible. Check photo permissions.")
    }
    let all = PHAssetResource.assetResources(for: asset)
    // PhotoKit exposes rendered edits as full-size resources; keep stable role keys.
    func role(_ type: PHAssetResourceType) -> PHAssetResourceType {
      switch type {
      case .fullSizePhoto: return .photo
      case .fullSizeVideo: return .video
      case .fullSizePairedVideo: return .pairedVideo
      default: return type
      }
    }
    let resources = all.filter { resource in
      if [.fullSizePhoto, .fullSizeVideo, .fullSizePairedVideo].contains(resource.type) { return true }
      guard [.photo, .video, .pairedVideo, .alternatePhoto].contains(resource.type) else { return false }
      return !all.contains { $0.type != resource.type && role($0.type) == resource.type }
    }
    guard !resources.isEmpty else { throw GalleryExportError(message: "Original resources are unavailable") }
    try manager.createDirectory(at: root, withIntermediateDirectories: true)
    var result = [[String: String]]()
    var counts = [Int: Int]()
    for resource in resources {
      let index = counts[role(resource.type).rawValue, default: 0]
      counts[role(resource.type).rawValue] = index + 1
      let key = "\(role(resource.type).rawValue)-\(index)"
      let target = root.appendingPathComponent(key)
      do { try await write(resource: resource, to: target) }
      catch { try? manager.removeItem(at: root); throw error }
      result.append(["key": key, "name": resource.originalFilename, "uri": target.absoluteString])
    }
    return result
  }

  private static func write(resource: PHAssetResource, to target: URL) async throws {
    guard FileManager.default.createFile(atPath: target.path, contents: nil) else {
      throw GalleryExportError(message: "Could not create temporary photo file")
    }
    let handle = try FileHandle(forWritingTo: target)
    defer { try? handle.close() }
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      let state = ResourceWrite(handle: handle, target: target, continuation: continuation)
      let options = PHAssetResourceRequestOptions()
      options.isNetworkAccessAllowed = true
      let manager = PHAssetResourceManager.default()
      let request = manager.requestData(for: resource, options: options, dataReceivedHandler: { data in
        state.append(data)
      }, completionHandler: { error in state.finish(error) })
      DispatchQueue.global().asyncAfter(deadline: .now() + 90) {
        if state.finish(GalleryExportError(message: "Original download timed out. Keep Arca open and retry.")) {
          manager.cancelDataRequest(request)
        }
      }
    }
  }
}

private final class ResourceWrite: @unchecked Sendable {
  let lock = NSLock()
  let handle: FileHandle
  let target: URL
  var continuation: CheckedContinuation<Void, Error>?
  var failure: Error?
  var size: UInt64 = 0
  init(handle: FileHandle, target: URL, continuation: CheckedContinuation<Void, Error>) {
    self.handle = handle; self.target = target; self.continuation = continuation
  }
  func append(_ data: Data) {
    lock.lock(); defer { lock.unlock() }
    guard continuation != nil, failure == nil else { return }
    do {
      let attributes = try FileManager.default.attributesOfFileSystem(forPath: target.deletingLastPathComponent().path)
      let free = (attributes[.systemFreeSize] as? NSNumber)?.uint64Value ?? 0
      guard free > UInt64(data.count) + 256 * 1024 * 1024 else {
        throw GalleryExportError(message: "Not enough storage for temporary photo transfer")
      }
      size += UInt64(data.count)
      guard size <= 100 * 1024 * 1024 * 1024 else { throw GalleryExportError(message: "Photo or video exceeds 100 GiB") }
      try handle.write(contentsOf: data)
    } catch { failure = error }
  }
  @discardableResult func finish(_ error: Error?) -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard let pending = continuation else { return false }
    continuation = nil
    if let error = failure ?? error { pending.resume(throwing: error) }
    else {
      do { try handle.synchronize(); pending.resume() }
      catch { pending.resume(throwing: error) }
    }
    return true
  }
}
