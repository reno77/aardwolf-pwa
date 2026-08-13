// pools.js -- getting into places `runto` cannot reach.
//
// Two kinds of place, one module, because they are the same problem: the game refuses to
// speedwalk you there and tells you what to do instead.
//
//   * THE PLANES. Reached through the Amulet of the Planes: hold it, `enter` to land on the
//     Astral Plane, walk N rooms east along the corridor and `enter pool`. Pool N is N rooms
//     east of the note room, and the order is fixed (see POOL_ORDER). Leaving is plane.js.
//
//   * AREAS WITH A NOTE. "You cannot run to The DarkLight. Note: Look for the Andromeda
//     Galaxy in Vidblain. Coords 14,23." -- runto the area the note names, steer to the
//     coordinate, then take the recorded way in.
//
// Split out of snd.js at 4500 lines. Everything here is about ARRIVING; what to do once
// there belongs to the campaign FSM.

import { entryHint, landmarkKeyword, lookupArea, rememberEntryHint } from './areas.js';
import { currentRoom } from './gmcp.js';
import { sendCmd, sendCmdRaw } from './net.js';
import { findPath, walkToCoords } from './nav.js';
import { inPlane, leavePlane, noteArrival } from './plane.js';
import { areaNameMatches, awaitAreaThen, gotoRoomUid, sndState, xcpAbandonTarget, xcpRecall,
         xcpStep, RUNTO } from './snd.js';
import { appendOutput, stripAnsi } from './ui.js';

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
export const POOL_ORDER = ['gladsheim', 'pandemonium', 'hades', 'gehenna', 'acheron',
                    'twin paradises', 'arcadia', 'seven heavens',
                    "swordbreaker's hoard", 'elysium', 'beastlands',
                    'realm of the zodiac', "thandeld's conflict", 'nine hells'];

// Which pool to take when all we know is "The Lower Planes" or "The Upper Planes".
//
// `cp check` gives the AREA for these -- "a cleric einheriar (The Lower Planes)" -- and
// the pool is chosen from the LAYER, which only a room name carries. So the run reached
// the Lower Astral Plane, could not tell which of fourteen pools to step into, and
// stopped there telling the player to take it from here.
//
// But each of these is a single Aardwolf area spanning all its layers, so `where` works
// from any of them: step into one pool of the right set and the existing machinery can
// place the mob by room from inside. Hades for the lower planes, Gladsheim for the upper.
const PLANE_SET_DEFAULT = [
  {re: /\blower\s+planes?\b/i, pool: 3, name: 'Hades'},
  {re: /\bupper\s+planes?\b/i, pool: 1, name: 'Gladsheim'},
];

/** Which pool leads to this target, from its room name, or 0 if none does. */
export function poolIndexFor(t){
  const hay = ((t && (t.roomName || t.loc)) || '').toLowerCase();
  if(hay){
    // Longest name first so "seven heavens" is not shadowed by a shorter match.
    const byLength = POOL_ORDER.map((n, i) => [n, i + 1]).sort((a, b) => b[0].length - a[0].length);
    for(const [name, n] of byLength) if(hay.includes(name)) return n;
  }
  // No layer named: fall back on the plane SET, which the area name does give.
  const area = ((t && (t.areaName || t.rawLoc)) || '') + ' ' + hay;
  for(const s of PLANE_SET_DEFAULT){
    if(s.re.test(area)) return s.pool;
  }
  return 0;
}

/**
 * Walk the astral corridor to the target's pool and step into it.
 *
 * Returns false when the target is not in a plane we can identify, so the caller
 * can fall back to telling the player where they are.
 */
export function enterPoolFor(t){
  const n = poolIndexFor(t);
  if(!n) return false;
  // Already in a plane, and the target is in a different one? Leave first.
  //
  // Watched live: standing on the Oinos Gloom of Hades, `where 2.paladin` answered "On
  // the Nidavellir Layer of Gladsheim" -- the planes are one Aardwolf area, so `where`
  // sees across all of them, and the layer we need was through a different pool
  // entirely. The walker spent ninety seconds trying to path there through layers that
  // are recorded as islands. The way from one plane to another is out through the
  // amulet and back in through the right pool, which /leaveplane already does.
  // No maze test here. I put `!isMazeHere()` on this condition and it was exactly
  // backwards: every plane layer reports details:"maze", so the guard switched the
  // leave-first branch OFF in the only situation it exists for, and the corridor walk ran
  // from inside Hades -- `e` then `enter pool`, which just moves within Hades. That looped:
  // arrive, note the room, fail to path to Gladsheim, "walk the astral corridor", arrive
  // in Hades again.
  if(inPlane()){
    const here = String(currentRoom.name || '').toLowerCase();
    const wantLayer = POOL_ORDER[n-1] || '';
    if(wantLayer && !here.includes(wantLayer)){
      appendOutput('[S&D] the target is in '+wantLayer+' and we are in '
        + (currentRoom.name||'another plane')+'; leaving this one first.\n','quest');
      leavePlane();
      // /leaveplane reports its own progress; come back to the pool walk once it has
      // put us back on the astral corridor.
      let waited = 0;
      const resume = () => {
        if(sndState.pendingXcp !== t) return;
        if(!inPlane() || /astral/i.test(String(currentRoom.name||''))){
          setTimeout(()=>enterPoolFor(t), 1500);
          return;
        }
        if((waited += 5000) > 180000){
          appendOutput('[S&D] still stuck in this plane; leaving the target for now.\n','error');
          xcpAbandonTarget(t, 'could not leave the plane');
          return;
        }
        setTimeout(resume, 5000);
      };
      setTimeout(resume, 5000);
      return true;
    }
  }
  // The corridor walk is `e` a few times and then `enter pool`, which is only meaningful
  // ON the Astral Plane. Anywhere else those are ordinary moves: run from inside Hades it
  // paced east and "entered" its way into another Hades room, over and over. The check
  // above should stop that, and this refuses to do it even if a future path gets here
  // some other way.
  if(!/astral/i.test(String(currentRoom.name || ''))){
    // Get there with the amulet rather than giving up. This is the step the plane
    // transfer was missing: leaving Hades put us in the CLAN HALL (recall was what
    // worked from that layer, not the amulet), and from there nothing was walking
    // anywhere -- the corridor guard correctly refused, and the chain simply stopped.
    // The amulet is a held portal used with a bare `enter`, from anywhere that allows
    // portals, and it lands on the astral corridor.
    if(t.astralTries && t.astralTries >= 2){
      appendOutput('[S&D] cannot get to the Astral Plane from here; hold the amulet and\n'
        + '      `enter` yourself, then /xcp '+t.index+'.\n','error');
      return false;
    }
    t.astralTries = (t.astralTries || 0) + 1;
    appendOutput('[S&D] the pools are reached from the Astral Plane, and this is '
      + (currentRoom.name || 'somewhere else')+' -- using the amulet to get there.\n','quest');
    sendCmd('hold amulet');
    setTimeout(()=>{
      if(sndState.pendingXcp !== t) return;
      sendCmdRaw('enter');
      setTimeout(()=>{
        if(sndState.pendingXcp !== t) return;
        if(/astral/i.test(String(currentRoom.name || ''))){ enterPoolFor(t); return; }
        appendOutput('[S&D] the amulet did not open here'
          + ' (noportal room?); trying from Aylor.\n','error');
        xcpRecall(t, ()=>enterPoolFor(t), 0, (why)=>{
          appendOutput('[S&D] '+why+'.\n','error');
          xcpAbandonTarget(t, 'cannot reach the Astral Plane');
        });
      }, 3000);
    }, 1500);
    return true;
  }
  const layerKnown = !!((t.roomName || t.loc || '').toLowerCase()
    && POOL_ORDER.some(nm => String(t.roomName || t.loc || '').toLowerCase().includes(nm)));
  appendOutput('[S&D] '+(t.roomName || t.areaName)+': pool '+n+' ('+(POOL_ORDER[n-1]||'?')+')'
    + (layerKnown ? '' : ' -- the campaign named the area, not the layer, and `where` reaches'
      + ' the whole area from inside')
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
      // Remember the room the pool dropped us in: a plane can only be LEFT from
      // its arrival room, and nothing recorded which one that was, so getting out
      // afterwards meant probing room by room with the amulet. See /leaveplane.
      noteArrival();
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
        // Only if the amulet actually took us somewhere. A noportal room answers
        // "Magic walls bounce you back" and leaves us standing where we were, and
        // walking the corridor from there paced three rooms east up a city street
        // in the Ruins of Diamond Reach before trying to enter a pool that was not
        // there.
        if(t && /astral/i.test(currentRoom.name || '') && enterPoolFor(t)) return;
        if(t && poolIndexFor(t) && !/astral/i.test(currentRoom.name || '')){
          appendOutput('[S&D] the amulet did not open here (this room blocks portals).\n'
            + '       Move somewhere that allows them, then /xcp again.\n','error');
          return;
        }
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
        // Only if the amulet actually took us somewhere. A noportal room answers
        // "Magic walls bounce you back" and leaves us standing where we were, and
        // walking the corridor from there paced three rooms east up a city street
        // in the Ruins of Diamond Reach before trying to enter a pool that was not
        // there.
        if(t && /astral/i.test(currentRoom.name || '') && enterPoolFor(t)) return;
        if(t && poolIndexFor(t) && !/astral/i.test(currentRoom.name || '')){
          appendOutput('[S&D] the amulet did not open here (this room blocks portals).\n'
            + '       Move somewhere that allows them, then /xcp again.\n','error');
          return;
        }
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
        // Are we THERE already? Steering to Vidblain 23,4 put the character in "The
        // Local Bar [imperial]" -- the coordinate is inside Imperial Nation, not next to
        // it -- and the run still stopped to say "enter it, then /xcp 1" about an area it
        // was standing in. Check before doing anything else.
        if(currentRoom.area && areaNameMatches(t.areaName, currentRoom.area)){
          appendOutput('[S&D] the coordinate put us inside '+(t.areaName||currentRoom.area)
            + '; carrying on from here.\n','quest');
          t.recallSent = true;
          xcpStep(t);
          return;
        }
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
        // A recorded command beats a guessed one. The note names a landmark, but
        // the way through it is an ordinary exit and nothing derives one from the
        // other: The DarkLight's note says "Look for the Andromeda Galaxy in
        // Vidblain. Coords 14,23." and the way in from there is `d`. See
        // setEntryDir/SEED_ENTRIES in areas.js.
        if(hint.dir && !t.entryDirTried){
          t.entryDirTried = true;
          appendOutput('[S&D] at '+hint.x+','+hint.y+'; the recorded way in is "'
            + hint.dir+'".\n','quest');
          const cmds = String(hint.dir).split(';').map(c=>c.trim()).filter(Boolean);
          let d = 0;
          for(const c of cmds){ setTimeout(()=>sendCmd(c), d); d += 1200; }
          setTimeout(()=>{ if(sndState.pendingXcp===t){ t.recallSent = true; xcpStep(t); } }, d+1500);
          return;
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
