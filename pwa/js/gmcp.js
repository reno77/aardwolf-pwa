// gmcp.js -- extracted from index.html

import { canonicalArea, matchAardwolfToGaardian, mergeAreaAliases, persistDb, sqlDb } from './db.js';
import { renderRooms, onRoomChanged } from './nav.js';
import { noticeTravelProgress, sndState, xcpStep } from './snd.js';
import { appendOutput, stripAnsi } from './ui.js';
// --- state owned by this module ---
export let currentRoom={name:'Unknown',area:'',exits:[]};

// Character state from GMCP char.status (see the char.status branch below).
export let charState = 3;    // 3 == "active and ready"
export let charLevel = 1;
export let charTier  = 0;

export const STATE_READY = 3;
export const STATE_FIGHTING = 8;
export const STATE_SLEEPING = 9;
export const STATE_RESTING = 11;
export const STATE_RUNNING = 12;

// Grid convention, matching map.js dirDelta: north is -y, east is +x, up is +z.
// Offsets to get from a NEIGHBOUR back to the room that has an exit `dir`
// leading to it -- i.e. the inverse of each direction.
const BACK_FROM_NEIGHBOUR = {
  n: [0,  1, 0],
  s: [0, -1, 0],
  e: [-1, 0, 0],
  w: [ 1, 0, 0],
  u: [0, 0, -1],
  d: [0, 0,  1],
};

/** Effective level for exit level-gates; portals get the tier bonus. */
export function effectiveLevel(){ return charLevel + charTier * 10; }

/**
 * True when a room.info exit destination is a real room number.
 *
 * Aardwolf uses several values for "there is a way out here but I am not telling
 * you where it goes": 0, '?', and -1 (every exit of a maze room). They are not
 * uids and must never be stored as one.
 */
function isKnownUid(v){
  if(v === undefined || v === null || v === '' || v === '?') return false;
  const n = Number(v);
  return Number.isFinite(n) && n > 0;
}

// nav.js registers here so a state change can wake a paused walk without
// gmcp.js importing nav.js (which would close an import cycle at module level).
let charStateListener = null;
export function onCharStateChange(fn){ charStateListener = fn; }
function onCharState(st){
  if(charStateListener){ try { charStateListener(st); } catch(e){ console.error(e); } }
}

// =============================================================================
// GMCP ROOM MAPPING (SQLite)
// =============================================================================
export function processGMCP(key, data){
  if(key==='room.info' && sqlDb){
    let uid=String(data.num||data.id||'');
    if(!uid || uid==='0') return;
    const name=stripAnsi(data.name||'');
    const area=stripAnsi(data.zone||data.area||'');
    const terrain=data.terrain||'';
    // Aardwolf reports num == -1 for unmappable ("nomap") rooms -- clan halls,
    // some quest rooms. The mapper synthesises a stable text uid from name+area
    // instead of dropping them; uid is TEXT so this needs no schema change.
    // Rooms sharing a name within an area do collapse into one node.
    if(uid==='-1') uid='nomap_'+name+'_'+area;
    // Aardwolf does NOT send reliable coord.x/y/z in GMCP.
    // Build our own coordinates from the exit graph.
    let x=0, y=0, z=0;
    try{
      const existing=sqlDb.exec("SELECT x,y,z FROM rooms WHERE uid=?",[uid]);
      if(existing.length && existing[0].values.length){
        x=existing[0].values[0][0]||0;
        y=existing[0].values[0][1]||0;
        z=existing[0].values[0][2]||0;
      } else {
        const exits=data.exits||{};
        for(const [dir,toUid] of Object.entries(exits)){
          if(!isKnownUid(toUid)) continue;
          const neighbor=sqlDb.exec("SELECT x,y,z FROM rooms WHERE uid=?",[toUid]);
          if(neighbor.length && neighbor[0].values.length){
            const nx=neighbor[0].values[0][0]||0;
            const ny=neighbor[0].values[0][1]||0;
            const nz=neighbor[0].values[0][2]||0;
            // `dir` points from THIS room to the neighbour, so this room sits
            // on the OPPOSITE side of it: the offset is the inverse of the
            // direction's own delta. Written as a table because the previous
            // hand-written branches had e/w right but n/s inverted, which
            // mirrored every live-mapped area about the horizontal axis --
            // walking north placed the new room below the one you came from.
            const back=BACK_FROM_NEIGHBOUR[dir];
            if(!back) continue;
            x=nx+back[0]; y=ny+back[1]; z=nz+back[2];
            break;
          }
        }
      }
    }catch(e){}
    const exits=data.exits||{};
    const exitStr=Object.keys(exits).join(':');
    const now=new Date().toISOString();
    // room.info.details is a comma-separated flag list (pk, shop, bank, healer,
    // quest, trainer, maze). The walker reads 'maze' to switch strategy.
    const info=String(data.details||'');
    // Upsert room
    sqlDb.run(`INSERT OR REPLACE INTO rooms(uid, area, name, terrain, info, x, y, z, exits, last_visited)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, [uid, area, name, terrain, info, x, y, z, exitStr, now]);
    // First seen
    const existing = sqlDb.exec("SELECT first_seen FROM rooms WHERE uid=?", [uid]);
    if(!existing.length || !existing[0].values[0][0]){
      sqlDb.run("UPDATE rooms SET first_seen=? WHERE uid=?", [now, uid]);
    }
    // Store exits. GMCP only ever publishes n/e/s/w/u/d, so this never
    // overwrites an imported custom exit. It does NOT publish only the exits
    // that are open: a closed door is listed like any other (confirmed at
    // "Before the fortress", whose doubledoor answers "The doubledoor is
    // closed." while room.info still reports "n": 31848).
    for(const [dir, toUid] of Object.entries(exits)){
      if(!isKnownUid(toUid)){
        // The game declares the exit but withholds where it goes -- maze rooms
        // report every destination as -1. Writing that through produced an edge
        // to a room called "-1" AND, because of the upsert below, overwrote
        // whatever real destination the Gaardian import had supplied, breaking
        // the only route across the maze on the first visit to it.
        //
        // Record the game's own admission instead: this exit's destination is
        // not predictable. That is exactly what `random` means.
        if(toUid !== undefined && toUid !== null && toUid !== '' && toUid !== '0'){
          try {
            sqlDb.run('UPDATE exits SET random=1 WHERE from_uid=? AND dir=?', [uid, dir]);
          } catch(e){ /* column added by initDb; ignore on a very old db */ }
        }
        continue;
      }
      // UPSERT, not INSERT OR REPLACE. REPLACE deletes the row and inserts a
      // new one, so every column not named here -- level, door, key_name,
      // key_desc, key_room, random -- was reset to NULL. Since room.info arrives
      // on every single room change, that wiped the door and key data the moment
      // after the Gaardian import supplied it, and re-armed exits the walker
      // had just parked at level 999 for being guarded.
      sqlDb.run(`INSERT INTO exits(from_uid, dir, to_uid) VALUES (?,?,?)
        ON CONFLICT(from_uid, dir) DO UPDATE SET to_uid=excluded.to_uid`,
        [uid, dir, String(toUid)]);
    }
    // Cross-reference with Gaardian map database and import the whole area
    // Pass the exits GMCP just reported so a repeated room name can be told
    // apart from its twins by fingerprint rather than picked arbitrarily.
    const gaardianRoom = matchAardwolfToGaardian(uid, area, name, now, exits);
    if (gaardianRoom) {
      // If Gaardian has coordinates and we don't, inherit them (scaled to local grid)
      try {
        const existingXY = sqlDb.exec("SELECT x,y FROM rooms WHERE uid=?", [uid]);
        const hasXY = existingXY.length && existingXY[0].values.length && (existingXY[0].values[0][0] !== 0 || existingXY[0].values[0][1] !== 0);
        if (!hasXY) {
          sqlDb.run("UPDATE rooms SET x=?, y=? WHERE uid=?", [gaardianRoom.xpos, gaardianRoom.ypos, uid]);
        }
      } catch(e) {}
    }
    // Update UI
    currentRoom={name, area, info, exits: Object.keys(exits), uid: uid};
    document.getElementById('room-name').textContent=(name||'Unknown') + (area?' ['+area+']':'');
    document.getElementById('room-area').textContent='';
    // Confirm/advance an in-flight walk. room.info is pushed on every room
    // change, which makes it the reliable "did that move land?" signal.
    onRoomChanged();
    // If xcp is waiting for arrival in this area, resume
    // Still moving: push the runto deadline back rather than cutting a long
    // speedwalk off part way.
    noticeTravelProgress();
    // Compare canonically. GMCP reports the keyword ('landofoz') while the
    // campaign gives the display name ('The Land of Oz'), and neither contains
    // the other -- so arriving in Oz never cleared the wait and the runto
    // watchdog announced "stopped moving before reaching The Land of Oz" while
    // standing in it.
    const awaitKey = sndState.xcpAwaitingArea ? canonicalArea(sndState.xcpAwaitingArea) : null;
    if(awaitKey && area && canonicalArea(area) === awaitKey){
      sndState.xcpAwaitingArea=null;
      sndState.xcpAwaitingStart=null;
      if(sndState.xcpAwaitingTimer){ clearTimeout(sndState.xcpAwaitingTimer); sndState.xcpAwaitingTimer=null; }
      if(sndState.pendingXcp) xcpStep(sndState.pendingXcp);
    }
    // Persist
    persistDb();
    // Update room list if visible
    if(document.getElementById('panel-rooms').classList.contains('show')) renderRooms();
  }
  if(key==='room.area' && sqlDb){
    // room.area is an authoritative keyword -> display-name pair, pushed on every
    // area change: {"id":"aardington","name":"Aardington Estate"}. `id` is exactly
    // what `runto`/`rt` wants, so walking anywhere teaches us that area's keyword
    // for free -- no `areas <n> <m> keywords` harvest, and no guessing from the
    // first word (which collides for 54 of the 269 areas: `land` alone matches
    // Land of Legend, ...Beer Goblins and ...of Oz).
    try {
      const id = String(data.id || '').trim().toLowerCase();
      const nm = stripAnsi(String(data.name || '')).trim().toLowerCase();
      if(id && nm){
        sqlDb.run(`INSERT INTO areas(name, key) VALUES (?,?)
                   ON CONFLICT(name) DO UPDATE SET key=excluded.key`, [nm, id]);
        // Learning the keyword also lets us repair rooms already stored under the
        // display name. The same area used to be imported twice -- once as
        // 'aardington' from room.info.zone, once as 'aardington estate' from a
        // campaign lookup -- so picking either in the map dropdown showed only
        // half of it, and the room you were in was frequently in the other half.
        const moved = mergeAreaAliases(nm, id);
        if(moved) appendOutput(`[map] merged ${moved} room(s) from "${nm}" into "${id}"\n`, 'system');
      }
    } catch(e){ /* areas table is best-effort */ }
  }
  if(key==='char.vitals'){
    const hp=data.hp||'', maxhp=data.maxhp||'', mn=data.mana||'', maxmn=data.maxmana||'', mv=data.move||'', maxmv=data.maxmove||'';
    let vitalText='';
    if(hp&&maxhp) vitalText+=hp+'/'+maxhp+'hp ';
    if(mn&&maxmn) vitalText+=mn+'/'+maxmn+'mn ';
    if(mv&&maxmv) vitalText+=mv+'/'+maxmv+'mv';
    if(vitalText){
      document.getElementById('room-name').textContent=(currentRoom.name||'Unknown')+' ('+vitalText.trim()+')';
    }
  }
  if(key==='char.status'){
    // Aardwolf char.status.state, per the GMCP spec:
    //   1,2 logging in   3 ready   4 AFK   5 note   6 building   7 paged
    //   8 fighting       9 sleeping   11 resting/sitting   12 running
    // The walker needs this: stepping while fighting or mid-speedwalk is how a
    // path desynchronises. Previously the whole message was discarded.
    const st = parseInt(data.state);
    if(!isNaN(st)){
      charState = st;
      onCharState(st);
    }
    // char.status carries level but NOT tier -- see the char.base branch below.
    const lv = parseInt(data.level);
    if(!isNaN(lv)) charLevel = lv;
  }
  if(key==='char.base'){
    // Tier only ever arrives here. Reading it from char.status left charTier at
    // 0 forever, which understated the wearable-level cap by 10 levels per tier
    // -- a tier 5 character was told they could wear 50 levels less than they
    // actually can. Confirmed live: char.base = {..., "tier":5, "level":71}.
    const tier = parseInt(data.tier);
    if(!isNaN(tier)) charTier = tier;
    const lv = parseInt(data.level);
    if(!isNaN(lv)) charLevel = lv;
  }
  if(key==='comm.quest'){
    appendOutput('Quest update: '+JSON.stringify(data)+'\n','quest');
  }
}
