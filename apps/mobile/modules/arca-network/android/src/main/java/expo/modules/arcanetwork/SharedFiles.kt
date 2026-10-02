package expo.modules.arcanetwork

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import java.io.File

internal fun receiveShared(context: Context, source: String, destination: String): Map<String, Any?> {
  val uri = Uri.parse(source)
  check(uri.scheme != "file") { "Arca cannot read a file shared by path. Share it again from the app that holds it." }
  check(uri.scheme == "content") { "Share the exported file, rather than a link or text." }
  val authority = uri.host?.lowercase() ?: error("Share the exported file, rather than a link or text.")
  check(!authority.startsWith(context.packageName.lowercase()) && context.packageManager.resolveContentProvider(authority, 0)?.packageName != context.packageName) { "Arca cannot receive its own files." }
  val inbox = File(context.cacheDir, "arca-incoming").canonicalFile
  val target = File(java.net.URI(destination)).canonicalFile
  check(target.path.startsWith(inbox.path + "/")) { "The shared file destination is outside Arca's inbox." }
  var name: String? = null
  var size = -1L
  context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
    if (cursor.moveToFirst()) {
      val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
      val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
      if (nameIndex >= 0 && !cursor.isNull(nameIndex)) name = cursor.getString(nameIndex)
      if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) size = cursor.getLong(sizeIndex)
    }
  }
  val directory = target.parentFile ?: error("Invalid shared file destination")
  check(directory.mkdirs() || directory.isDirectory) { "Could not create the shared file inbox." }
  check(size < 0 || size <= directory.usableSpace) { "There is not enough free space for the shared file." }
  try {
    val input = context.contentResolver.openInputStream(uri) ?: error("The shared file is no longer available.")
    input.use { stream -> target.outputStream().use { output -> stream.copyTo(output) } }
    check(size <= 0 || target.length() == size) { "The shared file is incomplete. Export and share it again." }
  } catch (error: Throwable) {
    target.delete()
    throw error
  }
  return mapOf("name" to (name ?: uri.lastPathSegment ?: "shared-file"), "size" to target.length())
}
