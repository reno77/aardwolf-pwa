# Aardwolf PWA Client + Relay

A mobile-first Progressive Web App for playing [Aardwolf MUD](https://www.aardwolf.com), with a WebSocket relay that bridges the phone to the MUD server over Telnet.

## Quick start

1. Install Python dependencies:
```bash
pip install aiohttp
```

2. Start the relay:
```bash
python3 relay_minimal.py
```
or, if you want room mapping persistence:
```bash
python3 relay_server.py
```

3. Open a browser on your phone to `http://YOUR_PC_IP:8765`.

4. Enter your Aardwolf character name and password manually. Auto-login credentials are **not** included in the published source.

## What's in this repo

| Path | Description |
|------|-------------|
| `pwa/index.html` | Markup and CSS; loads the client as an ES module |
| `pwa/js/` | The client, split by concern — see `HANDOVER.md` §2 |
| `pwa/manifest.json` | PWA manifest |
| `pwa/gaardian_maps.db` | Pre-built SQLite map of Gaardian areas |
| `relay_minimal.py` | Minimal WebSocket <-> Telnet relay, no DB required |
| `relay_server.py` | Relay with SQLite room-mapping persistence |
| `aardmap.db` | Empty starter DB for `relay_server.py` |
| `HANDOVER.md` | Notes for the next developer |

## Commands

Typed into the input box:

| Command | Does |
|---|---|
| `/runto <room>` | Walk to a known room, one confirmed step at a time |
| `/areas` | Learn the real area keywords from the game |
| `dinv build` / `dinv search <q>` | Inventory manager (see `HANDOVER.md` §6) |
| `/map`, `/rooms`, `/aliases`, `/triggers` | Open panels |
| `/xcp` | Campaign helper — **read `HANDOVER.md` §0 first** |

## Security note

No passwords or API secrets are committed. The PWA stores credentials in the browser's `localStorage` only after the user types them. The relay never auto-logs in.

## Botting note

Aardwolf's `help policies7` prohibits scripts that read campaign or quest
information and then automatically travel to, find and kill the target, and
states there is no legal scenario for a trigger that kills a mob. The campaign
helper (`/xcp`) implements that pattern. Navigation assistance is fine; the
unattended kill loop is not. See `HANDOVER.md` §0 before enabling it.

## Architecture

```
Phone browser  ←──WebSocket──→  Relay  ←──Telnet──→  aardwolf.org:4000
                     ↑
                HTTP (PWA files + gaardian_maps.db)
```
