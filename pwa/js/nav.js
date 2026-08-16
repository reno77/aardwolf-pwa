// nav.js -- the one pathfinder and the one movement executor.
//
// This replaces four separate BFS implementations (findDbPath, findDbDistances,
// findPath, mapFindPath) and three ad-hoc ways of walking a path.
//
// Two things the old code got structurally wrong:
//
//  1. It synthesised a reverse edge for every exit with
//     `{n:'s',s:'n',...}[d] || d`. The `|| d` fallback made 'enter portal'
//     reverse to 'enter portal', so the client believed it could walk back
//     through a one-way portal, and ne/nw/se/sw reversed to themselves.
//     Exits here are strictly directed: a reverse edge exists only if the
//     database actually contains one.
//
//  2. It validated custom exits against GMCP by asking whether the room's exit
//     list contained the key 'other'. Aardwolf's room.info.exits only ever
//     contains n/e/s/w/u/d -- custom exits are explicitly excluded from it --
//     so that test was false every time and *every* custom-exit step aborted
//     with "is not available here". A custom exit is now simply typed.

import { mapHints, sqlDb } from './db.js';
import { gaardianCandidateUids, gaardianPath, reconnectDanglingExits } from './roomid.js';
import { parseKeySource } from './keys.js';
import { currentRoom, charState, effectiveLevel, onCharStateChange,
         STATE_READY, STATE_FIGHTING, STATE_SLEEPING, STATE_RESTING,
         STATE_RUNNING, movesFraction, charMoves, charMaxMoves, hpFraction, manaFraction } from './gmcp.js';
import { queueMove, sendCmd, sendCmdRaw, setWalkCanceller } from './net.js';
import { errandFor, runErrand } from './errand.js';
import { lastRoomChars } from './questtag.js';
import { appendOutput } from './ui.js';

// =============================================================================
// PATHFINDING
// =============================================================================

const MAX_FRONTIER = 4000;   // guard against pathological SQL parameter counts

// What a step costs the search. These are not distances -- every exit is one room
// -- they are how much we would rather not use it.
//
//   STEP    a compass direction. The thing we are counting.
//   CUSTOM  a command to type. It might need an item we are not carrying, a door
//           to open, or a password the character has not learned; the walker has
//           a whole recovery path for those failures, which is the point -- they
//           fail. Worth it only when it saves a real walk.
//   RANDOM  the destination is one sample of where the exit went once, not a
//           fact. Avoid unless there is nothing else.
//
// Kobold Siege Camp is why this exists. The area entrance has four `say <password>`
// exits that teleport deep into the camp, and "A secluded corner" is 10 plain
// steps away (e e s e n n n n e e) but only 7 HOPS through one of them:
//
//     say glurpp | leave tent | n n n n e
//
// Breadth-first counts hops, so the teleport won every time and the walker sat
// there saying "glurpp" -- a password the character may never have been told, at
// which point nothing moves and there is nothing to recover from. Three extra
// steps is a trade any player would make; hop-counting could not express it.
const STEP_COST   = 1;
const CUSTOM_COST = 8;
const RANDOM_COST = 25;
// Speech is its own, worse category, and 8 was not enough. In Nenukon the
// campaign mob sat in A Campsite, two hops away as `say lynx | s` (cost 9) and
// ten plain steps away by road (cost 10) -- so the password won by one point, the
// character had never been told it, and the walk fell apart. See SPEECH below for
// why these are worth avoiding rather than merely costing: they fail SILENTLY.
const SPEECH_COST = 40;
// A compass walk of 300 rooms still resolves, with room to spare for the custom
// exits an area like Diamond Soul Revelation genuinely requires.
const MAX_COST = 600;

function quoteList(items){ return items.map(()=>'?').join(','); }

/**
 * An exit whose command is a spoken password.
 *
 * 182 of them across 53 areas, and every single one is recorded as a MOVE -- not
 * one is a prerequisite. That matters twice over:
 *
 *  - The password is area-quest knowledge the character may never have been told,
 *    and saying a word you have not learned does exactly nothing.
 *  - It fails SILENTLY. Every other blocked exit says something the walker can
 *    read -- "The door is locked.", "You cannot go that way." -- but a failed
 *    password just prints you saying a word, so there is no failure to detect and
 *    no message to react to.
 *
 * So they are costed near-last-resort, and treated as movement-only below.
 */
function isSpeechExit(dir){ return /^say\b/i.test(String(dir || '')); }

function stepCost(dir, random){
  const base = !isCustomExit(dir) ? STEP_COST
             : isSpeechExit(dir)  ? SPEECH_COST
             : CUSTOM_COST;
  return (random ? RANDOM_COST : 0) + base;
}

/**
 * Cheapest path from `fromUid` to `toUid` as [{dir, uid}, ...].
 *
 * Uniform-cost search (Dijkstra with the small integer weights above), run
 * backwards from the destination: each round asks for every exit that lands in
 * the current frontier, so this is still one indexed query per round rather than
 * the old "SELECT everything FROM exits" on every step of every walk.
 *
 * The queue is a bucket per cost. Weights are small integers, so ascending cost
 * order comes for free and the batching survives -- a per-node priority queue
 * would mean one SQL round trip per room, which is what the batched design exists
 * to avoid. Settled nodes are filtered in JS rather than with `from_uid NOT IN
 * (...)`: that list grew with the search and was bound for a parameter-count
 * limit, and re-reading a few edges is cheaper than binding thousands of values.
 *
 * Returns null when no path exists, [] when already there.
 */
export function findPath(fromUid, toUid, opts){
  if(!sqlDb || !fromUid || !toUid) return null;
  if(fromUid === toUid) return [];
  const maxLevel = (opts && opts.level) || effectiveLevel();
  const start = String(fromUid), goal = String(toUid);

  const buckets = new Map();      // cost -> [uid]
  const best = new Map([[goal, 0]]);
  const settled = new Set();
  // cameFrom[room] = {dir, next} : from `room`, go `dir` to reach `next`.
  const cameFrom = new Map();
  buckets.set(0, [goal]);

  const rebuild = () => {
    const path = [];
    let cur = start;
    while(cur !== goal){
      const step = cameFrom.get(cur);
      if(!step) return null;
      path.push({dir: step.dir, uid: step.next, random: step.random});
      cur = step.next;
    }
    return path;
  };

  for(let cost = 0; cost <= MAX_COST; cost++){
    const bucket = buckets.get(cost);
    if(!bucket) continue;
    buckets.delete(cost);
    // A node can sit in several buckets; only the first one to come up is final.
    const frontier = bucket.filter(u => !settled.has(u) && best.get(u) === cost);
    if(!frontier.length) continue;
    for(const u of frontier) settled.add(u);
    // Reached at its cheapest -- and because costs come up in order, cheapest
    // overall.
    if(settled.has(start)) return rebuild();
    if(frontier.length > MAX_FRONTIER) break;

    const res = sqlDb.exec(
      `SELECT from_uid, dir, to_uid, COALESCE(random,0) FROM exits
        WHERE to_uid IN (${quoteList(frontier)})
          AND level <= ?
        ORDER BY length(dir) ASC`,
      [...frontier, maxLevel]);
    for(const [f, dir, t, rnd] of (res[0]?.values || [])){
      const from = String(f);
      if(settled.has(from)) continue;
      const next = cost + stepCost(dir, rnd);
      if(next > MAX_COST) continue;
      const known = best.get(from);
      if(known !== undefined && known <= next) continue;
      best.set(from, next);
      cameFrom.set(from, {dir, next: String(t), random: !!rnd});
      if(!buckets.has(next)) buckets.set(next, []);
      buckets.get(next).push(from);
    }
  }
  return settled.has(start) ? rebuild() : null;
}

/** True when `dir` is a command to type rather than a compass direction. */
export function isCustomExit(dir){ return String(dir).length > 1; }

/**
 * A route from `fromUid`, falling back to the room's unresolved identities.
 *
 * A live room whose name repeats in its area is deliberately left unidentified
 * (see gaardianCandidateUids): the map cannot tell which "Backstage" you are in
 * without more evidence. Unidentified means no edges into the imported area,
 * which made findPath return null and the campaign helper report "no route" for
 * a mob three rooms away in a fully mapped area.
 *
 * The candidate set is precisely the list of hypotheses, so path from each and
 * take the shortest. It may be the wrong twin's route -- but walking is what
 * produces the evidence that settles it, and the walker re-paths every step, so
 * a wrong guess corrects itself as soon as an unambiguous room is entered.
 *
 * `ruledOut` holds candidates a failed move has already disproved -- see the
 * dead-end handler, which turns walking into elimination over the candidate set.
 *
 * Returns {path, viaCandidate, choices} with path null if nothing works.
 */
export function planRoute(fromUid, targetUid, ruledOut){
  const direct = findPath(fromUid, targetUid);
  if(direct) return {path: direct, viaCandidate: null, choices: 0};

  const skip = ruledOut || [];
  const candidates = gaardianCandidateUids(fromUid).filter(c => !skip.includes(c));
  let best = null, bestFrom = null;
  for(const c of candidates){
    if(c === fromUid) continue;
    const p = findPath(c, targetUid);
    if(p && (best === null || p.length < best.length)){ best = p; bestFrom = c; }
  }
  return {path: best, viaCandidate: bestFrom, choices: candidates.length};
}

/**
 * Print what Gaardian knows about getting past a blocked exit.
 *
 * The map records the key, where to buy it and for how much -- 882 exits across
 * 132 areas carry a note. Confirmed at the Keep of the Kobaloi: "a Kobalos
 * palace pass ... purchased from Palgern Cavedwoller for 50 gold", in A Cramped
 * Cave. Saying only "the way is guarded" wasted information already on disk.
 */
// The last exit that refused us, with whatever Gaardian knows about getting
// through it. Read by snd.js so the campaign helper can go and buy the key.
let lastGate = null;
export function lastGateInfo(){ return lastGate; }
export function clearGateInfo(){ lastGate = null; }

function keyRowFor(uid, dir){
  try {
    const r = sqlDb.exec('SELECT key_name, key_desc, key_room FROM exits WHERE from_uid=? AND dir=?',
      [String(uid), dir]);
    if(r.length && r[0].values.length){
      const row = r[0].values[0];
      if(row[0] || row[1]) return row;
    }
  } catch(e){ /* no row */ }
  return null;
}

// Mobs that are standing there because of the door. Aardwolf writes them into the
// room the same way every time: "An ugly looking Yurgach stands on guard before the
// gate", "A Gate Keeper is here, guarding the Citadel entrance".
const DOORKEEPER = /\b(?:guard(?:s|ing|ed)?|sentry|sentries|keeper|watch(?:man|men)|doorman|gatekeeper)\b/i;
// Words that are description, not something `kill` will match.
const NOT_A_KEYWORD = new Set(['a','an','the','is','are','here','stands','stand','standing',
  'on','before','guard','guarding','guards','looking','ugly','before','at','in','of','this',
  'his','her','their','with','and','you','it','to','from','by','who','that']);

/**
 * No key note in the map, but something in this room is guarding the way.
 *
 * 882 exits carry a Gaardian key note and the rest carry nothing at all -- the
 * black gate into the Yurgach Domain's Black Tower is one of the silent ones, and
 * the room says out loud what the map does not: "unless you carry the key, you can
 * go no further", with two Yurgach standing on guard in front of it. The mob in the
 * room is the lead, so hand it to the key machinery as one: it already knows how to
 * kill a holder and loot the corpse, which matters here more than usual because the
 * keys in this area rot within a couple of ticks of the kill.
 */
function gateFromRoom(dir){
  const lines = lastRoomChars();
  for(const line of lines){
    const text = String(line || '');
    if(!DOORKEEPER.test(text)) continue;
    const words = (text.toLowerCase().match(/[a-z]+/g) || [])
      .filter(w => w.length > 2 && !NOT_A_KEYWORD.has(w));
    if(!words.length) continue;
    // The distinctive word, which for a mob name is the longest one: "yurgach"
    // out of "an ugly looking Yurgach stands on guard before the gate".
    const kw = words.sort((a, b) => b.length - a.length)[0];
    lastGate = {fromUid: String(currentRoom.uid || ''), dir, keyName: null,
                keyDesc: 'the room says it is guarded', keyRoom: null,
                source: {kind: 'mob', mob: kw, fromRoom: true}};
    appendOutput('[nav] the map has no key for that way, but "' + text.trim() + '"\n'
      + '      is standing over it -- treating ' + kw + ' as the key holder.\n','quest');
    return true;
  }
  return false;
}

function reportKeyFor(fromUid, dir){
  if(!sqlDb || !fromUid || !dir) return false;
  // The live uid first -- but a room that was never identified keeps its Gaardian
  // twin as a separate row, and the key note is on THAT one. Which is the case
  // that matters: an unidentified room is exactly where the walker gets stuck,
  // and reporting nothing there is how "the way is guarded" lost the note saying
  // which key and where to get it.
  let row = keyRowFor(fromUid, dir);
  if(!row){
    for(const c of gaardianCandidateUids(fromUid)){
      row = keyRowFor(c, dir);
      if(row) break;
    }
  }
  if(!row) return gateFromRoom(dir);
  const [keyName, keyDesc, keyRoom] = row;
  const src = parseKeySource(keyDesc);
  lastGate = {fromUid: String(fromUid), dir, keyName: keyName || null,
              keyDesc: src.note || null, keyRoom: keyRoom || null, source: src};
  appendOutput('[nav] you need ' + (keyName || 'a key') + ' for that way\n', 'quest');
  // Say what to DO, not just what the map happens to store. The note is the only
  // lead there is, and for two thirds of the 882 of them the answer is "a named
  // mob is carrying it".
  if(src.kind === 'mob'){
    appendOutput('       it is carried by ' + src.mob + '\n', 'quest');
  } else if(src.kind === 'buy'){
    appendOutput('       buy it' + (src.who ? ' from ' + src.who : '')
      + (src.price ? ' for ' + src.price + ' gold' : '')
      + (keyRoom ? ', in "' + keyRoom + '"' : '') + '\n', 'quest');
  } else if(src.kind === 'quest'){
    appendOutput('       area quest reward -- not something to fetch\n', 'quest');
  } else if(src.note){
    appendOutput('       ' + src.note + '\n', 'quest');
  }
  if(keyRoom && src.kind !== 'buy') appendOutput('       map says: "' + keyRoom + '"\n', 'quest');
  return true;
}

// =============================================================================
// THE WALKER
// =============================================================================
//
// One step at a time: send, record the room we expect, and let the next GMCP
// room.info confirm it. That is the correct pacing primitive -- it is what the
// Aardwolf mapper's walkto mode does -- and it replaces the old 500ms blanket
// throttle that silently dropped steps.

// Bump when shipping a client change you will be asked about. /navdiag prints
// it, so "still the same error" can be told apart from "still the old code".
export const NAV_BUILD = 'nav-6.6';

const STEP_TIMEOUT_MS = 6000;
const MAX_REPATH = 5;
// A maze is crossed by trying and re-trying, so random exits get their own,
// much larger budget rather than spending the re-path one on the first corner.
const MAX_RANDOM_STEPS = 40;
// How often one walk may enter the same room before it is a loop rather than a
// route. Four, not two: a long legitimate route can cross a hub twice.
const MAX_ROOM_VISITS = 4;
// Below this, stop walking and heal. Not a cautious number: at 40% of a 3067hp bar the
// character can still absorb the two or three rooms it takes to get somewhere safe, and
// anything lower is betting the morgue on the next room being empty.
const HEALTH_FLOOR = 0.40;
const MAX_WALK_HEALS = 10;

let walk = null;   // {targetUid, path, expectUid, lastFrom, lastDir, repaths, timer, onDone, onFail, opened}

export function isWalking(){ return !!walk; }

// =============================================================================
// PROBING FOR A ROUTE THAT THE MAP DOES NOT HAVE
// =============================================================================
// Some areas are recorded as several disconnected islands, because the links
// between them are not exits Gaardian could record. The planes are the clearest
// case: The Lower Planes and The Upper Planes are each a stack of LAYERS, every
// layer a closed component of the reference map, and the way between them is an
// ordinary `u` or `d` that simply is not in the data. Confirmed by hand in the
// Twin Paradises, where `u` from the Shurrock layer landed on Dothion -- the map
// had said "no route" between two rooms one step apart.
//
// GMCP publishes the exits of whatever room you are standing in, and the client
// records an edge the first time one is walked. So the missing link is one move
// away from being known: take exits the map has no edge for and check, after each,
// whether the destination has become reachable. Bounded, because this is a walk
// around a live area, not a search.
const PROBE_BUDGET = 40;
// How many times a probe may try a route the map offers before concluding the map
// is not going to produce a usable one. Each failed attempt teaches the walker
// something (a deleted edge, a level=999 marker), so a few are worth having --
// but not unboundedly, or a maze becomes an infinite walk.
const MAX_PROBE_WALKS = 4;

/** True when the map already holds an edge for `dir` out of `uid`. */
function edgeKnown(uid, dir){
  try {
    const r = sqlDb.exec('SELECT 1 FROM exits WHERE from_uid=? AND dir=?', [String(uid), dir]);
    return !!(r.length && r[0].values.length);
  } catch(e){ return false; }
}

/**
 * Walk about taking unmapped exits until `targetUid` becomes reachable.
 *
 * Untried exits are preferred, and `u`/`d` before the compass, because a layered
 * area stacks vertically and that is where the missing link almost always is.
 */
export function exploreTo(targetUid, onDone, onFail, budget){
  if(!sqlDb || !targetUid){ if(onFail) onFail('no map'); return; }
  const limit = budget || PROBE_BUDGET;
  const tried = new Set();
  let moves = 0, walks = 0;

  const step = () => {
    const p = findPath(currentRoom.uid, targetUid);
    if(p){
      appendOutput('[nav] probing found a way through after ' + moves + ' move(s)\n','system');
      walks++;
      walkTo(targetUid, onDone, (why)=>{
        // The route the map offered was not walkable after all -- a door we cannot
        // open, an item we do not carry, a maze that loops. Giving up here defeats
        // the purpose of being in this function: keep probing, because the walker
        // has just marked whatever blocked it and the next search will avoid it.
        if(walks >= MAX_PROBE_WALKS || moves >= limit){
          if(onFail) onFail(why);
          return;
        }
        appendOutput('[nav] that route did not work (' + why + '); still probing\n','system');
        setTimeout(step, 900);
      });
      return;
    }
    if(moves >= limit){
      if(onFail) onFail('probed ' + moves + ' room(s) without finding a route');
      return;
    }
    const here = String(currentRoom.uid || '');
    const exits = currentRoom.exits || [];
    // u/d first: layers stack, and that is the link the data is missing.
    const order = ['u', 'd', 'n', 'e', 's', 'w'];
    const open = order.filter(d => exits.includes(d) && !tried.has(here + '|' + d));
    // An exit with no edge in the map is the one that can teach us something.
    const pick = open.find(d => !edgeKnown(here, d)) || open[0];
    if(!pick){
      if(onFail) onFail('nothing left to probe from ' + (currentRoom.name || 'here'));
      return;
    }
    tried.add(here + '|' + pick);
    moves++;
    queueMove(pick, {fromWalker: true});
    // Whether or not that moved us, look again: a refused exit is information too,
    // and gmcp.js has recorded whatever the move taught us by now.
    setTimeout(step, 1800);
  };

  appendOutput('[nav] no mapped route; probing exits for one (up to ' + limit + ' moves)\n','system');
  step();
}

function clearStepTimer(){
  if(walk && walk.timer){ clearTimeout(walk.timer); walk.timer = null; }
}

function finish(ok, reason){
  const w = walk;
  walk = null;
  setWalkCanceller(null);
  if(!w) return;
  if(w.timer) clearTimeout(w.timer);
  if(ok){
    if(w.onDone) w.onDone();
  } else {
    appendOutput('[nav] ' + reason + '\n', 'error');
    if(w.onFail) w.onFail(reason);
  }
}

export function cancelWalk(reason){
  if(!walk) return;
  clearStepTimer();
  const w = walk;
  walk = null;
  setWalkCanceller(null);
  if(w.onFail) w.onFail(reason || 'cancelled');
}

/**
 * Walk to `targetUid`, one confirmed step at a time.
 * onDone/onFail are optional callbacks.
 */
export function walkTo(targetUid, onDone, onFail, opts){
  if(!sqlDb){ appendOutput('[nav] no map database\n','error'); return false; }
  if(!currentRoom.uid){
    appendOutput('[nav] current room unknown -- walk one room to set it\n','error');
    return false;
  }
  if(currentRoom.uid === targetUid){ if(onDone) onDone(); return true; }
  // Can we afford to walk at all? Movement costs moves, and at zero the character simply
  // does not go: every step fails, and the failures read as map errors -- "cannot go that
  // way", "the portal did not fire" -- while the real answer was 37 points of 3129. Say the
  // true thing instead, so the caller can rest rather than re-plan.
  if(movesFraction() < 0.02){
    appendOutput('[nav] no movement points left ('+charMoves+'/'+charMaxMoves
      + ') -- rest or sleep before walking anywhere.\n','error');
    if(onFail) onFail('out of movement points');
    return false;
  }

  let plan = planRoute(currentRoom.uid, targetUid);
  // A local route that is far longer than the reference map's is not a route, it is
  // damage. The local graph accumulates wrong edges -- every mis-anchored room and
  // every "corrected map" line leaves one -- and BFS will happily follow them: from
  // Aylor recall to Among the Philosophes it proposed twenty steps through bushes
  // and the Citadel gate, where the Gate Keepers are aggressive and set about the
  // character, while Gaardian's own map says eight steps south. Walking is not free
  // and it is not safe, so when the reference route is less than half the length,
  // take the reference route.
  if(plan.path && plan.path.length > 4){
    const ref = gaardianPath(currentRoom.uid, targetUid);
    if(ref && ref.length && ref.length * 2 <= plan.path.length){
      appendOutput('[nav] the local map wants ' + plan.path.length + ' steps and Gaardian says '
        + ref.length + '; taking the short way\n','system');
      plan = {path: ref, viaCandidate: null, choices: 0, fromReference: true};
    }
  }
  if(plan.path === null){
    // The map splits again every time a room is promoted: its Gaardian exits move
    // onto the live uid and GMCP wins the directions it already knew, orphaning
    // the Gaardian destinations. The deduction that rejoins them runs at load and
    // after an import, which is not often enough -- promotions happen mid-walk,
    // so a route that existed a moment ago can vanish underneath us.
    //
    // Run it here, where the cost is paid only when a route is actually missing,
    // and try once more before reporting failure.
    if(reconnectDanglingExits()) plan = planRoute(currentRoom.uid, targetUid);
  }
  if(plan.path === null){
    // Last resort, and the one that removes the human from the loop: compute the
    // route in the reference map instead of the local graph. Gaardian connects
    // rooms the local graph has been split apart on, and this is exactly the
    // calculation that had to be done by hand to reach The King's Royal Box.
    const ref = gaardianPath(currentRoom.uid, targetUid);
    if(ref && ref.length){
      appendOutput('[nav] the local map is split here; following Gaardian\'s own route: '
        + ref.map(p=>p.dir).join(' ') + '\n','system');
      plan = {path: ref, viaCandidate: null, choices: 0, fromReference: true};
    } else if(ref && !ref.length && currentRoom.uid === targetUid){
      if(onDone) onDone();
      return true;
    }
    // An EMPTY reference path means "both ends are the same Gaardian room", which
    // is true of any two of the ten rooms called "On the Oinos Gloom of Hades" --
    // and is emphatically not the same as having arrived. Reading it as success
    // reported the walk complete without moving a step, twice, while the character
    // stood in the wrong one of them unable to leave the plane.
  }
  const path = plan.path;
  if(path === null){
    appendOutput('[nav] no route to that room from here'
      + (plan.choices ? ' (nor from any of the ' + plan.choices + ' rooms this could be)' : '')
      + '\n','error');
    if(onFail) onFail('no route');
    return false;
  }
  if(!path.length){ if(onDone) onDone(); return true; }
  if(plan.viaCandidate){
    appendOutput('[nav] this room is not identified yet (' + plan.choices
      + ' it could be); taking the shortest route from them\n','system');
  }

  cancelWalk('superseded');
  // A Gaardian target uid is a placeholder that no live room will ever equal, so
  // remember the room NAME too and treat arriving there as success.
  //
  // `opts.ignoreName` turns that off, for the one case where it is exactly
  // wrong: walking between two rooms that SHARE a name (snd.js's twin sweep).
  // There the name matches before the first step, so the walk would finish
  // without moving.
  let targetName = null;
  if(!(opts && opts.ignoreName)){
    try {
      const r = sqlDb.exec('SELECT name FROM rooms WHERE uid=?', [targetUid]);
      if(r.length && r[0].values.length) targetName = String(r[0].values[0][0]||'').toLowerCase();
    } catch(e){ /* name is a convenience, not a requirement */ }
  }
  walk = {targetUid, targetName, path, plan: path.slice(1), expectUid:null,
          lastFrom:null, lastDir:null, repaths:0, timer:null, onDone, onFail,
          // A route planned from a candidate is a hypothesis about which room we
          // are in, so the uids along it are not predictions to hold the walk to.
          opened:false, blind: !!(plan.viaCandidate || plan.fromReference),
          viaCandidate: plan.viaCandidate, ruledOut: []};
  setWalkCanceller(cancelWalk);
  appendOutput(`[nav] walking ${path.length} step${path.length>1?'s':''}: `
    + path.map(p=>p.dir).join(' ') + '\n', 'system');
  step();
  return true;
}

function step(){
  if(!walk) return;
  if(currentRoom.uid === walk.targetUid){ finish(true); return; }
  if(walk.targetName && String(currentRoom.name||'').toLowerCase() === walk.targetName){
    finish(true); return;
  }

  // Character must be able to move. Fighting is a pause, not a failure.
  if(charState === STATE_FIGHTING || charState === STATE_RUNNING){
    clearStepTimer();
    walk.timer = setTimeout(step, 1500);
    return;
  }
  if(charState === STATE_SLEEPING || charState === STATE_RESTING){
    sendCmdRaw('stand');
    clearStepTimer();
    walk.timer = setTimeout(step, 1000);
    return;
  }

  // Hurt is a reason to stop walking.
  //
  // The walker had no health gate at all: inside the Yurgach Domain's Black Tower it
  // kept stepping at 19% of 3067hp, through rooms whose guards attack on sight, while
  // re-pathing round a stairway it had already visited four times. Nothing in the loop
  // would ever have chosen to stop -- the character would have died mid-route, and the
  // morgue costs experience and stats. Walking is the one thing that keeps ADDING
  // fights, so it is the thing to stop.
  //
  // Heal first if there is mana for it; the run continues by itself when it works.
  if(hpFraction() < HEALTH_FLOOR){
    const pct = Math.round(hpFraction() * 100);
    if(manaFraction() > 0.15 && (walk.heals = (walk.heals || 0) + 1) <= MAX_WALK_HEALS){
      appendOutput('[nav] ' + pct + '% health -- healing before going on ('
        + walk.heals + '/' + MAX_WALK_HEALS + ').\n','system');
      sendCmd('cast heal');
      clearStepTimer();
      walk.timer = setTimeout(step, 5000);
      return;
    }
    finish(false, pct + '% health and no mana to fix it -- stopping here rather than'
      + ' walking on into something');
    return;
  }

  // Re-path from where we actually are rather than trusting the plan. Once an
  // unambiguous room is entered, cascadeAnchors identifies the ones behind it
  // too, so a walk that started as a guess turns into a real route mid-way.
  const replan = planRoute(currentRoom.uid, walk.targetUid, walk.ruledOut);
  walk.viaCandidate = replan.viaCandidate;
  let path = replan.path;
  let fromReference = false;
  if(path === null){
    const ref = gaardianPath(currentRoom.uid, walk.targetUid);
    if(ref && ref.length){ path = ref; fromReference = true; }
    else if(ref && !ref.length){ finish(true); return; }
  }
  if(path === null){
    // Re-pathing fails routinely while crossing an area imported from Gaardian:
    // every step into a skeleton room arrives with a real uid that is not yet in
    // the graph, so `currentRoom.uid` has no outgoing edges even though the route
    // we started with is still perfectly good. Fall back to the remaining plan --
    // that is what a speedwalk does -- and only give up if the plan runs out.
    if(walk.plan && walk.plan.length){
      path = walk.plan;
      if(!walk.blind){
        walk.blind = true;
        appendOutput('[nav] room not in the map yet; following the planned route\n','system');
      }
    } else {
      finish(false, 'lost the route in ' + (currentRoom.name||'?')
        + (walk.gateNote ? ' -- ' + walk.gateNote + ', and there is no way round' : ''));
      return;
    }
  } else {
    // A route planned from a candidate -- or from the reference map, which knows
    // directions but no live uids -- is a hypothesis, so uid mismatches stay
    // expected until the room is anchored.
    walk.blind = !!(replan.viaCandidate || fromReference);
  }
  // A prerequisite already performed from this room must not be re-planned: the
  // map still says the way through here is `give ... castle guard`, and we have
  // given it. Left in, re-pathing would hand the pass over forever.
  while(path.length && walk.done && isCustomExit(path[0].dir)
        && walk.done.has(currentRoom.uid + '|' + path[0].dir)){
    path = path.slice(1);
  }
  if(!path.length){ finish(true); return; }
  walk.path = path;
  // Keep the tail of the plan so a later re-path failure has something to follow.
  walk.plan = path.slice(1);

  const next = path[0];
  const dir = next.dir;

  if(!isCustomExit(dir)){
    // A compass direction the map has and GMCP does not is usually a hidden or
    // stuck door, so try opening it once. Note this is NOT how an ordinary
    // closed door is caught: room.info lists closed doors like any other exit
    // ("Before the fortress" reports "n" while answering "The doubledoor is
    // closed."), so those are handled by the text triggers in BLOCKED below.
    const available = (currentRoom.exits || []).map(d => String(d).toLowerCase());
    if(available.length && !available.includes(dir.toLowerCase()) && !walk.opened){
      walk.opened = true;
      // Record the edge we are attempting BEFORE sending, so that "There is no
      // door <dir> from here" can delete the right one. Without this, lastDir
      // still held the previous step's direction and the reply was blamed on
      // whichever edge we last walked.
      walk.lastFrom = currentRoom.uid;
      walk.lastDir = dir;
      walk.lastArea = String(currentRoom.area || '');
      appendOutput('[nav] ' + dir + ' is not open here; trying "open ' + dir + '"\n','system');
      sendCmdRaw('open ' + dir);
      clearStepTimer();
      walk.timer = setTimeout(step, 800);
      return;
    }
  }
  // A custom exit is never validated: Aardwolf does not publish custom exits in
  // GMCP, so there is nothing to validate against. Type it and see.

  walk.opened = false;
  walk.lastFrom = currentRoom.uid;
  walk.lastDir = dir;
  walk.lastArea = String(currentRoom.area || '');
  // A random exit lands you somewhere the map cannot predict, so claim no
  // expectation: onRoomChanged must not "correct" the edge to whichever room
  // this particular roll produced, and landing elsewhere must not count against
  // the re-path budget. Crossing a maze IS re-pathing from wherever you come
  // out, so the only thing worth bounding is how long that may go on for.
  if(next.random){
    walk.expectUid = null;
    walk.randomSteps = (walk.randomSteps || 0) + 1;
    if(walk.randomSteps > MAX_RANDOM_STEPS){
      finish(false, 'still lost after ' + MAX_RANDOM_STEPS + ' moves in ' + (currentRoom.name || 'the maze'));
      return;
    }
    if(walk.randomSteps === 1){
      appendOutput('[nav] the way through is a random exit; feeling my way\n','system');
    }
  } else {
    walk.expectUid = next.uid;
  }
  clearStepTimer();
  walk.timer = setTimeout(() => {
    if(!walk) return;
    // The move may well have landed and the confirmation simply be late: GMCP
    // arrives behind the move over a slow link, and this used to abort a walk
    // that was in fact progressing -- "it timed out but I still got moved".
    // Trust the room we are actually in over the clock.
    if(currentRoom.uid && currentRoom.uid !== walk.lastFrom){
      onRoomChanged();
      return;
    }
    // A custom exit that did not move us is very often not a movement at all.
    // 308 of Gaardian's 786 custom exits are prerequisites -- `give
    // 'identification pass' 'castle guard'`, `Knock door`, `say see a manager`,
    // `wave your hands wildly`. They satisfy a guard or open a way, and the step
    // AFTER them is the move. Waiting for a room change that was never coming
    // timed the walk out in The Castle of Knossos with the pass already handed
    // over, two steps short of the Senate.
    // ...but a spoken password is never a prerequisite (see isSpeechExit: all 182
    // of them are movements), so if it did not move us it FAILED -- the character
    // has not been told that word. Carrying on is then actively destructive: the
    // rest of the plan is a route out of the room we were supposed to arrive in,
    // and walking it from where we actually are made the walker "correct" six
    // perfectly good edges in Nenukon before giving up.
    //
    // Mark the exit unroutable for this character with the level=999 marker the
    // map already uses for exits we cannot pass, and re-path from here.
    if(isCustomExit(walk.lastDir) && isSpeechExit(walk.lastDir)){
      if(walk.lastFrom){
        try {
          sqlDb.run('UPDATE exits SET level=999 WHERE from_uid=? AND dir=?',
            [walk.lastFrom, walk.lastDir]);
        } catch(e){ console.error(e); }
      }
      appendOutput('[nav] "' + walk.lastDir + '" did nothing -- that password has not been\n'
        + '      learned, so it is not a way through for you. Routing around it.\n', 'system');
      if(++walk.repaths <= MAX_REPATH){
        walk.plan = null;
        walk.blind = false;
        clearStepTimer();
        walk.timer = setTimeout(step, 600);
        return;
      }
      finish(false, 'no route that avoids "' + walk.lastDir + '"');
      return;
    }
    if(isCustomExit(walk.lastDir)){
      walk.done = walk.done || new Set();
      walk.done.add(walk.lastFrom + '|' + walk.lastDir);
      appendOutput('[nav] "' + walk.lastDir + '" moved us nowhere; taking it as a'
        + ' prerequisite and carrying on\n', 'system');
      step();
      return;
    }
    // Genuinely still in the same room: the command may have been swallowed.
    walk.stalls = (walk.stalls || 0) + 1;
    if(walk.stalls < 2){
      appendOutput('[nav] no reply to that move; retrying\n', 'system');
      step();
      return;
    }
    finish(false, 'movement timed out in ' + (currentRoom.name || '?'));
  }, STEP_TIMEOUT_MS);

  if(isCustomExit(dir)) sendCustomExit(dir);
  else queueMove(dir, {fromWalker:true});
}

/**
 * Send a custom exit, which may be SEVERAL commands.
 *
 * The reference map writes a multi-step exit with semicolons -- the Keep of the
 * Asherodan's elevator is `hold 'steel crank';turn crank` -- and Aardwolf does not
 * treat `;` as a separator. Sent whole, the MUD read it as one command and answered:
 *
 *     > hold 'steel crank';turn crank
 *     Your race does not have a ;turn crank wear location.
 *
 * so the exit could never work, whatever we were carrying. Split and sent one at a
 * time, `hold 'steel crank'` takes the crank and `turn crank` raises the elevator.
 * 786 exits in the reference map are arbitrary commands and this affects every one
 * of them that has more than a single step.
 */
function sendCustomExit(dir){
  const parts = String(dir).split(';').map(s => s.trim()).filter(Boolean);
  if(parts.length < 2){ sendCmdRaw(dir); return; }
  let d = 0;
  for(const p of parts){ setTimeout(()=>sendCmdRaw(p), d); d += 800; }
}

/** Called from gmcp.js on every room.info. */
export function onRoomChanged(){
  if(coordWalk){ coordOnRoomChanged(); return; }
  if(!walk) return;
  clearStepTimer();
  walk.stalls = 0;          // we moved, so the link is alive

  if(currentRoom.uid === walk.targetUid){ finish(true); return; }
  if(walk.targetName && String(currentRoom.name||'').toLowerCase() === walk.targetName){
    finish(true); return;
  }

  // Going in circles.
  //
  // Some areas are mazes that hand you back the room you just left, and the
  // reference map records their rooms as ordinary ones -- so a route straight
  // through the middle looks perfectly good. The Diamond Mines say it out loud:
  // "The tunnel continues on for many miles ... You begin to think the tunnels are
  // running you around in circles." The walker ground through that maze taking
  // damage until the character died at 1hp, having been sent down a nineteen-step
  // "walk" that does not actually go anywhere.
  //
  // Counting visits per room catches both shapes: a maze that returns the same uid
  // and one whose rooms are distinct but keep recurring. Deliberately generous,
  // because a legitimate long route can cross a hub more than once.
  if(currentRoom.uid){
    walk.visits = walk.visits || new Map();
    const seen = (walk.visits.get(currentRoom.uid) || 0) + 1;
    walk.visits.set(currentRoom.uid, seen);
    if(seen >= MAX_ROOM_VISITS){
      finish(false, 'going in circles in ' + (currentRoom.name || 'this area')
        + ' (' + seen + ' visits to the same room)');
      return;
    }
  }

  // While following a planned route through rooms the map does not know by uid,
  // "you are not where the map said" is the normal case, not an error: the
  // skeleton's uids are placeholders. Correcting edges and counting re-paths
  // there just burns the retry budget and aborts a walk that is going fine.
  if(walk.blind){ walk.expectUid = null; }

  if(walk.expectUid && currentRoom.uid !== walk.expectUid){
    // We moved, but not where the map said we would. Correct the edge rather
    // than walking the same wrong way again: the mapper calls this fix_up_exit.
    if(walk.lastFrom && walk.lastDir && currentRoom.uid){
      try {
        sqlDb.run('UPDATE exits SET to_uid=? WHERE from_uid=? AND dir=?',
          [currentRoom.uid, walk.lastFrom, walk.lastDir]);
        appendOutput(`[nav] corrected map: ${walk.lastDir} from that room leads here\n`,'system');
      } catch(e){ console.error(e); }
    }
    // A step that changed AREA is a trapdoor, not a wrong turn.
    //
    // Halls of the Damned has a shaft that drops you into the tombs next door, and it
    // is one-way: there is no route back, so re-pathing from where you land cannot
    // work. The walker did it anyway -- corrected the edge, re-planned, wandered the
    // wrong area, and ejected the character mid-hunt over and over, which is most of
    // what made one campaign target take hours. Worse, the corrected edge looks like
    // an ordinary exit afterwards, so the next path through that room falls down it
    // again.
    //
    // So: mark it never-auto-path (level 999, the same flag the Gaardian importer
    // uses for exits it will not plan through) and stop, saying what happened. The
    // room stays in the map and stays walkable by hand -- only automatic routing
    // avoids it.
    // The area we were standing in when the step went out, taken from GMCP rather than
    // looked up: the map only knows the area of a room it has already recorded, and the
    // rooms this matters for are exactly the ones being walked for the first time.
    const cameFromArea = walk.lastArea || (walk.lastFrom ? areaOfUid(walk.lastFrom) : null);
    const hereArea = String(currentRoom.area || '');
    // ...but only when the step was not SUPPOSED to cross a boundary. Plenty of routes
    // legitimately leave an area, and aborting those would break ordinary travel; if the
    // room we were aiming at is recorded in the area we actually reached, this is a
    // normal cross-area step that merely landed a room off.
    const expectedArea = walk.expectUid ? areaOfUid(walk.expectUid) : null;
    const meantToCross = expectedArea && hereArea && expectedArea === hereArea;
    if(cameFromArea && hereArea && cameFromArea !== hereArea && !meantToCross){
      try {
        sqlDb.run('UPDATE exits SET level=999 WHERE from_uid=? AND dir=?',
          [walk.lastFrom, walk.lastDir]);
      } catch(e){ console.error(e); }
      finish(false, '"' + walk.lastDir + '" dropped us out of ' + cameFromArea
        + ' into ' + hereArea + ' -- one-way exit, not routing through it again');
      return;
    }
    if(++walk.repaths > MAX_REPATH){
      finish(false, 'kept ending up somewhere unexpected; stopping');
      return;
    }
  }
  step();
}


/** Print up to three map hints relevant to `what`, once each per walk. */
const hintedAlready = new Set();
function showMapHints(what){
  try {
    const area = String(currentRoom.area || '');
    if(!area) return;
    for(const h of mapHints(area, what).slice(0, 3)){
      if(hintedAlready.has(h)) continue;   // the same note on every retry is noise
      hintedAlready.add(h);
      appendOutput('[map] ' + h + '\n','quest');
    }
  } catch(e){ /* hints are a bonus, never a failure path */ }
}
/** Which area the map records for a uid, or null when it has never been visited. */
function areaOfUid(uid){
  if(!sqlDb || !uid) return null;
  try {
    const r = sqlDb.exec('SELECT area FROM rooms WHERE uid=?', [String(uid)]);
    if(r.length && r[0].values.length){
      const a = r[0].values[0][0];
      return a ? String(a) : null;
    }
  } catch(e){ /* not in the map */ }
  return null;
}

// A move can fail with no room change at all, in which case room.info never
// arrives and only the step timeout would notice. These are the mapper's
// cancel_speedwalk triggers plus the door cases from Search-and-Destroy.
const BLOCKED = [
  {re:/^There is no exit in that direction/im,      msg:'no exit that way', deadEnd:true},
  {re:/^Alas, you cannot go that way/im,            msg:'cannot go that way', deadEnd:true},
  // The reply to a speculative `open <dir>`. It is NOT evidence that the exit is
  // fake: Behind the Screen in The Land of Oz answers this for its west exit,
  // which Gaardian records as a real door and which the room description says is
  // opened by a handle rather than by `open`. Deleting the edge here threw away
  // the only route to the target. Say nothing and let the pending step try the
  // direction; if that fails, "cannot go that way" removes it properly.
  {re:/^There is no door\b.*\bhere\b/im,            msg:null, ignore:true},
  // Any name for the door: "The door is closed.", "The wooden gate is closed.",
  // "The doubledoor is closed." Aardwolf names them after the area's furniture.
  {re:/^the \w+(?:\s+\w+)? is closed\.?\s*$/im,     msg:null, open:true},
  {re:/is closed\.$/im,                             msg:null, open:true},
  {re:/^The door is locked/im,                      msg:'the door is locked', locked:true},
  {re:/^You do not have a key for/im,               msg:'no key for that door', locked:true},
  {re:/^You must be standing first/im,              msg:null, stand:true},
  {re:/^You need to use a boat, fly, or swim/im,    msg:'need a boat or flight'},
  {re:/^You are regaining balance/im,               msg:null, retry:true},
  {re:/^You fumble about drunkenly/im,              msg:null, retry:true},
  {re:/^Magic walls bounce you back/im,             msg:'blocked by magic walls', noportal:true},
  // "Magical wards around the pile bounce you back." -- NOT the same message as
  // "Magic walls bounce you back", and it does not mean the room is noportal. It is
  // what a LOCKED door answers when you walk into it after `open` has already failed
  // with "You do not have a key for the pile", and it names the door rather than the
  // room. Without this line it matched nothing, so a locked exit in The Scarred Lands
  // read as an unexplained timeout instead of "you need the key" -- and the note the
  // map holds about how to get that key was never printed.
  {re:/^Magical wards around .* bounce you back/im,  msg:'that door is locked', locked:true},
  // A guard mob standing in the way. The exit exists and is open -- you are just
  // not allowed through it -- so the move produces speech and no room change,
  // which used to look like a timeout. Confirmed live at the Keep of the
  // Kobaloi: 'A Kobalos peace keeper says, "I'm sorry - only Kobaloi may enter
  // without an official pass to the Keep."'
  {re:/only \w+ may enter/im,                       msg:'a guard will not let you through', gated:true},
  {re:/\bmay not enter\b/im,                        msg:'a guard will not let you through', gated:true},
  {re:/\bblocks your way\b/im,                      msg:'something blocks the way',         gated:true},
  {re:/refuses to let you pass/im,                  msg:'a guard will not let you through', gated:true},
  {re:/\byou are not allowed\b/im,                  msg:'not allowed through there',        gated:true},
  {re:/\byou cannot enter\b/im,                     msg:'you cannot enter there',           gated:true},
  {re:/^You cannot (recall|return home) from this room/im, msg:'cannot recall here', norecall:true},
  // The reply to a prerequisite we cannot perform: `give 'identification pass'
  // 'castle guard'` when the pass is not in inventory. Treated as a plain move
  // failure this looked like success -- the give "moved us nowhere", so the walk
  // carried on to the `n` beyond the guard, failed it five times and deleted the
  // edge on each attempt. It is a hard stop with a nameable cause instead.
  {re:/^You (?:don'?t|do not) have that(?: item)?\.?\s*$/im, msg:null, missingItem:true},
];

/** The item a custom exit needs, if its command quotes one. */
function neededItem(dir){
  const s = String(dir || '');
  const quoted = s.match(/'([^']+)'/);
  if(quoted) return quoted[1];
  // Not every exit quotes its item. The Amusement Park's gates are `give ticket woman`
  // and the Ruins' shard exit is `wear drtempshard;w`, and with no name to report the
  // walker said "that way needs an item you are not carrying" -- true, useless, and it
  // left the errand lookup with nothing to match on. The word after the verb is the
  // item in all three of these shapes.
  const m = s.match(/^(?:give|hold|wear|wield|use|put|insert|show)\s+(\w[\w-]*)/i);
  return m ? m[1] : null;
}

/**
 * The word to type at the item: "steel crank" -> "crank".
 *
 * Aardwolf targets on keywords, and the head noun is the last word in every one of
 * these seen so far ("steel crank", "drtempshard", "silver key"). The rest of the
 * name is an adjective the room shares with its furniture.
 */
function itemKw(item){
  const words = String(item || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  return words.length ? words[words.length - 1] : String(item || '');
}

// A shut door, in whatever the area calls it. Checked before anything is deleted
// from the map, because both messages can arrive in one chunk: walking west into
// a shut gate produced "The wooden gate is closed." AND a cannot-go-that-way, and
// whichever pattern happened to be earlier in BLOCKED won. deadEnd won, so the
// walker deleted a perfectly good edge, lost the route, and abandoned the target
// -- in Diamond Soul Revelation, one gate short of the arboretum.
const SOMETHING_SHUT = /\b(?:is|are) closed\b|^the \w+ is closed/im;

/**
 * Put the step we just failed back on the plan, so it is retried and not skipped.
 *
 * step() sets `walk.plan = path.slice(1)` when it issues a move -- the plan is
 * "what comes after this one". If the move is then refused (a shut door, a stand,
 * a stumble) the step never happened, but the plan has already moved past it. In
 * blind mode, where the plan IS the route because re-pathing cannot see the room
 * we are in, that is how a walk carries on from a room it never entered:
 *
 *     > n
 *     The door is closed.
 *     > open n
 *     > w                    <- should have been n again
 *     [nav] there is no w here; removed it from the map
 *
 * and the wrong turn then deleted a perfectly good edge. Seen in Diamond Soul
 * Revelation, one room short of the arboretum.
 */
function unspendLastStep(){
  if(!walk || !walk.lastDir) return;
  if(!Array.isArray(walk.plan)) walk.plan = [];
  if(walk.plan[0] && walk.plan[0].dir === walk.lastDir) return;   // already there
  walk.plan.unshift({dir: walk.lastDir, uid: walk.expectUid || null, random: false});
}

/** Called from net.js for every line of MUD output while a walk is active. */
export function onMudText(text){
  if(!walk || !text) return;
  const shut = SOMETHING_SHUT.test(text);
  for(const b of BLOCKED){
    if(!b.re.test(text)) continue;
    // Never treat a shut door as a missing exit. The exit is there; it is closed,
    // and deleting it throws away map data to solve a problem `open` solves.
    if(b.deadEnd && shut) continue;
    // A prerequisite we cannot perform stops the walk, and says what is missing.
    // The route is real; we simply lack the item it wants.
    if(b.missingItem){
      if(!isCustomExit(walk.lastDir)) continue;
      const item = neededItem(walk.lastDir);
      // Try to pick it up before writing the exit off. Some of these items lie in
      // the room the exit leaves from, and one `get` is much cheaper than routing
      // around -- which in the Keep of the Asherodan meant six re-paths and then
      // "there is no way round it". Once per exit: if the item is not here, it is
      // not here.
      const tag = walk.lastFrom + '|' + walk.lastDir;
      if(item && !walk.gotTried) walk.gotTried = new Set();
      if(item && !walk.gotTried.has(tag)){
        walk.gotTried.add(tag);
        appendOutput('[nav] that way needs "'+item+'" -- trying to pick it up here\n','system');
        unspendLastStep();
        sendCmdRaw('get ' + itemKw(item));
        clearStepTimer();
        walk.timer = setTimeout(step, 900);
        return;
      }
      // Not here, but we may know where it IS. A recipe says which room and what to
      // do there; go and do it, then walk the original route again. The Keep's steel
      // crank is the case that needed this: it is two floors away in a room full of
      // aggressive vines, and no rule derives that from the exit string.
      const recipe = item && !walk.errandTried ? errandFor(currentRoom.area, item) : null;
      if(recipe){
        walk.errandTried = true;
        const resume = {uid: walk.targetUid, onDone: walk.onDone, onFail: walk.onFail};
        // Take the callbacks off the walk before cancelling it, or the cancel reports
        // the route as failed and whatever asked for it gives up: watched live, the
        // errand announced it was going for the crank and the campaign abandoned
        // Johnette in the same second, for "could not reach the target room
        // (fetching steel crank)".
        walk.onFail = null;
        walk.onDone = null;
        cancelWalk('fetching '+item);
        runErrand(recipe,
          (roomName, ok, no) => {
            const room = resolveNavName(roomName);
            if(!room){ no('no room called '+roomName+' in the map'); return; }
            walkTo(room.uid, ok, no, {ignoreName:true});
          },
          ()=>{
            appendOutput('[errand] got what the exit wanted; walking the route again.\n','quest');
            walkTo(resume.uid, resume.onDone, resume.onFail, {ignoreName:true});
          },
          (why)=>{
            appendOutput('[errand] could not fetch '+item+' ('+why+').\n','error');
            if(resume.onFail) resume.onFail('that way needs "'+item+'" and fetching it failed: '+why);
          });
        return;
      }
      // The route is real, we just cannot use it -- so park the exit at level 999
      // and look for another way, exactly as a guarded exit is handled. Reporting
      // and stopping here strands the character whenever the cheap route needs an
      // item and a long one exists: in the Ruins of Diamond Reach the map's only
      // preferred way out of the Mage's Den is `wear drtempshard;w` (6 steps to
      // the area entrance) while a perfectly good 19-step walk goes round, and the
      // walker kept choosing the shard and giving up.
      if(walk.lastFrom){
        try {
          sqlDb.run('UPDATE exits SET level=999 WHERE from_uid=? AND dir=?',
            [walk.lastFrom, walk.lastDir]);
        } catch(e){ console.error(e); }
      }
      appendOutput('[nav] that way needs ' + (item ? '"' + item + '"' : 'an item')
        + ' you are not carrying; routing around it\n','system');
      if(++walk.repaths <= MAX_REPATH){
        walk.plan = null;
        walk.blind = false;
        clearStepTimer();
        walk.timer = setTimeout(step, 600);
        return;
      }
      finish(false, 'that way needs ' + (item ? '"' + item + '"' : 'an item')
        + ', and there is no way round it (' + walk.lastDir + ')');
      return;
    }
    if(b.noportal && currentRoom.uid){
      try { sqlDb.run('UPDATE rooms SET noportal=1 WHERE uid=?', [currentRoom.uid]); } catch(e){}
    }
    if(b.norecall && currentRoom.uid){
      try { sqlDb.run('UPDATE rooms SET norecall=1 WHERE uid=?', [currentRoom.uid]); } catch(e){}
    }
    // "The door is closed." -- open it and go through.
    //
    // This used to share the `opened` latch with the SPECULATIVE open in step(), which
    // fires when the map has a direction GMCP does not list. Both happen at the same
    // door: the speculative open spends the latch, the real refusal arrives with it
    // already set, and the walk ends on "movement blocked" in front of a door that
    // would have opened. That is the Peasants' Seating door in the arena, where a troll
    // shuts it behind you, so it is closed EVERY time you arrive.
    //
    // Counted per door instead, so each one gets its own attempts and a door that keeps
    // swinging shut still cannot loop forever.
    const openKey = String(walk.lastFrom || '') + '|' + String(walk.lastDir || '');
    walk.openTries = walk.openTries || new Map();
    const opens = walk.openTries.get(openKey) || 0;
    if(b.open && walk.lastDir && !isCustomExit(walk.lastDir) && opens < 2){
      walk.openTries.set(openKey, opens + 1);
      walk.opened = true;
      unspendLastStep();
      sendCmdRaw('open ' + walk.lastDir);
      clearStepTimer();
      walk.timer = setTimeout(step, 800);
      return;
    }
    // Informational only: a step is already scheduled, let it run.
    if(b.ignore) return;
    // The map's own note about this obstacle, if it has one. `reportKeyFor` covers doors
    // the DB records a key for; this covers the rest -- password exits, give-this-to-that,
    // and guards -- which is where the graph alone leaves you guessing.
    showMapHints(walk.lastDir);
    if(b.locked) reportKeyFor(walk.lastFrom, walk.lastDir);
    if(b.stand){ unspendLastStep(); sendCmdRaw('stand'); clearStepTimer(); walk.timer = setTimeout(step, 800); return; }
    if(b.retry){ unspendLastStep(); clearStepTimer(); walk.timer = setTimeout(step, 1200); return; }
    // The exit is real but you are not allowed through it. Park it at level 999
    // -- the "never auto-path" marker the schema already has -- so the router
    // goes round rather than walking into the same guard every time. It stays in
    // the map because you can still use it yourself once you have the pass.
    // A LOCKED door counts too. Aardwolf unlocks by itself when you hold the key --
    // and checks the keyring -- so "The door is locked" means we do not have it, which
    // is the same situation as a guard: the exit is real and unusable right now. The
    // walker used to report and stop, which is how Sergeant Miryma stayed alive behind
    // one locked cell door while three of Warrior's Battlefield's five rooms were
    // already walked and reachable the long way round. reportKeyFor above has already
    // recorded the gate, so the key machinery still gets its turn if there is no way
    // round at all.
    if((b.gated || b.locked) && walk.lastFrom && walk.lastDir){
      try {
        sqlDb.run('UPDATE exits SET level=999 WHERE from_uid=? AND dir=?', [walk.lastFrom, walk.lastDir]);
        appendOutput('[nav] '+walk.lastDir+' from here is '
          + (b.locked ? 'locked and we have no key' : 'guarded')+'; routing around it\n','system');
      } catch(e){ console.error(e); }
      // Remembered so that if there turns out to be no way round, the failure
      // can say what actually stopped us instead of "lost the route".
      walk.gateNote = (b.msg || 'the way is guarded') + ' ('
        + walk.lastDir + ' from ' + (currentRoom.name || 'here') + ')';
      reportKeyFor(walk.lastFrom, walk.lastDir);
      if(++walk.repaths <= MAX_REPATH){
        walk.plan = null;
        walk.blind = false;
        clearStepTimer();
        walk.timer = setTimeout(step, 600);
        return;
      }
    }
    // The step came from a guess about which of several identically-named rooms
    // we are in, and the guess has just been disproved: this room does not have
    // that exit. Rule the candidate out and re-plan from the ones still standing,
    // rather than sending the same impossible move until the retry budget runs
    // out. Walking is how the room gets identified; a refusal is evidence too.
    if(b.deadEnd && walk.viaCandidate){
      walk.ruledOut.push(walk.viaCandidate);
      appendOutput('[nav] not that room after all; '
        + 'ruling it out and re-planning\n','system');
      walk.viaCandidate = null;
      walk.plan = null;
      clearStepTimer();
      walk.timer = setTimeout(step, 400);
      return;
    }
    // "There is no exit that way" is the map being wrong, not the walk being
    // impossible: delete the edge we were told to take and try another route.
    // Leaving it in place meant the same bad edge was chosen again next time.
    if(b.deadEnd && walk.lastFrom && walk.lastDir){
      try {
        sqlDb.run('DELETE FROM exits WHERE from_uid=? AND dir=?', [walk.lastFrom, walk.lastDir]);
        appendOutput('[nav] there is no '+walk.lastDir+' here; removed it from the map\n','system');
      } catch(e){ console.error(e); }
      if(++walk.repaths <= MAX_REPATH){
        walk.plan = null;              // the plan was built on the edge just deleted
        walk.blind = false;
        clearStepTimer();
        walk.timer = setTimeout(step, 600);
        return;
      }
    }
    finish(false, b.msg || 'movement blocked');
    return;
  }
}

// Resume a walk that paused for combat as soon as the character is ready again.
onCharStateChange((st) => {
  if(walk && st === STATE_READY && !walk.expectUid) step();
});

// =============================================================================
// COORDINATE WALKING
// =============================================================================
//
// Aardwolf answers a refused `runto` with a coordinate -- "Look for the Andromeda
// Galaxy in Vidblain. Coords 14,23." -- and on a continent every room carries its
// own `room.info.coord`, so that is a destination we can steer to without any map
// of the place at all. Which is the point: these are the areas the map does not
// cover.
//
// The one thing not known in advance is which way the axes run. Rather than
// assume n is -y (the usual convention, but an assumption that would walk the
// wrong way for a whole continent before anyone noticed), the walker LEARNS it:
// it takes a step, sees which way the coordinate moved, and records that. Wrong
// guesses cost one move and are never repeated.

const AXIS_DEFAULT = {n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0]};
// Learning one direction has to move its opposite with it. Recording only that
// `n` moves +y leaves `s` still claiming +y and NOTHING claiming -y, so the
// walker can no longer express "go the other way" and strands itself the moment
// it overshoots -- which a simulated continent with an inverted y axis did on the
// first try. The compass is opposed by construction, so one observation settles
// both ends of the axis.
const OPPOSITE = {n: 's', s: 'n', e: 'w', w: 'e'};
const AXIS_KEY = 'coord_axes';
const COORD_MAX_STEPS = 400;

function loadAxes(){
  try {
    const r = sqlDb.exec("SELECT v FROM meta WHERE k=?", [AXIS_KEY]);
    if(r.length && r[0].values.length) return JSON.parse(r[0].values[0][0]);
  } catch(e){ /* fall through to the default */ }
  return {...AXIS_DEFAULT};
}

function saveAxes(axes){
  try { sqlDb.run("INSERT OR REPLACE INTO meta(k,v) VALUES (?,?)", [AXIS_KEY, JSON.stringify(axes)]); }
  catch(e){ /* the default still works, just unlearned next session */ }
}

let coordWalk = null;   // {tx, ty, axes, steps, tried, lastDir, lastCoord, onDone, onFail}

export function isCoordWalking(){ return !!coordWalk; }

export function cancelCoordWalk(reason){
  const w = coordWalk;
  coordWalk = null;
  if(w && w.onFail) w.onFail(reason || 'cancelled');
}

/**
 * Walk to an absolute game coordinate, steering by `room.info.coord`.
 *
 * Greedy: close the larger axis gap first, and if a direction is refused try the
 * other axis before giving up -- which is what gets round the water and mountains
 * a continent is full of. Bounded by COORD_MAX_STEPS.
 */
export function walkToCoords(tx, ty, onDone, onFail){
  if(!currentRoom.coord){
    appendOutput('[nav] this area has no coordinates, so there is nothing to steer by\n','error');
    if(onFail) onFail('no coordinates here');
    return false;
  }
  coordWalk = {tx: Number(tx), ty: Number(ty), axes: loadAxes(), steps: 0,
               tried: [], lastDir: null, lastCoord: null, onDone, onFail};
  appendOutput('[nav] steering from ' + currentRoom.coord.x + ',' + currentRoom.coord.y
    + ' to ' + tx + ',' + ty + '\n','system');
  coordStep();
  return true;
}

/** The direction that reduces this axis gap, given what we have learned. */
function dirFor(axes, dx, dy, exclude){
  const want = [];
  // Close the bigger gap first: fewer direction changes, and on a continent the
  // long leg is usually the one with open ground.
  const order = Math.abs(dx) >= Math.abs(dy) ? [['x', dx], ['y', dy]] : [['y', dy], ['x', dx]];
  for(const [axis, delta] of order){
    if(!delta) continue;
    for(const [dir, [ax, ay]] of Object.entries(axes)){
      const moves = axis === 'x' ? ax : ay;
      if(moves && Math.sign(moves) === Math.sign(delta)) want.push(dir);
    }
  }
  return want.find(d => !exclude.includes(d)) || null;
}

function coordFinish(ok, reason){
  const w = coordWalk;
  coordWalk = null;
  if(!w) return;
  if(ok){ if(w.onDone) w.onDone(); }
  else {
    appendOutput('[nav] ' + reason + '\n','error');
    if(w.onFail) w.onFail(reason);
  }
}

function coordStep(){
  const w = coordWalk;
  if(!w) return;
  const here = currentRoom.coord;
  if(!here){ coordFinish(false, 'lost coordinates part way'); return; }
  const dx = w.tx - here.x, dy = w.ty - here.y;
  if(!dx && !dy){
    appendOutput('[nav] arrived at ' + w.tx + ',' + w.ty + '\n','system');
    coordFinish(true);
    return;
  }
  if(++w.steps > COORD_MAX_STEPS){
    coordFinish(false, 'still ' + Math.abs(dx) + ',' + Math.abs(dy) + ' away after '
      + COORD_MAX_STEPS + ' moves; stopping');
    return;
  }
  // Fighting is a pause, not a failure -- same rule as the room walker.
  if(charState === STATE_FIGHTING || charState === STATE_RUNNING){
    setTimeout(coordStep, 1500);
    return;
  }
  if(charState === STATE_SLEEPING || charState === STATE_RESTING){
    sendCmdRaw('stand');
    setTimeout(coordStep, 1000);
    return;
  }
  const dir = dirFor(w.axes, dx, dy, w.tried);
  if(!dir){
    coordFinish(false, 'blocked: no way to close ' + dx + ',' + dy + ' from here');
    return;
  }
  w.lastDir = dir;
  w.lastCoord = {x: here.x, y: here.y};
  queueMove(dir, {fromWalker: true});
}

/**
 * Called from onRoomChanged. Confirms the step and learns the axis if the
 * coordinate moved in a direction we did not predict.
 */
function coordOnRoomChanged(){
  const w = coordWalk;
  if(!w || !w.lastDir || !w.lastCoord) { coordStep(); return; }
  const here = currentRoom.coord;
  if(!here){ coordFinish(false, 'left the coordinate area'); return; }
  const moved = {x: here.x - w.lastCoord.x, y: here.y - w.lastCoord.y};
  if(!moved.x && !moved.y){
    // Same coordinate: the move was refused, or it led somewhere off-grid. Rule
    // the direction out for this leg and try another.
    w.tried.push(w.lastDir);
    coordStep();
    return;
  }
  const expected = w.axes[w.lastDir];
  if(!expected || expected[0] !== moved.x || expected[1] !== moved.y){
    // Only trust a clean single-axis step as evidence; diagonal or multi-square
    // jumps are portals and teleports, not a lesson about the compass.
    if(Math.abs(moved.x) + Math.abs(moved.y) === 1){
      w.axes[w.lastDir] = [moved.x, moved.y];
      const back = OPPOSITE[w.lastDir];
      if(back) w.axes[back] = [-moved.x, -moved.y];
      saveAxes(w.axes);
      appendOutput('[nav] learned: ' + w.lastDir + ' moves '
        + (moved.x ? (moved.x > 0 ? '+x' : '-x') : (moved.y > 0 ? '+y' : '-y'))
        + (back ? ' (so ' + back + ' is the other way)' : '') + '\n','system');
    }
  }
  w.tried = [];          // progress made; every direction is worth trying again
  coordStep();
}

// =============================================================================
// DIAGNOSTICS
// =============================================================================

/**
 * `/navdiag [room name]` -- why can't I path there?
 *
 * "no route" has at least five distinct causes -- area not imported, room not
 * identified, no candidates recorded, a level-gated or deleted edge, genuinely
 * disconnected map -- and they are indistinguishable from the message. Rather
 * than guess at a database that only exists in the player's browser, print it.
 */
export function navDiag(targetName){
  if(!sqlDb){ appendOutput('[diag] no database\n','error'); return; }
  const say = (s) => appendOutput('[diag] ' + s + '\n', 'system');
  const one = (sql, params) => {
    try { const r = sqlDb.exec(sql, params); return (r[0]?.values) || []; }
    catch(e){ return [['ERROR: ' + e.message]]; }
  };

  // Printed first so a stale cached bundle is obvious from the paste alone,
  // rather than being mistaken for the fix not working.
  say('client build ' + NAV_BUILD);
  const uid = currentRoom.uid;
  say('here: uid=' + uid + ' name="' + (currentRoom.name||'?') + '" area="'
      + (currentRoom.area||'?') + '" exits=' + JSON.stringify(currentRoom.exits||[]));

  const row = one('SELECT area, name FROM rooms WHERE uid=?', [String(uid)]);
  say('rooms row: ' + (row.length ? JSON.stringify(row[0]) : 'MISSING -- this room is not in the map at all'));

  const out = one('SELECT dir, to_uid, level, COALESCE(random,0) FROM exits WHERE from_uid=?', [String(uid)]);
  say('edges out of here: ' + (out.length ? out.map(r=>r[0]+'->'+r[1]+(r[2]?' lvl'+r[2]:'')+(r[3]?' rnd':'')).join(', ') : 'NONE -- this room is an island'));

  const anchor = one('SELECT gaardian_areaid, gaardian_local_id FROM room_gaardian_map WHERE aardwolf_uid=?', [String(uid)]);
  say('identified as: ' + (anchor.length ? 'gaardian:'+anchor[0][0]+':'+anchor[0][1] : 'NOT identified'));

  const cands = gaardianCandidateUids(uid);
  say('candidates: ' + (cands.length ? cands.join(', ') : 'NONE recorded'
      + (anchor.length ? '' : ' -- with no anchor and no candidates, nothing can path from here')));

  const imported = one('SELECT COUNT(*) FROM gaardian_imported');
  say('areas imported: ' + (imported.length ? imported[0][0] : '?')
      + '; rooms in this area: ' + JSON.stringify(one('SELECT COUNT(*) FROM rooms WHERE area=?', [String(currentRoom.area||'')])[0] || []));

  if(!targetName) { say('add a room name to test a route, e.g. /navdiag Star Dressing Room'); return; }

  const targets = one('SELECT uid, name, area FROM rooms WHERE name LIKE ?', ['%'+targetName+'%']);
  if(!targets.length){ say('no room matching "'+targetName+'" in the map'); return; }
  say('matching rooms: ' + targets.length);
  for(const [tuid, tname, tarea] of targets.slice(0, 12)){
    const direct = findPath(uid, tuid);
    let line = '  ' + tuid + ' "' + tname + '" ['+tarea+'] direct='
      + (direct === null ? 'NO ROUTE' : direct.length + ' steps: ' + direct.map(p=>p.dir).join(' '));
    if(direct === null){
      const plan = planRoute(uid, tuid);
      line += plan.path
        ? ' | via candidate ' + plan.viaCandidate + ': ' + plan.path.map(p=>p.dir).join(' ')
        : ' | no candidate route either';
    }
    say(line);
  }
}

// =============================================================================
// ROOM LIST / /runto
// =============================================================================
export function renderRooms(){
  if(!sqlDb) return;
  const q=document.getElementById('room-search').value.toLowerCase();
  const list=document.getElementById('room-list');
  list.innerHTML='';
  let rows;
  if(q){
    const stmt=sqlDb.prepare("SELECT uid, name, area FROM rooms WHERE name LIKE ? OR area LIKE ? ORDER BY area, name");
    stmt.bind(['%'+q+'%','%'+q+'%']);
    rows=[]; while(stmt.step()) rows.push(stmt.getAsObject()); stmt.free();
  } else {
    rows=sqlDb.exec("SELECT uid, name, area FROM rooms ORDER BY area, name LIMIT 100")[0]?.values.map(r=>({uid:r[0],name:r[1],area:r[2]}))||[];
  }
  for(const r of rows){
    const el=document.createElement('div');
    el.className='item';
    el.textContent=(r.area?r.area+' / ':'')+r.name;
    el.onclick=()=>walkTo(r.uid);
    list.appendChild(el);
  }
}

/**
 * `/navto [uid]` -- walk to a room by its GMCP number, or report where we are.
 *
 * A room name is the wrong handle in exactly the places you most need one: The
 * Gauntlet has 51 rooms called "The Gauntlet", and Gaardian records no way into
 * the half of that area containing them, so neither `/runto <name>` nor the
 * campaign helper can express "the room I was in last time". A uid is unique,
 * survives areas the reference map does not cover, and needs no identification
 * machinery -- the room only has to have been visited once.
 *
 * With no argument it prints the current uid, which is how you collect one on
 * the way past.
 */
/** A uid is a GMCP room number, or the synthetic id of an imported room. */
function looksLikeUid(s){ return /^\d+$/.test(s) || /^gaardian:\d+:\d+$/.test(s); }

/**
 * Resolve a room NAME for /navto, reporting rather than guessing.
 *
 * A name is what a player has -- off a quest, a `where`, or a wiki page -- and
 * `/navto Inside the Kitchen` was not expressible at all: the command took only
 * the first word of its argument, so it searched for a room called "Inside".
 *
 * Ambiguity is printed rather than resolved: picking the first of 51 rooms called
 * "The Gauntlet" would send the walk somewhere arbitrary, and the uid the list
 * prints is the handle that removes the ambiguity for good.
 */
function resolveNavName(name){
  let rows = [];
  try {
    const r = sqlDb.exec(
      'SELECT uid, name, area FROM rooms WHERE LOWER(name)=LOWER(?)', [name]);
    rows = r.length ? r[0].values : [];
    if(!rows.length){
      const r2 = sqlDb.exec(
        'SELECT uid, name, area FROM rooms WHERE LOWER(name) LIKE ?', ['%'+name.toLowerCase()+'%']);
      rows = r2.length ? r2[0].values : [];
    }
  } catch(e){ /* reported by the caller */ }
  if(!rows.length){
    appendOutput('[nav] no room called "'+name+'" in your map. It may be in an area you\n'
      + '      have not imported -- walk in once, or /xq if it is a quest target.\n','error');
    return null;
  }
  // Prefer THIS AREA. Room names repeat constantly across Aardwolf -- "A cavern"
  // exists in a dozen areas, and Halls of the Damned alone has twelve of them -- and
  // somebody typing a room name almost always means the one they are standing near.
  //
  // Reachability alone was not enough to express that. When exactly one match had a
  // route, it was taken silently however far away it was: `/goto A cavern`, typed
  // inside Halls of the Damned, walked to a cavern in a different area entirely and
  // reported "Arrived at A cavern" -- correct by its own reckoning, and useless.
  // Filtering to the current area first makes the common case unambiguous, and leaves
  // the old behaviour intact for a name that genuinely is not local.
  const here = String(currentRoom.area || '').toLowerCase();
  const sameArea = here ? rows.filter(([,,a]) => String(a || '').toLowerCase() === here) : [];
  const pool = sameArea.length ? sameArea : rows;

  // Prefer somewhere we can actually get to: an unreachable exact match is worse
  // than a reachable one when the name repeats across areas.
  const reachable = pool.filter(([u]) => u !== currentRoom.uid && findPath(currentRoom.uid, u));
  const pick = reachable.length === 1 ? reachable
             : (pool.length === 1 ? pool : null);
  if(!pick){
    const list = (reachable.length ? reachable : pool).slice(0, 12);
    if(sameArea.length > 1){
      appendOutput('[nav] '+sameArea.length+' rooms called "'+name+'" in '
        + (currentRoom.area || 'this area')+' alone.\n','system');
    }
    // Count what is actually being offered. Reporting rows.length while listing only
    // the local ones reads as a bug ("matches 14 rooms" above a list of three).
    appendOutput('[nav] "'+name+'" matches '+pool.length+' room(s)'
      + (pool.length !== rows.length ? ' here (' + rows.length + ' in the whole map)' : '')
      + (reachable.length && reachable.length !== pool.length
          ? ', '+reachable.length+' of them reachable' : '')
      + ' -- /navto <uid> to choose:\n','system');
    for(const [u, n, a] of list){
      const p = findPath(currentRoom.uid, u);
      appendOutput('[nav]   ' + u + ' "' + n + '" [' + (a||'?') + '] '
        + (p ? p.length + ' steps' : 'no route') + '\n','system');
    }
    return null;
  }
  return String(pick[0][0]);
}

export function doNavTo(target){
  let uid = String(target || '').trim();
  // A name is accepted as well as a uid, because a name is what the player has.
  if(uid && !looksLikeUid(uid)){
    if(!sqlDb){ appendOutput('[nav] no map database\n','error'); return; }
    const resolved = resolveNavName(uid);
    if(!resolved) return;
    uid = resolved;
  }
  if(!uid){
    appendOutput('[nav] you are in ' + (currentRoom.uid || '?')
      + ' "' + (currentRoom.name || '?') + '" -- /navto ' + (currentRoom.uid || '<uid>')
      + ' walks back here\n', 'system');
    return;
  }
  if(!sqlDb){ appendOutput('[nav] no map database\n','error'); return; }
  if(currentRoom.uid === uid){ appendOutput('[nav] already there\n','system'); return; }

  let row = [];
  try {
    const r = sqlDb.exec('SELECT name, area FROM rooms WHERE uid=?', [uid]);
    row = (r.length && r[0].values.length) ? r[0].values[0] : [];
  } catch(e){ /* reported below */ }
  if(!row.length){
    // Distinguish "never been there" from "there but unreachable": only one of
    // them is fixable by walking.
    let seen = false;
    try {
      const r = sqlDb.exec('SELECT 1 FROM exits WHERE to_uid=? LIMIT 1', [uid]);
      seen = !!(r.length && r[0].values.length);
    } catch(e){ /* leave seen false */ }
    appendOutput('[nav] room ' + uid + ' is not in your map'
      + (seen ? ' yet -- something points at it, but you have never stood in it'
              : '. Walk there once and /navto will find it afterwards.')
      + '\n', 'error');
    return;
  }
  const [name, area] = row;
  appendOutput('[nav] walking to ' + uid + ' "' + name + '"'
    + (area ? ' [' + area + ']' : '') + '\n', 'system');
  // A uid is exact, so the name is nothing but a chance to be wrong: `/navto 266`
  // announced "arrived at On the Oinos Gloom of Hades" while standing in room 270,
  // which shares the name with nine others.
  walkTo(uid, () => appendOutput('[nav] arrived at ' + name + '.\n','system'),
         null, {ignoreName: true});
}

export function doRunto(target){
  if(!sqlDb || !target){ appendOutput('Usage: /runto <room name>\n','system'); return; }
  if(!currentRoom.uid){ appendOutput('Current room unknown. Walk around first.\n','error'); return; }
  // Go through resolveNavName rather than picking a room here. This used to be its own
  // `SELECT uid FROM rooms WHERE name LIKE ? LIMIT 1` -- no area preference, no
  // reachability test, no ORDER BY, so of the 16 rooms called "A Dark Hallway" it took
  // whichever SQLite happened to return first. Standing in Prosper's Island it chose one
  // in Rosewood and reported "no route to that room from here", which reads as a missing
  // map rather than the wrong room. The disambiguation was already written; /runto and
  // /goto simply were not calling it.
  const targetUid = resolveNavName(target);
  if(!targetUid) return;                 // resolveNavName has already explained why
  if(currentRoom.uid === targetUid){ appendOutput('Already there!\n','system'); return; }
  const named = sqlDb.exec('SELECT name FROM rooms WHERE uid=?', [targetUid]);
  const targetName = (named.length && named[0].values.length) ? named[0].values[0][0] : target;
  walkTo(targetUid, () => appendOutput('Arrived at '+targetName+'.\n','system'));
}
