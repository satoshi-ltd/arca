package expo.modules.arcanetwork

import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.provider.MediaStore
import java.io.File

// Read MediaStore only. Output is restricted to Arca's private temporary area.
internal fun exportGalleryAsset(context: Context, id: String, destination: String): List<Map<String, String>> {
  val root = File(java.net.URI(destination)).canonicalFile
  check(root.path.startsWith(context.filesDir.canonicalPath + "/arca/") && root.parentFile?.name == "gallery-stage") { "Invalid gallery staging path" }
  check(id.toLongOrNull() != null) { "Invalid photo identity" }
  check(root.mkdirs() || root.isDirectory) { "Could not create gallery staging area" }
  val resolver = context.contentResolver
  var uri = ContentUris.withAppendedId(MediaStore.Files.getContentUri("external"), id.toLong())
  var modified = 0L
  var expectedSize = 0L
  val projection = arrayOf(MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.Files.FileColumns.MEDIA_TYPE, MediaStore.MediaColumns.DATE_MODIFIED, MediaStore.MediaColumns.SIZE)
  val name = resolver.query(uri, projection, null, null, null)?.use { cursor ->
    check(cursor.moveToFirst()) { "Photo is no longer accessible. Check photo permissions." }
    val type = cursor.getInt(1)
    check(type == MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE || type == MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO) { "Only photos and videos can be uploaded" }
    modified = cursor.getLong(2)
    expectedSize = cursor.getLong(3)
    cursor.getString(0)
  } ?: error("Photo is no longer accessible")
  if (Build.VERSION.SDK_INT >= 29 && context.checkSelfPermission(android.Manifest.permission.ACCESS_MEDIA_LOCATION) == PackageManager.PERMISSION_GRANTED)
    uri = MediaStore.setRequireOriginal(uri)
  val target = File(root, "original")
  try {
    resolver.openInputStream(uri)?.use { input ->
      target.outputStream().use { output ->
        val buffer = ByteArray(1024 * 1024)
        var total = 0L
        val deadline = System.nanoTime() + 90_000_000_000L
        while (true) {
          check(System.nanoTime() < deadline) { "Photo export timed out. Keep Arca open and retry." }
          val count = input.read(buffer)
          if (count < 0) break
          check(root.usableSpace > 256L * 1024 * 1024 + count) { "Not enough storage for temporary photo transfer" }
          total += count
          check(total <= 100L * 1024 * 1024 * 1024) { "Photo or video exceeds 100 GiB" }
          output.write(buffer, 0, count)
        }
        output.fd.sync()
      }
    } ?: error("Original photo is unavailable")
    resolver.query(uri, projection, null, null, null)?.use { cursor ->
      check(cursor.moveToFirst() && cursor.getLong(2) == modified && cursor.getLong(3) == expectedSize) { "Original changed while reading. Retry the photo upload." }
    } ?: error("Photo became unavailable during export")
    return listOf(mapOf("key" to "original", "name" to name, "uri" to target.toURI().toString()))
  } catch (error: Throwable) { target.delete(); throw error }
}
