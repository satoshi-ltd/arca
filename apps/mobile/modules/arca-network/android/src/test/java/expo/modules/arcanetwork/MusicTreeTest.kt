package expo.modules.arcanetwork

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MusicTreeTest {
  private val root: File = Files.createTempDirectory("arca-music").toFile()
  private val cover = "a".repeat(64)
  private fun uri(path: String) = File(root, path).toURI().toString()
  private fun library(extra: String = "") = MusicLibraryData.parse(
    """
    {"format":1,"scope":"hub-1","covers":"${root.toURI()}",
     "tracks":[
       {"id":"v:Ann/First/1.mp3","uri":"${uri("hub-1/folders/v/Ann/First/1.mp3")}","title":"One","artist":"Ann","album":"First","albumId":"album:a:ann:first","duration":61.5,"cover":"$cover"},
       {"id":"v:Ann/First/2.mp3","uri":"${uri("hub-1/folders/v/Ann/First/2.mp3")}","title":"Two","artist":"Ann","album":"First","albumId":"album:a:ann:first","duration":null,"cover":null},
       {"id":"v:Bo/1.flac","uri":"${uri("hub-1/folders/v/Bo/1.flac")}","title":"Alone","artist":"Bo","album":"Solo","albumId":"album:a:bo:solo","duration":10,"cover":null},
       {"id":"v:outside.mp3","uri":"file:///etc/passwd","title":"Escape","artist":"X","album":"Y","albumId":"album:x","duration":1,"cover":null},
       {"id":"v:../escape.mp3","uri":"${uri("../escape.mp3")}","title":"Escape","artist":"X","album":"Y","albumId":"album:x","duration":1,"cover":null},
       null
     ],
     "albums":[
       {"id":"album:a:ann:first","title":"First","artist":"Ann","year":2001,"cover":"$cover","tracks":["v:Ann/First/1.mp3","v:Ann/First/2.mp3"]},
       {"id":"album:a:bo:solo","title":"Solo","artist":"Bo","year":null,"cover":null,"tracks":["v:Bo/1.flac","v:missing.mp3"]},
       {"id":"album:x","title":"Y","artist":"X","year":null,"cover":null,"tracks":["v:outside.mp3"]}
     ],
     "artists":[
       {"id":"artist:ann","name":"Ann","letter":"A","cover":"$cover","albums":["album:a:ann:first"]},
       {"id":"artist:bo","name":"Bo","letter":"B","cover":null,"albums":["album:a:bo:solo"]},
       {"id":"artist:x","name":"X","cover":null,"albums":["album:x"]}
     ],
     "recent":["album:a:bo:solo","album:x","album:a:ann:first"]$extra}
    """.trimIndent(),
    root.path,
  )

  @Test fun parsingKeepsOnlyTracksInsideTheAppStorageAndDropsEmptyGroups() {
    val data = library()
    assertEquals("hub-1", data.scope)
    assertEquals(listOf("v:Ann/First/1.mp3", "v:Ann/First/2.mp3", "v:Bo/1.flac"), data.tracks.keys.toList())
    assertEquals(61500L, data.tracks["v:Ann/First/1.mp3"]!!.durationMs)
    assertEquals(File(root, "hub-1/folders/v/Ann/First/1.mp3").canonicalPath, data.tracks["v:Ann/First/1.mp3"]!!.path)
    assertNull(data.tracks["v:Ann/First/2.mp3"]!!.durationMs)
    assertEquals(cover, data.tracks["v:Ann/First/1.mp3"]!!.cover)
    assertNull(data.tracks["v:Ann/First/2.mp3"]!!.cover)
    assertEquals(listOf("album:a:ann:first", "album:a:bo:solo"), data.albumOrder)
    assertEquals(listOf("v:Bo/1.flac"), data.albums["album:a:bo:solo"]!!.tracks)
    assertEquals(listOf("artist:ann", "artist:bo"), data.artists.map { it.id })
    assertEquals(listOf("album:a:bo:solo", "album:a:ann:first"), data.recent)
  }

  @Test fun artistsCarryTheirLetterAsTheCarsGroupHeading() {
    assertEquals(listOf("A", "B"), MusicTree(library()).children(MusicTree.ARTISTS)!!.map { it.group })
    val odd = MusicLibraryData.parse(
      """
      {"format":1,"scope":"hub-1",
       "tracks":[{"id":"v:a.mp3","uri":"${uri("hub-1/folders/v/a.mp3")}","title":"A"}],
       "albums":[{"id":"album:a","title":"A","artist":"x","tracks":["v:a.mp3"]}],
       "artists":[
         {"id":"artist:x","name":"x","letter":"ab","albums":["album:a"]},
         {"id":"artist:y","name":"9","letter":"#","albums":["album:a"]},
         {"id":"artist:z","name":"z","albums":["album:a"]}
       ]}
      """.trimIndent(),
      root.path,
    )
    assertEquals(listOf(null, "#", null), MusicTree(odd).children(MusicTree.ARTISTS)!!.map { it.group })
  }

  @Test fun aRenamedPlaylistKeepsItsPlaceInRecentOnce() {
    val tree = MusicTree(library(), listOf("playlist:old", "album:a:ann:first", "playlist:new"))
    assertEquals(listOf("playlist:new", "album:a:ann:first"), tree.renamed("playlist:old", "playlist:new")!!.history)
    assertNull(tree.renamed("playlist:none", "playlist:x"))
    assertNull(tree.renamed("playlist:old", "playlist:old"))
    val reloaded = tree.renamed("playlist:old", "playlist:new")!!.reloaded(MusicTree(library(), listOf("playlist:old")))
    assertEquals("a reload keeps the renamed history in memory", listOf("playlist:new", "album:a:ann:first"), reloaded.history)
  }

  @Test fun anUnknownFormatOrScopeReadsAsAnEmptyLibrary() {
    assertEquals(MusicLibraryData.EMPTY, MusicLibraryData.parse("""{"format":2,"scope":"hub-1"}""", root.path))
    assertEquals(MusicLibraryData.EMPTY, MusicLibraryData.parse("""{"format":1,"scope":"../x"}""", root.path))
    assertEquals(MusicLibraryData.EMPTY, MusicLibraryData.parse("""{"format":1,"scope":null}""", root.path))
  }

  @Test fun theRootOpensOnArtistsAndEachBranchIsAtMostThreeLevelsDeep() {
    val tree = MusicTree(library())
    assertEquals(listOf("artists", "albums", "recent"), tree.children(MusicTree.ROOT)!!.map { it.id })
    assertEquals(listOf("Artists", "Albums", "Recent"), tree.children(MusicTree.ROOT)!!.map { it.title })
    assertEquals(listOf(false, true, false), tree.children(MusicTree.ROOT)!!.map { it.grid })
    assertTrue(tree.children(MusicTree.ROOT)!!.none { it.playable })
    val artists = tree.children(MusicTree.ARTISTS)!!
    assertEquals(listOf("Ann" to "1 album", "Bo" to "1 album"), artists.map { it.title to it.subtitle })
    assertTrue("an artist's albums show as a grid", artists.all { it.grid })
    val albums = tree.children("artist:ann")!!
    assertEquals(listOf("album:a:ann:first"), albums.map { it.id })
    val tracks = tree.children("album:a:ann:first")!!
    assertEquals(listOf("One", "Two"), tracks.map { it.title })
    assertTrue(tracks.all { it.playable })
    assertEquals(MusicTree.trackNodeId("album:a:ann:first", "v:Ann/First/1.mp3", 0), tracks[0].id)
    assertNull(tree.children(tracks[0].id))
    assertEquals(listOf("Solo" to MusicTree.ADDED, "First" to MusicTree.ADDED), tree.children(MusicTree.RECENT)!!.map { it.title to it.group })
    assertNull(tree.children("album:unknown"))
  }

  @Test fun pickingATrackQueuesItsAlbumFromThatTrack() {
    val tree = MusicTree(library())
    val (album, start) = tree.expand(MusicTree.trackNodeId("album:a:ann:first", "v:Ann/First/2.mp3"))!!
    assertEquals(listOf("One", "Two"), album.map { it.title })
    assertEquals(1, start)
    val (single, index) = tree.expand("v:Bo/1.flac")!!
    assertEquals(listOf("Alone"), single.map { it.title })
    assertEquals(0, index)
    val (stale, staleIndex) = tree.expand(MusicTree.trackNodeId("album:gone", "v:Bo/1.flac"))!!
    assertEquals(listOf("Alone"), stale.map { it.title })
    assertEquals(0, staleIndex)
    assertNull(tree.expand(MusicTree.trackNodeId("album:a:ann:first", "v:missing.mp3")))
  }

  @Test fun aPlayingTrackStopsOnlyWhenItLeftTheLibraryAndItsFileIsGone() {
    val tree = MusicTree(library())
    val gone = MusicTree.trackNodeId("album:a:ann:first", "v:Ann/First/9.mp3")
    assertFalse(tree.stale(MusicTree.trackNodeId("album:a:ann:first", "v:Ann/First/1.mp3"), null) { false })
    assertFalse(tree.stale(gone, "/music/9.mp3") { true })
    assertTrue(tree.stale(gone, "/music/9.mp3") { false })
    assertTrue(tree.stale(gone, null) { true })
    assertTrue(MusicTree(MusicLibraryData.EMPTY).stale(gone, "/music/9.mp3") { true })
  }

  @Test fun recentListsThisPhonesPlaysNewestFirstAndFallsBackToRecentlyAdded() {
    val tree = MusicTree(library())
    val twice = tree.played("album:a:ann:first")!!.played("album:a:bo:solo")!!
    assertNull("playing the newest entry again changes nothing", twice.played("album:a:bo:solo"))
    assertNull("only albums of this library are recorded", twice.played("album:unknown"))
    assertNull(twice.played("playlist:v:Mix.m3u8"))
    val recent = twice.children(MusicTree.RECENT)!!
    assertEquals(listOf("Solo" to "Bo", "First" to "Ann"), recent.map { it.title to it.subtitle })
    assertTrue(recent.all { it.group == MusicTree.PLAYED && !it.playable && !it.grid })
    assertEquals(listOf("album:a:ann:first", "album:a:bo:solo"), twice.played("album:a:ann:first")!!.history)
    val gone = MusicTree(library(), listOf("album:removed", "playlist:v:Old.m3u"))
    assertEquals(listOf(MusicTree.ADDED, MusicTree.ADDED), gone.children(MusicTree.RECENT)!!.map { it.group })
    val many = (1..25).fold(emptyList<String>()) { history, index -> MusicHistory.record(history, "album:$index") }
    assertEquals(MusicHistory.LIMIT, many.size)
    assertEquals("album:25", many.first())
  }

  @Test fun aReloadKeepsPlaysTheFileHasNotCaughtUpWith() {
    val playing = MusicTree(library()).played("album:a:ann:first")!!
    val reread = MusicTree(library(), emptyList())
    assertEquals(listOf("album:a:ann:first"), playing.reloaded(reread).history)
    val other = MusicTree(MusicLibraryData.parse("""{"format":1,"scope":"hub-2","tracks":[]}""", root.path), listOf("album:z"))
    assertEquals(listOf("album:z"), playing.reloaded(other).history)
    assertEquals(emptyList<String>(), playing.reloaded(MusicTree(MusicLibraryData.EMPTY)).history)
    assertEquals(listOf("album:b"), MusicTree(MusicLibraryData.EMPTY).reloaded(MusicTree(library(), listOf("album:b"))).history)
  }

  @Test fun shuffleQueuesTheWholeLibraryOrOneArtistWithoutRecordingThem() {
    val tree = MusicTree(library())
    val (all, start) = tree.expand(MusicTree.trackNodeId(MusicTree.ALBUMS, "v:Bo/1.flac"))!!
    assertEquals("the whole library queues in album order", listOf("One", "Two", "Alone"), all.map { it.title })
    assertEquals("Alone", all[start].title)
    val (mine, at) = tree.expand(MusicTree.trackNodeId("in:v:${MusicTree.ALBUMS}", "v:Ann/First/1.mp3"))!!
    assertEquals("a folder's Shuffle queues only that folder", listOf("One", "Two", "Alone"), mine.map { it.title })
    assertEquals(0, at)
    assertNull(tree.queue("in:other:${MusicTree.ALBUMS}"))
    assertEquals(listOf("One", "Two"), tree.queue("in:v:artist:ann")!!.map { it.title })
    assertNull(tree.played("in:v:${MusicTree.ALBUMS}"))
    val (ann, first) = tree.expand(MusicTree.trackNodeId("artist:ann", "v:Ann/First/2.mp3"))!!
    assertEquals(listOf("One", "Two"), ann.map { it.title })
    assertEquals(1, first)
    assertNull(tree.played(MusicTree.ALBUMS))
    assertNull(tree.played("artist:ann"))
    assertNull(tree.queue("artist:nobody"))
  }

  @Test fun anAlbumPlayedFromOneFolderQueuesOnlyThatFolderAndStillEntersRecent() {
    val data = MusicLibraryData.parse(
      """{"format":1,"scope":"hub-1","tracks":[
        {"id":"v:a.mp3","uri":"${uri("hub-1/folders/v/a.mp3")}","title":"A","artist":"Ann","album":"First","duration":1,"cover":null},
        {"id":"w:a.mp3","uri":"${uri("hub-1/folders/w/a.mp3")}","title":"A again","artist":"Ann","album":"First","duration":1,"cover":null},
        {"id":"v:b.mp3","uri":"${uri("hub-1/folders/v/b.mp3")}","title":"B","artist":"Ann","album":"First","duration":1,"cover":null}],
      "albums":[{"id":"album:first","title":"First","artist":"Ann","cover":null,"tracks":["v:a.mp3","w:a.mp3","v:b.mp3"]}],
      "artists":[{"id":"artist:ann","name":"Ann","cover":null,"albums":["album:first"]}],"recent":["album:first"]}""",
      root.path,
    )
    val tree = MusicTree(data)
    assertEquals("without a folder the queue keeps every track the file lists", listOf("A", "A again", "B"), tree.queue("album:first")!!.map { it.title })
    assertEquals(listOf("A", "B"), tree.queue("in:v:album:first")!!.map { it.title })
    assertEquals(listOf("A again"), tree.queue("in:w:${MusicTree.ALBUMS}")!!.map { it.title })
    val (queue, index) = tree.expand(MusicTree.trackNodeId("in:v:album:first", "v:b.mp3"))!!
    assertEquals(listOf("A", "B"), queue.map { it.title })
    assertEquals(1, index)
    assertEquals(listOf("album:first"), tree.played("in:v:album:first")!!.history)
    assertNull("a context without a folder is refused, as on the phone", tree.played("in::album:first"))
    assertNull(tree.queue("in::album:first"))
  }

  @Test fun theHistoryFileBelongsToOneHub() {
    val history = listOf("playlist:v:Mix.m3u8", "album:a:ann:first")
    val text = MusicHistory.encode("hub-1", history)
    assertEquals(history, MusicHistory.parse(text, "hub-1"))
    assertEquals(emptyList<String>(), MusicHistory.parse(text, "hub-2"))
    assertEquals(emptyList<String>(), MusicHistory.parse(text, null))
    assertEquals(emptyList<String>(), MusicHistory.parse("""{"format":2,"scope":"hub-1","items":["album:a"]}""", "hub-1"))
    assertEquals(emptyList<String>(), MusicHistory.parse("not json", "hub-1"))
    assertEquals(emptyList<String>(), MusicHistory.parse(null, "hub-1"))
    assertEquals(listOf("album:a", "album:b"), MusicHistory.parse("""{"format":1,"scope":"hub-1","items":["album:a",1,"","album:b","album:a"]}""", "hub-1"))
  }

  private val roadTrip =
    ""","playlists":[
      {"id":"playlist:road","name":"Road trip","tracks":["v:Bo/1.flac","v:missing.mp3","v:Ann/First/1.mp3","v:Bo/1.flac","v:outside.mp3"]},
      {"id":"playlist:empty","name":"Gone","tracks":["v:missing.mp3"]},
      {"id":"mix","name":"Not a playlist id","tracks":["v:Bo/1.flac"]}]"""

  @Test fun thePlaylistsTabSitsBetweenAlbumsAndRecentOnlyWhileAPlaylistHasATrack() {
    assertEquals(listOf("artists", "albums", "recent"), MusicTree(library()).children(MusicTree.ROOT)!!.map { it.id })
    val tree = MusicTree(library(roadTrip))
    assertEquals(listOf("Artists", "Albums", "Playlists", "Recent"), tree.children(MusicTree.ROOT)!!.map { it.title })
    val playlists = tree.children(MusicTree.PLAYLISTS)!!
    assertEquals(listOf("Road trip" to "3 tracks"), playlists.map { it.title to it.subtitle })
    assertNull("the first track's cover, as the file orders it", playlists[0].cover)
    assertTrue(playlists.none { it.playable || it.grid })
    assertNull(tree.node("mix"))
    assertNull(tree.queue("playlist:empty"))
  }

  @Test fun aPlaylistListsItsTracksInFileOrderWithEveryAppearanceAndSkipsEntriesNamingNoTrack() {
    val tree = MusicTree(library(roadTrip))
    val tracks = tree.children("playlist:road")!!
    assertEquals(listOf("Alone", "One", "Alone"), tracks.map { it.title })
    assertEquals(
      listOf(0, 1, 2).zip(listOf("v:Bo/1.flac", "v:Ann/First/1.mp3", "v:Bo/1.flac")).map { (index, id) -> MusicTree.trackNodeId("playlist:road", id, index) },
      tracks.map { it.id },
    )
    assertEquals("each appearance has its own id", 3, tracks.map { it.id }.toSet().size)
    for (track in tracks) assertEquals(track, tree.node(track.id))
  }

  @Test fun trackRowsInTheCarEndWithTheirLengthAndPlaylistRowsNameTheAlbum() {
    val tree = MusicTree(library(roadTrip))
    assertEquals(listOf("Ann · 1:02", "Ann"), tree.children("album:a:ann:first")!!.map { it.subtitle })
    assertEquals(listOf("Bo · Solo · 0:10", "Ann · First · 1:02", "Bo · Solo · 0:10"), tree.children("playlist:road")!!.map { it.subtitle })
    assertEquals("Bo · Solo · 0:10", tree.node(MusicTree.trackNodeId("in:v:playlist:road", "v:Bo/1.flac", 0))!!.subtitle)
    assertEquals(listOf("9:22", "1:02:03", "0:01"), listOf(562_000L, 3_723_000L, 600L).map { MusicTree.length(it) })
    assertNull(MusicTree.length(null))
    assertNull(MusicTree.length(0))
  }

  @Test fun theQueueIsNamedAfterTheAlbumPlaylistOrArtistItWasSetFrom() {
    val tree = MusicTree(library(roadTrip))
    assertEquals("First", tree.queueTitle("album:a:ann:first"))
    assertEquals("Road trip", tree.queueTitle("in:v:playlist:road"))
    assertEquals("Ann", tree.queueTitle("artist:ann"))
    assertNull(tree.queueTitle(MusicTree.ALBUMS))
    assertNull(tree.queueTitle("album:unknown"))
  }

  @Test fun pickingARepeatedTrackQueuesThePlaylistFromThatAppearance() {
    val tree = MusicTree(library(roadTrip))
    val (queue, index) = tree.expand(MusicTree.trackNodeId("playlist:road", "v:Bo/1.flac", 2))!!
    assertEquals("the queue keeps every appearance", listOf("Alone", "One", "Alone"), queue.map { it.title })
    assertEquals(2, index)
    assertEquals(0, tree.expand(MusicTree.trackNodeId("playlist:road", "v:Bo/1.flac"))!!.second)
    assertEquals("a position naming another track falls back to the first appearance", 0, tree.expand(MusicTree.trackNodeId("playlist:road", "v:Bo/1.flac", 1))!!.second)
    assertEquals(2, tree.expand(MusicTree.trackNodeId("in:v:playlist:road", "v:Bo/1.flac", 2))!!.second)
    assertNull(tree.queue("in:w:playlist:road"))
    assertEquals(Triple("playlist:road", "v:Bo/1.flac", 2), MusicTree.parseTrackNodeId(MusicTree.trackNodeId("playlist:road", "v:Bo/1.flac", 2)))
    assertEquals(Triple("album:a", "v:a.mp3", null), MusicTree.parseTrackNodeId("track\u001Falbum:a\u001Fv:a.mp3"))
    for (bad in listOf("01", "-1", "x", "", "99999999999")) assertNull(bad, MusicTree.parseTrackNodeId("track\u001Falbum:a\u001Fv:a.mp3\u001F$bad"))
    assertNull(MusicTree.parseTrackNodeId("track\u001Fa\u001Fb\u001F1\u001F2"))
  }

  @Test fun aPlayedPlaylistEntersRecentWithAlbums() {
    val tree = MusicTree(library(roadTrip))
    val played = tree.played("in:v:playlist:road")!!.played("album:a:ann:first")!!
    assertEquals(listOf("album:a:ann:first", "playlist:road"), played.history)
    val recent = played.children(MusicTree.RECENT)!!
    assertEquals(listOf("First" to "Ann", "Road trip" to "3 tracks"), recent.map { it.title to it.subtitle })
    assertTrue(recent.all { it.group == MusicTree.PLAYED })
    for (child in recent) assertEquals(child.id, played.node(child.id)?.id)
    assertNull("a playlist with no track on this phone is not recorded", tree.played("playlist:empty"))
  }

  @Test fun fileUrisDecodePercentEscapesAndKeepCharactersJavaUriRejects() {
    val base = root.toURI().toString().removeSuffix("/")
    assertEquals(File(root, "hub-1/a b/[Remastered] x|y+z.mp3").path, MusicLibraryData.filePath("$base/hub-1/a%20b/[Remastered]%20x|y+z.mp3"))
    assertEquals("/data/caf\u00e9.mp3", MusicLibraryData.filePath("file:///data/caf%C3%A9.mp3"))
    val canonical = root.canonicalPath + File.separator
    assertEquals(File(root, "hub-1/folders/v/[Live] Song.mp3").canonicalPath, MusicLibraryData.insideRoot("$base/hub-1/folders/v/[Live]%20Song.mp3", canonical))
    assertNull(MusicLibraryData.insideRoot("$base/hub-1/../../escape.mp3", canonical))
    assertNull(MusicLibraryData.filePath("file:///bad%+F.mp3"))
    assertNull(MusicLibraryData.filePath("file:///bad%-1.mp3"))
    assertNull(MusicLibraryData.filePath("file:///bad%2"))
    assertNull(MusicLibraryData.filePath("file:///nul%00.mp3"))
    assertNull(MusicLibraryData.filePath("file://host/share.mp3"))
  }

  @Test fun everyNodeIdResolvesBackToItsNode() {
    val tree = MusicTree(library())
    for (parent in listOf(MusicTree.ROOT, MusicTree.ARTISTS, MusicTree.ALBUMS, "artist:ann", "album:a:ann:first"))
      for (child in tree.children(parent)!!) assertEquals(child, tree.node(child.id))
    val lists = MusicTree(library(roadTrip))
    for (parent in listOf(MusicTree.ROOT, MusicTree.PLAYLISTS, "playlist:road"))
      for (child in lists.children(parent)!!) assertEquals(child, lists.node(child.id))
    val played = tree.played("album:a:bo:solo")!!.played("album:a:ann:first")!!
    for (child in played.children(MusicTree.RECENT)!!) assertEquals(child.id, played.node(child.id)?.id)
    assertNull(tree.node("artist:nobody"))
    assertNull(MusicLibraryData.insideRoot("content://x/y", root.canonicalPath + File.separator))
  }

  @Test fun shuffleOrdersStartWithTheChosenTrackAndKeepEveryOther() {
    val random = java.util.Random(7)
    for (start in 0 until 10) {
      val order = MusicLibraryData.startFirst(10, start, random)
      assertEquals(start, order[0])
      assertEquals((0 until 10).toList(), order.sorted())
    }
    assertEquals(0, MusicLibraryData.startFirst(0, 0, random).size)
    assertEquals(listOf(0), MusicLibraryData.startFirst(1, 0, random).toList())
    assertEquals((0 until 4).toList(), MusicLibraryData.startFirst(4, -1, random).sorted())
  }
}
