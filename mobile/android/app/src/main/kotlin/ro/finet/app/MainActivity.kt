package ro.finet.app

import android.os.Bundle
import android.view.WindowManager
import io.flutter.embedding.android.FlutterFragmentActivity

// local_auth (amprentă / PIN) cere o FragmentActivity.
class MainActivity : FlutterFragmentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        // FLAG_SECURE: sumele nu apar în lista aplicațiilor recente și nu se pot captura (promptul
        // Android §6). Se aplică ferestrei întregi, deci tuturor ecranelor cu date financiare.
        window.setFlags(
            WindowManager.LayoutParams.FLAG_SECURE,
            WindowManager.LayoutParams.FLAG_SECURE,
        )
        super.onCreate(savedInstanceState)
    }
}
