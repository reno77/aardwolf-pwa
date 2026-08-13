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
import { currentRoom, hpFraction } from './gmcp.js';
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
];

function norm(s){ return String(s || '').trim().toLowerCase(); }

export function errandFor(area, item){
  const a = norm(area), i = norm(item);
  return RECIPES.find(r => norm(r.area) === a && (norm(r.item) === i
    || i.includes(norm(r.item)) || norm(r.item).includes(i))) || null;
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
      let d = 0;
      for(const c of recipe.cmds){ setTimeout(()=>sendCmd(c), d); d += 1200; }
      if(recipe.leaveAfter){
        setTimeout(()=>sendCmdRaw(recipe.leaveAfter), d);
        d += 1500;
      }
      setTimeout(done, d + 500);
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
