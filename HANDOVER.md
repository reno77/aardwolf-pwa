# Handover Notes for the Next Coding Agent

This document is written for another autonomous agent or developer taking over the project.

## 1. Project identity

- **MUD:** Aardwolf (`aardwolf.org:4000`). Port 23 is for character creation only. Always use port 4000 for live play.
- **Primary user character:** `bedokman` (this is not a secret; it is the public in-game name).
- **Live deployment:** `mud.bedok77.win` via Cloudflare tunnel `hermes-wsl-winbox`.
- **Relay:** `python3 relay_minimal.py` on port 8765.

## 2. What the PWA does

`pwa/index.html` is a single-file client containing:

- WebSocket connection to `/ws` on the relay.
- ANSI output rendering.
- GMCP parsing (`room.info`, `char.vitals`, `char.status`, `comm.quest`).
- SQLite map database loaded into sql.js (`/gaardian_maps.db`).
- Canvas-based area map with colored cells, 2-letter room abbreviations, pan/zoom/tap.
- Tap-to-walk: tap a room + tap **Go** sends `runto <area>`.
- Virtual joysticks (right = N/S/E/W/NW/NE/SW/SE, left = Up/Down) with haptic feedback.
- Alias + trigger editor panels.
- S&D campaign helper buttons (`xcp`, `crr`).
- Auto-login uses credentials typed by the user; the source does **not** contain a password.

## 3. Backend options

### `relay_minimal.py` (recommended for PWA)
- Dumb pipe: WebSocket <-> Telnet.
- Serves `pwa/index.html` and `/gaardian_maps.db`.
- No database, no state, no auto-login.
- Serves no-cache headers to avoid stale PWA issues.
- Reuses the MUD TCP session when WebSocket reconnects.

### `relay_server.py` (legacy mapping relay)
- Also serves the PWA.
- Has SQLite `aardmap.db` for room discovery / mapping.
- Same no-cache static serving.
- Use this if you want server-side map persistence.

## 4. Common pitfalls

| Issue | Cause / Fix |
|-------|---------------|
| PWA shows old version | Relay sends no-cache headers; user must hard-refresh or use incognito. |
| Phone cannot connect | PC and phone must be on same network, or use Cloudflare tunnel. |
| WebSocket drops repeatedly | Relay reuses MUD TCP session; verify `aardwolf.org:4000` reachable. |
| Map not loading | Check browser devtools Network tab for `/gaardian_maps.db`. |
| Tap-to-walk goes wrong area | Map DB area names must match Aardwolf `runto` keywords. |
| Auto-login not working | User must enter name/password; source no longer ships with credentials. |
| Character creation accidentally | Relay connects to port 4000; never port 23. |

## 5. User preferences to preserve

- Map style: compact Fado-like colored cells, rows almost touching, 2-letter abbreviations, full name on tap.
- S&D recall alias is an equipment-swap sequence (`wear garbage;enter;rem garbage;wear wpn;wear wpn 2`), not a simple `rec` command.
- Runto keywords should be short first-word partials (e.g. `rt hedge`).
- Skip recall when already in target area.
- Auto-login should not ship with hardcoded password.

## 6. Cloudflare tunnel

If the tunnel is down:
```bash
pkill -f cloudflared
cloudflared tunnel run hermes-wsl-winbox
```

## 7. Testing checklist

Before declaring a change done:
- [ ] Relay starts with `python3 relay_minimal.py` without errors.
- [ ] Phone/browser loads `http://YOUR_PC_IP:8765` and shows login prompt.
- [ ] WebSocket connects (`connected` indicator).
- [ ] Manual login succeeds.
- [ ] Map loads and shows the current area.
- [ ] Tap a room + Go sends correct `runto`.
- [ ] Joysticks send movement commands.
- [ ] Alias/trigger panels open and save to IndexedDB/sql.js.

## 8. Files that matter

- `pwa/index.html` — almost all client logic is here.
- `pwa/gaardian_maps.db` — map data used by sql.js.
- `relay_minimal.py` — current relay of record.
- `relay_server.py` — alternative relay with DB mapping.

## 9. Things NOT in this repo

- No API keys.
- No passwords.
- No Cloudflare credentials.
- No trading bot code (that lives elsewhere).

## 10. Next likely tasks

Based on user history, likely next features:
- Full Gaardian map: labeled boxes with names, tight vertical spacing, N/S/E/W edge lines, U/D corner stubs, drag pan, pinch zoom.
- Tap a room + **Go** walks there (same level only).
- Auto-login with saved credentials stored only in browser localStorage.
- Fado trigger/alias sync.
- SND campaign helper (`xcp`, `crr`).
- UTF-8 maps matching Fado style.
- Persistent state across reconnects.
