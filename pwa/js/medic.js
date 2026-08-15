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
// `/medic clorox lotus` names the healing and mana potions to use. Prefix one with
// `eat:` when it is a pill rather than a potion -- `/medic eat:fugu viagra`.

import { charState, hpFraction, manaFraction, STATE_FIGHTING } from './gmcp.js';
import { sendCmd, sendCmdRaw } from './net.js';
import { onInterval } from './ticker.js';
import { appendOutput } from './ui.js';

const HEAL_AT  = 0.80;   // cast heal below this
const MANA_AT  = 0.25;   // drink a mana potion below this

// QUAFF_AT was 0.55, and that is too late in a room that hits hard.
//
// A cast heal restores ~276; a potion restores ~780-1050. In the Heart of the
// Vampires' Nest the incoming rate is roughly 1,500 a round, so waiting until 55%
// means starting the big heals with about 1,800 health left -- barely one round of
// buffer -- and from there casting cannot catch up. A run went 100% -> 16% in fifty
// seconds that way, then died. Starting the potions at 75% spends the same potions but
// keeps a full round more of margin, which is the difference between recovering and
// being overtaken.
// ...but 75% everywhere is its own mistake: in the ordinary rooms it spends a 1,048
// potion to undo ~800 of damage that a 276 cast would have covered several times over,
// and fourteen Salves were gone before the run reached the room that needed them. So
// this is the DEFAULT, not the law: `/medic <heals> <mana> <percent>` sets it per
// stretch -- low through the easy rooms, high before the Vampires' Nest.
const QUAFF_AT_DEFAULT = 0.60;

// Below this, stop pacing and heal on every single tick that the MUD will accept.
// Losing a potion to a wasted round is cheap; losing the run is not.
const PANIC_AT = 0.40;

// One action per this many ms. Aardwolf ignores a second quaff in the same round
// anyway, and spamming the buffer is how a "quaff" lands after the killing blow --
// but when health is falling this fast, being early beats being tidy.
const GAP_MS = 2500;
const PANIC_GAP_MS = 1100;

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
  // `eat:` says up front that this one is a pill. The medic can work that out on its
  // own from "You can only quaff potions." (see parseMedicOutput), but learning it
  // costs one wasted round, and the round it would waste is the one where health has
  // just crossed the quaff threshold mid-fight. Declaring it costs nothing.
  const declaredEat = new Set();
  const readItem = s => {
    const t = String(s).trim();
    const m = t.match(/^eat:(.+)$/i);
    if(m){ declaredEat.add(m[1].toLowerCase()); return m[1]; }
    return t;
  };
  // Third argument, if present, is the quaff threshold as a percentage.
  const pct = parseInt(parts[2] || '', 10);
  const quaffAt = (pct >= 1 && pct <= 99) ? pct / 100 : QUAFF_AT_DEFAULT;
  watch = {
    heals: (parts[0] || 'clorox').split(',').map(readItem).filter(Boolean),
    healIdx: 0,
    quaffAt,
    mana: readItem(parts[1] || 'lotus'),
    manaOut: false,          // set once the game says there are none left
    lastAction: null,
    lastItem: null,          // which keyword the last quaff/eat named
    eat: declaredEat,        // keywords that are pills, not potions
    last: 0, heals_cast: 0, quaffs: 0, manas: 0,
  };
  if(!unsubscribe) unsubscribe = onInterval(1000, tick);
  // Name the verb the medic will actually use, not "quaff" regardless. A banner that
  // says quaff for a declared pill reads as though the `eat:` prefix was ignored.
  const verb = it => watch.eat.has(String(it).toLowerCase()) ? 'eat' : 'quaff';
  say('watching your health. heal below ' + Math.round(HEAL_AT*100)
      + '%, ' + watch.heals.map(h => verb(h) + ' "'+h+'"').join(' then ') + ' below '
      + Math.round(watch.quaffAt*100)
      + '%, ' + verb(watch.mana) + ' "' + watch.mana + '" below '
      + Math.round(MANA_AT*100) + '% mana.', 'quest');
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
  const s = String(text || '');

  // A PILL is eaten, not quaffed, and the best healing in the game comes as pills:
  // {::(Fugu)::} carries four uses of level 201 'heal' where a Clorox potion carries
  // three of level 60. Quaffing one answers "You can only quaff potions." and wastes
  // the round -- so remember the refusal and use `eat` for that keyword from now on.
  // Learning it from the reply beats asking the player to declare it, because the
  // player buying a better potion should not also have to reconfigure the medic.
  if(/you can only quaff potions/i.test(s)){
    if(watch.lastItem && !watch.eat.has(watch.lastItem)){
      watch.eat.add(watch.lastItem);
      say('"' + watch.lastItem + '" is a pill -- eating it instead.', 'quest');
      watch.last = 0;        // retry immediately rather than losing the interval
    }
    return;
  }

  // "The magic in X is too strong for you." -- Aardwolf refuses an item whose level is
  // above the character's, however many you are carrying. This is NOT the same as
  // running out, and it is unrecoverable: retrying spends a round every time and the
  // answer never changes. Treat the item as exhausted and move to the next one.
  //
  // Worth being blunt about in the code, because it cost a gauntlet run: twelve
  // level-201 heal pills and seven level-201 mana potions were bought for a level 93
  // character on the reasoning that a higher item level means a stronger spell. It
  // does -- but only up to the level you can actually drink.
  if(/the magic in .* is too strong for you/i.test(s)){
    if(watch.lastAction === 'mana'){
      if(!watch.manaOut){
        watch.manaOut = true;
        say('"' + watch.mana + '" is too high level to drink -- no mana potions usable.', 'error');
      }
      return;
    }
    if(watch.healIdx >= watch.heals.length - 1){
      if(!watch.healsOut){
        watch.healsOut = true;
        say('"' + watch.heals[watch.healIdx] + '" is too high level to use, and it was the '
            + 'last one -- healing from spells only now.', 'error');
      }
      return;
    }
    watch.healIdx++;
    say('"' + watch.heals[watch.healIdx - 1] + '" is too high level to use -- switching to "'
        + watch.heals[watch.healIdx] + '".', 'quest');
    watch.last = 0;
    return;
  }

  if(!/you (?:do not|don'?t) have that potion/i.test(s)) return;
  // WHICH potion ran out decides what to do, so the answer is matched to the last
  // thing sent. Without that, an empty mana flask read as an empty healing flask and
  // the loop quaffed at nothing twenty times in a row -- one wasted command per round,
  // in rooms where a round is the difference.
  if(watch.lastAction === 'mana'){
    if(watch.manaOut) return;
    watch.manaOut = true;
    say('out of "' + watch.mana + '" -- no more mana potions, healing only from here.', 'quest');
    return;
  }
  if(watch.healIdx >= watch.heals.length - 1){
    if(!watch.healsOut){
      watch.healsOut = true;
      say('out of healing potions entirely -- you are on spells and luck now.', 'error');
    }
    return;
  }
  watch.healIdx++;
  say('out of "' + watch.heals[watch.healIdx - 1] + '" -- switching to "'
      + watch.heals[watch.healIdx] + '".', 'quest');
}

function tick(){
  if(!watch) return;
  const now = Date.now();
  const hp = hpFraction(), mana = manaFraction();
  // Pace normally, but drop the spacing once health is genuinely dangerous.
  if(now - watch.last < (hp < PANIC_AT ? PANIC_GAP_MS : GAP_MS)) return;

  // Potion first when it is serious: it works with an empty mana bar, and at this
  // point the question is not efficiency, it is whether the next round lands.
  //
  // But NOT when a spell would already cover the gap. A Salve of Seikenji restores
  // about 1,050 and costs 960 gold; `cast heal` restores about 250 and costs 35 mana,
  // and mana refills from a Cup that is worth ~20 casts. Spending the potion on a
  // few-hundred-point dent is pure waste, and while grinding -- where the damage per
  // room is small and constant -- it burns a whole belt of potions in minutes for
  // healing the spell was always going to do. So hold the potions back for when
  // casting genuinely cannot keep up: no mana, or health already dangerous.
  // "The spell can cope" = there is mana to cast with, and health is not yet in the
  // range where a 250-point heal is too slow to matter.
  const spellCanCope = mana > MANA_AT && hp >= PANIC_AT;
  if(hp < watch.quaffAt && !watch.healsOut && !spellCanCope){
    watch.last = now; watch.quaffs++; watch.lastAction = 'heal';
    drink(watch.heals[watch.healIdx]);
    return;
  }
  if(hp < HEAL_AT && mana > MANA_AT){
    watch.last = now; watch.heals_cast++;
    sendCmd('cast heal');
    return;
  }
  // Only top the mana up mid-fight, or while hurt. Standing at full health with a
  // half-empty bar is what resting is for.
  if(mana < MANA_AT && !watch.manaOut && (charState === STATE_FIGHTING || hp < HEAL_AT)){
    watch.last = now; watch.manas++; watch.lastAction = 'mana';
    drink(watch.mana);
    return;
  }
}

/** Take `item`, by whichever verb the MUD has told us this one answers to. */
function drink(item){
  watch.lastItem = String(item).toLowerCase();
  sendCmdRaw((watch.eat.has(watch.lastItem) ? 'eat ' : 'quaff ') + item);
}
