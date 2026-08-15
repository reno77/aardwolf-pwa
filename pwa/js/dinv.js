// dinv.js -- inventory manager, modelled on Aardurel's aard_inventory MUSHclient
// plugin (command prefix "dinv"): https://github.com/Aardurel/aard-plugins
//
// It is built on Aardwolf's machine-readable inventory commands rather than on
// scraping the human-facing `inventory` display. Per 'help invdata':
//
//     Syntax: invdata (<container id>)
//             eqdata
//
//     {tag}
//     objectid,flags,itemname,level,type,unique,wear-loc,timer
//     ...
//     {endtag}
//
// where the tag is {invdata}, {eqdata} or {invdata <container-objectid>}.
//
// Everything here is user-initiated: it reports and it moves items you asked it
// to move. It deliberately does not act on its own -- see the note in snd.js
// about Aardwolf's botting policy.

import { sqlDb, persistDb } from './db.js';
import { sendCmdRaw } from './net.js';
import { effectiveLevel, charLevel, charTier } from './gmcp.js';
import { appendOutput, stripAnsi } from './ui.js';

// Item types, from 'help invdata'.
export const ITEM_TYPES = {
  1:'light', 2:'scroll', 3:'wand', 4:'stave', 5:'weapon', 6:'treasure', 7:'armor',
  8:'potion', 9:'furniture', 10:'trash', 11:'container', 12:'drink container',
  13:'key', 14:'food', 15:'boat', 16:'mob corpse', 17:'player corpse', 18:'fountain',
  19:'pill', 20:'portal', 21:'beacon', 22:'gift card', 23:'unused', 24:'raw material',
  25:'campfire', 26:'forge', 27:'runestone',
};

// Item flags, from 'help invdata'.
export const ITEM_FLAGS = {
  N:'nolocate', I:'invis', K:'kept', G:'glowing', M:'magical',
  C:'cursed', H:'humming', E:'envenomed', T:'tempered', W:'weakened',
};

export const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS items(
    objectid TEXT PRIMARY KEY,
    flags TEXT, name TEXT, level INTEGER, type INTEGER,
    unique_item INTEGER, wearloc INTEGER, timer INTEGER,
    location TEXT,           -- 'inv', 'eq', or a container's objectid
    updated TEXT);
  CREATE INDEX IF NOT EXISTS idx_items_name ON items(name);
  CREATE INDEX IF NOT EXISTS idx_items_loc  ON items(location);
`;

export function initInventory(){
  if(!sqlDb) return;
  sqlDb.run(SCHEMA_SQL);
  // Added after the first release; ALTER is the cheapest way to reach an
  // existing items table without discarding what has already been scanned.
  for(const col of ['wearslot TEXT', 'score INTEGER', 'scanned TEXT', 'seq INTEGER']){
    try { sqlDb.run('ALTER TABLE items ADD COLUMN ' + col); } catch(e){ /* already there */ }
  }
}

// -----------------------------------------------------------------------------
// invdetails: the game's own per-item data, including its own score
// -----------------------------------------------------------------------------
// Per 'help invdetails', and confirmed against live output:
//
//   {invdetails}
//   {invheader}objectid|level|itemtype|value|weight|wearloc|flags|owner|
//   fromclanname|timer|||itemscore
//   {statmod}Hit roll|15
//   {/invdetails}
//
// Unlike invdata, wearloc and itemtype are spelled out ('eyes', 'Armor'), and
// the trailing field is the score Aardwolf itself assigns the item -- which is
// a far better ranking key than anything we could infer from level alone.
const INVHEADER = /^\{invheader\}(.*)$/i;
// The game's refusal when the item is not in your hands or on your body.
const NOT_FOUND = /^Item (\d+) not found\.$/i;
let scanMisses = 0;

export function parseInvDetails(text){
  if(!sqlDb) return false;
  let hit = false;
  for(const raw of stripAnsi(String(text)).split(/\r?\n/)){
    if(NOT_FOUND.test(raw.trim())){ scanMisses++; continue; }
    const m = raw.trim().match(INVHEADER);
    if(!m) continue;
    const f = m[1].split('|');
    if(f.length < 7) continue;
    const objectid = f[0].trim();
    if(!/^\d+$/.test(objectid)) continue;
    const level = parseInt(f[1]) || 0;
    const wearslot = (f[5] || '').trim().toLowerCase();
    // itemscore is the last field; trailing separators leave empties after it.
    let score = 0;
    for(let i = f.length - 1; i >= 6; i--){
      const v = f[i].trim();
      if(/^\d+$/.test(v)) { score = parseInt(v); break; }
    }
    sqlDb.run(
      `UPDATE items SET wearslot=?, score=?, level=?, scanned=? WHERE objectid=?`,
      [wearslot, score, level, new Date().toISOString(), objectid]);
    hit = true;
  }
  if(hit) persistDb();
  return hit;
}

/** Aard-branded gear is generally the safe pick at equal score, so break ties toward it. */
export function isAardItem(name){ return /\baard(wolf)?\b/i.test(String(name || '')); }

/**
 * `dinv scan` -- ask the game for invdetails on every wearable item.
 * Paced, because this is one command per item and Aardwolf drops floods.
 */
export function dinvScan(opts){
  if(!sqlDb){ appendOutput('[dinv] no database\n','error'); return; }
  const all = !!(opts && opts.all);
  const here = !!(opts && opts.here);
  // Do NOT filter by item type for things you are carrying. Plenty of worn gear
  // is type 6 (treasure) rather than armour or weapon -- auras, bracers, a cow
  // bell -- and excluding those left their slots looking empty.
  const res = sqlDb.exec(
    `SELECT objectid, location, type FROM items
      WHERE type != 11` + (all ? '' : ' AND (scanned IS NULL OR score IS NULL)'));
  const rows = (res[0]?.values || []).map(r => ({id:r[0], loc:r[1], type:r[2]}));
  const carried = rows.filter(r => r.loc === 'inv' || r.loc === 'eq');
  // `invdetails` answers "Item <id> not found." for anything inside a container
  // -- confirmed live, and the reason stored gear had no wear slot or score and
  // was invisible to `dinv best`. The only way to ask about it is to take it out
  // and put it straight back. That is three commands per item, so restrict the
  // stored pass to types that can occupy a wear slot.
  const stored = here ? []
    : rows.filter(r => r.loc !== 'inv' && r.loc !== 'eq' && WEARABLE_TYPES.has(r.type));

  if(!carried.length && !stored.length){
    appendOutput('[dinv] nothing left to scan (try "dinv scan all")\n','system');
    return;
  }
  scanMisses = 0;
  let delay = 0;
  for(const r of carried){
    setTimeout(() => sendCmdRaw('invdetails ' + r.id), delay);
    delay += 450;
  }
  for(const r of stored){
    const id = r.id, box = r.loc;
    setTimeout(() => sendCmdRaw(`get ${id} ${box}`), delay);            delay += 400;
    setTimeout(() => sendCmdRaw('invdetails ' + id), delay);            delay += 400;
    setTimeout(() => sendCmdRaw(`put ${id} ${box}`), delay);            delay += 400;
  }
  const secs = Math.ceil(delay / 1000);
  appendOutput(`[dinv] scanning ${carried.length} carried`
    + (stored.length ? ` and ${stored.length} stored (taken out and put straight back)` : '')
    + ` -- about ${secs}s\n`, 'system');
  setTimeout(() => {
    appendOutput('[dinv] scan finished -- try "dinv best"\n','system');
    if(scanMisses) appendOutput(`[dinv] ${scanMisses} item(s) the game would not detail; "dinv build" then scan again\n`,'error');
  }, delay + 1200);
}

// Slots that hold more than one item at once. Confirmed against live eqdata +
// invdetails: two ears, two necks, two wrists, two fingers, three medals.
// Without this, a slot with one of its two places filled looked fully occupied,
// so a bare second wrist or ring was never offered anything.
// `wield:2` is dual wield -- the off-hand is for a second weapon, which is also
// why portals are excluded below. Drop it to 1 for a character without the skill.
const SLOT_CAPACITY = { ear:2, neck:2, wrist:2, finger:2, medal:3, wield:2 };
function capacityOf(slot){ return SLOT_CAPACITY[slot] || 1; }

// Item types that are never a sensible recommendation even though the game
// gives them a wear slot. A portal (type 20) is *held*, and holding one costs
// you the off-hand a second weapon needs.
const NEVER_RECOMMEND = new Set([20]);

// Every slot the game can fill. A slot you wear nothing in used to produce no
// output at all when none of your stored gear was low enough level to use --
// indistinguishable from the recommender being broken. Now it says so.
const ALL_SLOTS = ['light','eyes','ear','head','face','neck','back','medal','torso',
                   'body','arms','hands','wrist','finger','waist','legs','feet',
                   'shield','wield','second','hold','float','above'];

/**
 * `dinv best` -- the ideal loadout per wear slot from everything you own,
 * ranked by the game's own item score.
 */
export function dinvBest(){
  if(!sqlDb) return;
  const cap = effectiveLevel();
  const res = sqlDb.exec(
    `SELECT objectid,name,level,type,location,flags,wearslot,score
       FROM items WHERE score IS NOT NULL AND wearslot IS NOT NULL AND wearslot!=''`);
  const rows = (res[0]?.values || []).map(r => ({
    objectid:r[0], name:r[1], level:r[2], type:r[3], typeName:ITEM_TYPES[r[3]]||'?',
    location:r[4], flags:r[5], slot:r[6], score:r[7]||0,
  })).filter(i => !NEVER_RECOMMEND.has(i.type) || i.location === 'eq');
  if(!rows.length){ appendOutput('[dinv] no scanned items yet -- run "dinv scan"\n','system'); return; }

  const bySlot = {};
  for(const it of rows){ (bySlot[it.slot] = bySlot[it.slot] || []).push(it); }

  appendOutput(`[dinv] level ${charLevel} tier ${charTier} -> usable up to level ${cap}\n`,'system');
  const upgrades = [];
  let emptyFilled = 0;
  const bare = [];    // slots with a free place and nothing usable to put in it

  // Every slot the game has, not just the ones we happen to hold gear for, so
  // an empty slot is always accounted for one way or the other.
  const slots = [...new Set([...ALL_SLOTS, ...Object.keys(bySlot)])].sort((a, b) => {
    const free = s => capacityOf(s) - (bySlot[s]||[]).filter(i => i.location === 'eq').length;
    return (free(b) - free(a)) || a.localeCompare(b);   // emptiest first
  });

  for(const slot of slots){
    const held = bySlot[slot] || [];
    const room = capacityOf(slot);
    const worn = held.filter(i => i.location === 'eq')
                     .sort((a,b) => b.score - a.score);
    // Rank on the game's own score; prefer Aard gear only to break a tie.
    const usable = held
      .filter(i => i.level <= cap)
      .sort((a,b) => (b.score - a.score) || (isAardItem(b.name) - isAardItem(a.name)) || (b.level - a.level));

    // Aard-branded gear you are already wearing is sticky: nothing displaces it
    // except another Aard piece of a HIGHER LEVEL, however well the game scores
    // the alternative. Aard gear does not fade or break, which makes a raw score
    // comparison the wrong call for it.
    const forced = [];
    for(const w of worn){
      if(!isAardItem(w.name)) continue;
      const betterAard = usable
        .filter(c => c.objectid !== w.objectid && isAardItem(c.name) && c.level > w.level)
        .sort((a,b) => (b.level - a.level) || (b.score - a.score))[0];
      const pick = betterAard || w;
      if(!forced.some(f => f.objectid === pick.objectid)) forced.push(pick);
    }

    // The rest of the slot is the top-scoring usable pieces -- which is what
    // makes a two-wrist or three-medal slot work: a slot with one place filled
    // still has a place to fill.
    const want = forced.slice(0, room);
    for(const c of usable){
      if(want.length >= room) break;
      if(want.some(x => x.objectid === c.objectid)) continue;
      want.push(c);
    }
    const wantIds = new Set(want.map(i => i.objectid));
    // Worn pieces the ideal loadout does not include, worst first: those are
    // what comes off, paired against what goes on.
    const displaced = worn.filter(i => !wantIds.has(i.objectid)).reverse();
    const toWear = want.filter(i => i.location !== 'eq');

    if(!held.length){
      bare.push(`${slot} (nothing scanned that fits it)`);
      continue;
    }
    if(!usable.length){
      const best = held.slice().sort((a,b) => a.level - b.level)[0];
      bare.push(`${slot} (lowest you own is level ${best.level}, you can use ${cap})`);
      continue;
    }

    let d = 0;
    for(const it of toWear){
      const off = displaced[d++] || null;
      upgrades.push({slot, best: it, worn: off});
      if(!off) emptyFilled++;
      appendOutput(`  ${slot.padEnd(8)} ${String(it.score).padStart(4)}  ${it.name}`
        + (isAardItem(it.name) ? ' [aard]' : '')
        + (off ? `   (replaces ${off.score} ${off.name}) **UPGRADE**`
               : '   (NOTHING WORN) **EMPTY SLOT**') + '\n', 'system');
    }
    // A slot that is already optimal but still has a free place is worth saying
    // out loud -- it is the case the old code hid completely.
    const free = room - worn.length - toWear.length;
    if(free > 0) bare.push(`${slot} (${free} free, nothing else usable to put there)`);
  }

  if(bare.length){
    appendOutput(`[dinv] ${bare.length} slot(s) with nothing to offer:\n`,'system');
    for(const b of bare) appendOutput('    ' + b + '\n','system');
  }
  if(upgrades.length){
    const swaps = upgrades.length - emptyFilled;
    appendOutput(`[dinv] ${upgrades.length} recommendation(s)`
      + (emptyFilled ? ` -- ${emptyFilled} empty slot(s) to fill` : '')
      + (emptyFilled && swaps ? `, ${swaps} upgrade(s)` : '')
      + `. "dinv swap" to wear them and stow what comes off.\n`, 'quest');
  } else {
    appendOutput('[dinv] you are already wearing the best of what you own.\n','system');
  }
  return upgrades;
}

// Refusals the game gives to get/wear/put. Confirmed live: `get <objectid>
// <containerid>` and `wear <objectid>` are both accepted, so when a swap "can't
// find" an item the reason is one of these -- and it used to scroll past in raw
// MUD text with nothing tying it back to the item dinv had asked for.
const REFUSALS = [
  /^You do not have that item/i,
  /^You don't have that item/i,
  /^I see no .* here/i,
  /^You must be at least level (\d+) to use/i,
  /^You can't carry that many items/i,
  /^You can't carry that much weight/i,
  /^You are not carrying that/i,
  /^You can't let go of it/i,        // cursed: the old piece will not come off
  /^You cannot remove/i,
];

// What the in-flight swap asked for, so a refusal can be named.
let swapExpect = null;   // {items: Map(objectid -> {name, slot}), pending: Set, issues: []}

/** Feed MUD text here so a swap can report which item a refusal belongs to. */
export function dinvWatchText(text){
  if(!swapExpect) return;
  for(const raw of stripAnsi(String(text)).split(/\r?\n/)){
    const line = raw.trim();
    if(!line) continue;
    for(const re of REFUSALS){
      if(re.test(line)){ swapExpect.issues.push(line); break; }
    }
  }
}

/** `dinv swap` -- get + wear each upgrade, then file the displaced piece. */
export function dinvSwap(){
  const upgrades = dinvBest() || [];
  if(!upgrades.length) return;
  // Same reasoning as dinvSort: without a container to file into, everything the
  // swap takes off just piles up loose in your inventory.
  let b = getBindings();
  if(!Object.keys(b).length) b = autoBind();
  const missingBind = new Set();
  swapExpect = { items: new Map(), issues: [] };
  let delay = 0;
  for(const u of upgrades){
    // Re-read the location now instead of trusting the snapshot dinvBest built:
    // an earlier step in this same swap, or any invdata since the scan, may have
    // moved the item, and `get <id> <stale container>` just fails.
    const fresh = currentLocation(u.best.objectid) || u.best.location;
    const it = u.best;
    swapExpect.items.set(it.objectid, {name: it.name, slot: u.slot});
    if(fresh !== 'inv' && fresh !== 'eq'){
      setTimeout(() => sendCmdRaw(`get ${it.objectid} ${fresh}`), delay); delay += 350;
    }
    setTimeout(() => sendCmdRaw(`wear ${it.objectid}`), delay); delay += 350;
    if(u.worn){
      const slot = slotFor(u.worn);
      const target = b[slot];
      // Silently doing nothing here is why gear piled up loose in inventory.
      if(target){ setTimeout(() => sendCmdRaw(`put ${u.worn.objectid} ${target}`), delay); delay += 350; }
      else missingBind.add(slot);
    }
  }
  if(missingBind.size){
    appendOutput(`[dinv] no container bound for slot(s) ${[...missingBind].join(', ')}`
      + ` -- what comes off will stay loose in your inventory ("dinv bind <slot> <container>")\n`, 'error');
  }
  // Refresh, then say what actually ended up worn rather than assuming it did.
  setTimeout(() => {
    sendCmdRaw('eqdata');
    setTimeout(() => { sendCmdRaw('invdata'); setTimeout(reportSwap, 1500); }, 600);
  }, delay + 500);
  appendOutput(`[dinv] swapping ${upgrades.length} item(s), ~${Math.ceil(delay/1000)}s\n`,'quest');
}

function currentLocation(objectid){
  if(!sqlDb) return null;
  try {
    const r = sqlDb.exec('SELECT location FROM items WHERE objectid=?', [objectid]);
    return r.length && r[0].values.length ? r[0].values[0][0] : null;
  } catch(e){ return null; }
}

function reportSwap(){
  if(!swapExpect) return;
  const exp = swapExpect;
  swapExpect = null;
  const failed = [];
  for(const [objectid, info] of exp.items){
    const loc = currentLocation(objectid);
    if(loc !== 'eq') failed.push(`${info.slot}: ${info.name}` + (loc ? ` (still in ${describeLocation(loc)})` : ' (not found)'));
  }
  if(!failed.length){
    appendOutput('[dinv] all recommended items are now worn.\n','system');
  } else {
    appendOutput(`[dinv] ${failed.length} item(s) did not go on:\n`,'error');
    for(const f of failed) appendOutput('    ' + f + '\n','error');
    for(const msg of [...new Set(exp.issues)]) appendOutput('    game said: ' + msg + '\n','error');
  }
}

// Aardwolf colour codes look like @x123 / @R / @@ -- strip them for display and
// matching, but keep the raw name so we can still show it in colour later.
function cleanName(s){
  return stripAnsi(String(s||''))
    .replace(/@x\d{1,3}/g, '')
    .replace(/@[a-zA-Z]/g, '')
    .replace(/@@/g, '@')
    .trim();
}

// -----------------------------------------------------------------------------
// Collection
// -----------------------------------------------------------------------------
let collecting = null;   // {location, rows, done}
const pendingContainers = [];
// True between `dinv build` and the end of the last container listing. Rows not
// seen during that sweep are items we no longer hold, and get pruned at the end.
let rebuilding = false;
const STALE = '?stale';

const TAG_OPEN  = /^\{(invdata|eqdata)(?:\s+(\S+))?\}\s*$/i;
const TAG_CLOSE = /^\{\/(invdata|eqdata)\}\s*$/i;

/** `dinv build` -- rebuild the whole table from the game. */
export function buildInventory(){
  if(!sqlDb){ appendOutput('[dinv] no database\n','error'); return; }
  initInventory();
  // Do NOT delete: that threw away every invdetails score too, so a rebuild
  // silently cost you the scan. Park everything as stale instead; the sweep
  // below restores the location of anything still held, and prunes the rest.
  sqlDb.run('UPDATE items SET location=?', [STALE]);
  rebuilding = true;
  pendingContainers.length = 0;
  appendOutput('[dinv] reading equipment and inventory...\n','system');
  sendCmdRaw('eqdata');
  setTimeout(()=>sendCmdRaw('invdata'), 600);
}

/** Feed MUD output here. Returns true while it is consuming an invdata block. */
export function parseInvData(text){
  if(!sqlDb) return false;
  let consumed = false;
  for(const raw of stripAnsi(String(text)).split(/\r?\n/)){
    const line = raw.trim();
    if(!line) continue;

    const open = line.match(TAG_OPEN);
    if(open){
      const kind = open[1].toLowerCase();
      collecting = {location: kind === 'eqdata' ? 'eq' : (open[2] || 'inv'), rows: 0};
      consumed = true;
      continue;
    }
    if(TAG_CLOSE.test(line)){
      if(collecting){
        appendOutput(`[dinv] ${collecting.rows} item(s) in ${describeLocation(collecting.location)}\n`,'system');
        collecting = null;
        consumed = true;
        // Descend into any containers we just learned about.
        const next = pendingContainers.shift();
        if(next) setTimeout(()=>sendCmdRaw('invdata ' + next), 500);
        else {
          if(rebuilding){
            rebuilding = false;
            const gone = sqlDb.exec('SELECT COUNT(*) FROM items WHERE location=?', [STALE]);
            const n = gone.length ? gone[0].values[0][0] : 0;
            sqlDb.run('DELETE FROM items WHERE location=?', [STALE]);
            if(n) appendOutput(`[dinv] dropped ${n} item(s) you no longer hold\n`,'system');
          }
          persistDb(); renderInventory();
        }
      }
      continue;
    }
    if(!collecting) continue;

    // objectid,flags,itemname,level,type,unique,wear-loc,timer
    const f = line.split(',');
    if(f.length < 8) continue;
    const objectid = f[0].trim();
    if(!/^\d/.test(objectid)) continue;
    // The item name itself can contain commas, so take the fields from both ends.
    const flags = f[1].trim();
    const timer = f[f.length-1].trim();
    const wearloc = f[f.length-2].trim();
    const uniq = f[f.length-3].trim();
    const type = f[f.length-4].trim();
    const level = f[f.length-5].trim();
    const name = cleanName(f.slice(2, f.length-5).join(','));

    // UPSERT, not INSERT OR REPLACE. REPLACE deletes the whole row and inserts
    // a new one, so every column this statement does not name -- wearslot,
    // score, scanned -- came back NULL. Since `dinv swap` and `dinv sort` both
    // end by re-reading invdata, a scan was wiped moments after it finished and
    // `dinv best` went back to reporting "no scanned items yet" every time.
    sqlDb.run(
      `INSERT INTO items
         (objectid, flags, name, level, type, unique_item, wearloc, timer, location, updated)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(objectid) DO UPDATE SET
         flags=excluded.flags, name=excluded.name, level=excluded.level,
         type=excluded.type, unique_item=excluded.unique_item,
         wearloc=excluded.wearloc, timer=excluded.timer,
         location=excluded.location, updated=excluded.updated`,
      [objectid, flags, name, parseInt(level)||0, parseInt(type)||0,
       parseInt(uniq)||0, parseInt(wearloc), parseInt(timer)||0,
       collecting.location, new Date().toISOString()]);
    // invdata lists items in inventory order, which is what the MUD counts when
    // you type '2.backpack'. Keep that order so an ordinal can be resolved.
    try { sqlDb.run('UPDATE items SET seq=? WHERE objectid=?', [collecting.rows, objectid]); } catch(e){}
    collecting.rows++;
    consumed = true;

    // Recurse into containers so `dinv search` can see what is inside them.
    if(parseInt(type) === 11 && collecting.location === 'inv'){
      pendingContainers.push(objectid);
    }
  }
  return consumed;
}

function describeLocation(loc){
  if(loc === 'eq') return 'equipment';
  if(loc === 'inv') return 'inventory';
  const r = sqlDb.exec('SELECT name FROM items WHERE objectid=?', [loc]);
  return r.length && r[0].values.length ? `container "${r[0].values[0][0]}"` : `container ${loc}`;
}

// -----------------------------------------------------------------------------
// Queries
// -----------------------------------------------------------------------------
export function searchItems(query, opts){
  if(!sqlDb) return [];
  const limit = (opts && opts.limit) || 40;
  if(!query) {
    const r = sqlDb.exec('SELECT objectid,name,level,type,location,flags FROM items ORDER BY location,name LIMIT ?', [limit]);
    return rowsToItems(r);
  }
  // An all-digits query is an objectid.
  if(/^\d+$/.test(query)){
    return rowsToItems(sqlDb.exec(
      'SELECT objectid,name,level,type,location,flags FROM items WHERE objectid=?', [query]));
  }
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const where = terms.map(()=>'LOWER(name) LIKE ?').join(' AND ');
  // `containersOnly` matters when the query is going to be used as a PLACE to put
  // things. "aardwolf" matches both a Bag of Aardwolf and a Dagger of Aardwolf, and
  // the MUD picks by its own ordering -- `put all aardwolf` answered "The Dagger of
  // Aardwolf is not a container." and the transfer stalled. Binding to a dagger would
  // fail the same way later, quietly, one item at a time.
  const typeClause = (opts && opts.containersOnly) ? ' AND type=11' : '';
  return rowsToItems(sqlDb.exec(
    `SELECT objectid,name,level,type,location,flags FROM items
      WHERE ${where}${typeClause} ORDER BY level DESC, name LIMIT ?`,
    [...terms.map(t=>'%'+t+'%'), limit]));
}

function rowsToItems(res){
  return (res[0]?.values || []).map(r => ({
    objectid:r[0], name:r[1], level:r[2], type:r[3], typeName:ITEM_TYPES[r[3]]||'?',
    location:r[4], flags:r[5],
  }));
}

export function describeItem(it){
  const flags = (it.flags||'').split('').map(c=>ITEM_FLAGS[c]).filter(Boolean);
  return `${it.objectid}  ${it.name} (L${it.level} ${it.typeName}`
       + (flags.length ? ', ' + flags.join('/') : '') + `) [${describeLocation(it.location)}]`;
}

// -----------------------------------------------------------------------------
// Storage rules: which container each item belongs in
// -----------------------------------------------------------------------------
// Bands are upper bounds, so an item of exactly 40 goes to slot 1 and 41 to
// slot 2. Anything that is not armour or a weapon ignores level entirely and
// goes to the 'misc' container.
const ARMOUR = 7, WEAPON = 5;
// Types that can occupy a wear slot. Treasure (6) is in here because a lot of
// worn gear reports as treasure rather than armour -- auras, bracers, trinkets.
// Light (1) occupies the 'light' slot.
const WEARABLE_TYPES = new Set([1, 5, 6, 7]);
export const DEFAULT_BANDS = [
  { slot: '1', maxLevel: 40 },
  { slot: '2', maxLevel: 70 },
  { slot: '3', maxLevel: 130 },
  { slot: '4', maxLevel: 170 },
  { slot: '5', maxLevel: Infinity },
];

/** slot -> container objectid. Containers are named per character, so they are
 *  bound explicitly with `dinv bind` rather than guessed from their names. */
export function getBindings(){
  try { return JSON.parse(localStorage.getItem('dinv_bindings') || '{}'); }
  catch(e){ return {}; }
}
function setBindings(b){ localStorage.setItem('dinv_bindings', JSON.stringify(b)); }

/** Every band a stored item can be filed into, plus the catch-all. NOT the wear
 *  slots -- ALL_SLOTS above is those, and the two must not share a name. */
const BIND_SLOTS = ['1','2','3','4','5','misc'];

export function bindContainer(slot, query){
  slot = String(slot || '').toLowerCase();

  // `dinv bind all <container>` -- one container for everything.
  //
  // The five-backpack layout exists because five [Recruit] Leather Backpacks were the
  // storage on hand, and splitting by level band was the only way to fit. A single
  // Bag of Aardwolf holds 5,020 (against a backpack's 1,500), stores its contents at
  // 20% weight, and weighs -452 itself, so the bands stop earning their keep: one bag
  // is lighter, roomier and simpler than five. Pointing every slot at it keeps all the
  // banding machinery working unchanged -- sort, swap and bind all still file by slot,
  // they just happen to file to the same place.
  if(slot === 'all'){
    const q = String(query || '').trim();
    if(!q){ appendOutput('[dinv] usage: dinv bind all <container>\n','error'); return; }
    for(const s of BIND_SLOTS) bindContainer(s, q);
    appendOutput('[dinv] every slot now files into the same container\n','system');
    return;
  }

  if(!BIND_SLOTS.includes(slot)){
    appendOutput('[dinv] slot must be one of ' + ALL_SLOTS.join(', ') + ', or "all"\n','error');
    return;
  }
  const q = String(query || '').trim();
  if(!q){ appendOutput('[dinv] usage: dinv bind <1-5|misc> <container>\n','error'); return; }

  // Three ways to name a container, in order of preference:
  //   2478704308   an object id -- stable, never ambiguous
  //   2.backpack   Aardwolf's own ordinal syntax, passed through untouched
  //   leather      a name we look up in the item table
  // The first two are sent to the MUD verbatim; only the third needs resolving.
  let target, label;
  if(/^\d+$/.test(q)){
    target = q;
    const hit = searchItems(q, {limit:1})[0];
    label = hit ? hit.name : 'object ' + q;
  } else if(/^\d+\.\S/.test(q)){
    // '2.backpack' is positional: the MUD recounts it every time, so it
    // silently repoints if the packs come back in a different order -- which is
    // exactly what happens when you die and re-loot. Resolve it to the stable
    // object id NOW and store that instead.
    const [, nth, kw] = q.match(/^(\d+)\.(\S+)/);
    const hit = resolveOrdinal(parseInt(nth), kw);
    if(!hit){
      appendOutput(`[dinv] cannot resolve "${q}" -- run "dinv build" first, or bind by object id
`,'error');
      return;
    }
    target = hit.objectid;
    label = `${hit.name}  (was ${q} at bind time)`;
  } else {
    // Containers only. A name that also matches a weapon must never bind a slot to
    // something nothing can be put into: "aardwolf" matches both a Bag of Aardwolf and
    // a Dagger of Aardwolf, and picking the dagger fails one item at a time, quietly.
    const hit = searchItems(q, {limit:1, containersOnly:true})[0];
    if(!hit){
      appendOutput('[dinv] no CONTAINER matches "'+q+'" -- try an object id or 2.backpack.'
        + ' Names that also match a weapon (e.g. "aardwolf") are ignored here.\n','error');
      return;
    }
    target = hit.objectid;
    label = hit.name;
  }
  const b = getBindings();
  b[slot] = target;
  setBindings(b);
  appendOutput(`[dinv] slot ${slot} -> ${label} [${target}]\n`,'system');
}

/**
 * Choose containers for the level bands without being told which is which.
 *
 * Five identically-named backpacks cannot be told apart by name, so they are
 * taken in inventory order: first backpack -> band 1, second -> band 2, and so
 * on. A container whose name looks like a gem/misc bag is pulled out first and
 * used for `misc`.
 *
 * The order is only ever consulted HERE. What gets stored is the container's
 * objectid, so a later death-and-reloot that shuffles the packs does not
 * silently repoint an existing binding -- the same reason `dinv bind 2.backpack`
 * resolves the ordinal immediately. Re-run `dinv autobind force` to redo it.
 */
export function autoBind(opts){
  if(!sqlDb) return {};
  const force = !!(opts && opts.force);
  const quiet = !!(opts && opts.quiet);
  const b = getBindings();
  const res = sqlDb.exec(
    `SELECT objectid, name FROM items
      WHERE type=11 AND location='inv'
      ORDER BY COALESCE(seq, 999999), objectid`);
  const boxes = (res[0]?.values || []).map(r => ({objectid:String(r[0]), name:r[1]}));
  if(!boxes.length){
    appendOutput('[dinv] no containers in your inventory -- run "dinv build" first\n','error');
    return b;
  }

  // A gem/misc bag is identifiable by name, unlike the backpacks.
  const miscAt = boxes.findIndex(c => /\b(gem|gems|misc|junk|pouch|satchel)\b/i.test(c.name));
  const misc = miscAt >= 0 ? boxes.splice(miscAt, 1)[0] : null;

  // One big bag beats five small ones, so prefer it outright.
  //
  // A Bag of Aardwolf holds 5,020 where a [Recruit] Leather Backpack holds 1,500, keeps
  // its contents at 20% weight and weighs -452 itself. Once one is carried there is no
  // reason to spread gear across level bands at all -- so bind every band to it and
  // leave the packs empty. Recognised by name because the invdata feed does not report
  // container capacity; if that ever changes, prefer the largest instead.
  const big = boxes.find(c => /bag of aardwolf/i.test(c.name));
  if(big && (force || BIND_SLOTS.every(s => !b[s] || b[s] === big.objectid))){
    for(const s of DEFAULT_BANDS.map(x => x.slot)) b[s] = big.objectid;
    if(!b.misc || force) b.misc = misc ? misc.objectid : big.objectid;
    setBindings(b);
    if(!quiet){
      appendOutput(`[dinv] one container for everything: ${big.name} [${big.objectid}]\n`,'system');
      if(misc) appendOutput(`    misc still goes to ${misc.name} [${misc.objectid}]\n`,'system');
      appendOutput('[dinv] split it back up with "dinv bind <slot> <container>"\n','system');
    }
    return b;
  }

  const picked = [];
  const bands = DEFAULT_BANDS.map(x => x.slot);
  bands.forEach((slot, i) => {
    if(b[slot] && !force) return;              // never overwrite a deliberate bind
    if(!boxes[i]) return;
    b[slot] = boxes[i].objectid;
    picked.push([slot, boxes[i]]);
  });
  if(misc && (!b.misc || force)){ b.misc = misc.objectid; picked.push(['misc', misc]); }
  setBindings(b);

  if(!quiet || picked.length){
    if(picked.length){
      appendOutput('[dinv] chose containers automatically (inventory order):\n','system');
      let low = 1;
      const range = {};
      for(const band of DEFAULT_BANDS){
        range[band.slot] = band.maxLevel === Infinity ? `${low}+` : `${low}-${band.maxLevel}`;
        low = band.maxLevel + 1;
      }
      for(const [slot, box] of picked){
        const what = slot === 'misc' ? 'everything not armour/weapon' : 'level ' + range[slot];
        appendOutput(`    slot ${String(slot).padEnd(4)} ${what.padEnd(28)} ${box.name} [${box.objectid}]\n`,'system');
      }
      appendOutput('[dinv] override any of them with "dinv bind <slot> <container>"\n','system');
    }
    const short = bands.filter(s => !b[s]);
    if(short.length) appendOutput(`[dinv] not enough containers for slot(s) ${short.join(', ')} -- items for those bands stay loose\n`,'error');
    if(!b.misc) appendOutput('[dinv] no gem/misc bag recognised -- bind one with "dinv bind misc <container>"\n','error');
  }
  return b;
}

/** Resolve the MUD's `<n>.<keyword>` form against our own inventory ordering. */
export function resolveOrdinal(nth, keyword){
  if(!sqlDb || !nth || !keyword) return null;
  const res = sqlDb.exec(
    `SELECT objectid,name FROM items
      WHERE location='inv' AND LOWER(name) LIKE ?
      ORDER BY COALESCE(seq, 999999)`, ['%' + String(keyword).toLowerCase() + '%']);
  const rows = res[0]?.values || [];
  const row = rows[nth - 1];
  return row ? {objectid: row[0], name: row[1]} : null;
}

/** Which slot an item belongs in, by the rules above. */
export function slotFor(item){
  if(item.type !== ARMOUR && item.type !== WEAPON) return 'misc';
  for(const band of DEFAULT_BANDS) if(item.level <= band.maxLevel) return band.slot;
  return '5';
}

function describeBands(){
  let low = 1;
  const lines = DEFAULT_BANDS.map(b => {
    const range = b.maxLevel === Infinity ? `${low}+` : `${low}-${b.maxLevel}`;
    low = b.maxLevel + 1;
    return `  slot ${b.slot}: armour/weapons level ${range}`;
  });
  lines.push('  slot misc: everything that is not armour or a weapon');
  return lines.join('\n');
}

/**
 * `dinv sort` -- put carried items into the container their level band says.
 * Worn equipment is left alone; use `dinv stow` for that.
 */
export function dinvSort(opts){
  const dryRun = !!(opts && opts.dryRun);
  const items = searchItems('', {limit:2000}).filter(i => i.location === 'inv');
  if(!items.length){ appendOutput('[dinv] nothing loose in inventory (run "dinv build" first?)\n','system'); return; }

  // Requiring five `dinv bind` calls before sort would do anything was the real
  // reason it "did not put anything in the containers": with nothing bound it
  // had nowhere to file to, and said only "nothing to move". Pick the containers
  // itself, once, and say which it chose.
  let b = getBindings();
  if(!Object.keys(b).length) b = autoBind();

  const missing = new Set();
  const plan = [];
  for(const it of items){
    if(it.type === 11) continue;               // do not put containers inside containers
    const slot = slotFor(it);
    const target = b[slot];
    if(!target){ missing.add(slot); continue; }
    if(it.objectid === target) continue;
    plan.push({it, slot, target});
  }
  if(missing.size){
    appendOutput(`[dinv] no container bound for slot(s) ${[...missing].join(', ')} -- use "dinv bind <slot> <container>"\n`,'error');
  }
  if(!plan.length){
    appendOutput(`[dinv] nothing to move: all ${items.length} loose item(s) are already where the bands say`
      + (missing.size ? ', apart from the unbound slots above' : '') + '\n','system');
    return;
  }

  for(const p of plan){
    appendOutput(`  slot ${p.slot}  ${p.it.name} (L${p.it.level} ${p.it.typeName})\n`,'system');
  }
  // `dinv sort` is a preview by default -- filing your inventory is not something
  // to do by accident. Say so loudly: this is the single most common reason it
  // "does not put anything in the containers".
  if(dryRun){
    appendOutput(`[dinv] PREVIEW ONLY -- nothing has moved. ${plan.length} item(s) would move.\n`,'quest');
    appendOutput('[dinv] type "dinv sort go" to actually do it.\n','quest');
    return;
  }

  // Space the puts out: Aardwolf drops commands sent faster than it processes.
  let delay = 0;
  for(const p of plan){
    setTimeout(() => sendCmdRaw(`put ${p.it.objectid} ${p.target}`), delay);
    delay += 350;
  }
  setTimeout(() => { sendCmdRaw('invdata'); }, delay + 500);   // refresh the table
  appendOutput(`[dinv] moving ${plan.length} item(s), ~${Math.ceil(delay/1000)}s\n`,'system');
}

// -----------------------------------------------------------------------------
// Actions -- all of these are things the player explicitly asked for
// -----------------------------------------------------------------------------
export function dinvGet(query){
  const hits = searchItems(query, {limit:10});
  if(!hits.length){ appendOutput('[dinv] nothing matches "'+query+'"\n','error'); return; }
  for(const it of hits){
    if(it.location === 'inv' || it.location === 'eq') continue;
    sendCmdRaw(`get ${it.objectid} ${it.location}`);
  }
  appendOutput(`[dinv] getting ${hits.length} item(s)\n`,'system');
}

export function dinvPut(container, query){
  const hits = searchItems(query, {limit:10});
  if(!hits.length){ appendOutput('[dinv] nothing matches "'+query+'"\n','error'); return; }
  // Same three forms as `dinv bind`: object id, MUD ordinal, or a name.
  const target = /^\d+$/.test(container) || /^\d+\.\S/.test(container)
    ? container
    : (searchItems(container, {limit:1})[0] || {}).objectid;
  if(!target){ appendOutput('[dinv] no container matches "'+container+'"\n','error'); return; }
  for(const it of hits){
    if(it.objectid === target) continue;
    sendCmdRaw(`put ${it.objectid} ${target}`);
  }
  appendOutput(`[dinv] putting ${hits.length} item(s) into ${target}\n`,'system');
}

export function dinvWear(query){
  const hits = searchItems(query, {limit:5});
  if(!hits.length){ appendOutput('[dinv] nothing matches "'+query+'"\n','error'); return; }
  for(const it of hits) sendCmdRaw(`wear ${it.objectid}`);
}

/**
 * `dinv wearable` -- what you could put on right now.
 *
 * Aardwolf lets you wear items up to your level plus 10 per tier, so a tier 5
 * level 1 character can wear level 50 gear. That is exactly effectiveLevel().
 *
 * CAVEAT: invdata reports wear-loc as -1 for anything not currently worn, so
 * this cannot tell you which SLOT an unworn item occupies -- only that it is
 * armour or a weapon you are high enough to use. Ranking "best per slot"
 * needs an identify pass (see dinv.js notes).
 */
export function dinvWearable(){
  const cap = effectiveLevel();
  const all = searchItems('', {limit:2000});
  const worn = all.filter(i => i.location === 'eq');
  const cand = all
    .filter(i => i.location !== 'eq' && WEARABLE_TYPES.has(i.type))
    .filter(i => i.level <= cap)
    .sort((a,b) => b.level - a.level);

  appendOutput(`[dinv] level ${charLevel} tier ${charTier} -> you can wear up to level ${cap}\n`, 'system');
  if(!cand.length){
    appendOutput('[dinv] nothing stored that you can wear (run "dinv build" first?)\n', 'system');
    return;
  }

  const lowestWorn = worn.length ? Math.min(...worn.map(i => i.level)) : 0;
  let flagged = 0;
  for(const it of cand.slice(0, 30)){
    const better = it.level > lowestWorn ? '  <-- out-levels your weakest worn piece' : '';
    if(better) flagged++;
    appendOutput('  ' + describeItem(it) + better + '\n', 'system');
  }
  appendOutput(`[dinv] ${cand.length} wearable item(s); ${flagged} out-level your weakest worn piece.\n`, 'system');
  appendOutput('[dinv] level is only a proxy -- invdata exposes no stats, and no wear slot for stored items.\n', 'system');
}

// -----------------------------------------------------------------------------
// UI + command dispatch
// -----------------------------------------------------------------------------
export function renderInventory(){
  const list = document.getElementById('inv-list');
  if(!list) return;
  list.innerHTML = '';
  const q = (document.getElementById('inv-search')||{}).value || '';
  const items = searchItems(q, {limit:200});
  const header = document.createElement('div');
  header.style = 'background:var(--panel);padding:8px;border-radius:6px;margin-bottom:8px;font-size:12px;';
  header.textContent = items.length ? `${items.length} item(s)` : 'No items yet -- run "dinv build".';
  list.appendChild(header);
  for(const it of items){
    const el = document.createElement('div');
    el.className = 'item';
    el.textContent = describeItem(it);
    list.appendChild(el);
  }
}

const HELP = [
  'dinv build                 rebuild the item table from eqdata/invdata',
  'dinv search <query>        find items by name, or by object id',
  'dinv get <query>           get matching items out of their containers',
  'dinv put <container> <q>   put matching items into a container',
  'dinv wear <query>          wear matching items',
  'dinv containers            list containers and what is in them',
  'dinv wearable             what you can wear at your level + tier bonus',
  'dinv scan [all|here]      ask the game for each item score + wear slot.',
  '                          Stored gear is taken out and put straight back --',
  '                          invdetails cannot see inside a container. "here"',
  '                          skips that; "all" re-asks about everything.',
  'dinv best                 best loadout per slot, ranked by the game score',
  'dinv swap                 wear every upgrade and stow what comes off',
  'dinv bind <slot> <cont>   bind slot; id, name, or 2.backpack (resolved to an id)',
  'dinv bind all <cont>      one container for everything (e.g. a Bag of Aardwolf)',
  'dinv autobind [force]     pick containers automatically, in inventory order',
  'dinv bindings             show which container each band files into',
  'dinv bands                show the level bands',
  'dinv sort [go]            preview/do: file carried items by level band.',
  '                          Binds containers itself the first time if needed.',
  'dinv help                  this list',
].join('\n');

export function dinvCommand(args){
  const parts = String(args||'').trim().split(/\s+/).filter(Boolean);
  const sub = (parts.shift()||'help').toLowerCase();
  const rest = parts.join(' ');
  switch(sub){
    case 'build':   buildInventory(); return;
    case 'search': {
      const hits = searchItems(rest);
      if(!hits.length){ appendOutput('[dinv] no matches\n','system'); return; }
      for(const it of hits) appendOutput('  '+describeItem(it)+'\n','system');
      appendOutput(`[dinv] ${hits.length} match(es)\n`,'system');
      return;
    }
    case 'wearable': dinvWearable(); return;
    case 'scan':    dinvScan({all: /^all$/i.test(rest.trim()), here: /^here$/i.test(rest.trim())}); return;
    case 'best':    dinvBest(); return;
    case 'swap':
    case 'wearbest': dinvSwap(); return;
    case 'bind': { const p=rest.split(/\s+/); bindContainer(p.shift(), p.join(' ')); return; }
    case 'autobind': autoBind({force: /^force$/i.test(rest.trim())}); return;
    case 'bands':   appendOutput(describeBands()+'\n','system'); return;
    case 'bindings': {
      const b = getBindings();
      const keys = Object.keys(b);
      if(!keys.length){ appendOutput('[dinv] nothing bound -- "dinv autobind" picks containers for you\n','system'); return; }
      for(const k of ['1','2','3','4','5','misc']){
        if(!b[k]) continue;
        const hit = searchItems(b[k], {limit:1})[0];
        appendOutput(`    slot ${k.padEnd(4)} ${hit ? hit.name : '(not in inventory!)'} [${b[k]}]\n`,'system');
      }
      return;
    }
    case 'sort':    dinvSort({dryRun: !/^go$/i.test(rest.trim())}); return;
    case 'get':     dinvGet(rest); return;
    case 'wear':    dinvWear(rest); return;
    case 'put': {
      const p = rest.split(/\s+/);
      dinvPut(p.shift(), p.join(' '));
      return;
    }
    case 'containers': {
      const res = sqlDb ? sqlDb.exec(
        `SELECT c.objectid, c.name, (SELECT COUNT(*) FROM items i WHERE i.location=c.objectid)
           FROM items c WHERE c.type=11 ORDER BY c.name`) : [];
      const rows = res[0]?.values || [];
      if(!rows.length){ appendOutput('[dinv] no containers known -- run "dinv build"\n','system'); return; }
      for(const [id, name, n] of rows) appendOutput(`  ${id}  ${name} -- ${n} item(s)\n`,'system');
      return;
    }
    default:
      appendOutput(HELP+'\n','system');
  }
}
