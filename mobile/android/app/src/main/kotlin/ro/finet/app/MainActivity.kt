package ro.finet.app

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.view.WindowManager
import io.flutter.embedding.android.FlutterFragmentActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.util.UUID
import java.util.concurrent.Executors

// local_auth (amprentă / PIN) cere o FragmentActivity.
class MainActivity : FlutterFragmentActivity() {
    private var channel: MethodChannel? = null
    private val executor = Executors.newSingleThreadExecutor()

    override fun onCreate(savedInstanceState: Bundle?) {
        // FLAG_SECURE: sumele nu apar în lista aplicațiilor recente și nu se pot captura (promptul
        // Android §6). Se aplică ferestrei întregi, deci tuturor ecranelor cu date financiare.
        window.setFlags(
            WindowManager.LayoutParams.FLAG_SECURE,
            WindowManager.LayoutParams.FLAG_SECURE,
        )
        super.onCreate(savedInstanceState)
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        val ch = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, SHARE_CHANNEL)
        ch.setMethodCallHandler { call, result ->
            when (call.method) {
                // Fișierele cu care a fost pornită aplicația din „Partajează” (pornire la rece).
                "takeInitial" -> readShared(intent) { files ->
                    clearShareIntent()
                    result.success(files)
                }
                else -> result.notImplemented()
            }
        }
        channel = ch
    }

    // Aplicația rulează deja (singleTop): „Partajează” ajunge aici.
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        readShared(intent) { files ->
            clearShareIntent()
            if (files.isNotEmpty()) channel?.invokeMethod("shared", files)
        }
    }

    override fun onDestroy() {
        executor.shutdown()
        super.onDestroy()
    }

    private fun clearShareIntent() {
        // Un intent de partajare se consumă o singură dată (nu se reia la rotire sau la revenire).
        setIntent(Intent(Intent.ACTION_MAIN))
    }

    private fun readShared(source: Intent?, done: (List<Map<String, String>>) -> Unit) {
        val uris = sharedUris(source)
        if (uris.isEmpty()) {
            done(emptyList())
            return
        }
        // Copierea fișierelor nu rulează pe firul principal.
        executor.execute {
            val files = uris.take(MAX_FILES).mapNotNull { copyToCache(it) }
            runOnUiThread { done(files) }
        }
    }

    @Suppress("DEPRECATION")
    private fun sharedUris(source: Intent?): List<Uri> {
        if (source == null) return emptyList()
        val tiramisu = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
        return when (source.action) {
            Intent.ACTION_SEND -> {
                val uri: Uri? = if (tiramisu) {
                    source.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
                } else {
                    source.getParcelableExtra(Intent.EXTRA_STREAM)
                }
                listOfNotNull(uri)
            }
            Intent.ACTION_SEND_MULTIPLE -> {
                val list: List<Uri>? = if (tiramisu) {
                    source.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
                } else {
                    source.getParcelableArrayListExtra(Intent.EXTRA_STREAM)
                }
                list ?: emptyList()
            }
            else -> emptyList()
        }
    }

    /**
     * Copiază fișierul partajat în memoria temporară a aplicației. Doar URI-uri `content://`:
     * `file://` ar putea arăta spre datele private ale aplicației.
     */
    private fun copyToCache(uri: Uri): Map<String, String>? {
        if (uri.scheme != "content") return null
        val name = ensureExtension(
            displayName(uri)?.replace(Regex("[^A-Za-z0-9._ -]"), "_")?.take(80) ?: "fisier",
            contentResolver.getType(uri),
        )
        val dir = File(cacheDir, SHARE_DIR).apply { mkdirs() }
        val out = File(dir, "${UUID.randomUUID()}_$name")
        return try {
            val input = contentResolver.openInputStream(uri) ?: return null
            input.use { i -> out.outputStream().use { o -> copyLimited(i, o) } }
            mapOf("path" to out.absolutePath, "name" to name)
        } catch (e: IOException) {
            out.delete()
            null
        } catch (e: SecurityException) {
            out.delete()
            null
        }
    }

    private fun displayName(uri: Uri): String? =
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
            ?.use { c -> if (c.moveToFirst()) c.getString(0) else null }

    private fun ensureExtension(name: String, mime: String?): String {
        if (name.contains('.')) return name
        val ext = when (mime) {
            "image/jpeg" -> "jpg"
            "image/png" -> "png"
            "image/webp" -> "webp"
            "image/heic" -> "heic"
            "image/heif" -> "heif"
            "application/pdf" -> "pdf"
            "text/csv", "text/comma-separated-values" -> "csv"
            else -> return name
        }
        return "$name.$ext"
    }

    private fun copyLimited(input: InputStream, output: OutputStream) {
        val buffer = ByteArray(64 * 1024)
        var total = 0L
        while (true) {
            val n = input.read(buffer)
            if (n < 0) break
            total += n
            if (total > MAX_BYTES) throw IOException("Fișier prea mare")
            output.write(buffer, 0, n)
        }
    }

    companion object {
        private const val SHARE_CHANNEL = "ro.finet.app/share"
        private const val SHARE_DIR = "finet_share"
        private const val MAX_FILES = 4

        // Plasă de siguranță pentru memoria temporară; limita reală de încărcare o aplică serverul.
        private const val MAX_BYTES = 64L * 1024 * 1024
    }
}
