package win.bedok77.aardclient

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import org.json.JSONObject

/**
 * Owns the MUD connection, independently of the WebView.
 *
 * This is the piece that replaces the always-on relay at home. It matters that
 * the session lives here and not in the page: Android destroys and recreates the
 * Activity freely (rotation, memory pressure, the user switching apps), and a
 * socket owned by the page would go with it -- putting the character link-dead
 * mid-fight. A foreground service is the only way Android lets an app hold a
 * socket open while it is not on screen.
 */
class MudService : Service() {

    companion object {
        const val ACTION_DISCONNECT = "win.bedok77.aardclient.DISCONNECT"
        private const val CHANNEL_ID = "mud_session"
        private const val NOTIFICATION_ID = 1
        private const val MUD_HOST = "aardwolf.org"
        private const val MUD_PORT = 4000
    }

    inner class LocalBinder : Binder() {
        val service: MudService get() = this@MudService
    }

    private val binder = LocalBinder()
    // Touched from the WebView's binder thread (client messages) and from the
    // telnet reader thread (onClosed), not just the main thread.
    @Volatile private var session: TelnetSession? = null
    @Volatile private var wakeLock: PowerManager.WakeLock? = null

    /** Set by the Activity while a WebView is attached; null when there is none. */
    @Volatile private var listener: ((String) -> Unit)? = null

    // -------------------------------------------------------------------------
    // Service lifecycle
    // -------------------------------------------------------------------------

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_DISCONNECT) {
            disconnect()
            stopSelf()
            return START_NOT_STICKY
        }
        startForeground(NOTIFICATION_ID, buildNotification(connected = session?.isRunning == true))
        // START_STICKY would have Android restart us with a null intent after a
        // kill, with no socket and no page -- an empty notification and nothing
        // else. There is nothing useful to resume without the WebView, so let it
        // stay dead and reconnect when the user opens the app.
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        disconnect()
        super.onDestroy()
    }

    fun setListener(fn: ((String) -> Unit)?) { listener = fn }

    // -------------------------------------------------------------------------
    // The client protocol -- same JSON the relay speaks (see transport.js)
    // -------------------------------------------------------------------------

    /** One message from the page. Called on a WebView/binder thread. */
    fun handleClientMessage(json: String) {
        val d = try { JSONObject(json) } catch (_: Exception) { return }
        when (d.optString("action")) {
            "connect" -> connect()
            "ping" -> deliver(JSONObject().put("type", "pong"))
            "gmcp_request" -> session?.requestGmcpState()
            else -> {
                if (!d.has("cmd")) return
                val cmd = d.optString("cmd")
                val s = session ?: return
                if (!s.isRunning) return
                s.sendLine(cmd)
                deliver(JSONObject().put("type", "echo").put("text", cmd + "\n"))
            }
        }
    }

    private fun connect() {
        val existing = session
        if (existing != null && existing.isRunning) {
            // A reattaching page has missed everything sent so far and the MUD
            // will not redraw on its own, so the screen would just sit empty and
            // look broken. Pull the state back and nudge out a fresh prompt --
            // the same thing the relay does for a returning browser tab.
            deliver(JSONObject().put("type", "system")
                .put("text", "Reattached to the existing Aardwolf session"))
            existing.requestGmcpState()
            existing.sendLine("")
            return
        }
        val s = TelnetSession(
            host = MUD_HOST,
            port = MUD_PORT,
            emit = { deliver(it) },
            onClosed = {
                releaseWakeLock()
                updateNotification(connected = false)
            },
        )
        session = s
        acquireWakeLock()
        s.start()
        updateNotification(connected = true)
    }

    fun disconnect() {
        session?.close()
        session = null
        releaseWakeLock()
    }

    /**
     * Push one message to the page.
     *
     * With no page attached the message is dropped rather than queued. That is
     * deliberate: replaying missed output into a reattached client would re-run
     * every trigger and re-feed the campaign parsers, which act on what they
     * read -- a replayed "you killed X" line would advance the helper's state
     * machine for a kill it already handled.
     */
    private fun deliver(msg: JSONObject) {
        listener?.invoke(msg.toString())
    }

    // -------------------------------------------------------------------------
    // Staying alive
    // -------------------------------------------------------------------------

    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "AardClient::session").apply {
            setReferenceCounted(false)
            acquire()
        }
    }

    private fun releaseWakeLock() {
        try { if (wakeLock?.isHeld == true) wakeLock?.release() } catch (_: Exception) {}
        wakeLock = null
    }

    // -------------------------------------------------------------------------
    // Notification
    // -------------------------------------------------------------------------

    private fun buildNotification(connected: Boolean): Notification {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(NotificationManager::class.java)
            if (nm.getNotificationChannel(CHANNEL_ID) == null) {
                nm.createNotificationChannel(
                    NotificationChannel(CHANNEL_ID, "MUD session", NotificationManager.IMPORTANCE_LOW)
                        .apply { description = "Keeps the Aardwolf connection open while the app is in the background." }
                )
            }
        }
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0

        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), flags)
        val stop = PendingIntent.getService(
            this, 1, Intent(this, MudService::class.java).setAction(ACTION_DISCONNECT), flags)

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(if (connected) "Connected to Aardwolf" else "Not connected")
            .setSmallIcon(R.drawable.ic_stat_aard)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(open)
            .addAction(0, "Disconnect", stop)
            .build()
    }

    private fun updateNotification(connected: Boolean) {
        try {
            val nm = getSystemService(NotificationManager::class.java)
            nm.notify(NOTIFICATION_ID, buildNotification(connected))
        } catch (_: Exception) {}
    }
}
