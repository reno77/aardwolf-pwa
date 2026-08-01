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

import { sqlDb } from './db.js';
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
 * `ORDER BY length(dir)` makes a plain compass exit win a tie against a custom
 * one -- typing 'n' is cheaper and safer than 'climb the rickety ladder'.
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
      `SELECT from_uid, dir, to_uid FROM exits
        WHERE to_uid IN (${quoteList(frontier)})
          AND from_uid NOT IN (${quoteList(seen)})
          AND level <= ?
        ORDER BY length(dir) ASC`,
      [...frontier, ...seen, maxLevel]);
    const rows = res[0]?.values || [];
    if(!rows.length) return null;

    const next = [];
    for(const [f, dir, t] of rows){
      if(visited.has(f)) continue;      // first row wins: shortest, then shortest dir
      visited.add(f);
      cameFrom.set(f, {dir, next: t});
      next.push(f);
      if(f === String(fromUid)){
        // Walk the chain forwards to build the route.
        const path = [];
        let cur = String(fromUid);
        while(cur !== String(toUid)){
          const step = cameFrom.get(cur);
          if(!step) return null;
          path.push({dir: step.dir, uid: step.next});
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
export function walkTo(targetUid, onDone, onFail){
  if(!sqlDb){ appendOutput('[nav] no map database\n','error'); return false; }
  if(!currentRoom.uid){
    appendOutput('[nav] current room unknown -- walk one room to set it\n','error');
    return false;
  }
  if(currentRoom.uid === targetUid){ if(onDone) onDone(); return true; }

  const path = findPath(currentRoom.uid, targetUid);
  if(path === null){
    appendOutput('[nav] no route to that room from here\n','error');
    if(onFail) onFail('no route');
    return false;
  }
  if(!path.length){ if(onDone) onDone(); return true; }

  cancelWalk('superseded');
  // A Gaardian target uid is a placeholder that no live room will ever equal, so
  // remember the room NAME too and treat arriving there as success.
  let targetName = null;
  try {
    const r = sqlDb.exec('SELECT name FROM rooms WHERE uid=?', [targetUid]);
    if(r.length && r[0].values.length) targetName = String(r[0].values[0][0]||'').toLowerCase();
  } catch(e){ /* name is a convenience, not a requirement */ }
  walk = {targetUid, targetName, path, plan: path.slice(1), expectUid:null,
          lastFrom:null, lastDir:null, repaths:0, timer:null, onDone, onFail,
          opened:false, blind:false};
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

  // Re-path from where we actually are rather than trusting the plan.
  let path = findPath(currentRoom.uid, walk.targetUid);
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
      finish(false, 'lost the route in ' + (currentRoom.name||'?'));
      return;
    }
  } else {
    walk.blind = false;
  }
  if(!path.length){ finish(true); return; }
  walk.path = path;
  // Keep the tail of the plan so a later re-path failure has something to follow.
  walk.plan = path.slice(1);

  const next = path[0];
  const dir = next.dir;

  if(!isCustomExit(dir)){
    // GMCP lists only exits that are currently open, so a compass direction
    // that is missing from the room is a closed door -- try opening it once.
    const available = (currentRoom.exits || []).map(d => String(d).toLowerCase());
    if(available.length && !available.includes(dir.toLowerCase()) && !walk.opened){
      walk.opened = true;
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
  walk.expectUid = next.uid;
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
  {re:/^There is no exit in that direction/im,      msg:'no exit that way'},
  {re:/^Alas, you cannot go that way/im,            msg:'cannot go that way'},
  {re:/^The door is closed/im,                      msg:null, open:true},
  {re:/is closed\.$/im,                             msg:null, open:true},
  {re:/^The door is locked/im,                      msg:'the door is locked'},
  {re:/^You do not have a key for/im,               msg:'no key for that door'},
  {re:/^You must be standing first/im,              msg:null, stand:true},
  {re:/^You need to use a boat, fly, or swim/im,    msg:'need a boat or flight'},
  {re:/^You are regaining balance/im,               msg:null, retry:true},
  {re:/^You fumble about drunkenly/im,              msg:null, retry:true},
  {re:/^Magic walls bounce you back/im,             msg:'blocked by magic walls', noportal:true},
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
    if(b.stand){ sendCmdRaw('stand'); clearStepTimer(); walk.timer = setTimeout(step, 800); return; }
    if(b.retry){ clearStepTimer(); walk.timer = setTimeout(step, 1200); return; }
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
