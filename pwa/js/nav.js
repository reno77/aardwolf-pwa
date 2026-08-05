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

import { gaardianCandidateUids, sqlDb } from './db.js';
import { currentRoom, charState, effectiveLevel, onCharStateChange,
         STATE_READY, STATE_FIGHTING, STATE_SLEEPING, STATE_RESTING,
         STATE_RUNNING } from './gmcp.js';
import { queueMove, sendCmdRaw, setWalkCanceller } from './net.js';
import { appendOutput } from './ui.js';

// =============================================================================
// PATHFINDING
// =============================================================================

const MAX_DEPTH = 300;
const MAX_FRONTIER = 4000;   // guard against pathological SQL parameter counts

function quoteList(items){ return items.map(()=>'?').join(','); }

/**
 * Shortest path from `fromUid` to `toUid` as [{dir, uid}, ...].
 *
 * Breadth-first, searched backwards from the destination: each round asks for
 * every exit that lands in the current frontier. That is one indexed query per
 * depth level rather than the old "SELECT everything FROM exits" on every
 * single step of every walk.
 *
 * Ties within a depth level are broken first against random exits (their to_uid
 * is one sample, not a fact) and then by `length(dir)`, so a plain compass exit
 * wins over a custom one -- typing 'n' is cheaper and safer than 'climb the
 * rickety ladder'. Note this only orders *equal-length* routes: a shorter route
 * through a random exit still beats a longer certain one, which would need a
 * weighted search rather than BFS.
 *
 * Returns null when no path exists, [] when already there.
 */
export function findPath(fromUid, toUid, opts){
  if(!sqlDb || !fromUid || !toUid) return null;
  if(fromUid === toUid) return [];
  const maxLevel = (opts && opts.level) || effectiveLevel();

  let frontier = [String(toUid)];
  const visited = new Set(frontier);
  // cameFrom[room] = {dir, next} : from `room`, go `dir` to reach `next`.
  const cameFrom = new Map();

  for(let depth = 0; depth < MAX_DEPTH; depth++){
    if(!frontier.length || frontier.length > MAX_FRONTIER) break;
    const seen = [...visited];
    const res = sqlDb.exec(
      `SELECT from_uid, dir, to_uid, COALESCE(random,0) FROM exits
        WHERE to_uid IN (${quoteList(frontier)})
          AND from_uid NOT IN (${quoteList(seen)})
          AND level <= ?
        ORDER BY COALESCE(random,0) ASC, length(dir) ASC`,
      [...frontier, ...seen, maxLevel]);
    const rows = res[0]?.values || [];
    if(!rows.length) return null;

    const next = [];
    for(const [f, dir, t, rnd] of rows){
      if(visited.has(f)) continue;      // first row wins: shortest, then certain, then shortest dir
      visited.add(f);
      cameFrom.set(f, {dir, next: t, random: !!rnd});
      next.push(f);
      if(f === String(fromUid)){
        // Walk the chain forwards to build the route.
        const path = [];
        let cur = String(fromUid);
        while(cur !== String(toUid)){
          const step = cameFrom.get(cur);
          if(!step) return null;
          path.push({dir: step.dir, uid: step.next, random: step.random});
          cur = step.next;
        }
        return path;
      }
    }
    frontier = next;
  }
  return null;
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

function reportKeyFor(fromUid, dir){
  if(!sqlDb || !fromUid || !dir) return false;
  try {
    const r = sqlDb.exec('SELECT key_name, key_desc, key_room FROM exits WHERE from_uid=? AND dir=?',
      [String(fromUid), dir]);
    if(!r.length || !r[0].values.length) return false;
    const [keyName, keyDesc, keyRoom] = r[0].values[0];
    if(!keyName && !keyDesc) return false;
    lastGate = {fromUid: String(fromUid), dir, keyName: keyName || null,
                keyDesc: keyDesc || null, keyRoom: keyRoom || null};
    appendOutput('[nav] you need ' + (keyName || 'a key') + ' for that way'
      + (keyRoom ? ' -- try "' + keyRoom + '"' : '') + '\n', 'quest');
    if(keyDesc) appendOutput('       ' + keyDesc + '\n', 'quest');
    return true;
  } catch(e){ return false; }
}

// =============================================================================
// THE WALKER
// =============================================================================
//
// One step at a time: send, record the room we expect, and let the next GMCP
// room.info confirm it. That is the correct pacing primitive -- it is what the
// Aardwolf mapper's walkto mode does -- and it replaces the old 500ms blanket
// throttle that silently dropped steps.

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

  const plan = planRoute(currentRoom.uid, targetUid);
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
          opened:false, blind: !!plan.viaCandidate,
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
    // A route planned from a candidate is still only a hypothesis about which
    // room this is, so uid mismatches stay expected until the room is anchored.
    walk.blind = !!replan.viaCandidate;
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
  {re:/^The door is closed/im,                      msg:null, open:true},
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
];

/** Called from net.js for every line of MUD output while a walk is active. */
export function onMudText(text){
  if(!walk || !text) return;
  for(const b of BLOCKED){
    if(!b.re.test(text)) continue;
    if(b.noportal && currentRoom.uid){
      try { sqlDb.run('UPDATE rooms SET noportal=1 WHERE uid=?', [currentRoom.uid]); } catch(e){}
    }
    if(b.norecall && currentRoom.uid){
      try { sqlDb.run('UPDATE rooms SET norecall=1 WHERE uid=?', [currentRoom.uid]); } catch(e){}
    }
    if(b.open && walk.lastDir && !isCustomExit(walk.lastDir) && !walk.opened){
      walk.opened = true;
      sendCmdRaw('open ' + walk.lastDir);
      clearStepTimer();
      walk.timer = setTimeout(step, 800);
      return;
    }
    // Informational only: a step is already scheduled, let it run.
    if(b.ignore) return;
    if(b.locked) reportKeyFor(walk.lastFrom, walk.lastDir);
    if(b.stand){ sendCmdRaw('stand'); clearStepTimer(); walk.timer = setTimeout(step, 800); return; }
    if(b.retry){ clearStepTimer(); walk.timer = setTimeout(step, 1200); return; }
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

export function doRunto(target){
  if(!sqlDb || !target){ appendOutput('Usage: /runto <room name>\n','system'); return; }
  const res=sqlDb.exec("SELECT uid, name FROM rooms WHERE name LIKE ? LIMIT 1", ['%'+target+'%']);
  if(!res.length || !res[0].values.length){ appendOutput('Room not found: '+target+'\n','error'); return; }
  const [targetUid, targetName]=res[0].values[0];
  if(!currentRoom.uid){ appendOutput('Current room unknown. Walk around first.\n','error'); return; }
  if(currentRoom.uid===targetUid){ appendOutput('Already there!\n','system'); return; }
  walkTo(targetUid, () => appendOutput('Arrived at '+targetName+'.\n','system'));
}
