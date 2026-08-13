// plane.js -- get out of a plane.
//
// The Amulet of the Planes is a one-way door with a rule the client kept
// forgetting: you may only LEAVE a plane from the room the pool dropped you in.
// Anywhere else, `enter` does nothing at all -- no refusal, no message, just a
// prompt -- so there is nothing to parse and nothing to react to.
//
// That cost three hand-driven escapes in one session: Gehenna, then Hades twice.
// Each time the same routine -- hold the amulet, try `enter`, and when nothing
// happens go to another room and try again.
//
// Two things make it cheap instead of a wander:
//
//   1. snd.js records the arrival room when it steps into a pool (noteArrival),
//      and that is remembered across reloads. The normal case is then a walk back
//      to a known uid and one `enter`.
//   2. Failing that, the plane rooms already in the map are the candidates, tried
//      one LAYER at a time. Blind stepping is the last resort, not the first move:
//      the first version stepped u/d/u/d/u/d between two layers because it tracked
//      which DIRECTIONS it had tried rather than which rooms it had been in.
//
// Layer exits are not reversible, which is why retracing is not the same as
// reversing. Live: `e` from the Oinos arrival room reached Niflheim, and `w` back
// from Niflheim reached Pluton -- a third layer.

import { sqlDb } from './db.js';
import { currentRoom, hpFraction, manaFraction } from './gmcp.js';
import { sendCmd, sendCmdRaw } from './net.js';
import { walkTo, isWalking, cancelWalk } from './nav.js';
import { appendOutput } from './ui.js';

// The planes as Aardwolf names the AREAS. A room's name gives its layer ("On the
// Pluton Gloom of Hades"); the area is what says we are in a plane at all.
const PLANE_AREAS = /^(?:lplanes|uplanes|astral)$/i;
const ASTRAL = /astral/i;

// How many rooms to try the amulet in. A plane layer is flagged `maze` and reports
// -1 destinations, so its exits shuffle: wandering IS the mechanism there, and a
// small budget just stops early. /leaveplane <n> raises it when that is what the
// situation needs -- stranded two layers from the arrival room, with the game's own
// help saying there is no other way back.
const DEFAULT_MAX_ROOMS = 14;
const HEALTH_FLOOR = 0.6;      // never keep probing a plane while hurt
const STEP_MS = 1700;
const ENTER_MS = 2200;

// ---------------------------------------------------------------------------
// the arrival room
// ---------------------------------------------------------------------------

function entryKey(area){ return 'plane_entry_' + String(area || '').toLowerCase(); }

/** Called by snd.js the moment a pool lands. */
export function noteArrival(){
  if(!inPlane()) return;
  const rec = { uid: String(currentRoom.uid || ''), name: currentRoom.name || '',
                area: currentRoom.area || '', at: Date.now() };
  if(!rec.uid) return;
  // Remembered on the device, not just in memory: a reload used to lose the one
  // fact that turns a fourteen-room probe into a walk.
  try { localStorage.setItem(entryKey(rec.area), JSON.stringify(rec)); } catch(e){}
  appendOutput('[plane] noted '+(rec.name||rec.uid)+' as the way back out.\n','system');
}

export function planeEntry(area){
  try {
    const raw = localStorage.getItem(entryKey(area || currentRoom.area));
    return raw ? JSON.parse(raw) : null;
  } catch(e){ return null; }
}

export function inPlane(){
  return PLANE_AREAS.test(String(currentRoom.area || ''));
}

// ---------------------------------------------------------------------------
// the way out
// ---------------------------------------------------------------------------

let probe = null;

/** Rooms of this plane the map already holds, one layer at a time. */
function mappedCandidates(area, tried){
  if(!sqlDb) return [];
  let rows = [];
  try {
    const r = sqlDb.exec("SELECT uid, name FROM rooms WHERE area=? AND uid NOT LIKE 'gaardian%'",
                         [String(area || '')]);
    rows = r.length ? r[0].values : [];
  } catch(e){ return []; }
  const byLayer = new Map();
  for(const [uid, name] of rows){
    if(tried.has(String(uid))) continue;
    const layer = String(name || '');
    if(!byLayer.has(layer)) byLayer.set(layer, []);
    byLayer.get(layer).push(String(uid));
  }
  // One room per layer first: the arrival layer is what we are looking for, and
  // sweeping every room of the wrong layer before trying another one is how a
  // bounded probe runs out of budget in the wrong place.
  const out = [];
  const lists = [...byLayer.values()];
  for(let i = 0; ; i++){
    let added = false;
    for(const list of lists) if(list[i]){ out.push(list[i]); added = true; }
    if(!added) break;
  }
  return out;
}

export function leavePlane(budget){
  if(probe){ appendOutput('[plane] already trying to get out.\n','system'); return; }
  if(!inPlane()){
    appendOutput('[plane] you are not in a plane ('+(currentRoom.area||'?')+').\n','system');
    return;
  }
  if(ASTRAL.test(String(currentRoom.name||''))){
    appendOutput('[plane] you are already on the Astral Plane -- `recall` from here.\n','system');
    return;
  }
  const max = Math.max(1, Math.min(60, parseInt(budget) || DEFAULT_MAX_ROOMS));
  probe = { rooms: 0, max, tried: new Set(), visited: new Set(), area: String(currentRoom.area||'') };
  appendOutput('[plane] a plane can only be left from the room the pool dropped you in.\n','plane');
  sendCmd('hold amulet');

  const entry = planeEntry(probe.area);
  if(entry && entry.uid && entry.uid !== String(currentRoom.uid||'')){
    appendOutput('[plane] walking back to '+(entry.name||entry.uid)+' -- the room we arrived in.\n','plane');
    setTimeout(()=>{
      if(!probe) return;
      // ignoreName: every room on a layer shares one name, so a name match would
      // call it arrived without moving.
      walkTo(entry.uid, ()=>tryEnter(), ()=>{
        appendOutput('[plane] cannot walk back there; trying the rooms we know instead.\n','plane');
        tryEnter();
      }, {ignoreName:true});
    }, 1200);
    return;
  }
  setTimeout(tryEnter, 1200);
}

function tryEnter(){
  if(!probe) return;
  const here = String(currentRoom.uid || '');
  probe.tried.add(here);
  probe.visited.add(here);
  // `recall` first, because norecall is a per-ROOM flag: the room we happened to
  // be standing in answered "You cannot recall from this room." while a room two
  // steps away may not, and recall needs no arrival room and no amulet. It costs
  // one refused command when it does not work.
  sendCmdRaw('recall');
  setTimeout(()=>{
    if(!probe) return;
    if(!inPlane()){
      appendOutput('[plane] out -- recall worked from '+(currentRoom.name||'?')+'.\n','plane');
      probe = null;
      return;
    }
    tryAmulet(here);
  }, ENTER_MS);
}

function tryAmulet(here){
  if(!probe) return;
  const before = here + '|' + String(currentRoom.area || '');
  sendCmdRaw('enter');
  setTimeout(()=>{
    if(!probe) return;
    // Nothing to parse: a failed `enter` produces no message at all, so the only
    // honest test is whether the room changed.
    if(!inPlane() || ASTRAL.test(String(currentRoom.name||''))){
      appendOutput('[plane] out -- '+(currentRoom.name||'?')+'. `recall` works from here.\n','plane');
      // This room is the far side of the door, so it is where we will arrive next
      // time; the entry we walked to is still the right one to keep.
      probe = null;
      return;
    }
    if(String(currentRoom.uid||'')+'|'+String(currentRoom.area||'') !== before){
      nextRoom('that moved us but not out');
      return;
    }
    nextRoom('nothing happened');
  }, ENTER_MS);
}

function nextRoom(why){
  if(!probe) return;
  if(probe.rooms >= probe.max){
    appendOutput('[plane] tried the amulet in '+probe.rooms+' rooms without finding the way out.\n','error');
    appendOutput('[plane] `quit` and relog lands you at recall, which is the reliable way out\n'
      + '        of a plane whose arrival room we never saw.\n','error');
    probe = null;
    return;
  }
  if(hpFraction() < HEALTH_FLOOR){
    // Heal, do not stop. Stopping strands the character in the plane, which is worse than
    // the thing the floor exists to prevent -- and it stopped at 58% with a full mana bar,
    // which is nobody's idea of hurt. Only give up when the mana is gone too.
    if(manaFraction() > 0.15 && (probe.heals = (probe.heals || 0) + 1) <= 12){
      appendOutput('[plane] '+Math.round(hpFraction()*100)+'% health -- healing before'
        + ' going on ('+probe.heals+'/12).\n','plane');
      sendCmd('cast heal');
      setTimeout(()=>{ if(probe) nextRoom(why); }, 6000);
      return;
    }
    appendOutput('[plane] '+Math.round(hpFraction()*100)+'% health and no mana left --\n'
      + '        stopping here rather than wandering a plane hurt. Rest, then /leaveplane.\n','error');
    probe = null;
    return;
  }
  probe.rooms++;

  // A mapped room we have not tried yet, walked to properly. Much better than
  // stepping blind: the map holds the layers this plane has been seen on, and the
  // arrival layer is one of them.
  const candidates = mappedCandidates(probe.area, probe.tried);
  if(candidates.length){
    const uid = candidates[0];
    appendOutput('[plane] '+why+' -- walking to another room we know ('
      + probe.rooms+'/'+probe.max+').\n','plane');
    probe.tried.add(uid);              // do not offer it again if the walk fails
    walkTo(uid, ()=>tryEnter(), ()=>{ if(probe) blindStep(why); }, {ignoreName:true});
    return;
  }
  blindStep(why);
}

/** No mapped room left to try: step somewhere new and try there. */
function blindStep(why){
  if(!probe) return;
  const here = String(currentRoom.uid || '');
  const exits = currentRoom.exits || [];
  // Prefer an exit whose destination we have not stood in. The first version of
  // this tracked directions per room instead, and bounced u/d/u/d between two
  // layers for seven rooms of its budget.
  let pick = null;
  for(const d of exits){
    const to = destOf(here, d);
    if(to && !probe.visited.has(to)){ pick = d; break; }
  }
  if(!pick) pick = exits.find(d => !destOf(here, d)) || exits[0] || null;
  if(!pick){
    appendOutput('[plane] '+why+', and there is nowhere to go from here.\n','error');
    probe = null;
    return;
  }
  appendOutput('[plane] '+why+' -- stepping '+pick+' ('+probe.rooms+'/'+probe.max+').\n','plane');
  sendCmdRaw(pick);
  setTimeout(tryEnter, STEP_MS);
}

function destOf(fromUid, dir){
  if(!sqlDb || !fromUid) return null;
  try {
    const r = sqlDb.exec('SELECT to_uid FROM exits WHERE from_uid=? AND dir=?', [fromUid, dir]);
    return r.length && r[0].values.length ? String(r[0].values[0][0]) : null;
  } catch(e){ return null; }
}

export function stopLeavingPlane(reason){
  if(!probe) return;
  probe = null;
  if(isWalking()) cancelWalk(reason || 'plane probe cancelled');
  appendOutput('[plane] stopped.\n','system');
}
