#!/usr/bin/env python3
"""
Aardwolf Minimal Relay v14
- Dumb pipe: WebSocket <-> TCP (port 4000)
- No database, no state, no auto-login
- Forwards bytes + parses GMCP for client
"""
import asyncio, aiohttp, json, re
import socket
from aiohttp import web
from pathlib import Path
import os

# Debug logging is opt-in. These used to be unconditional writes to hard-coded
# /tmp paths, which raise FileNotFoundError on Windows -- and one of them sat
# inside the MUD read loop, so the connection died the moment the first byte
# arrived. Set RELAY_DEBUG_DIR=<dir> to turn logging back on.
DEBUG_DIR = os.environ.get('RELAY_DEBUG_DIR')


def dbglog(name, data):
    if not DEBUG_DIR:
        return
    try:
        os.makedirs(DEBUG_DIR, exist_ok=True)
        mode = 'ab' if isinstance(data, (bytes, bytearray)) else 'a'
        with open(os.path.join(DEBUG_DIR, name), mode) as f:
            f.write(data)
    except Exception:
        pass   # debug logging must never break the relay

MUD_HOST, MUD_PORT = "aardwolf.org", 4000
PORT = 8765
PWA_DIR = Path(__file__).parent / "pwa"

IAC = bytes([255])
SB = bytes([250])
SE = bytes([240])
GMCP = bytes([201])

class MinimalRelay:
    def __init__(self):
        self.reader = None
        self.writer = None
        self.mud_running = False
        self.ws_clients = {}      # ws -> outbound asyncio.Queue
        self._writers = {}       # ws -> writer task
        self.mud_lock = asyncio.Lock()
        self.gmcp_negotiated = False
        self.handshake_sent = False
        self.char_seen = False

    async def ensure_mud(self):
        async with self.mud_lock:
            if self.mud_running and self.writer:
                return True
            try:
                self.reader, self.writer = await asyncio.wait_for(
                    asyncio.open_connection(MUD_HOST, MUD_PORT), timeout=10
                )
                # Disable Nagle. A MUD sends tiny writes (a movement command is
                # two bytes) and Nagle will sit on them waiting for more data or
                # for the previous ACK, adding tens of milliseconds to every
                # keystroke on an already ~300ms round trip.
                try:
                    sock = self.writer.get_extra_info('socket')
                    if sock is not None:
                        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                except Exception:
                    pass
                self.mud_running = True
                self.gmcp_negotiated = False
                self.handshake_sent = False
                self.char_seen = False
                asyncio.create_task(self._mud_read_loop())
                asyncio.create_task(self._mud_keepalive_loop())
                return True
            except Exception as e:
                self.broadcast({'type': 'error', 'text': f'Failed to connect to MUD: {e}'})
                return False

    async def _mud_keepalive_loop(self):
        # Send Telnet NOP every 30s to keep Aardwolf TCP alive
        try:
            while self.mud_running and self.writer:
                await asyncio.sleep(30)
                if self.mud_running and self.writer:
                    try:
                        self.writer.write(bytes([255, 241]))  # IAC NOP
                        await self.writer.drain()
                    except Exception:
                        break
        except asyncio.CancelledError:
            pass
        except Exception:
            pass

    async def disconnect_mud(self):
        async with self.mud_lock:
            self.mud_running = False
            if self.writer:
                self.writer.close()
                try:
                    await self.writer.wait_closed()
                except:
                    pass
                self.writer = None
            self.reader = None

    # Outbound queue depth per client. Enough to ride out a brief stall; a client
    # further behind than this is not keeping up and gets dropped rather than
    # allowed to hold the session back.
    SEND_QUEUE_MAX = 500

    def broadcast(self, msg):
        """Queue a message for every client, in order.

        This used to be `asyncio.create_task(ws.send_str(data))` per client per
        message: unbounded, unordered, and with no way to notice a client that
        had gone away. Each MUD chunk spawned a task, they completed in whatever
        order the loop got to them, and sockets that were never cleanly closed
        stayed in the set forever -- so output arrived later and later, and
        eventually out of order. One queue and one writer task per client keeps
        delivery ordered and lets a dead client be dropped.
        """
        data = json.dumps(msg)
        for ws, q in list(self.ws_clients.items()):
            try:
                q.put_nowait(data)
            except asyncio.QueueFull:
                self._drop_client(ws)

    def _drop_client(self, ws):
        entry = self.ws_clients.pop(ws, None)
        if entry is not None:
            task = self._writers.pop(ws, None)
            if task is not None:
                task.cancel()

    async def _client_writer(self, ws, q):
        """Drain one client's queue in order, and stop the moment it fails."""
        try:
            while True:
                data = await q.get()
                if ws.closed:
                    break
                await ws.send_str(data)
        except asyncio.CancelledError:
            pass
        except Exception:
            pass
        finally:
            self.ws_clients.pop(ws, None)
            self._writers.pop(ws, None)

    async def _send_handshake(self):
        if not self.writer or self.handshake_sent:
            return
        self.handshake_sent = True
        # Aardwolf GMCP spec: Core.Hello identifies client; Core.Supports.Set enables modules.
        hello = IAC + SB + GMCP + b'Core.Hello {"client":"AardClient","version":"1.0"}' + IAC + SE
        # Match the Aardwolf MUSHclient package module list: Char + Comm + Room + Group + Quest
        supports = IAC + SB + GMCP + b'Core.Supports.Set ["Room 1", "Char 1", "Comm 1", "Group 1", "Quest 1"]' + IAC + SE
        self.writer.write(hello)
        await self.writer.drain()
        await asyncio.sleep(0.1)
        self.writer.write(supports)
        await self.writer.drain()
        await asyncio.sleep(0.2)
        # After enabling modules, request full state (same sequence as MUSHclient package)
        await self.request_gmcp_state()
        dbglog('relay_iac.log', 'HANDSHAKE SENT\n')
        self.broadcast({'type':'system','text':'GMCP handshake sent'})

    async def request_gmcp_state(self):
        """Ask the MUD to re-send the full GMCP state.

        Aardwolf only pushes room.info on a room change, so a client that logs
        in after the TCP handshake has no idea where it is until it moves. The
        client calls this once it is actually in the game.
        """
        if not self.writer or not self.mud_running:
            return
        for req in [b'request char', b'request room', b'request area',
                    b'request quest', b'request group']:
            self.writer.write(IAC + SB + GMCP + req + IAC + SE)
            await self.writer.drain()
            await asyncio.sleep(0.05)

    async def _mud_read_loop(self):
        buf = b''
        try:
            while self.mud_running and self.reader:
                chunk = await self.reader.read(4096)
                if not chunk:
                    break
                dbglog('relay_raw.log', b'RAW[' + str(len(chunk)).encode() + b'] ' + chunk + b'\n')
                buf += chunk
                while True:
                    iac_pos = buf.find(IAC)
                    if iac_pos == -1:
                        if buf:
                            self._handle_text(buf)
                            buf = b''
                        break
                    if iac_pos > 0:
                        self._handle_text(buf[:iac_pos])
                        buf = buf[iac_pos:]
                    if len(buf) < 2:
                        break
                    cmd = buf[1]
                    if cmd in (251, 252, 253, 254):  # WILL/WONT/DO/DONT
                        if len(buf) < 3:
                            break
                        opt = buf[2]
                        dbglog('relay_iac.log', f'IAC recv cmd={cmd} opt={opt}\n')
                        if cmd == 251 and opt == 201:
                            # Server offers GMCP: accept it
                            self.writer.write(bytes([255, 253, 201]))
                            await self.writer.drain()
                            self.gmcp_negotiated = True
                            dbglog('relay_iac.log', ' -> sent DO GMCP\n')
                            asyncio.create_task(self._send_handshake())
                        elif cmd == 253 and opt == 201:
                            # Server asks us to enable GMCP: confirm with DO
                            self.writer.write(bytes([255, 253, 201]))
                            await self.writer.drain()
                            self.gmcp_negotiated = True
                            asyncio.create_task(self._send_handshake())
                        elif cmd == 254 and opt == 201:
                            pass  # ignore DONT GMCP
                        elif cmd == 252 and opt == 201:
                            pass  # ignore WONT GMCP
                        elif opt == 102:
                            self.writer.write(bytes([255, 252, 102]))
                            await self.writer.drain()
                        else:
                            # Refuse everything else
                            self.writer.write(bytes([255, 252, opt]))
                            await self.writer.drain()
                        buf = buf[3:]
                    elif cmd == 250:  # SB
                        # Robust subnegotiation parser: handles IAC IAC escapes inside payload.
                        if len(buf) < 4:
                            break
                        sub_type = buf[2]
                        payload = bytearray()
                        i = 3
                        complete = False
                        while i < len(buf):
                            if buf[i] == 255:
                                if i + 1 >= len(buf):
                                    break  # need next byte
                                nxt = buf[i + 1]
                                if nxt == 255:
                                    payload.append(255)
                                    i += 2
                                elif nxt == 240:
                                    complete = True
                                    i += 2
                                    break
                                else:
                                    # invalid escape, skip IAC and treat next byte as data
                                    payload.append(nxt)
                                    i += 2
                            else:
                                payload.append(buf[i])
                                i += 1
                        if not complete:
                            break
                        if sub_type == 201:
                            dbglog('relay_gmcp.log', b'GMCP_RAW ' + bytes(payload) + b'\n')
                            self._handle_gmcp(bytes(payload))
                        buf = buf[i:]
                    elif cmd in (241, 242, 243, 244, 245, 246, 247, 248, 249, 250, 251, 252, 253, 254, 255):
                        buf = buf[2:]
                    else:
                        buf = buf[2:]
        except asyncio.CancelledError:
            pass
        except Exception as e:
            self.broadcast({'type': 'error', 'text': f'MUD read error: {e}'})
        finally:
            self.mud_running = False
            self.broadcast({'type': 'system', 'text': 'Disconnected from MUD'})

    def _handle_text(self, data):
        text = data.decode('utf-8', errors='replace')
        if text.strip():
            self.broadcast({'type': 'text', 'text': text})

    def _handle_gmcp(self, data):
        space = data.find(b' ')
        if space == -1:
            pkg = data.decode('utf-8', errors='replace')
            val = {}
        else:
            pkg = data[:space].decode('utf-8', errors='replace')
            payload = data[space+1:]
            try:
                text = payload.decode('utf-8', errors='replace')
                # Strip ANSI escape sequences that Aardwolf may embed in GMCP values
                text = re.sub(r'\x1b\[[0-9;]*m', '', text)
                # Aardwolf GMCP messages sometimes send bare values (e.g. config "foo")
                # and sometimes JSON objects/arrays; only attempt JSON parse if it looks structured.
                stripped = text.strip()
                if stripped and (stripped[0] in b'[{{"' if isinstance(stripped, bytes) else stripped[0] in '[{"'):
                    val = json.loads(text)
                else:
                    val = stripped
            except Exception as e:
                dbglog('relay_gmcp_parse_err.log', f'Parse err: {e} pkg={pkg} payload={payload[:200]}\n')
                val = {}
        if pkg.startswith('char.'):
            self.char_seen = True
        if pkg == 'room.info':
            self.gmcp_needs_retry = False
        self.broadcast({'type': 'gmcp', 'key': pkg, 'data': val})

    async def ws_handler(self, request):
        ws = web.WebSocketResponse(heartbeat=25.0)
        await ws.prepare(request)
        q = asyncio.Queue(maxsize=self.SEND_QUEUE_MAX)
        self.ws_clients[ws] = q
        self._writers[ws] = asyncio.create_task(self._client_writer(ws, q))
        try:
            async for msg in ws:
                if msg.type == aiohttp.WSMsgType.TEXT:
                    try:
                        d = json.loads(msg.data)
                    except:
                        continue
                    action = d.get('action', d.get('cmd', ''))
                    if action == 'connect':
                        # If MUD already connected, just reuse it; don't churn the session
                        if self.mud_running and self.writer:
                            await ws.send_str(json.dumps({'type':'system','text':'Reattached to the existing Aardwolf session'}))
                            # A reattaching client has missed everything sent so
                            # far and the MUD will not redraw on its own, so the
                            # screen just sits empty and looks broken. Ask for
                            # the GMCP state and nudge out a prompt so the client
                            # immediately knows where it is.
                            await self.request_gmcp_state()
                            try:
                                self.writer.write(b'\n')
                                await self.writer.drain()
                            except Exception:
                                pass
                            continue
                        ok = await self.ensure_mud()
                        await ws.send_str(json.dumps({'type':'system','text':'Connected to Aardwolf' if ok else 'Connection failed'}))
                        continue
                    elif action == 'ping':
                        await ws.send_str(json.dumps({'type': 'pong'}))
                    elif action == 'gmcp_request':
                        # The handshake requests full GMCP state when the TCP
                        # session opens, which is before the player has logged
                        # in -- so no room.info ever arrives for a session that
                        # logs in afterwards. The client asks again once it is
                        # actually in the game.
                        await self.request_gmcp_state()
                    elif 'cmd' in d:
                        cmd = d['cmd']
                        if self.writer and self.mud_running:
                            self.writer.write((cmd + '\n').encode('utf-8'))
                            await self.writer.drain()
                            self.broadcast({'type': 'echo', 'text': cmd + '\n'})
        except Exception as e:
            print(f'WS error: {e}')
        finally:
            self._drop_client(ws)
        return ws

relay = MinimalRelay()

# Browsers refuse an ES module served as anything but a JavaScript MIME type,
# and Python's mimetypes reads the Windows registry, where .js is often
# text/plain. Pin the types we care about rather than trusting the lookup.
CONTENT_TYPES = {
    '.js':   'application/javascript; charset=utf-8',
    '.mjs':  'application/javascript; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.db':   'application/octet-stream',
}

def serve(relpath):
    """FileResponse for PWA_DIR/relpath, no-cache, correct Content-Type."""
    full = (PWA_DIR / relpath).resolve()
    # Refuse anything that escapes PWA_DIR.
    if not full.is_file() or PWA_DIR.resolve() not in full.parents:
        return web.Response(text='Not found', status=404)
    resp = web.FileResponse(full)
    ctype = CONTENT_TYPES.get(full.suffix.lower())
    if ctype:
        resp.headers['Content-Type'] = ctype
    resp.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    resp.headers['Pragma'] = 'no-cache'
    return resp

async def index(request):
    return serve('index.html')

async def static_file(request):
    return serve(request.match_info['filename'])

async def gaardian_db(request):
    return serve('gaardian_maps.db')

app = web.Application()
app.router.add_get('/', index)
app.router.add_get('/ws', relay.ws_handler)
app.router.add_get('/gaardian_maps.db', gaardian_db)
app.router.add_get('/static/{filename:.*}', static_file)

if __name__ == '__main__':
    web.run_app(app, host='0.0.0.0', port=PORT, print=False)
