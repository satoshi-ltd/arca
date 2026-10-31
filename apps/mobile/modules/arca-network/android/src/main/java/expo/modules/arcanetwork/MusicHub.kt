package expo.modules.arcanetwork

import java.net.URI

object MusicHub {
  private class Access(val origin: String, val authorization: String)

  @Volatile private var access: Access? = null

  val ready: Boolean get() = access != null

  fun set(url: String?, authorization: String?): Boolean {
    val origin = url?.let(::origin)
    val next = if (origin != null && !authorization.isNullOrEmpty()) Access(origin, authorization) else null
    val changed = (next == null) != (access == null) || next?.origin != access?.origin || next?.authorization != access?.authorization
    access = next
    return changed
  }

  fun headers(uri: String): Map<String, String> {
    val current = access ?: return emptyMap()
    return if (origin(uri) == current.origin) mapOf("Authorization" to current.authorization) else emptyMap()
  }

  private fun origin(value: String): String? = try {
    val uri = URI(value)
    val scheme = uri.scheme?.lowercase()
    val host = uri.host?.lowercase()
    if (scheme !in setOf("http", "https") || host.isNullOrEmpty() || uri.userInfo != null) null
    else "$scheme://$host:${if (uri.port >= 0) uri.port else if (scheme == "https") 443 else 80}"
  } catch (_: Exception) {
    null
  }
}
