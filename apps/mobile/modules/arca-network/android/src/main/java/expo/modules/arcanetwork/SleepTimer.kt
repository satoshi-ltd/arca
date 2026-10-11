package expo.modules.arcanetwork

data class SleepPlayer(val track: String?, val positionMs: Long, val durationMs: Long, val ended: Boolean)

data class SleepState(val mode: String, val value: String?, val endsAt: Long?)

enum class SleepStep { NONE, NEAR, DUE, CANCEL }

class SleepTimer(private val clock: () -> Long = System::currentTimeMillis) {
  companion object {
    const val DUE_MS = 1500L
    const val NEAR_MS = 4000L
    const val END = "end"
    val DURATIONS = mapOf("30" to 30 * 60_000L, "60" to 60 * 60_000L)
    val OFF = SleepState("off", null, null)

    fun pauses(isPlaying: Boolean, playWhenReady: Boolean) = isPlaying || playWhenReady
  }

  private var state = OFF
  private var track: String? = null
  private var near = false

  val active get() = state.mode != "off"

  fun state() = state

  fun off() {
    state = OFF
    track = null
    near = false
  }

  fun start(value: String, playing: String?): SleepState {
    off()
    val duration = DURATIONS[value]
    if (duration != null) state = SleepState("duration", value, clock() + duration)
    else if (value == END && playing != null) {
      state = SleepState("end", END, null)
      track = playing
    }
    return state
  }

  fun tick(player: SleepPlayer): SleepStep {
    val step = peek(player)
    when (step) {
      SleepStep.NEAR -> near = true
      SleepStep.DUE, SleepStep.CANCEL -> off()
      SleepStep.NONE -> Unit
    }
    return step
  }

  private fun peek(player: SleepPlayer): SleepStep {
    if (state.mode == "duration") return if (clock() >= state.endsAt!!) SleepStep.DUE else SleepStep.NONE
    if (state.mode != "end") return SleepStep.NONE
    if (player.ended) return SleepStep.DUE
    if (player.track != null && player.track != track) return if (near) SleepStep.DUE else SleepStep.CANCEL
    val remaining = if (player.durationMs > 0) player.durationMs - player.positionMs else Long.MAX_VALUE
    return when {
      remaining <= DUE_MS -> SleepStep.DUE
      remaining <= NEAR_MS -> SleepStep.NEAR
      else -> SleepStep.NONE
    }
  }
}
