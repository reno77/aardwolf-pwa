# Handover Notes for the Next Coding Agent

This document is written for another autonomous agent or developer taking over the project.

## 0. Read this first: Aardwolf's botting policy

`help policies7` on Aardwolf says, verbatim:

> Read quest, gquest, and/or campaign information to automatically go to areas,
> find and kill mob, or quest complete (for quests).

is botting, and:

> There is no legal scenario in which you have a trigger that kills a mob, no exceptions.

> Using AI scripts or Large Language Models to control or provide input for your
> character is also considered botting.

The S&D helper in `pwa/js/snd.js` implements exactly that chain (`cp check` →
`runto` → `where`/`hunt` → `kill` → verify). **As written it is against the rules
and puts the account at risk of a ban.** The auto-advance between targets was
deliberately removed — the helper now stops after each target and waits for you
to type `/xcp` — but the `kill` step and the auto-attack triggers in
`state.js`/`ui.js` are still there. Decide what you want to keep before using it.

Navigation assistance (tap-to-walk, showing a route, the map) is ordinary client
behaviour and is not the problem. The unattended find-and-kill loop is.

## 1. Project identity

- **MUD:** Aardwolf (`aardwolf.org:4000`). Port 23 is for character creation only. Always use port 4000 for live play.
- **Primary user character:** `bedokman` (public in-game name, not a secret).
- **Live deployment:** `mud.bedok77.win` via Cloudflare tunnel `hermes-wsl-winbox`.
- **Relay:** `python3 relay_minimal.py` on port 8765.

## 2. Layout

The client used to be a single 3442-line `index.html`. It is now split:

```
pwa/index.html      markup + CSS only; loads /static/js/main.js as a module
pwa/js/main.js      entry point; re-exposes handlers on window for inline on*
pwa/js/state.js     shared constants (commandMap, triggerDefs, WS_URL, output)
pwa/js/net.js       WebSocket, login, command dispatch, movement entry point
pwa/js/gmcp.js      GMCP room.info / char.status / char.vitals / comm.quest
pwa/js/db.js        sql.js schema + migration, Gaardian map import
pwa/js/nav.js       THE pathfinder and THE movement walker
pwa/js/areas.js     area keywords, level locks, no-go list, runto results
pwa/js/snd.js       campaign helper (see §0)
pwa/js/dinv.js      inventory manager (invdata/eqdata)
pwa/js/map.js       canvas map, tap-to-walk
pwa/js/joystick.js  the two movement sticks
pwa/js/ui.js        output rendering, panels, aliases, triggers
```

Ownership rule: a module-level `let` lives in the module that **writes** it, so
every cross-module import stays a read-only binding. If you need to change a
value from elsewhere, export a setter (see `setMaxLines`, `replaceDb`).

Inline `on*` attributes cannot see module scope. `main.js` re-exposes the
handlers they use on `window`; add to that list when you add a handler, or wire
it with `addEventListener` instead (the joysticks do the latter).

## 3. Local database (schema v2)

`initDb()` rebuilds the map tables when `meta.schema_version` does not match
`SCHEMA_VERSION`, keeping aliases and triggers.

```sql
rooms(uid TEXT PK, area, name, terrain, info, x, y, z, exits,
      noportal, norecall, first_seen, last_visited)
exits(from_uid, dir, to_uid, level, door, key_name, PRIMARY KEY(from_uid, dir))
areas(name TEXT PK, key, minlvl, maxlvl, lock, nogo)
mobs(mob, area, room, room_uid, seen_count, last_seen, PRIMARY KEY(mob,area,room))
items(objectid TEXT PK, flags, name, level, type, unique_item, wearloc, timer, location, updated)
```

Three things to understand about `exits`:

1. **`dir` may be any command string.** `length(dir) > 1` means "a custom exit:
   type this verbatim" — `enter portal`, `climb ladder`, `say yes`. This matches
   how the Aardwolf mapper models custom exits.
2. **`PRIMARY KEY(from_uid, dir)`** makes `INSERT OR REPLACE` actually replace.
   The v1 table had an `AUTOINCREMENT` id and no unique key, so every room visit
   appended a duplicate row and the graph grew without bound.
3. **Exits are strictly directed.** Never synthesise a reverse edge. v1 did
   (`{n:'s',...}[d] || d`), so `enter portal` "reversed" to itself and the client
   believed one-way portals were two-way.

### `gaardian_maps.db` exit encoding

Confirmed against the shipped file by comparing each exit to its rooms' x/y deltas:

| `exit_type` | meaning | rows |
|---|---|---|
| 0/1/2/3 | N / E / S / W | ~49,300 |
| 4 / 5 | up / down | 4,810 |
| 6 | `enter <exit_action>` (`portal`, `hole`, `den`) | 491 |
| 7 | arbitrary command in `exit_action` (`climb ladder`, `say yes`) | 786 |

Plus `door_type` (0 none, 1 door, 2 locked; 4,647 doors, 1,037 locked across 145
areas), `key_name`, and `random` (313 exits — skipped; you cannot route through
an exit that goes somewhere unpredictable).

## 4. Navigation

`nav.js` has one pathfinder and one walker. Do not add a second of either.

- `findPath(from, to)` — breadth-first, searched **backwards from the
  destination**, one indexed SQL frontier query per depth level.
  `ORDER BY length(dir)` prefers a plain compass exit over a custom one.
- `walkTo(uid, onDone, onFail)` — sends one step, records `expectedUid`, and
  waits for the next GMCP `room.info` to confirm it. On a mismatch it corrects
  the offending edge (`UPDATE exits SET to_uid=...`) and re-paths.
  It gates on `char.status.state`: pauses on 8 (fighting), stands on 9/11,
  never steps during 12 (running).
- A cardinal direction missing from `room.info.exits` is a **closed door** —
  GMCP lists only open exits — so the walker tries `open <dir>` once.
  A custom exit is never validated against GMCP, because Aardwolf never
  publishes custom exits there.

There is **no movement throttle**. There used to be a 500 ms one that silently
dropped anything faster; it broke tap-to-walk (paced at 400 ms) and `/runto`
(whole path in one tick). Pacing is the walker's job now.

## 5. `runto` and area keywords

From `help runto`: **`runto` only works from Aylor recall** unless a `runprefix`
is set (`help runprefix`), it only executes the canned speedwalk for an area, and
`run` itself "only works with six basic directions, not custom exits or commands
like opening doors".

`areas.js` therefore does not guess keywords. `/areas` harvests the real list
from the game (`areas 1 299 keywords`, answering the pager with `A`) into the
`areas` table, capturing the level `Lock` column too. Verified live: 312 areas.

This matters. The old code took the first word of the area name and truncated it
to five characters, which collides for 54 of the 269 mapped areas:

| area | old guess | real keyword |
|---|---|---|
| Land of Legend | `land` | `legend` |
| The Land of Oz | `land` | `landofoz` |
| The Land of the Beer Goblins | `land` | `beer` |

`NO_GO` in `areas.js` lists areas that cannot be auto-navigated at all (mazes,
clan halls, epic and puzzle areas) — the helper reports and skips instead of
looping. A failed `rt` is now parsed and abandons the target rather than falling
through to `where`, which only works *inside* the target area.

## 6. Inventory (`dinv`)

Modelled on [Aardurel/aard-plugins](https://github.com/Aardurel/aard-plugins).
Built on the machine-readable commands (`help invdata`), not on scraping
`inventory`:

```
{invdata}
objectid,flags,itemname,level,type,unique,wear-loc,timer
{/invdata}
```

`eqdata` for worn items, `invdata <container objectid>` to descend into a
container. `dinv build` walks equipment → inventory → every container found.
Item names contain commas and Aardwolf colour codes, so the parser takes fields
from both ends of the line and strips `@x123`/`@R` codes.

Commands: `dinv build | search | get | put | wear | containers | help`,
available as `dinv ...` or `/dinv ...`. Verified live: 339 items indexed.

## 7. Relay

Both relays serve the PWA with no-cache headers and now pin `Content-Type` for
`.js` — Python's `mimetypes` reads the Windows registry, where `.js` is often
`text/plain`, and browsers refuse an ES module served as `text/plain`.

Two bugs fixed that will bite you again if reintroduced:

- The relay wrote debug logs to hard-coded `/tmp/...` paths **unconditionally**,
  including inside the MUD read loop. On Windows that raises `FileNotFoundError`
  and the MUD connection dies on the first byte. Logging is now opt-in via
  `RELAY_DEBUG_DIR`.
- The GMCP handshake requests full state when the TCP session opens, which is
  *before* the player logs in — so a session that logs in afterwards never gets a
  `room.info` and the client has no idea where it is. The client now sends
  `{action:'gmcp_request'}` once it sees a prompt, and the relay re-requests.

## 7a. Running the relay on Windows while the tunnel lives in WSL

The deployment was historically a `relay_minimal.py` inside WSL, supervised by
the systemd **user** unit `aardwolf-relay.service`
(`/home/rama/.config/systemd/user/aardwolf-relay.service`, working directory
`/home/rama/.hermes/workspace/aardclone`). `cloudflared` runs in WSL too
(separate process, do not stop it) with a token-based tunnel whose ingress is
configured in the Cloudflare dashboard and points at `http://localhost:8765`.

To serve this Windows checkout instead:

```
wsl -- systemctl --user stop aardwolf-relay.service   # frees WSL's 8765
python relay_minimal.py                               # on Windows
wsl -- python3 /mnt/d/projects/aardwolf-pwa/tools/wsl_to_windows_bridge.py
```

The bridge is needed because **WSL2 forwards localhost Windows → WSL, but not
WSL → Windows**. Without it the tunnel 502s: `cloudflared` resolves
`localhost:8765` inside WSL, where nothing is listening. The bridge listens on
WSL's `127.0.0.1:8765` and relays to the Windows host (the WSL default gateway,
e.g. `172.29.160.1`, resolved at startup because it changes across reboots).
It is a plain TCP relay, so the WebSocket upgrade passes through fine.

Two things that will bite you:

- `aardwolf-relay.service` is still **enabled**, so it starts on next boot and
  takes WSL's 8765 back, and the bridge then fails to bind. Either
  `systemctl --user disable aardwolf-relay.service`, or point that unit at this
  checkout and drop the Windows relay and bridge entirely.
- The bridge started with `nohup` does not survive a reboot or `wsl --shutdown`.
  Make it a systemd user unit if you want it permanent.

Simpler alternative: keep running the relay inside WSL and just update the WSL
checkout to this code. Then no bridge is involved at all.

## 7b. Performance: what made it laggy

The client felt 3-4 seconds behind the MUD while walking. Three causes, all on
the `room.info` path, all compounding because none of them were awaited:

1. **`matchAardwolfToGaardian` called `importGaardianArea` on every room.info** —
   re-importing every room and exit of the current area on each step. Worse, its
   "promote existing rooms" block scanned *all* local rooms and ran one Gaardian
   query per row: measured 110 ms at 2k rooms, 250 ms at 5k, **463 ms at 10k**,
   on a desktop. Now guarded by the `gaardian_imported` table so an area is
   imported once, and the promote scan is filtered by area in SQL.
2. **`persistDb()` on every room.info** — `sqlDb.export()` of the whole database
   (1.4 MB on a small map, 8.3 MB fully imported) handed to IndexedDB, not
   awaited, so writes queued on top of each other. Now debounced and coalesced
   (`PERSIST_DEBOUNCE_MS`, at most one write in flight). Use `persistDbNow()`
   where the user is waiting, e.g. database import.
3. **`idbSave`/`idbLoad` opened a new IndexedDB connection per call** and never
   closed it. One connection is now opened lazily and reused.

Measured after: **~8 ms per room change** on a 3.5k-room map.

`sqlDb.export()` itself is not the problem — 2 ms even at 8.3 MB. It is the
IndexedDB write and the repeated import work.

If it ever feels slow again, measure before changing anything: time
`processGMCP('room.info', ...)` on a warm map rather than guessing.

### Where the remaining latency actually is

Measured, so nobody has to guess again:

| Hop | Cost |
|---|---|
| Client work per MUD line (ansi -> HTML, 80 trigger regexes, parsers) | ~0.1 ms |
| Client work per room change | ~8 ms |
| **Cloudflare tunnel round trip** (`mud.bedok77.win`) | **350-830 ms** |
| Same relay over LAN | 2-24 ms |
| Network to `aardwolf.org:4000` | ~300 ms best case, highly variable |

**The tunnel is the dominant term** -- roughly 400 ms added to every round trip,
on top of the MUD's own ~300 ms. Over LAN the same relay answers in ~20 ms.
So: use the LAN address when at home, and keep the tunnel for when you are out.
No amount of client optimisation moves this; it is the transport.

The client itself is no longer a meaningful contributor. Do not spend effort
micro-optimising the text path -- 0.1 ms per chunk is noise next to the above.

Both relays now set `TCP_NODELAY` on the MUD socket. Nagle otherwise holds a
two-byte movement command waiting for more data or the previous ACK, which on a
~300 ms link is a real addition for no benefit.

## 7c. User preferences to preserve

- **Map style:** labelled cells showing the room's **full name**, shrunk to fit
  and ellipsised only when very long, with ~3.5 room-heights of margin at the
  top of the view. This replaced the earlier 2-letter abbreviations; tapping a
  room still shows the untruncated name.
- **Output density:** rows tight, no blank line between them (see §9).
- **Joystick:** 4-way only, no diagonals. Deliberately insensitive -- a
  dominant-axis rule plus hysteresis, so a push that is mostly south but
  drifting west stays south instead of firing `w`.
- **S&D recall** is an equipment-swap sequence
  (`wear garbage;enter;rem garbage;wear wpn;wear wpn 2`), not a plain `rec`.
  Configurable with `/recallseq`.
- **Skip recall when already in the target area.**
- **Never ship a hardcoded password.** Credentials are typed by the user and
  live in browser `localStorage` only.

## 8. Common pitfalls

| Issue | Cause / Fix |
|-------|---------------|
| PWA shows old version | Relay sends no-cache headers; hard-refresh or use incognito. |
| Modules 404 or refuse to load | Check `Content-Type: application/javascript` on `/static/js/*.js`. |
| Phone cannot connect | PC and phone on same network, or use the Cloudflare tunnel. |
| No room shown after login | GMCP re-request (§7); check `char.status`/`room.info` are arriving. |
| Map or walk says "no route" | The area probably is not imported yet, or the target is behind a `random`/`level 999` exit. |
| `rt` goes to the wrong area | Run `/areas` to harvest real keywords. |
| Blank line between every row | `appendOutput` must buffer partial lines; see §9. |
| Connected, but a blank screen and "no MUD updates" | The relay shares ONE MUD session across all clients. A client attaching to a session that is already past the banner sees nothing until the MUD next says something, which looks identical to a broken connection. `action:'connect'` now re-requests GMCP state and nudges a prompt out on reattach. If you are debugging this, poke the session with a bare newline before concluding anything is broken. |

## 9. Output rendering

MUD output arrives in arbitrary TCP-sized chunks. A chunk ending in a newline
used to yield a trailing empty string from `split('\n')`, rendered as a blank
row, and a line split across two chunks rendered as two rows. Between them that
put a gap after most lines and made ASCII maps double height. `appendOutput`
now holds the incomplete tail back and emits only whole lines, flushing after
120 ms of quiet so the prompt (which has no trailing newline) still appears.

## 10. Testing

`pip install aiohttp`, then `python relay_minimal.py`.

There are two harnesses (kept out of the repo, in the session scratchpad) worth
recreating if you need them:

- a **load test** that imports every module under a DOM shim, to catch
  circular-import and missing-export errors without a browser;
- a **live harness** that runs the real modules against a real session with
  `sql.js`, driving login and asserting on GMCP parsing, the exits table,
  `findPath` across a custom exit, and duplicate rows.

Manual checklist:
- [ ] Relay starts without errors, serves `/static/js/*.js` as JavaScript.
- [ ] **Hold the left stick down, then push the right stick each of N/S/E/W.**
      Each must echo its own direction. Before the PointerEvent rewrite it
      echoed `w` every time, because `e.touches[0]` is the first touch on the
      *document*, not the one belonging to that stick.
- [ ] Tap-to-walk a 6+ room path: every step echoes, and you end up there.
- [ ] Path across a custom exit (try `Tumari's Diner`, `Realm of the Zodiac`,
      `The Partroxis`, `Yggdrasil`): it sends the literal command.
- [ ] `/areas` learns ~300 keywords.
- [ ] `dinv build` then `dinv search <something you own>`.
- [ ] Visit one room 20 times: `SELECT COUNT(*) FROM exits` must not grow.

## 11. Things NOT in this repo

No API keys, no passwords, no Cloudflare credentials, no trading bot code.
Credentials are typed by the user and kept in browser `localStorage` only.

## 12. Next likely tasks

- Decide the §0 question and prune the campaign helper accordingly.
- `runprefix` support, so `runto` works from somewhere other than Aylor recall.
- Portal/recall as first-class graph edges (the Aardwolf mapper uses virtual
  rooms `*` and `**` so "usable from anywhere" falls out of plain BFS).
- Two-phase paths for `noportal`/`norecall` rooms: walk to the nearest room
  where portalling is legal, then portal.
- Equipment sets in `dinv` (`dinv set`, `dinv snapshot`).
