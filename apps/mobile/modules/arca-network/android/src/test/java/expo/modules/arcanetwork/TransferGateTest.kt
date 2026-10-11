package expo.modules.arcanetwork

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TransferGateTest {
  @Test
  fun aStopBeforeTheServiceIsForegroundWaitsForTheServiceToStopItself() {
    val gate = TransferGate()
    gate.requested()
    assertFalse("stopService before startForeground crashes the whole process", gate.released())
    gate.promoted()
    assertFalse("the pending start then stops itself after startForeground", gate.keep())
  }

  @Test
  fun aStopAfterTheServiceIsForegroundStopsItAtOnce() {
    val gate = TransferGate()
    gate.requested()
    gate.promoted()
    assertTrue(gate.keep())
    assertTrue(gate.released())
  }

  @Test
  fun aNewStartRightAfterAStopNeverStopsTheServiceThatIsStillStarting() {
    val gate = TransferGate()
    gate.requested()
    gate.promoted()
    assertTrue(gate.released())
    gate.requested()
    assertFalse(gate.released())
    gate.promoted()
    assertFalse(gate.keep())
  }

  @Test
  fun aServiceThatStoppedItselfIsNotStoppedAgainWhileTheNextOneStarts() {
    val gate = TransferGate()
    gate.requested()
    gate.promoted()
    gate.ended()
    gate.requested()
    assertFalse(gate.released())
  }

  @Test
  fun aStartAfterADeferredStopKeepsTheService() {
    val gate = TransferGate()
    gate.requested()
    assertFalse(gate.released())
    gate.requested()
    gate.promoted()
    assertTrue(gate.keep())
  }
}
