// keyring.js -- know which keys we already have before going to get one.
//
// Aardwolf's keyring is a side list for keys, and the line in `help keyring` that
// matters to a walker is this one:
//
//   "Whenever you use a command such as 'unlock' that looks for a key, your
//    keyring will also be checked."
//
// So a key on the keyring opens its door with no help from us -- and the client had
// no idea what was on it. Watched live: a locked door in The Realm of the Hawklords
// sent the helper off to hunt a guard for a mine key, which is a long errand and
// which failed ("lost track of one guard"), without ever asking whether the key was
// already in the pack.
//
// `keyring data` is the scriptable form, one key per line:
//
//   {keyring}
//   3869350589,,a brass key,85,13,0,-1,1114797
//   {/keyring}
//
// Field 3 is the name, which is what door records name too. The last field is an
// expiry timer -- keys rot, which is why aardGigel's Keyring-Manager exists to prune
// them; that is housekeeping and deliberately not done here.

import { sendCmd, sendCmdRaw } from './net.js';
import { appendOutput, stripAnsi } from './ui.js';

let keys = [];          // names, lower case
let fetchedAt = 0;
let waiting = null;
const FRESH_MS = 120000;

/** Names currently on the keyring, as the game last reported them. */
export function keyringKeys(){ return keys.slice(); }

/**
 * Is this key on the keyring?
 *
 * Matched loosely: door records say "a mine key" and the keyring says "a mine key",
 * but nothing guarantees the articles agree, so compare on the significant words.
 */
export function haveKey(keyName){
  const want = words(keyName);
  if(!want.length) return false;
  return keys.some(k => {
    const have = words(k);
    return want.every(w => have.includes(w));
  });
}

function words(s){
  return String(s || '').toLowerCase().match(/[a-z0-9]+/g)?.filter(w =>
    !['a','an','the','of','to'].includes(w)) || [];
}

/** Ask the game what is on the keyring. `onDone` gets the list. */
export function refreshKeyring(onDone){
  if(Date.now() - fetchedAt < FRESH_MS){ if(onDone) onDone(keys.slice()); return false; }
  if(waiting){ if(onDone) waiting.also.push(onDone); return false; }
  waiting = {buf: '', also: onDone ? [onDone] : [], timer: null};
  waiting.timer = setTimeout(()=>{
    const w = waiting; waiting = null;
    if(w) for(const f of w.also) f(keys.slice());
  }, 4000);
  sendCmdRaw('keyring data');
  return true;
}

/** Feed MUD output here; picks up the {keyring} block whenever one arrives. */
export function parseKeyringOutput(text){
  const clean = stripAnsi(text);
  if(waiting){
    waiting.buf += clean;
    if(!/\{\/keyring\}/.test(waiting.buf)) return;
    const w = waiting; waiting = null;
    clearTimeout(w.timer);
    absorb(w.buf);
    for(const f of w.also) f(keys.slice());
    return;
  }
  // Unprompted -- the player typed it themselves. Still worth reading.
  if(/\{keyring\}[\s\S]*\{\/keyring\}/.test(clean)) absorb(clean);
}

function absorb(buf){
  const block = (buf.match(/\{keyring\}([\s\S]*?)\{\/keyring\}/) || [, ''])[1];
  const found = [];
  for(const line of block.split(/\r?\n/)){
    const cols = line.trim().split(',');
    if(cols.length < 4) continue;
    const name = (cols[2] || '').trim();
    if(name) found.push(name.toLowerCase());
  }
  keys = found;
  fetchedAt = Date.now();
}

/**
 * Put every eligible key on the keyring.
 *
 * Called after a key has been fetched: it keeps the pack tidy, and it means the next
 * character-session finds the key without another errand. `keyring put all` is silent
 * about items it will not take, which is what we want here.
 */
export function stowKeys(){
  sendCmd('keyring put all');
  fetchedAt = 0;                 // the list has changed
}

/** `/keyring` -- show what the game says, and refresh our copy. */
export function showKeyring(){
  refreshKeyring((list)=>{
    if(!list.length){ appendOutput('[keyring] empty. `keyring put all` puts your keys on it.\n','system'); return; }
    appendOutput('[keyring] '+list.length+' key(s):\n','system');
    for(const k of list) appendOutput('          '+k+'\n','system');
  });
  fetchedAt = 0;
}
