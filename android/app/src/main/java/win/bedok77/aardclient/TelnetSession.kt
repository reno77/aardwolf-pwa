package win.bedok77.aardclient

import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.nio.charset.StandardCharsets

/**
 * The TCP half of the client: telnet to aardwolf.org:4000, GMCP negotiation,
 * and the same JSON messages relay_minimal.py emits over its WebSocket.
 *
 * This is a deliberate line-by-line port of that relay's `_mud_read_loop`. The
 * client's parsers (snd.js, dinv.js, areas.js) are tuned to the exact shape of
 * what the relay produces -- including the fact that whitespace-only chunks are
 * dropped -- so the safe move is to reproduce it rather than improve it.
 *
 * One thing is deliberately NOT a port: telnet refusals now answer with the
 * correct polarity (DONT answers WILL, WONT answers DO). The relay replies WONT
 * to everything, which is malformed and can in principle make a server re-offer
 * an option forever.
 */
class TelnetSession(
    private val host: String,
    private val port: Int,
    private val emit: (JSONObject) -> Unit,
    private val onClosed: () -> Unit,
) {
    companion object {
        private const val IAC = 255
        private const val SE = 240
        private const val NOP = 241
        private const val SB = 250
        private const val WILL = 251
        private const val WONT = 252
        private const val DO = 253
        private const val DONT = 254
        private const val GMCP = 201

        /** Aardwolf embeds colour codes in some GMCP values; the client wants them gone. */
        private val ANSI = Regex("\u001B\\[[0-9;]*m")

        private val EMPTY = ByteArray(0)
    }

    @Volatile private var socket: Socket? = null
    @Volatile private var out: OutputStream? = null
    @Volatile var isRunning: Boolean = false
        private set

    private val writeLock = Any()
    private val closed = java.util.concurrent.atomic.AtomicBoolean(false)
    @Volatile private var handshakeSent = false
    private var pending = EMPTY

    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------

    fun start() {
        if (isRunning) return
        isRunning = true
        Thread({ runSession() }, "aard-telnet").apply { isDaemon = true }.start()
        Thread({ keepAliveLoop() }, "aard-keepalive").apply { isDaemon = true }.start()
    }

    private fun runSession() {
        try {
            val s = Socket()
            // A movement command is two bytes. Nagle would sit on it waiting for
            // more data or the previous ACK, adding tens of milliseconds to every
            // keystroke on an already slow link.
            s.tcpNoDelay = true
            s.keepAlive = true
            s.connect(InetSocketAddress(host, port), 10_000)
            socket = s
            out = s.getOutputStream()
            emit(msg("system", "Connected to Aardwolf"))

            val input = s.getInputStream()
            val chunk = ByteArray(4096)
            while (isRunning) {
                val n = input.read(chunk)
                if (n <= 0) break
                feed(chunk.copyOf(n))
            }
        } catch (e: Exception) {
            if (isRunning) emit(msg("error", "MUD read error: ${e.message}"))
        } finally {
            shutdown()
        }
    }

    fun close() {
        if (!isRunning) return
        isRunning = false
        shutdown()
    }

    /**
     * Idempotent teardown. Both close() and the reader thread's finally block
     * land here -- an explicit disconnect closes the socket, which makes the
     * blocking read throw, which runs the finally -- so the guard is what stops
     * "Disconnected from MUD" being reported twice for one disconnect.
     */
    private fun shutdown() {
        if (!closed.compareAndSet(false, true)) return
        isRunning = false
        try { socket?.close() } catch (_: Exception) {}
        socket = null
        out = null
        handshakeSent = false
        pending = EMPTY
        emit(msg("system", "Disconnected from MUD"))
        onClosed()
    }

    // -------------------------------------------------------------------------
    // Writing
    // -------------------------------------------------------------------------

    private fun write(bytes: ByteArray) {
        val stream = out ?: return
        synchronized(writeLock) {
            try {
                stream.write(bytes)
                stream.flush()
            } catch (e: Exception) {
                if (isRunning) emit(msg("error", "MUD write error: ${e.message}"))
            }
        }
    }

    /** One command line to the MUD, exactly as a terminal client would send it. */
    fun sendLine(text: String) {
        if (!isRunning) return
        write((text + "\n").toByteArray(StandardCharsets.UTF_8))
    }

    private fun keepAliveLoop() {
        while (isRunning) {
            try { Thread.sleep(30_000) } catch (_: InterruptedException) { return }
            if (!isRunning) return
            write(byteArrayOf(IAC.toByte(), NOP.toByte()))
        }
    }

    // -------------------------------------------------------------------------
    // Telnet stream
    // -------------------------------------------------------------------------

    /** Internal rather than private so the frame parser can be tested directly. */
    internal fun feed(incoming: ByteArray) {
        pending = if (pending.isEmpty()) incoming else pending + incoming
        loop@ while (true) {
            val iac = indexOfIac(pending)
            if (iac < 0) {
                if (pending.isNotEmpty()) {
                    emitText(pending)
                    pending = EMPTY
                }
                break@loop
            }
            if (iac > 0) {
                emitText(pending.copyOfRange(0, iac))
                pending = pending.copyOfRange(iac, pending.size)
            }
            if (pending.size < 2) break@loop

            when (val cmd = pending[1].toInt() and 0xFF) {
                WILL, WONT, DO, DONT -> {
                    if (pending.size < 3) break@loop
                    negotiate(cmd, pending[2].toInt() and 0xFF)
                    pending = pending.copyOfRange(3, pending.size)
                }
                SB -> {
                    if (pending.size < 4) break@loop
                    val subType = pending[2].toInt() and 0xFF
                    val payload = ArrayList<Byte>(pending.size)
                    var i = 3
                    var complete = false
                    while (i < pending.size) {
                        if ((pending[i].toInt() and 0xFF) == IAC) {
                            if (i + 1 >= pending.size) break        // need the next byte
                            when (pending[i + 1].toInt() and 0xFF) {
                                IAC -> { payload.add(IAC.toByte()); i += 2 }
                                SE -> { complete = true; i += 2 }
                                // Invalid escape: drop the IAC, keep the byte.
                                else -> { payload.add(pending[i + 1]); i += 2 }
                            }
                            if (complete) break
                        } else {
                            payload.add(pending[i]); i++
                        }
                    }
                    if (!complete) break@loop                       // wait for the rest
                    if (subType == GMCP) handleGmcp(payload.toByteArray())
                    pending = pending.copyOfRange(i, pending.size)
                }
                else -> pending = pending.copyOfRange(2, pending.size)
            }
        }
    }

    private fun indexOfIac(b: ByteArray): Int {
        for (i in b.indices) if ((b[i].toInt() and 0xFF) == IAC) return i
        return -1
    }

    private fun negotiate(cmd: Int, opt: Int) {
        when {
            opt == GMCP && cmd == WILL -> {
                write(byteArrayOf(IAC.toByte(), DO.toByte(), GMCP.toByte()))
                startHandshake()
            }
            opt == GMCP && cmd == DO -> {
                write(byteArrayOf(IAC.toByte(), WILL.toByte(), GMCP.toByte()))
                startHandshake()
            }
            // The other side declining something we never asked for: nothing to do.
            cmd == WONT || cmd == DONT -> Unit
            // Refuse everything else, with the right verb for the offer.
            cmd == WILL -> write(byteArrayOf(IAC.toByte(), DONT.toByte(), opt.toByte()))
            cmd == DO -> write(byteArrayOf(IAC.toByte(), WONT.toByte(), opt.toByte()))
        }
    }

    private fun emitText(data: ByteArray) {
        val text = String(data, StandardCharsets.UTF_8)
        // Matches the relay: a chunk that is only whitespace is dropped rather
        // than forwarded. The client's line parsers assume this.
        if (text.isBlank()) return
        emit(msg("text", text))
    }

    // -------------------------------------------------------------------------
    // GMCP
    // -------------------------------------------------------------------------

    private fun gmcpPacket(body: String): ByteArray =
        byteArrayOf(IAC.toByte(), SB.toByte(), GMCP.toByte()) +
            body.toByteArray(StandardCharsets.UTF_8) +
            byteArrayOf(IAC.toByte(), SE.toByte())

    private fun startHandshake() {
        if (handshakeSent) return
        handshakeSent = true
        // Off the reader thread: the sequence sleeps between packets and the
        // reader must stay free to consume what the MUD sends back.
        Thread({
            try {
                write(gmcpPacket("""Core.Hello {"client":"AardClient","version":"1.0"}"""))
                Thread.sleep(100)
                // Same module list as the Aardwolf MUSHclient package.
                write(gmcpPacket("""Core.Supports.Set ["Room 1", "Char 1", "Comm 1", "Group 1", "Quest 1"]"""))
                Thread.sleep(200)
                requestGmcpState()
                emit(msg("system", "GMCP handshake sent"))
            } catch (_: InterruptedException) {
            }
        }, "aard-handshake").apply { isDaemon = true }.start()
    }

    /**
     * Ask the MUD to re-send full GMCP state.
     *
     * Aardwolf only pushes room.info on a room change, so a session that logs in
     * after the telnet handshake has no idea where it is until the player moves.
     * The client calls this once it sees a game prompt, and the service calls it
     * again whenever a WebView reattaches.
     */
    fun requestGmcpState() {
        if (!isRunning) return
        Thread({
            for (req in listOf("request char", "request room", "request area",
                               "request quest", "request group")) {
                write(gmcpPacket(req))
                try { Thread.sleep(50) } catch (_: InterruptedException) { return@Thread }
            }
        }, "aard-gmcp-req").apply { isDaemon = true }.start()
    }

    private fun handleGmcp(payload: ByteArray) {
        val raw = String(payload, StandardCharsets.UTF_8)
        val space = raw.indexOf(' ')
        val pkg: String
        var value: Any = JSONObject()
        if (space < 0) {
            pkg = raw
        } else {
            pkg = raw.substring(0, space)
            val body = ANSI.replace(raw.substring(space + 1), "").trim()
            value = try {
                // Aardwolf sends bare values for some packages (config "foo") and
                // JSON for others; only parse what looks structured, and fall back
                // to an empty object on malformed JSON exactly as the relay does.
                when {
                    body.isEmpty() -> JSONObject()
                    body[0] == '{' -> JSONObject(body)
                    body[0] == '[' -> JSONArray(body)
                    body[0] == '"' -> JSONTokener(body).nextValue()
                    else -> body
                }
            } catch (_: Exception) {
                JSONObject()
            }
        }
        emit(JSONObject().put("type", "gmcp").put("key", pkg).put("data", value))
    }

    private fun msg(type: String, text: String): JSONObject =
        JSONObject().put("type", type).put("text", text)
}
