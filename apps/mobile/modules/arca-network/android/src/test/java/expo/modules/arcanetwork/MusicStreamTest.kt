package expo.modules.arcanetwork

import java.io.File
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MusicStreamTest {
  private val root: File = Files.createTempDirectory("arca-stream").toFile()
  private val hub = "https://hub.example:8443/v1/music/media?volume=v&path=A%2F2.mp3&hash=b"
  private fun library() = MusicLibraryData.parse(
    """
    {"format":1,"scope":"hub-1",
     "tracks":[
       {"id":"v:A/1.mp3","uri":"${File(root, "hub-1/audio-downloads/v/a.mp3").toURI()}","title":"One","artist":"Ann","album":"First","duration":60},
       {"id":"v:A/2.mp3","uri":"$hub","stream":true,"title":"Two","artist":"Ann","album":"First","duration":60},
       {"id":"v:A/3.mp3","uri":"https://user@hub.example/v1/music/media?volume=v","stream":true,"title":"Bad","artist":"Ann","album":"First"},
       {"id":"v:A/4.mp3","uri":"https://hub.example/v1/blobs/x","stream":true,"title":"Bad","artist":"Ann","album":"First"},
       {"id":"v:A/5.mp3","uri":"$hub","title":"Not marked","artist":"Ann","album":"First"}
     ],
     "albums":[{"id":"album:first","title":"First","artist":"Ann","tracks":["v:A/1.mp3","v:A/2.mp3"]}],
     "artists":[{"id":"artist:ann","name":"Ann","letter":"A","albums":["album:first"]}],
     "recent":[]}
    """.trimIndent(),
    root.path,
  )

  @After fun forget() {
    MusicHub.set(null, null)
  }

  @Test fun streamTracksKeepOnlyHubMediaUrls() {
    val data = library()
    assertEquals(listOf("v:A/1.mp3", "v:A/2.mp3"), data.tracks.keys.toList())
    assertTrue(data.tracks["v:A/2.mp3"]!!.stream)
    assertEquals(hub, data.tracks["v:A/2.mp3"]!!.path)
    assertFalse(data.tracks["v:A/1.mp3"]!!.stream)
  }

  @Test fun streamTracksLeaveThePlayableSetWithoutTheHub() {
    val online = MusicTree(library())
    assertEquals(listOf("v:A/1.mp3", "v:A/2.mp3"), online.queue("album:first")!!.map { it.id })
    val offline = online.streaming(false)
    assertEquals(listOf("v:A/1.mp3"), offline.queue("album:first")!!.map { it.id })
    val rows = offline.children("album:first")!!
    assertEquals(listOf(true, false), rows.map { it.playable })
    assertEquals(MusicTree.UNAVAILABLE, rows[1].subtitle)
    assertNull(offline.expand(MusicTree.trackNodeId("album:first", "v:A/2.mp3")))
    assertNull(offline.expand("v:A/2.mp3"))
    assertEquals("v:A/1.mp3", offline.expand(rows[0].id)!!.first.single().id)
  }

  @Test fun theCredentialReachesOnlyTheHubsOrigin() {
    assertTrue(MusicHub.headers(hub).isEmpty())
    assertTrue(MusicHub.set("https://hub.example:8443", "Bearer secret"))
    assertFalse(MusicHub.set("https://HUB.example:8443/", "Bearer secret"))
    assertTrue(MusicHub.ready)
    assertEquals(mapOf("Authorization" to "Bearer secret"), MusicHub.headers(hub))
    assertTrue(MusicHub.headers("https://hub.example/v1/music/media").isEmpty())
    assertTrue(MusicHub.headers("http://hub.example:8443/v1/music/media").isEmpty())
    assertTrue(MusicHub.headers("https://other.example:8443/v1/music/media").isEmpty())
    assertTrue(MusicHub.set(null, null))
    assertFalse(MusicHub.ready)
    assertTrue(MusicHub.headers(hub).isEmpty())
  }
}
