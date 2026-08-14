// medic.js -- keep the character alive during a fight, without being asked.
//
// This exists because a character died in the Gladiator's Arena gauntlet while
// being healed by hand. The fight ran continuously; the healing arrived in
// bursts, whenever a human noticed. Between two checks health went 100% -> 37%
// -> 6%, and the potions that would have covered it were quaffed a second too
// late. Nothing about that is a judgement problem -- it is a latency problem,
// and the client already has the numbers as they arrive over GMCP.
//
// So: watch vitals, and act on a threshold the moment it is crossed.
//
//   below HEAL_AT  -- cast heal, which is cheap while there is mana
//   below QUAFF_AT -- drink a healing potion, which does not care about mana
//   below MANA_AT  -- drink a mana potion, so the heals keep coming
//
// The potion keywords are settable because they are shop items, not fixtures:
// `/medic clorox lotus` names the healing and mana potions to use.

import { charState, hpFraction, manaFraction, STATE_FIGHTING } from './gmcp.js';
import { sendCmd, sendCmdRaw } from './net.js';
import { onInterval } from './ticker.js';
import { appendOutput } from './ui.js';

const HEAL_AT  = 0.80;   // cast heal below this
const QUAFF_AT = 0.55;   // and drink below this, whatever the mana says
const MANA_AT  = 0.25;   // drink a mana potion below this

// One action per this many ms. Aardwolf ignores a second quaff in the same round
// anyway, and spamming the buffer is how a "quaff" lands after the killing blow.
const GAP_MS = 2500;

let watch = null;
let unsubscribe = null;

function say(msg, cls){ appendOutput('[medic] ' + msg + '\n', cls || 'system'); }

/** `/medic [heal-potion-keyword] [mana-potion-keyword]` */
export function startMedic(args){
  const parts = String(args || '').trim().split(/\s+/).filter(Boolean);
  if(/^(off|stop|no)$/i.test(parts[0] || '')){ stopMedic('asked to stop'); return; }
  // Several healing potions, tried in order. A run through the gauntlet needs more
  // healing than the 399-item cap allows of any one kind, and the way the last attempt
  // ended was three quaffs answering "You don't have that potion" at 6% health, with a
  // bag of perfectly good trivia potions unused because the medic only knew one word.
  // `/medic trivia,clorox lotus` drinks the trivia ones first and moves on when they run out.
  watch = {
    heals: (parts[0] || 'clorox').split(',').map(s => s.trim()).filter(Boolean),
    healIdx: 0,
    mana: parts[1] || 'lotus',
    last: 0, heals_cast: 0, quaffs: 0, manas: 0,
  };
  if(!unsubscribe) unsubscribe = onInterval(1000, tick);
  say('watching your health. heal below ' + Math.round(HEAL_AT*100)
      + '%, quaff ' + watch.heals.map(h => '"'+h+'"').join(' then ') + ' below '
      + Math.round(QUAFF_AT*100)
      + '%, drink "' + watch.mana + '" below ' + Math.round(MANA_AT*100) + '% mana.', 'quest');
  say('/medic off to stop.');
}

export function stopMedic(why){
  if(!watch) return;
  const w = watch;
  watch = null;
  if(unsubscribe){ unsubscribe(); unsubscribe = null; }
  say('stopped' + (why ? ' -- ' + why : '') + '. ' + w.heals_cast + ' heal(s), '
      + w.quaffs + ' potion(s), ' + w.manas + ' mana potion(s).', 'quest');
}

export function isMedicOn(){ return !!watch; }

/**
 * Feed MUD output here: notice a potion running out and move to the next kind.
 *
 * The alternative is discovering it at 6% health, which is where the last gauntlet run
 * ended -- three quaffs in a row answered "You don't have that potion" while the
 * character died holding a bag of other healing potions.
 */
export function parseMedicOutput(text){
  if(!watch) return;
  if(!/you (?:do not|don'?t) have that potion/i.test(String(text || ''))) return;
  if(watch.healIdx >= watch.heals.length - 1) return;      // nothing left to fall back to
  watch.healIdx++;
  say('out of "' + watch.heals[watch.healIdx - 1] + '" -- switching to "'
      + watch.heals[watch.healIdx] + '".', 'quest');
}

function tick(){
  if(!watch) return;
  const now = Date.now();
  if(now - watch.last < GAP_MS) return;
  const hp = hpFraction(), mana = manaFraction();

  // Potion first when it is serious: it works with an empty mana bar, and at this
  // point the question is not efficiency, it is whether the next round lands.
  if(hp < QUAFF_AT){
    watch.last = now; watch.quaffs++;
    sendCmdRaw('quaff ' + watch.heals[watch.healIdx]);
    return;
  }
  if(hp < HEAL_AT && mana > MANA_AT){
    watch.last = now; watch.heals_cast++;
    sendCmd('cast heal');
    return;
  }
  // Only top the mana up mid-fight, or while hurt. Standing at full health with a
  // half-empty bar is what resting is for.
  if(mana < MANA_AT && (charState === STATE_FIGHTING || hp < HEAL_AT)){
    watch.last = now; watch.manas++;
    sendCmdRaw('quaff ' + watch.mana);
    return;
  }
}
