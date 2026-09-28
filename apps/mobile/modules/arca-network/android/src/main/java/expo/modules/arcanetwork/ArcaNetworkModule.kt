package expo.modules.arcanetwork

import android.net.Uri
import android.provider.DocumentsContract
import java.net.URL
import java.net.HttpURLConnection
import android.util.Base64
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.functions.Coroutine
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class ArcaNetworkModule : Module() {
  private class RequestState {
    @Volatile var cancelled = false
    @Volatile var connection: HttpURLConnection? = null
  }
  private val requests = java.util.concurrent.ConcurrentHashMap<String, RequestState>()
  override fun definition() = ModuleDefinition {
    Name("ArcaNetwork")
    AsyncFunction("openFile") Coroutine { uri: String ->
      withContext(Dispatchers.Main) {
        val context = appContext.reactContext ?: error("App is unavailable")
        val activity = appContext.currentActivity ?: error("Open Arca to open this file.")
        val file = File(java.net.URI(uri)).canonicalFile
        check(file.path.startsWith(context.filesDir.canonicalPath + "/") && file.isFile) { "This file is not available locally yet." }
        val content = androidx.core.content.FileProvider.getUriForFile(context, context.packageName + ".SharingFileProvider", file)
        val extension = file.extension.lowercase(java.util.Locale.ROOT)
        val apk = extension == "apk"
        if (apk && android.os.Build.VERSION.SDK_INT >= 26 && !context.packageManager.canRequestPackageInstalls())
          return@withContext "install-permission"
        val mime = if (apk) "application/vnd.android.package-archive" else android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension) ?: "application/octet-stream"
        val intent = android.content.Intent(android.content.Intent.ACTION_VIEW).apply {
          setDataAndType(content, mime)
          addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
          clipData = android.content.ClipData.newRawUri(file.name, content)
        }
        try { activity.startActivity(intent) }
        catch (_: android.content.ActivityNotFoundException) { error("No installed app can open this file. Try Share from the file menu.") }
        catch (_: SecurityException) { error("Android blocked opening this file. Check the app permissions and try again.") }
        "opened"
      }
    }
    AsyncFunction("openInstallSettings") Coroutine { ->
      withContext(Dispatchers.Main) {
        val activity = appContext.currentActivity ?: error("Open Arca to change this setting.")
        try {
          activity.startActivity(android.content.Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.packageName)))
        } catch (_: android.content.ActivityNotFoundException) {
          error("Open Android Settings, then Apps, Special app access, Install unknown apps, and select Arca.")
        } catch (_: SecurityException) {
          error("Android does not allow changing this setting on this device.")
        }
      }
    }
    Events("transferStopped")
    OnCreate { TransferService.onStopped = { reason -> sendEvent("transferStopped", mapOf("reason" to reason)) } }
    OnDestroy { TransferService.onStopped = null }
    AsyncFunction("startTransfer") {
      val context = appContext.reactContext ?: error("App is unavailable")
      check(appContext.currentActivity != null && appContext.currentActivity?.isFinishing == false) { "Open Arca to start photo uploads" }
      val intent = android.content.Intent(context, TransferService::class.java)
      if (android.os.Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
      true
    }
    AsyncFunction("stopTransfer") {
      appContext.reactContext?.let { it.stopService(android.content.Intent(it, TransferService::class.java)) }
    }
    AsyncFunction("transferProgress") { text: String, done: Double, total: Double ->
      TransferService.instance?.progress(text, done.toLong(), total.toLong())
    }
    AsyncFunction("hashFile") Coroutine { uri: String ->
      withContext(Dispatchers.IO) {
      val context = appContext.reactContext ?: error("App is unavailable")
      val file = File(java.net.URI(uri))
      check(file.canonicalPath.startsWith(context.filesDir.canonicalPath + "/") || file.canonicalPath.startsWith(context.cacheDir.canonicalPath + "/")) { "File is outside Arca storage" }
      val digest = java.security.MessageDigest.getInstance("SHA-256")
      file.inputStream().buffered().use { input ->
        val buffer = ByteArray(1024 * 1024)
        while (true) { val count = input.read(buffer); if (count < 0) break; digest.update(buffer, 0, count) }
      }
      digest.digest().joinToString("") { "%02x".format(it) }
      }
    }
    AsyncFunction("exportGalleryAsset") Coroutine { id: String, destination: String ->
      withContext(Dispatchers.IO) {
      exportGalleryAsset(appContext.reactContext ?: error("App is unavailable"), id, destination)
      }
    }
    AsyncFunction("copyText") { text: String ->
      val context = appContext.reactContext ?: error("App is unavailable")
      val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
      clipboard.setPrimaryClip(android.content.ClipData.newPlainText("Arca details", text))
    }
    Function("beginRequest") { id: String, privateNetwork: Boolean -> requests[id] = RequestState() }
    Function("cancelRequest") { id: String ->
      requests[id]?.let { it.cancelled = true; it.connection?.disconnect() }
    }
    AsyncFunction("request") Coroutine { address: String, method: String, headers: Map<String, String>, body: String?, id: String, transfer: Map<String, String> ->
      withContext(Dispatchers.IO) {
        val url = URL(address)
        check(url.protocol == "https" || url.protocol == "http")
        check(url.userInfo == null)
        val state = requests[id] ?: error("Request cancelled")
        try {
          try { perform(url, method, headers, body, emptySet(), state, transfer) }
          catch (stale: StaleNetwork) { perform(url, method, headers, body, setOf(stale.network), state, transfer) }
        } finally { requests.remove(id) }
      }
    }
    AsyncFunction("exportDirectory") { source: String, destination: String, name: String ->
      val context = appContext.reactContext!!
      val sourceFile = File(java.net.URI(source))
      check(sourceFile.canonicalPath.startsWith(context.filesDir.canonicalPath + "/"))
      check(!name.contains("/") && !name.contains(".."))
      val tree = Uri.parse(destination)
      val parent = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
      val target = DocumentsContract.createDocument(context.contentResolver, parent, DocumentsContract.Document.MIME_TYPE_DIR, name) ?: error("Could not create export folder")
      fun copyDirectory(directory: File, destinationUri: Uri) {
        for (file in directory.listFiles() ?: emptyArray()) {
          check(!Files.isSymbolicLink(file.toPath()))
          val mime = if (file.isDirectory) DocumentsContract.Document.MIME_TYPE_DIR else "application/octet-stream"
          val next = DocumentsContract.createDocument(context.contentResolver, destinationUri, mime, file.name) ?: error("Could not export file")
          if (file.isDirectory) copyDirectory(file, next)
          else context.contentResolver.openOutputStream(next, "w")!!.use { out -> file.inputStream().use { it.copyTo(out, 1048576) } }
        }
      }
      copyDirectory(sourceFile,target)
      target.toString()
    }
    Function("removeEmptyDirectory") { source: String ->
      val target = File(java.net.URI(source))
      val root = appContext.reactContext!!.filesDir.canonicalPath + "/"
      check(target.canonicalPath.startsWith(root))
      check(!Files.isSymbolicLink(target.toPath()))
      if (target.exists()) {
        check(target.isDirectory)
        // Files.delete never descends into children, unlike Expo Directory.delete.
        Files.delete(target.toPath())
      }
    }
    Function("replaceFile") { source: String, destination: String ->
      val from = File(java.net.URI(source)); val to = File(java.net.URI(destination))
      val root = appContext.reactContext!!.filesDir.canonicalPath + "/"
      check(from.canonicalPath.startsWith(root) && to.canonicalPath.startsWith(root))
      java.io.RandomAccessFile(from, "rw").use { it.fd.sync() }
      Files.move(from.toPath(), to.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
    }
    AsyncFunction("resolveLanHost") { host: String -> lanNetwork(host); host }
    AsyncFunction("resolvePrivateHost") { host: String -> privateNetwork(host).getAllByName(host).first().hostAddress!! }
  }
  // A network handle that is being torn down rejects bind with EPERM before any byte is sent.
  private class StaleNetwork(val network: android.net.Network, cause: java.net.SocketException) : java.net.SocketException(cause.message) {
    init { initCause(cause) }
  }
  private fun perform(url: URL, method: String, headers: Map<String, String>, body: String?, excluded: Set<android.net.Network>, state: RequestState, transfer: Map<String, String>): Map<String, Any> {
    val network = if (url.protocol == "http") (if (isLanAddress(url.host)) lanNetwork(url.host, excluded) else privateNetwork(url.host)) else null
    val connection = (network?.openConnection(url) ?: url.openConnection()) as HttpURLConnection
    state.connection = connection
    try {
      check(!state.cancelled) { "Request cancelled" }
      connection.instanceFollowRedirects = false
      connection.connectTimeout = 20000
      connection.readTimeout = 20000
      connection.requestMethod = method
      headers.forEach { (key, value) -> connection.setRequestProperty(key, value) }
      val offset = transfer["offset"]?.toLong() ?: 0L
      val length = transfer["length"]?.toInt() ?: 0
      check(offset >= 0 && length in 0..1048576)
      val source = transfer["source"]?.let { privateFile(it) }
      connection.doOutput = body != null || source != null
      // Retry only before sending a body; later socket failures may follow an accepted write.
      try { connection.connect() }
      catch (error: java.net.SocketException) {
        if (network != null && excluded.isEmpty() && error.message?.contains("Binding socket to network") == true) throw StaleNetwork(network, error)
        throw error
      }
      if (source != null) {
        val bytes = ByteArray(length)
        java.io.RandomAccessFile(source, "r").use { it.seek(offset); it.readFully(bytes) }
        connection.outputStream.use { it.write(bytes) }
      }
      if (body != null) connection.outputStream.use { it.write(Base64.decode(body, Base64.NO_WRAP)) }
      val status = connection.responseCode
      val input = if (status >= 400) connection.errorStream else connection.inputStream
      val data = input?.use { stream ->
        val out = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(65536)
        while (true) { val count = stream.read(buffer); if (count < 0) break; check(out.size() + count <= 8 * 1024 * 1024); out.write(buffer, 0, count) }
        out.toByteArray()
      } ?: ByteArray(0)
      var written = 0
      if (transfer["destination"] != null && status == 206) {
        check(connection.getHeaderField("Content-Range") == transfer["range"] && data.size == length) { "Invalid download range" }
        check(!state.cancelled) { "Request cancelled" }
        java.io.RandomAccessFile(privateFile(transfer.getValue("destination")), "rw").use {
          check(it.length() == offset) { "Partial download changed" }
          it.seek(offset); it.write(data); it.fd.sync()
        }
        written = data.size
      }
      return mapOf("bytesWritten" to written, "status" to status, "headers" to connection.headerFields.filterKeys { it != null }.mapValues { it.value.joinToString(", ") }, "body" to Base64.encodeToString(if (written > 0) ByteArray(0) else data, Base64.NO_WRAP))
    } finally { connection.disconnect() }
  }
  private fun privateFile(uri: String): File {
    val parsed = java.net.URI(uri)
    check(parsed.scheme == "file")
    val file = File(parsed).canonicalFile
    val context = appContext.reactContext ?: error("App unavailable")
    check(listOf(context.filesDir, context.cacheDir).any { file.path.startsWith(it.canonicalPath + "/") }) { "File is outside Arca storage" }
    return file
  }
  private fun isLanAddress(address: String): Boolean {
    val parts = address.split('.').mapNotNull { it.toIntOrNull() }
    return parts.size == 4 && parts.all { it in 0..255 } &&
      (parts[0] == 10 || (parts[0] == 172 && parts[1] in 16..31) || (parts[0] == 192 && parts[1] == 168))
  }
  private fun lanNetwork(host: String, excluded: Set<android.net.Network> = emptySet()): android.net.Network {
    check(isLanAddress(host)) { "Use the hub's private IPv4 address" }
    val context = appContext.reactContext ?: error("App is unavailable")
    val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    val target = java.net.InetAddress.getByName(host)
    // Bind the request to Wi-Fi/Ethernet, never a cellular or VPN fallback; prefer the active network over possibly stale handles.
    val usable = { network: android.net.Network ->
      val caps = manager.getNetworkCapabilities(network)
      network !in excluded && caps != null && !caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) &&
        caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_RESTRICTED) &&
        (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) &&
        manager.getLinkProperties(network)?.routes?.any { it.matches(target) } == true
    }
    return manager.activeNetwork?.takeIf(usable) ?: manager.allNetworks.firstOrNull(usable)
      ?: error("Connect this device to the hub's local Wi-Fi network")
  }
  private fun privateNetwork(host: String): android.net.Network {
      val context = appContext.reactContext ?: throw IllegalStateException("App is unavailable")
      val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
      val network = manager.activeNetwork ?: throw IllegalStateException("Connect Tailscale first")
      val capabilities = manager.getNetworkCapabilities(network)
      val properties = manager.getLinkProperties(network)
      check(capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true && properties != null) { "Connect Tailscale on this device and the hub" }
      check(properties!!.linkAddresses.any { isTailAddress(it.address.hostAddress ?: "") }) { "Use your Tailscale network" }
      val addresses = network.getAllByName(host)
      check(addresses.isNotEmpty() && addresses.all { isTailAddress(it.hostAddress ?: "") && properties.routes.any { route -> route.matches(it) } }) { "Use the hub's Tailscale address" }
      return network
  }
  private fun isTailAddress(address: String): Boolean {
    val parts = address.split('.').mapNotNull { it.toIntOrNull() }
    return parts.size == 4 && parts[0] == 100 && parts[1] in 64..127 && parts.all { it in 0..255 }
  }
}
