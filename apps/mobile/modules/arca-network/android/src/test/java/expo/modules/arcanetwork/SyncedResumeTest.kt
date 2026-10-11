package expo.modules.arcanetwork

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SyncedResumeTest {
  private val desktop = SyncedPosition(3_480_000, 2_000)

  @Test
  fun aPausedEpisodeJumpsToANewerPlaceFurtherAlong() {
    assertEquals(3_480_000L, SyncedResume.target(0, false, desktop, 0))
    assertEquals(3_480_000L, SyncedResume.target(1_200_000, false, desktop, 1_000))
  }

  @Test
  fun aPlaceSavedBeforeThisPhoneLastPlayedItNeverMovesThePlayer() {
    assertNull(SyncedResume.target(1_200_000, false, desktop, 2_000))
    assertNull(SyncedResume.target(1_200_000, false, desktop, 3_000))
  }

  @Test
  fun thePlayerKeepsItsPlaceWhenItIsAheadOrWithinTenSeconds() {
    assertNull(SyncedResume.target(3_600_000, false, desktop, 0))
    assertNull(SyncedResume.target(3_470_000, false, desktop, 0))
    assertEquals(3_480_000L, SyncedResume.target(3_469_999, false, desktop, 0))
  }

  @Test
  fun aPlayingOrEndedPlayerAndAnUnknownEpisodeAreLeftAlone() {
    assertNull(SyncedResume.target(0, true, desktop, 0))
    assertNull(SyncedResume.target(0, false, null, 0))
  }

  @Test
  fun theFileAppliesOnlyToItsOwnHubAndKeepsValidRows() {
    val text = """{"scope":"hub","tracks":{"v:Show/One.mp3":{"position":600400,"updated":2000},"v:Show/Two.mp3":{"position":0,"updated":2000},"v:Show/Three.mp3":{"position":5000}}}"""
    assertEquals(mapOf("v:Show/One.mp3" to SyncedPosition(600_400, 2_000)), SyncedResume.parse(text, "hub"))
    assertTrue(SyncedResume.parse(text, "other").isEmpty())
    assertTrue(SyncedResume.parse(text, null).isEmpty())
    assertTrue(SyncedResume.parse(null, "hub").isEmpty())
    assertTrue(SyncedResume.parse("{not json", "hub").isEmpty())
  }

  @Test
  fun theFileIsReadAgainOnlyWhenItOrTheHubChanges() {
    val cache = SyncedCache()
    var reads = 0
    val text = """{"scope":"hub","tracks":{"v:Show/One.mp3":{"position":600400,"updated":2000}}}"""
    val read = { reads++; text }
    assertEquals(1, cache.get(10, 80, "hub", read).size)
    assertEquals(1, cache.get(10, 80, "hub", read).size)
    assertEquals(1, reads)
    cache.get(11, 80, "hub", read)
    cache.get(11, 81, "hub", read)
    assertTrue(cache.get(11, 81, "other", read).isEmpty())
    assertEquals(4, reads)
  }

  @Test
  fun theProgressSectionKeepsEachEpisodesCompletionForItsOwnHub() {
    val text = """{"scope":"hub","tracks":{},"progress":{"v:Show/One.mp3":{"state":"partial","percent":14,"position":600400,"updated":2000},"v:Show/Two.mp3":{"state":"full","updated":3000},"v:Show/Bad.mp3":{"state":"partial","percent":0,"position":5},"v:Show/Odd.mp3":{"state":"other"}}}"""
    val rows = SyncedResume.parseProgress(text, "hub")!!
    assertEquals(EpisodeProgress(false, 14, 600_400, 2_000), rows["v:Show/One.mp3"])
    assertEquals(true, rows["v:Show/Two.mp3"]!!.finished)
    assertEquals(setOf("v:Show/One.mp3", "v:Show/Two.mp3"), rows.keys)
    assertNull(SyncedResume.parseProgress(text, "other"))
    assertNull(SyncedResume.parseProgress("""{"scope":"hub","tracks":{}}""", "hub"))
    assertNull(SyncedResume.parseProgress(null, "hub"))
    assertNull(SyncedResume.parseProgress("{not json", "hub"))
  }

  @Test
  fun theCacheParsesTheProgressWithTheResumeRowsInOneRead() {
    val cache = SyncedCache()
    var reads = 0
    val text = """{"scope":"hub","tracks":{"v:Show/One.mp3":{"position":600400,"updated":2000}},"progress":{"v:Show/One.mp3":{"state":"partial","percent":14,"position":600400,"updated":2000}}}"""
    val read = { reads++; text }
    assertEquals(1, cache.progress(10, 80, "hub", read)!!.size)
    assertEquals(1, cache.get(10, 80, "hub", read).size)
    assertEquals(1, reads)
    assertNull(cache.progress(10, 80, "other", read))
  }

  @Test
  fun continueNeverRewindsTheEpisodeThatIsAlreadyPlaying() {
    assertEquals(900_000L, SyncedResume.continueStart(600_000, "v:Show/One.mp3", "v:Show/One.mp3", 900_000))
    assertEquals(600_000L, SyncedResume.continueStart(600_000, "v:Show/One.mp3", "v:Show/One.mp3", 100_000))
    assertEquals(600_000L, SyncedResume.continueStart(600_000, "v:Show/Two.mp3", "v:Show/One.mp3", 900_000))
    assertEquals(600_000L, SyncedResume.continueStart(600_000, null, "v:Show/One.mp3", 900_000))
  }
}
