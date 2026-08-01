#!/usr/bin/env python3
"""Forward WSL's 127.0.0.1:<port> to the Windows host's <port>.

Why this exists
---------------
The Cloudflare tunnel (`cloudflared`) runs inside WSL and its ingress points at
`http://localhost:8765`. WSL2 forwards Windows -> WSL on localhost, but not the
other direction, so when the relay runs on Windows instead of inside WSL the
tunnel gets a 502.

Run this inside WSL and cloudflared's existing config keeps working:

    python3 wsl_to_windows_bridge.py            # 127.0.0.1:8765 -> <win host>:8765
    python3 wsl_to_windows_bridge.py 8765 8765

It is a plain TCP relay, so WebSocket upgrades pass through untouched.

The Windows host address is the WSL default gateway, which can change across
reboots, so it is resolved at startup rather than hard-coded.
"""
import asyncio
import subprocess
import sys


def windows_host() -> str:
    """WSL's default gateway is the Windows host."""
    out = subprocess.run(['ip', 'route'], capture_output=True, text=True).stdout
    for line in out.splitlines():
        parts = line.split()
        if parts[:1] == ['default'] and 'via' in parts:
            return parts[parts.index('via') + 1]
    raise SystemExit('could not determine the Windows host address from `ip route`')


async def pipe(reader, writer):
    try:
        while True:
            data = await reader.read(65536)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    except (ConnectionResetError, BrokenPipeError, asyncio.IncompleteReadError):
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def handle(local_reader, local_writer, host, port):
    try:
        remote_reader, remote_writer = await asyncio.open_connection(host, port)
    except OSError as e:
        print(f'  upstream {host}:{port} unreachable: {e}', flush=True)
        local_writer.close()
        return
    await asyncio.gather(
        pipe(local_reader, remote_writer),
        pipe(remote_reader, local_writer),
    )


async def main():
    listen_port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    target_port = int(sys.argv[2]) if len(sys.argv) > 2 else listen_port
    host = windows_host()
    server = await asyncio.start_server(
        lambda r, w: handle(r, w, host, target_port), '127.0.0.1', listen_port)
    print(f'bridging 127.0.0.1:{listen_port} -> {host}:{target_port}', flush=True)
    async with server:
        await server.serve_forever()


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
