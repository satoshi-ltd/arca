package expo.modules.arcanetwork

class TransferGate {
  private var wanted = false
  private var foreground = false

  @Synchronized fun requested() {
    wanted = true
  }

  @Synchronized fun released(): Boolean {
    wanted = false
    return foreground.also { foreground = false }
  }

  @Synchronized fun promoted() {
    foreground = true
  }

  @Synchronized fun keep(): Boolean {
    if (!wanted) foreground = false
    return wanted
  }

  @Synchronized fun ended() {
    foreground = false
  }
}
