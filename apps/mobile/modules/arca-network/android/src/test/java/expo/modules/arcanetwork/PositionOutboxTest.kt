package expo.modules.arcanetwork

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PositionOutboxTest {
  private val folder = Files.createTempDirectory("arca-outbox").toFile()
  private val file = File(File(folder, "arca"), "music-positions.json")
  private val outbox = PositionOutbox(file)
  private fun row(path: String = "Show/One.mp3", position: Double = 600.0, at: Long = 10L) = QueuedPosition("v", path, "h-$path", position, 3600.0, at)

  @Test
  fun anEntryIsStoredAtomicallyAndComesBack() {
    outbox.add("hub", row())
    assertEquals(listOf(row()), outbox.pending("hub"))
    assertFalse(File(file.path + ".part").exists())
  }

  @Test
  fun aWriteForALibraryThatIsGoneNeverCreatesTheFile() {
    outbox.add("hub", row()) { false }
    assertFalse(file.exists())
    outbox.add("hub", row()) { true }
    assertEquals(1, outbox.pending("hub").size)
  }

  @Test
  fun theNewestEntryPerFileWinsAndOlderOnesAreIgnored() {
    outbox.add("hub", row(position = 600.0, at = 10))
    outbox.add("hub", row(position = 900.0, at = 20))
    outbox.add("hub", row(position = 700.0, at = 15))
    assertEquals(listOf(row(position = 900.0, at = 20)), outbox.pending("hub"))
  }

  @Test
  fun entriesAreOrderedByTimeAcrossFiles() {
    outbox.add("hub", row("B.mp3", at = 30))
    outbox.add("hub", row("A.mp3", at = 20))
    assertEquals(listOf("A.mp3", "B.mp3"), outbox.pending("hub").map { it.path })
  }

  @Test
  fun acknowledgingKeepsAnEntryThatChangedAfterItWasSent() {
    outbox.add("hub", row(at = 10))
    outbox.add("hub", row("Other.mp3", at = 12))
    outbox.add("hub", row(at = 20))
    outbox.acknowledge(listOf(Triple("v", "Show/One.mp3", 10L), Triple("v", "Other.mp3", 12L)))
    assertEquals(listOf(row(at = 20)), outbox.pending("hub"))
    outbox.acknowledge(listOf(Triple("v", "Show/One.mp3", 20L)))
    assertTrue(outbox.pending("hub").isEmpty())
    assertFalse(file.exists())
  }

  @Test
  fun anotherHubOrACorruptFileNeverLeaksEntries() {
    outbox.add("hub", row())
    assertTrue(outbox.pending("other").isEmpty())
    assertFalse(file.exists())
    outbox.add("hub", row())
    outbox.add("other", row("New.mp3"))
    assertEquals(listOf("New.mp3"), outbox.pending("other").map { it.path })
    file.writeText("{broken")
    assertTrue(outbox.pending("other").isEmpty())
    outbox.add("other", row())
    assertEquals(1, outbox.pending("other").size)
  }

  @Test
  fun theQueueIsBoundedAndDropsTheOldest() {
    for (index in 0..PositionOutbox.LIMIT) outbox.add("hub", row("F$index.mp3", at = index + 1L))
    val rows = outbox.pending("hub")
    assertEquals(PositionOutbox.LIMIT, rows.size)
    assertNull(rows.firstOrNull { it.path == "F0.mp3" })
    assertNotNull(rows.firstOrNull { it.path == "F${PositionOutbox.LIMIT}.mp3" })
  }
}

class PositionRulesTest {
  private fun snap(id: String? = "n1", position: Long = 60_000, duration: Long = 3_600_000, playing: Boolean = true, ended: Boolean = false) =
    PlaybackSnapshot(id, position, duration, playing, ended)

  @Test
  fun theRulesMatchTheHub() {
    assertEquals(1200L, PositionRules.MIN_SECONDS)
    assertEquals(10L, PositionRules.HEAD_SECONDS)
    assertEquals(15_000L, PositionRules.INTERVAL_MS)
  }

  @Test
  fun aSaveNeedsTwentyMinutesTenSecondsAndFifteenSecondsSinceTheLast() {
    assertTrue(PositionRules.shouldSave(600_000, 3_600_000, false, 100_000, 80_000, false))
    assertFalse(PositionRules.shouldSave(600_000, 3_600_000, false, 100_000, 90_000, false))
    assertTrue(PositionRules.shouldSave(600_000, 3_600_000, true, 100_000, 90_000, false))
    assertFalse(PositionRules.shouldSave(9_999, 3_600_000, true, 100_000, 0, false))
    assertFalse(PositionRules.shouldSave(600_000, 3_600_000, true, 100_000, 0, true))
    assertFalse(PositionRules.shouldSave(600_000, 1_199_999, true, 100_000, 0, false))
    assertTrue(PositionRules.shouldSave(600_000, 1_200_000, true, 100_000, 0, false))
  }

  @Test
  fun transitionsDecideWhatIsSaved() {
    val playing = snap()
    assertEquals(PositionSave(playing.copy(positionMs = 75_000), false), PositionRules.plan(playing, playing.copy(positionMs = 75_000)))
    val paused = playing.copy(positionMs = 80_000, playing = false)
    assertEquals(PositionSave(paused, true), PositionRules.plan(playing, paused))
    val ended = playing.copy(positionMs = 3_599_000, playing = false, ended = true)
    assertEquals(3_600_000L, PositionRules.plan(playing, ended)!!.snapshot.positionMs)
    val next = snap("n2", 0, 3_000_000)
    assertEquals(PositionSave(playing, true), PositionRules.plan(playing, next))
    assertEquals(3_600_000L, PositionRules.plan(playing.copy(positionMs = 3_599_000), next)!!.snapshot.positionMs)
    assertNull(PositionRules.plan(playing.copy(durationMs = 200_000), next))
    assertNull(PositionRules.plan(paused, paused))
    assertNull(PositionRules.plan(snap(null, 0, 0, false), snap(null, 0, 0, false)))
  }

  @Test
  fun aTrackIdSplitsIntoVolumeAndPath() {
    assertEquals("v" to "Show/One: A.mp3", PositionRules.file("v:Show/One: A.mp3"))
    assertNull(PositionRules.file(":x"))
    assertNull(PositionRules.file("nocolon"))
  }
}

class PositionTrackerTest {
  private var now = 100_000L
  private val tracker = PositionTracker { now }
  private fun snap(position: Long, playing: Boolean = true, id: String = "n1") = PlaybackSnapshot(id, position, 3_600_000, playing, false)

  @Test
  fun aPlayingTrackSavesEveryFifteenSecondsAndOnPause() {
    assertEquals(false, tracker.observe(snap(60_000))!!.force)
    now += 5_000
    assertNull(tracker.observe(snap(65_000)))
    now += 10_000
    assertEquals(75_000L, tracker.observe(snap(75_000))!!.snapshot.positionMs)
    now += 1_000
    assertEquals(true, tracker.observe(snap(76_000, playing = false))!!.force)
  }

  @Test
  fun seekingHoldsSavesUntilItSettles() {
    tracker.observe(snap(60_000))
    now += 20_000
    tracker.seeked()
    now += 1_000
    assertNull(tracker.observe(snap(900_000)))
    assertNull(tracker.observe(snap(900_000, playing = false)))
    now += 1_500
    assertEquals(902_000L, tracker.observe(snap(902_000))!!.snapshot.positionMs)
  }

  @Test
  fun switchingTracksSavesThePreviousOneAtOnce() {
    tracker.observe(snap(600_000))
    now += 1_000
    val save = tracker.observe(snap(0, id = "n2"))!!
    assertEquals("n1", save.snapshot.id)
    assertEquals(true, save.force)
  }

  @Test
  fun anExpiredTimerForcesTheSnapshot() {
    now += 1_000
    assertNull(tracker.force(snap(5_000)))
    assertEquals(true, tracker.force(snap(600_000, playing = false))!!.force)
  }

  @Test
  fun leavingAnItemAfterAScrubStillSavesItAtTheScrubbedPlace() {
    tracker.observe(snap(60_000))
    now += 1_000
    tracker.seeked()
    now += 100
    val save = tracker.observe(snap(0, id = "n2"))!!
    assertEquals("n1", save.snapshot.id)
    assertEquals(60_000L, save.snapshot.positionMs)
    assertEquals(true, save.force)
  }

  @Test
  fun aSeekWhilePausedRefreshesWhatASkipSaves() {
    tracker.observe(snap(60_000, playing = false))
    now += 1_000
    tracker.seeked()
    assertNull(tracker.observe(snap(900_000, playing = false)))
    now += 100
    val save = tracker.observe(snap(0, id = "n2"))!!
    assertEquals(900_000L, save.snapshot.positionMs)
  }
}
