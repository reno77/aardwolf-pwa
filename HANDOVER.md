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
pwa/js/buttons.js   the editable shortcut row above the input
pwa/js/ui.js        output rendering, panels, aliases, triggers
```

Ownership rule: a module-level `let` lives in the module that **writes** it, so
every cross-module import stays a read-only binding. If you need to change a
value from elsewhere, export a setter (see `setMaxLines`, `replaceDb`).

Inline `on*` attributes cannot see module scope. `main.js` re-exposes the
handlers they use on `window`; add to that list when you add a handler, or wire
it with `addEventListener` instead (the joysticks and the shortcut row do the
latter).

### Shortcut row (`#bottomrow`)

Rendered from the `buttons` table by `buttons.js`, not hardcoded in the markup.
**Tap** sends the command through `sendCmd` (so aliases and `;` sequences work),
**hold 500 ms** opens the editor for that button, **+** adds one. The default set
is seeded once, guarded by `meta.buttons_seeded` so deleting every button does
not bring them back on the next load.

The editor's Position field is 1-based and reads left to right. `moveTo()`
renumbers every row after a move rather than nudging a single `pos`, which keeps
the sequence dense across inserts and deletes so there is never a `pos` tie for
`ORDER BY pos, id` to break arbitrarily. Deleting also closes the gap.

The row is action commands only — movement is joystick-only, and there is no
movement button anywhere in the UI. The pinned group to the right of the divider
(`#bottomrow-fixed`: `+ 🎯 🎒 ⚙️`) is panel navigation, stays put while the row
scrolls, and is deliberately not editable.

Activation is on `pointerup`, not `click`, so the long-press can suppress the tap
without a click-cancelling dance. A drag past 10 px cancels the press entirely,
which is what lets you scroll the row without opening an editor.

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
buttons(id INTEGER PK AUTOINCREMENT, label, cmd, cls, pos)
```

`buttons` is added by `SCHEMA_SQL` without a version bump — `initDb` re-runs the
whole script on every load, so `CREATE TABLE IF NOT EXISTS` picks up new tables
in an existing v3 database. Use that path for any table that does not invalidate
map data. It is rescued alongside `aliases`/`triggers` on a real schema rebuild.

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
areas), `key_name`, and `random` (313 exits across 17 areas).

**Random exits are imported, flagged `exits.random=1`, and routed through.** They
used to be dropped, on the reasoning that you cannot route through an exit whose
destination is unpredictable. That is true of one step and false of the graph: in
16 of those 17 areas the random exits are the only link between one part of the
map and another, so dropping them left this much unreachable from the area
entrance —

| area | rooms | reachable without | with |
|---|---|---|---|
| Castle Vlad-Shamir | 100 | 4 | 100 |
| The Coral Kingdom | 50 | 7 | 50 |
| The Goblin Fortress | 50 | 16 | 50 |
| The DarkLight | 49 | 18 | 47 |
| Lowlands Paradise '96 | 97 | 35 | 97 |
| Gold Rush | 49 | 35 | 49 |
| …11 more | | | |

That is what produced `/xcp`'s "no route" for a campaign mob a few rooms away:
Lodi, the goblin mutant sits in The forgotten halls, and every route in crosses
one random exit at "Fortress intersection".

`to_uid` on a random exit is one sample rather than a fact, so:

- `findPath` orders `random ASC` before `length(dir) ASC`, which breaks ties
  against them. It does **not** prefer a longer certain path over a shorter random
  one — that would need a weighted search, and BFS is the right shape here.
- the walker sets **no** `expectUid` for a random step, so landing elsewhere
  neither rewrites the edge (fossilising one roll as truth) nor spends the
  re-path budget. Re-pathing from wherever you come out *is* how a maze is
  crossed; `MAX_RANDOM_STEPS` (40) is the only bound.
- arriving is usually detected by **room name**, not uid — `walkTo` remembers the
  target's name, so any one of the nine "The forgotten halls" rooms counts.

### What `room.info.exits` actually means

Two assumptions in the old code were wrong, both confirmed live in The Goblin
Fortress:

- **A closed door is still listed.** "Before the fortress" reports `"n": 31848`
  and answers `n` with "The doubledoor is closed." So a missing direction is a
  *hidden* exit, not a closed one; ordinary closed doors are caught by the
  `BLOCKED` text triggers in `nav.js`, which send `open <dir>` and retry.
- **A destination of `-1` means "not telling".** Maze rooms report every exit as
  `-1` — "Fortress intersection" gives `{n:-1, e:-1, s:-1, w:-1, d:-1}` with
  `details: "pk,maze"`. Storing that created an edge to a room named `-1` and,
  worse, the upsert overwrote the real Gaardian destination, so the first visit
  to a maze destroyed the only route across it. `isKnownUid` now rejects `-1`,
  `0`, `'?'` and empty, and marks the existing edge `random=1` instead — the
  game telling you it will not disclose a destination is the definition of one.

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
- A cardinal direction missing from `room.info.exits` is a **hidden** exit, not a
  closed one — GMCP lists closed doors like any other (see §3) — so the walker
  tries `open <dir>` once. Ordinary closed doors are caught by the `BLOCKED`
  text triggers. A custom exit is never validated against GMCP, because Aardwolf
  never publishes custom exits there.
- `planRoute(from, to, ruledOut)` wraps `findPath` and falls back to the rooms
  the current one might still be (see "Room identity"), because an unidentified
  room has no edges and therefore no routes.

### Commands worth knowing

| command | what it is for |
|---|---|
| `/navdiag [room name]` | Why "no route"? Prints the room's uid, row, edges, anchor, candidate set, imported-area count, and the direct and via-candidate routes. Leads with the client build id, so stale cached modules are obvious. |
| `/navto [uid]` | Walk to a room by GMCP number. With no argument, prints the current uid. A **name** is the wrong handle in the areas that need one most: The Gauntlet has 51 rooms called "The Gauntlet", and Gaardian records no way into the half of that area containing them. A uid is unique and needs no identification machinery — the room only has to have been visited once. |

Caveat on `/navto` in a true maze: if the room reports its exits as `-1` (see
§3), nothing is stored for them, so walking builds no usable graph there either.
The uid is still a valid target from outside; it is the last leg that has to be
walked by hand.

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

### Area names: keyword vs display name

**GMCP puts the area KEYWORD in `rooms.area`, not the display name.** `room.info`
sends `"zone":"aardington"` and `room.area` sends
`{"id":"aardington","name":"Aardington Estate"}`, and `processGMCP` stores
`data.zone`. Gaardian, campaign text and `where` output all use the *display*
name. The local value is therefore a **prefix** of the long one.

Every prefix test in the codebase originally pointed the other way
(`LOWER(area) LIKE 'aardington estate%'`), which silently matched nothing:

- `importGaardianArea` promoted no live rooms, so an imported area stayed an
  island. Standing *inside* Aardington Estate, pathing to The stables reported
  "no path to that room from here" — the room existed twice, once as the live
  uid and once as `gaardian:344:25`, with no edge between the two subgraphs.
- `resolveRoomsByName` returned only the Gaardian placeholder, so the walker was
  aimed at the disconnected copy even when the real room was known.

Both now accept a match in **either** direction (`? LIKE LOWER(area)||'%'`), and
`resolveRoomsByName` orders real uids ahead of `gaardian:%` ones.

`room.area` is also an authoritative keyword→name pair, so `processGMCP` upserts
it into `areas(name, key)`. Walking anywhere now teaches the client that area's
`runto` keyword for free — no `areas <n> <m> keywords` harvest, and no falling
back to the first-word guess (which yields `aardi`, not `aardington`).

### Area keywords are not derivable — harvest them

GMCP's zone is the display name with the spaces squeezed out (`earthplane`,
`landofoz`), but **249 of Gaardian's 269 area names contain a space**, so
`areaname LIKE '%earthplane%'` matched nothing and the map was never imported
for most areas. The client then knew only the rooms you had physically walked,
and clicking anything else said "no path found". `gaardianAreaIdFor()` resolves
an area by comparing with all punctuation removed, preferring the display name
GMCP supplied via `room.area`.

The `runto` keyword is a different problem: it is **arbitrary**, not derived.
`kobaloi` for "Keep of the Kobaloi", `tilule` for "Tilule Rehabilitation
Clinic", `earthplane` for "Earth Plane 4". Every heuristic is a coin flip — the
old one truncated the first word to five characters and sent `rt earth`. So the
helper no longer guesses: with no keyword on record it runs
`harvestAreaKeywords()` once (≈330 keywords from `areas 1 299 keywords`), waits,
and retries the target.

### Travel deadlines measure being stuck, not the journey

The runto watchdog was a flat 12s, so a long speedwalk was abandoned while it was
still walking — "it timed out but I still got moved". `armRuntoWatchdog` is now
re-armed by every `room.info` (`noticeTravelProgress`), so it fires only after
`RUNTO_STALL_MS` of *no room change*, with `RUNTO_TOTAL_MS` as a backstop.
The walker's own per-step timeout does the same: before failing it checks whether
the room actually changed, and retries once before giving up.

### One area, one name

`rooms.area` used to be written from whatever string the caller happened to
hold: GMCP's zone (`aardington`) when walking in, but the display name
(`aardington estate`) when a room was resolved by name for a campaign. The same
area was then imported **twice under two names**, so the map dropdown listed both
and picking either showed only half the rooms — with the room you were standing
in frequently in the other half. It looked right only under "All Areas".

`canonicalArea()` resolves any area string to the GMCP keyword via
`areas(name, key)`, and every write of `rooms.area` goes through it.
`mergeAreaAliases()` folds already-split rows together, and `room.area` calls it
on arrival, so an existing database repairs itself as you walk.

The map's **"All Areas"** option is gone. It drew all 22k rooms across 269
unconnected areas onto one sheet, and it was the default. The dropdown now
follows the room you are in; picking an area pins it until the map is reopened.

### Room identity: which Gaardian room is this?

The hard part of using an imported map. Neither obvious key works:

- **Names repeat.** Only 10,740 of 22,362 Gaardian rooms (48%) have a name unique
  within their own area. Aardington Estate has **twelve** "Path around the manor"
  and eight "Catacombs".
- **`coord` is the area's position, not the room's.** Every room in the estate
  reports `{x:38, y:25}` — the same value `room.area` carries. Verified against
  three different rooms. It cannot separate twins.

What does identify a room is the graph around it: GMCP publishes exits as
`{direction: neighbour-uid}`, so every edge constrains two rooms at once.
Identification is therefore **constraint propagation**, in `db.js`:

- `room_candidates` holds the surviving hypotheses for a room that is not yet
  certain. A room is never promoted on a guess.
- `narrowCandidates` shrinks a set using, strongest first: a neighbour we already
  know, an inbound edge from a room we know, a neighbour whose *name* we know
  from having stood in it, and finally the exit-direction fingerprint. Each only
  ever narrows — a constraint that would empty the set is ignored, because GMCP
  omits closed exits.
- `cascadeAnchors` carries one certain anchor outwards: if this room is Gaardian
  room L and `dir` leads to live room U, then U is whatever L's `dir` exit
  reaches. Breadth-first, so a single certain room aligns everything reachable.
- `reconcileArea` re-runs narrowing over still-ambiguous rooms for a few rounds,
  since each new anchor is fresh evidence for its neighbours.

Why the discipline matters: promotion **rewrites a room's edges**, so a wrong
identification cannot be undone and surfaces much later as a walk that sets off
in the wrong direction. Measured before this was fixed: 83 rooms, 82 of them
skeleton, the one real room holding two dead-end exits, and every route across
the area failing while standing in it. After: 5 anchored, **0 ambiguous**, and
`/xcp 1` walks the single correct step to the target room.

`promoteGaardianRoom` is now a pure merge — it does no inference of its own.

### When there is no mapped route at all

`gotoRoomUid` used to report failure and stop. Importing an area from Gaardian
does not connect it to anywhere you have walked, and from a clan hall there is no
mapped route anywhere — so it now falls back to the server's own
`runto <keyword>` to get into the target area, waits for GMCP to confirm arrival,
and retries the local path from inside (once; `opts.noAreaHop` stops recursion).

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

Commands: `dinv build | search | get | put | wear | containers | scan | best |
swap | bind | sort | help`, available as `dinv ...` or `/dinv ...`.

### `invdetails` — where scores and wear slots come from

`invdata` reports `wear-loc` as `-1` for anything not currently worn, so it can
never tell you which slot a stored item belongs in. `invdetails <objectid>` can,
for worn *and* stored items alike, and it carries the game's own item score:

```
{invheader}objectid|level|itemtype|value|weight|wearloc|flags|owner|clan|…|itemscore
{invheader}2507920616|41|Armor|5600|0|eyes|unique, glow…||The Midgaardian…||2|||80
```

Confirmed live against `bedokman`.

**`invdetails` cannot see inside a container.** For any item in a backpack the
game answers `Item <objectid> not found.` — verified live, and passing the
container as a second argument does not help (`help invdetails` documents a
single argument). This was the biggest defect in the recommender: all gear
stored in backpacks had no `wearslot` and no `score`, so `dinv best` could not
see it and reported whole slots as having nothing to offer. The refusal line was
parsed as noise, so nothing said anything was wrong.

`dinv scan` therefore runs two passes: carried and worn items get a plain
`invdetails` at 450 ms spacing, and each stored item is taken out, detailed, and
put straight back (`get`/`invdetails`/`put`, 400 ms apart). That pass is limited
to `WEARABLE_TYPES` because it costs three commands per item. `dinv scan here`
skips it entirely. `parseInvDetails` counts the "not found" replies and the scan
reports the total.

Three bugs fixed here; all three are easy to reintroduce:

1. **Never use `INSERT OR REPLACE` on `items`.** REPLACE deletes the row and
   inserts a new one, so every column the statement does not name — `wearslot`,
   `score`, `scanned` — came back `NULL`. Since `dinv swap` and `dinv sort` both
   end by re-reading `invdata`, a scan was destroyed seconds after it finished
   and `dinv best` reported "no scanned items yet" forever. `parseInvData` now
   uses `ON CONFLICT(objectid) DO UPDATE`, and `dinv build` marks rows stale and
   prunes the survivors instead of `DELETE FROM items`.
2. **Several wear slots hold more than one item** — confirmed from live eqdata:
   `ear`, `neck`, `wrist`, `finger` ×2 and `medal` ×3. Treating a slot as full
   when one of its two places was occupied meant a bare second wrist or ring was
   never offered anything. `SLOT_CAPACITY` in `dinv.js` holds the exceptions;
   `dinv best` picks the top *capacity* items per slot.
3. **Worn Aard gear is sticky** (user rule). Nothing displaces an Aard-branded
   piece you are already wearing except another Aard piece of a *higher level* —
   not a non-Aard item however well the game scores it, and not a lower-level
   Aard item with a better score. Aard gear does not fade or break, so a raw
   score comparison is the wrong call for it. Implemented as a `forced` list per
   slot that is seeded before the score ranking fills the remaining capacity.
4. **Portals are never recommended** (`NEVER_RECOMMEND = {20}`). A portal is
   *held*, and holding one costs the off-hand a second weapon needs. For the same
   reason `SLOT_CAPACITY.wield` is **2** — dual wield. Drop it to 1 for a
   character without the skill. A portal already worn is still shown, so it can
   be reported as the thing being displaced.
5. **A slot with no usable candidate used to print nothing at all**, which is
   indistinguishable from the recommender being broken. `dinv best` now iterates
   `ALL_SLOTS` and says why a slot got no suggestion ("lowest you own is level
   161, you can use 121").

### Container bindings

`dinv sort` files loose items into containers by level band. It used to need five
`dinv bind` calls first, and with nothing bound it filed nothing and reported
only "nothing to move" — which reads as "already sorted". `dinv sort` and
`dinv swap` now call `autoBind()` when no bindings exist at all.

Five identically-named backpacks cannot be told apart by name, so `autoBind`
takes them in **inventory order** (band 1 = first backpack) and pulls out a
container whose name matches `gem|misc|junk|pouch|satchel` for `misc`. Inventory
order is consulted **only at bind time**; what gets stored is the objectid, so a
death-and-reloot that shuffles the packs cannot silently repoint an existing
binding. This is the same rule as `dinv bind 2.backpack`, and it is deliberate —
see §7c. A manual bind is never overwritten without `dinv autobind force`.

`dinv bindings` shows the current mapping, `dinv bands` the level ranges.

`get <objectid> <containerid>` and `wear <objectid>` are both **verified working**
against the live MUD — if a swap fails it is not the syntax. `dinvWatchText` in
`dinv.js` collects the game's refusals during a swap and `reportSwap` names the
items that did not go on, so the next failure report says which and why.

Item level is not the level needed to use it: a level 200 item is wearable at
150 for a tier 5 character. `effectiveLevel()` (`charLevel + charTier * 10`) is
the matching cap — verified live: level 71 tier 5 → cap 121, and the game
refused a level 200 item with "You must be at least level 150".

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

Both of the traps this section used to warn about have now been closed, because
both of them actually fired after a crash — the site came back up serving the
*old* WSL checkout, which reads as "the site is down" since none of the current
behaviour is there:

- `aardwolf-relay.service` was still enabled, so it restarted on boot and took
  WSL's 8765 back. It is now **stopped and disabled**
  (`systemctl --user disable aardwolf-relay.service`). If you ever want to go
  back to serving from inside WSL, re-enable it *and* disable the bridge below —
  they both want port 8765.
- The bridge was started with `nohup` and did not survive a reboot. It is now a
  systemd user unit, `~/.config/systemd/user/aardwolf-bridge.service`, enabled
  with lingering on, so it comes back by itself:

```
systemctl --user status  aardwolf-bridge.service
systemctl --user restart aardwolf-bridge.service
```

`Restart=always` covers the gateway address changing across reboots, since the
bridge resolves it at startup.

**WSL will not stay up on its own.** WSL2 tears the whole VM down once no
Windows process is attached to it, and that takes `cloudflared` and
`aardwolf-bridge.service` with it. The symptom is Cloudflare **error 1033**
("unable to resolve the origin") while the Windows relay on :8765 is perfectly
healthy -- and it looks intermittent, because any `wsl ...` command boots the VM
again and the site works for as long as you keep poking it.

`wsl -l -v` is the check; it reports state without starting anything:

```
wsl -l -v            # Ubuntu-22.04 must say Running, not Stopped
```

Held open by `wsl-keepalive.vbs` in the per-user Startup folder
(`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`), which runs
`wsl -d Ubuntu-22.04 -- sleep infinity` hidden at logon. Delete the file to
undo. A scheduled task would be tidier but needs admin.

The real fix is to stop involving WSL at all: run `cloudflared` on Windows
against `http://localhost:8765` and drop both the bridge and the keepalive.
Nothing else in the chain needs WSL any more.

**Diagnosing "the site is down".** Work along the chain; the useful test is
whether the public URL serves a file that only exists in the new checkout:

```
curl -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8765/            # Windows relay
wsl -- ss -ltn | grep 8765                                              # bridge listening
curl -o /dev/null -w '%{http_code}\n' https://mud.bedok77.win/static/js/buttons.js
```

502 from Cloudflare means nothing is listening on WSL's 8765 (bridge down).
A 200 on `/` but 530/404 on `buttons.js` means the *old* WSL relay has the port.

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

## 7d. The Android app (`android/`) — the same client with no relay at all

The relay exists for exactly one reason: **a browser cannot open a raw TCP
socket**, so something else has to hold the telnet session to
`aardwolf.org:4000`. Nothing else about the client needs a server. sql.js,
IndexedDB, `localStorage` and `gaardian_maps.db` are all browser-local already.

An Android app can open that socket itself, so the relay, the WSL bridge, the
Cloudflare tunnel and the always-on PC all disappear together.

**Shape:** a `WebView` running the *same* `pwa/` directory, plus a foreground
service holding the socket.

```
pwa/js/transport.js   openTransport() -> WebSocket in a browser,
                      NativeTransport (window.AardNative) in the app
android/…/TelnetSession.kt   port of relay_minimal.py's telnet + GMCP read loop
android/…/MudService.kt      foreground service that owns the socket
android/…/MainActivity.kt    WebView + WebViewAssetLoader + the JS bridge
```

Things that are load-bearing and non-obvious:

- **`pwa/` is not copied into the app.** `app/build.gradle.kts` points the
  `assets` source set at `../pwa`, so the app compiles the live client in. There
  is deliberately no second copy to drift.
- **Assets are served over `https://appassets.androidplatform.net`, not
  `file://`.** A `file://` origin is opaque: IndexedDB and `localStorage` are
  unreliable-to-unavailable there and ES modules will not load. `WebViewAssetLoader`
  gives a normal secure origin, and the two path handlers (`/static/` then `/`)
  reproduce the relay's URL layout so no client code needs an app-specific path.
- **Content types are pinned, not guessed** (`MainActivity.CONTENT_TYPES`) for
  the same reason `relay_minimal.py` pins them: a module served as `text/plain`
  is refused outright.
- **sql.js is vendored** in `pwa/vendor/` rather than loaded from cdnjs, so first
  paint needs no network. `.wasm` must be served as `application/wasm` or
  `instantiateStreaming` silently falls back to a slower path.
- **`/export` and `/import` are rewritten for the app.** A blob URL with
  `<a download>` and an `<input type=file>` are both *silent no-ops* in a
  WebView. They now go through the system document picker, chunked in both
  directions because a multi-megabyte string through the JS bridge is not
  something the WebView guarantees to deliver. This is also the migration path:
  `/export` in the browser client, `/import` in the app.
- **The session outlives the page, on purpose.** Closing the transport does not
  drop the MUD connection — Android recreates Activities freely, and a socket
  owned by the page would take the character link-dead with it. Only the
  notification's Disconnect action really ends it.
- **Missed output is dropped, not replayed.** A reattaching page gets a GMCP
  state re-request and a fresh prompt (exactly what the relay does), not the
  backlog. Replaying `text` messages would re-run every trigger and re-feed the
  campaign parsers — a replayed kill line would advance the S&D state machine
  for a kill it already handled.

**What you lose versus the relay:** one shared session across phone *and*
desktop, and a session that survives with the phone off. The app's session lives
and dies with the phone.

**Versions are pinned to Android Studio 2022.2** (the installed one): AGP 8.0.2,
Gradle 8.0.2, Kotlin 1.8.22, compileSdk 33, JDK 17. AGP 8.1+ will not sync in
that Studio. See `android/README.md` for the build.

## 8. Common pitfalls

| Issue | Cause / Fix |
|-------|---------------|
| PWA shows old version | Relay sends no-cache headers; hard-refresh or use incognito. |
| Modules 404 or refuse to load | Check `Content-Type: application/javascript` on `/static/js/*.js`. |
| Phone cannot connect | PC and phone on same network, or use the Cloudflare tunnel. |
| No room shown after login | GMCP re-request (§7); check `char.status`/`room.info` are arriving. |
| Map or walk says "no route" | The area probably is not imported yet, or the target is behind a `level 999` exit. If the area is one of the 17 with random exits (§3) and the DB predates the `exits.random` column, `initDb` backfills them once — check for "[Gaardian] Restored N random exit(s)". |
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
