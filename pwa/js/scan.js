// scan.js -- see into the neighbouring rooms without walking into them.
//
// `scan` reports what is standing up to three rooms away in every direction, which
// is a far better search primitive than the one the helper had. Finding a mob used
// to mean walking room to room and probing each with `look <kw>`: fourteen rooms of
// budget, a real move every time, and every move a chance to walk into something
// aggressive. One `scan` covers the same ground for free.
//
// The reply is bracketed and the distance is in the heading, absent for one room:
//
//   {scan}
//   Right here you see:
//        - (Flying) A violet
//   North from here you see:
//        - A vine
//   3 East from here you see:
//        - A rose
//   {/scan}
//
// Captured live in the Keep of the Asherodan's garden. "Right here" is included so a
// caller can tell "it is in this room" from "it is two south".

import { sendCmdRaw } from './net.js';
import { appendOutput, stripAnsi } from './ui.js';

const HEAD = /^(?:(\d+)\s+)?(right here|north|south|east|west|up|down)\b[^:]*:\s*$/i;
const ITEM = /^-\s*(.+?)\s*$/;
const DIRS = {north:'n', south:'s', east:'e', west:'w', up:'u', down:'d', 'right here':'here'};
// For messages: "2 s" reads as a typo, "2 south" reads as an instruction.
const WORDS = {n:'north', s:'south', e:'east', w:'west', u:'up', d:'down', here:'here'};
export function dirWord(d){ return WORDS[d] || d; }

const SCAN_MS = 4000;
let pending = null;

/**
 * Run `scan` and hand the parsed result to `onResult`.
 *
 * The result is [{dir, dist, mobs:[names]}], nearest first, with dir 'here' for the
 * room we are standing in.
 */
export function scanNow(onResult, onFail){
  if(pending){ if(onFail) onFail('a scan is already running'); return false; }
  pending = {buf: '', onResult, onFail, timer: null};
  pending.timer = setTimeout(()=>{
    const p = pending; pending = null;
    if(p && p.onFail) p.onFail('no reply to scan');
  }, SCAN_MS);
  sendCmdRaw('scan');
  return true;
}

/** Feed MUD output here while a scan is outstanding. */
export function parseScanOutput(text){
  const p = pending;
  if(!p) return;
  p.buf += stripAnsi(text);
  if(!/\{\/scan\}/.test(p.buf)) return;
  clearTimeout(p.timer);
  pending = null;
  const block = (p.buf.match(/\{scan\}([\s\S]*?)\{\/scan\}/) || [, p.buf])[1];
  const out = [];
  let cur = null;
  for(const raw of block.split(/\r?\n/)){
    const line = raw.trim();
    if(!line) continue;
    const h = HEAD.exec(line);
    if(h){
      cur = {dir: DIRS[h[2].toLowerCase()] || h[2].toLowerCase(),
             dist: h[1] ? parseInt(h[1]) : (DIRS[h[2].toLowerCase()] === 'here' ? 0 : 1),
             mobs: []};
      out.push(cur);
      continue;
    }
    const it = ITEM.exec(line);
    if(it && cur) cur.mobs.push(it[1]);
  }
  out.sort((a, b) => a.dist - b.dist);
  if(p.onResult) p.onResult(out);
}

/**
 * Where is `mob`, according to one scan?
 *
 * `matches(name)` is the caller's own name test -- snd.js has mobMatches, which
 * handles "A giant" against "A giant guard" properly, and duplicating that here
 * would be a second answer to the same question. Nearest sighting wins.
 */
export function scanFor(matches, onFound, onNothing){
  return scanNow((rooms)=>{
    for(const r of rooms){
      const hit = r.mobs.find(m => { try { return matches(m); } catch(e){ return false; } });
      if(hit){
        appendOutput('[scan] '+hit+' is '
          + (r.dir === 'here' ? 'in this room' : r.dist+' '+r.dir)+'.\n','quest');
        onFound(r, hit);
        return;
      }
    }
    if(onNothing) onNothing('nothing matching within scan range');
  }, onNothing);
}
