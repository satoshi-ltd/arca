package expo.modules.arcanetwork

import android.content.ComponentName
import android.content.Context
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.MoreExecutors
import java.util.concurrent.ExecutionException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext

private suspend fun <T> ListenableFuture<T>.await(): T = suspendCancellableCoroutine { continuation ->
  addListener({
    try {
      continuation.resume(get())
    } catch (error: ExecutionException) {
      continuation.resumeWithException(error.cause ?: error)
    } catch (error: Exception) {
      continuation.resumeWithException(error)
    }
  }, MoreExecutors.directExecutor())
}

class MusicRemote(private val context: Context, private val emit: (Map<String, Any?>) -> Unit) {
  private var pending: ListenableFuture<MediaController>? = null
  private val listener = object : Player.Listener {
    override fun onEvents(player: Player, events: Player.Events) = emit(state(player))
  }

  suspend fun controller(): MediaController = withContext(Dispatchers.Main) {
    val future = pending ?: MediaController.Builder(
      context,
      SessionToken(context, ComponentName(context, MusicService::class.java)),
    ).buildAsync().also { pending = it }
    val controller = try {
      future.await()
    } catch (error: Exception) {
      if (pending === future) pending = null
      throw IllegalStateException("Music playback is unavailable. Try again.", error)
    }
    if (!controller.isConnected) {
      if (pending === future) pending = null
      controller.release()
      error("Music playback is unavailable. Try again.")
    }
    controller.removeListener(listener)
    controller.addListener(listener)
    controller
  }

  suspend fun play(contextId: String, trackId: String, shuffle: Boolean, position: Int): Map<String, Any?> {
    val controller = controller()
    return withContext(Dispatchers.Main) {
      controller.shuffleModeEnabled = shuffle
      controller.setMediaItem(MediaItem.Builder().setMediaId(MusicTree.trackNodeId(contextId, trackId, position.takeIf { it >= 0 })).build())
      controller.prepare()
      controller.play()
      state(controller)
    }
  }

  suspend fun command(name: String, value: Double): Map<String, Any?> {
    val controller = controller()
    return withContext(Dispatchers.Main) {
      when (name) {
        "toggle" -> if (controller.isPlaying) controller.pause() else {
          if (controller.playbackState == Player.STATE_IDLE) controller.prepare()
          if (controller.playbackState == Player.STATE_ENDED) controller.seekToDefaultPosition(0)
          controller.play()
        }
        "next" -> controller.seekToNext()
        "previous" -> controller.seekToPrevious()
        "seek" -> controller.seekTo(value.toLong().coerceAtLeast(0))
        "shuffle" -> controller.shuffleModeEnabled = value > 0
        "repeat" -> controller.repeatMode = when (value.toInt()) {
          1 -> Player.REPEAT_MODE_ONE
          2 -> Player.REPEAT_MODE_ALL
          else -> Player.REPEAT_MODE_OFF
        }
        "stop" -> {
          controller.stop()
          controller.clearMediaItems()
        }
        "state" -> Unit
        else -> error("Unknown music command")
      }
      state(controller)
    }
  }

  fun release() {
    val future = pending ?: return
    pending = null
    android.os.Handler(android.os.Looper.getMainLooper()).post {
      if (future.isDone && !future.isCancelled) runCatching { future.get().removeListener(listener) }
      MediaController.releaseFuture(future)
    }
  }

  private fun state(player: Player): Map<String, Any?> {
    val metadata = player.mediaMetadata
    return mapOf(
      "id" to player.currentMediaItem?.mediaId,
      "title" to metadata.title?.toString(),
      "artist" to metadata.artist?.toString(),
      "album" to metadata.albumTitle?.toString(),
      "playing" to player.isPlaying,
      "playWhenReady" to player.playWhenReady,
      "buffering" to (player.playbackState == Player.STATE_BUFFERING),
      "ended" to (player.playbackState == Player.STATE_ENDED),
      "position" to player.currentPosition.coerceAtLeast(0).toDouble(),
      "duration" to player.duration.takeIf { it != C.TIME_UNSET && it > 0 }?.toDouble(),
      "index" to player.currentMediaItemIndex,
      "count" to player.mediaItemCount,
      "hasNext" to player.hasNextMediaItem(),
      "hasPrevious" to player.hasPreviousMediaItem(),
      "shuffle" to player.shuffleModeEnabled,
      "repeat" to when (player.repeatMode) {
        Player.REPEAT_MODE_ONE -> "one"
        Player.REPEAT_MODE_ALL -> "all"
        else -> "off"
      },
      "error" to player.playerError?.let { message(it) },
    )
  }

  private fun message(error: PlaybackException) = when (error.errorCode) {
    PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND -> "This track is no longer on this phone. Sync the folder and try again."
    PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED,
    PlaybackException.ERROR_CODE_DECODER_INIT_FAILED,
    PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED -> "This track's format can't play on this phone."
    else -> "This track couldn't be played."
  }
}
