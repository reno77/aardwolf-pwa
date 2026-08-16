// learn.js -- record custom exits that are proven to work by using them.
//
// GMCP publishes only n/e/s/w/u/d. Everything else an area uses to move you --
// `enter portal`, `climb ladder`, `say yes`, `knock door`, `pull lever` -- is invisible
// to the client unless the Gaardian import happened to carry it. When it does not, the
// room is an island: `/goto` answers "no route to that room from here" for somewhere the
// player has personally walked to twice in the last five minutes.
//
// That is what happened at "At the Cristallium" in the Storm Ships of Lem-Dagor. The map
// note names the portal, `enter portal` works, and the client still had no edge for it
// afterwards -- because the only code that records a custom exit is the walker, and the
// walker only records exits it already knew about. A command typed by hand taught it
// nothing.
//
// So: remember the last command sent and the room it was sent from, and when the next
// room.info arrives somewhere new that no compass exit explains, write the edge down.
// This is the same evidence the walker uses -- the room changed after we sent this -- just
// no longer restricted to routes the map already had.

import { sqlDb } from './db.js';
import { appendOutput } from './ui.js';

/** The last command sent, and where from. Overwritten by each send, which is what makes
 *  the attribution safe: if anything else went out in between, the earlier command is no
 *  longer a candidate. */
let pending = null;

/** How long a command stays a plausible explanation for a room change. Generous enough
 *  for a laggy portal, short enough that an idle player being summoned is not blamed on
 *  whatever they last typed. */
const WINDOW_MS = 12000;

const COMPASS = /^(?:n|e|s|w|u|d|ne|nw|se|sw|north|east|south|west|up|down|northeast|northwest|southeast|southwest)$/i;

// Commands that either move you from ANYWHERE (so the edge is not a property of this
// room), land you somewhere unpredictable, or are not movement at all and would only be
// blamed for a room change something else caused.
//
// Deliberately NOT here: say, give, push, pull, touch, open, climb, jump, knock, ring.
// Those look like utility verbs but Aardwolf genuinely uses them as exits -- the Gaardian
// data has `say yes`, `give Texas conductor` and `climb ladder` as real type-7 exits --
// and those are exactly the ones worth learning.
const GLOBAL = /^(?:recall|rec|home|nexus|travel|goto|runto|rt|hunt|flee|kill|k|murder|c\s|cast|quit|enter)$/i;

/** Called for every outgoing command. `text` is a single command, never a sequence. */
export function noteSentCommand(text, fromUid){
  const cmd = String(text || '').trim();
  if(!cmd || !fromUid){ pending = null; return; }
  pending = { cmd, from: String(fromUid), at: Date.now() };
}

/**
 * A room change just happened. If the last typed command is the only thing that explains
 * it, and it is not something the map already knows, record it as an exit.
 */
export function learnExitFromMove(fromUid, toUid){
  const p = pending;
  pending = null;                       // one room change per command, at most
  if(!p || !fromUid || !toUid) return;
  if(String(fromUid) !== p.from) return;          // sent from somewhere else
  if(String(fromUid) === String(toUid)) return;   // did not actually move
  if(Date.now() - p.at > WINDOW_MS) return;

  const cmd = p.cmd;
  if(COMPASS.test(cmd)) return;                   // gmcp.js owns these
  if(GLOBAL.test(cmd)) return;
  if(cmd.startsWith('/')) return;                 // a client command, not a MUD one
  // A real exit command is short. Anything longer is far more likely to be a tell, a
  // channel line or a shop transaction that coincided with being moved.
  if(cmd.length > 30 || cmd.split(/\s+/).length > 3) return;
  try {
    // If a plain compass exit out of that room already leads here, the move was ordinary
    // and gmcp.js has it -- a mob's `push` or a mistyped word that happened to coincide
    // with a normal step must not be written down as an exit.
    const compass = sqlDb.exec(
      "SELECT dir FROM exits WHERE from_uid=? AND to_uid=? AND length(dir)<=2", [String(fromUid), String(toUid)]);
    if(compass.length && compass[0].values.length) return;

    const had = sqlDb.exec('SELECT to_uid FROM exits WHERE from_uid=? AND dir=?', [String(fromUid), cmd]);
    const known = had.length && had[0].values.length ? String(had[0].values[0][0]) : null;
    if(known === String(toUid)) return;           // already knew, say nothing
    sqlDb.run(`INSERT INTO exits(from_uid, dir, to_uid) VALUES (?,?,?)
      ON CONFLICT(from_uid, dir) DO UPDATE SET to_uid=excluded.to_uid`,
      [String(fromUid), cmd, String(toUid)]);
    // Worth saying out loud. A silently-learned edge changes where /goto will walk you
    // later, and the player should be able to see why.
    appendOutput('[map] learned "' + cmd + '" as an exit from here\n', 'system');
  } catch(e){ console.error(e); }
}
