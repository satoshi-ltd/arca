package expo.modules.arcanetwork

import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import org.json.JSONArray
import org.json.JSONObject

data class PlaybackSnapshot(val id: String?, val positionMs: Long, val durationMs: Long, val playing: Boolean, val ended: Boolean)

data class PositionSave(val snapshot: PlaybackSnapshot, val force: Boolean)

data class QueuedPosition(val volume: String, val path: String, val hash: String, val position: Double, val duration: Double, val at: Long) {
  fun json(): JSONObject = JSONObject().put("volume", volume).put("path", path).put("hash", hash).put("position", position).put("duration", duration).put("at", at)

  companion object {
    fun encode(rows: Collection<QueuedPosition>): JSONArray {
      val items = JSONArray()
      for (row in rows) items.put(row.json())
      return items
    }
  }
}

object PositionRules {
  const val MIN_SECONDS = 1200L
  const val HEAD_SECONDS = 10L
  const val INTERVAL_MS = 15_000L
  const val SEEK_SETTLE_MS = 2000L
  const val END_SLACK_MS = 3000L

  fun file(id: String): Pair<String, String>? {
    val at = id.indexOf(':')
    return if (at > 0) id.substring(0, at) to id.substring(at + 1) else null
  }

  fun plan(before: PlaybackSnapshot, next: PlaybackSnapshot): PositionSave? {
    if (before.id != null && before.id != next.id) {
      if (before.durationMs < MIN_SECONDS * 1000) return null
      val ended = before.durationMs - before.positionMs <= END_SLACK_MS
      return PositionSave(if (ended) before.copy(positionMs = before.durationMs) else before, true)
    }
    if (next.id != null && before.id == next.id && before.playing && !next.playing)
      return PositionSave(if (next.ended) next.copy(positionMs = next.durationMs) else next, true)
    return if (next.id != null && next.playing) PositionSave(next, false) else null
  }

  fun shouldSave(positionMs: Long, durationMs: Long, force: Boolean, now: Long, last: Long, seeking: Boolean): Boolean {
    if (seeking || durationMs < MIN_SECONDS * 1000) return false
    if (positionMs < HEAD_SECONDS * 1000) return false
    return force || now - last >= INTERVAL_MS
  }
}

class PositionTracker(private val clock: () -> Long = System::currentTimeMillis) {
  private var live = PlaybackSnapshot(null, 0, 0, false, false)
  private var lastSaved = 0L
  private var seekingUntil = 0L

  fun seeked() {
    val now = clock()
    seekingUntil = now + PositionRules.SEEK_SETTLE_MS
    lastSaved = now - PositionRules.INTERVAL_MS + PositionRules.SEEK_SETTLE_MS
  }

  fun observe(next: PlaybackSnapshot): PositionSave? {
    val before = live
    live = next
    val plan = PositionRules.plan(before, next) ?: return null
    return accept(plan.snapshot, plan.force, before.id != null && before.id != next.id)
  }

  fun force(snapshot: PlaybackSnapshot): PositionSave? = accept(snapshot, true, false)

  private fun accept(snapshot: PlaybackSnapshot, force: Boolean, leaving: Boolean): PositionSave? {
    val now = clock()
    if (snapshot.id == null || !PositionRules.shouldSave(snapshot.positionMs, snapshot.durationMs, force, now, lastSaved, !leaving && now < seekingUntil)) return null
    lastSaved = now
    return PositionSave(snapshot, force)
  }
}

class PositionOutbox(private val file: File) {
  companion object {
    const val LIMIT = 200
    private val lock = Any()
  }

  private class Content(val scope: String?, val rows: Map<Pair<String, String>, QueuedPosition>)

  fun add(scope: String, entry: QueuedPosition, live: () -> Boolean = { true }) {
    synchronized(lock) {
      if (!live()) return
      val current = read()
      val rows: LinkedHashMap<Pair<String, String>, QueuedPosition> = LinkedHashMap()
      if (current.scope == scope) rows.putAll(current.rows)
      val key = entry.volume to entry.path
      val known = rows[key]
      if (known != null && known.at >= entry.at) return
      rows[key] = entry
      while (rows.size > LIMIT) rows.remove(rows.entries.minByOrNull { it.value.at }!!.key)
      write(scope, rows.values)
    }
  }

  fun pending(scope: String): List<QueuedPosition> {
    synchronized(lock) {
      val current = read()
      if (current.scope == scope) return current.rows.values.sortedBy { it.at }
      if (current.scope != null || current.rows.isNotEmpty()) file.delete()
      return emptyList()
    }
  }

  fun acknowledge(sent: List<Triple<String, String, Long>>) {
    synchronized(lock) {
      val current = read()
      val scope = current.scope ?: return
      val rows = current.rows.values.filterNot { row -> sent.any { it.first == row.volume && it.second == row.path && row.at <= it.third } }
      if (rows.size == current.rows.size) return
      if (rows.isEmpty()) file.delete() else write(scope, rows)
    }
  }

  private fun read(): Content = try {
    val json = JSONObject(file.readText())
    val items = json.optJSONArray("entries") ?: JSONArray()
    val rows = LinkedHashMap<Pair<String, String>, QueuedPosition>()
    if (json.optInt("format") == 1) for (index in 0 until items.length()) {
      val item = items.optJSONObject(index) ?: continue
      val volume = item.optString("volume")
      val path = item.optString("path")
      val hash = item.optString("hash")
      val position = item.optDouble("position")
      val duration = item.optDouble("duration")
      val at = item.optLong("at", -1)
      if (volume.isEmpty() || path.isEmpty() || hash.isEmpty() || !position.isFinite() || !duration.isFinite() || at < 0) continue
      rows[volume to path] = QueuedPosition(volume, path, hash, position, duration, at)
    }
    Content(json.optString("scope").takeIf { it.isNotEmpty() && json.optInt("format") == 1 }, rows)
  } catch (_: Exception) {
    Content(null, emptyMap())
  }

  private fun write(scope: String, rows: Collection<QueuedPosition>) {
    file.parentFile?.mkdirs()
    val staged = File(file.path + ".part")
    FileOutputStream(staged).use { out ->
      out.write(JSONObject().put("format", 1).put("scope", scope).put("entries", QueuedPosition.encode(rows)).toString().toByteArray())
      out.fd.sync()
    }
    Files.move(staged.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
  }
}
