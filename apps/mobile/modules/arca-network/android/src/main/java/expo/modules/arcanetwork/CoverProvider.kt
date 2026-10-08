package expo.modules.arcanetwork

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import java.io.File
import java.io.FileNotFoundException

class CoverProvider : ContentProvider() {
  companion object {
    private val SCOPE = Regex("^[a-zA-Z0-9-]+$")
    private val NAME = Regex("^[a-f0-9]{64}-(small|large)\\.jpg$")
    fun authority(packageName: String) = "$packageName.arcamusic"
    fun uri(packageName: String, scope: String?, key: String?, size: String): Uri? {
      if (scope == null || key == null || !SCOPE.matches(scope)) return null
      val name = "$key-$size.jpg"
      if (!NAME.matches(name)) return null
      return Uri.Builder().scheme("content").authority(authority(packageName)).appendPath(scope).appendPath(name).build()
    }
    fun file(root: File, scope: String, name: String): File? {
      if (!SCOPE.matches(scope) || !NAME.matches(name)) return null
      return File(root, "arca/$scope/music-covers/$name")
    }
  }

  override fun onCreate() = true

  override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
    if (mode != "r") throw SecurityException("Covers are read-only")
    val segments = uri.pathSegments
    val context = context ?: throw FileNotFoundException()
    val target = if (segments.size == 2) file(context.filesDir, segments[0], segments[1]) else null
    if (target == null || !target.isFile) throw FileNotFoundException()
    return ParcelFileDescriptor.open(target, ParcelFileDescriptor.MODE_READ_ONLY)
  }

  override fun getType(uri: Uri) = "image/jpeg"
  override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? = null
  override fun insert(uri: Uri, values: ContentValues?): Uri? = null
  override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0
  override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = 0
}
