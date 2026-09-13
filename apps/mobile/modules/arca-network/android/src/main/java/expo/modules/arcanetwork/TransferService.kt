package expo.modules.arcanetwork

import android.app.*
import android.content.Intent
import android.os.*
import android.content.pm.ServiceInfo

/** Keeps an existing user-visible upload session alive; never restarts after termination. */
class TransferService : com.facebook.react.HeadlessJsTaskService() {
  companion object {
    const val CHANNEL = "arca-transfers"
    const val ID = 4102
    const val PAUSE = "arca.transfer.PAUSE"
    @Volatile var instance: TransferService? = null
    var onStopped: ((String) -> Unit)? = null
  }
  private var lock: PowerManager.WakeLock? = null
  private var lastUpdate = 0L

  override fun onCreate() {
    super.onCreate()
    instance = this
    val manager = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(NotificationChannel(CHANNEL, "Photo uploads", NotificationManager.IMPORTANCE_LOW))
    val notification = notification("Preparing photos", 0, 0)
    if (Build.VERSION.SDK_INT >= 29) startForeground(ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    else startForeground(ID, notification)
    lock = (getSystemService(POWER_SERVICE) as PowerManager).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "arca:uploads")
    lock?.acquire(6 * 60 * 60 * 1000L)
  }
  private fun notification(text: String, done: Long, total: Long): Notification {
    val pause = PendingIntent.getService(this, 0, Intent(this, TransferService::class.java).setAction(PAUSE), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
      PendingIntent.getActivity(this, 1, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
    return (if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else Notification.Builder(this))
      .setSmallIcon(android.R.drawable.stat_sys_upload)
      .setContentTitle("Arca · Photo uploads").setContentText(text)
      .setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true)
      .setProgress(100, if (total > 0) ((done.toDouble() / total) * 100).toInt().coerceIn(0, 100) else 0, total <= 0)
      .addAction(Notification.Action.Builder(null, "Pause", pause).build()).build()
  }
  fun progress(text: String, done: Long, total: Long) {
    val now = SystemClock.elapsedRealtime()
    if (now - lastUpdate < 1000) return
    lastUpdate = now
    getSystemService(NotificationManager::class.java).notify(ID, notification(text.take(120), done, total))
  }
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == PAUSE) { onStopped?.invoke("paused"); stopSelf() }
    if (intent?.action != PAUSE) super.onStartCommand(intent, flags, startId)
    return START_NOT_STICKY
  }
  override fun onTimeout(startId: Int, fgsType: Int) { onStopped?.invoke("timeout"); stopSelf() }
  override fun onTaskRemoved(rootIntent: Intent?) { onStopped?.invoke("closed"); stopSelf() }
  override fun onDestroy() {
    instance = null
    if (lock?.isHeld == true) lock?.release()
    stopForeground(STOP_FOREGROUND_REMOVE)
    super.onDestroy()
  }
  override fun getTaskConfig(intent: Intent?) = com.facebook.react.jstasks.HeadlessJsTaskConfig(
    "ArcaPhotoTransfer", com.facebook.react.bridge.Arguments.createMap(), 0, true
  )
}
