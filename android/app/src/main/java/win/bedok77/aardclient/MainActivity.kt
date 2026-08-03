package win.bedok77.aardclient

import android.Manifest
import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.util.Base64
import android.util.Log
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject
import java.io.ByteArrayOutputStream

/**
 * The whole UI: a WebView running the same client as the browser PWA.
 *
 * The assets are served over https://appassets.androidplatform.net rather than
 * loaded as file:// URLs. That is not cosmetic -- a file:// origin is opaque, so
 * IndexedDB (the map database), localStorage (login, aliases, dinv bindings) and
 * ES modules either fail outright or get wiped between runs. An asset-loader
 * origin behaves like a normal secure website, which is what the client expects.
 */
class MainActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "AardClient"
        private const val ORIGIN = "https://appassets.androidplatform.net"

        /**
         * Content types, pinned rather than guessed -- exactly as relay_minimal.py
         * has to do. A browser refuses an ES module served as anything but a
         * JavaScript type, and the platform's own extension lookup has been known
         * to answer text/plain for .js.
         */
        private val CONTENT_TYPES = mapOf(
            "js" to "application/javascript",
            "mjs" to "application/javascript",
            "html" to "text/html",
            "json" to "application/json",
            "css" to "text/css",
            "wasm" to "application/wasm",
            "db" to "application/octet-stream",
        )
        private val TEXT_TYPES = setOf("js", "mjs", "html", "json", "css")

        /** ~256KB of base64 per bridge call; big enough to be quick, small enough to be safe. */
        private const val FILE_CHUNK = 192 * 1024
    }

    private lateinit var webView: WebView
    private var service: MudService? = null

    /** Messages the page sent before the service finished binding. */
    private val pendingToService = ArrayDeque<String>()

    private val fileLock = Any()
    private var outgoing: ByteArrayOutputStream? = null
    private var pendingSaveBytes: ByteArray? = null

    // -------------------------------------------------------------------------
    // Activity results -- StartActivityForResult rather than the CreateDocument /
    // OpenDocument contracts, whose constructors changed shape across androidx
    // activity versions.
    // -------------------------------------------------------------------------

    private val createDoc = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val bytes = pendingSaveBytes
        pendingSaveBytes = null
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null || bytes == null) return@registerForActivityResult
        try {
            contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
        } catch (e: Exception) {
            Log.e(TAG, "save failed", e)
        }
    }

    private val openDoc = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) {
            evalJs("window.__aardFileDone(\"cancelled\")")
            return@registerForActivityResult
        }
        try {
            val bytes = contentResolver.openInputStream(uri)?.use { it.readBytes() }
                ?: throw IllegalStateException("could not open")
            pushFileToPage(bytes)
        } catch (e: Exception) {
            Log.e(TAG, "open failed", e)
            evalJs("window.__aardFileDone(${jsString(e.message ?: "read failed")})")
        }
    }

    private val askNotifications = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { /* denial only costs the Disconnect action, so nothing to handle */ }

    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            val s = (binder as? MudService.LocalBinder)?.service ?: return
            s.setListener { json -> deliverToPage(json) }
            // Publishing `service` and draining the queue have to happen under
            // one lock. Done separately, a message posted from the WebView
            // thread in between would be queued after the drain had already run
            // and would sit there forever -- and the message that goes missing
            // is {action:'connect'}, so the app would just never connect.
            val queued = synchronized(pendingToService) {
                service = s
                val copy = pendingToService.toList()
                pendingToService.clear()
                copy
            }
            queued.forEach { s.handleClientMessage(it) }
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            service = null
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        }

        val loader = WebViewAssetLoader.Builder()
            // Order matters: the loader takes the first handler whose prefix
            // matches. "/static/js/main.js" has to reach assets/js/main.js, which
            // it only does if the "/static/" handler is consulted before "/".
            .addPathHandler("/static/", TypedAssetHandler(this))
            .addPathHandler("/", TypedAssetHandler(this))
            .build()

        webView = WebView(this)
        webView.setBackgroundColor(0xFF0A0A12.toInt())   // matches the client's --bg; avoids a white flash
        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true          // localStorage: login, aliases, dinv bindings
            databaseEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mediaPlaybackRequiresUserGesture = false
            // index.html asks for user-scalable=yes, maximum-scale=5.
            setSupportZoom(true)
            builtInZoomControls = true
            displayZoomControls = false
        }
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView, request: WebResourceRequest
            ): WebResourceResponse? = loader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(
                view: WebView, request: WebResourceRequest
            ): Boolean {
                if (request.url.host == "appassets.androidplatform.net") return false
                // A link out of the client belongs in a real browser, not in here.
                return try {
                    startActivity(Intent(Intent.ACTION_VIEW, request.url)); true
                } catch (_: Exception) { true }
            }
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                Log.d(TAG, "console: ${m.message()} (${m.sourceId()}:${m.lineNumber()})")
                return true
            }
        }
        webView.addJavascriptInterface(AardBridge(this), "AardNative")
        setContentView(webView)

        val svc = Intent(this, MudService::class.java)
        ContextCompat.startForegroundService(this, svc)
        bindService(svc, connection, Context.BIND_AUTO_CREATE)

        webView.loadUrl("$ORIGIN/index.html")
    }

    override fun onDestroy() {
        service?.setListener(null)
        try { unbindService(connection) } catch (_: Exception) {}
        // The WebView goes; the MUD session does not. That is the point of the
        // service -- closing the window must not drop the character link-dead.
        // destroy() on a WebView still attached to the view hierarchy is a
        // documented crash, so detach it first.
        (webView.parent as? ViewGroup)?.removeView(webView)
        webView.destroy()
        super.onDestroy()
    }

    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        // Send the app to the background rather than finishing it: finishing
        // would tear down the WebView and lose the scrollback for no reason.
        moveTaskToBack(true)
    }

    // -------------------------------------------------------------------------
    // Bridge plumbing (called from AardBridge, on a WebView worker thread)
    // -------------------------------------------------------------------------

    fun postToService(json: String) {
        val s = synchronized(pendingToService) {
            val bound = service
            if (bound == null) pendingToService.addLast(json)
            bound
        }
        s?.handleClientMessage(json)
    }

    fun requestDisconnect() {
        service?.disconnect()
    }

    private fun deliverToPage(json: String) {
        evalJs("window.__aardNativeRecv(${jsString(json)})")
    }

    private fun evalJs(script: String) {
        runOnUiThread {
            try { webView.evaluateJavascript(script, null) } catch (_: Exception) {}
        }
    }

    /**
     * A JS string literal for arbitrary text.
     *
     * JSONObject.quote handles quotes, backslashes and control characters, but
     * not U+2028/U+2029 -- legal inside a JSON string, a syntax error inside a
     * JavaScript one. MUD output is not supposed to contain them; a crash of the
     * whole bridge is too high a price for finding out otherwise.
     */
    private fun jsString(s: String): String =
        JSONObject.quote(s).replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")

    // -------------------------------------------------------------------------
    // File transfer (/export and /import)
    // -------------------------------------------------------------------------

    fun fileBegin() {
        synchronized(fileLock) { outgoing = ByteArrayOutputStream() }
    }

    fun fileChunk(base64: String) {
        synchronized(fileLock) {
            outgoing?.write(Base64.decode(base64, Base64.DEFAULT))
        }
    }

    fun fileSave(suggestedName: String) {
        val bytes = synchronized(fileLock) {
            val b = outgoing?.toByteArray()
            outgoing = null
            b
        } ?: return
        pendingSaveBytes = bytes
        runOnUiThread {
            createDoc.launch(
                Intent(Intent.ACTION_CREATE_DOCUMENT)
                    .addCategory(Intent.CATEGORY_OPENABLE)
                    .setType("application/octet-stream")
                    .putExtra(Intent.EXTRA_TITLE, suggestedName)
            )
        }
    }

    fun fileOpen(mimeType: String) {
        runOnUiThread {
            openDoc.launch(
                Intent(Intent.ACTION_OPEN_DOCUMENT)
                    .addCategory(Intent.CATEGORY_OPENABLE)
                    .setType(if (mimeType.isBlank()) "*/*" else mimeType)
            )
        }
    }

    private fun pushFileToPage(bytes: ByteArray) {
        var off = 0
        while (off < bytes.size) {
            val n = minOf(FILE_CHUNK, bytes.size - off)
            // NO_WRAP keeps the output to [A-Za-z0-9+/=], which needs no escaping
            // inside the JS string literal below.
            val b64 = Base64.encodeToString(bytes, off, n, Base64.NO_WRAP)
            evalJs("window.__aardFileChunk(\"$b64\")")
            off += n
        }
        evalJs("window.__aardFileDone()")
    }

    /** AssetsPathHandler, with the Content-Type pinned instead of guessed. */
    private class TypedAssetHandler(context: Context) : WebViewAssetLoader.PathHandler {
        private val inner = WebViewAssetLoader.AssetsPathHandler(context)

        override fun handle(path: String): WebResourceResponse? {
            val resp = inner.handle(path) ?: return null
            val ext = path.substringAfterLast('.', "").lowercase()
            CONTENT_TYPES[ext]?.let { resp.mimeType = it }
            if (ext in TEXT_TYPES) resp.encoding = "utf-8"
            return resp
        }
    }
}
