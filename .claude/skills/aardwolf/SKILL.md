---
name: aardwolf
description: Playing Aardwolf MUD through the aardwolf-pwa client — character state, game mechanics, quests and campaigns, travel, healing, and the pitfalls that have actually cost runs. Use when driving the game, not when only editing client code.
---

# Aardwolf MUD

Everything learned from playing Aardwolf through this client. `HANDOVER.md` in the repo
root covers the **codebase**; this file covers the **game** and how to operate it. Where
they overlap, HANDOVER.md is the authority on code and this file on play.

---

## 0. Read this first — the botting policy

`help policies7` on Aardwolf says, verbatim:

> Read quest, gquest, and/or campaign information to automatically go to areas,
> find and kill mob, or quest complete (for quests).

is botting, and:

> There is no legal scenario in which you have a trigger that kills a mob, no exceptions.
>
> Using AI scripts or Large Language Models to control or provide input for your
> character is also considered botting.

**That last line covers this entire arrangement.** The client's `/xcpauto`, `/grind` and
kill-triggers implement exactly the prohibited chain, and the account is the user's to
risk. The client prints the warning itself whenever `/xcpauto` starts — do not suppress
it. The user has repeatedly asked for these features and that is their call, but:

- Never volunteer to hide, obfuscate, or evade detection.
- Prefer supervised operation (`/xcp <n>`, one target at a time) over unattended runs.
- Navigation, mapping and showing a route are ordinary client behaviour and not at issue.
  The unattended **find-and-kill** loop is.

---

## 1. Standing instruction from the user

> "try not to do by hand as much as possible, so that the PWA can be used without
> requiring you"

**Fix the client rather than hand-driving it.** A workaround typed into the terminal
helps for one minute and leaves the phone broken. When something fails, the deliverable
is a patched module plus a comment explaining the failure — see
`memory/aardwolf-fix-the-pwa-not-by-hand.md`. Hand-driving is for *diagnosing* and for
one-off puzzles the client cannot reasonably learn.

---

## 2. Character and connection

- **MUD:** `aardwolf.org:4000`. Port 23 is character creation only.
- **Character:** `bedokman` (public in-game name), **level 96**, Tier 5. The password is
  **not** in this repo — it lives in `memory/aardwolf-login.md` and in the client's
  localStorage. Never commit it; this repo is public.
- **Relay:** `python relay_minimal.py`, serves the client on `http://localhost:8765`.
- **Driving it:** the client is a browser page; commands go in via CDP. The scratchpad
  helper `go.mjs` sets `#cmd-input` then calls `submitCmd()`.
  **`submitCmd()` takes no argument** — passing one sends a blank line.
- Slash commands through Git Bash need `MSYS_NO_PATHCONV=1`, or `/xcp` becomes a
  Windows path.
- After a page reload the socket drops: click `#connect-btn`, and it usually says
  **"Reattached to the existing Aardwolf session"** — no re-login needed.

Login details and localStorage keys: `memory/aardwolf-login.md`.

---

## 3. Client commands worth knowing

Generated from the dispatcher table; `/help` is always current. The ones that matter:

| command | what it does |
|---|---|
| `/grind <level>` | walk the area killing what triggers attack, until that level |
| `/grindstop`, `/grind off` | stop it (both work) |
| `/medic <heals> <mana> [pct]` | watch health, cast/quaff automatically |
| `/veil <command>` | wait for Veil of Stone, then fire the command |
| `/xcp <n\|name>` | go and kill campaign target n |
| `/xcpauto`, `/xcpstop` | unattended campaign run — see §0 |
| `/cpnew [auto]` | walk to a questmaster and take a campaign |
| `/cpcheck` | re-read `cp check` and rebuild the target list |
| `/quest`, `/xq` | show the quest target / go and kill it |
| `/goto <room name>` | walk to a room using the client map |
| `/ah <keyword>` | autohunt — server-side `hunt`, one step at a time |
| `/chat [clan\|tell\|group\|say]` | the chat panel (see §9) |
| `/dinv ...` | inventory database |
| `/sync` | map sync between clients |

**Stop words are not uniform** and this has bitten before: most helpers take `off`
(`/medic off`), and `/grind off` was a silent no-op that let the walker keep running for
900 rooms while it looked stopped. It now works. **After sending any stop, verify it
actually stopped** — check the banner, or that output stopped growing.

---

## 4. Travel

**`runto` only works standing in the Grand City of Aylor recall room.** Anywhere else:
"You need to be at the Grand City of Aylor (recall) to use runto." It also only handles
the six compass directions — no custom exits, no doors.

**Getting to recall.** The `rec` alias is `hold garbage; enter; rem garbage; wear <gear>`:
the garbage can is a **portal item**, and `enter` (bare, not `enter garbage`) is the step
that moves you. The alias has one trailing `wear` for an item no longer carried, so it
ends with "You do not have that item" — harmless, but it makes a successful recall look
failed. Verify with `look`, not with the alias's output.

**Some areas block both.** `recall` → "You cannot recall from this room", and the portal
silently does nothing. The Ruins of Diamond Reach is one. When both fail, **walk out** to
the area entrance and recall from outside. `recall` also does **not** necessarily go to
Aylor — it goes to your recall point, which has landed in a PK-flagged area before.

**Area keywords are not derivable.** `runto diamond` goes to *Diamond Soul Revelation*;
The Ruins of Diamond Reach is **`ruins`**. Harvest the real list with
`areas 1 299 keywords` — 54 of 269 areas collide on the naive first-word guess.

**When the map cannot route, ask the Gaardian DB.** `pwa/gaardian_maps.db` holds the real
graph (`areas` / `rooms` / `exits`, 269 areas, 22k rooms). BFS from the `is_entrance` room:

- `exit_type` 0–5 → `n e s w u d`; 6 → `enter <exit_action>`; 7 → the action **is** the command
- skip `random=1` — those cannot be pathed through
- `door_type` set → send `open <door_name>` before the step

Some exits are *actions*, not directions: the DB stores `kill crystal` and
`wear drtempshard` as the exit itself, and a boulder-blocked exit in the Diamond Mines
only opens after `kill lich`. This solved rooms the client walked in circles around —
the swirling current is `e;e;open ground;d` from the Elemental Chaos entrance.

**The map will route you into traps.** `/goto` once walked into a **Room of Riddles**
where webs block all movement and portals bounce; the client retried until it timed out.
The map has no concept of a room you can enter but not leave. `recall` escaped it.

---

## 5. Finding a mob — this is where the time goes

**`where` searches the CURRENT AREA only.** Nothing found usually means you are in the
wrong area, not that the mob is absent. Travel first, then `where`.

**One mob needs three different keywords.** For "a tied up ghoul":

| command | keyword |
|---|---|
| `where` | `tied` — `where ghoul` finds a *different* mob |
| `hunt` | neither works; hunt matches **names**, and its name is `ghoul` |
| `kill` | `ghoul`, and only while standing in its room |

A keyword failing proves nothing about the other commands.

**A campaign mob is the one that cannot be hunted:** "You seem unable to hunt that target
for some reason." That is the reliable way to pick it out of four identical
"A knight is here" mobs. The lookalikes give **0 experience** and do not advance `cp check`.

**Hidden mobs cannot be killed.** `(Hidden)` in `scan` means `kill` answers "They aren't
here" from inside the room. `cast 'detect hidden'` — spellup's copy lapses.

**Mobs wander.** A `where` result is a snapshot; by the time you walk there it may have
moved. Re-`where` on arrival rather than assuming.

---

## 6. Quests

1. `quest time` — "You do not have to wait" means one is available.
2. **Stand at a questmaster** (`quest request` elsewhere says "You need to be at a
   questmaster"). Aylor's is **Among the Philosophes**; `/goto Among the Philosophes`.
3. `quest request`, then `/quest` to see the target and whether the room resolves.
4. `/xq` walks there and finds the copy carrying the **`[QUEST]` tag** — the tag is only
   visible in the room, which is how copies are told apart. Its ordinal guess is often
   wrong ("kill 3.captain" → "They aren't here"); just `kill <keyword>` once you can see it.
5. `quest complete` back at the questmaster. ~43 minutes to kill, ~30 more to hand in.

Payout at level 96: roughly 3,200–3,800 gold plus quest points, a tier bonus, sometimes a
bonus practice and a daily-blessing bonus.

---

## 7. Campaigns

- `campaign check` / `campaign request`, or `/cpnew` to walk and take one.
- `cp check` builds the target list; `/xcp <n>` does one target.
- Targets renumber as they are killed — **re-run `/cpcheck` before using an index.**
- ~7 days to finish. `cp check` will say **"You will have to level before you can go on
  another campaign"** — so finish, don't abandon.
- Targets that are simply **not spawned** are common. `where` and `hunt` both come up
  empty and no amount of walking helps; the answer is a repop, which is what the
  auto-run's 5-minute rounds are for. Do not read "not found" as "broken".

---

## 8. Staying alive

**Healing economy.** Mana is far better value than heal potions, because `cast heal`
converts it well:

| item | weight | gives | effective healing |
|---|---|---|---|
| `-=Cup of Sakurayu=-` | 13 | 728 mana | ~20 casts ≈ **5,700 hp** |
| `Salve of Seikenji` | 13 | 4 uses | ~1,048 hp per quaff |
| `A Clorox potion` | 7 | — | 786 hp |
| `-=Samurai Draught of Taikyu=-` | — | ~1,200 moves | movement, not health |

Buy at **Kodai no Ibutsu, Masaki** (`memory/aardwolf-masaki-potions.md`).

**Items above your level are refused outright** — "The magic in X is too strong for you."
This is not the same as running out and retrying never helps. Buy **one** and test before
buying in bulk; 12 level-201 pills bought for a level-93 character cost a whole run.

**Movement ends runs more often than health.** "You are too exhausted to move there" with
full health and a bag of potions is a real death. Carry Draughts.

**Spell up before grinding or a hard fight** — the game's own `spellup`, not an alias.
The user has asked for this explicitly. Expect ~40 spells and most of your mana.

**Veil of Stone** — ~25s of total *physical* immunity, ~1:54 recovery, shared with
`veil shadow` (magical). Lagfree, usable in combat. Drive it with `/veil <command>`, never
by hand. Full notes: `memory/aardwolf-veil-of-stone.md`.

**On death:** everything is on the corpse in the **Morgue** — not where you died, and the
Morgue's own room description misleadingly says "you see your corpse". `get all corpse`
recovers the lot. Order: `get all cor`, `wear all`, sleep to full, then spell up
(`memory/aardwolf-death-recovery.md`). Gold is never at risk. Deaths cost experience and
sometimes a point of a stat.

---

## 9. The chat panel

Clan, tells, group and public talk get lost in the combat scroll — a fight is a dozen
damage lines a round and a tell is gone before it can be read. `pwa/js/chat.js` taps
`emitLine` (the single point every line passes through), classifies by channel and keeps
300 lines each, with an unread badge on the toolbar button and a reply box that sends on
whichever channel is open (`reply` / `gtell` / `clan` / `say`).

Nothing is removed from the main window — it is a second view, not a filter, because a
filter that drops a line you wanted is worse than none. Quest/campaign NPC tells are
excluded so a hundred "Questor tells you" lines cannot bury a real person.

---

## 10. Automation pitfalls that have actually happened

Each of these is fixed in the client; they are listed so the failure **mode** is
recognisable when it recurs somewhere else.

- **A stop command that silently does nothing.** `/grind off` printed usage and returned;
  the grind kept walking for 900 rooms. Always verify a stop took effect.
- **Counting attempts instead of successes.** The grind walker picked its *least-used*
  exit, but counted moves **sent**, not moves that **worked** — so a permanently-refused
  direction stayed least-used forever and it hammered a wall every 2 seconds. Refusals are
  now remembered per room, with a five-strike halt.
- **Spending the resource you are waiting for.** The campaign recovery cast `heal` at full
  health when only *mana* was short — mana climbed past the threshold, got burned on no-op
  heals, fell back, slept, forever. Only cast when the cast has something to do.
- **Retrying a broken route.** Targets were marked skipped and retried on the same map
  route that failed, over 5-minute repop rounds. Map failure now falls back to the
  server's `hunt`, which has its own pathfinder.
- **Trigger storms.** A room lists one line per mob, so a four-mob room fired the attack
  alias four times. Triggers are now capped at one firing per 4 seconds.
- **Alias bursts outliving their target.** `attgreen` is five attacks; the mob dies on the
  second and the rest hit an empty room ("Green death whom?"). Queued sequences now abort
  when the MUD says the target is gone.
- **Chrome throttles background timers.** Use `ticker.js` `onInterval` (worker-backed),
  never bare `setTimeout`, for anything that must keep time in a hidden tab.

---

## 11. Verify before claiming

Two checkers must pass after any client edit:

```
node tools/check_wiring.mjs      # imports resolve, every parser is dispatched,
                                 # no stray control characters
node tools/check_unresolved.mjs  # every function called is declared or imported
```

Both report a module count (33 at time of writing). `check_wiring` catches a real hazard:
writing JS through a shell heredoc can eat `\b` into a literal backspace (0x08).

**Do not report a stat gain measured under buffs.** A `score` taken with spellup and a
Gladiator's Strength potion running showed large gains from the arena goal that did not
exist — every stat returned to its pre-goal value once they expired. Let buffs lapse
(`saffects` → "You are not affected by any") before comparing.

---

## 12. Solved content

- **Gladiator's Arena goal — complete.** The final challenge, *Blackness*, is a 7×7 maze
  that wraps: `scan` shows *yourself* in most directions, and the one direction showing
  **The Emperor** is the way out. Do not try to fight through it. Reward upgrades to a
  **Lifetime Pass** (+9 damroll, score +45) — see `memory/aardwolf-arena-goal.md` for the
  full route and the 50,000 gold upgrade step.
- **Grind to 96 — done.** Elemental Chaos and its gale rooms are good grinding.

## 13. Current state

See `memory/aardwolf-campaign-in-progress.md` — it carries the live campaign, its
deadline, where the character is parked, and what needs restocking. Check it before
starting anything; it is written to be the first thing a new session reads.
