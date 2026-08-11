// quest.js -- run an Aardwolf quest target through the campaign machinery.
//
// A quest and a campaign target are the same problem: a mob, somewhere, that has
// to be reached and killed. snd.js already solves it -- area keyword, runto, the
// hunt trick to pick the right copy, `where` to place it, walkTo, the health gate,
// then verify. None of that needed rewriting; a quest just needed to be expressed
// as a target and handed to xcpStep.
//
// The one thing a quest has that a campaign does not is the ROOM. `cp check`
// gives a single location field that is sometimes an area and sometimes a room,
// and the helper has to guess which. GMCP's comm.quest gives mob, room and area
// as three separate fields:
//
//   comm.quest {"action":"start","targ":"a swamp ape","room":"Swamp Ape Enclosure",
//               "area":"Aardwolf Zoological Park","timer":52}
//
// (Documented at https://www.aardwolf.com/wiki/index.php/Clients/GMCP. The client
// previously parsed six guessed regexes out of the text -- "You have been tasked
// to kill X in the area of Y." and friends -- to fill two labels in a panel, and
// did nothing else with them. The structured feed is authoritative and carries the
// room, which the text patterns never captured.)
//
// So a quest target starts life already knowing its room, which is the case the
// campaign helper handles best: resolve the room, walk to it, kill what is there.
// No `where`, no hunt trick, no sweeping identically-named rooms -- unless the
// room cannot be resolved, in which case it falls back to exactly the campaign
// path.
//
// Verification is better too. A campaign kill is confirmed by re-reading
// `cp check`; a quest kill arrives unprompted as comm.quest {"action":"killed"},
// so there is nothing to poll and no window in which the answer is stale.

import { resolveRoomByNameAnywhere } from './db.js';
import { appendOutput } from './ui.js';
import { sendCmd } from './net.js';
import { cancelWalk, isWalking } from './nav.js';
import { gmkw, huntTrickKw, sndState, setQuestHooks, xcpStep } from './snd.js';

/**
 * Everything the game has told us about the current quest.
 *
 * `state` is what we believe: 'none' (nothing running), 'active', 'missing' (the
 * target is gone -- killed by someone else, or repopped away), 'killed' (done,
 * not yet handed in), 'unknown' (we have not been told yet, e.g. the client
 * connected mid-quest and has not asked).
 */
export let quest = { state: 'unknown', mob: '', room: '', area: '', timer: 0, at: 0 };

/** True while a quest target is the thing /xcp machinery is working on. */
function questIsPending(){
  return !!(sndState.pendingXcp && sndState.pendingXcp.isQuest);
}

// ---------------------------------------------------------------------------
// the GMCP feed
// ---------------------------------------------------------------------------

function remember(data, state){
  quest = {
    state,
    mob:   String(data.targ || quest.mob || ''),
    room:  String(data.room || ''),
    area:  String(data.area || ''),
    timer: Number(data.timer != null ? data.timer : (data.time != null ? data.time : 0)) || 0,
    at:    Date.now(),
  };
}

/** Called from gmcp.js for every comm.quest message. */
export function noticeQuest(data){
  if(!data || typeof data !== 'object'){
    // A bare value, e.g. comm.quest "ready". Nothing to record.
    if(data) appendOutput('[quest] '+String(data)+'\n','quest');
    return;
  }
  const action = String(data.action || '');
  const status = String(data.status || '');

  // "targ":"missing" comes with empty room and area: the mob is not findable, so
  // there is nothing to walk to and the honest answer is to say so rather than
  // send the walker after an empty room name.
  if(String(data.targ || '') === 'missing'){
    quest = { state:'missing', mob:'', room:'', area:'', timer:0, at:Date.now() };
    paint();
    appendOutput('[quest] the game says your target is missing -- someone else killed it,\n'
      + '        or it repopped away. `quest info` again, or fail and re-request.\n','error');
    if(questIsPending()) stopQuestRun('target missing');
    return;
  }

  if(action === 'start' || (action === 'status' && data.targ)){
    remember(data, 'active');
    paint();
    describe(action === 'start' ? 'new quest' : 'on a quest');
    return;
  }
  if(action === 'status' && status === 'ready'){
    quest = { state:'none', mob:'', room:'', area:'', timer:0, at:Date.now() };
    paint();
    return;
  }
  if(action === 'ready'){
    quest = { state:'none', mob:'', room:'', area:'', timer:0, at:Date.now() };
    paint();
    appendOutput('[quest] you can quest again.\n','quest');
    return;
  }
  if(action === 'killed' || String(data.target || '') === 'killed'){
    quest.state = 'killed';
    quest.at = Date.now();
    paint();
    appendOutput('[quest] target dead'
      + (data.time != null ? ' -- '+data.time+' minute(s) left to hand it in' : '')
      + '. Go to a questmaster and `quest complete`.\n','quest');
    // This is the confirmation snd.js would otherwise have polled `cp check` for.
    const t = sndState.pendingXcp;
    if(t && t.isQuest){
      if(t.onQuestKilled){ const f = t.onQuestKilled; t.onQuestKilled = null; f(); }
      sndState.pendingXcp = null;
    }
    return;
  }
  if(action === 'comp'){
    quest = { state:'none', mob:'', room:'', area:'', timer:0, at:Date.now() };
    paint();
    appendOutput('[quest] complete: '+(data.qp != null ? data.qp+'qp' : 'done')
      + (data.tierqp ? ' +'+data.tierqp+' tier' : '')
      + (data.gold ? ', '+data.gold+' gold' : '')
      + (data.wait != null ? ' -- next quest in '+data.wait+' min' : '')+'\n','quest');
    if(questIsPending()) stopQuestRun('quest complete');
    return;
  }
  if(action === 'fail' || action === 'timeout'){
    quest = { state:'none', mob:'', room:'', area:'', timer:0, at:Date.now() };
    paint();
    appendOutput('[quest] '+(action === 'fail' ? 'failed' : 'timed out')
      + (data.wait != null ? ' -- next quest in '+data.wait+' min' : '')+'\n','error');
    if(questIsPending()) stopQuestRun(action);
    return;
  }
  if(action === 'warning'){
    appendOutput('[quest] '+(data.time != null ? data.time+' minute(s)' : 'not long')
      + ' left on this quest.\n','error');
    return;
  }
  if(action === 'reset'){
    appendOutput('[quest] quest timer reset'
      + (data.timer != null ? ' ('+data.timer+' min)' : '')+'\n','quest');
    return;
  }
}

function stopQuestRun(reason){
  sndState.pendingXcp = null;
  sndState.pendingKill = null;
  sndState.pendingTwinProbe = null;
  sndState.xcpAwaitingArea = null;
  if(isWalking()) cancelWalk(reason);
}

/**
 * Keep the quest panel showing the authoritative data.
 *
 * The labels were filled only by the text patterns in ui.js, so on a client whose
 * quest arrived over GMCP -- which is every client -- they stayed blank or stale.
 */
function paint(){
  try {
    const target = document.getElementById('quest-target');
    const area = document.getElementById('quest-area');
    const box = document.getElementById('quest-info');
    if(!target || !area || !box) return;
    if(quest.state === 'active' || quest.state === 'killed'){
      target.textContent = quest.mob + (quest.state === 'killed' ? ' (dead)' : '');
      area.textContent = (quest.room ? quest.room + ', ' : '') + (quest.area || '?');
      box.style.display = 'block';
    } else {
      box.style.display = 'none';
    }
  } catch(e){ /* the panel is a convenience, never load-bearing */ }
}

function describe(lead){
  appendOutput('[quest] '+lead+': '+quest.mob
    + (quest.room ? ' in '+quest.room : '')
    + (quest.area ? ' ('+quest.area+')' : '')
    + (quest.timer ? ' -- '+quest.timer+' min' : '')+'\n','quest');
  appendOutput('[quest] /xq to go and kill it.\n','quest');
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

/** `/quest` -- what we know, and where the room resolves to. */
export function questInfo(){
  if(quest.state === 'none'){ appendOutput('[quest] not on a quest.\n','system'); askGame(); return; }
  if(quest.state === 'unknown'){
    appendOutput('[quest] nothing recorded yet -- asking the game.\n','system');
    askGame();
    return;
  }
  appendOutput('[quest] '+quest.state+': '+(quest.mob||'?')
    + (quest.room ? ' in '+quest.room : '')
    + (quest.area ? ' ('+quest.area+')' : '')
    + (quest.timer ? ' -- '+quest.timer+' min' : '')+'\n','quest');
  if(quest.room){
    const room = resolveRoomByNameAnywhere(quest.room, quest.area);
    appendOutput('[quest] room '+(room ? 'resolves to '+room.uid+' ['+(room.area||'?')+']'
      : 'is not in the map -- /xq will fall back to hunt and where')+'\n','system');
  }
}

/**
 * Ask the game to re-send the quest state.
 *
 * `quest info` prints text we deliberately do not parse; the reply that matters
 * is the comm.quest status the MUD sends alongside it. Both relays re-request
 * GMCP state on {action:'gmcp_request'}, which is the same path the client uses
 * after login, so this needs no new protocol.
 */
function askGame(){
  sendCmd('quest info');
}

/**
 * `/xq` -- take the quest target and run it through the campaign pipeline.
 *
 * The target object is the same shape buildCpTargets makes, so everything
 * downstream of xcpStep works unchanged. `isQuest` marks it so the two places
 * that would otherwise reach for `cp check` -- verification, and the "N targets
 * left" report -- do the quest-shaped thing instead.
 */
export function doXq(){
  if(quest.state === 'killed'){
    appendOutput('[quest] already dead -- go to a questmaster and `quest complete`.\n','quest');
    return;
  }
  if(quest.state === 'missing'){
    appendOutput('[quest] the game says the target is missing; there is nothing to walk to.\n','error');
    return;
  }
  if(quest.state !== 'active' || !quest.mob){
    appendOutput('[quest] no quest target on record. `quest info` (or /quest) first;\n'
      + '        the game sends the target, room and area over GMCP when it answers.\n','error');
    askGame();
    return;
  }

  // The room is the whole advantage a quest has over a campaign target, so use it
  // when it resolves. resolveRoomByNameAnywhere imports the area from the
  // reference map if it is missing, and returns the live uid when the room has
  // already been identified -- which is what makes the walk possible in an area
  // never visited.
  const room = quest.room ? resolveRoomByNameAnywhere(quest.room, quest.area) : null;
  const areaName = (room && room.area) || quest.area || '';
  if(!areaName && !room){
    appendOutput('[quest] the game gave no area for this target, so there is nothing to\n'
      + '        travel to. Get into the area yourself, then /xq.\n','error');
    return;
  }

  const t = {
    mob: quest.mob,
    areaName, area: areaName,
    areaUid: room ? room.area : null,
    roomUid: room ? room.uid : null,
    roomName: room ? room.name : (quest.room || null),
    type: room ? 'room' : 'unknown',
    // /xq rather than a number: the abandon path tells the player how to retry,
    // and "/xcp 3" would be the wrong advice for a quest.
    index: 'q',
    isQuest: true,
    progress: 0, total: 1, completed: false, is_dead: false,
    kw: gmkw(quest.mob, areaName),
    htkw: huntTrickKw(quest.mob),
    recallSent: false, located: false, roomQueue: [], roomIndex: 0,
    whereInstances: null, huntTrickIndex: 1, campaignInstance: null,
  };

  appendOutput('[quest] going after '+t.mob+' in '
    + (t.roomName || areaName) + (t.roomUid ? ' ['+t.roomUid+']' : '')
    + (t.type === 'unknown' ? ' -- room not mapped, will locate with hunt/where' : '')
    + '\n','quest');

  sndState.xcpIndex = 0;
  sndState.shortMobName = t.kw;
  sndState.pendingKill = null;
  sndState.pendingTwinProbe = null;
  sndState.xcpAwaitingArea = null;
  sndState.pendingXcp = t;
  try {
    xcpStep(t);
  } catch(e){
    appendOutput('[quest] internal error starting this target: '+(e && e.message || e)+'\n','error');
    console.error('xq failed', e);
    sndState.pendingXcp = null;
  }
}

// snd.js owns the pipeline but must not import this module -- gmcp.js already
// imports both, and a third edge would make the cycle harder to reason about than
// it needs to be. Register instead, the way nav.js registers its walk canceller.
setQuestHooks({
  /**
   * A quest kill needs no poll: comm.quest {"action":"killed"} arrives on its own.
   * So wait for it, and only if it does not come conclude that whatever died was
   * the wrong copy and let the caller carry on sweeping.
   */
  verifyKill(t, onStillAlive){
    if(quest.state === 'killed'){ onQuestDone(t); return; }
    t.onQuestKilled = () => onQuestDone(t);
    setTimeout(() => {
      if(!t.onQuestKilled) return;      // the GMCP message got there first
      t.onQuestKilled = null;
      if(sndState.pendingXcp !== t) return;
      appendOutput('[quest] that kill did not register as the quest target'
        + ' -- wrong copy, or it is not dead.\n','error');
      onStillAlive();
    }, 9000);
  },
  /** What to say instead of "N campaign targets left". */
  abandonNote(){
    appendOutput('[quest] gave up on this quest target. /quest to see it, /xq to retry,\n'
      + '        or walk into the area yourself and /xq from inside.\n','quest');
  },
});

function onQuestDone(t){
  appendOutput('[quest] '+t.mob+' confirmed as the quest target and dead.\n','quest');
  appendOutput('[quest] runto a questmaster and `quest complete` to collect.\n','quest');
  if(sndState.pendingXcp === t) sndState.pendingXcp = null;
}
