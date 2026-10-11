package expo.modules.arcanetwork

import org.json.JSONObject

data class SyncedPosition(val positionMs: Long, val updated: Long)

class SyncedCache {
  private var key: Triple<Long, Long, String?>? = null
  private var rows: Map<String, SyncedPosition> = emptyMap()

  fun get(modified: Long, size: Long, scope: String?, read: () -> String?): Map<String, SyncedPosition> {
    val next = Triple(modified, size, scope)
    if (next != key) {
      rows = SyncedResume.parse(read(), scope)
      key = next
    }
    return rows
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

  fun target(positionMs: Long, active: Boolean, synced: SyncedPosition?, heardAt: Long): Long? {
    if (active || synced == null || synced.updated <= heardAt) return null
    return if (synced.positionMs > positionMs + AHEAD_MS) synced.positionMs else null
  }
}
