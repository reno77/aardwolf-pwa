// areas.js -- area names, Aardwolf `runto` keywords, level locks, no-go list.
//
// The old code derived a runto keyword by taking the first word of the area
// name and truncating it to five characters, with no table and no validation.
// Measured against the 269 areas in gaardian_maps.db, 54 of them (20%) collide:
//   'land'  -> Land of Legend / The Land of the Beer Goblins / The Land of Oz
//   'dark'  -> Dark Elf Stronghold / The Dark Temple of Zyian / The Dark Continent
//   'a'     -> A Magical Hodgepodge / A Peaceful Giant Village / A Bad Trip
// Nothing parsed the reply either, so a wrong or rejected `rt` just left the
// character in the wrong area while the helper carried on to `where` -- which
// on Aardwolf only works inside the target area. That is the "stuck" loop.
//
// The game itself is the authority, so `areas 1 299 keywords` is harvested into
// the `areas` table and used from then on. The heuristic remains only as a last
// resort, and now says so out loud.

import { sqlDb } from './db.js';
import { sendCmdRaw } from './net.js';
import { appendOutput, stripAnsi } from './ui.js';

// Areas that cannot be auto-navigated: no sensible entry point, or entry is
// gated on a quest/portal/level. Search-and-Destroy marks these start = "-1".
// Attempting them produces the retry loop the user sees, so refuse up front.
export const NO_GO = new Set([
  // mazes and puzzle areas
  'wolfmaze', 'inferno', 'transcend',
  // normally inaccessible
  'challenge', 'immhomes', 'lasertwo', 'limbo', 'lualand', 'midgaard',
  'oldclanone', 'oldclantwo', 'oldclanthr', 'oldclanfou', 'vault', 'warzone',
  // epic / special access
  'blackclaw', 'seaking',
  // closed clan halls
  'baal', 'hook', 'retri', 'rhabdo', 'rogues', 'xunti',
]);

// Minimal seed so the very first campaign is not helpless before the harvest
// runs. Everything else comes from the game.
const SEED = {
  'the grand city of aylor': 'aylor',
  'the continent of mesolar': 'mesolar',
  'the dark continent, abend': 'abend',
  'alagh, the blood lands': 'alagh',
  'the southern ocean': 'southern',
  'the uncharted oceans': 'uncharted',
  'gelidus': 'gelidus',
  'vidblain, the everdark': 'vidblain',
  'faerie tales': 'ft1',
  'faerie tales ii': 'ftii',
  "death's manor": 'manor',
  'aardwolf zoological park': 'zoo',
  "a genie's last wish": 'geniewish',
  'a magical hodgepodge': 'hodgepodge',
  'a bad trip': 'badtrip',
  'aardwolf birthday area': 'birthday',
};

let harvesting = false;
let harvestRows = 0;

export function seedAreas(){
  if(!sqlDb) return;
  for(const [name, key] of Object.entries(SEED)){
    sqlDb.run(`INSERT OR IGNORE INTO areas(name, key, nogo) VALUES (?,?,?)`,
      [name, key, NO_GO.has(key) ? 1 : 0]);
  }
}

/** Ask the MUD for the authoritative keyword list. Safe to call repeatedly. */
let harvestTimer = null;
export function harvestAreaKeywords(){
  if(harvesting) return;
  harvesting = true;
  harvestRows = 0;
  appendOutput('[areas] requesting keyword list from the game...\n','system');
  sendCmdRaw('areas 1 299 keywords');
  // Stop consuming output even if the closing line never arrives.
  if(harvestTimer) clearTimeout(harvestTimer);
  harvestTimer = setTimeout(() => {
    if(!harvesting) return;
    harvesting = false;
    appendOutput(`[areas] listing ended early; learned ${harvestRows} keywords\n`,'system');
  }, 30000);
}

// Aardwolf prints:  From   To  Lock  Keyword          Area Name
const AREA_ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)?\s+?([0-9a-z]+?)\s+([A-Z].+?)\s*$/;
const AREA_END = /^'Lock' means you cannot enter until you are that level/i;
// The listing is ~300 rows, so the game pages it. Answering 'A' (All) turns the
// rest of it loose; without this only the first screen is ever learned.
const PAGING = /\[ Paging : \(Enter\)/i;

/** Feed MUD output here; returns true while it is consuming the listing. */
export function parseAreasOutput(text){
  if(!harvesting || !sqlDb) return false;
  for(const raw of stripAnsi(text).split(/\r?\n/)){
    if(PAGING.test(raw)){ sendCmdRaw('A'); continue; }
    if(AREA_END.test(raw)){
      harvesting = false;
      if(harvestTimer){ clearTimeout(harvestTimer); harvestTimer = null; }
      appendOutput(`[areas] learned ${harvestRows} area keywords\n`,'system');
      return true;
    }
    const m = raw.match(AREA_ROW);
    if(!m) continue;
    const [, minlvl, maxlvl, lock, key, name] = m;
    const lname = name.trim().toLowerCase();
    sqlDb.run(
      `INSERT INTO areas(name, key, minlvl, maxlvl, lock, nogo) VALUES (?,?,?,?,?,?)
         ON CONFLICT(name) DO UPDATE SET key=excluded.key, minlvl=excluded.minlvl,
           maxlvl=excluded.maxlvl, lock=excluded.lock, nogo=excluded.nogo`,
      [lname, key, parseInt(minlvl)||0, parseInt(maxlvl)||0,
       parseInt(lock)||0, NO_GO.has(key) ? 1 : 0]);
    harvestRows++;
  }
  return harvesting;
}

/**
 * Look up an area by full name.
 * Returns {key, lock, nogo, name, guessed} or null.
 */
export function lookupArea(areaName){
  if(!sqlDb || !areaName) return null;
  const n = stripAnsi(String(areaName)).trim().toLowerCase();
  if(!n) return null;
  for(const [sql, params] of [
    ['SELECT name,key,lock,nogo FROM areas WHERE name=?', [n]],
    ['SELECT name,key,lock,nogo FROM areas WHERE key=?', [n]],
    ['SELECT name,key,lock,nogo FROM areas WHERE name LIKE ? ORDER BY length(name) LIMIT 1', ['%'+n+'%']],
  ]){
    const r = sqlDb.exec(sql, params);
    if(r.length && r[0].values.length){
      const [name, key, lock, nogo] = r[0].values[0];
      return {name, key, lock: lock||0, nogo: !!nogo, guessed: false};
    }
  }
  // Last resort. Aardwolf's keyword is the display name with the spaces squeezed
  // out ('Earth Plane 4' -> 'earthplane', 'The Land of Oz' -> 'landofoz'), NOT
  // its first word truncated to five characters -- that produced `rt earth`,
  // which the game rejects. Try the squashed forms first and keep the old
  // first-word guess only as a final fallback.
  const bare = n.replace(/^the\s+/, '');
  const squashed = bare.replace(/[^a-z0-9]/g, '');
  const candidates = [
    squashed.replace(/\d+$/, ''),   // 'earthplane4' -> 'earthplane'
    squashed,
    bare.replace(/\s+.*/, '').replace(/[^a-z0-9]/g, ''),
    bare.replace(/\s+.*/, '').replace(/[^a-z0-9]/g, '').slice(0, 5),
  ].filter(k => k && k.length >= 3);
  const guess = candidates[0];
  return guess ? {name: n, key: guess, alts: candidates.slice(1), lock: 0,
                  nogo: NO_GO.has(guess), guessed: true} : null;
}

/** Kept for callers that only want the keyword string. */
export function areaRuntoKeyword(areaName){
  const a = lookupArea(areaName);
  return a ? a.key : '';
}

// -----------------------------------------------------------------------------
// runto result
// -----------------------------------------------------------------------------
// Nothing used to read the reply to `rt`, so a failure was indistinguishable
// from success and the helper carried on regardless.
const RUNTO_FAIL = [
  /^No such area/im,
  /^You cannot runto/im,
  /^Sorry, you cannot/im,
  /^There is no area/im,
  /^You must be in your recall room/im,
  /^You are not high enough level/im,
  /^Ambiguous area name/im,
  /^That area is locked/im,
];

export function runtoFailed(text){
  const clean = stripAnsi(text);
  return RUNTO_FAIL.some(re => re.test(clean));
}
