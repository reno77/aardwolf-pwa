// grind.js -- walk an area killing what is in it, until a level.
//
// The killing itself is already solved: the player's own triggers fire on a mob's
// description line and run their attack aliases ("A gust of wind blows" ->
// `strang gust; back gust; ki gust; attgreen`). What was missing was the other
// half -- somebody to keep walking, keep the character alive, and know when to
// stop -- which is the part that was being typed by hand.
//
// Three rules it must not break, all learned the hard way in this codebase:
//
//   1. Do not walk while hurt. The walker's own health floor exists because a
//      route through a hostile area at 19% hp is how a character reaches the
//      morgue. Here the whole point is to pick fights, so the floor is higher and
//      resting is part of the loop rather than a failure.
//   2. Do not take someone else's kill. If another player is standing in the
//      room, leave and grind somewhere else. This is etiquette, not an
//      optimisation, so the check runs before anything else and the room is
//      remembered for a while.
//   3. Stop at the level asked for. Levelling past a goal's ceiling cannot be
//      undone -- the Gladiator's Arena goal is capped at 96, so "level to 91"
//      means 91, not "level until something goes wrong".

import { charLevel, charState, currentRoom, hpFraction, manaFraction, movesFraction,
         STATE_FIGHTING, STATE_RESTING, STATE_RUNNING, STATE_SLEEPING } from './gmcp.js';
import { sendCmd, sendCmdRaw } from './net.js';
import { lastRoomChars } from './questtag.js';
import { onInterval } from './ticker.js';
import { appendOutput } from './ui.js';

// Full health before walking into the next room, not "enough to survive the last one".
// Every room here holds something that attacks on sight, so a step IS starting a fight,
// and starting one at 40% is how a grind ends in the morgue. Healing is cheap and mana
// comes back while walking; a death costs experience and stats.
const FIGHT_READY   = 0.95;
const HEAL_BELOW   = 0.95;   // cast heal below this
const REST_BELOW   = 0.35;   // sit down and wait, rather than walk into the next room
const MANA_FLOOR   = 0.20;   // no mana is no healing, so rest before it runs out
const RESUME_AT    = 0.92;   // back to walking once this healthy
const STEP_MS      = 2200;
const FIGHT_MS     = 2500;
const REST_MS      = 6000;
const SKIP_ROOM_MS = 180000;  // how long a room with someone in it is left alone

let run = null;
let unsubscribe = null;

// ---------------------------------------------------------------------------
// is someone else standing here?
// ---------------------------------------------------------------------------
//
// Aardwolf writes mobs with an article ("A gust of wind blows by") and players with
// their name and title ("Bedokman the Vampire is here"). Both can carry flags first,
// so those come off before the test. Proper-noun mobs (Sylciri, Arosa) read as
// players by this rule and the room gets skipped -- which is the safe way to be
// wrong, because the cost is walking one room further.
const FLAGS = /^(?:\((?:[^)]*)\)\s*)+/;
const MOB_START = /^(?:a|an|the|some|someone|his|her|its|two|three|several)\b/i;

export function playersHere(){
  const out = [];
  for(const raw of lastRoomChars()){
    const line = String(raw || '').replace(FLAGS, '').trim();
    if(!line) continue;
    if(MOB_START.test(line)) continue;             // "A gorilla is here."
    if(!/^[A-Z][a-z]+/.test(line)) continue;       // not a name-shaped opener
    out.push(line.split(/\s+/)[0]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// the loop
// ---------------------------------------------------------------------------

function say(msg, cls){ appendOutput('[grind] ' + msg + '\n', cls || 'system'); }

/** `/grind <level>` -- kill what is here until that level, then stop. */
export function startGrind(arg){
  // "/grind off" has to STOP, not print usage.
  //
  // The stop command is `/grindstop`, but every other long-running helper here takes
  // `off` (`/medic off`, `/autorun off`), so `off` is what gets typed under pressure --
  // and when it answered with a usage line, the grind was still walking while the
  // player believed it had stopped. It kept roaming for another few hundred rooms.
  // A stop word that is ignored is worse than no stop word at all.
  if(/^(?:off|stop|no|end|halt)$/i.test(String(arg || '').trim())){
    if(!run) say('not grinding.', 'quest');
    stopGrind('asked to stop');
    return;
  }
  const target = parseInt(String(arg || '').match(/\d+/) || [], 10);
  if(!target){
    say('usage: /grind <level to stop at>, e.g. /grind 91', 'error');
    return;
  }
  if(charLevel && charLevel >= target){
    say('already level ' + charLevel + '.', 'quest');
    return;
  }
  run = { target, area: String(currentRoom.area || ''), startLevel: charLevel || 0,
          lastDir: null, skip: new Map(), kills: 0, rests: 0, at: Date.now() };
  say('levelling to ' + target + ' in ' + (run.area || 'this area')
      + '. Your triggers do the killing; this walks, rests and stops at ' + target + '.', 'quest');
  say('rooms with another player in them are skipped -- their kill, not ours.');
  if(!unsubscribe) unsubscribe = onInterval(2000, tick);
  step();
}

export function stopGrind(why){
  if(!run) return;
  const r = run;
  run = null;
  if(unsubscribe){ unsubscribe(); unsubscribe = null; }
  say('stopped' + (why ? ' -- ' + why : '') + '. ' + r.kills + ' room(s) walked, '
      + r.rests + ' rest(s).', 'quest');
}

export function isGrinding(){ return !!run; }

/**
 * The heartbeat, so a missed reply cannot strand the loop.
 *
 * Chrome throttles setTimeout in a hidden tab, which is why this hangs off the
 * shared worker-backed ticker rather than its own timer -- the same reason the
 * campaign watchdog does.
 */
function tick(){
  if(!run) return;
  if(Date.now() - run.at < 12000) return;      // something is still in flight
  step();
}

function step(){
  if(!run) return;
  run.at = Date.now();

  if(charLevel && charLevel >= run.target){
    say('level ' + charLevel + ' -- that is what you asked for.', 'quest');
    stopGrind('reached level ' + run.target);
    return;
  }

  // Fighting is the point; let it finish.
  if(charState === STATE_FIGHTING || charState === STATE_RUNNING){
    schedule(FIGHT_MS);
    return;
  }

  // HEAL BEFORE RESTING. The first version had these the other way round and sat at
  // 28% health with a full mana bar, announcing "resting" every six seconds and
  // recovering nothing: the rest branch caught the low-health case first, so the heal
  // below it could never run. Mana is the fast way back and it regenerates while
  // walking, so spend it.
  if(hpFraction() < HEAL_BELOW && manaFraction() > MANA_FLOOR){
    sendCmd('cast heal');
    schedule(3000);
    return;
  }

  // Only when there is no mana left to heal with. `rest`, NOT `sleep`: the player's own
  // fado_t20 trigger answers Aardwolf's "You dream about..." with `wake`, so a sleeping
  // character stands straight back up and the loop rests forever without ever resting.
  if(hpFraction() < REST_BELOW || manaFraction() < MANA_FLOOR || movesFraction() < 0.05){
    if(charState !== STATE_RESTING && charState !== STATE_SLEEPING){
      run.rests++;
      say(Math.round(hpFraction()*100) + '% health, ' + Math.round(manaFraction()*100)
          + '% mana -- resting.');
      sendCmdRaw('rest');
    }
    if(hpFraction() >= RESUME_AT && manaFraction() >= 0.5){
      sendCmdRaw('stand');
      spellup();
    }
    schedule(REST_MS);
    return;
  }
  if(charState === STATE_SLEEPING || charState === STATE_RESTING){
    sendCmdRaw('stand');
    schedule(1200);
    return;
  }

  // Do not step into the next room short of full. The heal branch above tops us up
  // whenever there is mana; this is the gate that makes sure the step waits for it.
  if(hpFraction() < FIGHT_READY && manaFraction() > MANA_FLOOR){
    schedule(2500);
    return;
  }

  // Someone else is working this room.
  const others = playersHere();
  if(others.length){
    if(currentRoom.uid) run.skip.set(String(currentRoom.uid), Date.now() + SKIP_ROOM_MS);
    say(others.join(', ') + ' is here -- moving on rather than taking their kill.', 'quest');
    move(true);
    return;
  }

  run.kills++;
  move(false);
}

/**
 * Feed MUD output here: notice a refused move and stop using that exit.
 *
 * MAX_FAILS is the backstop. Remembering refusals should be enough on its own, but
 * "enough on its own" is exactly what was believed about the least-used counter, and
 * the failure mode is a bot hammering a wall at one command every couple of seconds
 * with nobody watching. If several moves in a row are refused, the walker's picture of
 * the room is wrong in some way this code does not model -- so stop and say so, rather
 * than keep sending. A stopped grind costs a few minutes; a spamming one costs the
 * connection, and the player is the one who has to notice.
 */
const MAX_FAILS = 5;
const REFUSED = /Alas, you cannot go that way\.|There is no exit in that direction\.|You cannot go that way/i;

export function parseGrindOutput(text){
  if(!run || !run.lastDir) return;
  if(!REFUSED.test(String(text || ''))) return;

  const here = run.lastFrom || String(currentRoom.uid || currentRoom.name || '?');
  run.blocked = run.blocked || new Map();
  if(!run.blocked.has(here)) run.blocked.set(here, new Set());
  run.blocked.get(here).add(run.lastDir);

  run.fails = (run.fails || 0) + 1;
  if(run.fails >= MAX_FAILS){
    say('move refused ' + run.fails + ' times in a row at ' + (currentRoom.name || here)
        + ' -- stopping rather than walking into a wall.', 'error');
    stopGrind('exits refused');
  }
}

function schedule(ms){
  if(!run) return;
  run.at = Date.now() + Math.max(0, ms - 2000);
  setTimeout(() => { if(run) step(); }, ms);
}

/**
 * One step, preferring somewhere new.
 *
 * `avoidBack` is set when leaving a room because of another player: going straight
 * back the way we came would land us next to them again on the following step.
 */
function move(avoidBack){
  if(!run) return;
  const exits = (currentRoom.exits || []).filter(Boolean);
  if(!exits.length){
    say('no exits from ' + (currentRoom.name || 'here') + '.', 'error');
    stopGrind('nowhere to go');
    return;
  }
  const back = {n:'s', s:'n', e:'w', w:'e', u:'d', d:'u'}[run.lastDir] || null;
  let choices = exits;
  if((avoidBack || exits.length > 1) && back) choices = exits.filter(d => d !== back);
  if(!choices.length) choices = exits;

  // LEAST-USED exit from THIS room, not a rotation across rooms.
  //
  // A single counter shared by every room walks a groove: in Elemental Canyon's 3x3
  // block it worked the middle and bottom rows over and over and never once went to
  // the top, so a third of the mobs were never pulled. Counting per room and per
  // direction makes the walk fan out -- a grid gets covered because the exit taken
  // least often from where we are standing is, by definition, the way we have been
  // neglecting.
  const here = String(currentRoom.uid || currentRoom.name || '?');
  // Arriving somewhere new means the last direction worked -- forget the failures.
  if(here !== run.lastFrom) run.fails = 0;
  run.lastFrom = here;

  // Drop exits this room has already refused. GMCP's exit list is not the same thing
  // as "you may walk that way": the gale rooms above Elemental Canyon advertise east
  // and answer "Alas, you cannot go that way", and closed doors, flying-only and
  // level-gated exits all read as ordinary exits too. Without this the walker picked
  // the same refused direction every time -- its least-used counter only counts moves
  // it *sent*, so a direction that never succeeds stays the least-used one forever,
  // and it spammed east into a wall until a human pulled the plug.
  run.blocked = run.blocked || new Map();
  const bad = run.blocked.get(here);
  if(bad && bad.size){
    const open = choices.filter(d => !bad.has(d));
    if(open.length) choices = open;
    else {                              // every exit refused -- walking back is all that is left
      const out = exits.filter(d => !bad.has(d));
      choices = out.length ? out : (back ? [back] : exits);
    }
  }

  run.taken = run.taken || new Map();
  if(!run.taken.has(here)) run.taken.set(here, new Map());
  const used = run.taken.get(here);
  let dir = choices[0], fewest = Infinity;
  for(const d of choices){
    const n = used.get(d) || 0;
    if(n < fewest){ fewest = n; dir = d; }
  }
  used.set(dir, (used.get(dir) || 0) + 1);
  run.lastDir = dir;
  sendCmdRaw(dir);
  schedule(STEP_MS);
}

/**
 * The game's own `spellup`, which casts every spell the character has.
 *
 * Not a list of casts, and deliberately not the client alias that used to shadow it:
 * that alias was four spells (armor, bless, detect invis, detect hidden) and stood in
 * front of a command that does the lot, so a "spelled up" character walked into a
 * grind with almost nothing on.
 */
function spellup(){
  sendCmdRaw('spellup');
}
