#!/usr/bin/env python3
"""
Aardwolf Minimal Relay v14
- Dumb pipe: WebSocket <-> TCP (port 4000)
- No database, no state, no auto-login
- Forwards bytes + parses GMCP for client
"""
import asyncio, aiohttp, json, re
from aiohttp import web
from pathlib import Path

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
        self.ws_clients = set()
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

    def broadcast(self, msg):
        data = json.dumps(msg)
        dead = []
        for ws in list(self.ws_clients):
            try:
                asyncio.create_task(ws.send_str(data))
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.ws_clients.discard(ws)

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
        for req in [b'request char', b'request room', b'request area', b'request quest', b'request group']:
            self.writer.write(IAC + SB + GMCP + req + IAC + SE)
            await self.writer.drain()
            await asyncio.sleep(0.05)
        with open('/tmp/relay_iac.log','a') as f:
            f.write('HANDSHAKE SENT\n')
        self.broadcast({'type':'system','text':'GMCP handshake sent'})

    async def _mud_read_loop(self):
        buf = b''
        try:
            while self.mud_running and self.reader:
                chunk = await self.reader.read(4096)
                if not chunk:
                    break
                with open('/tmp/relay_raw.log','ab') as f:
                    f.write(b'RAW[' + str(len(chunk)).encode() + b'] ' + chunk + b'\n')
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
                        with open('/tmp/relay_iac.log','a') as f:
                            f.write(f'IAC recv cmd={cmd} opt={opt}\n')
                        if cmd == 251 and opt == 201:
                            # Server offers GMCP: accept it
                            self.writer.write(bytes([255, 253, 201]))
                            await self.writer.drain()
                            self.gmcp_negotiated = True
                            with open('/tmp/relay_iac.log','a') as f:
                                f.write(' -> sent DO GMCP\n')
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
                            with open('/tmp/relay_gmcp.log','ab') as f:
                                f.write(b'GMCP_RAW ' + bytes(payload) + b'\n')
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
                with open('/tmp/relay_gmcp_parse_err.log','a') as f:
                    f.write(f'Parse err: {e} pkg={pkg} payload={payload[:200]}\n')
                val = {}
        if pkg.startswith('char.'):
            self.char_seen = True
        if pkg == 'room.info':
            self.gmcp_needs_retry = False
        self.broadcast({'type': 'gmcp', 'key': pkg, 'data': val})

    async def ws_handler(self, request):
        ws = web.WebSocketResponse(heartbeat=25.0)
        await ws.prepare(request)
        self.ws_clients.add(ws)
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
                            await ws.send_str(json.dumps({'type':'system','text':'Connected to Aardwolf'}))
                            continue
                        ok = await self.ensure_mud()
                        await ws.send_str(json.dumps({'type':'system','text':'Connected to Aardwolf' if ok else 'Connection failed'}))
                        continue
                    elif action == 'ping':
                        await ws.send_str(json.dumps({'type': 'pong'}))
                    elif 'cmd' in d:
                        cmd = d['cmd']
                        if self.writer and self.mud_running:
                            self.writer.write((cmd + '\n').encode('utf-8'))
                            await self.writer.drain()
                            self.broadcast({'type': 'echo', 'text': cmd + '\n'})
        except Exception as e:
            print(f'WS error: {e}')
        finally:
            self.ws_clients.discard(ws)
        return ws

relay = MinimalRelay()

async def index(request):
    resp = web.FileResponse(str(PWA_DIR / 'index.html'))
    resp.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    resp.headers['Pragma'] = 'no-cache'
    return resp

app = web.Application()
app.router.add_get('/', index)
app.router.add_get('/ws', relay.ws_handler)
app.router.add_get('/gaardian_maps.db', lambda r: web.FileResponse(str(PWA_DIR / 'gaardian_maps.db')))
app.router.add_static('/static', str(PWA_DIR), name='static')

# Ensure static files are not cached either
async def no_cache_static(request):
    filepath = request.match_info['filename']
    full = str(PWA_DIR / filepath)
    resp = web.FileResponse(full)
    resp.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    resp.headers['Pragma'] = 'no-cache'
    return resp

app.router.add_get('/static/{filename:.*}', no_cache_static)
app.router.add_get('/gaardian_maps.db', no_cache_static)

if __name__ == '__main__':
    web.run_app(app, host='0.0.0.0', port=PORT, print=False)
