// recast.js -- retry a spell that failed for lost concentration.
//
// A failed cast is not a decision, it is a dice roll: "You lost your concentration while
// trying to cast detect hidden." costs the mana and gives nothing back. Every spell this
// client depends on has hit it -- detect hidden before the hidden mobs it exists to reveal,
// pass door in front of a locked gate, invis before a room full of aggro shades -- and each
// time the player has to notice the line in a fast-scrolling combat log and type the cast
// again. That is exactly the gap the client should be covering.
//
// The message names the spell, so the retry can be exact. This cannot be a user trigger:
// processTriggers sends a fixed command string and has no capture-group substitution, so a
// trigger could only ever recast one hard-coded spell.

import { sendCmdRaw } from './net.js';
import { appendOutput } from './ui.js';

// "You lost your concentration while trying to cast detect hidden."
// Aardwolf also uses "You lost your concentration." with no spell named, which is not
// actionable -- there is nothing to retry -- so the spell name is required.
// The spell name may arrive bare ("cast invis.") or quoted ("cast 'pass door'."), so the
// quotes are optional and stripped rather than captured.
const LOST = /^You lost your concentration while trying to cast ['"]?([a-z][a-z -]{1,30}?)['"]?\.?\s*$/im;

// A spell that can never succeed here -- too low a level for it, a room that forbids it --
// would otherwise retry forever, burning mana and filling the buffer. Allow a small burst
// per spell and then stop, which is enough for a genuine run of bad luck and harmless when
// the cast is impossible.
const MAX_TRIES = 3;
const WINDOW_MS = 30000;
const tries = new Map();   // spell -> [timestamps]

let enabled = true;
export function setRecast(on){
  enabled = !!on;
  appendOutput('[recast] failed casts will ' + (enabled ? '' : 'NOT ') + 'be retried\n', 'system');
}
export function recastEnabled(){ return enabled; }

/** Called for every line of MUD output. */
export function parseConcentrationOutput(text){
  if(!enabled || !text) return false;
  const m = LOST.exec(String(text));
  if(!m) return false;
  const spell = m[1].trim().toLowerCase();
  if(!spell) return false;

  const now = Date.now();
  const recent = (tries.get(spell) || []).filter(t => now - t < WINDOW_MS);
  if(recent.length >= MAX_TRIES){
    appendOutput('[recast] "' + spell + '" failed ' + recent.length
      + ' times in a row -- not retrying (check level, mana or the room)\n', 'error');
    return true;
  }
  recent.push(now);
  tries.set(spell, recent);

  // Quote it: several spell names are two words, and `cast detect hidden` parses the
  // second word as a target.
  appendOutput('[recast] lost concentration on "' + spell + '"; casting again\n', 'system');
  sendCmdRaw("cast '" + spell + "'");
  return true;
}
