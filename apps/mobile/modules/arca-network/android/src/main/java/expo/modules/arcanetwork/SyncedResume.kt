package expo.modules.arcanetwork

import org.json.JSONObject

data class SyncedPosition(val positionMs: Long, val updated: Long)
data class EpisodeProgress(val finished: Boolean, val percent: Int, val positionMs: Long, val updated: Long)

class SyncedCache {
  private var key: Triple<Long, Long, String?>? = null
  private var rows: Map<String, SyncedPosition> = emptyMap()
  private var progress: Map<String, EpisodeProgress>? = null

  private fun load(modified: Long, size: Long, scope: String?, read: () -> String?) {
    val next = Triple(modified, size, scope)
    if (next != key) {
      val text = read()
      rows = SyncedResume.parse(text, scope)
      progress = SyncedResume.parseProgress(text, scope)
      key = next
    }
  }

  fun get(modified: Long, size: Long, scope: String?, read: () -> String?): Map<String, SyncedPosition> {
    load(modified, size, scope, read)
    return rows
  }

  fun progress(modified: Long, size: Long, scope: String?, read: () -> String?): Map<String, EpisodeProgress>? {
    load(modified, size, scope, read)
    return progress
  }
}

object SyncedResume {
  const val AHEAD_MS = 10_000L

  fun parse(text: String?, scope: String?): Map<String, SyncedPosition> {
    if (text == null || scope == null) return emptyMap()
    return try {
      val json = JSONObject(text)
      val tracks = json.optJSONObject("tracks")
      if (json.optString("scope") != scope || tracks == null) emptyMap()
      else {
        val found = HashMap<String, SyncedPosition>()
        for (id in tracks.keys()) {
          val row = tracks.optJSONObject(id) ?: continue
          val position = row.optLong("position", -1)
          val updated = row.optLong("updated", -1)
          if (position > 0 && updated > 0) found[id] = SyncedPosition(position, updated)
        }
        found
      }
    } catch (_: Exception) {
      emptyMap()
    }
  }

  fun parseProgress(text: String?, scope: String?): Map<String, EpisodeProgress>? {
    if (text == null || scope == null) return null
    return try {
      val json = JSONObject(text)
      val rows = json.optJSONObject("progress")
      if (json.optString("scope") != scope || rows == null) null
      else {
        val found = HashMap<String, EpisodeProgress>()
        for (id in rows.keys()) {
          val row = rows.optJSONObject(id) ?: continue
          val updated = row.optLong("updated", 0).coerceAtLeast(0)
          when (row.optString("state")) {
            "full" -> found[id] = EpisodeProgress(true, 100, 0, updated)
            "partial" -> {
              val position = row.optLong("position", -1)
              val percent = row.optInt("percent", -1)
              if (position > 0 && percent in 1..99) found[id] = EpisodeProgress(false, percent, position, updated)
            }
          }
        }
        found
      }
    } catch (_: Exception) {
      null
    }
  }

  fun continueStart(savedMs: Long, playingTrack: String?, track: String, currentMs: Long): Long =
    if (playingTrack == track) maxOf(savedMs, currentMs) else savedMs

  fun target(positionMs: Long, active: Boolean, synced: SyncedPosition?, heardAt: Long): Long? {
    if (active || synced == null || synced.updated <= heardAt) return null
    return if (synced.positionMs > positionMs + AHEAD_MS) synced.positionMs else null
  }
}
