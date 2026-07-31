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
| `pwa/index.html` | The full single-page PWA client |
| `pwa/manifest.json` | PWA manifest |
| `pwa/gaardian_maps.db` | Pre-built SQLite map of Gaardian areas |
| `relay_minimal.py` | Minimal WebSocket <-> Telnet relay, no DB required |
| `relay_server.py` | Relay with SQLite room-mapping persistence |
| `aardmap.db` | Empty starter DB for `relay_server.py` |
| `HANDOVER.md` | Notes for the next developer |

## Security note

No passwords or API secrets are committed. The PWA stores credentials in the browser's `localStorage` only after the user types them. The relay never auto-logs in.

## Architecture

```
Phone browser  ←──WebSocket──→  Relay  ←──Telnet──→  aardwolf.org:4000
                     ↑
                HTTP (PWA files + gaardian_maps.db)
```
