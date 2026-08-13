// roomord.js -- which copy in this room is the one we want?
//
// `kill` numbers the mobs in the ROOM that answer to a keyword: `kill 2.ironwood` is the
// second thing here matching `ironwood`. Nothing else shares that numbering -- `hunt` and
// `where` count across the whole area -- so an ordinal from anywhere else is a guess.
//
// Svrogan's Logging Camp is the case that forced this. Standing in "Wandering through the
// ironwoods" with the campaign's "A creaking Ironwood" in front of it, the helper sent a
// plain `kill ironwood` and killed a swaying Ironwood susurrant instead; the hunt trick had
// already named copy 8, which is an area ordinal and meant nothing to kill. Four of the
// campaign's fourteen targets were Ironwoods, all matching one keyword.
//
// So: look, take the mob list, count only the lines that answer to the keyword, and find
// the one whose NAME is the target. That position is the ordinal kill wants.

import { currentRoom } from './gmcp.js';
import { sendCmd } from './net.js';
import { lookLanded, roomContents } from './questtag.js';
import { appendOutput, stripAnsi } from './ui.js';

const SETTLE_MS = 700;
const HARD_MS = 6000;

let scan = null;

/**
 * `then(killArg)` gets "3.ironwood", or just the keyword when the room does not need an
 * ordinal -- or cannot supply one, in which case the caller's usual behaviour is right.
 */
export function findRoomOrdinal(mobName, kw, matches, then){
  if(scan){ clearTimeout(scan.timer); }
  scan = {kw, mobName, matches, then, buf: '', ts: Date.now(), timer: null};
  scan.timer = setTimeout(()=>finish('no reply to look'), HARD_MS);
  sendCmd('look');
}

/** Feed MUD output here while a room is being counted. */
export function parseRoomOrdinalOutput(text){
  const st = scan;
  if(!st) return;
  st.buf += stripAnsi(text);
  const start = st.buf.lastIndexOf('{rdesc}');
  if(start > 0) st.buf = st.buf.slice(start);
  if(!lookLanded(st.buf)) return;
  clearTimeout(st.timer);
  const left = HARD_MS - (Date.now() - st.ts);
  st.timer = setTimeout(()=>finish(), Math.max(50, Math.min(SETTLE_MS, left)));
}

function finish(why){
  const st = scan;
  if(!st) return;
  scan = null;
  clearTimeout(st.timer);
  const lines = roomContents(st.buf, currentRoom && currentRoom.name);
  const kw = String(st.kw || '').toLowerCase();
  // Only the lines kill would count: the ones that answer to the keyword.
  const counted = kw ? lines.filter(l => l.toLowerCase().includes(kw)) : lines;
  const ord = counted.findIndex(l => {
    try { return st.matches(l); } catch(e){ return false; }
  }) + 1;

  if(!ord){
    // Not identifiable by name here -- a long description that does not repeat it, or the
    // mob is not in this room at all. Hand back the plain keyword and let the caller's
    // ordinal walk and sweep do what they did before.
    if(why) appendOutput('[room] '+why+'; killing by keyword.\n','system');
    else if(counted.length > 1){
      appendOutput('[room] '+counted.length+' things here answer to "'+st.kw
        + '" and none of them reads as '+st.mobName+'; killing by keyword.\n','system');
    }
    st.then(st.kw);
    return;
  }
  if(counted.length > 1){
    appendOutput('[room] '+counted.length+' things here answer to "'+st.kw+'"; '
      + st.mobName+' is number '+ord+'.\n','quest');
  }
  st.then(ord > 1 ? ord + '.' + st.kw : st.kw);
}
