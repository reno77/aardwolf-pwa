// snd.js -- extracted from index.html

import { canonicalArea, findAreaAnywhere, gaardianDb, gaardianPath,
         resolveRoomByNameAnywhere, sqlDb } from './db.js';
import { currentRoom, charState, charLevel, hpFraction,
         STATE_READY, STATE_FIGHTING } from './gmcp.js';
import { sendCmd, sendCmdRaw } from './net.js';
import { findPath, planRoute, walkTo, cancelWalk, isWalking, lastGateInfo, clearGateInfo,
         walkToCoords } from './nav.js';
import { lookupArea, runtoFailed, harvestAreaKeywords, parseAreasOutput,
         parseRuntoNote, rememberEntryHint, entryHint, landmarkKeyword } from './areas.js';
import { appendOutput, stripAnsi, togglePanel } from './ui.js';
// --- state owned by this module ---
export let campaignTargets=[]; // S&D target list, built from cp info + cp check
// `wear wpn 2` was two arguments, so it never referred to the wpn2 alias at all.
// Both weapon slots now go through their aliases (wpn -> poly, wpn2 -> poly2).
export const DEFAULT_RECALL = 'wear garbage;enter;rem garbage;wear wpn;wear wpn2';
export let sndState={cpType:'none', cpLevel:0, xcpIndex:0, xcpMode:localStorage.getItem('xcp_mode')||'ch', recallSequence:fixStoredRecall(localStorage.getItem('recall_sequence'))||DEFAULT_RECALL};

/** Repair a stored sequence that carries the `wear wpn 2` typo. */
function fixStoredRecall(seq){
  if(!seq) return seq;
  const fixed = seq.replace(/\bwear\s+wpn\s+2\b/gi, 'wear wpn2');
  if(fixed !== seq){
    try { localStorage.setItem('recall_sequence', fixed); } catch(e){ /* not fatal */ }
  }
  return fixed;
}
export let lastCpInfoRaw='';
export let lastCpCheckRaw='';
export let lastCampaignRaw='';

// How many `where <n>.<kw>` ordinals to walk before giving up on a target.
const WHERE_ORD_MAX=8;
// How long to wait for a `where` reply before asking again.
const WHERE_REPLY_MS=9000;

// =============================================================================
// SEARCH AND DESTROY CAMPAIGN HELPER (ported from Search_and_Destroy_v2.0.xml)
// =============================================================================
export function gmkw(s, areaName){
  // Use the entire mob name (without leading article) as a quoted keyword.
  // e.g. 'a large apple tree' -> '"large apple tree"'
  if(!s) return '';
  const trimmed=s.toLowerCase().replace(/^\s*(a|an|the)\s+/i,'').trim();
  if(!trimmed) return '';
  // Quote it so Aardwolf treats it as a single phrase.
  return '"'+trimmed+'"';
}

/**
 * The single word to hand `where`, so ordinals work: `where 2.barn`.
 *
 * `where` takes one keyword and answers with ONE mob. Quoting the whole name
 * ("barn swallow") is not a phrase search, and the first mob matching the
 * keyword may not be the one you want -- confirmed live: in Aardington Estate
 * `where barn` answers "a swooping swallow", and only `where 2.barn` reaches
 * "a barn swallow". So the keyword must stay a bare word that an ordinal can be
 * prefixed to.
 */
const KW_STOP = new Set(['a','an','the','of','and','in','on','at','with','to','from','for','de','le']);

/**
 * Keywords to try for `where`/`hunt`, best first.
 *
 * One keyword is not enough. `where` matches on a keyword and answers with a
 * single mob, so the wrong keyword means walking ordinals through a crowd that
 * has nothing to do with the target: hunting "Trudes Tronesetter, Queen of the
 * Kobaloi" on `kobaloi` walked 1..8 through the area's other kobaloi and gave
 * up, when `trudes` finds her immediately.
 *
 *  1. A comma marks a proper name followed by a title. The name is unique; the
 *     title's nouns are shared with everything else in the area.
 *  2. Otherwise the head noun, which is the last word -- "a black pegasus" is
 *     `pegasus`, not `black`, an adjective half the area shares.
 *  3. Then any capitalised word, which is a name rather than a category.
 *  4. Then whatever is left, so there is always something to fall back to.
 */
export function whereKeywords(s){
  const raw = String(s || '').trim();
  if(!raw) return [];
  const out = [];
  const clean = w => w.toLowerCase().replace(/[^a-z0-9'-]/g, '');
  const push = w => {
    const c = clean(w);
    if(c && c.length >= 2 && !KW_STOP.has(c) && !out.includes(c)) out.push(c);
  };
  const body = raw.replace(/^\s*(a|an|the)\s+/i, '');
  const words = body.split(/\s+/).filter(Boolean);

  const comma = body.indexOf(',');
  if(comma > 0) for(const w of body.slice(0, comma).split(/\s+/)) push(w);
  if(words.length) push(words[words.length - 1]);
  for(const w of words) if(/^[A-Z]/.test(w)) push(w);
  for(const w of words) push(w);
  return out;
}

/**
 * The keyword to use when acting on this mob.
 *
 * `matchedKw` is set once `where` has returned a line whose NAME matches the
 * target, so it is the only word proven to mean this creature. Everything that
 * acts -- hunt, kill -- must prefer it: the head noun is often shared, and
 * `kill worker` for "a relaxing worker" killed an injured goblin worker that
 * happened to be in the same room.
 */
export function actionKw(t){
  return (t && t.matchedKw) || whereKw(t && t.mob) || '';
}

export function whereKw(s){ return whereKeywords(s)[0] || ''; }

export function huntTrickKw(s){
  // `hunt` takes ONE keyword, exactly like `where`. Passing the full name failed
  // outright -- confirmed live: both `hunt 1.black pegasus` and `hunt black
  // pegasus` answered "You seem unable to hunt that target for some reason.",
  // while `pega` located it. So `hunt 1.pegasus`, never the phrase.
  return whereKw(s);
}

// Pathfinding and stepwise movement used to live here as two more copies of
// the same BFS (both loading the entire `exits` table on every step, both
// synthesising bogus reverse edges) plus a stepper that refused any custom exit.
// All of it now delegates to nav.js.

export function pickNearestRoom(rooms, fromUid){
  if(!rooms.length) return null;
  let best=null, bestLen=Infinity;
  for(const r of rooms){
    const path=findPath(fromUid, r.uid);
    if(path && path.length<bestLen){ bestLen=path.length; best=r; }
  }
  return best || rooms[0];
}

function areaOfRoom(uid){
  if(!sqlDb || !uid) return null;
  try {
    const r=sqlDb.exec('SELECT area FROM rooms WHERE uid=?', [uid]);
    return (r.length && r[0].values.length) ? r[0].values[0][0] : null;
  } catch(e){ return null; }
}

/** Poll until GMCP says we are in `areaName`, then run `fn`. */
function awaitAreaThen(areaName, fn, tries){
  tries = (tries==null) ? 40 : tries;          // ~60s at 1.5s a tick
  if(currentRoom.area && areaNameMatches(currentRoom.area, areaName)){
    setTimeout(fn, 800);                        // let the arrival room.info settle
    return;
  }
  if(tries<=0){
    appendOutput('[S&D] never arrived in '+areaName+'; giving up on this target.\n','error');
    return;
  }
  setTimeout(()=>awaitAreaThen(areaName, fn, tries-1), 1500);
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
const KEY_ABSENT   = /^you (?:do not|don'?t) see|^that (?:is|s) not here|isn'?t here|^you cannot find/im;

/** Feed MUD output here while a key is being fetched. */
export function parseKeyFetchOutput(text){
  const st = sndState.pendingKeyFetch;
  if(!st) return;
  if(Date.now() - st.ts > 12000){ sndState.pendingKeyFetch = null; return; }
  const clean = stripAnsi(text);
  if(KEY_GOT_IT.test(clean)){
    sndState.pendingKeyFetch = null;
    appendOutput('[S&D] got '+(st.keyName||'the key')+'; going back for the door.\n','quest');
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

function tryGetKeyThen(t, gate, resume){
  const src = gate && gate.source;
  if(src && src.kind === 'container'){
    if(fetchKeyFromContainer(t, gate, resume)) return true;
  }
  if(src && src.kind === 'mob'){
    const tag = gate.fromUid + '|' + gate.dir;
    if(boughtKeys.has(tag)) return false;
    boughtKeys.add(tag);
    const kw = gmkw(src.mob) || whereKw(src.mob);
    appendOutput('[S&D] the key ('+(gate.keyName||'?')+') is on '+src.mob+'.\n','quest');
    if(!kw){
      appendOutput('[S&D] no keyword to search on; find it yourself, then /xcp '
        + (t ? t.index : '') + '.\n','error');
      return false;
    }
    appendOutput('[S&D] locating it (where '+kw+')...\n','quest');
    sendCmd('where '+kw);
    // Deliberately not chained into a kill. Finding the mob is navigation;
    // killing it is a choice, and the player is the one making it.
    appendOutput('[S&D] kill '+src.mob+', take the key, then /xcp '
      + (t ? t.index : '') + ' to carry on.\n','quest');
    return false;
  }
  return tryBuyKeyThen(t, gate, resume);
}

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

export function gotoRoomUid(toUid, onDone, opts){
  if(!toUid) return;
  walkTo(toUid, onDone, (reason)=>{
    // Blocked by a gate whose key the map knows how to get? Go and get it.
    const gate = lastGateInfo();
    if(gate && !(opts && opts.noKeyBuy)){
      const t = sndState.pendingXcp;
      if(tryGetKeyThen(t, gate, ()=>gotoRoomUid(toUid, onDone, {...(opts||{}), noKeyBuy:true}))) return;
    }
    // A room can be present in the local map and still be unreachable. Importing
    // an area from Gaardian does not connect it to anything you have actually
    // walked, so it sits as an island -- and from a clan hall there is no mapped
    // route to anywhere. No amount of BFS fixes that; the server's own `runto`
    // does. Get into the area first, then path locally from inside it.
    const area=areaOfRoom(toUid);
    const inArea=currentRoom.area && area && areaNameMatches(currentRoom.area, area);
    if(area && !inArea && !(opts && opts.noAreaHop)){
      appendOutput('[S&D] no mapped route from '+(currentRoom.area||'here')+' to '+area
        +' -- recalling, then using the server\'s runto to reach the area.\n','quest');
      // Recall FIRST. `runto` only works from the Grand City of Aylor -- the game
      // answers "You need to be at the Grand City of Aylor (recall) to use runto."
      // from anywhere else -- and this path fired it from wherever the walk had
      // broken down. Seen chasing the Fox Champion: a random exit in Nenukon
      // carried the character into Alagh, this fallback said `runto nenukon` on
      // the spot, and the game refused it. The main travel path in xcpStep has
      // always recalled first; this one simply forgot to.
      xcpRecall(sndState.pendingXcp, ()=>{
        if(runtoArea(area)){
          awaitAreaThen(area, ()=>gotoRoomUid(toUid, onDone, {noAreaHop:true}));
          return;
        }
        appendOutput('[S&D] could not reach the target room (no runto keyword for '
          + area + ').\n','error');
      });
      return;
    }
    appendOutput('[S&D] could not reach the target room ('+reason+').\n','error');
    // Getting lost among random exits is not a transient failure -- the area does
    // not have a route we can express, and trying again does the same thing. Give
    // up on THIS target so nothing upstream recalls, runs back and wanders again.
    //
    // Nenukon and the Far Country is the case: the game reports every exit from
    // "Entering the Nenukon" with destination -1, meaning it will not say where you
    // land, and it scatters you across the continent (Alagh, Kherashin, the Great
    // Eastern Desert all turned up). The intended way in is a spoken tribe name,
    // and `say lynx` / `say bear` both do nothing for a character who has not done
    // the area quest -- so for that character there is no route at all.
    if(/still lost|somewhere unexpected/i.test(String(reason || ''))){
      const t = sndState.pendingXcp;
      appendOutput('[S&D] that area moves you around unpredictably, so there is no route\n'
        + '      to plan. Get in yourself and /xcp again from inside.\n','quest');
      if(t) xcpAbandonTarget(t, 'lost in random exits');
    }
  }, opts);
}

export function resolveAreaUid(areaName){
  if(!sqlDb || !areaName) return null;
  const res=sqlDb.exec("SELECT DISTINCT area FROM rooms WHERE area LIKE ? LIMIT 1", ['%'+areaName+'%']);
  if(res.length && res[0].values.length) return res[0].values[0][0];
  return null;
}

export function areaNameMatches(a, b){
  if(!a || !b) return false;
  const la=a.toLowerCase().replace(/[^a-z0-9]/g,'');
  const lb=b.toLowerCase().replace(/[^a-z0-9]/g,'');
  if(la===lb) return true;
  // 'hedge' should match 'hedgehogs' and vice versa when one is a prefix of the other.
  if(la.length>=4 && lb.startsWith(la)) return true;
  if(lb.length>=4 && la.startsWith(lb)) return true;
  return false;
}

export function resolveRoomByName(roomName, areaName){
  const rooms=resolveRoomsByName(roomName, areaName);
  return rooms.length?rooms[0]:null;
}

export function resolveRoomsByName(roomName, areaName){
  if(!sqlDb || !roomName) return [];
  let res;
  if(areaName){
    // `area LIKE '%<display name>%'` alone misses every live room, because GMCP
    // stores the area KEYWORD ('aardington') while campaign text gives the
    // display name ('Aardington Estate'). Accept a match in either direction.
    res=sqlDb.exec(
      // A room you have actually stood in beats a Gaardian placeholder of the
      // same name: its uid is the one the live exit graph refers to.
      // Also match on the canonical keyword. "The Land of Oz" is stored as
      // 'landofoz', which neither LIKE test can reach -- the display name is not
      // a prefix of the keyword or the other way round -- so a room that was
      // sitting one step away was missed and a stale gaardian: uid returned.
      "SELECT uid, name, area FROM rooms WHERE name LIKE ?"
      + " AND (area LIKE ? OR ? LIKE area||'%' OR area=?)"
      + " ORDER BY (uid LIKE 'gaardian:%')",
      ['%'+roomName+'%', '%'+areaName+'%', areaName.toLowerCase(), canonicalArea(areaName)]);
  } else {
    res=sqlDb.exec("SELECT uid, name, area FROM rooms WHERE name LIKE ?", ['%'+roomName+'%']);
  }
  return (res.length && res[0].values)?res[0].values.map(r=>({uid:r[0], name:r[1], area:r[2]})):[];
}

/**
 * Spelled out, never abbreviated.
 *
 * `rt <area>` is not runto. Aardwolf matched it to some other command entirely
 * and answered "You are not carrying that item.", which is not in any runto
 * failure list, so the helper believed the travel had worked and carried on to
 * `where` from the wrong side of the world. `help rt` DOES resolve to the Runto
 * page, which is exactly why this looked right for so long: the help system and
 * the command parser do not abbreviate the same way.
 */
const RUNTO = 'runto ';

export function runtoArea(areaName){
  // Aardwolf's own runto handles area-level travel; room-level navigation inside
  // an area goes through gotoRoomUid or the hunt fallback.
  const area=lookupArea(areaName);
  if(!area){
    appendOutput('[S&D] cannot derive runto keyword for '+areaName+'\n','error');
    return false;
  }
  if(area.nogo){
    appendOutput('[S&D] '+areaName+' cannot be reached with runto.\n','error');
    return false;
  }
  appendOutput('[S&D] runto '+area.key+(area.guessed?' (guessed)':'')+'\n','quest');
  sendCmd(RUNTO+area.key);
  return true;
}

// Legacy 'campaign' command output parser (kept for compatibility)
export function parseCampaignOutput(text){
  const clean=stripAnsi(text);
  if(!clean.includes('Campaign') && !clean.includes('Remaining') && !clean.includes('campaign') && !clean.includes('request')) return;
  lastCampaignRaw+=clean+'\n';
  const lines=clean.split('\n');
  let found=false;
  for(const line of lines){
    const m=line.match(/(\d+)\.\s+(.+?)\s+(?:in|of|near|at|around)\s+(.+?)\s*\((\d+)\/(\d+)\)/i);
    if(m){
      const idx=parseInt(m[1])-1;
      const areaName=resolveAreaUid(m[3].trim()) || m[3].trim();
      const room=resolveRoomByName(m[2].trim(), areaName);
      campaignTargets[idx]={mob:m[2].trim(), areaName:areaName, area:m[3].trim(), progress:parseInt(m[4]), total:parseInt(m[5]), completed:parseInt(m[4])>=parseInt(m[5]), is_dead:parseInt(m[4])>=parseInt(m[5]), type:room?'room':'area', roomUid:room?room.uid:null, roomName:room?room.name:null, kw:gmkw(m[2].trim(), areaName)};
      found=true;
    }
  }
  if(found) renderCampaign();
}

// cp info parser
export function parseCpInfoOutput(text){
  for(const raw of text.split(/\r?\n/)){
    const clean=stripAnsi(raw).trim();
    if(!clean) continue;
    const levelMatch=clean.match(/Level\s+Taken[\s.]*:\s*\[\s*(\d{1,3})\s*\]/i);
    if(levelMatch){
      sndState.cpLevel=parseInt(levelMatch[1]);
      sndState._inCpInfo=true;
      sndState._cpInfoTmp=[];
      continue;
    }
    if(/targets\s+for\s+this\s+campaign\s+are/i.test(clean)){ sndState._inCpInfo=true; sndState._cpInfoTmp=[]; continue; }
    if(!sndState._inCpInfo) continue;
    const m=clean.match(/^\s*Find\s+and\s+kill\s+1\s+\*\s+(.+?)\s+\(([^)]+)\)\s*$/i);
    if(m){
      sndState._cpInfoTmp.push({mob:m[1].trim(), loc:m[2].trim()});
      continue;
    }
    sndState._inCpInfo=false;
    buildCpTargets(sndState._cpInfoTmp);
  }
}

// cp check parser
export function parseCpCheckOutput(text){
  for(const raw of text.split(/\r?\n/)){
    const clean=stripAnsi(raw).trim();
    if(!clean) continue;
    const m=clean.match(/^\s*You\s+still\s+have\s+to\s+kill\s+\*\s+(.+?)\s+\((.+?)(\s*-\s*Dead)?\)\s*$/i);
    if(m){
      if(!sndState._inCpCheck){ sndState._inCpCheck=true; sndState._cpCheckTmp=[]; }
      sndState._cpCheckSawKill=true;
      const dead=!!m[3];
      const loc=m[2].trim();
      sndState._cpCheckTmp.push({mob:m[1].trim(), loc:loc, is_dead:dead});
      continue;
    }
    // When every target is dead, `cp check` prints no "still have to kill" lines
    // at all -- only the timer. Without this the block never closed, so a
    // finished campaign was never shown as finished.
    if(/left to finish this campaign/i.test(clean)){
      // Only a reply we asked for, and only one that listed nothing, means the
      // campaign is finished. Without the _cpCheckSawKill guard this fired on
      // the tail of a perfectly normal reply whose kill lines arrived in an
      // earlier chunk, and marked every remaining target dead.
      const finished = sndState._cpCheckExpecting && !sndState._cpCheckSawKill
                       && !sndState._inCpCheck && campaignTargets.length;
      sndState._cpCheckExpecting=false;
      if(finished){ mergeCpCheck([]); continue; }
    }
    if(sndState._inCpCheck){
      sndState._inCpCheck=false;
      if(campaignTargets.length===0){
        buildCpTargetsFromCheck(sndState._cpCheckTmp);
      } else {
        mergeCpCheck(sndState._cpCheckTmp);
      }
      // Trigger pending xcp verification if any
      if(sndState.pendingCpCheckCallback){
        const idx=(sndState.xcpIndex||1)-1;
        const t=campaignTargets[idx];
        const cb=sndState.pendingCpCheckCallback;
        sndState.pendingCpCheckCallback=null;
        cb(!!(t&&t.is_dead));
      }
    }
  }
}

// cp status parser
export function parseCpStatusOutput(text){
  for(const raw of text.split(/\r?\n/)){
    const clean=stripAnsi(raw);
    if(/^\s*You\s+are\s+not\s+currently\s+on\s+a\s+campaign\s*\.?\s*$/i.test(clean) || /^\s*CONGRATULATIONS!\s+You\s+have\s+completed\s+your\s+campaign\s*\.?\s*$/i.test(clean) || /^\s*Campaign\s+cleared\s*\.?\s*$/i.test(clean)){
      sndState.cpType='none';
      campaignTargets=[];
      renderCampaign();
      return;
    }
    if(/^\s*You\s+have\s+.+\s+left\s+to\s+finish\s+this\s+campaign\s*\.?\s*$/i.test(clean)){ sndState.onCp=true; }
  }
}

export function buildCpTargets(infoList){
  // Determine area vs room type by majority
  let areaCount=0, roomCount=0;
  const tmp=[];
  for(const v of infoList){
    const areaUid=resolveAreaUid(v.loc);
    if(areaUid){ areaCount++; tmp.push({...v, type:'area', areaName:areaUid, areaUid:areaUid}); }
    else {
      // A location that is neither a known area nor a room we have walked is very
      // often a room in the REFERENCE map -- one campaign gave "Green lawns",
      // "Parlour", "Before the Prison", "Before the Baron's Manor" and "An aerial
      // street", none of which are areas and none of which had been visited. They
      // were filed as type 'unknown' with areaName set to the room name, so travel
      // looked for a runto keyword called "Green lawns", found none, and every one
      // of those targets had to be walked to by hand.
      //
      // resolveRoomByNameAnywhere imports the area from gaardian_maps.db and hands
      // back the room, so the target gets its real area name and becomes routable.
      const room=resolveRoomByName(v.loc) || resolveRoomByNameAnywhere(v.loc);
      if(room){ roomCount++; tmp.push({...v, type:'room', roomUid:room.uid, roomName:room.name, areaName:room.area, areaUid:room.area}); }
      else { areaCount++; tmp.push({...v, type:'unknown', areaName:v.loc, areaUid:null}); }
    }
  }
  sndState.cpType=(areaCount>=roomCount)?'area':'room';
  campaignTargets=tmp.map((v,i)=>({
    mob:v.mob,
    areaName:v.areaName,
    area:v.areaName,
    areaUid:v.areaUid,
    roomUid:v.roomUid||null,
    roomName:v.roomName||null,
    type:v.type,
    progress:0, total:1, completed:false, is_dead:false,
    index:i+1,
    kw:gmkw(v.mob, v.areaName)
  }));
  appendOutput('[S&D] cp info parsed: '+campaignTargets.length+' targets, type='+sndState.cpType+'\n','quest');
  renderCampaign();
}

export function buildCpTargetsFromCheck(checkList){
  // Build campaign targets directly from cp check output (cp info not available/failed)
  let areaCount=0, roomCount=0;
  const tmp=[];
  for(const v of checkList){
    const areaUid=resolveAreaUid(v.loc);
    if(areaUid){ areaCount++; tmp.push({...v, type:'area', areaName:areaUid, areaUid:areaUid}); }
    else {
      // A location that is neither a known area nor a room we have walked is very
      // often a room in the REFERENCE map -- one campaign gave "Green lawns",
      // "Parlour", "Before the Prison", "Before the Baron's Manor" and "An aerial
      // street", none of which are areas and none of which had been visited. They
      // were filed as type 'unknown' with areaName set to the room name, so travel
      // looked for a runto keyword called "Green lawns", found none, and every one
      // of those targets had to be walked to by hand.
      //
      // resolveRoomByNameAnywhere imports the area from gaardian_maps.db and hands
      // back the room, so the target gets its real area name and becomes routable.
      const room=resolveRoomByName(v.loc) || resolveRoomByNameAnywhere(v.loc);
      if(room){ roomCount++; tmp.push({...v, type:'room', roomUid:room.uid, roomName:room.name, areaName:room.area, areaUid:room.area}); }
      else { areaCount++; tmp.push({...v, type:'unknown', areaName:v.loc, areaUid:null}); }
    }
  }
  sndState.cpType=(areaCount>=roomCount)?'area':'room';
  campaignTargets=tmp.map((v,i)=>({
    mob:v.mob,
    areaName:v.areaName,
    area:v.areaName,
    areaUid:v.areaUid,
    roomUid:v.roomUid||null,
    roomName:v.roomName||null,
    type:v.type,
    progress:v.is_dead?1:0, total:1, completed:!!v.is_dead, is_dead:!!v.is_dead,
    index:i+1,
    kw:gmkw(v.mob, v.areaName)
  }));
  appendOutput('[S&D] cp check parsed: '+campaignTargets.length+' targets, type='+sndState.cpType+'\n','quest');
  // Print the numbers /xcp takes. mergeCpCheck does this, but a FRESH campaign
  // comes through here instead, which is exactly when the list is longest and
  // knowing the numbering matters most.
  liveTargets().forEach((t, i) => {
    appendOutput('        /xcp '+(i+1)+'  '+t.mob+'  ('+t.areaName+')\n','quest');
  });
  renderCampaign();
}

/** Does this `cp check` line refer to the same mob as this target? */
function cpMobMatches(target, entry){
  const a=String(target.mob||'').toLowerCase();
  const b=String(entry.mob||'').toLowerCase();
  if(!a || !b) return false;
  return a===b || a.includes(b) || b.includes(a);
}

export function mergeCpCheck(checkList){
  for(const c of checkList){
    const t=campaignTargets.find(x=>cpMobMatches(x, c));
    if(t){
      t.is_dead=c.is_dead;
      t.completed=c.is_dead;
      if(t.is_dead) t.progress=t.total;
    }
  }
  // `cp check` lists ONLY what is still outstanding -- confirmed live: after
  // killing the barn swallow and the black pegasus, both simply vanished from
  // the output, leaving 8 of the original 10 lines. So anything we know about
  // that the check did not mention is dead.
  //
  // The loop above could never mark anything complete, because it only ever
  // looked at mobs that were still ALIVE. That is why Refresh kept showing a
  // killed mob as target #1.
  let done=0;
  for(const t of campaignTargets){
    if(t.is_dead) continue;
    if(checkList.some(c => cpMobMatches(t, c))) continue;
    t.is_dead=true; t.completed=true; t.progress=t.total;
    done++;
  }
  appendOutput('[S&D] cp check: '+checkList.length+' still to kill'
    + (done ? ', '+done+' newly done' : '')
    + ' ('+campaignTargets.filter(t=>t.completed).length+'/'+campaignTargets.length+' complete)\n','quest');
  // Print the numbers /xcp takes, so there is no guessing which line is which.
  // They are the outstanding targets, in this order -- the whole point of the
  // change in xcpByIndex.
  liveTargets().forEach((t, i) => {
    appendOutput('        /xcp '+(i+1)+'  '+t.mob+'  ('+t.areaName+')\n','quest');
  });
  renderCampaign();
}

export function xcpNext(){
  if(sndState.cpType==='none'){ appendOutput('[S&D] Not on a campaign.\n','error'); return; }
  // The first outstanding target -- by live position, which is what xcpByIndex
  // now counts. Passing t.index here would mean "the t.index-th LIVE target",
  // which is a different target as soon as anything has died.
  if(liveTargets().length){ xcpByIndex(1); return; }
  appendOutput('[S&D] no live targets left.\n','error');
}

/** The targets still to kill, in the order `cp check` prints them. */
export function liveTargets(){
  return campaignTargets.filter(t => !t.is_dead && !t.skipped);
}

/**
 * `/xcp <n>` counts the targets that are STILL OUTSTANDING.
 *
 * It used to index the whole campaign, dead ones included, while `cp check`
 * prints only what is left -- so after ten kills the two remaining lines read as
 * 1 and 2 were internally 9 and 12, and `/xcp 2` picked something already dead.
 * That misfired three times in one session, twice dragging the character across
 * the world to the wrong target. The number now means what the game just showed.
 *
 * A name works too: `/xcp boy` or `/xcp trumpet`, which does not shift at all.
 */
export function xcpByIndex(index, overrideKw){
  const raw = String(index == null ? '' : index).trim();
  const idx=parseInt(raw);
  if(idx===0){
    sndState.xcpIndex=0; sndState.shortMobName=''; sndState.pendingXcp=null; sndState.xcpAwaitingArea=null;
    // Clearing the target used to leave the walk itself running: in Wedded Bliss
    // the character kept pacing between two rooms for minutes after `/xcp 0`,
    // and the only thing that stopped it was reloading the page. `/xcp 0` is the
    // stop button, so it has to stop the movement too.
    cancelWalk('xcp cleared');
    appendOutput('[S&D] xcp target cleared.\n','system');
    return;
  }
  const live = liveTargets();
  let t = null;
  if(/^\d+$/.test(raw)){
    t = live[idx-1];
    if(!t){
      appendOutput('[S&D] there '+(live.length===1?'is':'are')+' only '+live.length
        + ' target'+(live.length===1?'':'s')+' left; /campaign to see them.\n','error');
      return;
    }
  } else if(raw){
    // Match on the mob name -- immune to the list shifting under you.
    const hits = live.filter(x => String(x.mob||'').toLowerCase().includes(raw.toLowerCase()));
    if(!hits.length){ appendOutput('[S&D] no live target matching "'+raw+'".\n','error'); return; }
    if(hits.length > 1){
      appendOutput('[S&D] "'+raw+'" matches '+hits.map(h=>h.mob).join(', ')+' -- be more specific.\n','error');
      return;
    }
    t = hits[0];
  }
  if(!t){ appendOutput('[S&D] Invalid xcp target: '+index+'\n','error'); return; }
  if(t.type==='unknown'){
    appendOutput('[S&D] '+t.mob+': exact room unknown; will discover via where.\n','quest');
  }
  sndState.xcpIndex=t.index;
  sndState.shortMobName=t.kw;
  sndState.pendingXcp=null;
  sndState.xcpAwaitingArea=null;
  // A stale "kill" or twin probe from the previous target would otherwise send
  // this one off sweeping rooms the moment the game says "They aren't here".
  sndState.pendingKill=null;
  sndState.pendingTwinProbe=null;
  appendOutput('[S&D] xcp: '+t.mob+' ('+t.type+' in '+t.areaName+')\n','quest');
  let htkw = overrideKw || t.htkwOverride || huntTrickKw(t.mob);
  let kw = gmkw(t.mob);
  const pending={...t, recallSent:false, located:false, roomQueue:[], roomIndex:0, whereInstances:null, huntTrickIndex:1, campaignInstance:null, htkw:htkw, kw:kw};
  sndState.pendingXcp=pending;
  // A throw in here used to vanish -- the runaway recursion above blew the stack
  // and `/xcp` simply printed the target line and stopped, with nothing to say
  // why. Surface it in the output pane, not just the devtools console.
  try {
    xcpStep(pending);
  } catch(e){
    appendOutput('[S&D] internal error while starting this target: '+(e&&e.message||e)+'\n','error');
    console.error('xcpStep failed', e);
    sndState.pendingXcp=null;
  }
}

// How long the character may stand still, mid-runto, before we give up on it.
// Measured from the last room change rather than from the start of the journey.
const RUNTO_STALL_MS = 15000;
// A whole speedwalk still has to end sometime, even if it keeps moving.
const RUNTO_TOTAL_MS = 120000;

export function armRuntoWatchdog(t){
  if(sndState.xcpAwaitingTimer) clearTimeout(sndState.xcpAwaitingTimer);
  if(!sndState.xcpAwaitingStart) sndState.xcpAwaitingStart = Date.now();
  sndState.xcpAwaitingTimer = setTimeout(()=>{
    if(!sndState.xcpAwaitingArea) return;
    sndState.xcpAwaitingArea = null;
    sndState.xcpAwaitingStart = null;
    appendOutput('[S&D] stopped moving before reaching '+t.areaName+'; skipping this target.\n','error');
    xcpAbandonTarget(t, 'runto did not arrive');
  }, RUNTO_STALL_MS);
}

/**
 * Called from gmcp.js on every room.info: the character is still travelling, so
 * push the deadline back. Without this a long `runto` was cut off mid-walk.
 */
export function noticeTravelProgress(){
  const t = sndState.pendingXcp;
  if(!t || !sndState.xcpAwaitingArea || !sndState.xcpAwaitingTimer) return;
  if(sndState.xcpAwaitingStart && Date.now() - sndState.xcpAwaitingStart > RUNTO_TOTAL_MS) return;
  armRuntoWatchdog(t);
}

export function xcpRecall(t, onComplete){
  // User's recall alias is an equipment sequence, not the simple 'rec' command.
  const recallSeq=(sndState.recallSequence||DEFAULT_RECALL).split(';');
  let delay=0;
  for(const cmd of recallSeq){
    const c=cmd.trim();
    if(!c) continue;
    // sendCmd, not sendCmdRaw. Raw skips alias expansion, so `wear wpn` went to
    // the game as the literal string "wear wpn" -- and `wpn` is the alias for the
    // actual weapon (`poly`). The recall sequence therefore re-wore nothing and
    // left the character unarmed after every hop.
    setTimeout(()=>sendCmd(c), delay);
    delay+=1000;
  }
  // Give Aardwolf time to finish the recall before runto.
  setTimeout(onComplete, delay+1500);
}

/**
 * Give up on one target and move to the next, rather than retrying forever.
 * Every dead end in the old code just nulled pendingXcp and stopped silently.
 */
export function xcpAbandonTarget(t, reason){
  if(sndState.xcpAwaitingTimer){ clearTimeout(sndState.xcpAwaitingTimer); sndState.xcpAwaitingTimer=null; }
  sndState.xcpAwaitingArea=null;
  sndState.xcpRuntoTarget=null;
  sndState.pendingXcp=null;
  sndState.xcpNav=null;
  sndState.pendingKill=null;
  sndState.pendingTwinProbe=null;
  if(isWalking()) cancelWalk(reason);
  if(t) t.skipped=reason || 'skipped';
  // A quest target is not in campaignTargets, so the count below would report on
  // an unrelated campaign and tell the player to type /xcp.
  if(t && t.isQuest && questHooks && questHooks.abandonNote){ questHooks.abandonNote(); return; }
  const remaining=campaignTargets.filter(x=>!x.is_dead && !x.skipped);
  // Deliberately does NOT chain into the next target on its own. Aardwolf's
  // 'help policies7' names "read campaign information to automatically go to
  // areas, find and kill mob" as botting, and an unattended target-to-target
  // loop is exactly that. Stop here and let the player choose to continue.
  if(remaining.length){
    appendOutput('[S&D] '+remaining.length+' target(s) left -- /xcp when you want the next one.\n','quest');
  } else {
    appendOutput('[S&D] no auto-navigable targets left.\n','quest');
  }
}

/**
 * Do what the game just told us to do.
 *
 *   You cannot run to The DarkLight.
 *   Note: Look for the Andromeda Galaxy in Vidblain. Coords 14,23.
 *
 * runto the area the note names, steer to the coordinate (see walkToCoords --
 * on a continent every room reports its own, so this needs no map of the place,
 * which is the point: these are the areas the map does not cover), then try the
 * landmark. Each stage reports and stops rather than falling through, because a
 * wrong turn on a continent is a long walk.
 *
 * Returns false if the note is not actionable, so the caller can abandon.
 */
// A held portal is used with a bare `enter` (help portals). Confirmed with the
// Amulet of the Planes: `enter amulet`, `enter planes`, `use amulet` and `rub
// amulet` are all refused; holding it and typing `enter` works.
const CARRYING = /^you are carrying:/im;
const NOT_CARRYING = /nothing with name or keyword|you do not have that|^you (?:do not|don'?t) have/im;
const HELD_OK = /you (?:hold|are now holding|wield)/im;

// =============================================================================
// THE ASTRAL POOLS
// =============================================================================
// The Amulet of the Planes does not put you in a plane -- it puts you on an
// Astral Plane, a one-room-wide corridor of pools, and the pool you walk to
// decides which plane you end up in. `look pools` in the first room prints the
// list, and the pools sit in that order going east:
//
//        1) Gladsheim        6)  Twin Paradises   11) Beastlands
//        2) Pandemonium      7)  Arcadia          12) Realm of the Zodiac
//        3) Hades            8)  Seven Heavens    13) Thandeld's Conflict
//        4) Gehenna          9)  Swordbreaker's Hoard  14) Nine Hells
//        5) Acheron          10) Elysium
//
// so pool N is N rooms east of the note room, and `enter pool` uses it. That is
// the whole mechanism, and it was the missing half of "reached with the Amulet of
// the Planes": the helper handed over an amulet, announced the Astral Plane and
// stopped, leaving the actual travel to be typed by hand -- twice in one session,
// once for the Twin Paradises and once for Hades.
//
// Aardwolf calls the areas "The Upper Planes" / "The Lower Planes", and the plane
// a target sits in has to be read from the ROOM name, which names its layer:
// "On the Pluton Gloom of Hades", "On the Dothion layer of the Twin Paradises".
const POOL_ORDER = ['gladsheim', 'pandemonium', 'hades', 'gehenna', 'acheron',
                    'twin paradises', 'arcadia', 'seven heavens',
                    "swordbreaker's hoard", 'elysium', 'beastlands',
                    'realm of the zodiac', "thandeld's conflict", 'nine hells'];

/** Which pool leads to this target, from its room name, or 0 if none does. */
export function poolIndexFor(t){
  const hay = ((t && (t.roomName || t.loc)) || '').toLowerCase();
  if(!hay) return 0;
  // Longest name first so "seven heavens" is not shadowed by a shorter match.
  const byLength = POOL_ORDER.map((n, i) => [n, i + 1]).sort((a, b) => b[0].length - a[0].length);
  for(const [name, n] of byLength) if(hay.includes(name)) return n;
  return 0;
}

/**
 * Walk the astral corridor to the target's pool and step into it.
 *
 * Returns false when the target is not in a plane we can identify, so the caller
 * can fall back to telling the player where they are.
 */
function enterPoolFor(t){
  const n = poolIndexFor(t);
  if(!n) return false;
  appendOutput('[S&D] '+(t.roomName || t.areaName)+' is through pool '+n
    + '; walking the astral corridor.\n','quest');
  let step = 0;
  const walk = () => {
    if(sndState.pendingXcp !== t) return;            // target changed under us
    if(step < n){
      step++;
      sendCmdRaw('e');
      setTimeout(walk, 1600);
      return;
    }
    sendCmdRaw('enter pool');
    setTimeout(()=>{
      if(sndState.pendingXcp !== t) return;
      appendOutput('[S&D] arrived in '+(currentRoom.name||'?')+' ['+(currentRoom.area||'?')+'].\n','quest');
      t.recallSent = true;      // we are in the plane; do not recall back out
      xcpStep(t);
    }, 3500);
  };
  setTimeout(walk, 1200);
  return true;
}

/** Feed MUD output here while an entry item is being readied. */
export function parseEntryItemOutput(text){
  const st = sndState.pendingEntryItem;
  if(!st) return;
  if(Date.now() - st.ts > 10000){ sndState.pendingEntryItem = null; return; }
  const clean = stripAnsi(text);

  if(st.stage === 'check'){
    if(NOT_CARRYING.test(clean)){
      // The keyword may simply be the wrong end of the name; try the next before
      // concluding the item is missing.
      if(st.kwIndex + 1 < st.kws.length){
        st.kwIndex++;
        st.kw = st.kws[st.kwIndex];
        st.ts = Date.now();
        sendCmdRaw('i '+st.kw);
        return;
      }
      // `i` lists INVENTORY, and a held portal is not in inventory -- it is in the
      // hand. So "not carrying" is not proof of absence: standing on the Astral
      // Plane with the amulet already held, this reported the amulet missing and
      // abandoned the target. Check the equipment before believing it.
      if(!st.checkedEq){
        st.checkedEq = true;
        st.stage = 'eq';
        st.ts = Date.now();
        sendCmdRaw('eq');
        // The listing runs to a couple of dozen lines across several chunks, so
        // give it time and let the timer decide, not a line of the listing.
        setTimeout(()=>{
          if(sndState.pendingEntryItem !== st || st.stage !== 'eq') return;
          sndState.pendingEntryItem = null;
          appendOutput('[S&D] you do not have '+st.item+', which is how you reach '
            + st.areaName + '. '+(st.note||'')+'\n','error');
        }, 5000);
        return;
      }
      sndState.pendingEntryItem = null;
      appendOutput('[S&D] you are not carrying '+st.item+', which is how you reach '
        + st.areaName + '. '+(st.note||'')+'\n','error');
      return;
    }
    if(CARRYING.test(clean)){
      st.stage = 'hold';
      st.ts = Date.now();
      appendOutput('[S&D] you have '+st.item+'; holding it.\n','quest');
      sendCmdRaw('hold '+st.kw);
      return;
    }
    return;
  }
  if(st.stage === 'eq'){
    // Held already? Then there is nothing to hold and we can use it straight away.
    // Match on any word of the item name, since `eq` prints the full item and the
    // hint gives a title ("Amulet of the Planes" vs "the amulet of the planes").
    const words = String(st.item||'').toLowerCase().split(/\s+/)
      .filter(w => w.length > 3 && !/^(the|of|and)$/.test(w));
    const hit = words.length && words.every(w => clean.toLowerCase().includes(w));
    if(hit){
      st.stage = 'enter';
      st.ts = Date.now();
      appendOutput('[S&D] '+st.item+' is already in hand; using it.\n','quest');
      sendCmdRaw('enter');
      setTimeout(()=>{
        if(sndState.pendingEntryItem !== st) return;
        const t = st.t;
        sndState.pendingEntryItem = null;
        if(t && enterPoolFor(t)) return;
        appendOutput('[S&D] you are in '+(currentRoom.name||'?')+' ['+(currentRoom.area||'?')+'].\n','quest');
      }, 4000);
      return;
    }
    // Do NOT conclude "missing" from a line of the eq listing. "You are using:" is
    // its HEADER and arrives in an earlier chunk than the item, so testing for it
    // declared the amulet absent while it was sitting in the Held slot two chunks
    // later. The verdict belongs to the timer armed when this stage started.
    return;
  }
  if(st.stage === 'hold'){
    // "You do not have that item" here means it is already held, not missing --
    // holding moves it out of inventory into the hand slot.
    if(HELD_OK.test(clean) || NOT_CARRYING.test(clean)){
      st.stage = 'enter';
      st.ts = Date.now();
      appendOutput('[S&D] using it (a held portal takes a bare "enter").\n','quest');
      sendCmdRaw('enter');
      setTimeout(()=>{
        if(sndState.pendingEntryItem !== st) return;
        const t = st.t;
        sndState.pendingEntryItem = null;
        appendOutput('[S&D] you are in '+(currentRoom.name||'?')+' ['+(currentRoom.area||'?')+'].'
          + ' /navto ' + (currentRoom.uid||'?') + ' comes back here -- note it, some planes\n'
          + '       can only be left from the room you arrived in.\n','quest');
        // The amulet lands on an Astral Plane, which is a corridor of pools rather
        // than the destination. Take the rest of the journey too.
        if(t && enterPoolFor(t)) return;
        appendOutput('[S&D] then /xcp again.\n','quest');
      }, 4000);
      return;
    }
  }
}

/**
 * The note names an item rather than a place: carry it, hold it, use it.
 *
 * "Use the Amulet of the Planes." has no area and no coordinate, so
 * followEntryHint had nothing to act on and simply reported the note. The amulet
 * is a held portal, and Aardwolf uses those with a bare `enter` -- documented only
 * in `help portals`, plural; `enter amulet`, `use amulet` and `rub amulet` are all
 * refused.
 */
/**
 * Keywords to try for an item name, best first.
 *
 * "Amulet of the Planes" is targeted as `amulet`, not `planes` -- `i planes` and
 * `enter planes` were both refused live. The head noun sits BEFORE "of", so a
 * plain last-word rule picks exactly the wrong end. Everything else ("magic
 * carpet") does want the last word, so try the head noun first and fall back.
 */
function itemKeywords(name){
  const words = String(name||'').toLowerCase().replace(/[^a-z0-9 ]/g,' ')
    .split(/\s+/).filter(w => w && !/^(a|an|the)$/.test(w));
  if(!words.length) return [];
  const ofAt = words.indexOf('of');
  const out = [];
  if(ofAt > 0) out.push(words[ofAt-1]);      // 'amulet' from 'amulet of the planes'
  out.push(words[words.length-1]);           // 'carpet' from 'magic carpet'
  out.push(words[0]);
  return [...new Set(out)];
}

function useEntryItem(t, hint){
  const item = String(hint.item || '').trim();
  if(!item) return false;
  const kws = itemKeywords(item);
  if(!kws.length) return false;
  appendOutput('[S&D] '+t.areaName+' is reached with "'+item+'"; checking you have it.\n','quest');
  sndState.pendingEntryItem = {t, item, kws, kwIndex: 0, kw: kws[0],
                               areaName: t.areaName, note: hint.note,
                               stage: 'check', ts: Date.now()};
  sendCmdRaw('i '+kws[0]);
  return true;
}

export function followEntryHint(t, hint){
  if(hint && hint.item && !hint.area) return useEntryItem(t, hint);
  if(!hint || !hint.area || hint.x == null) return false;
  const bridge = lookupArea(hint.area);
  if(!bridge || bridge.nogo){
    appendOutput('[S&D] no runto keyword for '+hint.area+'; get there yourself, then /xcp '
      + t.index + '.\n','error');
    return false;
  }
  appendOutput('[S&D] following the note: runto '+bridge.key+', then steering to '
    + hint.x + ',' + hint.y + '\n','quest');
  xcpRecall(t, ()=>{
    sendCmd(RUNTO + bridge.key);
    awaitAreaThen(hint.area, ()=>{
      walkToCoords(hint.x, hint.y, ()=>{
        // Standing on the coordinate. Before guessing a command from the landmark
        // name, ask the map: the way in is an ordinary exit once it has been walked
        // even once, and GMCP records it the first time. Zenith Trail leads UP into
        // Before the Keep -- `enter trail`, which the landmark name suggests, is
        // simply wrong, and guessing it looped the whole journey.
        if(t.roomUid){
          const p = findPath(currentRoom.uid, t.roomUid);
          if(p && p.length){
            appendOutput('[S&D] at '+hint.x+','+hint.y+'; the map knows the rest ('
              + p.length + ' step'+(p.length===1?'':'s')+').\n','quest');
            gotoRoomUid(t.roomUid, ()=>{ sndState.pendingXcp = t; t.recallSent = true; xcpStep(t); },
                        {noAreaHop:true});
            return;
          }
        }
        // Nothing learned yet, so fall back to the landmark. One attempt only:
        // re-entering xcpStep on failure sent the character round the whole
        // recall/runto/steer circuit again and again.
        if(t.landmarkTried){
          appendOutput('[S&D] at '+hint.x+','+hint.y+' but "'+(hint.landmark||'the landmark')
            + '" did not let us in. '+(hint.note||'')+'\n','error');
          xcpAbandonTarget(t, 'landmark did not work');
          return;
        }
        t.landmarkTried = true;
        const kw = landmarkKeyword(hint.landmark);
        if(!kw){
          appendOutput('[S&D] at '+hint.x+','+hint.y+'. '+(hint.note||'')
            + ' -- enter it, then /xcp '+t.index+'.\n','quest');
          return;
        }
        appendOutput('[S&D] at '+hint.x+','+hint.y+'; trying "enter '+kw+'"\n','quest');
        sendCmd('enter '+kw);
        // Give the move a moment, then let xcpStep decide: if we are now inside
        // the target area it carries on, and if not it says so.
        setTimeout(()=>{
          if(sndState.pendingXcp!==t && sndState.pendingXcp!=null) return;
          sndState.pendingXcp = t;
          t.recallSent = false;
          xcpStep(t);
        }, 2500);
      }, (reason)=>{
        appendOutput('[S&D] could not reach '+hint.x+','+hint.y+' ('+reason
          + '). '+(hint.note||'')+'\n','error');
        xcpAbandonTarget(t, 'coord walk failed');
      });
    });
  });
  return true;
}

/** Watch MUD output for a failed `rt` so we do not wait out the full timeout. */
export function parseRuntoOutput(text){
  const t=sndState.xcpRuntoTarget;
  if(!t || !sndState.xcpAwaitingArea) return;
  if(!runtoFailed(text)) return;
  sndState.xcpAwaitingArea=null;
  sndState.xcpRuntoTarget=null;
  appendOutput('[S&D] runto was refused for '+t.areaName+'.\n','error');
  // The refusal usually comes with the answer attached:
  //   You cannot run to The DarkLight.
  //   Note: Look for the Andromeda Galaxy in Vidblain. Coords 14,23.
  // Areas reachable only through a landmark in another area are precisely the
  // ones no canned speedwalk covers, so this note is the only routing
  // information that exists for them. Keep it rather than throwing it away with
  // the rest of the reply, and say it out loud.
  const hint = parseRuntoNote(text);
  if(hint){
    rememberEntryHint(t.areaName, hint);
    appendOutput('[S&D] the game says how: '+hint.note+'\n','quest');
    if(followEntryHint(t, hint)) return;
  }
  xcpAbandonTarget(t, hint ? 'runto refused (entry hint saved)' : 'runto refused');
}

export function xcpStep(t){
  // Normalize target area on the fly for unknown-type targets.
  if(t.type==='unknown' || !t.areaUid){
    const resolvedArea=resolveAreaUid(t.areaName);
    if(resolvedArea){ t.areaName=resolvedArea; t.area=resolvedArea; t.areaUid=resolvedArea; t.type='area'; }
  }
  // 1. Recall + runto to the target area first, unless we already know we are in it.
  // where only works inside the target area, so this is required for reliable routing.
  // We skip recall when currentRoom.area matches the target area (avoids recalling out of the area).
  // Use a broader check that also tolerates short area prompts like [hedge] vs Hedgehogs' Paradise.
  // canonicalArea first: GMCP gives the keyword ('landofoz') and the campaign
  // the display name ('The Land of Oz'), and neither substring test can bridge
  // those. The looser tests stay for areas we have not learned a keyword for.
  const alreadyInArea=currentRoom.area && (
    canonicalArea(t.areaName) === canonicalArea(currentRoom.area) ||
    t.areaName.toLowerCase().includes(currentRoom.area.toLowerCase()) ||
    currentRoom.area.toLowerCase().includes(t.areaName.toLowerCase()) ||
    areaNameMatches(t.areaName, currentRoom.area)
  );
  // Travel is gated on knowing the AREA NAME, not on `areaUid`. areaUid is only
  // set once the area exists in the local map, so for an area never visited the
  // target stayed type 'unknown', step 1 was skipped entirely, and the helper
  // went straight to `where` -- which only works inside the target area. That is
  // why the Cowardly Lion needed a manual `rec` and `rt oz` first: the client
  // never recalled or ran anywhere, it just asked `where` from the wrong side of
  // the world. The keyword comes from lookupArea(t.areaName), which needs no
  // local map at all.
  if(t.areaName && !t.recallSent && !alreadyInArea){
    const area=lookupArea(t.areaName);
    if(!area){
      appendOutput('[S&D] no runto keyword for "'+t.areaName+'"; skipping this target.\n','error');
      xcpAbandonTarget(t, 'unknown area');
      return;
    }
    if(area.nogo){
      // Clan halls, mazes, epic areas: runto has no entry for these and walking
      // in is not something we can plan. Say so and move on instead of looping.
      appendOutput('[S&D] "'+t.areaName+'" cannot be auto-navigated (no route exists). '
        + 'Walk there yourself, then /xcp '+t.index+'.\n','error');
      xcpAbandonTarget(t, 'no-go area');
      return;
    }
    // Already refused once, with the game's own explanation on record. Spending
    // another recall to be told the same thing is the loop this helper exists to
    // avoid, so report what we know instead.
    const known = entryHint(t.areaName);
    if(known && known.norunto){
      appendOutput('[S&D] runto cannot reach '+t.areaName+'.\n','error');
      // Act on the hint before giving up -- ANY hint, not just an item one. This
      // used to be `known.item && ...`, so a COORDINATE hint printed "get there
      // yourself (via Vidblain at 10,15)" and abandoned the target, even though
      // followEntryHint's whole other half exists to runto the bridging area and
      // steer to that coordinate. Doing it by hand (runto vidblain, /navcoord
      // 10,15, then `u` into the Keep) worked first time, which is precisely the
      // sequence this branch already knows how to issue.
      if(followEntryHint(t, known)) return;
      if(known.note) appendOutput('[S&D] the game says: '+known.note+'\n','quest');
      appendOutput('[S&D] get there yourself'
        + (known.area ? ' (via '+known.area
            + (known.x != null ? ' at '+known.x+','+known.y : '')+')' : '')
        + ', then /xcp '+t.index+' from inside.\n','quest');
      xcpAbandonTarget(t, 'runto refused before');
      return;
    }
    if(area.lock && charLevel && charLevel < area.lock){
      appendOutput('[S&D] "'+t.areaName+'" is locked until level '+area.lock
        + ' (you are '+charLevel+'); skipping.\n','error');
      xcpAbandonTarget(t, 'level locked');
      return;
    }
    if(area.guessed){
      // Do not fire a guessed keyword at the game. Aardwolf's keywords are
      // arbitrary -- `kobaloi` for "Keep of the Kobaloi", `tilule` for "Tilule
      // Rehabilitation Clinic" -- so nothing derived from the display name is
      // reliable, and the old first-word-truncated-to-five guess sent
      // `rt earth` for Earth Plane 4. Ask the game for the real list instead;
      // it is one command and it fixes every area at once.
      if(!sndState.harvestedThisSession){
        sndState.harvestedThisSession = true;
        appendOutput('[S&D] no runto keyword on record for "'+t.areaName
          + '" -- fetching the real list from the game, then retrying.\n','quest');
        harvestAreaKeywords();
        setTimeout(()=>{ if(sndState.pendingXcp===t) xcpStep(t); }, 12000);
        return;
      }
      appendOutput('[S&D] the game\'s area list has no keyword for "'+t.areaName
        + '"; walk there yourself, then /xcp '+t.index+'.\n','error');
      xcpAbandonTarget(t, 'no runto keyword');
      return;
    }
    const kw=area.key;
    t.recallSent=true;
    sndState.xcpAwaitingArea=t.areaName.toLowerCase();
    sndState.xcpRuntoTarget=t;
    appendOutput('[S&D] recalling to '+t.areaName+' ('+RUNTO+kw+')...\n','quest');
    xcpRecall(t, ()=>{
      sendCmd(RUNTO+kw);
      // If the area never turns up, abandon this target. The old code carried on
      // to `where` anyway -- but `where` only works inside the target area, so
      // that just burned commands in the wrong place and never converged.
      //
      // The deadline is on being STUCK, not on the journey: `runto` walks a
      // speedwalk that can easily run past a flat 12s, and killing it mid-walk
      // was the "it timed out but I still got moved" case. armRuntoWatchdog is
      // re-armed by every room.info (see noticeTravelProgress), so it only fires
      // once the character has genuinely stopped moving.
      armRuntoWatchdog(t);
    });
    return;
  }
  // Standing in the target area already: there is no recall to do, so record the
  // step as done. Without this, step 2's "area was just discovered, go back and
  // recall first" guard sees `!recallSent` forever and re-enters xcpStep on every
  // pass -- unbounded recursion that blows the stack and prints nothing at all,
  // which is exactly what `/xcp 1` did from inside the mob's own area.
  if(alreadyInArea) t.recallSent=true;

  // 2. Locate exact instance via where. Ensure target area is imported first so room names are resolvable.
  if(!t.located){
    if(t.type==='unknown' || !t.areaUid){
      const found=findAreaAnywhere(t.areaName);
      if(found){ t.areaName=found; t.area=found; t.areaUid=found; t.type='area'; }
    }
    // If area was just discovered and we haven't recalled yet, run the recall step first.
    if(t.areaUid && !t.recallSent){
      xcpStep(t);
      return;
    }
    // For campaign-hunt mode, the hunt trick comes FIRST -- it is free, needs no
    // travel, and names the exact copy, so `where` then has one ordinal to place
    // rather than a list to enumerate and guess between. This is the order
    // help/HuntTrick describes. If hunt cannot resolve the ordinals (outside the
    // area, or a keyword that matches other mobs too) it falls through to the
    // enumeration below on its own.
    if(sndState.xcpMode==='ch' && !t.huntTried){
      t.huntTried = true;
      if(xcpIdentifyInArea(t)) return;
    }
    // For campaign-hunt mode, enumerate instances with where 1.<full name>, where 2.<full name>, etc.
    if(sndState.xcpMode==='ch' || sndState.xcpMode==='ht'){
      if(!t.whereInstances){
        appendOutput('[S&D] locating '+t.mob+' instances...\n','quest');
        t.whereInstances=[];
        t.whereIndex=1;
        xcpQueryWhereInstance(t, 1);
        return;
      }
    } else {
      // nearest / qw: one keyword, walking the ordinals until the NAME matches.
      t.whereKw=whereKw(t.mob);
      t.whereOrd=t.whereOrd||1;
      appendOutput('[S&D] locating '+t.mob+' (where '+(t.whereOrd>1?t.whereOrd+'.':'')+t.whereKw+')...\n','quest');
      sendCmd('where '+(t.whereOrd>1?t.whereOrd+'.':'')+t.whereKw);
    }
    return;
  }
  // 3. Mode-specific instance handling
  if(sndState.xcpMode==='nearest'){
    if(!t.campaignInstance){
      xcpRunNearest(t);
      return;
    }
  } else if(sndState.xcpMode==='ch'){
    // Campaign hunt: test each where instance with hunt n.<full mob name>.
    // The campaign mob is the one that cannot be hunted.
    if(!t.campaignInstance){
      if(!t.whereInstances || t.whereInstances.length===0){
        appendOutput('[S&D] no campaign-hunt candidates found.\n','quest');
        sndState.pendingXcp=null;
        return;
      }
      xcpRunCampaignHunt(t);
      return;
    }
  } else {
    // Classic hunt trick mode
    if(!t.campaignInstance){
      xcpRunHuntTrick(t);
      return;
    }
  }
  // 4. Move to the identified instance's room
  xcpGotoInstance(t);
}

export function xcpRunNearest(t){
  if(!t.whereInstances || t.whereInstances.length===0){
    appendOutput('[S&D] no instances found; retrying where in 3s...\n','quest');
    t.located=false;
    setTimeout(()=>xcpStep(t), 3000);
    return;
  }
  // Resolve all instance room names to UIDs and pick nearest to current room
  if(!t.nearestQueue){
    const resolved=[];
    for(const inst of t.whereInstances){
      let room=null;
      if(inst.roomUid){
        room={uid:inst.roomUid, name:inst.roomName};
      } else if(inst.roomName){
        room=resolveRoomByNameAnywhere(inst.roomName, t.areaName);
      }
      if(room) resolved.push({...inst, roomUid:room.uid, roomName:room.name});
    }
    if(resolved.length===0){
      appendOutput('[S&D] No where instances could be resolved to mapped rooms; falling back to hunt trick.\n','quest');
      sndState.xcpMode='ht';
      xcpRunHuntTrick(t);
      return;
    }
    // Sort by real path length, nearest first.
    const dists={};
    for(const r of resolved){
      const path=findPath(currentRoom.uid, r.roomUid);
      dists[r.roomUid]=path?path.length:Infinity;
    }
    resolved.sort((a,b)=>dists[a.roomUid]-dists[b.roomUid]);
    t.nearestQueue=resolved.slice();
    t.nearestIndex=0;
    appendOutput('[S&D] nearest mode: '+resolved.length+' candidate room(s)\n','quest');
  }
  if(t.nearestIndex>=t.nearestQueue.length){
    appendOutput('[S&D] nearest mode exhausted all candidates without kill confirmation. Switching to hunt trick.\n','quest');
    t.nearestQueue=null;
    sndState.xcpMode='ht';
    xcpRunHuntTrick(t);
    return;
  }
  const inst=t.nearestQueue[t.nearestIndex];
  t.campaignInstance=inst;
  appendOutput('[S&D] nearest candidate #'+(t.nearestIndex+1)+': '+inst.roomName+'\n','quest');
  xcpGotoInstance(t);
}

export function xcpRunCampaignHunt(t){
  if(!t.whereInstances || t.whereInstances.length===0){
    appendOutput('[S&D] no instances found; retrying where in 3s...\n','quest');
    t.located=false;
    setTimeout(()=>xcpStep(t), 3000);
    return;
  }
  // Work through instances 1..N
  if(t.huntTrickIndex===undefined || t.huntTrickIndex<1) t.huntTrickIndex=1;
  if(t.huntTrickIndex>t.whereInstances.length){
    appendOutput('[S&D] all instances tested; no campaign mob found.\n','quest');
    sndState.pendingXcp=null;
    return;
  }
  const inst=t.whereInstances[t.huntTrickIndex-1];
  t.campaignInstance=inst;
  // Travel first, identify afterwards.
  //
  // The hunt trick -- the campaign mob is the one that cannot be hunted -- was
  // being run from wherever the player happened to be standing, BEFORE going
  // anywhere. That is the one place it cannot work. `hunt` resolves an ordinal
  // only when you are in the room with the mobs; from elsewhere in the area it
  // answers "No one in this area by the name '1.senator'.", and from outside the
  // area "You couldn't find a path to a senator from here." Neither says anything
  // about which copy is the target, so the identification never happened and the
  // helper fell back to killing whichever copy `kill <kw>` picked first.
  //
  // Proved in The Knossos Senate: from outside, `hunt 1.senator` failed both
  // ways; standing in the room, `hunt senator`, `hunt 2.senator` and
  // `hunt 3.senator` all answered "A senator is here!" -- ordinals resolving
  // perfectly, and every copy huntable, which is how we know the campaign
  // senator was not among them.
  //
  // So go to the room, then test the copies there. One instance still needs no
  // test at all.
  if(t.whereInstances.length===1){
    appendOutput('[S&D] only one '+t.mob+' here, in '+inst.roomName+' -- going straight there.\n','quest');
  } else {
    appendOutput('[S&D] '+t.whereInstances.length+' copies reported; going to '
      + inst.roomName + ' to find which one is the campaign mob.\n','quest');
  }
  xcpGotoInstance(t);
}

// =============================================================================
// IDENTIFYING THE CAMPAIGN COPY, IN THE ROOM
// =============================================================================

const HUNT_UNABLE   = /unable\s+to\s+hunt\s+that\s+target|seem\s+unable\s+to\s+hunt/i;
const HUNT_IS_HERE  = /\bis here\b/i;
// A direction is the other "yes, this one is huntable" answer, and it stalled the
// identify outright: `hunt head` replied "You are confident that Berta passed
// through here, heading west." That matched none of the patterns, so `awaiting`
// stayed armed and the machine sat waiting for a reply it had already been given.
// For identification a direction means the same as "is here" -- huntable, so not
// the campaign mob -- so it advances to the next copy.
const HUNT_DIRECTION = /passed through here|you are confident that|\btrail\b.*\b(?:leads|heads|goes)\b|you are certain that|\bis (?:north|south|east|west|up|down) from here\b|heading (?:north|south|east|west|up|down)|hunting (?:north|south|east|west|up|down)/i;
// Hunt replies NAME the mob, which is the way out of the keyword problem below.
const HUNT_NAMES = [
  /^(?:you are confident that\s+)?(.+?)\s+passed through here/im,
  /^(?:you are confident that\s+)?(.+?)\s+is here\b/im,
  /^you are (?:now )?hunting\s+(.+?)\s*[.!]/im,
];

/** The mob a hunt reply is talking about, or null. */
function huntedName(text){
  for(const re of HUNT_NAMES){
    const m = text.match(re);
    if(m && m[1] && m[1].length < 60) return m[1].trim();
  }
  return null;
}
const HUNT_NO_SUCH  = /no one (?:in this area |here )?by (?:the |that )?name|could ?n[o']?t find a path|you are not hunting/i;
const IDENTIFY_MAX  = 12;

/**
 * Standing in the room, work out which copy is the campaign mob.
 *
 * `hunt <n>.<kw>` on an ordinary copy answers "A senator is here!"; on the
 * campaign mob it is refused. That refusal is the only thing that distinguishes
 * them, and it is available only from here.
 */
export function xcpIdentifyHere(t){ return startIdentify(t, 'kill'); }

/**
 * Identify the campaign copy, then ask `where` the same ordinal to place it.
 *
 * This is the order help/HuntTrick gives, and it is the right way round: hunt
 * costs nothing and needs no travel, so finding the copy first means travelling
 * once, to a room the target is actually in. Identifying on arrival instead
 * bought a wasted trip to The Knossos Senate for a senator that was not there.
 *
 * The ordinals do line up between `hunt` and `where` -- for a keyword that
 * matches only this mob. `where 6.small` in Hedgehogs' Paradise was counting a
 * small worker bee and a small apple tree as well as the hedgehog, so ITS sixth
 * match meant nothing to hunt; that is a property of a loose keyword, not of the
 * two commands disagreeing.
 */
export function xcpIdentifyInArea(t){ return startIdentify(t, 'locate'); }

function startIdentify(t, then){
  if(!t || t.is_dead) return false;
  const kw = actionKw(t) || gmkw(t.mob);
  if(!kw) return false;
  const st = {t, kw, ord: 1, ts: Date.now(), then, awaiting: true};
  sndState.pendingIdentify = st;
  appendOutput('[S&D] ' + (then === 'kill' ? 'in the room -- testing' : 'testing')
    + ' which copy of "'+t.mob+'" cannot be hunted...\n','quest');
  identifyProbe(st);          // the same path, so the no-answer guard applies here too
  return true;
}

function identifyProbe(st){
  const target = st.ord > 1 ? st.ord + '.' + st.kw : st.kw;
  st.ts = Date.now();
  st.awaiting = true;      // exactly one recognised reply advances the ordinal
  sendCmd('hunt ' + target);
  // A reply shape nobody anticipated must not hang the whole helper, which is
  // exactly what the directional answer above did. If nothing recognisable
  // arrives, give up on identifying and let the caller's fallback run.
  if(st.timer) clearTimeout(st.timer);
  st.timer = setTimeout(()=>{
    if(sndState.pendingIdentify !== st || !st.awaiting) return;
    sndState.pendingIdentify = null;
    appendOutput('[S&D] no answer to "hunt '+target+'" that I recognise; not identifying by hunt.\n','quest');
    if(st.then === 'locate') xcpStep(st.t);
    else xcpSweepCopies(st.t, Math.max(1, st.ord - 1), st.matches);
  }, 6000);
}

/** Feed MUD output here while an in-room identification is running. */
export function parseIdentifyOutput(text){
  const st = sndState.pendingIdentify;
  if(!st) return;
  if(Date.now() - st.ts > 8000){ sndState.pendingIdentify = null; return; }
  // One RECOGNISED reply per probe. MUD output arrives in whatever chunks the
  // network gives, and two of them matching "is here" advanced the ordinal twice
  // -- the probe went `hunt senator` then `hunt 3.senator`, so copy 2 was never
  // tested. If the campaign mob had been copy 2 the search would have missed it
  // and reported the target absent.
  //
  // The flag is cleared only in the branches that act, so an auction line or a
  // gossip arriving between the command and its answer passes through instead of
  // swallowing the probe.
  if(st.awaiting === false) return;
  const clean = stripAnsi(text);
  const ordKw = st.ord > 1 ? st.ord + '.' + st.kw : st.kw;

  if(HUNT_UNABLE.test(clean)){
    // Refused: this is the campaign mob.
    st.awaiting = false;
    if(st.timer) clearTimeout(st.timer);
    sndState.pendingIdentify = null;
    appendOutput('[S&D] copy '+st.ord+' cannot be hunted -- that is the campaign mob.\n','quest');
    // Kept for `where`, which shares hunt's numbering. NOT for `kill`, which
    // counts only this room -- see onArriveAtInstance.
    st.t.huntOrdKw = ordKw;
    if(st.then === 'locate'){
      // help/HuntTrick: ask `where` the same ordinal to find which room it is in.
      appendOutput('[S&D] locating it (where '+ordKw+')...\n','quest');
      sndState.pendingWhereOrd = {t: st.t, ordKw, ts: Date.now()};
      sendCmd('where '+ordKw);
      return;
    }
    // Plain keyword, not ordKw: we are standing in the room, and the room's own
    // numbering is the only one `kill` understands. If several copies are here the
    // ordinal walk in xcpKillTarget works through them across retries.
    xcpKillTarget(st.t);
    return;
  }
  if(HUNT_IS_HERE.test(clean) || HUNT_DIRECTION.test(clean)){
    st.awaiting = false;
    // This copy is huntable -- but is it even the right mob? A keyword is only the
    // last word of the name, so "a stuffed medusa head" searches on `head`, and
    // Aardington also holds a stuffed PANTHER head. `kill head` took the panther.
    // The reply names the mob, so check it: an ordinal naming something else is a
    // different creature sharing the keyword, not a copy of the target, and must
    // not be counted or killed.
    const named = huntedName(clean);
    st.matches = st.matches || [];
    if(named && !mobMatches(st.t.mob, named)){
      appendOutput('[S&D] '+ordKw+' is "'+named+'", not "'+st.t.mob+'" -- skipping it.\n','quest');
    } else {
      st.matches.push(st.ord);
    }
    if(st.ord >= IDENTIFY_MAX){
      sndState.pendingIdentify = null;
      if(st.then === 'locate'){
        appendOutput('[S&D] no unhuntable copy in the first '+st.ord+'; enumerating with where instead.\n','quest');
        xcpStep(st.t);
        return;
      }
      appendOutput('[S&D] tested '+st.ord+' copies of "'+st.t.mob+'" and every one can be hunted.\n','quest');
      xcpSweepCopies(st.t, st.ord, st.matches);
      return;
    }
    st.ord++;
    setTimeout(()=>{ if(sndState.pendingIdentify===st) identifyProbe(st); }, 700);
    return;
  }
  if(HUNT_NO_SUCH.test(clean)){
    // Run past the number of copies hunt can see.
    st.awaiting = false;
    if(st.timer) clearTimeout(st.timer);
    sndState.pendingIdentify = null;
    // Identifying before travelling is an optimisation, not the only route: if
    // hunt cannot resolve the ordinals from here -- outside the area, or a
    // keyword like `small` that also matches a worker bee and an apple tree --
    // fall back to enumerating with `where`, which is what used to happen anyway.
    if(st.then === 'locate'){
      // Every copy hunt could see has been tested. Note that, so arriving at the
      // room does not repeat the identical probe and get the identical answers.
      if(st.ord > 1) st.t.huntExhausted = true;
      appendOutput('[S&D] hunt cannot pick a copy from here; enumerating with where instead.\n','quest');
      xcpStep(st.t);
      return;
    }
    if(st.ord <= 1){
      appendOutput('[S&D] hunt cannot see '+t2name(st)+' from here; killing by keyword instead.\n','quest');
      xcpKillTarget(st.t);
      return;
    }
    appendOutput('[S&D] '+(st.ord-1)+' cop'+(st.ord-1===1?'y':'ies')+' of "'+st.t.mob
      + '" here, and every one can be hunted.\n','quest');
    xcpSweepCopies(st.t, st.ord-1, st.matches);
    return;
  }
}
function t2name(st){ return st.t && st.t.mob ? st.t.mob : st.kw; }

// `where 4.senator` answers with the fixed-width column layout `where` always
// uses: 30 characters of mob name, then the room.
const WHERE_ROW = /^(.{1,30}?)\s{2,}([^ (0-9].*?)\s*$/;

/** Feed MUD output here: the reply to the `where <n>.<kw>` that follows an identify. */
export function parseWhereOrdOutput(text){
  const st = sndState.pendingWhereOrd;
  if(!st) return;
  if(Date.now() - st.ts > 8000){ sndState.pendingWhereOrd = null; return; }
  const clean = stripAnsi(text);
  if(/there is no |no one (?:in this area |here )?by/i.test(clean)){
    sndState.pendingWhereOrd = null;
    appendOutput('[S&D] where could not place '+st.ordKw+'; falling back to the room list.\n','quest');
    return;                        // the ordinary where-enumeration flow continues
  }
  for(const line of clean.split(/\r?\n/)){
    const m = line.match(WHERE_ROW);
    if(!m) continue;
    // The vitals prompt has the same two-column shape ("[2998/2998hp ...]  >"),
    // so reject anything whose first column looks like a prompt and anything whose
    // second is too short to be a room name.
    if(/^\[/.test(m[1].trim())) continue;
    const room = m[2].trim();
    if(room.length < 3 || !/[a-z]/i.test(room)) continue;
    sndState.pendingWhereOrd = null;
    appendOutput('[S&D] the campaign '+st.t.mob+' is in '+room+'.\n','quest');
    st.t.located = true;
    st.t.campaignInstance = {n: st.ordKw, roomName: room, roomUid: null};
    st.t.whereInstances = [st.t.campaignInstance];
    xcpGotoInstance(st.t);
    return;
  }
}

/** Move to the next candidate keyword. Returns false when they are exhausted. */
export function advanceWhereKeyword(t){
  if(!t.kwList) t.kwList=whereKeywords(t.mob);
  t.kwIndex=(t.kwIndex==null?0:t.kwIndex)+1;
  return t.kwIndex < t.kwList.length;
}

/**
 * Step to the next (keyword, ordinal) probe, breadth-first across keywords:
 * ordinal 1 of every keyword, then ordinal 2 of every keyword, and so on.
 *
 * Depth-first on a single keyword spends the whole budget in the wrong place.
 * The head noun is the first candidate, and for "a relaxing worker" that is
 * `worker` -- which matches an injured goblin worker and several others, while
 * `where 1.relaxing` returns her immediately. Confirmed live in Tilule, along
 * with `manager` matching a pet store manager three ordinals running.
 */
export function nextWhereProbe(t){
  if(!t.kwList){ t.kwList=whereKeywords(t.mob); t.kwIndex=0; }
  t.kwIndex=(t.kwIndex||0)+1;
  if(t.kwIndex >= t.kwList.length){
    t.kwIndex=0;
    t.whereIndex=(t.whereIndex||1)+1;
    if(t.whereIndex > WHERE_ORD_MAX) return false;
  }
  return true;
}

/** The keyword currently being searched on. */
export function activeWhereKw(t){
  if(!t.kwList) { t.kwList=whereKeywords(t.mob); t.kwIndex=0; }
  return t.kwList[t.kwIndex||0] || whereKw(t.mob);
}

export function xcpQueryWhereInstance(t, n){
  t.whereIndex=n;
  t.whereAwaiting=n;
  // One keyword, not the phrase -- `where 1.barn swallow` is not a thing.
  // parseWhereOutput checks the returned NAME, so a same-keyword neighbour is
  // rejected rather than being walked to.
  const kw1=activeWhereKw(t);
  appendOutput('[S&D] querying instance '+n+': where '+n+'.'+kw1+'\n','quest');
  sendCmd('where '+n+'.'+kw1);
  // 5s was too tight: over the tunnel the reply to `where 1.trudes` regularly
  // landed just after the deadline, so enumeration reported "0 instances" and
  // gave up on a mob that was standing in the next room. Wait longer, and ask
  // once more before concluding there is nothing there.
  t.whereTimeout=setTimeout(()=>{
    if(t.whereAwaiting!==n) return;
    if(!t.whereRetried){
      t.whereRetried=true;
      appendOutput('[S&D] no reply to where '+n+'; asking again\n','quest');
      xcpQueryWhereInstance(t, n);
      return;
    }
    t.whereRetried=false;
    appendOutput('[S&D] where '+n+' timed out; stopping enumeration at '+(n-1)+' instance(s).\n','quest');
    t.whereAwaiting=null;
    t.located=true;
    if(sndState.pendingXcp) xcpStep(sndState.pendingXcp);
  }, WHERE_REPLY_MS);
}

export function xcpRunHuntTrick(t){
  if(!t.whereInstances || t.whereInstances.length===0){
    appendOutput('[S&D] no instances found; retrying where in 3s...\n','quest');
    t.located=false;
    setTimeout(()=>xcpStep(t), 3000);
    return;
  }
  // Start from instance 1 upward
  if(t.huntTrickIndex===undefined || t.huntTrickIndex<1) t.huntTrickIndex=1;
  if(t.huntTrickIndex>t.whereInstances.length){
    appendOutput('[S&D] hunt trick did not identify target, using last instance.\n','quest');
    t.campaignInstance=t.whereInstances[t.whereInstances.length-1];
    xcpKillTarget(t);
    return;
  }
  const inst=t.whereInstances[t.huntTrickIndex-1];
  t.huntTrickSteps=0;
  appendOutput('[S&D] hunt trick '+t.huntTrickIndex+'/'+t.whereInstances.length+'...\n','quest');
  xcpContinueHuntTrick(t, inst);
}

export function xcpContinueCampaignHunt(t, inst){
  clearTimeout(sndState.huntTrickTimeout||null);
  sndState.pendingHuntTrick={target:t, instance:inst, at:Date.now(), responded:false};
  sndState.huntTrickTimeout=setTimeout(()=>{
    const h=sndState.pendingHuntTrick;
    if(h && !h.responded){
      appendOutput('[S&D] no hunt response while testing instance '+inst.n+', trying next.\n','quest');
      sndState.pendingHuntTrick=null;
      t.huntTrickIndex++;
      xcpRunCampaignHunt(t);
    }
  }, 3500);
  // ONE keyword plus the ordinal. The full name fails outright: `hunt 1.black
  // pegasus` answered "You seem unable to hunt that target for some reason."
  const huntArg=inst.n+'.'+actionKw(t);
  sendCmd('hunt '+huntArg);
}

export function xcpGotoInstance(t){
  const inst=t.campaignInstance;
  if(!inst){
    runtoArea(t.areaName);
    xcpScheduleAction(t);
    return;
  }
  // Already in the room -- but "in the room" is where identification happens, so
  // go through the same arrival path rather than straight to the kill.
  if(currentRoom.name && currentRoom.name.toLowerCase()===inst.roomName.toLowerCase()){
    appendOutput('[S&D] already in target room.\n','quest');
    onArriveAtInstance(t);
    return;
  }
  appendOutput('[S&D] identified instance in '+inst.roomName+'\n','quest');

  // Prefer the map over `hunt`.
  //
  // `hunt` matches on a keyword, so an un-numbered `hunt swallow` follows
  // whichever swallow the game picks first -- confirmed live, it set off west
  // after "a swooping swallow" while the campaign mob sat in The carriage house.
  // And `hunt <n>.<kw>` on the campaign mob is refused outright ("You seem
  // unable to hunt that target"); that refusal is precisely how the hunt trick
  // identifies it. So hunt can never navigate to the actual target. A room name
  // from `where` is exact, and the area is imported -- use it.
  let mapped=null;
  if(inst.roomUid) mapped={uid:inst.roomUid, name:inst.roomName};
  else if(inst.roomName) mapped=resolveRoomByNameAnywhere(inst.roomName, t.areaName);
  if(mapped && mapped.uid){
    appendOutput('[S&D] using mapped path to '+inst.roomName+'\n','quest');
    gotoRoomUid(mapped.uid, ()=>onArriveAtInstance(t));
    return;
  }

  // Unmapped area or maze: fall back to following a NON-campaign instance with
  // hunt, which at least converges on the right room.
  const navInst=(t.whereInstances||[]).find(i=>i!==inst && i.roomName && i.roomName.toLowerCase()!==inst.roomName.toLowerCase()) || null;
  if(navInst){
    appendOutput('[S&D] navigating via non-campaign instance '+navInst.n+' in '+navInst.roomName+'\n','quest');
    sndState.xcpNav={target:t, targetInstance:inst, navInstance:navInst, phase:'hunt', startName:currentRoom.name, steps:0};
    xcpFollowHuntInstance(t, navInst);
    return;
  }
  // If all instances are in the same room, try following by mob keyword (un-numbered hunt) instead.
  const kw=gmkw(t.mob);
  if(kw){
    appendOutput('[S&D] all instances in same room; navigating by keyword hunt '+kw+'\n','quest');
    sndState.xcpNav={target:t, targetInstance:inst, navInstance:null, phase:'kw', startName:currentRoom.name, steps:0};
    xcpFollowHuntByKeyword(t, kw);
    return;
  }
  // Fallback: try direct room resolution (may be unreliable if map doesn't match live exits).
  let room=null;
  if(inst.roomUid){
    room={uid:inst.roomUid, name:inst.roomName};
  } else if(inst.roomName){
    room=resolveRoomByNameAnywhere(inst.roomName, t.areaName);
  }
  if(room){
    appendOutput('[S&D] using mapped path to '+inst.roomName+'\n','quest');
    gotoRoomUid(room.uid, ()=>onArriveAtInstance(t));
    return;
  }
  appendOutput('[S&D] room "'+inst.roomName+'" not mapped locally; open Gaardian map manually: '+t.areaName+' - '+inst.roomName+'\n','quest');
  window.open('https://maps.gaardian.com/', '_blank');
}

export function xcpFollowHuntInstance(t, navInst){
  const xn=sndState.xcpNav;
  if(!xn) return;
  // Check if we already arrived at target room by name.
  if(currentRoom.name && xn.targetInstance && currentRoom.name.toLowerCase()===xn.targetInstance.roomName.toLowerCase()){
    appendOutput('[S&D] arrived at target room '+currentRoom.name+'\n','quest');
    sndState.xcpNav=null;
    xcpKillTarget(t);
    return;
  }
  // Check if the nav instance still points to a different room; if so, follow it.
  if(currentRoom.name && navInst.roomName && currentRoom.name.toLowerCase()===navInst.roomName.toLowerCase()){
    appendOutput('[S&D] arrived at nav instance room '+currentRoom.name+', but target instance is elsewhere. Trying direct route.\n','quest');
    sndState.xcpNav=null;
    xcpTryDirectPath(t, xn.targetInstance);
    return;
  }
  // Follow hunt for the nav instance. Parse directional output from Aardwolf.
  sndState.pendingXcpNav={target:t, nav:navInst, at:Date.now()};
  appendOutput('[S&D] following hunt '+navInst.n+'...\n','quest');
  sendCmd('hunt '+navInst.n+'.'+actionKw(t));
  sndState.xcpNav.huntTimeout=setTimeout(()=>{
    appendOutput('[S&D] hunt navigation timed out; trying direct path.\n','quest');
    sndState.pendingXcpNav=null;
    xcpTryDirectPath(t, xn.targetInstance);
  }, 4000);
}

export function xcpTryDirectPath(t, inst){
  let room=null;
  if(inst.roomUid){
    room={uid:inst.roomUid, name:inst.roomName};
  } else if(inst.roomName){
    room=resolveRoomByNameAnywhere(inst.roomName, t.areaName);
  }
  if(room){
    appendOutput('[S&D] using mapped fallback path to '+inst.roomName+'\n','quest');
    gotoRoomUid(room.uid, ()=>onArriveAtInstance(t));
    return;
  }
  // No mapped route. In a maze the map was never going to help -- the room
  // layout is not expressible as a grid -- so hand navigation to the server's
  // own hunt skill and follow it a step at a time. This is what
  // Search-and-Destroy's autohunt does, and it is the answer for the areas
  // where the helper used to give up.
  appendOutput('[S&D] no mapped route; switching to autohunt.\n','quest');
  startAutoHunt(t);
}

// -----------------------------------------------------------------------------
// Autohunt: server-driven navigation for mazes and unmapped areas
// -----------------------------------------------------------------------------
const HUNT_DIRS = {north:'n', south:'s', east:'e', west:'w', northeast:'ne',
                   northwest:'nw', southeast:'se', southwest:'sw', up:'u', down:'d'};
const HUNT_DIR_RE = /(?:is|heading|leading|fled|went|go|toward)\s+(?:the\s+)?(north(?:east|west)?|south(?:east|west)?|east|west|up|down)\b/i;
const HUNT_ARRIVED = /is here|right here|in this (?:very )?room/i;
const HUNT_THROUGH = /\bis through\b|\bpassed through here, heading through\b/i;
const HUNT_FAIL = /couldn't find a path|No one in this area by the name|unable to hunt that target|You are not hunting/i;
const MAX_HUNT_STEPS = 40;

export function isMazeHere(){
  return /\bmaze\b/i.test(String(currentRoom.info || ''));
}

/**
 * `/ah <keyword>` -- follow the MUD's own `hunt` skill to a mob, one step at a
 * time, and stop when you are in its room.
 *
 * This is the same loop the campaign helper uses in mazes, driven directly.
 * It only works inside the mob's area (that is a `hunt` limitation, not ours),
 * it opens closed doors it is told to walk through, and it gives up on portals.
 */
export function huntTo(keyword){
  const kw=String(keyword||'').trim().replace(/"/g,'');
  if(!kw){ appendOutput('[ah] usage: /ah <mob keyword>   (/ah off to stop)\n','system'); return; }
  if(/^(off|stop|abort)$/i.test(kw)){ stopAutoHunt('cancelled'); return; }
  if(isWalking()) cancelWalk('autohunt');
  appendOutput('[ah] hunting "'+kw+'" -- will stop when you reach it. /ah off to cancel.\n','quest');
  sndState.autoHunt={target:null, kw, steps:0, lastDir:null, opened:false, timer:null};
  huntStep();
}

export function startAutoHunt(t){
  if(isWalking()) cancelWalk('autohunt');
  const kw=(t.htkw || gmkw(t.mob) || '').replace(/"/g,'') || t.mob;
  sndState.autoHunt={target:t, kw, steps:0, lastDir:null, opened:false, timer:null};
  huntStep();
}

export function stopAutoHunt(reason){
  const ah=sndState.autoHunt;
  if(!ah) return;
  if(ah.timer) clearTimeout(ah.timer);
  sndState.autoHunt=null;
  if(reason) appendOutput('[S&D] autohunt stopped: '+reason+'\n','error');
}

function huntStep(){
  const ah=sndState.autoHunt;
  if(!ah) return;
  if(ah.steps++ > MAX_HUNT_STEPS){ stopAutoHunt('trail too long'); return; }
  if(charState===STATE_FIGHTING){ ah.timer=setTimeout(huntStep, 1500); return; }
  sendCmdRaw('hunt '+ah.kw);
  ah.timer=setTimeout(()=>stopAutoHunt('no hunt response'), 6000);
}

/** Drive autohunt from MUD output. Returns true if the text was consumed. */
export function parseAutoHuntOutput(text){
  const ah=sndState.autoHunt;
  if(!ah) return false;
  const clean=stripAnsi(text);
  if(ah.timer){ clearTimeout(ah.timer); ah.timer=null; }

  if(HUNT_FAIL.test(clean)){ stopAutoHunt('hunt cannot find the target'); return true; }
  if(HUNT_THROUGH.test(clean)){
    stopAutoHunt('target is through a portal -- enter it manually, then /xcp again');
    return true;
  }
  if(HUNT_ARRIVED.test(clean)){
    const t=ah.target;
    sndState.autoHunt=null;
    if(t){
      appendOutput('[S&D] autohunt arrived at the target.\n','quest');
      xcpKillTarget(t);
    } else {
      // Standalone /ah: walk the player there and stop. Landing the killing
      // blow is theirs to do -- see the note about triggers that kill in
      // HANDOVER.md section 0.
      appendOutput('[ah] you are in the room with "'+ah.kw+'". Stopping here.\n','quest');
      try{ if('vibrate' in navigator) navigator.vibrate([40,60,40]); }catch(e){}
    }
    return true;
  }
  const m=clean.match(HUNT_DIR_RE);
  if(m){
    const dir=HUNT_DIRS[m[1].toLowerCase()];
    if(dir){
      ah.lastDir=dir;
      // GMCP publishes only open exits, so a hunt direction that is missing
      // from the room is a closed door. Open it before walking into it.
      const available=(currentRoom.exits||[]).map(d=>String(d).toLowerCase());
      if(available.length && !available.includes(dir) && !ah.opened){
        ah.opened=true;
        sendCmdRaw('open '+dir);
        ah.timer=setTimeout(huntStep, 800);
        return true;
      }
      ah.opened=false;
      sendCmdRaw(dir);
      ah.timer=setTimeout(huntStep, 900);
      return true;
    }
  }
  // Not a line we understand; keep waiting for the real response.
  ah.timer=setTimeout(()=>stopAutoHunt('no usable hunt direction'), 5000);
  return false;
}

export function xcpFollowHuntByKeyword(t, kw){
  const xn=sndState.xcpNav;
  if(!xn || xn.phase!=='kw') return;
  // Check arrival by target room name.
  if(currentRoom.name && xn.targetInstance && currentRoom.name.toLowerCase()===xn.targetInstance.roomName.toLowerCase()){
    appendOutput('[S&D] arrived at target room '+currentRoom.name+'\n','quest');
    sndState.xcpNav=null;
    xcpKillTarget(t);
    return;
  }
  // `hunt` takes a single keyword, never the phrase.
  const bareKw=actionKw(t);
  sndState.pendingXcpNav={target:t, nav:null, kw:kw, at:Date.now()};
  appendOutput('[S&D] following hunt '+bareKw+'...\n','quest');
  sendCmd('hunt '+bareKw);
  sndState.xcpNav.huntTimeout=setTimeout(()=>{
    appendOutput('[S&D] keyword hunt timed out; trying direct path.\n','quest');
    sndState.pendingXcpNav=null;
    xcpTryDirectPath(t, xn.targetInstance);
  }, 4000);
}

// Hook into hunt-response parsing for navigation instances.
export function parseXcpNavOutput(text){
  const n=sndState.pendingXcpNav;
  if(!n) return;
  const clean=stripAnsi(text).toLowerCase();
  const lines=clean.split(/\r?\n/);
  n.responded=true;
  clearTimeout((sndState.xcpNav||{}).huntTimeout||null);
  sndState.pendingXcpNav=null;
  const t=n.target;
  const nav=n.nav;

  // Directional hunt: parse explicit direction lines from Aardwolf.
  const dirLine=lines.find(line=>(/(confident|certain|heading|trail)/i.test(line) && /(?:heading|leading|fled|went|go|to|toward|direction|is)\s+(?:the\s+)?(north(?:east|west)?|south(?:east|west)?|east|west|up|down)/i.test(line)));
  if(dirLine){
    const dirMatch=dirLine.match(/(?:heading|leading|fled|went|go|to|toward|direction|is)\s+(?:the\s+)?(north(?:east|west)?|south(?:east|west)?|east|west|up|down)/i);
    const dirMap={north:'n',south:'s',east:'e',west:'w',northeast:'ne',northwest:'nw',southeast:'se',southwest:'sw',up:'u',down:'d'};
    const dir=dirMap[dirMatch[1].toLowerCase()];
    if(dir){
      sndState.xcpNav.steps=(sndState.xcpNav.steps||0)+1;
      if(sndState.xcpNav.steps>25){
        appendOutput('[S&D] nav trail too long, stopping.\n','quest');
        sndState.xcpNav=null;
        return;
      }
      appendOutput('[S&D] hunt indicates '+dirMatch[1].toLowerCase()+', moving...\n','quest');
      stepFollowing(dir);
      const nav=sndState.xcpNav.navInstance;
      const kw=sndState.xcpNav.kw;
      setTimeout(()=>{
        if(kw) xcpFollowHuntByKeyword(t, kw);
        else if(nav) xcpFollowHuntInstance(t, nav);
      }, 1500);
      return;
    }
  }

  // If we reached the mob, we are in its room.
  const here=/you\s+(?:attack|slash|pierce|crush|whip|hit|maul|cleave)|you\s+start\s+hunting/i;
  if(lines.some(line=>here.test(line))){
    appendOutput('[S&D] reached hunt target room.\n','quest');
    if(currentRoom.name && t.campaignInstance && currentRoom.name.toLowerCase()===t.campaignInstance.roomName.toLowerCase()){
      xcpKillTarget(t);
    } else {
      sndState.xcpNav=null;
      xcpTryDirectPath(t, t.campaignInstance);
    }
    return;
  }

  // Otherwise fall back to direct path.
  appendOutput('[S&D] no direction from hunt; trying direct path.\n','quest');
  sndState.xcpNav=null;
  xcpTryDirectPath(t, t.campaignInstance);
}

export function collectRoomNamesForArea(areaName){
  const names=[];
  if(!areaName) return names;
  if(sqlDb){
    const res=sqlDb.exec('SELECT DISTINCT name FROM rooms WHERE LOWER(area)=LOWER(?)', [areaName]);
    if(res.length && res[0].values) names.push(...res[0].values.map(r=>r[0]));
  }
  if(gaardianDb && names.length<5){
    const res=gaardianDb.exec(`SELECT r.roomname FROM rooms r JOIN areas a ON a.areaid=r.areaid WHERE LOWER(a.areaname) LIKE ?`, ['%'+areaName.toLowerCase()+'%']);
    if(res.length && res[0].values) names.push(...res[0].values.map(r=>r[0]));
  }
  return [...new Set(names)].sort((a,b)=>b.length-a.length);
}

// -----------------------------------------------------------------------------
// Mob sightings
// -----------------------------------------------------------------------------
// Remember where each mob has actually been seen, so that when both `hunt` and
// `where` come up empty there is still somewhere to suggest. Ranked by how
// often we have seen it there.

export function recordSightings(mob, areaName, instances){
  if(!sqlDb || !mob || !instances || !instances.length) return;
  const now=new Date().toISOString();
  const a=(areaName||currentRoom.area||'').toLowerCase();
  for(const inst of instances){
    if(!inst.roomName) continue;
    try {
      sqlDb.run(
        `INSERT INTO mobs(mob, area, room, room_uid, seen_count, last_seen)
         VALUES (?,?,?,?,1,?)
         ON CONFLICT(mob, area, room) DO UPDATE
           SET seen_count=seen_count+1, last_seen=excluded.last_seen,
               room_uid=COALESCE(excluded.room_uid, mobs.room_uid)`,
        [mob.toLowerCase(), a, inst.roomName, inst.roomUid || null, now]);
    } catch(e){ console.error('recordSightings', e); }
  }
}

export function knownSightings(mob, areaName){
  if(!sqlDb || !mob) return [];
  try {
    const res=sqlDb.exec(
      `SELECT room, room_uid, seen_count FROM mobs
        WHERE mob=? AND (?='' OR area=?) ORDER BY seen_count DESC, room LIMIT 5`,
      [mob.toLowerCase(), (areaName||'').toLowerCase(), (areaName||'').toLowerCase()]);
    return (res[0]?.values||[]).map(r=>({roomName:r[0], roomUid:r[1], count:r[2]}));
  } catch(e){ return []; }
}

export function parseWhereOutput(text){
  const t=sndState.pendingXcp;
  if(!t || t.located) return;
  const clean=stripAnsi(text);
  const lines=clean.split(/\r?\n/);
  const instances=[];
  const fallback=[];
  const wrongName=[];   // right keyword, wrong mob -- drives the ordinal retry
  const kw=(t.htkw||'').toLowerCase();
  const targetMob=t.mob.toLowerCase();
  // Load candidate room names for the target area to do suffix matching.
  const areaRoomNames=collectRoomNamesForArea(t.areaName);

  // Aardwolf wraps room descriptions in {rdesc}...{/rdesc} and the ASCII map in
  // <MAPSTART>...<MAPEND>. Those arrive interleaved with a pending `where`, and
  // the fixed-width split below happily reads a line of prose as "30 characters
  // of mob name, then a room" -- "surrounded by the roots of the" was accepted
  // as a mob in the Palace of Song. Never read anything inside a tagged block.
  let inBlock=false;
  for(const rawLine of lines){
    const line=rawLine.trim();
    if(!line) continue;
    if(/^\{(rdesc|roomchars|invdata|eqdata|invdetails|help|statmod|exits)\b/i.test(line)
       || /^<MAPSTART>/i.test(line)){ inBlock=true; continue; }
    if(/^\{\/(rdesc|roomchars|invdata|eqdata|invdetails|help)\}/i.test(line)
       || /^<MAPEND>/i.test(line)){ inBlock=false; continue; }
    if(inBlock) continue;
    if(line.startsWith('{') || line.startsWith('<')) continue;
    // The room's exit list and the status prompt both start with '[' and are
    // long enough for the fixed-width split to read as "mob, then room":
    // `[ Exits: north east south west ]` was reported as a mob. Not a blanket
    // '[' skip -- Aardwolf does have mobs whose names start with a bracket.
    if(/^\[\s*Exits:/i.test(line) || /^\[\d+\/\d+hp\b/i.test(line)) continue;
    // Skip echo of the command itself and informational/no-match lines.
    if(/^where\s/i.test(line)) continue;
    if(/There is no|around here|can't find any|no such/i.test(line)){
      // In numbered enumeration, an explicit no-match line ends the loop.
      if((sndState.xcpMode==='ch' || sndState.xcpMode==='ht') && t.whereAwaiting){
        clearTimeout(t.whereTimeout||null);
        t.whereAwaiting=null;
        // Nothing found on this keyword: it was the wrong one, not proof the mob
        // is absent. Try the next candidate before giving up on the target.
        // Nothing at this ordinal for this keyword. That is the end of the list
        // for THIS keyword only -- another may still have a match at the same
        // ordinal, so step across rather than concluding the mob is absent.
        if(!t.whereInstances.length && nextWhereProbe(t)){
          appendOutput('[S&D] nothing on that; trying '+t.whereIndex+'.'+activeWhereKw(t)+'\n','quest');
          setTimeout(()=>xcpQueryWhereInstance(t, t.whereIndex), 400);
          continue;
        }
        appendOutput('[S&D] enumerated '+t.whereInstances.length+' instance(s)\n','quest');
        t.located=true;
        setTimeout(()=>xcpStep(t), 100);
      }
      continue;
    }

    let roomName=null, mobCol=null, n=1;

    // Numbered lines like "1. Aorzloi the head triage doctor The triage"
    const numMatch=line.match(/^\s*(\d+)\.\s+(.+)$/);
    if(numMatch){ n=parseInt(numMatch[1]); mobCol=numMatch[2]; }
    else { mobCol=line; }

    // Aardwolf's `where` output is fixed-width: the mob name occupies exactly
    // 30 columns and the room name starts at column 32. Split on that first --
    // it is exact, and it works for rooms we have never seen. The fuzzy
    // suffix-matching below only runs when the column split does not apply
    // (wrapped lines, unusual output).
    const col=mobCol.match(/^(.{30}) (\S.*)$/);
    if(col && !/^\d/.test(col[2])){
      roomName=col[2].trim();
      mobCol=col[1].trim();
    }

    // Find longest known room name that is a suffix of mobCol.
    if(!roomName && areaRoomNames.length){
      const lowerMobCol=mobCol.toLowerCase();
      for(const candidate of areaRoomNames){
        const c=candidate.toLowerCase();
        if(lowerMobCol.endsWith(' '+c) || lowerMobCol===c){
          const idx=lowerMobCol.lastIndexOf(c);
          roomName=candidate;
          mobCol=mobCol.slice(0, idx).trim().replace(/\s+$/,'');
          break;
        }
      }
    }
    // Fuzzy fallback: the where line may be truncated. Find the candidate whose last
    // words are the suffix of the line, or whose last words match the START of a room name.
    if(!roomName && areaRoomNames.length){
      const lowerMobCol=mobCol.toLowerCase();
      const lineWords=lowerMobCol.split(/\s+/).filter(Boolean);
      for(const candidate of areaRoomNames){
        const cwords=candidate.toLowerCase().split(/\s+/).filter(Boolean);
        if(!cwords.length) continue;
        // Try matching the last 1-4 words of candidate against the end of the line.
        for(let take=1; take<=Math.min(4, cwords.length); take++){
          const suffix=cwords.slice(-take).join(' ');
          if(lowerMobCol.endsWith(' '+suffix) || lowerMobCol===suffix){
            roomName=candidate;
            mobCol=mobCol.slice(0, lowerMobCol.lastIndexOf(suffix)).trim();
            break;
          }
        }
        // Also try matching the last words of the line against the start of the room name.
        if(!roomName && lineWords.length){
          for(let take=1; take<=Math.min(4, lineWords.length); take++){
            const prefix=lineWords.slice(-take).join(' ');
            const candStart=cwords.slice(0, take).join(' ');
            if(prefix===candStart){
              roomName=candidate;
              mobCol=mobCol.slice(0, lowerMobCol.lastIndexOf(prefix)).trim();
              break;
            }
          }
        }
        if(roomName) break;
      }
    }

    // Fallback to the old double-space split if no room name matched.
    if(!roomName){
      const parts=mobCol.split(/\s{2,}/);
      if(parts.length>=2){
        mobCol=parts.slice(0,-1).join(' ');
        roomName=parts[parts.length-1];
      }
    }

    if(!roomName) continue;
    const mobLower=mobCol.toLowerCase();

    // In campaign-hunt mode, the where output must match the exact full mob name.
    // Reject lines like "an apple-carrying hedgehog" when target is "a large apple tree".
    const fullMob=t.mob.toLowerCase().replace(/^\s*(a|an|the)\s+/i,'');
    const fullMobWords=fullMob.split(/\s+/).filter(Boolean);
    // Require every word of the full mob name to appear, in order, in the mob
    // column. This used to run only in ch/ht mode; every other mode accepted
    // `mobLower.includes(kw)`, a bare substring test on a shared keyword. Hunting
    // "a barn swallow" therefore locked on to "a swooping swallow" in the same
    // area and walked to the wrong mob -- the two share the word `swallow`, and
    // the swooping one is listed first.
    let mi=0;
    const mobWords=mobLower.split(/\s+/).filter(Boolean);
    for(const w of mobWords){
      if(mi<fullMobWords.length && w===fullMobWords[mi]) mi++;
    }
    // `where` prints the mob in a 30-character column, so a long name arrives
    // cut short: "Trudes Tronesetter, Queen of the Kobaloi" comes back as
    // "Trudes Tronesetter, Queen of t" and can never contain every word. Accept
    // a column that is a prefix of the target -- with or without its article,
    // since `where` keeps the article and t.mob may not.
    const trimmed = mobLower.length >= 20 && (
      targetMob.startsWith(mobLower) || fullMob.startsWith(mobLower));
    if(mi===fullMobWords.length || trimmed){
      // Remember the keyword that actually identified this mob. It is the only
      // one proven to mean *this* creature, and everything downstream -- hunt,
      // kill -- must use it rather than falling back to the first candidate.
      // `kill worker` for "a relaxing worker" killed an injured goblin worker
      // standing in the same room; `relaxing` is what `where` had matched on.
      t.matchedKw = activeWhereKw(t);
      instances.push({n, roomName, roomUid:null});
      continue;
    }
    // `where` hides the name of a mob you cannot see; those lines are still worth
    // keeping, but only if nothing named matches.
    if(/someone|somebody|something/i.test(mobLower)){
      fallback.push({n, roomName, roomUid:null, generic:true});
    } else {
      // A different mob sharing the keyword. `where` answers with only one mob,
      // so the next ordinal is the only way past it.
      wrongName.push(mobCol.trim());
    }
  }

  // Nothing named right, but something answered: step to `where <n+1>.<kw>`.
  //
  // In ch/ht mode the enumeration below assumed every `where n.<kw>` reply WAS
  // the target, so once the name check started rejecting neighbours the reply
  // simply went unclaimed, `whereAwaiting` stayed set, and the 5s timeout
  // declared "0 instance(s)". Advance the ordinal instead -- that is the whole
  // point of enumerating.
  if(!instances.length && !fallback.length && wrongName.length
     && (sndState.xcpMode==='ch' || sndState.xcpMode==='ht') && t.whereAwaiting){
    clearTimeout(t.whereTimeout||null);
    const n=t.whereAwaiting;
    t.whereAwaiting=null;
    if(!nextWhereProbe(t)){
      appendOutput('[S&D] "'+t.mob+'" not found on any of: '+t.kwList.join(', ')
        + ' (up to '+WHERE_ORD_MAX+' each)\n','error');
      t.located=true;
      setTimeout(()=>xcpStep(t), 100);
      return;
    }
    appendOutput('[S&D] that is "'+wrongName[0]+'", not "'+t.mob+'" -- trying '
      + t.whereIndex+'.'+activeWhereKw(t)+'\n','quest');
    xcpQueryWhereInstance(t, t.whereIndex);
    return;
  }

  if(!instances.length && !fallback.length && wrongName.length
     && (sndState.xcpMode!=='ch' && sndState.xcpMode!=='ht') && t.whereKw){
    t.whereOrd=(t.whereOrd||1)+1;
    if(t.whereOrd>WHERE_ORD_MAX){
      appendOutput('[S&D] "'+t.mob+'" not among the first '+WHERE_ORD_MAX+' "'+t.whereKw+'" mobs here; skipping.\n','error');
      t.whereOrd=1;
      return;
    }
    appendOutput('[S&D] that is "'+wrongName[0]+'", not "'+t.mob+'" -- trying where '+t.whereOrd+'.'+t.whereKw+'\n','quest');
    setTimeout(()=>{
      if(sndState.pendingXcp===t && !t.located) sendCmd('where '+t.whereOrd+'.'+t.whereKw);
    }, 600);
    return;
  }
  let use = instances.length ? instances : fallback;
  if(use.length===0) return; // not a where block we can parse
  if(instances.length===0 && fallback.length>0){
    appendOutput('[S&D] where hid the mob name; using '+fallback.length+' generic candidate(s).\n','quest');
  }
  // For numbered enumeration (campaign hunt / hunt trick), add the single result to the target list and continue.
  if((sndState.xcpMode==='ch' || sndState.xcpMode==='ht') && t.whereAwaiting){
    clearTimeout(t.whereTimeout||null);
    const n=t.whereAwaiting;
    t.whereAwaiting=null;
    if(use.length>0){
      const inst=use[0];
      inst.n=n;
      t.whereRetried=false;
      t.whereInstances.push(inst);
      t.whereIndex=n+1;
      appendOutput('[S&D] instance '+n+' found: '+inst.roomName+'\n','quest');
      xcpQueryWhereInstance(t, n+1);
    } else {
      // No match for this number means enumeration is done.
      appendOutput('[S&D] enumerated '+t.whereInstances.length+' instance(s)\n','quest');
      t.located=true;
      xcpStep(t);
    }
    return;
  }
  t.whereInstances=use;
  t.located=true;
  recordSightings(t.mob, t.areaName, use);
  // If target area is unknown, try to discover it from the first resolved room name.
  if(t.type==='unknown' || !t.areaUid){
    for(const inst of use){
      const rooms=resolveRoomByNameAnywhere(inst.roomName, null);
      if(rooms){
        t.areaName=rooms.area;
        t.area=rooms.area;
        t.areaUid=rooms.area;
        t.type='area';
        break;
      }
    }
  }
  appendOutput('[S&D] found '+use.length+' instance(s) of '+t.mob+'\n','quest');
  xcpStep(t);
}

export function parseHuntTrickOutput(text){
  const h=sndState.pendingHuntTrick;
  if(!h) return;
  const clean=stripAnsi(text).toLowerCase();
  const lines=clean.split(/\r?\n/);
  const target=h.target;
  const inst=h.instance;
  h.responded=true;
  clearTimeout(sndState.huntTrickTimeout||null);

  // "No one in this area by the name '6.small'." -- hunt could not resolve the
  // ordinal at all, which is different from refusing to hunt a campaign mob.
  // Nothing matched it, so the state machine stopped dead and waited for a reply
  // that had already arrived. Advance to the next instance instead.
  // Two different ways hunt declines to help, neither of which said anything
  // about the mob being the campaign target, and neither of which was matched --
  // so the state machine stopped dead waiting for a reply that had arrived:
  //   No one in this area by the name '6.senator'.   (ordinal means nothing to hunt)
  //   You couldn't find a path to a senator from here. (outside the city gates)
  // In both cases `where` has already named the room, so go by the map.
  const noSuchOrdinal=/no one (?:in this area |here )?by (?:the |that )?name|could ?n[o']?t find a path/i;
  if(lines.some(line=>noSuchOrdinal.test(line))){
    appendOutput('[S&D] hunt does not know "'+inst.n+'.'+(target.htkw||'')
      + '" -- where and hunt number things differently; going by room instead.\n','quest');
    sndState.pendingHuntTrick=null;
    target.campaignInstance=inst;
    xcpGotoInstance(target);
    return;
  }

  const unable=/unable\s+to\s+hunt\s+that\s+target|seem\s+unable\s+to\s+hunt|campaign.*unable/i;
  if(lines.some(line=>unable.test(line))){
    appendOutput('[S&D] campaign instance '+inst.n+' is the target.\n','quest');
    target.campaignInstance=inst;
    sndState.pendingHuntTrick=null;
    if(sndState.xcpMode==='ch'){
      // In campaign-hunt mode we are not necessarily in the room; route there first.
      xcpGotoInstance(target);
    } else {
      xcpKillTarget(target);
    }
    return;
  }

  // `hunt` answers "<mob> is here!" when the mob is in the room you are already
  // standing in -- it never has to hunt at all, so this says nothing about
  // whether the mob is the campaign target. It just means we have arrived.
  // None of the branches below matched it, so the helper stopped dead with the
  // Queen of the Kobaloi standing in front of it.
  if(lines.some(line=>/\bis here\b/i.test(line) && !/is not here/i.test(line))){
    appendOutput('[S&D] '+target.mob+' is in this room.\n','quest');
    target.campaignInstance=inst;
    sndState.pendingHuntTrick=null;
    xcpKillTarget(target);
    return;
  }

  // Directional hunt: only from explicit hunt-result lines like "heading east"
  const dirLine=lines.find(line=>/(confident|certain|heading|trail)/i.test(line) && /(?:heading|leading|fled|went|go|to|toward|direction|is)\s+(?:the\s+)?(north(?:east|west)?|south(?:east|west)?|east|west|up|down)/i.test(line));
  if(dirLine){
    const dirMatch=dirLine.match(/(?:heading|leading|fled|went|go|to|toward|direction|is)\s+(?:the\s+)?(north(?:east|west)?|south(?:east|west)?|east|west|up|down)/i);
    const dirMap={north:'n',south:'s',east:'e',west:'w',northeast:'ne',northwest:'nw',southeast:'se',southwest:'sw',up:'u',down:'d'};
    const dir=dirMap[dirMatch[1].toLowerCase()];
    if(dir){
      target.huntTrickSteps=(target.huntTrickSteps||0)+1;
      if(target.huntTrickSteps>25){
        appendOutput('[S&D] instance '+inst.n+' trail too long, trying next.\n','quest');
        sndState.pendingHuntTrick=null;
        target.huntTrickIndex++;
        setTimeout(()=> sndState.xcpMode==='ch'?xcpRunCampaignHunt(target):xcpRunHuntTrick(target), 600);
        return;
      }
      appendOutput('[S&D] instance '+inst.n+' is '+dirMatch[1].toLowerCase()+', moving...\n','quest');
      sndState.pendingHuntTrick=null;
      stepFollowing(dir);
      setTimeout(()=>xcpContinueHuntTrick(target, inst), 1200);
      return;
    }
  }

  const notHere=/you\s+can't\s+find\s+any|they\s+aren't\s+here|you\s+don't\s+see|no\s+such\s+creature|is\s+not\s+here|unable\s+to\s+see|no\s+trail|lost\s+(?:the\s+)?trail/i;
  const attackStart=/you\s+(?:start\s+)?hunting|you\s+attack|you\s+(?:slash|pierce|crush|whip|hit|maul|cleave)/i;
  if(lines.some(line=>notHere.test(line) || attackStart.test(line))){
    appendOutput('[S&D] instance '+inst.n+' is not the target.\n','quest');
    sndState.pendingHuntTrick=null;
    target.huntTrickIndex++;
    setTimeout(()=> sndState.xcpMode==='ch'?xcpRunCampaignHunt(target):xcpRunHuntTrick(target), 600);
    return;
  }
}

export function xcpContinueHuntTrick(t, inst){
  clearTimeout(sndState.huntTrickTimeout||null);
  sndState.pendingHuntTrick={target:t, instance:inst, at:Date.now(), responded:false};
  sndState.huntTrickTimeout=setTimeout(()=>{
    const h=sndState.pendingHuntTrick;
    if(h && !h.responded){
      appendOutput('[S&D] no hunt response while following instance '+inst.n+', trying next.\n','quest');
      sndState.pendingHuntTrick=null;
      t.huntTrickIndex++;
      xcpRunHuntTrick(t);
    }
  }, 3500);
  sendCmd('hunt '+inst.n+'.'+t.htkw);
}

/**
 * We are in the instance room. In campaign-hunt mode the copies still have to be
 * told apart, and this is the only place `hunt` can do it.
 */
function onArriveAtInstance(t){
  // `t.huntOrdKw` is a HUNT ordinal, and hunt counts every copy in the AREA while
  // kill counts only the ones in this ROOM. They are different lists, so handing
  // it to kill asks for a copy that is very often not here:
  //
  //     [S&D] copy 2 cannot be hunted -- that is the campaign mob.
  //     > kill 2.militia
  //     They aren't here.
  //
  // and the walker then swept all seven rooms called "A Road through the
  // Countryside" looking for a mob standing in front of it. The ordinal is still
  // right for `where` -- which is what placed us in this room -- but from here on
  // the room's own numbering is the only one that means anything, so fall through
  // to the ordinal walk in xcpKillTarget.
  //
  // (Not the same as the `where` vs `hunt` numbering question: those two agree for
  // a clean keyword. This is hunt vs kill.)
  // The in-area probe already tested every copy hunt can see; repeating it here
  // would ask the same questions and get the same answers.
  const many = (t.whereInstances && t.whereInstances.length > 1);
  if(sndState.xcpMode === 'ch' && many && !t.huntExhausted) xcpIdentifyHere(t);
  else xcpKillTarget(t);
}

/**
 * No copy refused the hunt, so work through them.
 *
 * "Nothing refused" does NOT mean the target is absent -- it means this mob is not
 * flagged unhuntable, and the hunt trick simply cannot see it. Proved with a
 * senator: seven copies all huntable, copy 2 included once the skipped ordinal
 * was fixed, and the campaign cleared on the eighth kill with the room emptied.
 * The helper had been reporting "not in this room; try again after a repop" and
 * stopping, which was wrong twice over -- wrong conclusion, and it gave up on a
 * target that was standing right there.
 *
 * Kill by plain keyword rather than by ordinal: as each copy dies the next becomes
 * the first, so the keyword walks the room on its own, and no ordinal goes stale
 * underneath the sweep. Verify after each, stop the moment the campaign clears.
 */
export function xcpSweepCopies(t, count, ordinals){
  if(!t || t.is_dead) return;
  // Only the ordinals whose hunt reply NAMED our mob. A bare keyword would take
  // whatever is first in the room, which is how "a stuffed medusa head" got a
  // stuffed panther head killed instead -- both answer to `head`.
  t.sweepOrds = (ordinals && ordinals.length) ? ordinals.slice() : null;
  t.copiesLeft = t.sweepOrds ? t.sweepOrds.length
                             : Math.max(1, Math.min(count || 1, 15)) + 2;
  appendOutput('[S&D] no copy refused the hunt, so this mob is not flagged -- the trick\n'
    + '       cannot pick it out. Working through '
    + (t.sweepOrds ? t.sweepOrds.length + ' confirmed cop' + (t.sweepOrds.length===1?'y':'ies')
                   : 'the copies') + ' one at a time.\n','quest');
  killNextCopy(t);
}

function killNextCopy(t){
  if(!t || t.is_dead) return;
  if(t.copiesLeft <= 0){
    appendOutput('[S&D] worked through every copy of "'+t.mob+'" here without the campaign\n'
      + '       clearing. Either more will repop, or it really is elsewhere.\n','error');
    sndState.pendingXcp = null;
    return;
  }
  t.copiesLeft--;
  const kw = actionKw(t) || gmkw(t.mob);
  // A confirmed ordinal when we have one; otherwise the plain keyword, which takes
  // the first copy in the room -- a different mob each time as the previous dies.
  let targetKw = kw;
  if(t.sweepOrds && t.sweepOrds.length){
    const ord = t.sweepOrds.shift();
    targetKw = ord > 1 ? ord + '.' + kw : kw;
  }
  xcpKillTarget(t, targetKw, ()=>{
    appendOutput('[S&D] not that one; '+t.copiesLeft+' more to try.\n','quest');
    setTimeout(()=>killNextCopy(t), 1200);
  });
}

// Do not start a fight below this, and abandon the run below the second figure.
// The helper killed its way from full health to dead without once looking at the
// numbers the game sends on every tick.
const FIGHT_ABOVE = 0.55;
const BAIL_BELOW   = 0.35;
const HEAL_TRIES   = 8;

/**
 * Heal to FIGHT_ABOVE before attacking, or give up the run.
 *
 * Returns true when it has taken over -- the caller must not attack. `heal` is the
 * player's own alias, so whatever their class does to recover is what runs; if they
 * have no such alias the command simply fails and resting still regenerates.
 */
function healBeforeFighting(t, resume){
  const frac = hpFraction();
  if(frac >= FIGHT_ABOVE) return false;
  if(charState === STATE_FIGHTING) return false;      // already committed; see below
  t.healTries = (t.healTries || 0) + 1;
  if(t.healTries > HEAL_TRIES){
    appendOutput('[S&D] still on '+Math.round(frac*100)+'% health after '+HEAL_TRIES
      + ' attempts -- stopping rather than walking into another fight.\n','error');
    sndState.pendingXcp = null;
    return true;
  }
  appendOutput('[S&D] '+Math.round(frac*100)+'% health: healing before the next fight'
    + ' ('+t.healTries+'/'+HEAL_TRIES+').\n','quest');
  // `cast heal` restores about 257hp for ~35 mana; the `heal` alias is a string of
  // cure lights worth a fraction of that, so eight rounds of it barely moved the
  // bar. Prefer the spell and alternate to the alias, which covers a character
  // that does not have `heal` -- a failed cast costs nothing but the round.
  sendCmd((t.healTries % 2) ? 'cast heal' : 'heal');
  setTimeout(()=>{
    if(sndState.pendingXcp !== t) return;
    if(hpFraction() >= FIGHT_ABOVE){ t.healTries = 0; resume(); return; }
    if(!healBeforeFighting(t, resume)) resume();
  }, 6000);
  return true;
}

export function xcpKillTarget(t, forcedKw, onStillAlive){
  if(t.is_dead) return;
  // Health first. Everything below this line commits the character to a fight.
  if(healBeforeFighting(t, ()=>xcpKillTarget(t, forcedKw, onStillAlive))) return;
  // A keyword, like `where` and `hunt`. The quoted full name is not something
  // the game can target: standing in the throne room with Queen Trudes in front
  // of us, `kill "trudes tronesetter, queen of the kobaloi"` answered
  // "They aren't here."
  const kw=actionKw(t)||gmkw(t.mob);
  // Work through the identical copies in the room by ordinal.
  //
  // The Knossos Senate holds SIX senators and `kill senator` always takes the
  // first, so re-running /xcp killed the same non-campaign one over and over --
  // three rounds, three dead senators, no progress. The hunt trick cannot pick
  // the right one either, because `hunt <n>.<kw>` does not share `where`'s
  // numbering. Nothing distinguishes them from outside, so try them in turn.
  //
  // The counter lives on the campaignTargets entry, not on `t`: xcpByIndex builds
  // a fresh copy of the target on every invocation, so anything kept on `t` is
  // forgotten between attempts -- which is exactly what has to persist here.
  // A copy identified by xcpIdentifyHere is exact, so there is nothing to guess.
  // The ordinal walk below is the fallback for when identification was not
  // possible -- it kills copies in turn rather than the same one every time.
  const ct = campaignTargets[t.index-1] || t;
  // How many copies `where` actually reported. 0 means it never told us, in which
  // case 8 is a guess wide enough for the Knossos Senate's six senators.
  //
  // The cap used to be Math.max(seen, 8) unconditionally, so a target `where`
  // had reported EXACTLY ONE of still got walked up to eight ordinals -- and the
  // second attempt on Polaf den Tedra announced "kill 2.tedra -- copy 2 of 1" and
  // asked the game for a copy the code already knew did not exist. Once the count
  // is known, honour it: retries then re-attack the one copy, which is what makes
  // a mob that fled at wimpy die on the next pass.
  const known = (t.whereInstances && t.whereInstances.length) || 0;
  const cap = known > 0 ? known : 8;
  let targetKw = forcedKw;
  if(!targetKw){
    ct.killOrd = (ct.killOrd || 0) + 1;
    if(ct.killOrd > cap) ct.killOrd = 1;                 // wrap rather than run away
    targetKw = ct.killOrd > 1 ? ct.killOrd + '.' + kw : kw;
  }
  const seen = known || 1;
  appendOutput('[S&D] killing '+t.mob+' (kill '+targetKw+')'
    + (forcedKw ? ' -- the copy that refused to be hunted'
                : (ct.killOrd > 1 ? ' -- copy '+ct.killOrd+' of '+seen : '')) + '...\n','quest');
  // Watched by parseNotHereOutput: "They aren't here" after this means we are in
  // a room with the right NAME but not the right room. See xcpSweepTwins.
  sndState.pendingKill={t, at:currentRoom.uid, ts:Date.now()};
  sendCmd('kill '+targetKw);
  // `cp check` on a flat 5s timer lands in the middle of the fight, so it read the
  // target as still alive every single time -- "finish the fight and /xcp to
  // continue" printed immediately before the mob died. Wait for combat to end
  // instead, with a cap so a fight we are losing does not hang the helper.
  let waited = 0;
  const whenDone = () => {
    // Losing. Recall out rather than watching the numbers fall to zero -- which is
    // what happened in the Forest Strategy Room: 922 of 3058 against a mob at full
    // health, and the helper simply kept waiting for combat to end.
    if(charState === STATE_FIGHTING && hpFraction() < BAIL_BELOW){
      appendOutput('[S&D] down to '+Math.round(hpFraction()*100)+'% mid-fight -- recalling out.\n','error');
      sendCmdRaw('recall');
      sndState.pendingXcp = null;
      sndState.pendingKill = null;
      return;
    }
    if(charState === STATE_FIGHTING && waited < 90000){
      waited += 1500;
      setTimeout(whenDone, 1500);
      return;
    }
    xcpVerifyKill(t, onStillAlive || (()=>{
      appendOutput('[S&D] '+t.mob+' is still alive'
        + (charState === STATE_FIGHTING ? ' and the fight is still going' : '')
        + '; /xcp to try again.\n','quest');
    }));
  };
  setTimeout(whenDone, 2500);
}

// =============================================================================
// ROOMS THAT SHARE A NAME
// =============================================================================
//
// `where` reports a room NAME, and names repeat: "The forgotten halls" is NINE
// rooms in The Goblin Fortress, "Hallway in the fortress" five more. Only 48% of
// the 22,362 Gaardian rooms have a name unique within their area.
//
// So xcpGotoInstance's "already in target room" test -- currentRoom.name equals
// the name `where` gave -- is right about the name and says nothing about the
// room. Standing in one of the nine halls it declared arrival, sent `kill lodi`,
// and got "They aren't here." with no idea what to do next.
//
// Being in the wrong twin is an ordinary outcome, not a failure. Walk the others.

const NOT_HERE = [
  /they aren'?t here/i,
  /you (?:do not|don't) see (?:that|them|him|her|any) here/i,
  /you can'?t find any.*here/i,
  /no such creature/i,
];

// =============================================================================
// FOLLOWING A HUNT TRAIL
// =============================================================================
//
// Following `hunt` is a SECOND movement path, separate from nav.js's walker, and
// it had no door handling at all: it sent the direction, the door was shut, the
// character did not move, `hunt` said the same direction again, and it looped
// until "trail too long". Five wasted rounds and the target abandoned, with the
// mob two rooms away.
//
// This went unnoticed because the fado_t51 trigger -- blindly opening all six
// directions on any "is closed" line -- happened to open the door. Turning that
// off (it fights the walker) exposed the gap it was covering.

// Anchored to the end of the line on purpose. Without that, "The shop is closed
// for the night, come back later." reads as a shut door and the follower fires a
// pointless `open` -- caught by the test before it ever ran.
const DOOR_SHUT = [
  /^the \w+ is closed\.?\s*$/im,      // "The door is closed." / "The doubledoor is closed."
  /\bis closed\.\s*$/im,              // "A large iron portcullis is closed."
];

/** One step along a hunt trail, with the door opened if the game says it is shut. */
function stepFollowing(dir){
  sndState.pendingFollowMove = {dir, ts: Date.now(), opened: false};
  sendCmd(dir);
}

/**
 * Feed MUD output here. Opens a shut door the hunt-follower just walked into and
 * repeats the step, once. The walker has its own version of this; it only runs
 * while a path walk is active, which a hunt trail is not.
 */
export function parseFollowMoveOutput(text){
  const m = sndState.pendingFollowMove;
  if(!m) return;
  // The reply is immediate; anything later belongs to somebody else's command.
  if(Date.now() - m.ts > 4000){ sndState.pendingFollowMove = null; return; }
  const clean = stripAnsi(text);
  if(!DOOR_SHUT.some(re => re.test(clean))) return;
  if(m.opened){ sndState.pendingFollowMove = null; return; }   // one attempt is enough
  m.opened = true;
  appendOutput('[S&D] '+m.dir+' is closed; opening it\n','quest');
  sendCmdRaw('open '+m.dir);
  setTimeout(()=>{ if(sndState.pendingFollowMove===m) sendCmd(m.dir); }, 500);
}

// The reply to `kill` or `look` is immediate, so anything later is somebody
// else's "They aren't here" -- usually the player typing their own command --
// and must not send the helper off sweeping rooms.
const REPLY_WINDOW_MS = 3000;

/** Feed MUD output here; reacts to "kill" or a probe finding nothing. */
export function parseNotHereOutput(text){
  const now=Date.now();
  if(sndState.pendingKill && now - sndState.pendingKill.ts > REPLY_WINDOW_MS) sndState.pendingKill=null;
  // A probe that never gets a conclusive answer means absent, not stuck: carry on
  // to the next twin rather than leaving the sweep waiting forever.
  if(sndState.pendingTwinProbe && now - sndState.pendingTwinProbe.ts > REPLY_WINDOW_MS){
    const stale = sndState.pendingTwinProbe;
    sndState.pendingTwinProbe = null;
    xcpSweepTwins(stale.t);
    return;
  }
  const probe=sndState.pendingTwinProbe;
  const kill=sndState.pendingKill;
  if(!probe && !kill) return;
  const clean=stripAnsi(text);
  const absent=NOT_HERE.some(re=>re.test(clean));

  if(probe){
    // Presence needs POSITIVE evidence. Treating "no absence phrase matched" as a
    // hit meant any unrecognised reply -- and `look <kw>` in a room without the mob
    // produces several -- read as "it is standing right there", so the sweep fired
    // `kill 4.yagnoloth` into empty rooms across the Oinos Gloom of Hades. The mob
    // is here only if the reply mentions it by name.
    if(absent){
      sndState.pendingTwinProbe=null;
      xcpSweepTwins(probe.t);
      return;
    }
    const named = clean.split(/\r?\n/).some(line => {
      const l = line.trim();
      return l && l.length < 120 && mobMatches(probe.t.mob, l);
    });
    if(named){
      sndState.pendingTwinProbe=null;
      xcpKillTarget(probe.t);
      return;
    }
    // Nothing conclusive yet: leave the probe armed and let the reply window or a
    // later line settle it, rather than attacking on a guess.
    return;
  }
  if(absent){
    sndState.pendingKill=null;
    xcpSweepTwins(kill.t);
  }
}

/**
 * Try the other rooms in this area that share the target room's name.
 *
 * Each twin is visited at most once, so this terminates. Arrival is probed with
 * `look`, not `kill`: a keyword that matches the campaign mob can equally match
 * something else standing in the wrong room, and swinging at it is how you end
 * up fighting a level 80 guard by accident.
 */
export function xcpSweepTwins(t){
  if(!t || t.is_dead) return;
  const roomName=(t.campaignInstance && t.campaignInstance.roomName) || currentRoom.name;
  if(!roomName){
    appendOutput('[S&D] '+t.mob+' is not in this room and I do not know its room name.\n','error');
    return;
  }
  t.twinsTried=t.twinsTried||[];
  if(currentRoom.uid && !t.twinsTried.includes(currentRoom.uid)) t.twinsTried.push(currentRoom.uid);

  // Match on the area GMCP says we are standing in, not on the campaign's
  // display name: rooms.area holds the keyword ('fortress') while the campaign
  // says "The Goblin Fortress", and bridging those depends on the keyword list
  // having been harvested. We are standing in one of the twins, so currentRoom
  // is the authority here and needs no bridging at all.
  const twins=resolveRoomsByName(roomName, currentRoom.area || t.areaName)
    .filter(r=>r.uid && r.uid!==currentRoom.uid && !t.twinsTried.includes(r.uid));
  if(!twins.length){
    appendOutput('[S&D] tried every room called "'+roomName+'" in '+t.areaName
      + ' and '+t.mob+' was in none of them -- it has moved, or the room is not mapped. '
      + 'Run /xcp '+t.index+' again to re-locate.\n','error');
    sndState.pendingXcp=null;
    return;
  }
  const next=pickNearestRoom(twins, currentRoom.uid);
  appendOutput('[S&D] not this "'+roomName+'" -- '+twins.length+' more to try.\n','quest');
  // ignoreName: every twin has the same name as the room we are standing in, so
  // the walker's name-match would call it arrived before taking a single step.
  gotoRoomUid(next.uid, ()=>{
    t.twinsTried.push(next.uid);
    const kw=actionKw(t)||gmkw(t.mob);
    sndState.pendingTwinProbe={t, ts:Date.now()};
    sendCmd('look '+kw);
  }, {ignoreName:true});
}

export function mobMatches(targetMob, lineMob){
  const omit={a:1,an:1,the:1,of:1,in:1,on:1,at:1,with:1,from:1,to:1,and:1};
  const targetWords=targetMob.toLowerCase().replace(/[^\w\s-]/g,' ').split(/\s+/).filter(w=>w&&!omit[w]);
  const lineWords=lineMob.toLowerCase().replace(/[^\w\s-]/g,' ').split(/\s+/).filter(w=>w);
  let ti=0;
  for(const w of lineWords){
    if(ti<targetWords.length && w===targetWords[ti]) ti++;
  }
  return ti===targetWords.length;
}

export function parseHuntOutput(text){
  // First, handle campaign-hunt testing and nav-instance following.
  const h=sndState.pendingHuntTrick;
  const n=sndState.pendingXcpNav;
  if(n) parseXcpNavOutput(text);
  if(h) parseHuntTrickOutput(text);
  // Keep existing parseHuntOutput for regular hunt mode if needed
  const hunt=sndState.pendingHunt;
  if(!hunt) return;
  const clean=stripAnsi(text).toLowerCase();
  const target=hunt.target;
  const foundPatterns=[/is here/i,/you start hunting/i,/you hunt/i,/you begin hunting/i,/you attack/i,/you slash/i,/you pierce/i,/you crush/i,/you whip/i,/you hit/i];
  const notHerePatterns=[/you can't find any.*here/i,/they aren't here/i,/you don't see.*here/i,/no such creature/i,/is not here/i];
  if(foundPatterns.some(p=>p.test(clean))){
    hunt.found=true;
    appendOutput('[S&D] '+target.mob+' is here! Killing...\n','quest');
    sendCmd('kill '+(actionKw(target)||target.kw));
    sndState.pendingHunt=null;
  } else if(notHerePatterns.some(p=>p.test(clean))){
    hunt.found=false;
    appendOutput('[S&D] '+target.mob+' not in this room.\n','quest');
    sndState.pendingHunt=null;
  }
}

// A quest target runs through this same pipeline (see quest.js), but the two
// places that reach for `cp check` have to do something else for it. quest.js
// registers those here rather than being imported: gmcp.js already imports both
// modules, and one more edge in that cycle buys nothing.
let questHooks = null;
export function setQuestHooks(h){ questHooks = h; }

export function xcpVerifyKill(t, onStillAlive){
  // A quest is confirmed by comm.quest {"action":"killed"}, which the MUD sends
  // unprompted -- so there is nothing to poll, and `cp check` would be answering
  // a question about a campaign this character may not even be on.
  if(t && t.isQuest && questHooks && questHooks.verifyKill){
    questHooks.verifyKill(t, onStillAlive);
    return;
  }
  // Send cp check; callback runs after result arrives
  sndState.pendingCpCheckCallback=(dead)=>{
    if(dead){
      // Start the next target's copy-hunt from the first one again.
      const ct = campaignTargets[t.index-1];
      if(ct) ct.killOrd = 0;
      appendOutput('[S&D] '+t.mob+' confirmed dead. Moving to next target.\n','quest');
      xcpNext();
    } else {
      onStillAlive();
    }
  };
  sendCmd('cp check');
}

export function xcpScheduleAction(t){
  const kw1=actionKw(t)||t.kw;
  if(sndState.xcpMode==='ht') setTimeout(()=>sendCmd('hunt '+kw1), 600);
  else if(sndState.xcpMode==='qw') setTimeout(()=>sendCmd('where '+kw1), 600);
}

// areaRuntoKeyword lived here as "first word, truncated to 5 chars". It now
// lives in areas.js, backed by the keyword list harvested from the game.

export function xcpTarget(t){
  // Only auto-restart if target is alive and not already actively being routed.
  if(t.is_dead) return;
  if(sndState.pendingXcp && sndState.pendingXcp.index===t.index && (sndState.pendingXcp.campaignInstance || sndState.pendingXcp.located)) return;
  xcpByIndex(t.index);
}

export function renderCampaign(){
  const list=document.getElementById('campaign-list');
  if(!list) return;
  list.innerHTML='';
  const header=document.createElement('div');
  header.style='background:var(--panel);padding:8px;border-radius:6px;margin-bottom:8px;font-size:12px;';
  header.innerHTML='S&D: type='+(sndState.cpType||'none')+' level='+(sndState.cpLevel||'?')+' mode='+(sndState.xcpMode||'ht');
  list.appendChild(header);
  if(campaignTargets.length===0){
    list.innerHTML+='<div style="color:var(--muted);text-align:center;padding:20px;">No campaign data. Type /cpinfo then /cpcheck.</div>';
    return;
  }
  const done=campaignTargets.filter(t=>t.completed).length;
  const left=campaignTargets.length-done;
  const progressDiv=document.createElement('div');
  progressDiv.innerHTML='<div style="background:var(--panel);padding:8px;border-radius:6px;margin-bottom:8px;">'
    + 'Progress: <b>'+done+'/'+campaignTargets.length+'</b> done'
    + (done ? ' <span style="color:var(--green)">('+done+' hidden)</span>' : '')
    + '</div>';
  list.appendChild(progressDiv);
  if(!left){
    list.innerHTML+='<div style="color:var(--green);text-align:center;padding:20px;">All targets killed &mdash; go and hand the campaign in.</div>';
    return;
  }
  // Only what is still to be killed. A finished target stayed on the list
  // labelled "dead", so after a kill the panel looked unchanged and the mob you
  // had just killed was still sitting at the top. The count above says how many
  // are done; the list itself is the work remaining.
  for(const t of campaignTargets){
    if(t.completed) continue;
    const el=document.createElement('div');
    el.className='item';
    el.style.background='rgba(231,76,60,.05)';
    const sub=t.type==='room' ? (t.roomName||'')+' in '+t.areaName : t.areaName;
    el.innerHTML='<b>'+t.index+'. '+t.mob+'</b> <span style="color:var(--muted)">'+sub+'</span>';
    el.onclick=()=>{xcpByIndex(t.index);};
    list.appendChild(el);
  }
}

export function setXcpMode(mode){
  const valid=['ht','ch','qw','nearest','off'];
  if(valid.includes(mode)){
    sndState.xcpMode=mode;
    localStorage.setItem('xcp_mode', mode);
    appendOutput('[S&D] xcp mode set to '+mode+'\n','system');
  }
  else { appendOutput('[S&D] Valid modes: ht, ch, qw, nearest, off\n','error'); }
}

export function doHuntTrick(mob){
  if(mob){ sndState.shortMobName=whereKw(mob); }
  if(!sndState.shortMobName){ appendOutput('[S&D] No target. Use /ht <mob> or /xcp first.\n','error'); return; }
  sendCmd('hunt '+sndState.shortMobName);
}

export function doQuickWhere(mob){
  if(mob){ sndState.shortMobName=gmkw(mob); }
  if(!sndState.shortMobName){ appendOutput('[S&D] No target. Use /qw <mob> or /xcp first.\n','error'); return; }
  sendCmd('where '+sndState.shortMobName);
}

export function doCpInfo(){ sendCmd('cp info'); }
export function doCpCheck(){
  // Arm the "everything is dead" detection for THIS reply only. See
  // parseCpCheckOutput: the timer line is the only marker of a campaign with no
  // targets left, but it also ends an ordinary reply, and MUD output arrives in
  // arbitrary chunks -- so when the kill lines and the timer landed in separate
  // chunks the timer was read as "no targets" and wiped the whole list.
  sndState._cpCheckExpecting = true;
  sndState._cpCheckSawKill = false;
  sendCmd('cp check');
}
export function refreshCampaign(){ togglePanel('campaign'); doCpCheck(); }
