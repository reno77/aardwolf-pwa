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

import { gaardianCandidateUids, gaardianPath, reconnectDanglingExits, sqlDb } from './db.js';
import { parseKeySource } from './keys.js';
import { currentRoom, charState, effectiveLevel, onCharStateChange,
         STATE_READY, STATE_FIGHTING, STATE_SLEEPING, STATE_RESTING,
         STATE_RUNNING } from './gmcp.js';
import { queueMove, sendCmdRaw, setWalkCanceller } from './net.js';
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
// A compass walk of 300 rooms still resolves, with room to spare for the custom
// exits an area like Diamond Soul Revelation genuinely requires.
const MAX_COST = 600;

function quoteList(items){ return items.map(()=>'?').join(','); }

function stepCost(dir, random){
  return (random ? RANDOM_COST : 0) + (isCustomExit(dir) ? CUSTOM_COST : STEP_COST);
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
  if(!row) return false;
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
export const NAV_BUILD = 'nav-4.9';

const STEP_TIMEOUT_MS = 6000;
const MAX_REPATH = 5;
// A maze is crossed by trying and re-trying, so random exits get their own,
// much larger budget rather than spending the re-path one on the first corner.
const MAX_RANDOM_STEPS = 40;

let walk = null;   // {targetUid, path, expectUid, lastFrom, lastDir, repaths, timer, onDone, onFail, opened}

export function isWalking(){ return !!walk; }

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

  let plan = planRoute(currentRoom.uid, targetUid);
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
    } else if(ref && !ref.length){
      if(onDone) onDone();
      return true;
    }
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

  if(isCustomExit(dir)) sendCmdRaw(dir);
  else queueMove(dir, {fromWalker:true});
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
    if(++walk.repaths > MAX_REPATH){
      finish(false, 'kept ending up somewhere unexpected; stopping');
      return;
    }
  }
  step();
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
  const m = String(dir || '').match(/'([^']+)'/);
  return m ? m[1] : null;
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
      finish(false, 'that way needs ' + (item ? '"' + item + '"' : 'an item')
        + ', which you are not carrying (' + walk.lastDir + ')');
      return;
    }
    if(b.noportal && currentRoom.uid){
      try { sqlDb.run('UPDATE rooms SET noportal=1 WHERE uid=?', [currentRoom.uid]); } catch(e){}
    }
    if(b.norecall && currentRoom.uid){
      try { sqlDb.run('UPDATE rooms SET norecall=1 WHERE uid=?', [currentRoom.uid]); } catch(e){}
    }
    if(b.open && walk.lastDir && !isCustomExit(walk.lastDir) && !walk.opened){
      walk.opened = true;
      unspendLastStep();
      sendCmdRaw('open ' + walk.lastDir);
      clearStepTimer();
      walk.timer = setTimeout(step, 800);
      return;
    }
    // Informational only: a step is already scheduled, let it run.
    if(b.ignore) return;
    if(b.locked) reportKeyFor(walk.lastFrom, walk.lastDir);
    if(b.stand){ unspendLastStep(); sendCmdRaw('stand'); clearStepTimer(); walk.timer = setTimeout(step, 800); return; }
    if(b.retry){ unspendLastStep(); clearStepTimer(); walk.timer = setTimeout(step, 1200); return; }
    // The exit is real but you are not allowed through it. Park it at level 999
    // -- the "never auto-path" marker the schema already has -- so the router
    // goes round rather than walking into the same guard every time. It stays in
    // the map because you can still use it yourself once you have the pass.
    if(b.gated && walk.lastFrom && walk.lastDir){
      try {
        sqlDb.run('UPDATE exits SET level=999 WHERE from_uid=? AND dir=?', [walk.lastFrom, walk.lastDir]);
        appendOutput('[nav] '+walk.lastDir+' from here is guarded; routing around it\n','system');
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
  // Prefer somewhere we can actually get to: an unreachable exact match is worse
  // than a reachable one when the name repeats across areas.
  const reachable = rows.filter(([u]) => u !== currentRoom.uid && findPath(currentRoom.uid, u));
  const pick = reachable.length === 1 ? reachable
             : (rows.length === 1 ? rows : null);
  if(!pick){
    const list = (reachable.length ? reachable : rows).slice(0, 12);
    appendOutput('[nav] "'+name+'" matches '+rows.length+' room(s)'
      + (reachable.length && reachable.length !== rows.length
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
  walkTo(uid, () => appendOutput('[nav] arrived at ' + name + '.\n','system'));
}

export function doRunto(target){
  if(!sqlDb || !target){ appendOutput('Usage: /runto <room name>\n','system'); return; }
  const res=sqlDb.exec("SELECT uid, name FROM rooms WHERE name LIKE ? LIMIT 1", ['%'+target+'%']);
  if(!res.length || !res[0].values.length){ appendOutput('Room not found: '+target+'\n','error'); return; }
  const [targetUid, targetName]=res[0].values[0];
  if(!currentRoom.uid){ appendOutput('Current room unknown. Walk around first.\n','error'); return; }
  if(currentRoom.uid===targetUid){ appendOutput('Already there!\n','system'); return; }
  walkTo(targetUid, () => appendOutput('Arrived at '+targetName+'.\n','system'));
}
