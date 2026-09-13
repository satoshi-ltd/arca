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
  override fun definition() = ModuleDefinition {
    Name("ArcaNetwork")
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
    AsyncFunction("request") Coroutine { address: String, method: String, headers: Map<String, String>, body: String? ->
      withContext(Dispatchers.IO) {
      val url = URL(address)
      check(url.protocol == "https" || url.protocol == "http")
      check(url.userInfo == null)
      val connection = (if(url.protocol=="http") { (if (isLanAddress(url.host)) lanNetwork(url.host) else privateNetwork(url.host)).openConnection(url) } else url.openConnection()) as HttpURLConnection
      try {
        connection.instanceFollowRedirects = false
        connection.connectTimeout = 20000
        connection.readTimeout = 20000
        connection.requestMethod = method
        headers.forEach { (key, value) -> connection.setRequestProperty(key, value) }
        if (body != null) { connection.doOutput = true; connection.outputStream.use { it.write(Base64.decode(body, Base64.NO_WRAP)) } }
        val status = connection.responseCode
        val input = if (status >= 400) connection.errorStream else connection.inputStream
        val data = input?.use { stream ->
          val out = java.io.ByteArrayOutputStream()
          val buffer = ByteArray(65536)
          while (true) { val count = stream.read(buffer); if (count < 0) break; check(out.size() + count <= 8 * 1024 * 1024); out.write(buffer, 0, count) }
          out.toByteArray()
        } ?: ByteArray(0)
        mapOf("status" to status, "headers" to connection.headerFields.filterKeys { it != null }.mapValues { it.value.joinToString(", ") }, "body" to Base64.encodeToString(data, Base64.NO_WRAP))
      } finally { connection.disconnect() }
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
  private fun isLanAddress(address: String): Boolean {
    val parts = address.split('.').mapNotNull { it.toIntOrNull() }
    return parts.size == 4 && parts.all { it in 0..255 } &&
      (parts[0] == 10 || (parts[0] == 172 && parts[1] in 16..31) || (parts[0] == 192 && parts[1] == 168))
  }
  private fun lanNetwork(host: String): android.net.Network {
    check(isLanAddress(host)) { "Use the hub's private IPv4 address" }
    val context = appContext.reactContext ?: error("App is unavailable")
    val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    // Bind the request to Wi-Fi/Ethernet, never a cellular or VPN fallback.
    return manager.allNetworks.firstOrNull { network ->
      val caps = manager.getNetworkCapabilities(network)
      caps != null && !caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) &&
        (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) &&
        manager.getLinkProperties(network)?.routes?.any { it.matches(java.net.InetAddress.getByName(host)) } == true
    } ?: error("Connect this device to the hub's local Wi-Fi network")
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
