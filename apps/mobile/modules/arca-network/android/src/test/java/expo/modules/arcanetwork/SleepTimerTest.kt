package expo.modules.arcanetwork

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SleepTimerTest {
  private var now = 1_000L
  private val timer = SleepTimer { now }
  private val idle = SleepPlayer("t1", 0, 600_000, false)

  @Test
  fun aDurationTimerExpiresExactlyAtItsEndAndSurvivesTrackChanges() {
    assertEquals(SleepState("duration", "30", 1_000L + 30 * 60_000), timer.start("30", "t1"))
    now = 1_000L + 30 * 60_000 - 1
    assertEquals(SleepStep.NONE, timer.tick(SleepPlayer("t2", 0, 600_000, true)))
    assertTrue(timer.active)
    now += 1
    assertEquals(SleepStep.DUE, timer.tick(idle))
    assertFalse(timer.active)
    assertEquals(SleepTimer.OFF, timer.state())
  }

  @Test
  fun anHourTimerRunsSixtyMinutes() {
    assertEquals(1_000L + 60 * 60_000, timer.start("60", null).endsAt)
  }

  @Test
  fun endOfEpisodeNeedsAnItemAndIgnoresTime() {
    assertEquals(SleepTimer.OFF, timer.start("end", null))
    assertEquals(SleepState("end", "end", null), timer.start("end", "t1"))
    now = Long.MAX_VALUE / 2
    assertEquals(SleepStep.NONE, timer.tick(SleepPlayer("t1", 1_000, 600_000, false)))
    assertEquals(SleepStep.NONE, timer.tick(SleepPlayer("t1", 1_000, 0, false)))
  }

  @Test
  fun endOfEpisodeIsNearWithinFourSecondsAndDueWithinOneAndAHalf() {
    timer.start("end", "t1")
    assertEquals(SleepStep.NEAR, timer.tick(SleepPlayer("t1", 597_000, 600_000, false)))
    assertTrue(timer.active)
    assertEquals(SleepStep.DUE, timer.tick(SleepPlayer("t1", 598_500, 600_000, false)))
    assertFalse(timer.active)
  }

  @Test
  fun endOfEpisodeIsDueWhenPlaybackEnded() {
    timer.start("end", "t1")
    assertEquals(SleepStep.DUE, timer.tick(SleepPlayer("t1", 0, 0, true)))
    assertFalse(timer.active)
  }

  @Test
  fun theItemRunningOutIntoTheNextOneIsDueButChoosingAnotherMidwayCancels() {
    timer.start("end", "t1")
    timer.tick(SleepPlayer("t1", 597_000, 600_000, false))
    assertEquals(SleepStep.DUE, timer.tick(SleepPlayer("t2", 0, 600_000, false)))
    timer.start("end", "t1")
    assertEquals(SleepStep.CANCEL, timer.tick(SleepPlayer("t2", 0, 600_000, false)))
    assertFalse(timer.active)
  }

  @Test
  fun aCancelledOrExpiredTimerStaysQuiet() {
    assertEquals(SleepStep.NONE, timer.tick(idle))
    timer.start("30", "t1")
    timer.off()
    now += 31 * 60_000
    assertEquals(SleepStep.NONE, timer.tick(idle))
    assertEquals(SleepTimer.OFF, timer.start("nope", "t1"))
  }

  @Test
  fun anEmptyPlayerNeverCancelsEndOfEpisode() {
    timer.start("end", "t1")
    assertEquals(SleepStep.NONE, timer.tick(SleepPlayer(null, 0, 0, false)))
    assertTrue(timer.active)
  }

  @Test
  fun expiryPausesAPlayerThatIsPlayingOrAboutToPlay() {
    assertTrue(SleepTimer.pauses(true, true))
    assertTrue(SleepTimer.pauses(false, true))
    assertTrue(SleepTimer.pauses(true, false))
    assertFalse(SleepTimer.pauses(false, false))
  }
}
