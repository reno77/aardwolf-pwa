package win.bedok77.aardclient

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The telnet/GMCP frame parser is a hand-port of relay_minimal.py's read loop
 * and everything else in the app depends on it, so it gets tested directly
 * rather than trusted because it compiles.
 *
 * The cases that matter are the ones a naive parser gets wrong: TCP does not
 * respect message boundaries, so a GMCP subnegotiation routinely arrives split
 * across two reads, and a payload byte that happens to equal 255 is doubled on
 * the wire and has to be un-doubled.
 */
class TelnetSessionTest {

    private val IAC = 255.toByte()
    private val SB = 250.toByte()
    private val SE = 240.toByte()
    private val WILL = 251.toByte()
    private val GMCP = 201.toByte()

    /** Collects what the session would have sent to the page. */
    private class Sink {
        val messages = mutableListOf<JSONObject>()
        fun of(type: String) = messages.filter { it.optString("type") == type }
    }

    private fun sessionWith(sink: Sink) =
        TelnetSession(host = "unused", port = 0, emit = { sink.messages.add(it) }, onClosed = {})

    private fun gmcpFrame(body: String): ByteArray =
        byteArrayOf(IAC, SB, GMCP) + body.toByteArray(Charsets.UTF_8) + byteArrayOf(IAC, SE)

    @Test
    fun `plain text is forwarded`() {
        val sink = Sink()
        sessionWith(sink).feed("You are hungry.\n".toByteArray())

        val text = sink.of("text")
        assertEquals(1, text.size)
        assertEquals("You are hungry.\n", text[0].getString("text"))
    }

    @Test
    fun `whitespace-only chunks are dropped, matching the relay`() {
        val sink = Sink()
        sessionWith(sink).feed("   \r\n  ".toByteArray())
        assertEquals(0, sink.of("text").size)
    }

    @Test
    fun `gmcp subnegotiation is parsed into key and data`() {
        val sink = Sink()
        sessionWith(sink).feed(gmcpFrame("""room.info {"num":1234,"name":"The Grand Path","zone":"aylor"}"""))

        val gmcp = sink.of("gmcp")
        assertEquals(1, gmcp.size)
        assertEquals("room.info", gmcp[0].getString("key"))
        val data = gmcp[0].getJSONObject("data")
        assertEquals(1234, data.getInt("num"))
        assertEquals("The Grand Path", data.getString("name"))
        assertEquals("aylor", data.getString("zone"))
    }

    @Test
    fun `a subnegotiation split across two reads is not lost`() {
        val sink = Sink()
        val session = sessionWith(sink)
        val frame = gmcpFrame("""char.status {"state":8}""")

        // TCP gives no message boundaries: this is the normal case, not an edge
        // case. Splitting inside the JSON payload is the shape that breaks a
        // parser which assumes one read equals one frame.
        val cut = frame.size / 2
        session.feed(frame.copyOfRange(0, cut))
        assertEquals("nothing should be emitted from a half frame", 0, sink.of("gmcp").size)

        session.feed(frame.copyOfRange(cut, frame.size))
        val gmcp = sink.of("gmcp")
        assertEquals(1, gmcp.size)
        assertEquals("char.status", gmcp[0].getString("key"))
        assertEquals(8, gmcp[0].getJSONObject("data").getInt("state"))
    }

    @Test
    fun `text either side of a negotiation survives`() {
        val sink = Sink()
        // IAC WILL GMCP sits between two pieces of ordinary output.
        val stream = "before".toByteArray() +
            byteArrayOf(IAC, WILL, GMCP) +
            "after".toByteArray()
        sessionWith(sink).feed(stream)

        val text = sink.of("text").map { it.getString("text") }
        assertEquals(listOf("before", "after"), text)
    }

    @Test
    fun `a doubled IAC inside a payload is one literal byte`() {
        val sink = Sink()
        // 255 in the payload is escaped as IAC IAC on the wire. Failing to
        // un-double it corrupts the value; treating the second one as a command
        // truncates the frame.
        val body = "comm.channel ".toByteArray() + byteArrayOf(IAC, IAC)
        sessionWith(sink).feed(byteArrayOf(IAC, SB, GMCP) + body + byteArrayOf(IAC, SE))

        val gmcp = sink.of("gmcp")
        assertEquals(1, gmcp.size)
        assertEquals("comm.channel", gmcp[0].getString("key"))
    }

    @Test
    fun `a bare non-JSON gmcp value is kept as a string`() {
        val sink = Sink()
        sessionWith(sink).feed(gmcpFrame("char.name Bedokman"))

        val gmcp = sink.of("gmcp")
        assertEquals(1, gmcp.size)
        assertEquals("Bedokman", gmcp[0].getString("data"))
    }

    @Test
    fun `malformed gmcp json degrades to an empty object instead of throwing`() {
        val sink = Sink()
        sessionWith(sink).feed(gmcpFrame("""room.info {"num":"""))

        val gmcp = sink.of("gmcp")
        assertEquals(1, gmcp.size)
        assertEquals(0, gmcp[0].getJSONObject("data").length())
    }

    @Test
    fun `several frames in one read are all parsed`() {
        val sink = Sink()
        val stream = gmcpFrame("""room.info {"num":1}""") +
            "You see nothing special.\n".toByteArray() +
            gmcpFrame("""char.vitals {"hp":100}""")
        sessionWith(sink).feed(stream)

        assertEquals(2, sink.of("gmcp").size)
        assertEquals(1, sink.of("text").size)
        assertTrue(sink.of("text")[0].getString("text").contains("nothing special"))
    }
}
