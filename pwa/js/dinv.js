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

export function parseInvDetails(text){
  if(!sqlDb) return false;
  let hit = false;
  for(const raw of stripAnsi(String(text)).split(/\r?\n/)){
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
  const onlyNew = !(opts && opts.all);
  // Do NOT filter by item type. Plenty of worn gear is type 6 (treasure) rather
  // than armour or weapon -- auras, bracers, a cow bell are all worn on your
  // character right now -- and excluding those left their slots looking empty
  // with nothing to recommend. Containers are the only thing worth skipping.
  const res = sqlDb.exec(
    `SELECT objectid FROM items
      WHERE type != 11` + (onlyNew ? ' AND (scanned IS NULL OR score IS NULL)' : ''));
  const ids = (res[0]?.values || []).map(r => r[0]);
  if(!ids.length){ appendOutput('[dinv] nothing left to scan (try "dinv scan all")\n','system'); return; }
  const secs = Math.ceil(ids.length * 0.45);
  appendOutput(`[dinv] asking the game about ${ids.length} item(s) -- about ${secs}s\n`,'system');
  let delay = 0;
  for(const id of ids){
    setTimeout(() => sendCmdRaw('invdetails ' + id), delay);
    delay += 450;
  }
  setTimeout(() => appendOutput('[dinv] scan finished -- try "dinv best"\n','system'), delay + 800);
}

/**
 * `dinv best` -- for each wear slot, the highest-scoring item you can use,
 * and whether it beats what you have on.
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
  }));
  if(!rows.length){ appendOutput('[dinv] no scanned items yet -- run "dinv scan"\n','system'); return; }

  const bySlot = {};
  for(const it of rows){ (bySlot[it.slot] = bySlot[it.slot] || []).push(it); }

  appendOutput(`[dinv] level ${charLevel} tier ${charTier} -> usable up to level ${cap}\n`,'system');
  const upgrades = [];
  let emptyFilled = 0;
  // Slots with nothing worn come first: an empty slot is a bigger win than
  // swapping a decent piece for a slightly better one, and it is easy to miss.
  const slots = Object.keys(bySlot).sort((a, b) => {
    const aEmpty = !bySlot[a].some(i => i.location === 'eq');
    const bEmpty = !bySlot[b].some(i => i.location === 'eq');
    return (bEmpty - aEmpty) || a.localeCompare(b);
  });
  for(const slot of slots){
    const worn = bySlot[slot].find(i => i.location === 'eq');
    const usable = bySlot[slot]
      .filter(i => i.level <= cap)
      // Rank on the game's own score; prefer Aard gear only to break a tie.
      .sort((a,b) => (b.score - a.score) || (isAardItem(b.name) - isAardItem(a.name)) || (b.level - a.level));
    const best = usable[0];
    if(!best) continue;
    const wornScore = worn ? worn.score : -1;
    const isEmpty = !worn;
    const mark = (!worn || best.objectid !== worn.objectid) && best.score > wornScore
      ? (isEmpty ? ' **EMPTY SLOT**' : ' **UPGRADE**') : '';
    if(mark){ upgrades.push({slot, best, worn}); if(isEmpty) emptyFilled++; }
    appendOutput(`  ${slot.padEnd(10)} ${String(best.score).padStart(4)}  ${best.name}`
      + (isAardItem(best.name) ? ' [aard]' : '')
      + (worn ? `   (worn: ${worn.score} ${worn.name})` : '   (NOTHING WORN)') + mark + '\n', 'system');
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

/** `dinv swap` -- get + wear each upgrade, then file the displaced piece. */
export function dinvSwap(){
  const upgrades = dinvBest() || [];
  if(!upgrades.length) return;
  const b = getBindings();
  let delay = 0;
  for(const u of upgrades){
    const it = u.best;
    if(it.location !== 'inv' && it.location !== 'eq'){
      setTimeout(() => sendCmdRaw(`get ${it.objectid} ${it.location}`), delay); delay += 350;
    }
    setTimeout(() => sendCmdRaw(`wear ${it.objectid}`), delay); delay += 350;
    if(u.worn){
      const target = b[slotFor(u.worn)];
      if(target){ setTimeout(() => sendCmdRaw(`put ${u.worn.objectid} ${target}`), delay); delay += 350; }
    }
  }
  setTimeout(() => { sendCmdRaw('eqdata'); setTimeout(()=>sendCmdRaw('invdata'), 600); }, delay + 500);
  appendOutput(`[dinv] swapping ${upgrades.length} item(s), ~${Math.ceil(delay/1000)}s\n`,'quest');
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

const TAG_OPEN  = /^\{(invdata|eqdata)(?:\s+(\S+))?\}\s*$/i;
const TAG_CLOSE = /^\{\/(invdata|eqdata)\}\s*$/i;

/** `dinv build` -- rebuild the whole table from the game. */
export function buildInventory(){
  if(!sqlDb){ appendOutput('[dinv] no database\n','error'); return; }
  initInventory();
  sqlDb.run('DELETE FROM items');
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
        else { persistDb(); renderInventory(); }
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

    sqlDb.run(
      `INSERT OR REPLACE INTO items
         (objectid, flags, name, level, type, unique_item, wearloc, timer, location, updated)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
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
  return rowsToItems(sqlDb.exec(
    `SELECT objectid,name,level,type,location,flags FROM items
      WHERE ${where} ORDER BY level DESC, name LIMIT ?`,
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

export function bindContainer(slot, query){
  slot = String(slot || '').toLowerCase();
  const valid = ['1','2','3','4','5','misc'];
  if(!valid.includes(slot)){
    appendOutput('[dinv] slot must be one of ' + valid.join(', ') + '\n','error');
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
    const hit = searchItems(q, {limit:1})[0];
    if(!hit){ appendOutput('[dinv] no container matches "'+q+'" -- try an object id or 2.backpack\n','error'); return; }
    target = hit.objectid;
    label = hit.name;
  }
  const b = getBindings();
  b[slot] = target;
  setBindings(b);
  appendOutput(`[dinv] slot ${slot} -> ${label} [${target}]\n`,'system');
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
  const b = getBindings();
  const items = searchItems('', {limit:2000}).filter(i => i.location === 'inv');
  if(!items.length){ appendOutput('[dinv] nothing loose in inventory (run "dinv build" first?)\n','system'); return; }

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
  if(!plan.length){ appendOutput('[dinv] nothing to move\n','system'); return; }

  for(const p of plan){
    appendOutput(`  slot ${p.slot}  ${p.it.name} (L${p.it.level} ${p.it.typeName})\n`,'system');
  }
  if(dryRun){ appendOutput(`[dinv] ${plan.length} item(s) would move. Run "dinv sort go" to do it.\n`,'system'); return; }

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
  'dinv scan [all]           ask the game for each item score + wear slot',
  'dinv best                 best item per slot, ranked by the game score',
  'dinv swap                 wear every upgrade and stow what comes off',
  'dinv bind <slot> <cont>   bind slot; id, name, or 2.backpack (resolved to an id)',
  'dinv sort [go]            preview/do: file carried items by level band',
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
    case 'scan':    dinvScan({all: /^all$/i.test(rest.trim())}); return;
    case 'best':    dinvBest(); return;
    case 'swap':
    case 'wearbest': dinvSwap(); return;
    case 'bind': { const p=rest.split(/\s+/); bindContainer(p.shift(), p.join(' ')); return; }
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
