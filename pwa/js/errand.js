// errand.js -- fetch the item an exit needs, then carry on.
//
// Some exits are gated on an item you have to go and get. The map records the exit
// ("hold 'steel crank';turn crank") but nothing about where the item is, so the
// walker did the only thing it could: parked the exit, looked for another way, and
// reported "there is no way round it". In the Keep of the Asherodan that is the only
// route to Below the Green Chamber, so the campaign target behind it was
// unreachable, twice.
//
// The item is not always findable by rule. This one took reading the room:
//
//   Ancient Elevator: "Below the buttons is a metal hexagonal socket... In Case of
//   Emergency, Break the Glass" -> `break glass` drops a note ->
//   "you will just have to find the crank... it was near some of those plants that
//   don't have flowers... you will have to dig around until you find it."
//
// which points at Active Plants, where a steel crank does indeed lie on the ground.
// No general rule gets there. So the recipe is written down, once, and the walker
// runs it instead of giving up.
//
// The room is also full of aggressive vines that took a third of the character's
// health on entry and triggered wimpy, which is why a recipe can say to rest first
// and to leave immediately after.

import { unparkItemExits } from './db.js';
import { charState, currentRoom, hpFraction, STATE_FIGHTING } from './gmcp.js';
import { sendCmd, sendCmdRaw } from './net.js';
import { appendOutput } from './ui.js';

// Keyed by area and the item the exit asks for. `room` is matched by name, which is
// what the reference map gives us and what survives a schema rebuild.
const RECIPES = [
  {
    area: 'asherodan', item: 'steel crank',
    room: 'Active Plants',
    // It lies on the ground in plain sight; `dig` is what the note tells you to do
    // and it works too, so do both and let one of them succeed.
    cmds: ['get crank', 'dig', 'get crank'],
    restAbove: 0.85,          // the vines there hit for a third of full health
    leaveAfter: 's',          // grab it and get out rather than fighting four vines
    note: 'the crank lies in Active Plants, guarded by aggressive vines',
  },
  {
    // The mine key is nosteal and cannot be hunted off anybody: the reference map's
    // own note for the mine gate says how it works --
    //
    //   "You will need to trick the mine guard before you can obtain this (nosteal)
    //    key. Kill one guard for his trident and uniform. Then wear both items and
    //    kill the second guard. He'll believe you're there to relieve him and will
    //    hand you the key."
    //
    // Which is why `hunt guard` was never going to work, however well it followed
    // the trail. Both guards stand in The guard room, next to the gate.
    area: 'hawklord', item: 'a mine key',
    room: 'The guard room',
    cmds: ['kill guard', '@fight', 'get all corpse', 'wear trident', 'wear uniform',
           'kill guard', '@fight', 'get all corpse'],
    restAbove: 0.8,
    note: 'the mine key needs the guard trick: kill one guard for his trident and '
        + 'uniform, wear both, then the second guard hands the key over',
  },
];

function norm(s){ return String(s || '').trim().toLowerCase(); }

export function errandFor(area, item){
  const a = norm(area), i = norm(item);
  if(!a || !i) return null;
  // Prefix either way on the area. GMCP's key for the Realm of the Hawklords is
  // `hawklord`, singular, and a recipe written as `hawklords` matched nothing at all
  // -- the errand simply never ran and the run fell back to hunting a guard across
  // the whole area. A silent near-miss is the worst possible failure here.
  const areaOk = (r) => {
    const ra = norm(r.area);
    return ra === a || ra.startsWith(a) || a.startsWith(ra);
  };
  const itemOk = (r) => {
    const ri = norm(r.item);
    return ri === i || i.includes(ri) || ri.includes(i);
  };
  return RECIPES.find(r => areaOk(r) && itemOk(r)) || null;
}

let running = null;

/**
 * Go and get `item`, then call `onDone` (or `onFail`).
 *
 * Deliberately takes the walker as an argument rather than importing nav.js: nav.js
 * is what calls this, and a cycle between the two is not worth the convenience.
 */
export function runErrand(recipe, walkTo, onDone, onFail){
  if(running){ if(onFail) onFail('already fetching something'); return false; }
  running = recipe;
  const fail = (why) => { running = null; if(onFail) onFail(why); };
  const done = () => {
    running = null;
    // The exit that sent us here was parked at level=999 the moment it was refused,
    // which takes it out of the pathfinder -- so without this the walk we are about
    // to resume cannot use the route we just made possible.
    unparkItemExits();
    if(onDone) onDone();
  };

  appendOutput('[errand] '+recipe.note+'; going to get it.\n','quest');

  // One retry, because the first attempt can lose a route that exists.
  //
  // Watched live: the errand's walk out of the Ancient Elevator answered "no route
  // to that room from here", and the identical call a minute later planned it in
  // seven steps. The local map splits whenever a room is promoted -- its reference
  // exits move onto the live uid -- and walkTo repairs that itself before reporting
  // failure, so the second ask sees the joined graph.
  let tried = 0;
  const go = () => {
    tried++;
    // The room is resolved by NAME because that is what the recipe can know. The
    // walker takes uids, so hand it the name and let it resolve -- see doNavTo.
    walkTo(recipe.room, () => {
      runSteps(recipe.cmds.slice(), ()=>{
        if(recipe.leaveAfter){
          sendCmdRaw(recipe.leaveAfter);
          setTimeout(done, 1500);
          return;
        }
        done();
      });
    }, (why)=>{
      if(tried < 2){
        appendOutput('[errand] no route to '+recipe.room+' yet; asking again in a moment.\n','system');
        setTimeout(go, 2500);
        return;
      }
      fail(why || 'could not reach '+recipe.room);
    });
  };

  if(recipe.restAbove && hpFraction() < recipe.restAbove){
    appendOutput('[errand] '+Math.round(hpFraction()*100)+'% health -- resting first;\n'
      + '         '+recipe.room+' is not somewhere to arrive hurt.\n','quest');
    sendCmdRaw('sleep');
    let tries = 0;
    const wait = () => {
      if(hpFraction() >= recipe.restAbove){ sendCmdRaw('stand'); setTimeout(go, 1500); return; }
      if(++tries > 45){ fail('could not recover enough health to go there'); return; }
      setTimeout(wait, 8000);
    };
    setTimeout(wait, 8000);
    return true;
  }
  go();
  return true;
}

export function errandRunning(){ return !!running; }

/**
 * Run a recipe's steps in order, waiting where waiting is what matters.
 *
 * A fixed delay per command is fine for `get` and `wear` and useless for a kill: the
 * guard-trick recipe has to finish one fight before looting the corpse and starting
 * the next, and a fight is however long it is. `@fight` means "wait until combat
 * ends", capped so a fight we are losing does not hold the errand open forever.
 */
const STEP_GAP_MS = 1200;
const FIGHT_MIN_MS = 8000;   // give the kill time to become a fight
const FIGHT_CAP_MS = 90000;

function runSteps(steps, onDone){
  const next = () => {
    if(!running){ return; }                       // cancelled under us
    const step = steps.shift();
    if(step === undefined){ onDone(); return; }
    // A minimum wait before believing char.status: right after `kill` the state has
    // not caught up, so checking straight away reads "not fighting" and loots a
    // corpse that does not exist yet. And if char.status is not flowing at all --
    // which happens on a session the relay reattached to -- the minimum is the only
    // thing standing between the kill and the next command.
    if(step === '@fight'){ setTimeout(()=>waitForCombat(next, 0), FIGHT_MIN_MS); return; }
    sendCmd(step);
    setTimeout(next, STEP_GAP_MS);
  };
  next();
}

function waitForCombat(then, waited){
  if(!running) return;
  if(charState !== STATE_FIGHTING || waited >= FIGHT_CAP_MS){
    if(waited >= FIGHT_CAP_MS){
      appendOutput('[errand] that fight is still going after '
        + Math.round(FIGHT_CAP_MS/1000)+'s; carrying on anyway.\n','error');
    }
    setTimeout(then, 1200);
    return;
  }
  setTimeout(()=>waitForCombat(then, waited + 1500), 1500);
}
