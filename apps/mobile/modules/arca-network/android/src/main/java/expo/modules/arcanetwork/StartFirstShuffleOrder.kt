package expo.modules.arcanetwork

import androidx.media3.common.C
import androidx.media3.exoplayer.source.ShuffleOrder
import java.util.Random

class StartFirstShuffleOrder private constructor(order: IntArray, private val random: Random) :
  ShuffleOrder.DefaultShuffleOrder(order, random.nextLong()) {
  constructor(random: Random) : this(IntArray(0), random)

  private fun wrap(next: ShuffleOrder): ShuffleOrder {
    val order = IntArray(next.length)
    var index = next.firstIndex
    var position = 0
    while (index != C.INDEX_UNSET && position < order.size) {
      order[position++] = index
      index = next.getNextIndex(index)
    }
    return StartFirstShuffleOrder(order, random)
  }

  fun startingAt(count: Int, start: Int): ShuffleOrder =
    StartFirstShuffleOrder(MusicLibraryData.startFirst(count, start, random), random)

  override fun cloneAndInsert(insertionIndex: Int, insertionCount: Int) =
    wrap(super.cloneAndInsert(insertionIndex, insertionCount))

  override fun cloneAndRemove(indexFrom: Int, indexToExclusive: Int) =
    wrap(super.cloneAndRemove(indexFrom, indexToExclusive))

  override fun cloneAndClear(): ShuffleOrder = StartFirstShuffleOrder(IntArray(0), random)

  override fun cloneAndSet(insertionCount: Int, insertionIndex: Int) = startingAt(insertionCount, insertionIndex)
}
