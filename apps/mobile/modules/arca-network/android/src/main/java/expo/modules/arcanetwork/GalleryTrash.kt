package expo.modules.arcanetwork

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.MediaStore
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts.StartIntentSenderForResult.Companion.ACTION_INTENT_SENDER_REQUEST
import androidx.activity.result.contract.ActivityResultContracts.StartIntentSenderForResult.Companion.EXTRA_INTENT_SENDER_REQUEST
import expo.modules.kotlin.activityresult.AppContextActivityResultContract
import java.io.Serializable

internal data class GalleryTrashInput(val uris: List<Uri>) : Serializable
internal class GalleryTrashContract : AppContextActivityResultContract<GalleryTrashInput, Boolean> {
  override fun createIntent(context: Context, input: GalleryTrashInput): Intent {
    check(android.os.Build.VERSION.SDK_INT >= 30) { "Android 11 or later is required for photo trash." }
    val request = MediaStore.createTrashRequest(context.contentResolver, input.uris, true)
    return Intent(ACTION_INTENT_SENDER_REQUEST).putExtra(EXTRA_INTENT_SENDER_REQUEST, IntentSenderRequest.Builder(request.intentSender).build())
  }
  override fun parseResult(input: GalleryTrashInput, resultCode: Int, intent: Intent?): Boolean = resultCode == Activity.RESULT_OK
}
