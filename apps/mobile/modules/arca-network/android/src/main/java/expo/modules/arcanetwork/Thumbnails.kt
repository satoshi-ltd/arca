package expo.modules.arcanetwork

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.media.ExifInterface
import android.media.MediaMetadataRetriever
import android.os.Build
import java.io.File
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

// cover: the short edge reaches size (grid tiles); otherwise the long edge fits within size (viewer).
internal fun writeThumbnail(context: Context, source: String, destination: String, size: Int, cover: Boolean, video: Boolean) {
  val input = File(java.net.URI(source)).canonicalFile
  val output = File(java.net.URI(destination)).canonicalFile
  check(input.path.startsWith(context.filesDir.canonicalPath + "/")) { "File is outside Arca storage" }
  check(output.path.startsWith(context.cacheDir.canonicalPath + "/")) { "Thumbnail is outside Arca cache" }
  check(size in 32..4096) { "Invalid thumbnail size" }
  val bitmap = if (video) videoFrame(input, size, cover) else imageThumbnail(input, size, cover)
  try {
    val directory = output.parentFile ?: error("Invalid thumbnail path")
    check(directory.mkdirs() || directory.isDirectory) { "Could not create the thumbnail cache" }
    val partial = File(directory, output.name + ".part")
    try {
      partial.outputStream().use { stream ->
        check(bitmap.compress(Bitmap.CompressFormat.JPEG, if (size > 1024) 85 else 75, stream)) { "Could not encode the thumbnail" }
      }
      check(partial.renameTo(output)) { "Could not save the thumbnail" }
    } catch (error: Throwable) {
      partial.delete()
      throw error
    }
  } finally {
    bitmap.recycle()
  }
}

private fun factor(width: Int, height: Int, size: Int, cover: Boolean): Float {
  val edge = if (cover) min(width, height) else max(width, height)
  return if (edge <= 0) 1f else min(1f, size.toFloat() / edge)
}

private fun scaled(bitmap: Bitmap, size: Int, cover: Boolean, rotation: Float = 0f): Bitmap {
  val scale = factor(bitmap.width, bitmap.height, size, cover)
  if (scale >= 1f && rotation == 0f) return bitmap
  val matrix = Matrix().apply {
    postScale(scale, scale)
    postRotate(rotation)
  }
  val result = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
  if (result !== bitmap) bitmap.recycle()
  return result
}

private fun imageThumbnail(file: File, size: Int, cover: Boolean): Bitmap {
  if (Build.VERSION.SDK_INT >= 28)
    return ImageDecoder.decodeBitmap(ImageDecoder.createSource(file)) { decoder, info, _ ->
      val scale = factor(info.size.width, info.size.height, size, cover)
      decoder.setTargetSize(
        max(1, (info.size.width * scale).roundToInt()),
        max(1, (info.size.height * scale).roundToInt()),
      )
      decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
    }
  val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
  BitmapFactory.decodeFile(file.path, bounds)
  check(bounds.outWidth > 0 && bounds.outHeight > 0) { "Unsupported image" }
  val edge = if (cover) min(bounds.outWidth, bounds.outHeight) else max(bounds.outWidth, bounds.outHeight)
  var sample = 1
  while (edge / (sample * 2) >= size) sample *= 2
  val decoded = BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample })
    ?: error("Unsupported image")
  val rotation = runCatching {
    when (ExifInterface(file.path).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
      ExifInterface.ORIENTATION_ROTATE_90 -> 90f
      ExifInterface.ORIENTATION_ROTATE_180 -> 180f
      ExifInterface.ORIENTATION_ROTATE_270 -> 270f
      else -> 0f
    }
  }.getOrDefault(0f)
  return scaled(decoded, size, cover, rotation)
}

private fun videoFrame(file: File, size: Int, cover: Boolean): Bitmap {
  val retriever = MediaMetadataRetriever()
  try {
    retriever.setDataSource(file.path)
    val width = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
    val height = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
    val rotation = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
    val (shownWidth, shownHeight) = if (rotation % 180 == 0) width to height else height to width
    val scale = factor(shownWidth, shownHeight, size, cover)
    val frame = if (Build.VERSION.SDK_INT >= 27 && shownWidth > 0 && shownHeight > 0 && scale < 1f)
      retriever.getScaledFrameAtTime(
        0,
        MediaMetadataRetriever.OPTION_CLOSEST_SYNC,
        max(1, (shownWidth * scale).roundToInt()),
        max(1, (shownHeight * scale).roundToInt()),
      )
    else retriever.getFrameAtTime(0, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
    return scaled(frame ?: error("Video frame unavailable"), size, cover)
  } finally {
    retriever.release()
  }
}
