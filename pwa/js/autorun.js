// autorun.js -- work through a campaign without a person in the loop.
//
// Split out of snd.js, which had grown to 4500 lines: the campaign FSM, the key errands,
// the pool travel and this loop were all one file, and "where does the run decide to give
// up?" meant reading all of it.
//
// This module owns the DECISION to keep going: when to rest, when to skip a target, when to
// wait for a repop and come back, and when to stop. It owns no game knowledge -- how to
// find or kill anything belongs to snd.js, which it calls.
//
// Aardwolf's 'help policies7' names "read campaign information to automatically go to areas,
// find and kill mob" as botting, and a loop that walks target to target without a human in
// it is exactly that. It is off by default and only /xcpauto turns it on.

import { currentRoom, charState, hpFraction, manaFraction, movesFraction,
         STATE_FIGHTING } from './gmcp.js';
import { sendCmd, sendCmdRaw } from './net.js';
import { isWalking } from './nav.js';
import { campaignTargets, doCpCheck, liveTargets, sndState, xcpAbandonTarget,
         xcpByIndex, xcpNext, xcpRecall } from './snd.js';
import { onInterval } from './ticker.js';
import { appendOutput } from './ui.js';

// -----------------------------------------------------------------------------
// Running the campaign unattended (/xcpauto)
// -----------------------------------------------------------------------------
// Aardwolf's 'help policies7' names "read campaign information to automatically go
// to areas, find and kill mob" as botting, and a loop that walks target to target
// without a human in it is exactly that. It is off by default and only /xcpauto
// turns it on. What the loop does about it: it stops on anything it does not
// understand rather than thrashing, rests instead of fighting hurt, and gives up
// after AUTO_FAIL_LIMIT failures in a row.
// Consecutive abandoned targets before stopping. Three was too tight once skipping
// worked properly: a ten-target campaign can easily have three awkward ones in a row
// -- a ticket gate, a mob that had wandered, a room the map does not hold -- and
// stopping there left seven perfectly reachable targets untouched. A failure costs a
// recall and a walk; a kill resets the count.
const AUTO_FAIL_LIMIT = 5;
const AUTO_GAP_MS = 6000;       // pause between targets
const AUTO_PASSES = 2;           // times to re-try the targets it had to skip
const WANDER_RETRIES = 2;        // re-read cp check for a mob that moved
const AUTO_COOLDOWN_MS = 300000; // wait this long for repops, then try the campaign again
const AUTO_ROUNDS = 8;           // how many times to come back before giving up
const REST_BELOW = 0.75;        // rest before the next target below this health
const REST_UNTIL = 0.95;
const REST_MANA  = 0.4;         // ...or this much mana
const REST_MOVES = 0.25;        // ...or this much movement: at zero it cannot walk at all
const REST_TRIES = 40;          // ~5 minutes of ticks

export function setAutoRun(on){
  sndState.autoRun = !!on;
  sndState.autoFails = 0;
  sndState.autoPasses = 0;
  if(!sndState.autoRun){
    stopAutoWatch();
    if(sndState.autoCooldown){ clearTimeout(sndState.autoCooldown); sndState.autoCooldown = null; }
    sndState.autoRounds = 0;
    appendOutput('[S&D] auto-run off. /xcp runs one target at a time again.\n','system');
    return;
  }
  startAutoWatch();
  appendOutput('[S&D] auto-run ON: it will work through the campaign on its own,\n'
    + '      resting when hurt and stopping after '+AUTO_FAIL_LIMIT+' failures in a row.\n','system');
  appendOutput('[S&D] Aardwolf calls unattended campaign automation botting'
    + " ('help policies7'). /xcpstop ends it.\n",'error');
  // A fresh page has not read a `cp check` yet, so it does not know a campaign
  // exists -- /xcpauto answered "Not on a campaign" while one was running. Ask
  // first, then start: the whole point of this switch is that it needs no setup.
  if(sndState.cpType === 'none' || !campaignTargets.length){
    appendOutput('[S&D] reading the campaign first.\n','system');
    doCpCheck();
    setTimeout(()=>{
      if(!sndState.autoRun) return;
      if(!liveTargets().length){
        appendOutput('[S&D] no campaign targets to work through. `cp check` to see why.\n','error');
        sndState.autoRun = false;
        stopAutoWatch();
        return;
      }
      if(!sndState.pendingXcp) recoverThen(()=>xcpNext());
    }, 4000);
    return;
  }
  if(!sndState.pendingXcp) recoverThen(()=>xcpNext());
}

/** Rest to a fighting state before starting anything, then run `fn`. */
function recoverThen(fn, tries){
  const hp = hpFraction(), mana = manaFraction(), moves = movesFraction();
  // Once resting has started, rest properly: getting back to 75% and standing up
  // means the next fight starts a quarter down, and the fight after that starts
  // lower again. Only the decision to START resting uses the lower number.
  const need = tries ? REST_UNTIL : REST_BELOW;
  if(hp >= need && mana >= REST_MANA && moves >= REST_MOVES){
    sndState.autoResting = false;
    sndState.autoRestingSince = 0;
    sndState.autoRestMode = null;
    sndState.autoRestHere = false;
    if(tries) sendCmdRaw('stand');
    setTimeout(fn, tries ? 1500 : 0);
    return;
  }
  const n = (tries || 0) + 1;
  if(n > REST_TRIES){
    appendOutput('[S&D] still on '+Math.round(hp*100)+'% health after resting'
      + ' -- stopping the auto-run rather than walking into a fight.\n','error');
    sndState.autoRun = false;
    sndState.autoResting = false;
    sndState.autoRestMode = null;
    stopAutoWatch();
    return;
  }
  if(n === 1){
    appendOutput('[S&D] '+Math.round(hp*100)+'% health, '+Math.round(mana*100)
      + '% mana -- sleeping before the next target.\n','quest');
    sndState.autoResting = true;
    // Not HERE. The target we just gave up on left the character standing in A dark
    // wood, which has something aggressive in it, and sleeping there took health from
    // 76% DOWN to 69% -- the recovery was making things worse. Recall first: Aylor is
    // safe, and it is where the next target's runto has to start from anyway.
    if(!sndState.autoRestHere && !/^aylor$/i.test(String(currentRoom.area || ''))){
      appendOutput('[S&D] not resting here -- recalling somewhere safe first.\n','quest');
      sendCmdRaw('stand');
      xcpRecall(null, ()=>{
        setTimeout(()=>recoverThen(fn, 1), 2000);
      }, 0, (why)=>{
        appendOutput('[S&D] '+why+'; recovering where we stand instead.\n','error');
        sndState.autoRestHere = true;
        setTimeout(()=>recoverThen(fn, 1), 2000);
      });
      return;
    }
  }
  // Spend the mana. Sleeping in Aylor recovers about 2.5% of health a minute, so
  // getting from 77% to 95% is seven minutes of nothing -- longer than the recovery
  // budget, which then stopped the run for "still on 77% after resting". A heal is
  // ~257hp for ~35 mana, and the character stands there with 2389 of it: three casts
  // do what seven minutes of sleep does. Sleep is what happens once the mana is gone.
  if(mana > 0.25){
    if(sndState.autoRestMode !== 'heal'){
      sndState.autoRestMode = 'heal';
      appendOutput('[S&D] healing rather than waiting -- '+Math.round(mana*100)
        + '% mana to spend.\n','quest');
      sendCmdRaw('stand');
    }
    // Movement first when that is what is short. `cast refresh` restores moves the way
    // `cast heal` restores health, and it is the answer to the failure that stopped this run
    // dead: 37 movement points of 3129, every step refused, and a recovery that could only
    // sleep and wait. Health still wins when both are low -- walking somewhere hurt is worse
    // than waiting a tick longer.
    if(hp >= need && moves < REST_MOVES) sendCmd('cast refresh');
    else sendCmd('cast heal');
  } else if(sndState.autoRestMode !== 'sleep'){
    sndState.autoRestMode = 'sleep';
    appendOutput('[S&D] out of mana; sleeping the rest off.\n','quest');
    sendCmdRaw('sleep');
  }
  // Tell the watchdog this is deliberate. Without it the two fought each other: the
  // rest announced itself, the watchdog saw nothing running for 25s, called it a stall
  // and restarted the run, which rested again -- around and around at 55% health with
  // nine targets waiting.
  sndState.autoResting = true;
  setTimeout(()=>recoverThen(fn, n), 8000);
}

/**
 * Move to the next target on our own, if the player asked for that.
 *
 * `ok` marks a target that actually died, which resets the failure counter: three
 * failures in a row means something is wrong with the world or with us, while three
 * failures spread across ten kills is just a campaign with awkward targets in it.
 */
export function autoContinue(reason, ok){
  if(!sndState.autoRun) return false;
  // Whatever we were working on did not die, so take it off the list here.
  //
  // xcpAbandonTarget marks it, but half a dozen dead ends never reach that: the twin
  // sweep running out of rooms just prints "it has moved, or the room is not mapped"
  // and nulls the target. The run then picked the very same target back up -- watched
  // with Sylvaticus the elf, round and round the Bumper Cars while eight other targets
  // waited. Marking it in the ONE place that resumes covers every one of those paths.
  if(!ok && sndState.autoLastMob){
    const prev = campaignTargets.find(x => x.mob === sndState.autoLastMob && !x.is_dead);
    if(prev && !prev.skipped){
      // Try again from a FRESH `cp check` before giving up on it. The room in that
      // reply is where the mob is NOW, not where it started: across two readings the
      // earthworm moved from "Tunnel Trap" to "Above Treeline". So a target that was
      // "in none of the rooms called X" has usually just walked somewhere, and the
      // game will say where if asked again -- which is a much better answer than
      // skipping nine targets out of ten because they all wander.
      prev.wanderTries = (prev.wanderTries || 0) + 1;
      if(prev.wanderTries <= WANDER_RETRIES){
        appendOutput('[S&D] '+prev.mob+' was not where the campaign said'
          + ' -- re-reading cp check for where it is now ('
          + prev.wanderTries+'/'+WANDER_RETRIES+').\n','quest');
        doCpCheck();
        setTimeout(()=>{
          if(!sndState.autoRun) return;
          recoverThen(()=>xcpByIndex(prev.mob));
        }, 4500);
        return true;                       // not a failure yet
      }
      prev.skipped = reason || 'skipped';
      appendOutput('[S&D] leaving '+prev.mob+' for now ('+(reason||'no progress')+').\n','quest');
    }
  }
  if(ok) sndState.autoFails = 0;
  else if(++sndState.autoFails >= AUTO_FAIL_LIMIT){
    appendOutput('[S&D] '+AUTO_FAIL_LIMIT+' targets in a row went nowhere (last: '+reason
      + ').\n','error');
    sndState.autoRun = false;
    stopAutoWatch();
    // Not the end of the run, just the end of this attempt. Campaign mobs repop and
    // wandering ones come back, so after a run of failures the useful thing is to wait
    // and read the campaign again rather than stop for good: there is a week on the
    // timer and nothing else to do with it.
    sndState.autoRounds = (sndState.autoRounds || 0) + 1;
    if(sndState.autoRounds <= AUTO_ROUNDS){
      appendOutput('[S&D] waiting '+Math.round(AUTO_COOLDOWN_MS/60000)
        + ' minutes for repops, then trying again (round '+sndState.autoRounds
        + ' of '+AUTO_ROUNDS+'). /xcpstop to stop for good.\n','quest');
      // A DEADLINE, not just a timer. A hidden tab has its timers throttled to about
      // one a minute, and this one had not fired ten minutes after it was set; the
      // ticker-driven watch below honours the deadline whatever the page clock does.
      sndState.autoCooldownAt = Date.now() + AUTO_COOLDOWN_MS;
      sndState.autoCooldown = setTimeout(()=>resumeAfterCooldown(), AUTO_COOLDOWN_MS);
    } else {
      appendOutput('[S&D] '+AUTO_ROUNDS+' rounds and the campaign is still not finished;'
        + ' stopping. `cp check` for what is left.\n','error');
    }
    return false;
  }
  if(!liveTargets().length){
    // Everything left was skipped rather than killed. A skip is often temporary --
    // a mob that had not repopped, a route not learned yet -- so try the list again
    // before declaring the campaign as far as it goes.
    const skipped = campaignTargets.filter(x => !x.is_dead && x.skipped);
    if(skipped.length && (sndState.autoPasses||0) < AUTO_PASSES){
      sndState.autoPasses = (sndState.autoPasses||0) + 1;
      appendOutput('[S&D] nothing left but the '+skipped.length+' target(s) that failed;'
        + ' trying them again (pass '+sndState.autoPasses+' of '+AUTO_PASSES+').\n','quest');
      for(const s of skipped) s.skipped = null;
    } else {
      appendOutput('[S&D] auto-run finished: nothing left it can reach.'
        + ' `cp check` for what remains.\n','quest');
      sndState.autoRun = false;
      stopAutoWatch();
      return false;
    }
  }
  appendOutput('[S&D] auto-run: next target in '+Math.round(AUTO_GAP_MS/1000)+'s.\n','system');
  sndState.autoNextAt = Date.now() + AUTO_GAP_MS;
  setTimeout(()=>{
    sndState.autoNextAt = 0;
    if(!sndState.autoRun) return;
    recoverThen(()=>xcpNext());
  }, AUTO_GAP_MS);
  return true;
}

/** Start the next round, however we got here. */
function resumeAfterCooldown(){
  if(sndState.autoCooldown){ clearTimeout(sndState.autoCooldown); sndState.autoCooldown = null; }
  sndState.autoCooldownAt = 0;
  // Everything gets another chance: a skip was about a moment, not about the campaign.
  for(const x of campaignTargets){ if(!x.is_dead){ x.skipped = null; x.wanderTries = 0; } }
  setAutoRun(true);
}

// A watchdog rather than a chain at every dead end.
//
// Six places give up on a target by nulling pendingXcp and printing why -- the copy
// sweep running out, the walking sweep's room budget, the health gate failing to
// recover, a mid-fight bail, the twin sweep exhausting its rooms, the quest tag cap.
// Patching each one to also continue would mean six chances to miss the next one
// somebody adds. This notices that nothing is running and picks the campaign back
// up, which covers all of them and anything future.
const AUTO_WATCH_MS = 15000;
const AUTO_IDLE_MS  = 25000;
const AUTO_STALL_MS = 90000;   // a target assigned but nothing moving
const REST_HANG_MS  = 360000;  // a recovery that never finishes is a hang
let autoWatch = null;

function startAutoWatch(){
  if(autoWatch) return;
  // onInterval, not setInterval: this is the one loop that must keep time in a tab
  // nobody is looking at, because everything else recovers through it.
  autoWatch = onInterval(AUTO_WATCH_MS, ()=>{
    // An overdue cooldown means the page timer was starved. Honour the deadline.
    if(!sndState.autoRun && sndState.autoCooldownAt && Date.now() >= sndState.autoCooldownAt){
      appendOutput('[S&D] the wait is over; picking the campaign back up.\n','system');
      resumeAfterCooldown();
      return;
    }
    if(!sndState.autoRun){ stopAutoWatch(); return; }
    // Recovering on purpose -- but not forever. The flag that tells the watchdog to
    // leave a rest alone is also the flag that hid a hang: a pre-rest recall with no
    // failure path never called back, and the run sat in the tombs basement for ten
    // minutes with nothing watching it. A recovery that has not finished in
    // REST_HANG_MS is not a recovery.
    if(sndState.autoResting){
      sndState.autoIdleSince = 0;
      if(!sndState.autoRestingSince) sndState.autoRestingSince = Date.now();
      if(Date.now() - sndState.autoRestingSince < REST_HANG_MS) return;
      appendOutput('[S&D] recovery has been going for '+Math.round(REST_HANG_MS/60000)
        + ' minutes with nothing to show for it -- carrying on regardless.\n','error');
      sndState.autoResting = false;
      sndState.autoRestingSince = 0;
      sndState.autoRestMode = null;
      autoContinue('recovery hung', false);
      return;
    }
    sndState.autoRestingSince = 0;
    // A target still assigned is not proof anything is happening. Several failure
    // paths print a reason and leave pendingXcp set; the run then sits still with
    // a target it is not working on, which is indistinguishable from progress
    // unless you watch the room. So watch the room: no movement, no walk and no
    // fight for STALL_MS means it is not going to start on its own.
    if(sndState.pendingXcp){
      sndState.autoIdleSince = 0;
      const here = String(currentRoom.uid || '') + '|' + String(charState);
      if(here !== sndState.autoLastWhere || isWalking() || charState === STATE_FIGHTING){
        sndState.autoLastWhere = here;
        sndState.autoStillSince = Date.now();
        return;
      }
      if(!sndState.autoStillSince){ sndState.autoStillSince = Date.now(); return; }
      if(Date.now() - sndState.autoStillSince < AUTO_STALL_MS) return;
      sndState.autoStillSince = 0;
      const stuck = sndState.pendingXcp;
      appendOutput('[S&D] auto-run: '+(stuck.mob||'the target')+' has not moved anything for '
        + Math.round(AUTO_STALL_MS/1000)+'s -- giving up on it and carrying on.\n','error');
      xcpAbandonTarget(stuck, 'stalled');
      return;
    }
    sndState.autoStillSince = 0;
    if(sndState.autoNextAt && Date.now() < sndState.autoNextAt + AUTO_IDLE_MS) return;
    if(isWalking() || charState === STATE_FIGHTING){ sndState.autoIdleSince = 0; return; }
    if(!sndState.autoIdleSince){ sndState.autoIdleSince = Date.now(); return; }
    if(Date.now() - sndState.autoIdleSince < AUTO_IDLE_MS) return;
    sndState.autoIdleSince = 0;
    appendOutput('[S&D] auto-run: nothing has been running for '
      + Math.round(AUTO_IDLE_MS/1000)+'s -- picking the campaign back up.\n','system');
    autoContinue('the run stalled', false);
  });
}

function stopAutoWatch(){
  if(autoWatch){ autoWatch(); autoWatch = null; }   // onInterval returns an unsubscribe
  sndState.autoIdleSince = 0;
}
