package expo.modules.arcanetwork

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.ResolvingDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaConstants
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaSession
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionError
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.SettableFuture
import java.io.File
import java.io.FileOutputStream
import java.util.Random
import java.util.concurrent.Executor
import java.util.concurrent.Executors

class MusicService : MediaLibraryService() {
  companion object {
    @Volatile var instance: MusicService? = null
    private const val PREFERENCES = "arca-music"
    private val loader = Executors.newSingleThreadExecutor()
    private val outboxWriter = Executors.newSingleThreadExecutor()
    fun outbox(context: Context) = PositionOutbox(File(root(context), "music-positions.json"))
    fun root(context: Context) = File(context.filesDir, "arca")
    fun load(context: Context): MusicLibraryData = try {
      val file = File(root(context), "music-library.json")
      if (file.isFile) MusicLibraryData.parse(file.readText(), root(context).path) else MusicLibraryData.EMPTY
    } catch (_: Exception) {
      MusicLibraryData.EMPTY
    }
    fun tree(context: Context): MusicTree {
      val data = load(context)
      val file = File(root(context), "music-history.json")
      val text = try { if (file.isFile) file.readText() else null } catch (_: Exception) { null }
      return MusicTree(data, MusicHistory.parse(text, data.scope))
    }
    fun reloadRunning(context: Context, done: () -> Unit = {}) {
      instance?.let {
        it.reload(done)
        return
      }
      val app = context.applicationContext
      loader.execute {
        try {
          val prefs = app.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
          val item = prefs.getString("item", null) ?: return@execute
          if (tree(app).expand(item) == null) prefs.edit().clear().apply()
        } finally {
          done()
        }
      }
    }
    fun saveHistory(context: Context, scope: String, history: List<String>) {
      val directory = root(context)
      val staged = File(directory, "music-history.json.part")
      runCatching {
        FileOutputStream(staged).use { out ->
          out.write(MusicHistory.encode(scope, history).toByteArray())
          out.fd.sync()
        }
        if (!staged.renameTo(File(directory, "music-history.json"))) staged.delete()
      }
    }
    fun renameHistory(context: Context, from: String, to: String, done: () -> Unit) {
      val app = context.applicationContext
      loader.execute {
        runCatching {
          val current = tree(app)
          val scope = current.library.scope
          if (scope != null) current.renamed(from, to)?.let { saveHistory(app, scope, it.history) }
        }
        instance?.applyRename(from, to, done) ?: done()
      }
    }
  }

  private val main = Handler(Looper.getMainLooper())
  private val onMain = Executor { main.post(it) }
  private var session: MediaLibrarySession? = null
  private lateinit var player: ExoPlayer
  private lateinit var shuffle: StartFirstShuffleOrder
  private var tree = MusicTree(MusicLibraryData.EMPTY)
  private val loaded: SettableFuture<Unit> = SettableFuture.create()
  private val saved by lazy { getSharedPreferences(PREFERENCES, MODE_PRIVATE) }
  private val syncedFile = SyncedCache()
  private val rootLimits = HashMap<MediaSession.ControllerInfo, Int>()
  private val sleepTimer = SleepTimer()
  private val positions = PositionTracker()
  private val ticker = object : Runnable {
    override fun run() {
      tick()
      schedule()
    }
  }

  override fun onCreate() {
    super.onCreate()
    instance = this
    shuffle = StartFirstShuffleOrder(Random())
    val hub = ResolvingDataSource.Factory(DefaultDataSource.Factory(this, DefaultHttpDataSource.Factory())) { spec ->
      MusicHub.headers(spec.uri.toString()).takeIf { it.isNotEmpty() }?.let(spec::withAdditionalHeaders) ?: spec
    }
    player = ExoPlayer.Builder(this)
      .setMediaSourceFactory(DefaultMediaSourceFactory(hub))
      .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), true)
      .setHandleAudioBecomingNoisy(true)
      .setWakeMode(C.WAKE_MODE_NETWORK)
      .build()
    player.setShuffleOrder(shuffle)
    player.addListener(object : Player.Listener {
      override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
        if (player.isPlaying) heard()
        remember()
        observe()
      }
      override fun onIsPlayingChanged(isPlaying: Boolean) {
        heard()
        remember()
        observe()
        schedule()
      }
      override fun onPlaybackStateChanged(playbackState: Int) {
        observe()
      }
      override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) {
        if (reason == Player.DISCONTINUITY_REASON_SEEK) {
          heard()
          if (oldPosition.mediaItemIndex == newPosition.mediaItemIndex) positions.seeked()
          observe()
        }
      }
      override fun onShuffleModeEnabledChanged(shuffleModeEnabled: Boolean) {
        if (shuffleModeEnabled && player.mediaItemCount > 0)
          player.setShuffleOrder(shuffle.startingAt(player.mediaItemCount, player.currentMediaItemIndex))
        remember()
      }
    })
    val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
      PendingIntent.getActivity(this, 2, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
    val synced = object : ForwardingPlayer(player) {
      override fun play() {
        catchUp()
        super.play()
      }
      override fun setPlayWhenReady(playWhenReady: Boolean) {
        if (playWhenReady) catchUp()
        super.setPlayWhenReady(playWhenReady)
      }
    }
    session = MediaLibrarySession.Builder(this, synced, Callback()).apply { open?.let(::setSessionActivity) }.build()
    reload()
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo) = session

  override fun onTaskRemoved(rootIntent: Intent?) {
    if (!player.playWhenReady || player.mediaItemCount == 0) stopSelf()
  }

  override fun onDestroy() {
    instance = null
    main.removeCallbacks(ticker)
    sleepTimer.off()
    remember()
    session?.release()
    player.release()
    session = null
    super.onDestroy()
  }

  fun reload(done: () -> Unit = {}) {
    loader.execute {
      val next = tree(this)
      main.post {
        try {
          if (session == null) return@post
          tree = tree.reloaded(next)
          forgetStale()
          loaded.set(Unit)
          notifyRoots()
        } finally {
          done()
        }
      }
    }
  }

  fun hubChanged() {
    main.post { if (loaded.isDone) notifyRoots() }
  }

  private fun notifyRoots() {
    val current = session ?: return
    val browsing = browse()
    current.notifyChildrenChanged(MusicTree.ROOT, browsing.roots.size, null)
    for (root in browsing.roots) current.notifyChildrenChanged(root.id, browsing.children(root.id)?.size ?: 0, null)
  }

  private fun playing() = tree.streaming(MusicHub.ready)

  fun applyRename(from: String, to: String, done: () -> Unit) {
    main.post {
      try {
        if (session != null && loaded.isDone) tree.renamed(from, to)?.let(::adopt)
      } finally {
        done()
      }
    }
  }

  private fun forgetStale() {
    val current = player.currentMediaItem
    if (current != null && tree.stale(current.mediaId, current.localConfiguration?.uri?.path) { File(it).isFile }) {
      player.stop()
      player.clearMediaItems()
    }
    val item = saved.getString("item", null)
    if (item != null && tree.expand(item) == null) saved.edit().clear().apply()
  }

  private fun played(context: String) {
    tree.played(context)?.let(::adopt)
  }

  private fun adopt(next: MusicTree) {
    val scope = next.library.scope ?: return
    tree = next
    val history = next.history
    loader.execute { saveHistory(this, scope, history) }
    session?.notifyChildrenChanged(MusicTree.RECENT, next.children(MusicTree.RECENT)?.size ?: 0, null)
  }

  private fun remember() {
    val id = player.currentMediaItem?.mediaId ?: return
    saved.edit()
      .putString("item", id)
      .putLong("position", player.currentPosition.coerceAtLeast(0))
      .putBoolean("shuffle", player.shuffleModeEnabled)
      .apply()
  }

  fun sleepState() = sleepTimer.state()

  fun setSleep(value: String): SleepState {
    val state = sleepTimer.start(value, player.currentMediaItem?.mediaId?.let(::trackOf))
    schedule()
    return state
  }

  private fun snapshot() = PlaybackSnapshot(
    player.currentMediaItem?.mediaId,
    player.currentPosition.coerceAtLeast(0),
    player.duration.takeIf { it != C.TIME_UNSET && it > 0 } ?: 0L,
    player.isPlaying,
    player.playbackState == Player.STATE_ENDED,
  )

  private fun observe() {
    positions.observe(snapshot())?.let(::enqueue)
  }

  private fun schedule() {
    main.removeCallbacks(ticker)
    if (player.isPlaying || sleepTimer.active) main.postDelayed(ticker, 1000)
  }

  private fun tick() {
    val now = snapshot()
    val step = if (sleepTimer.active) sleepTimer.tick(SleepPlayer(now.id?.let(::trackOf), now.positionMs, now.durationMs, now.ended)) else SleepStep.NONE
    positions.observe(now)?.let(::enqueue)
    if (step != SleepStep.DUE) return
    val playing = player.isPlaying
    if (SleepTimer.pauses(playing, player.playWhenReady)) player.pause()
    if (!playing) positions.force(if (now.ended) now.copy(positionMs = now.durationMs) else now)?.let(::enqueue)
  }

  private fun enqueue(save: PositionSave) {
    val id = save.snapshot.id?.let(::trackOf) ?: return
    val scope = tree.library.scope ?: return
    val hash = tree.library.tracks[id]?.hash ?: return
    val (volume, path) = PositionRules.file(id) ?: return
    val entry = QueuedPosition(volume, path, hash, save.snapshot.positionMs / 1000.0, save.snapshot.durationMs / 1000.0, System.currentTimeMillis())
    val target = outbox(this)
    val library = File(root(this), "music-library.json")
    outboxWriter.execute { runCatching { target.add(scope, entry) { library.isFile } } }
  }

  private fun trackOf(id: String) = MusicTree.parseTrackNodeId(id)?.second ?: id

  private fun heard(id: String? = player.currentMediaItem?.mediaId) {
    if (id == null) return
    saved.edit().putString("heard-track", trackOf(id)).putLong("heard-at", System.currentTimeMillis()).apply()
  }

  private fun syncedText(file: File): String? = try { file.takeIf { it.isFile }?.readText() } catch (_: Exception) { null }

  private fun browse(): MusicTree {
    val file = File(root(this), "music-synced.json")
    return playing().withProgress(syncedFile.progress(file.lastModified(), file.length(), tree.library.scope) { syncedText(file) })
  }

  private fun syncedStart(track: String, positionMs: Long, active: Boolean): Long? {
    val file = File(root(this), "music-synced.json")
    val synced = syncedFile.get(file.lastModified(), file.length(), tree.library.scope) { syncedText(file) }[track]
    val heardAt = if (saved.getString("heard-track", null) == track) saved.getLong("heard-at", 0L) else 0L
    return SyncedResume.target(positionMs, active, synced, heardAt)
  }

  private fun catchUp() {
    val id = player.currentMediaItem?.mediaId ?: return
    val active = player.isPlaying || player.playWhenReady || player.playbackState == Player.STATE_ENDED
    syncedStart(trackOf(id), player.currentPosition.coerceAtLeast(0), active)?.let { player.seekTo(it) }
  }

  private fun <T> whenLoaded(block: () -> T): ListenableFuture<T> = Futures.transform(loaded, { block() }, onMain)

  private fun cover(key: String?, large: Boolean, seen: MutableMap<String, Uri?>? = null): Uri? {
    if (seen != null && key != null) {
      val slot = "$key-$large"
      return if (seen.containsKey(slot)) seen[slot] else cover(key, large).also { seen[slot] = it }
    }
    val scope = tree.library.scope
    if (key == null || scope == null) return null
    if (large && CoverProvider.file(filesDir, scope, "$key-large.jpg")?.isFile == true)
      return CoverProvider.uri(packageName, scope, key, "large")
    if (CoverProvider.file(filesDir, scope, "$key-small.jpg")?.isFile != true) return null
    return CoverProvider.uri(packageName, scope, key, "small")
  }

  private fun type(id: String) = when {
    id == MusicTree.ROOT -> MediaMetadata.MEDIA_TYPE_FOLDER_MIXED
    id == MusicTree.ARTISTS -> MediaMetadata.MEDIA_TYPE_FOLDER_ARTISTS
    id == MusicTree.ALBUMS || id == MusicTree.RECENT -> MediaMetadata.MEDIA_TYPE_FOLDER_ALBUMS
    id == MusicTree.PLAYLISTS -> MediaMetadata.MEDIA_TYPE_FOLDER_PLAYLISTS
    id == MusicTree.PODCASTS -> MediaMetadata.MEDIA_TYPE_FOLDER_PODCASTS
    MusicTree.parseGroupNodeId(id) != null -> MediaMetadata.MEDIA_TYPE_FOLDER_MIXED
    id.startsWith("artist:") -> MediaMetadata.MEDIA_TYPE_ARTIST
    id.startsWith("album:") -> MediaMetadata.MEDIA_TYPE_ALBUM
    id.startsWith("playlist:") -> MediaMetadata.MEDIA_TYPE_PLAYLIST
    id.startsWith("show:") -> MediaMetadata.MEDIA_TYPE_PODCAST
    else -> MediaMetadata.MEDIA_TYPE_MUSIC
  }

  private fun completion(played: Played?, percent: Int): Bundle? = played?.let {
    Bundle().apply {
      when (it) {
        Played.NOT_PLAYED -> putInt(MediaConstants.EXTRAS_KEY_COMPLETION_STATUS, MediaConstants.EXTRAS_VALUE_COMPLETION_STATUS_NOT_PLAYED)
        Played.FULLY_PLAYED -> putInt(MediaConstants.EXTRAS_KEY_COMPLETION_STATUS, MediaConstants.EXTRAS_VALUE_COMPLETION_STATUS_FULLY_PLAYED)
        Played.PARTIALLY_PLAYED -> {
          putInt(MediaConstants.EXTRAS_KEY_COMPLETION_STATUS, MediaConstants.EXTRAS_VALUE_COMPLETION_STATUS_PARTIALLY_PLAYED)
          putDouble(MediaConstants.EXTRAS_KEY_COMPLETION_PERCENTAGE, percent / 100.0)
        }
      }
    }
  }

  private fun browsable(node: MusicNode): MediaItem {
    node.track?.takeIf { node.playable }?.let { return playable(node.id, it, false, subtitle = node.subtitle, extras = completion(node.played, node.percent)) }
    val metadata = MediaMetadata.Builder()
      .setTitle(node.title)
      .setSubtitle(node.subtitle)
      .setArtworkUri(cover(node.cover, false))
      .setIsBrowsable(node.track == null)
      .setIsPlayable(false)
      .setMediaType(if (node.track == null) type(node.id) else MediaMetadata.MEDIA_TYPE_MUSIC)
    if (node.grid || node.group != null)
      metadata.setExtras(Bundle().apply {
        if (node.grid) putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_BROWSABLE, MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_GRID_ITEM)
        node.group?.let { putString(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_GROUP_TITLE, it) }
      })
    return MediaItem.Builder().setMediaId(node.id).setMediaMetadata(metadata.build()).build()
  }

  private fun playable(id: String, track: MusicTrack, large: Boolean = true, seen: MutableMap<String, Uri?>? = null, subtitle: String? = null, extras: Bundle? = null): MediaItem = MediaItem.Builder()
    .setMediaId(id)
    .setUri(if (track.stream) Uri.parse(track.path) else Uri.fromFile(File(track.path)))
    .setMediaMetadata(
      MediaMetadata.Builder()
        .setTitle(track.title)
        .setArtist(track.artist)
        .setAlbumTitle(track.album)
        .setArtworkUri(cover(track.cover, large, seen))
        .setDurationMs(track.durationMs)
        .setIsBrowsable(false)
        .setIsPlayable(true)
        .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
        .apply { if (subtitle != null) setDisplayTitle(track.title).setSubtitle(subtitle) }
        .apply { if (extras != null) setExtras(extras) }
        .build(),
    )
    .build()

  private fun nameQueue(id: String?) {
    val context = id?.let { MusicTree.parseTrackNodeId(it)?.first }
    player.playlistMetadata = MediaMetadata.Builder().setTitle(context?.let(tree::queueTitle)).build()
  }

  private fun queue(id: String, positionMs: Long): MediaSession.MediaItemsWithStartPosition? {
    val tree = playing()
    val (tracks, index) = tree.expand(id) ?: return null
    val context = MusicTree.parseTrackNodeId(id)?.first?.takeIf { tree.queue(it) != null }
    val seen = HashMap<String, Uri?>()
    val items = tracks.mapIndexed { index, track -> playable(if (context != null) MusicTree.trackNodeId(context, track.id, index) else track.id, track, seen = seen) }
    return MediaSession.MediaItemsWithStartPosition(items, index, positionMs)
  }

  private inner class Callback : MediaLibrarySession.Callback {
    override fun onConnect(session: MediaSession, controller: MediaSession.ControllerInfo): MediaSession.ConnectionResult =
      MediaSession.ConnectionResult.AcceptedResultBuilder(session)
        .setAvailableSessionCommands(
          MediaSession.ConnectionResult.DEFAULT_SESSION_AND_LIBRARY_COMMANDS.buildUpon()
            .remove(SessionCommand.COMMAND_CODE_LIBRARY_SEARCH)
            .remove(SessionCommand.COMMAND_CODE_LIBRARY_GET_SEARCH_RESULT)
            .build(),
        )
        .build()

    override fun onGetLibraryRoot(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      params: LibraryParams?,
    ): ListenableFuture<LibraryResult<MediaItem>> {
      val limit = params?.extras?.getInt(MediaConstants.EXTRAS_KEY_ROOT_CHILDREN_LIMIT, 0) ?: 0
      if (limit > 0) rootLimits[browser] = limit else rootLimits.remove(browser)
      return Futures.immediateFuture(LibraryResult.ofItem(browsable(MusicTree.rootNode), null))
    }

    override fun onDisconnected(session: MediaSession, controller: MediaSession.ControllerInfo) {
      rootLimits.remove(controller)
    }

    override fun onGetItem(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      mediaId: String,
    ): ListenableFuture<LibraryResult<MediaItem>> = whenLoaded {
      val node = browse().node(mediaId)
      if (node == null) LibraryResult.ofError(SessionError.ERROR_BAD_VALUE) else LibraryResult.ofItem(browsable(node), null)
    }

    override fun onGetChildren(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      parentId: String,
      page: Int,
      pageSize: Int,
      params: LibraryParams?,
    ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> = whenLoaded {
      val children = browse().children(parentId, rootLimits[browser])
      if (children == null || page < 0 || pageSize < 1) LibraryResult.ofError(SessionError.ERROR_BAD_VALUE)
      else {
        val from = (page.toLong() * pageSize).coerceAtMost(children.size.toLong()).toInt()
        val to = (from.toLong() + pageSize).coerceAtMost(children.size.toLong()).toInt()
        LibraryResult.ofItemList(children.subList(from, to).map(::browsable), params)
      }
    }

    override fun onAddMediaItems(
      mediaSession: MediaSession,
      controller: MediaSession.ControllerInfo,
      mediaItems: MutableList<MediaItem>,
    ): ListenableFuture<MutableList<MediaItem>> = whenLoaded {
      mediaItems.mapNotNull { item -> MusicTree.resolveContinue(item.mediaId).let { id -> playing().expand(id)?.let { (tracks, index) -> playable(id, tracks[index]) } } }.toMutableList()
    }

    override fun onSetMediaItems(
      mediaSession: MediaSession,
      controller: MediaSession.ControllerInfo,
      mediaItems: MutableList<MediaItem>,
      startIndex: Int,
      startPositionMs: Long,
    ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> = Futures.transformAsync(loaded, {
      val position = if (startPositionMs == C.TIME_UNSET) 0L else startPositionMs
      val continued = if (mediaItems.size == 1) MusicTree.parseContinueNodeId(mediaItems[0].mediaId) else null
      val first = continued ?: mediaItems.firstOrNull()?.mediaId
      val begin = if (continued != null) browse().resumePosition(continued)?.let { SyncedResume.continueStart(it, player.currentMediaItem?.mediaId?.let(::trackOf), trackOf(continued), player.currentPosition.coerceAtLeast(0)) } ?: position else position
      val single = if (mediaItems.size == 1 && first != null) queue(first, begin) else null
      if (single != null && first != null) {
        heard(first)
        MusicTree.parseTrackNodeId(first)?.let { played(it.first) }
        nameQueue(first)
        Futures.immediateFuture(single)
      }
      else {
        val resolved = mediaItems.mapNotNull { item -> MusicTree.resolveContinue(item.mediaId).let { id -> playing().expand(id)?.let { (tracks, index) -> playable(id, tracks[index]) } } }
        if (resolved.isEmpty()) Futures.immediateFailedFuture(IllegalArgumentException("This music is no longer on this phone."))
        else {
          nameQueue(null)
          val start = if (startIndex == C.INDEX_UNSET) 0 else startIndex.coerceIn(0, resolved.size - 1)
          heard(resolved[start].mediaId)
          Futures.immediateFuture(MediaSession.MediaItemsWithStartPosition(resolved, start, position))
        }
      }
    }, onMain)

    override fun onPlaybackResumption(
      mediaSession: MediaSession,
      controller: MediaSession.ControllerInfo,
      isForPlayback: Boolean,
    ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> = Futures.transformAsync(loaded, {
      val item = saved.getString("item", null)
      val restored = item?.let {
        val position = saved.getLong("position", 0)
        queue(it, syncedStart(trackOf(it), position, false) ?: position)
      }
      if (restored == null) Futures.immediateFailedFuture(UnsupportedOperationException("Nothing to resume"))
      else {
        nameQueue(item)
        player.shuffleModeEnabled = saved.getBoolean("shuffle", false)
        Futures.immediateFuture(restored)
      }
    }, onMain)
  }
}
