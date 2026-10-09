package expo.modules.arcanetwork

import java.text.Normalizer
import java.util.Locale
import org.json.JSONArray
import org.json.JSONObject

data class MusicTrack(
  val id: String,
  val path: String,
  val title: String,
  val artist: String,
  val album: String,
  val durationMs: Long?,
  val cover: String?,
)
data class MusicAlbum(val id: String, val title: String, val artist: String, val cover: String?, val tracks: List<String>)
data class MusicArtist(val id: String, val name: String, val letter: String?, val cover: String?, val albums: List<String>)
data class MusicPlaylist(val id: String, val name: String, val cover: String?, val tracks: List<String>)
data class MusicLibraryData(
  val scope: String?,
  val tracks: Map<String, MusicTrack>,
  val albums: Map<String, MusicAlbum>,
  val albumOrder: List<String>,
  val artists: List<MusicArtist>,
  val recent: List<String>,
  val playlists: Map<String, MusicPlaylist> = emptyMap(),
) {
  companion object {
    val EMPTY = MusicLibraryData(null, emptyMap(), emptyMap(), emptyList(), emptyList(), emptyList())
    private val SCOPE = Regex("^[a-zA-Z0-9-]+$")
    private val COVER = Regex("^[a-f0-9]{64}$")
    private val LETTER = Regex("^[A-Z#]$")

    fun parse(text: String, root: String): MusicLibraryData {
      val json = JSONObject(text)
      if (json.optInt("format") != 1) return EMPTY
      val scope = (if (json.isNull("scope")) "" else json.optString("scope")).takeIf { SCOPE.matches(it) } ?: return EMPTY
      fun text(item: JSONObject, key: String) = if (item.isNull(key)) "" else item.optString(key)
      fun cover(item: JSONObject) = text(item, "cover").takeIf { COVER.matches(it) }
      fun strings(array: JSONArray?) = (0 until (array?.length() ?: 0)).mapNotNull { array!!.opt(it) as? String }
      val canonicalRoot = java.io.File(root).canonicalPath + java.io.File.separator
      val tracks = LinkedHashMap<String, MusicTrack>()
      val rawTracks = json.optJSONArray("tracks") ?: JSONArray()
      for (index in 0 until rawTracks.length()) {
        val item = rawTracks.optJSONObject(index) ?: continue
        val id = text(item, "id").takeIf { it.isNotEmpty() } ?: continue
        val path = insideRoot(text(item, "uri"), canonicalRoot) ?: continue
        tracks[id] = MusicTrack(
          id,
          path,
          text(item, "title").ifEmpty { id.substringAfterLast('/') },
          text(item, "artist"),
          text(item, "album"),
          item.optDouble("duration").takeIf { it.isFinite() && it > 0 }?.let { (it * 1000).toLong() },
          cover(item),
        )
      }
      val albums = LinkedHashMap<String, MusicAlbum>()
      val rawAlbums = json.optJSONArray("albums") ?: JSONArray()
      for (index in 0 until rawAlbums.length()) {
        val item = rawAlbums.optJSONObject(index) ?: continue
        val id = text(item, "id").takeIf { it.isNotEmpty() } ?: continue
        val members = strings(item.optJSONArray("tracks")).filter { it in tracks }
        if (members.isEmpty()) continue
        albums[id] = MusicAlbum(id, text(item, "title"), text(item, "artist"), cover(item), members)
      }
      val artists = mutableListOf<MusicArtist>()
      val rawArtists = json.optJSONArray("artists") ?: JSONArray()
      for (index in 0 until rawArtists.length()) {
        val item = rawArtists.optJSONObject(index) ?: continue
        val id = text(item, "id").takeIf { it.isNotEmpty() } ?: continue
        val members = strings(item.optJSONArray("albums")).filter { it in albums }
        if (members.isNotEmpty()) artists += MusicArtist(id, text(item, "name"), text(item, "letter").takeIf { LETTER.matches(it) }, cover(item), members)
      }
      val playlists = LinkedHashMap<String, MusicPlaylist>()
      val rawPlaylists = json.optJSONArray("playlists") ?: JSONArray()
      for (index in 0 until rawPlaylists.length()) {
        val item = rawPlaylists.optJSONObject(index) ?: continue
        val id = text(item, "id").takeIf { it.startsWith("playlist:") } ?: continue
        val members = strings(item.optJSONArray("tracks")).filter { it in tracks }
        if (members.isNotEmpty()) playlists[id] = MusicPlaylist(id, text(item, "name"), tracks[members.first()]?.cover, members)
      }
      return MusicLibraryData(
        scope,
        tracks,
        albums,
        albums.keys.toList(),
        artists,
        strings(json.optJSONArray("recent")).filter { it in albums },
        playlists,
      )
    }

    fun filePath(uri: String): String? {
      val encoded = when {
        uri.startsWith("file:///") -> uri.substring("file://".length)
        uri.startsWith("file:/") && !uri.startsWith("file://") -> uri.substring("file:".length)
        else -> return null
      }
      val bytes = java.io.ByteArrayOutputStream()
      var index = 0
      while (index < encoded.length) {
        val char = encoded[index]
        if (char == '%') {
          if (index + 2 >= encoded.length) return null
          val hex = encoded.substring(index + 1, index + 3)
          if (!hex.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) return null
          bytes.write(hex.toInt(16))
          index += 3
        } else {
          bytes.write(char.toString().toByteArray(Charsets.UTF_8))
          index++
        }
      }
      val path = bytes.toString(Charsets.UTF_8.name())
      return path.takeUnless { it.contains('\u0000') }
    }

    fun insideRoot(uri: String, canonicalRoot: String): String? {
      val path = filePath(uri) ?: return null
      val canonical = try { java.io.File(path).canonicalPath } catch (_: Exception) { return null }
      return canonical.takeIf { it.startsWith(canonicalRoot) }
    }

    fun startFirst(count: Int, start: Int, random: java.util.Random): IntArray {
      if (count <= 0) return IntArray(0)
      val rest = (0 until count).filter { it != start }.toMutableList()
      for (index in rest.size - 1 downTo 1) {
        val other = random.nextInt(index + 1)
        val value = rest[index]
        rest[index] = rest[other]
        rest[other] = value
      }
      return if (start in 0 until count) intArrayOf(start, *rest.toIntArray()) else rest.toIntArray()
    }
  }
}

data class MusicNode(
  val id: String,
  val title: String,
  val subtitle: String?,
  val cover: String?,
  val playable: Boolean,
  val grid: Boolean = false,
  val group: String? = null,
  val track: MusicTrack? = null,
)

object MusicHistory {
  const val LIMIT = 20
  fun parse(text: String?, scope: String?): List<String> = try {
    val json = JSONObject(text ?: "")
    val items = json.optJSONArray("items")
    if (scope == null || json.optInt("format") != 1 || json.optString("scope") != scope) emptyList()
    else (0 until (items?.length() ?: 0)).mapNotNull { (items!!.opt(it) as? String)?.takeIf(String::isNotEmpty) }.distinct().take(LIMIT)
  } catch (_: Exception) {
    emptyList()
  }
  fun record(history: List<String>, id: String) = (listOf(id) + history.filter { it != id }).take(LIMIT)
  fun rename(history: List<String>, from: String, to: String) = history.map { if (it == from) to else it }.distinct()
  fun encode(scope: String, history: List<String>): String =
    JSONObject().put("format", 1).put("scope", scope).put("items", JSONArray(history)).toString()
}

class MusicTree(val library: MusicLibraryData, val history: List<String> = emptyList()) {
  companion object {
    const val ROOT = "root"
    const val ARTISTS = "artists"
    const val ALBUMS = "albums"
    const val PLAYLISTS = "playlists"
    const val RECENT = "recent"
    private const val SEPARATOR = '\u001F'
    fun trackNodeId(context: String, track: String, position: Int? = null): String {
      val id = "track$SEPARATOR$context$SEPARATOR$track"
      return if (position == null) id else "$id$SEPARATOR$position"
    }
    fun parseTrackNodeId(id: String): Triple<String, String, Int?>? {
      val parts = id.split(SEPARATOR)
      if (parts[0] != "track") return null
      return when (parts.size) {
        3 -> Triple(parts[1], parts[2], null)
        4 -> parts[3].toIntOrNull()?.takeIf { it >= 0 && it.toString() == parts[3] }?.let { Triple(parts[1], parts[2], it) }
        else -> null
      }
    }
    private fun count(value: Int, one: String, many: String) = if (value == 1) "1 $one" else "$value $many"
    fun length(ms: Long?): String? {
      if (ms == null || ms <= 0) return null
      val seconds = (ms + 500) / 1000
      val hours = seconds / 3600
      return if (hours > 0) String.format(Locale.ROOT, "%d:%02d:%02d", hours, seconds % 3600 / 60, seconds % 60)
      else String.format(Locale.ROOT, "%d:%02d", seconds / 60, seconds % 60)
    }
    private const val FOLDER = "in:"
    private const val GROUP = "group"
    const val GROUP_LIMIT = 120
    private const val GROUP_DEPTH = 3
    private const val CHUNK = '@'
    private val MARKS = Regex("\\p{M}+")
    private val LETTER_BASE = mapOf('\u00C6' to 'A', '\u00D0' to 'D', '\u0110' to 'D', '\u0141' to 'L', '\u00D8' to 'O', '\u0152' to 'O', '\u00DE' to 'T')
    fun groupNodeId(parent: String, prefix: String) = "$GROUP$SEPARATOR$parent$SEPARATOR$prefix"
    fun parseGroupNodeId(id: String): Pair<String, String>? {
      val parts = id.split(SEPARATOR)
      return if (parts.size == 3 && parts[0] == GROUP && parts[1].isNotEmpty() && parts[2].isNotEmpty()) parts[1] to parts[2] else null
    }
    fun sortKey(name: String, depth: Int): String =
      Normalizer.normalize(name, Normalizer.Form.NFKD)
        .replace(MARKS, "")
        .trim()
        .uppercase(Locale.ROOT)
        .take(depth)
        .map { LETTER_BASE[it] ?: it }
        .map { if (it in 'A'..'Z') it else '#' }
        .joinToString("")
        .padEnd(depth, '#')
    private val GROUP_ORDER = Comparator<String> { a, b ->
      val left = a.map { if (it == '#') '\u007F' else it }.joinToString("")
      val right = b.map { if (it == '#') '\u007F' else it }.joinToString("")
      left.compareTo(right)
    }
    private fun splitPrefix(prefix: String): Pair<String, Int?>? {
      val at = prefix.indexOf(CHUNK)
      if (at < 0) return prefix to null
      val text = prefix.substring(at + 1)
      val index = text.toIntOrNull()?.takeIf { it in 0..9999 && it.toString() == text } ?: return null
      return prefix.substring(0, at) to index
    }
    private fun chunkPrefix(key: String, index: Int) = "$key$CHUNK$index"
    private fun chunkTitle(key: String, from: Int, size: Int) =
      listOf(key, "${from + 1}\u2013${from + size}").filter { it.isNotEmpty() }.joinToString(" ")
    const val PLAYED = "Recently played"
    const val ADDED = "Recently added"
    val rootNode = MusicNode(ROOT, "Arca", null, null, false)
  }

  val roots = listOfNotNull(
    MusicNode(ARTISTS, "Artists", null, null, false),
    MusicNode(ALBUMS, "Albums", null, null, false, grid = library.albumOrder.size <= GROUP_LIMIT),
    MusicNode(PLAYLISTS, "Playlists", null, null, false).takeIf { library.playlists.isNotEmpty() },
    MusicNode(RECENT, "Recent", null, null, false),
  )

  private fun albumNode(album: MusicAlbum) =
    MusicNode(album.id, album.title, album.artist, album.cover, false)
  private fun artistNode(artist: MusicArtist) =
    MusicNode(artist.id, artist.name, count(artist.albums.size, "album", "albums"), artist.cover, false, grid = artist.albums.size <= GROUP_LIMIT, group = artist.letter)
  private fun playlistNode(playlist: MusicPlaylist) =
    MusicNode(playlist.id, playlist.name, count(playlist.tracks.size, "track", "tracks"), playlist.cover, false)
  private fun trackNode(context: String, track: MusicTrack, position: Int?): MusicNode {
    val album = track.album.takeIf { base(context).startsWith("playlist:") }
    val subtitle = listOfNotNull(track.artist, album, length(track.durationMs)).filter(String::isNotBlank).joinToString(" · ")
    return MusicNode(trackNodeId(context, track.id, position), track.title, subtitle.ifEmpty { null }, track.cover, true, track = track)
  }

  private fun base(context: String) = if (context.startsWith(FOLDER)) inFolder(context)?.second ?: context else context

  fun queueTitle(context: String): String? = base(context).let { id ->
    library.albums[id]?.title ?: library.playlists[id]?.name ?: library.artists.firstOrNull { it.id == id }?.name
  }

  fun recent(): List<MusicNode> {
    val played = history.mapNotNull { id ->
      (library.albums[id]?.let(::albumNode) ?: library.playlists[id]?.let(::playlistNode))?.copy(group = PLAYED)
    }.take(MusicHistory.LIMIT)
    return played.ifEmpty { library.recent.mapNotNull { library.albums[it] }.map { albumNode(it).copy(group = ADDED) } }
  }

  fun reloaded(next: MusicTree): MusicTree =
    if (next.library.scope != null && next.library.scope == library.scope) MusicTree(next.library, history) else next

  fun renamed(from: String, to: String): MusicTree? =
    if (from == to || from !in history) null else MusicTree(library, MusicHistory.rename(history, from, to))

  fun played(context: String): MusicTree? {
    val item = if (context.startsWith(FOLDER)) inFolder(context)?.second ?: return null else context
    if (library.albums[item] == null && library.playlists[item] == null) return null
    val next = MusicHistory.record(history, item)
    return if (next == history) null else MusicTree(library, next)
  }

  private class Entry(val name: String, val node: MusicNode)

  private fun entries(parent: String): List<Entry>? = when {
    parent == ARTISTS -> library.artists.map { Entry(it.name, artistNode(it)) }
    parent == ALBUMS -> library.albumOrder.mapNotNull { library.albums[it] }.map { Entry(it.title, albumNode(it)) }
    else -> library.artists.firstOrNull { it.id == parent }?.albums?.mapNotNull { library.albums[it] }?.map { Entry(it.title, albumNode(it)) }
  }

  private fun groupNode(parent: String, prefix: String, title: String, size: Int, leaf: Boolean): MusicNode {
    val unit = if (parent == ARTISTS) ("artist" to "artists") else ("album" to "albums")
    return MusicNode(groupNodeId(parent, prefix), title, count(size, unit.first, unit.second), null, false, grid = leaf && parent != ARTISTS)
  }

  private fun folder(parent: String, prefix: String): MusicNode? {
    val all = entries(parent) ?: return null
    val (key, chunk) = splitPrefix(prefix) ?: return null
    val matching = all.count { sortKey(it.name, key.length) == key }
    if (chunk == null) return if (matching > 0) groupNode(parent, prefix, key, matching, matching <= GROUP_LIMIT) else null
    val from = chunk * GROUP_LIMIT
    val size = (matching - from).coerceAtMost(GROUP_LIMIT)
    return if (size > 0) groupNode(parent, prefix, chunkTitle(key, from, size), size, true) else null
  }

  private fun listing(parent: String, prefix: String): List<MusicNode>? {
    val all = entries(parent) ?: return null
    val (key, chunk) = splitPrefix(prefix) ?: return null
    val matching = all.filter { sortKey(it.name, key.length) == key }
    if (chunk != null) return matching.drop(chunk * GROUP_LIMIT).take(GROUP_LIMIT).map { it.node }
    if (matching.size <= GROUP_LIMIT) return matching.map { it.node }
    val deeper = (key.length + 1..GROUP_DEPTH)
      .map { depth -> matching.groupBy { sortKey(it.name, depth) } }
      .firstOrNull { it.size > 1 }
    if (deeper != null)
      return deeper.toSortedMap(GROUP_ORDER).map { (name, members) -> groupNode(parent, name, name, members.size, members.size <= GROUP_LIMIT) }
    return (0 until (matching.size + GROUP_LIMIT - 1) / GROUP_LIMIT).map { index ->
      val from = index * GROUP_LIMIT
      groupNode(parent, chunkPrefix(key, index), chunkTitle(key, from, (matching.size - from).coerceAtMost(GROUP_LIMIT)), (matching.size - from).coerceAtMost(GROUP_LIMIT), true)
    }
  }

  fun children(parent: String): List<MusicNode>? = when {
    parent == ROOT -> roots
    parent == PLAYLISTS -> library.playlists.values.map(::playlistNode)
    parent == RECENT -> recent()
    else -> parseGroupNodeId(parent)?.let { (base, prefix) -> listing(base, prefix)?.takeIf { it.isNotEmpty() } }
      ?: listing(parent, "")
      ?: queue(parent)?.mapIndexed { index, track -> trackNode(parent, track, index) }
  }

  private fun inFolder(context: String): Pair<String, String>? =
    context.removePrefix(FOLDER).split(":", limit = 2).takeIf { it.size == 2 && it[0].isNotEmpty() }?.let { it[0] to it[1] }

  private fun albumTracks(albums: List<String>) =
    albums.flatMap { library.albums[it]?.tracks.orEmpty() }.mapNotNull { library.tracks[it] }.ifEmpty { null }

  fun queue(context: String): List<MusicTrack>? = when {
    context.startsWith(FOLDER) -> inFolder(context)
      ?.let { (folder, base) -> queue(base)?.filter { it.id.startsWith("$folder:") }?.ifEmpty { null } }
    context == ALBUMS -> albumTracks(library.albumOrder)
    context.startsWith("artist:") -> library.artists.firstOrNull { it.id == context }?.let { albumTracks(it.albums) }
    context.startsWith("playlist:") -> library.playlists[context]?.tracks?.mapNotNull { library.tracks[it] }
    else -> library.albums[context]?.tracks?.mapNotNull { library.tracks[it] }
  }

  fun node(id: String): MusicNode? {
    if (id == ROOT) return rootNode
    roots.firstOrNull { it.id == id }?.let { return it }
    parseTrackNodeId(id)?.let { (context, track, position) ->
      val item = library.tracks[track] ?: return null
      return trackNode(context, item, position)
    }
    parseGroupNodeId(id)?.let { (base, prefix) -> return folder(base, prefix) }
    library.albums[id]?.let { return albumNode(it) }
    library.playlists[id]?.let { return playlistNode(it) }
    library.artists.firstOrNull { it.id == id }?.let { return artistNode(it) }
    return null
  }

  fun expand(id: String): Pair<List<MusicTrack>, Int>? {
    val (context, track, position) = parseTrackNodeId(id) ?: return library.tracks[id]?.let { listOf(it) to 0 }
    val tracks = queue(context)
    if (tracks != null) {
      val index = position?.takeIf { tracks.getOrNull(it)?.id == track } ?: tracks.indexOfFirst { it.id == track }
      if (index >= 0) return tracks to index
    }
    return library.tracks[track]?.let { listOf(it) to 0 }
  }

  fun stale(id: String, path: String?, exists: (String) -> Boolean): Boolean =
    expand(id) == null && (library.tracks.isEmpty() || path == null || !exists(path))
}
