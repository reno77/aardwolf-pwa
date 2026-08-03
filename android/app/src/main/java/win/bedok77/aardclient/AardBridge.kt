package win.bedok77.aardclient

import android.webkit.JavascriptInterface

/**
 * The `window.AardNative` object the page talks to. See pwa/js/transport.js for
 * the other side.
 *
 * Every method here runs on a WebView worker thread, never the main thread, so
 * nothing in this file may touch the UI directly -- it all hops through the
 * Activity.
 *
 * File transfer is chunked. A backup of the local map database runs to several
 * megabytes, and a single string argument that large through the JavaScript
 * bridge is not something the WebView guarantees to deliver; a fixed-size chunk
 * always is.
 */
class AardBridge(private val activity: MainActivity) {

    /** One client protocol message: {action:...} or {cmd:...}. */
    @JavascriptInterface
    fun send(json: String) {
        activity.postToService(json)
    }

    /** The page dropped its transport. The MUD session deliberately survives. */
    @JavascriptInterface
    fun detach() {
        // Nothing to do: the service owns the socket. Present so the JS side has
        // a symmetric close() and does not have to special-case its absence.
    }

    /** Ends the MUD session for real. */
    @JavascriptInterface
    fun disconnect() {
        activity.requestDisconnect()
    }

    /** Lets the page tell it is running inside the app rather than a browser. */
    @JavascriptInterface
    fun platform(): String = "android"

    // -------------------------------------------------------------------------
    // Saving a file out
    // -------------------------------------------------------------------------

    /** Start a new outgoing file. */
    @JavascriptInterface
    fun fileBegin() = activity.fileBegin()

    /** One base64 chunk of the outgoing file, in order. */
    @JavascriptInterface
    fun fileChunk(base64: String) = activity.fileChunk(base64)

    /** Finish: opens the system "save as" picker. */
    @JavascriptInterface
    fun fileSave(suggestedName: String) = activity.fileSave(suggestedName)

    // -------------------------------------------------------------------------
    // Reading a file in
    // -------------------------------------------------------------------------

    /**
     * Opens the system file picker. The bytes come back to the page as base64
     * chunks via window.__aardFileChunk(), terminated by window.__aardFileDone()
     * -- or window.__aardFileDone(error) if it failed or was cancelled.
     */
    @JavascriptInterface
    fun fileOpen(mimeType: String) = activity.fileOpen(mimeType)
}
