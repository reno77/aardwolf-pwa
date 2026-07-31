#!/usr/bin/env python3
"""
Aardwolf Relay Server v12
- One MUD connection shared by all WebSocket clients
- Auto-reconnect to MUD on disconnect
- Per-client command handling
- No auto-login on server (client sends credentials)
"""
import asyncio, aiohttp, json, re, sqlite3
from aiohttp import web
from datetime import datetime
from pathlib import Path

MUD_HOST, MUD_PORT = "aardwolf.org", 4000
PORT = 8765

IAC = bytes([255])
SB = bytes([250])
SE = bytes([240])
GMCP = bytes([201])

BASE_DIR = Path(__file__).parent.resolve()
DB_PATH = BASE_DIR / "aardmap.db"
PWA_DIR = BASE_DIR / "pwa"

class MudRelay:
    def __init__(self):
        self.reader = None
        self.writer = None
        self.mud_running = False
        self.ws_clients = set()
        self.mud_lock = asyncio.Lock()
        self._init_db()

    def _init_db(self):
        conn = sqlite3.connect(str(DB_PATH))
        c = conn.cursor()
        c.executescript('''
            CREATE TABLE IF NOT EXISTS rooms(uid TEXT PRIMARY KEY, area TEXT, name TEXT, terrain TEXT,
                x INTEGER, y INTEGER, z INTEGER, exits TEXT, first_seen TEXT, last_visited TEXT);
            CREATE TABLE IF NOT EXISTS exits(id INTEGER PRIMARY KEY, from_uid TEXT, direction TEXT, to_uid TEXT);
            CREATE INDEX IF NOT EXISTS idx_exits_from ON exits(from_uid);
        ''')
        conn.commit()
        conn.close()

    async def ensure_mud(self):
        async with self.mud_lock:
            if self.mud_running and self.writer:
                return True
            try:
                self.reader, self.writer = await asyncio.wait_for(
                    asyncio.open_connection(MUD_HOST, MUD_PORT), timeout=10
                )
                self.mud_running = True
                asyncio.create_task(self._mud_reader())
                await self._setup_telnet()
                print("[MUD] Connected")
                self.broadcast({'type': 'system', 'text': 'Connected to Aardwolf'})
                return True
            except Exception as e:
                print(f"[MUD FAIL] {e}")
                self.broadcast({'type': 'error', 'text': f'Failed to connect to Aardwolf: {e}'})
                return False

    async def _setup_telnet(self):
        await asyncio.sleep(0.5)
        self.writer.write(bytes([255, 251, 1]))
        self.writer.write(bytes([255, 253, 3]))
        self.writer.write(bytes([255, 251, 31]))
        self.writer.write(bytes([255, 250, 31, 0, 80, 0, 24, 255, 240]))
        self.writer.write(bytes([255, 251, 201]))
        await asyncio.sleep(1)
        gmcp = bytes([255, 250, 201]) + b'Core.Hello {"client":"AardWeb","version":"1.0"}' + bytes([255, 240])
        self.writer.write(gmcp)
        gmcp2 = bytes([255, 250, 201]) + b'Core.Supports.Set ["Char 1","Char.Vitals 1","Room 1","Room.Info 1"]' + bytes([255, 240])
        self.writer.write(gmcp2)

    def disconnect_mud(self):
        self.mud_running = False
        if self.writer:
            try: self.writer.close()
            except: pass
        self.reader = None
        self.writer = None
        print("[MUD] Disconnected by request")
        self.broadcast({'type': 'system', 'text': 'Disconnected from Aardwolf'})

    def send(self, text):
        if self.writer and self.mud_running:
            self.writer.write((text + "\n").encode())
            return True
        return False

    def broadcast(self, msg):
        payload = json.dumps(msg)
        dead = set()
        for ws in list(self.ws_clients):
            try:
                asyncio.create_task(ws.send_str(payload))
            except Exception:
                dead.add(ws)
        for ws in dead:
            self.ws_clients.discard(ws)

    async def _mud_reader(self):
        buf = b""
        while self.mud_running:
            try:
                chunk = await asyncio.wait_for(self.reader.read(4096), timeout=1.0)
                if not chunk:
                    print("[MUD] Connection closed by server")
                    break
                buf += chunk
                buf = self._process(buf)
            except asyncio.TimeoutError:
                continue
            except Exception as e:
                print(f"[MUD ERR] {e}")
                break

        self.mud_running = False
        self.reader = None
        self.writer = None
        self.broadcast({'type': 'system', 'text': 'Disconnected from Aardwolf'})
        print("[MUD] Reader ended")
        # Auto-reconnect after 3 seconds if clients are still connected
        if self.ws_clients:
            await asyncio.sleep(3)
            asyncio.create_task(self.ensure_mud())

    def _process(self, buf):
        while buf:
            gmcp_start = buf.find(bytes([255, 250, 201]))
            if gmcp_start != -1:
                gmcp_end = buf.find(bytes([255, 240]), gmcp_start + 3)
                if gmcp_end != -1:
                    if gmcp_start > 0:
                        self._handle_text(buf[:gmcp_start])
                    payload = buf[gmcp_start+3:gmcp_end].decode('utf-8', errors='replace')
                    self._handle_gmcp(payload)
                    buf = buf[gmcp_end+2:]
                    continue
                else:
                    break

            iac_pos = buf.find(bytes([255]))
            if iac_pos == -1:
                self._handle_text(buf)
                buf = b""
            else:
                if iac_pos > 0:
                    self._handle_text(buf[:iac_pos])
                if len(buf) < iac_pos + 2:
                    break
                cmd = buf[iac_pos + 1]
                if cmd in (251, 252, 253, 254):
                    if len(buf) < iac_pos + 3:
                        break
                    opt = buf[iac_pos + 2]
                    if cmd == 253 and opt in (201, 3, 1, 31, 24):
                        self.writer.write(bytes([255, 251, opt]))
                        if opt == 31:
                            self.writer.write(bytes([255, 250, 31, 0, 80, 0, 24, 255, 240]))
                    else:
                        self.writer.write(bytes([255, 252 if cmd == 253 else 254, opt]))
                    buf = buf[iac_pos + 3:]
                elif cmd == 250:
                    end = buf.find(bytes([255, 240]), iac_pos + 2)
                    if end == -1:
                        break
                    buf = buf[:iac_pos] + buf[end + 2:]
                else:
                    buf = buf[iac_pos + 2:]
        return buf

    def _handle_text(self, data):
        text = data.decode('utf-8', errors='replace')
        if text.strip():
            quest = self._parse_quest(text)
            if quest:
                self.broadcast({'type': 'quest', 'data': quest})
            self.broadcast({'type': 'text', 'text': text})

    def _parse_quest(self, text):
        for p in [r'You have been tasked to kill\s+(.+?)\s+in\s+the\s+area of\s+(.+?)\.',
                  r'Go kill\s+(.+?)\s+in\s+the\s+area of\s+(.+?)\.',
                  r'Find and kill\s+(.+?)\s+near\s+(.+?)\.']:
            m = re.search(p, text, re.IGNORECASE)
            if m:
                return {'mob': m.group(1).strip(), 'area': m.group(2).strip()}
        return None

    def _handle_gmcp(self, data):
        space = data.find(' ')
        if space == -1:
            mod, payload = data, "{}"
        else:
            mod, payload = data[:space], data[space+1:]
        try:
            obj = json.loads(payload)
        except:
            obj = {}
        if mod == "Room.Info":
            self._save_room(obj)
            self.broadcast({'type': 'room', 'data': obj})
        elif mod == "Char.Vitals":
            self.broadcast({'type': 'vitals', 'data': obj})
        elif mod == "Char.Status":
            self.broadcast({'type': 'status', 'data': obj})

    def _save_room(self, room):
        uid = room.get('id')
        if not uid or uid == '0':
            return
        conn = sqlite3.connect(str(DB_PATH))
        c = conn.cursor()
        now = datetime.now().isoformat()
        # Aardwolf GMCP coord is not reliable; compute relative coords from exits.
        x = y = z = 0
        try:
            c.execute("SELECT x,y,z FROM rooms WHERE uid=?", (uid,))
            row = c.fetchone()
            if row:
                x, y, z = row[0] or 0, row[1] or 0, row[2] or 0
            else:
                exits = room.get('exits', {})
                for d, t in exits.items():
                    if not t or t == '0':
                        continue
                    c.execute("SELECT x,y,z FROM rooms WHERE uid=?", (t,))
                    n = c.fetchone()
                    if n:
                        nx, ny, nz = n[0] or 0, n[1] or 0, n[2] or 0
                        if d == 'n': x, y, z = nx, ny - 1, nz
                        elif d == 's': x, y, z = nx, ny + 1, nz
                        elif d == 'e': x, y, z = nx - 1, ny, nz
                        elif d == 'w': x, y, z = nx + 1, ny, nz
                        elif d == 'u': x, y, z = nx, ny, nz - 1
                        elif d == 'd': x, y, z = nx, ny, nz + 1
                        break
        except Exception as e:
            print(f"[DB coord error] {e}")
        c.execute('''INSERT OR REPLACE INTO rooms
            (uid, area, name, terrain, x, y, z, exits, first_seen, last_visited)
            VALUES (?,?,?,?,?,?,?,?,COALESCE((SELECT first_seen FROM rooms WHERE uid=?),?),?)''',
            (uid, room.get('area','Unknown'), room.get('name','Unknown'), room.get('terrain',''),
             x, y, z, json.dumps(exits), uid, now, now))
        for d, t in exits.items():
            if t and t != '0':
                c.execute('INSERT OR IGNORE INTO exits (from_uid, direction, to_uid) VALUES (?,?,?)',
                          (uid, d, t))
        conn.commit()
        conn.close()


relay = MudRelay()

async def ws_handler(request):
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    relay.ws_clients.add(ws)
    print(f"[WS] Client connected ({len(relay.ws_clients)} total)")

    # Send initial status
    if relay.mud_running:
        await ws.send_str(json.dumps({'type': 'system', 'text': 'Already connected to Aardwolf'}))
    else:
        await ws.send_str(json.dumps({'type': 'system', 'text': 'Click Connect to join Aardwolf'}))

    try:
        async for msg in ws:
            if msg.type == aiohttp.WSMsgType.TEXT:
                data = json.loads(msg.data)
                action = data.get('action')
                if action == 'connect':
                    # Force fresh connection - disconnect old one first
                    if relay.mud_running:
                        relay.disconnect_mud()
                        await asyncio.sleep(1)
                    ok = await relay.ensure_mud()
                    if ok:
                        await ws.send_str(json.dumps({'type': 'system', 'text': 'Connected'}))
                    else:
                        await ws.send_str(json.dumps({'type': 'error', 'text': 'Connect failed'}))
                elif action == 'disconnect':
                    relay.disconnect_mud()
                elif action == 'ping':
                    await ws.send_str(json.dumps({'type': 'pong'}))
                elif 'cmd' in data:
                    relay.send(data['cmd'])
                    await ws.send_str(json.dumps({'type': 'echo', 'text': '> ' + data['cmd']}))
                elif 'runto' in data:
                    relay.send(f"runto {data['runto']}")
                elif 'direction' in data:
                    relay.send(data['direction'])
    except Exception as e:
        print(f"[WS ERR] {e}")
    finally:
        relay.ws_clients.discard(ws)
        print(f"[WS] Client left ({len(relay.ws_clients)} remaining)")
        # Keep MUD alive for other clients, or auto-disconnect after 30s if no clients
        if not relay.ws_clients:
            await asyncio.sleep(30)
            if not relay.ws_clients and relay.mud_running:
                relay.disconnect_mud()
    return ws

async def index_handler(request):
    file_path = PWA_DIR / 'index.html'
    if file_path.exists():
        return web.FileResponse(file_path)
    return web.Response(text="PWA not found", status=404)

async def static_handler(request):
    path = request.match_info.get('path', '')
    file_path = PWA_DIR / path
    if file_path.exists() and file_path.is_file():
        return web.FileResponse(file_path)
    return web.Response(text="Not found", status=404)

async def main():
    app = web.Application()
    app.router.add_get('/ws', ws_handler)
    app.router.add_get('/', index_handler)
    app.router.add_get('/{path:.*}', static_handler)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", PORT)
    await site.start()

    print(f"[SERVER] HTTP + WS on port {PORT}")
    print(f"\n{'='*55}")
    print(f"Local:    http://localhost:{PORT}")
    print(f"Network:  http://10.92.173.144:{PORT}")
    print(f"{'='*55}")
    print("\nStart Cloudflare tunnel:")
    print(f"  cloudflared tunnel --url http://localhost:{PORT}")
    print(f"{'='*55}")

    await asyncio.Future()

if __name__ == "__main__":
    asyncio.run(main())
