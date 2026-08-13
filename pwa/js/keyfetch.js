// keyfetch.js -- get the key a locked door wants.
//
// The reference map carries a note for 882 gated exits, and keys.js reads it into a kind:
// carried by a mob, inside a container, or for sale. This module acts on that -- go to the
// mob and pick its pocket or kill it, open the container, buy from the shop -- and then
// hands control back to whatever walk was interrupted.
//
// Split out of snd.js at 4500 lines, where it sat between the campaign FSM and the travel
// code with no boundary at all. It is the largest self-contained errand the client runs:
// a key can be four commands away or a room of guards and a trick.

import { gaardianPath, resolveRoomByNameAnywhere, sqlDb } from './db.js';
import { errandFor, runErrand } from './errand.js';
import { charState, currentRoom, STATE_FIGHTING } from './gmcp.js';
import { haveKey, refreshKeyring, stowKeys } from './keyring.js';
import { sendCmd, sendCmdRaw } from './net.js';
import { clearGateInfo, planRoute, walkTo } from './nav.js';
import { dirWord, scanFor } from './scan.js';
import { actionKw, gmkw, gotoRoomUid, mobMatches, resolveRoomByName,
         sndState, whereKw, xcpKillTarget,
         HUNT_DIRS, HUNT_DIR_RE, HUNT_IS_HERE, HUNT_UNABLE, WHERE_ROW } from './snd.js';
import { appendOutput, stripAnsi } from './ui.js';

const boughtKeys = new Set();

function keyKeyword(keyName){
  // 'a Kobalos palace pass' -> 'pass'. Shops match on a keyword like everything
  // else in this game.
  const w = String(keyName||'').toLowerCase()
    .replace(/^\s*(a|an|the)\s+/,'').split(/\s+/).filter(Boolean);
  return w.length ? w[w.length-1] : '';
}

/**
 * Deal with a locked exit, whichever way the map says the key is obtained.
 *
 * The note was only ever read for a purchase, and purchases are 24 of the 882
 * notes Gaardian carries. 644 of them say a named mob is holding it. So the
 * common case -- by a wide margin -- was the one that produced nothing at all.
 *
 * A purchase is fetched automatically: it is a walk and a `buy`. A mob is
 * located and walked to, and then it stops and says so, because killing it is a
 * decision rather than a step.
 */
/**
 * Would fetching the key mean going back through the door that is blocking us?
 *
 * The Trophy room in Aardington has exactly one exit: the skeleton-key door we
 * just failed to open. The key is in The Earl's den, and every route there starts
 * by going back through that door -- so the fetch is circular and cannot work.
 * The helper tried anyway, which left the character shut in a room it could not
 * leave, needing a recall to get out.
 */
function fetchWouldCrossGate(gate, roomUid){
  if(!gate || !gate.dir) return false;
  const plan = planRoute(currentRoom.uid, roomUid);
  let path = plan && plan.path;
  if(!path) path = gaardianPath(currentRoom.uid, roomUid);
  if(!path || !path.length) return false;                 // nothing to judge
  return path[0].dir === gate.dir && String(gate.fromUid) === String(currentRoom.uid);
}

/** 'a large mahogany desk' -> 'desk'; the game targets on one keyword. */
function lastWord(s){
  const w = String(s||'').toLowerCase().replace(/[^a-z0-9 ]/g,' ').split(/\s+/).filter(Boolean);
  return w.length ? w[w.length-1] : '';
}

// A key taken from a container, watched so success is confirmed rather than
// assumed. The old buy path announced "bought a skeleton key" without checking,
// walked back, and hit the same locked door -- the key was never for sale, it was
// in a desk.
const KEY_GOT_IT   = /^you get |^you take /im;
// Thief work. `look <mob>` shows what it carries, `steal <item> <mob>` takes it.
// A key the game flags nosteal has to be fought for -- the mine key says so in its
// own note -- so the flag is checked before the attempt rather than after.
const KEY_IS_NOSTEAL = /\bnosteal\b|cannot be stolen/i;
const STEAL_OK       = /you (?:steal|got|now have)\b|you successfully (?:steal|pilfer)/i;
const STEAL_FAILED   = /you failed|oops|fumble|couldn'?t find|nothing to steal|too (?:aware|alert)/i;
const STEAL_TRIES    = 3;
const KEY_FIGHT_MS   = 120000;
const KILL_RETRIES   = 3;        // swings at one target before it needs a person   // how long a key mob may take to die before we give up

/** Does this reply show the key on the mob? */
function keyLooksPresent(text, keyName){
  const words = String(keyName || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  const sig = words.filter(w => !['a','an','the','of','to','key'].includes(w));
  const hay = String(text).toLowerCase();
  // "a mine key" -> look for "mine" AND "key"; a bare "key" alone is too loose, but
  // a key whose whole name IS "a key" has nothing else to go on.
  if(!sig.length) return /\bkey\b/.test(hay);
  return /\bkey\b/.test(hay) && sig.some(w => hay.includes(w));
}
const KEY_ABSENT   = /^you (?:do not|don'?t) see|^that (?:is|s) not here|isn'?t here|^you cannot find/im;

// A key that is not on a shelf but in a pocket. 882 exits carry a key note and a
// good share of them name a MOB -- "carried by cityguard", "Guarded by an ogre
// guard" -- and until now the helper located the holder and stopped, printing
// "kill it, take the key, then /xcp again". That is one manual step per locked
// door, and it came up twice in a single campaign: an ogre guard in the Keep of
// the Asherodan and a cityguard at the gates of Diamond Reach.
//
// The holder wanders, so it is chased with `hunt` rather than walked to by room --
// which is also why the cityguard could not be found by `where`: it was standing
// in the room while hunt pointed through a closed gate at a second one.
const KEY_MOB_HOPS = 20;          // how far to chase before giving up
const MOB_DIED = /\bis dead\b|crumbles|You receive \d+ experience|corpse of/i;

/**
 * The mob name in a key note is prose, not a name.
 *
 * "Key is carried by one guard" means A guard, and the leading quantifier is not
 * part of anything the game will match: `hunt "one guard"` is refused outright and a
 * scan line reading "A mine guard" does not contain the word "one". Same trap as the
 * campaign mobs, where `hunt 1.black pegasus` had to become `hunt 1.pegasus`.
 */
function keyMobName(mob){
  return String(mob || '').replace(/^\s*(?:one|two|a|an|the|some)\s+/i, '').trim();
}

function fetchKeyFromMob(t, gate, resume){
  const src = gate.source;
  // ONE bare keyword. gmkw quotes the whole phrase, which hunt will not take.
  const kw = whereKw(keyMobName(src.mob)) || whereKw(src.mob);
  if(!kw){
    appendOutput('[S&D] '+(gate.keyName||'the key')+' is on '+src.mob
      + ', but there is no keyword to search on.\n','error');
    return false;
  }
  const tag = gate.fromUid + '|' + gate.dir;
  if(boughtKeys.has(tag)) return false;      // already tried this door
  boughtKeys.add(tag);
  appendOutput('[S&D] '+(gate.keyName||'the key')+' is carried by '+src.mob
    + '; asking where it is.\n','quest');
  sndState.pendingKeyMob = {t, gate, resume, kw, mob: src.mob, keyName: gate.keyName,
                            note: src.note, stage: 'where', hops: 0, tried: [],
                            ts: Date.now()};
  // `where` before `hunt`. hunt follows a trail one room at a time and loses it the
  // moment the mob moves: chasing the Realm of the Hawklords' guard went twenty hops
  // and ended up "In the air", outside the mines entirely. `where` answers with the
  // ROOM, area-wide, in one command -- which is also how the campaign targets are
  // located, so the walker already knows what to do with it.
  sendCmd('where ' + kw);
  return true;
}

/**
 * Walk to the room `where` named, then kill for the key.
 *
 * Each room is tried once, so a guard that has wandered off by the time we arrive
 * costs one walk rather than the whole errand: the next sighting is already in the
 * list, and when the list runs out `hunt` is still there to fall back on.
 */
function gotoKeyMobRoom(st){
  if(sndState.pendingKeyMob !== st) return;
  const room = st.rooms.shift();
  if(!room){
    st.stage = 'find'; st.ts = Date.now(); st.hops = 0;
    appendOutput('[S&D] none of the rooms where had '+st.mob+' worked out; hunting instead.\n','quest');
    sendCmd('hunt ' + st.kw);
    return;
  }
  st.tried.push(room);
  const target = resolveRoomByName(room, currentRoom.area) || resolveRoomByNameAnywhere(room, currentRoom.area);
  if(!target || !target.uid){
    appendOutput('[S&D] "'+room+'" is not in the map; trying the next sighting.\n','quest');
    gotoKeyMobRoom(st);
    return;
  }
  gotoRoomUid(target.uid, ()=>{
    if(sndState.pendingKeyMob !== st) return;
    appendOutput('[S&D] in '+room+' with '+st.mob+'.\n','quest');
    approachKeyMob(st);
  }, {noKeyBuy: true});           // do not recurse into another key errand on the way
  // gotoRoomUid reports its own failures; if the walk dies we fall through to the
  // 20s staleness check at the top of parseKeyMobOutput, which moves things on.
  setTimeout(()=>{
    if(sndState.pendingKeyMob === st && st.stage === 'goto') gotoKeyMobRoom(st);
  }, 45000);
}

/**
 * In the room with the key-carrier: pick its pocket if we can, fight it if we cannot.
 *
 * `look <mob>` is the cheap question -- for a thief it shows what the mob carries --
 * and `steal` leaves it alive, which matters when the same key is wanted again. The
 * note is consulted first: a key the map marks nosteal (the mine key says so in as
 * many words) can only be taken the hard way, and a failed steal on a guard starts a
 * fight anyway.
 */
function approachKeyMob(st){
  if(sndState.pendingKeyMob !== st) return;
  if(KEY_IS_NOSTEAL.test(String(st.note || ''))){
    st.stage = 'kill'; st.ts = Date.now();
    appendOutput('[S&D] the map says '+(st.keyName||'that key')
      + ' is nosteal, so killing '+st.mob+' for it.\n','quest');
    sendCmd('kill ' + st.kw);
    return;
  }
  st.stage = 'peek'; st.ts = Date.now();
  appendOutput('[S&D] looking at '+st.mob+' to see whether '+(st.keyName||'the key')
    + ' can be lifted.\n','quest');
  sendCmd('look ' + st.kw);
}

function giveUpOnKeyMob(st, why){
  sndState.pendingKeyMob = null;
  // Before handing it back: look around. `hunt` follows a trail and loses it easily
  // -- "lost track of one guard" is what ended this errand twice in the Realm of the
  // Hawklords -- while `scan` simply sees three rooms in every direction, and in a
  // mine full of guards the one carrying the key is usually one of them.
  if(!st.scanned){
    st.scanned = true;
    appendOutput('[S&D] '+why+'; scanning the neighbouring rooms for '+st.mob+'.\n','quest');
    const want = keyMobName(st.mob);
    scanFor(name => mobMatches(want, name) || mobMatches(whereKw(want), name),
      (spot)=>{
        appendOutput('[S&D] '+st.mob+' is '+(spot.dir === 'here' ? 'right here'
          : spot.dist+' '+dirWord(spot.dir))+' -- going to take '+(st.keyName||'the key')+'.\n','quest');
        let d = 0;
        if(spot.dir !== 'here'){
          for(let i = 0; i < spot.dist; i++){ setTimeout(()=>sendCmdRaw(spot.dir), d); d += 1400; }
        }
        setTimeout(()=>{
          // Back into the same state machine, at the stage that kills and loots.
          sndState.pendingKeyMob = {...st, stage: 'kill', hops: 0, ts: Date.now()};
          sendCmd('kill ' + st.kw);
        }, d + 600);
      },
      ()=>{
        appendOutput('[S&D] '+why+' -- take '+(st.keyName||'the key')+' from '+st.mob
          + ' yourself, then /xcp again.\n','error');
      });
    return;
  }
  appendOutput('[S&D] '+why+' -- take '+(st.keyName||'the key')+' from '+st.mob
    + ' yourself, then /xcp again.\n','error');
}

/** Feed MUD output here while a key-carrying mob is being chased. */
export function parseKeyMobOutput(text){
  const st = sndState.pendingKeyMob;
  if(!st) return;
  // Not while the walker has it: a walk across an area easily outlasts 20s, and this
  // check would abandon the errand mid-route. gotoKeyMobRoom has its own deadline.
  if(st.stage !== 'goto' && Date.now() - st.ts > 20000){
    // A quiet stretch mid-STEAL is a failed pickpocket, not a lost mob: Aardwolf has
    // several replies for it ("Oops, you failed to steal from Jereck." is only one) and an
    // unrecognised one used to run the clock down and end the errand -- with the mob
    // standing right there, carrying the key, and the fight we would have won next.
    if(st.stage === 'steal'){
      st.steals = (st.steals || 0) + 1;
      if(st.steals < STEAL_TRIES){
        st.ts = Date.now();
        appendOutput('[S&D] that pickpocket did not take; trying again ('
          + st.steals+'/'+STEAL_TRIES+').\n','quest');
        sendCmd('steal ' + keyKeyword(st.keyName) + ' ' + st.kw);
        return;
      }
      st.stage = 'kill'; st.ts = Date.now();
      appendOutput('[S&D] stealing is not working; killing '+st.mob+' for '
        + (st.keyName||'the key')+'.\n','quest');
      sendCmd('kill ' + st.kw);
      return;
    }
    // A fight is not a lost mob either. Jereck took longer than twenty seconds to kill --
    // three failed pickpockets first, and he fights back -- so the deadline ended the
    // errand while the character was still swinging, and the key stayed on a mob that was
    // about to drop it. Combat is its own evidence that this is still working.
    if(st.stage === 'kill' && charState === STATE_FIGHTING
       && Date.now() - st.ts < KEY_FIGHT_MS){
      return;
    }
    giveUpOnKeyMob(st, 'lost track of '+st.mob);
    return;
  }
  const clean = stripAnsi(text);

  if(st.stage === 'where'){
    // Nothing of that name in the area: hunt is the only thing left to try.
    if(/there is no |no one (?:in this area |here )?by|you (?:did ?n'?t|do not) find/i.test(clean)){
      appendOutput('[S&D] where cannot see '+st.mob+' in this area; hunting instead.\n','quest');
      st.stage = 'find'; st.ts = Date.now();
      sendCmd('hunt ' + st.kw);
      return;
    }
    const want = keyMobName(st.mob);
    const rooms = [];
    for(const line of clean.split(/\r?\n/)){
      const m = line.match(WHERE_ROW);
      if(!m) continue;
      if(/^\[/.test(m[1].trim())) continue;         // the vitals prompt has this shape too
      const room = m[2].trim();
      if(room.length < 3 || !/[a-z]/i.test(room)) continue;
      const named = m[1].trim();
      // Only lines that are actually our mob: `where guard` in a mine answers with
      // every guard in it, and the note says which one carries the key only in prose.
      if(!(mobMatches(want, named) || mobMatches(st.kw, named))) continue;
      if(st.tried.includes(room)) continue;
      rooms.push(room);
    }
    if(!rooms.length) return;                        // more of the reply may be coming
    st.stage = 'goto'; st.ts = Date.now();
    st.rooms = rooms;
    appendOutput('[S&D] '+st.mob+' is in '+rooms[0]
      + (rooms.length > 1 ? ' (+'+(rooms.length-1)+' more)' : '')+'; going there.\n','quest');
    gotoKeyMobRoom(st);
    return;
  }

  if(st.stage === 'goto') return;                    // the walker is driving

  if(st.stage === 'find'){
    if(HUNT_IS_HERE.test(clean)){
      appendOutput('[S&D] '+st.mob+' is here.\n','quest');
      approachKeyMob(st);
      return;
    }
    if(HUNT_UNABLE.test(clean) || /\byou (?:cannot|can'?t) find\b|\bno .* to hunt\b/i.test(clean)){
      giveUpOnKeyMob(st, 'cannot hunt '+st.mob);
      return;
    }
    const d = HUNT_DIR_RE.exec(clean);
    if(d){
      if(++st.hops > KEY_MOB_HOPS){ giveUpOnKeyMob(st, 'chased '+st.mob+' too far'); return; }
      const dir = HUNT_DIRS[d[1].toLowerCase()];
      if(!dir){ giveUpOnKeyMob(st, 'hunt pointed somewhere I cannot walk'); return; }
      st.ts = Date.now();
      sendCmdRaw(dir);
      setTimeout(()=>{ if(sndState.pendingKeyMob === st) sendCmd('hunt ' + st.kw); }, 1500);
      return;
    }
    return;
  }

  // A thief can take the key off the mob instead of killing it. `look <mob>` shows
  // what it is carrying (peek), and `steal <item> <mob>` takes it -- cheaper than a
  // fight, and it leaves the mob alive for whoever else needs the same key.
  if(st.stage === 'peek'){
    if(KEY_IS_NOSTEAL.test(clean) || !keyLooksPresent(clean, st.keyName)){
      // Not visible on it, or the game says it cannot be taken: fight for it.
      st.stage = 'kill'; st.ts = Date.now();
      appendOutput('[S&D] '+(st.keyName||'the key')+' cannot be lifted off '+st.mob
        + '; killing it instead.\n','quest');
      sendCmd('kill ' + st.kw);
      return;
    }
    st.stage = 'steal'; st.ts = Date.now(); st.steals = 0;
    appendOutput('[S&D] '+st.mob+' is carrying '+(st.keyName||'the key')
      + '; stealing it.\n','quest');
    sendCmd('steal ' + keyKeyword(st.keyName) + ' ' + st.kw);
    return;
  }

  if(st.stage === 'steal'){
    if(STEAL_OK.test(clean)){
      appendOutput('[S&D] stole '+(st.keyName||'the key')+'.\n','quest');
      sndState.pendingKeyMob = null;
      stowKeys();
      try {
        sqlDb.run('UPDATE exits SET level=0 WHERE from_uid=? AND dir=? AND level=999',
          [st.gate.fromUid, st.gate.dir]);
      } catch(e){ console.error(e); }
      clearGateInfo();
      if(st.resume) st.resume();
      return;
    }
    if(STEAL_FAILED.test(clean)){
      if(++st.steals < STEAL_TRIES){
        st.ts = Date.now();
        setTimeout(()=>{
          if(sndState.pendingKeyMob === st) sendCmd('steal ' + keyKeyword(st.keyName) + ' ' + st.kw);
        }, 2500);
        return;
      }
      st.stage = 'kill'; st.ts = Date.now();
      appendOutput('[S&D] '+STEAL_TRIES+' failed attempts at picking the pocket;'
        + ' killing '+st.mob+' for it.\n','quest');
      sendCmd('kill ' + st.kw);
      return;
    }
    return;
  }

  if(st.stage === 'kill'){
    if(!MOB_DIED.test(clean)) return;
    // Dead. Hand the looting to the fetch parser that already knows how to notice
    // "You get <key>", re-arm the door and resume the walk -- the whole point of
    // this being one machine rather than two.
    sndState.pendingKeyMob = null;
    sndState.pendingKeyFetch = {t: st.t, gate: st.gate, resume: st.resume,
                                keyName: st.keyName, what: st.mob, note: st.note,
                                ts: Date.now()};
    setTimeout(()=>sendCmdRaw('get all corpse'), 700);
    setTimeout(()=>{
      if(!sndState.pendingKeyFetch) return;              // resumed already
      sndState.pendingKeyFetch = null;
      appendOutput('[S&D] '+st.mob+' is dead but '+(st.keyName||'the key')
        + ' was not on it. '+(st.note||'')+'\n','error');
    }, 9000);
    return;
  }
}

/** Feed MUD output here while a key is being fetched. */
export function parseKeyFetchOutput(text){
  const st = sndState.pendingKeyFetch;
  if(!st) return;
  if(Date.now() - st.ts > 12000){ sndState.pendingKeyFetch = null; return; }
  const clean = stripAnsi(text);
  if(KEY_GOT_IT.test(clean)){
    sndState.pendingKeyFetch = null;
    appendOutput('[S&D] got '+(st.keyName||'the key')+'; going back for the door.\n','quest');
    // Onto the keyring, where the game will find it by itself next time -- and where
    // it survives the pack being emptied. Keys are still "carried" for unlocking
    // (help keyring), so this costs nothing now and saves the whole errand later.
    stowKeys();
    try {
      sqlDb.run('UPDATE exits SET level=0 WHERE from_uid=? AND dir=? AND level=999',
        [st.gate.fromUid, st.gate.dir]);
    } catch(e){ console.error(e); }
    clearGateInfo();
    if(st.resume) st.resume();
    return;
  }
  if(KEY_ABSENT.test(clean)){
    sndState.pendingKeyFetch = null;
    appendOutput('[S&D] "'+st.what+'" is not here, so I cannot get '
      + (st.keyName||'the key')+'. '+(st.note||'')+'\n','error');
    return;
  }
}

/**
 * Open the container the note names and take the key out of it.
 *
 * 58 of the 882 notes are this shape -- "The key is inside a large mahogany desk."
 * -- and 46 of them were previously misread as a mob's name.
 */
function fetchKeyFromContainer(t, gate, resume){
  const src = gate.source;
  if(!gate.keyRoom) return false;
  const tag = gate.fromUid + '|' + gate.dir;
  if(boughtKeys.has(tag)) return false;
  const room = resolveRoomByNameAnywhere(gate.keyRoom, t && t.areaName);
  if(!room || !room.uid) return false;
  if(fetchWouldCrossGate(gate, room.uid)){
    appendOutput('[S&D] '+(gate.keyName||'the key')+' is in "'+src.container+'" ('+gate.keyRoom
      + '), but the only way there is back through the door I cannot open.\n'
      + '       Get the key yourself, then /xcp again.\n','error');
    return false;
  }
  boughtKeys.add(tag);
  const box = lastWord(src.container);
  const keyKw = keyKeyword(gate.keyName);
  appendOutput('[S&D] '+(gate.keyName||'the key')+' is in "'+src.container+'" ('+gate.keyRoom
    + '); going to get it.\n','quest');
  gotoRoomUid(room.uid, ()=>{
    sndState.pendingKeyFetch = {t, gate, resume, keyName: gate.keyName,
                               what: src.container, note: src.note, ts: Date.now()};
    sendCmdRaw('open ' + box);
    setTimeout(()=>sendCmdRaw('get ' + keyKw + ' ' + box), 800);
    // If neither a success nor a failure line arrives, say so rather than hanging.
    setTimeout(()=>{
      if(sndState.pendingKeyFetch && sndState.pendingKeyFetch.ts === undefined) return;
      if(!sndState.pendingKeyFetch) return;
      sndState.pendingKeyFetch = null;
      appendOutput('[S&D] no reply to "get '+keyKw+' '+box+'"; take '
        + (gate.keyName||'the key')+' yourself, then /xcp again.\n','error');
    }, 9000);
  }, {noAreaHop:true});
  return true;
}

export function tryGetKeyThen(t, gate, resume){
  const src = gate && gate.source;
  // Do we already have it? `help keyring`: "Whenever you use a command such as
  // 'unlock' that looks for a key, your keyring will also be checked." So a key on
  // the keyring needs nothing from us but another try at the door -- and the helper
  // used to skip that question entirely, setting off to hunt a guard for a mine key
  // it might have been carrying all along.
  const keyName = gate && (gate.keyName || gate.key_name);
  if(keyName && !t?.keyringChecked){
    if(t) t.keyringChecked = true;
    // No article: the map's key names carry their own ("a mine key"), and adding one
    // printed "a a mine key is needed".
    appendOutput('[S&D] '+keyName+' is needed; checking the keyring first.\n','quest');
    refreshKeyring(()=>{
      if(haveKey(keyName)){
        appendOutput('[S&D] "'+keyName+'" is already on your keyring, which the game checks\n'
          + '       when it unlocks -- trying the door again.\n','quest');
        resume();
        return;
      }
      tryGetKeyThen(t, gate, resume);
    });
    return true;
  }
  // A written-down procedure beats searching. The mine key is the case: it is
  // nosteal, and the reference map's own note says the only way to it is to kill one
  // guard for his trident and uniform, wear both, and let the second guard hand it
  // over. No amount of `hunt guard` gets there -- it followed the trail out of the
  // mines and into the air, twice.
  const recipe = keyName ? errandFor(currentRoom.area, keyName) : null;
  if(recipe && !t?.errandTried){
    if(t) t.errandTried = true;
    return runErrand(recipe,
      (roomName, ok, no) => {
        const room = resolveRoomByName(roomName, currentRoom.area)
                  || resolveRoomByNameAnywhere(roomName, currentRoom.area);
        if(!room || !room.uid){ no('no room called '+roomName+' in the map'); return; }
        walkTo(room.uid, ok, no, {ignoreName:true});
      },
      ()=>{
        appendOutput('[S&D] the trick is done; trying the door again.\n','quest');
        clearGateInfo();
        resume();
      },
      (why)=>{
        appendOutput('[S&D] could not work the '+keyName+' trick ('+why+'); searching instead.\n','error');
        tryGetKeyThen(t, gate, resume);
      });
  }
  if(src && src.kind === 'container'){
    if(fetchKeyFromContainer(t, gate, resume)) return true;
  }
  if(src && src.kind === 'mob'){
    if(fetchKeyFromMob(t, gate, resume)) return true;
  }
  return tryBuyKeyThen(t, gate, resume);
}

/**
 * Buy the key a gate wants, then carry on to where we were going.
 *
 * Gaardian names the key, the room it comes from and the price; the seller is in
 * the prose ("purchased from Palgern Cavedwoller for 5 gold"). That is enough to
 * walk to the shop, buy it and resume, instead of stopping with "you need an
 * entry pass" and making the player do it by hand.
 *
 * Deliberately narrow: it buys only the item the map named, only from the room
 * the map named, and only once per gate per session.
 */
function tryBuyKeyThen(t, gate, resume){
  if(!gate || !gate.keyName || !gate.keyRoom) return false;
  const tag = gate.fromUid + '|' + gate.dir;
  if(boughtKeys.has(tag)) return false;         // already tried this gate
  const shop = resolveRoomByNameAnywhere(gate.keyRoom, t && t.areaName);
  if(!shop || !shop.uid) return false;
  if(fetchWouldCrossGate(gate, shop.uid)){
    appendOutput('[S&D] '+(gate.keyName||'the key')+' is sold in '+gate.keyRoom
      + ', but the only way there is back through the door I cannot open.\n','error');
    return false;
  }
  boughtKeys.add(tag);

  const kw = keyKeyword(gate.keyName);
  const price = (String(gate.keyDesc||'').match(/for\s+([\d,]+)\s+gold/i) || [])[1];
  appendOutput('[S&D] fetching '+gate.keyName+' from '+gate.keyRoom
    + (price ? ' ('+price+' gold)' : '') + '...\n','quest');

  gotoRoomUid(shop.uid, ()=>{
    // Confirm rather than assert. This used to announce "bought <key>; resuming"
    // whatever the shop said, walk back, and hit the same locked door -- which is
    // how the Aardington skeleton key looked like a working feature for so long:
    // it is not for sale at all, it is inside a desk. parseKeyFetchOutput now
    // resumes only on a line that says the key actually changed hands.
    sndState.pendingKeyFetch = {t, gate, resume, keyName: gate.keyName,
                                what: gate.keyName, note: gate.keyDesc, ts: Date.now()};
    sendCmdRaw('buy ' + kw);
    setTimeout(()=>{
      if(!sndState.pendingKeyFetch) return;      // already resumed
      sndState.pendingKeyFetch = null;
      appendOutput('[S&D] "buy '+kw+'" did not produce '+(gate.keyName||'the key')+'.'
        + (gate.keyDesc ? ' Note: '+gate.keyDesc : '') + '\n','error');
    }, 6000);
  }, {noAreaHop:true});
  return true;
}
