import ExpoModulesCore
import Foundation
import UIKit
import Darwin

public class ArcaNetworkModule: Module {
  private var documentController: UIDocumentInteractionController?

  public func definition() -> ModuleDefinition {
    Name("ArcaNetwork")
    AsyncFunction("openFile") { (uri: String) async throws in
      try await MainActor.run {
        guard let url = URL(string: uri), url.isFileURL,
          let root = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first,
          url.resolvingSymlinksInPath().path.hasPrefix(root.path + "/"),
          FileManager.default.fileExists(atPath: url.path),
          let view = self.appContext?.utilities?.currentViewController()?.view else {
          throw NSError(domain: "Arca", code: 1, userInfo: [NSLocalizedDescriptionKey: "This file is not available locally yet."])
        }
        self.documentController?.dismissMenu(animated: false)
        let controller = UIDocumentInteractionController(url: url)
        self.documentController = controller
        guard controller.presentOpenInMenu(from: CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1), in: view, animated: true) else {
          self.documentController = nil
          throw NSError(domain: "Arca", code: 2, userInfo: [NSLocalizedDescriptionKey: "No installed app can open this file. Try Share from the file menu."])
        }
      }
    }
    AsyncFunction("exportGalleryAsset") { (id: String, destination: String) async throws -> [[String: String]] in
      return try await GalleryExport.export(id: id, destination: destination)
    }
    AsyncFunction("copyText") { (text: String) async in
      await MainActor.run { UIPasteboard.general.string = text }
    }
    AsyncFunction("request") { (address: String, method: String, headers: [String: String], body: String?) async throws -> [String: Any] in
      guard let url = URL(string: address), ["http", "https"].contains(url.scheme ?? ""), url.user == nil, url.password == nil else { throw NetworkUnavailable() }
      if url.scheme == "http" {
        guard let host = url.host, try self.verifiedAddress(host, lan: self.isLanAddress(host)) == host else { throw NetworkUnavailable() }
      }
      var request = URLRequest(url: url, timeoutInterval: 20)
      request.httpMethod = method
      for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }
      if let body { request.httpBody = Data(base64Encoded: body) }
      let configuration = URLSessionConfiguration.ephemeral
      if url.scheme == "http" { configuration.allowsCellularAccess = false }
      configuration.httpCookieStorage = nil
      configuration.urlCache = nil
      let session = URLSession(configuration: configuration)
      defer { session.invalidateAndCancel() }
      let (data, response) = try await session.data(for: request, delegate: NoRedirect())
      guard let http = response as? HTTPURLResponse, data.count <= 8 * 1024 * 1024 else { throw NetworkUnavailable() }
      var fields = [String: String]()
      for (key, value) in http.allHeaderFields { fields[String(describing: key)] = String(describing: value) }
      return ["status": http.statusCode, "headers": fields, "body": data.base64EncodedString()]
    }
    AsyncFunction("exportDirectory") { (source: String, destination: String, name: String) -> String in
      guard let from = URL(string: source), let to = URL(string: destination), from.isFileURL, to.isFileURL,
        let root = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first,
        from.resolvingSymlinksInPath().path.hasPrefix(root.path + "/"), !name.contains("/"), !name.contains("..") else { throw NetworkUnavailable() }
      let access = to.startAccessingSecurityScopedResource()
      defer { if access { to.stopAccessingSecurityScopedResource() } }
      let target = to.appendingPathComponent(name, isDirectory: true)
      try FileManager.default.copyItem(at: from, to: target)
      return target.absoluteString
    }
    Function("removeEmptyDirectory") { (source: String) in
      guard let target = URL(string: source), target.isFileURL,
        let root = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first,
        target.resolvingSymlinksInPath().path.hasPrefix(root.path + "/") else { throw NetworkUnavailable() }
      if rmdir(target.path) != 0 && errno != ENOENT {
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
      }
    }
    Function("replaceFile") { (source: String, destination: String) in
      guard let from = URL(string: source), let to = URL(string: destination), from.isFileURL, to.isFileURL,
        let root = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first,
        from.resolvingSymlinksInPath().path.hasPrefix(root.path + "/"), to.resolvingSymlinksInPath().path.hasPrefix(root.path + "/") else { throw NetworkUnavailable() }
      let fd = open(from.path, O_RDONLY)
      if fd >= 0 { fsync(fd); close(fd) }
      guard rename(from.path, to.path) == 0 else { throw NetworkUnavailable() }
      let directory = open(to.deletingLastPathComponent().path, O_RDONLY)
      if directory >= 0 { fsync(directory); close(directory) }
    }
    AsyncFunction("resolveLanHost") { (host: String) -> String in
      guard self.isLanAddress(host) else { throw NetworkUnavailable() }
      return try self.verifiedAddress(host, lan: true)
    }
    AsyncFunction("resolvePrivateHost") { (host: String) -> String in try self.verifiedAddress(host) }
  }
  private func verifiedAddress(_ host: String, lan: Bool = false) throws -> String {
      var interfaces: UnsafeMutablePointer<ifaddrs>?
      guard getifaddrs(&interfaces) == 0 else { throw NetworkUnavailable() }
      defer { freeifaddrs(interfaces) }
      var current = interfaces
      var tunnels = Set<String>()
      while let pointer = current {
        let value = pointer.pointee
        if let address = value.ifa_addr, address.pointee.sa_family == UInt8(AF_INET),
           String(cString: value.ifa_name).hasPrefix(lan ? "en" : "utun"), (value.ifa_flags & UInt32(IFF_UP)) != 0 {
          var buffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
          if getnameinfo(address, socklen_t(address.pointee.sa_len), &buffer, socklen_t(buffer.count), nil, 0, NI_NUMERICHOST) == 0,
             (lan ? self.isLanAddress(String(cString: buffer)) : self.isTailAddress(String(cString: buffer))) { tunnels.insert(String(cString: buffer)) }
        }
        current = value.ifa_next
      }
      guard !tunnels.isEmpty else { throw NetworkUnavailable() }
      var hints = addrinfo()
      hints.ai_family = AF_INET
      hints.ai_socktype = SOCK_STREAM
      var results: UnsafeMutablePointer<addrinfo>?
      guard getaddrinfo(host, nil, &hints, &results) == 0 else { throw NetworkUnavailable() }
      defer { freeaddrinfo(results) }
      var node = results
      var addresses = [String]()
      while let result = node {
        var buffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
        if getnameinfo(result.pointee.ai_addr, result.pointee.ai_addrlen, &buffer, socklen_t(buffer.count), nil, 0, NI_NUMERICHOST) == 0 {
          addresses.append(String(cString: buffer))
        }
        node = result.pointee.ai_next
      }
      guard let first = addresses.first, addresses.allSatisfy({ lan ? self.isLanAddress($0) : self.isTailAddress($0) }) else { throw NetworkUnavailable() }
      // UDP connect selects a route without sending application traffic. The
      // selected source must be one of the active private tunnel addresses.
      let fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP)
      guard fd >= 0 else { throw NetworkUnavailable() }
      defer { close(fd) }
      var target = sockaddr_in()
      target.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
      target.sin_family = sa_family_t(AF_INET)
      target.sin_port = UInt16(9).bigEndian
      inet_pton(AF_INET, first, &target.sin_addr)
      let connected = withUnsafePointer(to: &target) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
      }
      guard connected == 0 else { throw NetworkUnavailable() }
      var local = sockaddr_in(), length = socklen_t(MemoryLayout<sockaddr_in>.size)
      let selected = withUnsafeMutablePointer(to: &local) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) }
      }
      var source = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
      inet_ntop(AF_INET, &local.sin_addr, &source, socklen_t(source.count))
      guard selected == 0, tunnels.contains(String(cString: source)) else { throw NetworkUnavailable() }
      return first
  }
  private func isLanAddress(_ address: String) -> Bool {
    let parts = address.split(separator: ".").compactMap { Int($0) }
    return parts.count == 4 && parts.allSatisfy { (0...255).contains($0) } &&
      (parts[0] == 10 || (parts[0] == 172 && (16...31).contains(parts[1])) || (parts[0] == 192 && parts[1] == 168))
  }
  private func isTailAddress(_ address: String) -> Bool {
    let parts = address.split(separator: ".").compactMap { Int($0) }
    return parts.count == 4 && parts[0] == 100 && (64...127).contains(parts[1]) && parts.allSatisfy { (0...255).contains($0) }
  }
}
class NetworkUnavailable: Exception {
  override var reason: String { "Connect to the hub’s local Wi-Fi and use its private IPv4 address, or connect Tailscale on both devices." }
}

private final class NoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(nil)
  }
}
