// veil.js -- get behind a Veil of Stone, then do the dangerous thing.
//
// The Gladiator's Arena gauntlet has one room that cannot be survived by playing
// well. The Test of Speed holds eight Inexperienced Goblin Gladiators and every one
// of them strikes on the round you walk in: roughly 2,700 damage against a 3,256
// health bar, landing before any command you send can arrive. It killed this
// character three times from full health with sanctuary up. Potions cannot be drunk
// in time, strangle cannot be cast from outside the room, and the goblins see
// through invisibility.
//
// Veil of Stone answers it exactly:
//
//   Veil of stone will allow a Ninja to become temporarily immune to all
//   physical damage ... can be used in combat and are lagfree.
//
// The goblins' alpha strike is entirely physical, so immunity turns a lethal room
// into a free one. What makes it awkward to use by hand is the timing:
//
//   duration  ~25 seconds
//   recovery  ~1:54
//
// so the veil is up for well under a fifth of its cycle. Arriving at the door at a
// random moment and hoping is not a plan -- and the player's own `fado_t57` trigger
// re-casts `veil stone` the instant the recovery expires, which means the charge is
// usually spent standing in a corridor rather than at the door that needs it.
//
// `/veil <command>` closes that gap: it waits until the veil is actually up, and
// only then sends the command. `/veil enter hole` walks into the Test of Speed
// immune, every time, instead of 18% of the time.
//
// The MUD's four messages are the whole state machine:
//
//   You surround yourself with a veil of stone.              -- up
//   You feel more exposed without your veil.                 -- down
//   You are still recovering your Veil abilities (00:34).    -- refused, wait this long
//   ## You may now use your veil abilities.                  -- recovered
//
// Note the deliberate co-operation with fado_t57 rather than a fight with it: when
// the recovery expires that trigger casts, we see "You surround yourself" like any
// other cast, and we go. Whoever gets there first is fine, because the thing being
// waited on is the veil being UP, not this module having been the one to raise it.

import { sendCmd, sendCmdRaw } from './net.js';
import { onInterval } from './ticker.js';
import { appendOutput, stripAnsi } from './ui.js';

const UP       = /You surround yourself with a veil of stone\./i;
const DOWN     = /You feel more exposed without your veil\./i;
const RECOVER  = /You are still recovering your Veil abilities \((\d+):(\d+)\)/i;
const READY    = /You may now use your veil abilities\./i;

// Giving up matters: standing at the door of a room that kills you, forever, while
// the player believes a run is in progress is worse than saying so and stopping.
const MAX_WAIT_MS = 300000;   // five minutes covers two full recovery cycles

let active = false;    // is the veil up right now, as far as the MUD has told us
let pending = null;    // {cmd, until, dueAt}
let unsubscribe = null;

// The retry is driven by the shared ticker, NOT setTimeout.
//
// Chrome throttles timers in a hidden or background tab to about once a minute, and
// this client spends most of its life in exactly that state -- on a phone with the
// screen off, or behind another window. A `setTimeout(attempt, 67000)` to re-cast
// after a recovery simply does not run on time, and the symptom is the worst kind:
// the veil never goes up, the queued move never fires, and nothing reports an error.
// That is precisely what happened on the first attempt at the Test of Speed.
// grind.js and medic.js already hang off the ticker for the same reason.
function ensureTicking(){ if(!unsubscribe) unsubscribe = onInterval(1000, tick); }
function stopTicking(){ if(unsubscribe){ unsubscribe(); unsubscribe = null; } }

// Never cast more often than this, whatever else goes wrong. A belt-and-braces
// floor: if the recovery line ever stops being understood again, the failure should
// be "casts once every few seconds" and not "floods the MUD with a command per tick",
// which in a fight is a wasted round every round.
const MIN_GAP_MS = 4000;

function tick(){
  if(!pending){ stopTicking(); return; }
  if(pending.dueAt && Date.now() < pending.dueAt) return;
  if(pending.lastTry && Date.now() - pending.lastTry < MIN_GAP_MS) return;
  pending.dueAt = 0;
  attempt();
}

function say(msg, cls){ appendOutput('[veil] ' + msg + '\n', cls || 'system'); }

export function isVeiled(){ return active; }

/** `/veil [command]` -- wait for Veil of Stone, then send `command` (if given). */
export function startVeil(args){
  const cmd = String(args || '').trim();
  if(/^(off|stop|cancel)$/i.test(cmd)){ cancelVeil('asked to stop'); return; }
  cancelVeil(null);
  pending = { cmd, until: Date.now() + MAX_WAIT_MS, dueAt: 0, lastTry: 0 };
  ensureTicking();
  if(active){
    say('veil of stone is already up' + (cmd ? ' -- ' + cmd : '') + '.', 'quest');
    fire();
    return;
  }
  say(cmd ? 'waiting for veil of stone, then: ' + cmd : 'raising veil of stone.', 'quest');
  attempt();
}

export function cancelVeil(why){
  if(!pending) return;
  pending = null;
  stopTicking();
  if(why) say('cancelled -- ' + why + '.', 'error');
}

function attempt(){
  if(!pending) return;
  if(Date.now() > pending.until){
    const c = pending.cmd;
    pending = null;
    stopTicking();
    say('gave up waiting for the veil' + (c ? ' -- ' + c + ' NOT sent' : '') + '.', 'error');
    return;
  }
  pending.lastTry = Date.now();
  sendCmdRaw('veil stone');
}

function fire(){
  if(!pending) return;
  const cmd = pending.cmd;
  pending = null;
  stopTicking();
  if(!cmd) return;
  // No delay. The veil lasts about 25 seconds and the point of the whole exercise is
  // to be inside that window when the room's first round resolves.
  //
  // Semicolons matter here. Getting INTO the Test of Speed veiled is only half of it:
  // the room has to be left again before the veil expires, and the eight goblins do
  // not have to be killed to do it. A run died with the veil working perfectly --
  // every attack answering "is harmless to you" -- because `enter blood` and
  // `enter hole` were issued as two separate operator round trips and the immunity
  // ran out between them. `/veil enter blood; enter hole` puts both inside the one
  // window, which is the whole point of the command existing.
  if(cmd.includes(';')) sendCmd(cmd); else sendCmdRaw(cmd);
}

/**
 * Feed MUD output here.
 *
 * ANSI comes off FIRST. Aardwolf colours these lines, and the colour codes sit
 * between the words -- so the recovery pattern never matched, this module never
 * learned how long to wait, and it re-cast `veil stone` on every tick instead.
 * A recovering veil answered thirty times in a row while the countdown ran down
 * on its own. Every other parser in this client strips ANSI before matching;
 * this one did not.
 */
export function parseVeilOutput(text){
  const s = stripAnsi(String(text || ''));

  if(UP.test(s)){
    active = true;
    if(pending){ say('veil up -- going.', 'quest'); fire(); }
    return;
  }
  if(DOWN.test(s)){ active = false; return; }

  if(!pending) return;

  const m = s.match(RECOVER);
  if(m){
    // Recovery is still running, and the MUD just told us exactly how long is left.
    // Wait that out rather than retrying blindly -- a retry loop here is one wasted
    // command per round in rooms where a round is the difference.
    const secs = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    say('recovering, ' + secs + 's left -- waiting.');
    pending.dueAt = Date.now() + (secs + 2) * 1000;
    ensureTicking();
    return;
  }
  if(READY.test(s)){
    // fado_t57 casts on this line too. Let it: whoever casts, "You surround
    // yourself" is what actually releases us, so a double cast costs nothing.
    pending.dueAt = Date.now() + 600;
    ensureTicking();
    return;
  }
}
