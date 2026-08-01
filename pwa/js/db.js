// db.js -- extracted from index.html

import { renderRooms } from './nav.js';
import { areaNameMatches, resolveAreaUid, resolveRoomsByName } from './snd.js';
import { commandMap } from './state.js';
import { seedAreas } from './areas.js';
import { initInventory } from './dinv.js';
import { appendOutput, renderTriggers } from './ui.js';
// --- state owned by this module ---
export let sqlDb=null; // Browser SQLite (live/discovered map)
export let fadoTriggers=[]; // populated from SQLite on init

// =============================================================================
// SQLITE INITIALIZATION
// =============================================================================
export let initSqlPromise = initSqlJs({ locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/${file}` });

// Swap in a database loaded from a file. `sqlDb` is owned by this module, so
// the assignment has to live here -- imported bindings are read-only.
export async function replaceDb(bytes){
  const SQL = await initSqlPromise;
  sqlDb = new SQL.Database(bytes);
  return sqlDb;
}

// Schema version. Bump when the shape below changes; initDb rebuilds the map
// tables on mismatch (they are re-derivable from the Gaardian DB and from
// walking, unlike aliases/triggers, which are migrated across).
export const SCHEMA_VERSION = 3;

// v3 rebuilds the map because v2 stored live-discovered rooms with the y axis
// mirrored (see BACK_FROM_NEIGHBOUR in gmcp.js) -- those coordinates cannot be
// corrected in place, only re-learned.
//
// v2 notes:
//  - exits.dir may be ANY command string, not just a compass letter. This is how
//    the Aardwolf mapper models custom exits too: `length(dir) > 1` means "send
//    this text verbatim" (e.g. 'enter portal', 'climb ladder', 'open n;n').
//  - PRIMARY KEY(from_uid, dir) makes INSERT OR REPLACE actually replace. The v1
//    table had an AUTOINCREMENT id and no unique constraint, so every room visit
//    appended a duplicate row and the graph grew without bound.
//  - Exits are strictly directed. v1 synthesised a reverse edge for every exit
//    with `{n:'s',...}[d] || d`, so 'enter portal' reversed to itself and the
//    client believed it could walk back through a one-way portal.
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS rooms(
    uid TEXT PRIMARY KEY, area TEXT, name TEXT, terrain TEXT, info TEXT,
    x INTEGER, y INTEGER, z INTEGER, exits TEXT,
    noportal INTEGER DEFAULT 0, norecall INTEGER DEFAULT 0,
    first_seen TEXT, last_visited TEXT);
  CREATE TABLE IF NOT EXISTS exits(
    from_uid TEXT NOT NULL,
    dir      TEXT NOT NULL,   -- 'n'..'d', or a literal command for custom exits
    to_uid   TEXT NOT NULL,
    level    INTEGER DEFAULT 0,   -- min level to use; 999 = never auto-path
    door     INTEGER DEFAULT 0,   -- 0 none, 1 door, 2 locked
    key_name TEXT,
    PRIMARY KEY(from_uid, dir));
  CREATE INDEX IF NOT EXISTS idx_exits_from ON exits(from_uid);
  CREATE INDEX IF NOT EXISTS idx_exits_to   ON exits(to_uid);
  CREATE INDEX IF NOT EXISTS idx_rooms_area ON rooms(area);
  CREATE TABLE IF NOT EXISTS aliases(name TEXT PRIMARY KEY, expansion TEXT);
  CREATE TABLE IF NOT EXISTS triggers(name TEXT PRIMARY KEY, enabled INTEGER, pattern TEXT, cmd TEXT, category TEXT);
  CREATE TABLE IF NOT EXISTS room_gaardian_map(
    aardwolf_uid TEXT PRIMARY KEY,
    gaardian_areaid INTEGER,
    gaardian_local_id INTEGER,
    gaardian_name TEXT,
    matched_at TEXT);
  CREATE TABLE IF NOT EXISTS areas(
    name TEXT PRIMARY KEY,   -- full area name, lowercased
    key TEXT,                -- Aardwolf area keyword, as used by 'runto'
    minlvl INTEGER, maxlvl INTEGER,
    lock INTEGER DEFAULT 0,  -- cannot enter below this level
    nogo INTEGER DEFAULT 0); -- refuse to auto-navigate here
  CREATE INDEX IF NOT EXISTS idx_areas_key ON areas(key);
  CREATE TABLE IF NOT EXISTS mobs(
    mob TEXT NOT NULL, area TEXT NOT NULL, room TEXT, room_uid TEXT,
    seen_count INTEGER DEFAULT 1, last_seen TEXT,
    PRIMARY KEY(mob, area, room));
  CREATE TABLE IF NOT EXISTS gaardian_imported(areaid INTEGER PRIMARY KEY, imported_at TEXT);
  CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
  -- Shortcut buttons in the row above the command input. Seeded once from the
  -- set that used to be hardcoded in index.html, then owned by the user.
  CREATE TABLE IF NOT EXISTS buttons(
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    cmd   TEXT NOT NULL,
    cls   TEXT DEFAULT '',    -- '' | 'combat' | 'heal' | 'dir'
    pos   INTEGER DEFAULT 0);
`;

function schemaVersionOf(db){
  try {
    const r = db.exec("SELECT v FROM meta WHERE k='schema_version'");
    return r.length && r[0].values.length ? parseInt(r[0].values[0][0]) : 1;
  } catch(e){ return 1; }   // no meta table at all -> v1
}

/** Copy the user's own data out of an old DB before the map tables are rebuilt. */
function rescueUserData(db){
  const out = { aliases: [], triggers: [], buttons: [] };
  for (const [table, bucket] of [['aliases','aliases'], ['triggers','triggers'], ['buttons','buttons']]) {
    try {
      const r = db.exec(`SELECT * FROM ${table}`);
      if (r.length) out[bucket] = { cols: r[0].columns, rows: r[0].values };
    } catch(e){ /* table absent in this DB */ }
  }
  return out;
}

export async function initDb() {
  const SQL = await initSqlPromise;
  const saved = await idbLoad('aardmap');
  let migratedFrom = 0;
  if (saved) {
    const old = new SQL.Database(new Uint8Array(saved));
    const ver = schemaVersionOf(old);
    if (ver === SCHEMA_VERSION) {
      sqlDb = old;
      appendOutput('[DB] Loaded ' + saved.length + ' bytes from storage\n', 'system');
    } else {
      // v1 rooms/exits cannot be migrated in place: the exits table has no
      // unique key (so it holds duplicates) and its rows were built with
      // synthesised reverse edges. Rebuild the map, keep aliases and triggers.
      migratedFrom = ver;
      const rescued = rescueUserData(old);
      old.close();
      sqlDb = new SQL.Database();
      sqlDb.run(SCHEMA_SQL);
      for (const t of ['aliases','triggers','buttons']) {
        const data = rescued[t];
        if (!data || !data.rows || !data.rows.length) continue;
        const cols = data.cols.join(',');
        const qs = data.cols.map(()=>'?').join(',');
        for (const row of data.rows) {
          try { sqlDb.run(`INSERT OR REPLACE INTO ${t}(${cols}) VALUES (${qs})`, row); }
          catch(e){ /* skip rows the new schema rejects */ }
        }
      }
    }
  } else {
    sqlDb = new SQL.Database();
    sqlDb.run(SCHEMA_SQL);
    appendOutput('[DB] New database created\n', 'system');
  }
  sqlDb.run(SCHEMA_SQL);   // idempotent: adds any table missing from an older v2
  sqlDb.run("INSERT OR REPLACE INTO meta(k,v) VALUES ('schema_version',?)", [String(SCHEMA_VERSION)]);
  if (migratedFrom) {
    appendOutput(`[DB] Upgraded schema v${migratedFrom} -> v${SCHEMA_VERSION}; map rebuilt, aliases, triggers and buttons kept\n`, 'system');
  }

  seedAreas();   // minimal area keyword seed; /areas harvests the real list
  initInventory();

  // Load Gaardian map database (read-only reference, not persisted with user data)
  await loadGaardianDb();

  // Load user aliases from DB (overrides defaults)
  loadAliasesFromDb();
  
  // Load all triggers from DB into memory
  loadTriggersFromDb();
  
  // If no Fado triggers in DB, seed them
  const hasFado = sqlDb.exec("SELECT COUNT(*) FROM triggers WHERE name LIKE 'fado_%'");
  if (!hasFado.length || hasFado[0].values[0][0] === 0) {
    seedFadoTriggers();
    loadTriggersFromDb();
    appendOutput('[Triggers] Imported ' + fadoTriggers.length + ' Fado triggers\n', 'system');
  } else {
    appendOutput('[Triggers] Loaded ' + fadoTriggers.length + ' triggers from DB\n', 'system');
  }
  
  setInterval(persistDb, 30000);
}

export let gaardianDb = null;
export async function loadGaardianDb() {
  try {
    const SQL = await initSqlPromise;
    const resp = await fetch('/gaardian_maps.db', { cache: 'no-store' });
    if (!resp.ok) {
      appendOutput('[Gaardian] Map DB not available on server\n', 'system');
      return;
    }
    const buf = await resp.arrayBuffer();
    if (!buf || !buf.byteLength) return;
    gaardianDb = new SQL.Database(new Uint8Array(buf));
    const cntRes = gaardianDb.exec("SELECT COUNT(*) FROM rooms");
    const cnt = cntRes[0]?.values?.[0]?.[0] || 0;
    const areaCntRes = gaardianDb.exec("SELECT COUNT(*) FROM areas");
    const areaCnt = areaCntRes[0]?.values?.[0]?.[0] || 0;
    appendOutput(`[Gaardian] Loaded ${cnt} rooms across ${areaCnt} areas\n`, 'system');
  } catch (e) {
    console.error('loadGaardianDb error', e);
    appendOutput('[Gaardian] Failed to load map DB: ' + e.message + '\n', 'error');
  }
}

export function gaardianUid(areaid, localId){ return `gaardian:${areaid}:${localId}`; }

export function importGaardianAreaByName(areaName){
  if(!sqlDb || !gaardianDb || !areaName) return false;
  const name=areaName.toLowerCase();
  // If already imported, nothing to do.
  if(resolveAreaUid(name)) return true;
  // Find Gaardian area matching the name.
  try {
    const res=gaardianDb.exec('SELECT areaid FROM areas WHERE LOWER(areaname) LIKE ?', ['%'+name+'%']);
    if(res.length && res[0].values.length){
      const areaid=res[0].values[0][0];
      const count=importGaardianArea(areaid, name);
      if(count>0){
        appendOutput('[Gaardian] Auto-imported '+count+' rooms for "'+name+'"\n','system');
        // Was `saveDb()`, which does not exist: the ReferenceError was swallowed
        // by the catch below, so a successful import always reported failure.
        persistDb();
        return true;
      }
    }
  } catch(e){ console.error(e); }
  return false;
}

export function findAreaAnywhere(areaName){
  // Prefer user's DB, then Gaardian DB, auto-importing if needed.
  if(!areaName) return null;
  let area=resolveAreaUid(areaName);
  if(area) return area;
  if(importGaardianAreaByName(areaName)){
    return resolveAreaUid(areaName);
  }
  return null;
}

export function resolveRoomByNameAnywhere(roomName, areaName){
  if(!roomName) return null;
  let rooms=resolveRoomsByName(roomName, areaName);
  if(rooms.length) return rooms[0];
  // Try to import the area from Gaardian if an areaName was provided and missing.
  if(areaName && importGaardianAreaByName(areaName)){
    rooms=resolveRoomsByName(roomName, areaName);
    if(rooms.length) return rooms[0];
  }
  // Last resort: search Gaardian DB directly and import that specific area.
  if(gaardianDb){
    try {
      let sql=`SELECT r.areaid, r.local_id, r.roomname, r.xpos, r.ypos
        FROM rooms r
        WHERE LOWER(r.roomname) LIKE ?`;
      let params=['%'+roomName.toLowerCase()+'%'];
      if(areaName){
        sql+=` AND EXISTS (SELECT 1 FROM areas a WHERE a.areaid=r.areaid AND LOWER(a.areaname) LIKE ?)`;
        params.push('%'+areaName.toLowerCase()+'%');
      }
      const res=gaardianDb.exec(sql, params);
      if(res.length && res[0].values.length){
        const [areaid, local_id]=res[0].values[0];
        importGaardianArea(areaid, areaName || findAreaAnywhereById(areaid));
        const uid=gaardianUid(areaid, local_id);
        const name=res[0].values[0][2];
        return {uid, name, area: areaName || findAreaAnywhereById(areaid)};
      }
    } catch(e){ console.error(e); }
  }
  return null;
}

export function findAreaAnywhereById(gaardianAreaid){
  if(!gaardianDb) return null;
  const res=gaardianDb.exec('SELECT areaname FROM areas WHERE areaid=?', [gaardianAreaid]);
  return (res.length && res[0].values.length)?res[0].values[0][0].toLowerCase():null;
}

export function importGaardianArea(gaardianAreaid, aardwolfAreaName){
  if(!sqlDb || !gaardianDb || !gaardianAreaid) return 0;
  try {
    let areaName = (aardwolfAreaName || '').toLowerCase();
    if(!areaName){
      const areaRes=gaardianDb.exec('SELECT areaname FROM areas WHERE areaid=?', [gaardianAreaid]);
      if(areaRes.length && areaRes[0].values.length){
        areaName=String(areaRes[0].values[0][0]).toLowerCase();
      } else {
        return 0;
      }
    }
    // Also load the canonical Gaardian name to promote any existing local rooms that match by name.
    const gaardianNameRes=gaardianDb.exec('SELECT areaname FROM areas WHERE areaid=?', [gaardianAreaid]);
    const gaardianAreaName=gaardianNameRes.length&&gaardianNameRes[0].values.length?String(gaardianNameRes[0].values[0][0]).toLowerCase():areaName;
    const roomsRes = gaardianDb.exec('SELECT local_id, roomname, xpos, ypos FROM rooms WHERE areaid=?', [gaardianAreaid]);
    const rows = roomsRes[0]?.values || [];
    let inserted = 0;
    const now = new Date().toISOString();
    for(const [localId, roomName, x, y] of rows){
      const uid = gaardianUid(gaardianAreaid, localId);
      sqlDb.run(`INSERT OR IGNORE INTO rooms(uid, area, name, x, y, z, exits, first_seen, last_visited)
        VALUES (?,?,?,?,?,?,?,?,?)`, [uid, areaName, roomName, x||0, y||0, 0, '', now, '']);
      inserted++;
    }

    // Promote any already-known Aardwolf rooms whose names match rooms in this
    // Gaardian area, linking the live graph to the imported one.
    //
    // This used to scan EVERY local room and run one Gaardian query per row.
    // Since importGaardianArea ran on every room.info (see matchAardwolfToGaardian),
    // that was O(local rooms) queries per step: ~460ms at 10k rooms on a desktop,
    // several times worse on a phone. The area filter now happens in SQL, so only
    // rooms that could plausibly belong to this area are considered.
    try {
      const localRes=sqlDb.exec(
        `SELECT uid, name, area FROM rooms
          WHERE area IS NOT NULL AND area!='' AND uid NOT LIKE 'gaardian:%'
            AND (LOWER(area)=? OR LOWER(area)=?
              OR LOWER(area) LIKE ? OR LOWER(area) LIKE ?
              OR ? LIKE LOWER(area)||'%' OR ? LIKE LOWER(area)||'%')`,
        // The last two clauses matter more than the first four. GMCP puts the
        // area KEYWORD in rooms.area ('aardington'), while Gaardian holds the
        // display name ('Aardington Estate') -- so the local value is a PREFIX
        // of the Gaardian one, and every prefix test here pointed the wrong way.
        // Nothing was ever promoted, which left the 84 imported rooms as an
        // island: standing inside Aardington Estate, `findPath` to The stables
        // reported "no path to that room from here".
        [areaName, gaardianAreaName, areaName+'%', gaardianAreaName+'%',
         areaName, gaardianAreaName]);
      const localRows=localRes[0]?.values||[];
      for(const [uid,name,localArea] of localRows){
        const gRes=gaardianDb.exec('SELECT local_id FROM rooms WHERE areaid=? AND LOWER(roomname)=LOWER(?) LIMIT 1', [gaardianAreaid, name]);
        if(gRes.length && gRes[0].values.length){
          const localId=gRes[0].values[0][0];
          // Only promote if the local area is plausibly the same as the Gaardian area.
          if(localArea.toLowerCase()===areaName || localArea.toLowerCase()===gaardianAreaName || areaNameMatches(areaName, localArea) || areaNameMatches(gaardianAreaName, localArea)){
            promoteGaardianRoom(uid, gaardianAreaid, localId, areaName);
          }
        }
      }
    }catch(e){ console.error('promote existing rooms error', e); }

    const stats = importGaardianExits(gaardianAreaid);
    markAreaImported(gaardianAreaid);
    appendOutput(`[Gaardian] Imported ${inserted} rooms and ${stats.total} exits for ${areaName}`
      + (stats.custom ? ` (${stats.custom} custom, ${stats.doors} doors)` : '')
      + (stats.skipped ? `, skipped ${stats.skipped}` : '') + '\n', 'system');
    return inserted;
  } catch(e){
    console.error('importGaardianArea error', e);
    appendOutput('[Gaardian] Import failed: ' + e.message + '\n', 'error');
    return 0;
  }
}

// gaardian_maps.db exit encoding, confirmed against the shipped file by
// comparing each exit against its rooms' xpos/ypos deltas:
//   exit_type 0..3 = N/E/S/W, 4 = up, 5 = down
//   exit_type 6     = "enter"-style special exit; exit_action names the target
//                     ('portal', 'hole', 'den', 'log')            -- 491 rows
//   exit_type 7     = an arbitrary command to type verbatim
//                     ('climb ladder', 'say yes', 'Jump down')    -- 786 rows
//   door_type       = 0 none, 1 door, 2 locked (key_name names the key)
//   random          = the exit leads somewhere unpredictable
// The old importer handled only 0..6 and dropped every type 7, which left 310
// rooms reachable by no imported edge at all.
const GAARDIAN_DIRS = {0:'n', 1:'e', 2:'s', 3:'w', 4:'u', 5:'d'};

// exit_action is mostly a command, but a few rows are prose describing how the
// exit works rather than something you can type. Import those with level 999 so
// they still show on the map but never appear in a route.
const UNTYPEABLE = /^(mobprog|special|unknown)$|\(/i;

export function importGaardianExits(gaardianAreaid){
  const stats = {total:0, custom:0, doors:0, skipped:0};
  const res = gaardianDb.exec(
    `SELECT from_room, to_room, exit_type, exit_action, target_areaid,
            door_type, key_name, random
       FROM exits WHERE areaid=?`, [gaardianAreaid]);
  const rows = res[0]?.values || [];
  for(const [fromRoom, toRoom, exitType, exitAction, targetAreaid, doorType, keyName, random] of rows){
    // Random exits cannot be routed through -- you don't know where you land.
    if(random){ stats.skipped++; continue; }

    let toUid = null;
    if(toRoom){
      toUid = gaardianUid(gaardianAreaid, toRoom);
    } else if(targetAreaid){
      // Cross-area exit. Only usable if we know a concrete entrance room in the
      // target area. The old code invented a 'gaardian-area:<id>' node with no
      // row in `rooms`, which made every pair of rooms bordering the same area
      // look two steps apart through a room that does not exist.
      const ent = gaardianDb.exec(
        'SELECT local_id FROM rooms WHERE areaid=? AND is_entrance=1 LIMIT 1', [targetAreaid]);
      if(ent[0]?.values?.length) toUid = gaardianUid(targetAreaid, ent[0].values[0][0]);
    }
    if(!toUid){ stats.skipped++; continue; }

    let dir = null, level = 0;
    if(exitType >= 0 && exitType <= 5){
      dir = GAARDIAN_DIRS[exitType];
    } else if(exitType === 6 && exitAction){
      dir = 'enter ' + String(exitAction).trim().toLowerCase();
    } else if(exitType === 7 && exitAction){
      // Already a command; send it as written.
      dir = String(exitAction).trim().toLowerCase();
      if(UNTYPEABLE.test(dir)) level = 999;
    }
    if(!dir){ stats.skipped++; continue; }

    const door = doorType || 0;
    sqlDb.run(
      `INSERT OR REPLACE INTO exits(from_uid, dir, to_uid, level, door, key_name)
       VALUES (?,?,?,?,?,?)`,
      [gaardianUid(gaardianAreaid, fromRoom), dir, toUid, level, door, keyName || null]);
    stats.total++;
    if(dir.length > 1) stats.custom++;
    if(door) stats.doors++;
  }
  return stats;
}

/**
 * Carry a promotion outwards along the exits.
 *
 * Promoting one room is not enough to join the two graphs. The live room keeps
 * its GMCP exits, which point at real uids of rooms you have not visited -- rows
 * that do not exist -- while the imported area is a closed `gaardian:<area>:<id>`
 * component. Measured in the browser: 83 rooms, 82 of them synthetic, and the
 * one real room's only exits were two dead ends. Every path across the area
 * failed even while standing in it.
 *
 * So when the live room and its Gaardian twin agree on a direction, their
 * neighbours in that direction are the same room too. Promote those, and repeat.
 * That is how the live uids progressively replace the imported skeleton.
 */
function liveExitsOf(uid){
  try {
    const r = sqlDb.exec('SELECT dir, to_uid FROM exits WHERE from_uid=?', [uid]);
    return r.length ? r[0].values : [];
  } catch(e){ return []; }
}

/**
 * `synthetic` is the Gaardian room's own exit list, captured before the merge
 * deleted it. Where the live room has a GMCP exit in the same direction, the two
 * neighbours are the same room -- so promote that neighbour and carry on.
 */
function propagatePromotion(seedUid, seedSynthetic, gaardianAreaid, areaName){
  let queue = [[seedUid, seedSynthetic]];
  const seen = new Set([seedUid]);
  let promoted = 0;
  while(queue.length && promoted < 400){
    const [uid, synthetic] = queue.shift();
    if(!synthetic || !synthetic.length) continue;
    const bySynthDir = new Map(synthetic.map(([d, t]) => [d, t]));
    for(const [dir, toUid] of liveExitsOf(uid)){
      const target = String(toUid);
      if(target.startsWith('gaardian:')) continue;    // already the skeleton
      if(seen.has(target)) continue;
      const gTarget = bySynthDir.get(dir);
      if(!gTarget || !String(gTarget).startsWith('gaardian:')) continue;
      const localId = parseInt(String(gTarget).split(':')[2]);
      if(isNaN(localId)) continue;
      seen.add(target);
      promoted++;
      // Capture the next room's skeleton exits before promoting it, for the
      // next hop.
      const nextSynthetic = liveExitsOf(gaardianUid(gaardianAreaid, localId));
      promoteGaardianRoom(target, gaardianAreaid, localId, areaName, true);
      queue.push([target, nextSynthetic]);
    }
  }
  return promoted;
}

export function promoteGaardianRoom(aardwolfUid, gaardianAreaid, gaardianLocalId, aardwolfAreaName, noPropagate){
  if(!sqlDb) return;
  const oldUid = gaardianUid(gaardianAreaid, gaardianLocalId);
  // Read the skeleton's exits before the merge below deletes them: they are the
  // only record of which Gaardian room each live neighbour corresponds to.
  const synthetic = liveExitsOf(oldUid);
  try {
    // Merge Gaardian-preloaded room into the real Aardwolf room record.
    sqlDb.run("UPDATE OR IGNORE rooms SET uid=? WHERE uid=?", [aardwolfUid, oldUid]);
    // Ensure the promoted room uses the Aardwolf area name
    if(aardwolfAreaName){
      sqlDb.run("UPDATE rooms SET area=? WHERE uid=?", [aardwolfAreaName.toLowerCase(), aardwolfUid]);
    }
    // If the old uid row still exists (because real uid already existed), delete the synthetic one.
    sqlDb.run("DELETE FROM rooms WHERE uid=?", [oldUid]);
    // Rewrite exits that pointed to/from the synthetic uid.
    //
    // `exits` is keyed on (from_uid, dir), so moving the synthetic room's exits
    // onto the real uid collides whenever the real room already has that
    // direction from GMCP. A plain UPDATE throws and abandons the rest of the
    // rewrite, stranding rows that point at a room we are about to delete.
    // Keep the GMCP-derived row (it is observed, not inferred) and drop the
    // synthetic duplicate.
    sqlDb.run("UPDATE OR IGNORE exits SET from_uid=? WHERE from_uid=?", [aardwolfUid, oldUid]);
    sqlDb.run("DELETE FROM exits WHERE from_uid=?", [oldUid]);
    // to_uid is not part of the key, so this one cannot conflict.
    sqlDb.run("UPDATE exits SET to_uid=? WHERE to_uid=?", [aardwolfUid, oldUid]);
  } catch(e){ console.error('promoteGaardianRoom error', e); }
  // Join the live graph to the imported one, not just at this single room.
  if(!noPropagate){
    const n = propagatePromotion(aardwolfUid, synthetic, gaardianAreaid, aardwolfAreaName);
    if(n) console.log('[map] aligned', n, 'room(s) with the live graph');
  }
}

// Areas whose Gaardian data is already in the local database. Backed by a table
// so it survives a reload, and consulted before doing the work again.
const importedAreas = new Set();

export function isAreaImported(gaardianAreaid){
  if(importedAreas.has(gaardianAreaid)) return true;
  try {
    const r = sqlDb.exec('SELECT 1 FROM gaardian_imported WHERE areaid=?', [gaardianAreaid]);
    if(r.length && r[0].values.length){ importedAreas.add(gaardianAreaid); return true; }
  } catch(e){ /* table missing on an older db */ }
  return false;
}

function markAreaImported(gaardianAreaid){
  importedAreas.add(gaardianAreaid);
  try {
    sqlDb.run('INSERT OR REPLACE INTO gaardian_imported(areaid, imported_at) VALUES (?,?)',
      [gaardianAreaid, new Date().toISOString()]);
  } catch(e){ /* not fatal */ }
}

/**
 * Pick the Gaardian twin whose exits match the ones GMCP just reported.
 *
 * Room names repeat: Aardington Estate has twelve rooms called "Path around the
 * manor". Matching on name alone picks an arbitrary one, and since a promotion
 * rewires that room's edges, a wrong pick corrupts the graph -- the walk starts,
 * then dies with "lost the route". The set of exit directions is a much stronger
 * fingerprint and costs one query.
 */
const DIR_OF_TYPE = {0:'n', 1:'e', 2:'s', 3:'w', 4:'u', 5:'d'};

function gaardianExitsOf(areaid, localId){
  try {
    const e = gaardianDb.exec(
      'SELECT exit_type, to_room FROM exits WHERE areaid=? AND from_room=?', [areaid, localId]);
    return (e[0]?.values || [])
      .map(([t, to]) => [DIR_OF_TYPE[t], to])
      .filter(([d]) => d);
  } catch(e){ return []; }
}

/** local_id of a live room we have already anchored, or null. */
function anchoredLocalId(uid, areaid){
  try {
    const r = sqlDb.exec(
      'SELECT gaardian_local_id FROM room_gaardian_map WHERE aardwolf_uid=? AND gaardian_areaid=?',
      [String(uid), areaid]);
    return (r.length && r[0].values.length) ? r[0].values[0][0] : null;
  } catch(e){ return null; }
}

/**
 * Which Gaardian room is this live room? Answer only when it is certain.
 *
 * GMCP's `coord` cannot help: it reports the AREA's position on the world map,
 * so every room in Aardington Estate reports {x:38, y:25} -- verified against
 * three different rooms. Room names are not unique either; this area has twelve
 * called "Path around the manor".
 *
 * Three signals, strongest first. A guess here is worse than no answer at all:
 * promoting rewrites that room's edges, so one wrong pick corrupts the graph and
 * the walk dies with "lost the route". When nothing is conclusive we anchor
 * nothing and let the skeleton stand until the player reaches a room we can
 * identify.
 */
function identifyRoom(areaid, roomName, liveDirs, liveExits){
  if(!gaardianDb) return null;
  let ids;
  try {
    const res = gaardianDb.exec(
      'SELECT local_id FROM rooms WHERE areaid=? AND roomname=? COLLATE NOCASE', [areaid, roomName]);
    ids = (res[0]?.values || []).map(r => r[0]);
  } catch(e){ return null; }
  if(!ids.length) return null;
  if(ids.length === 1) return ids[0];            // the name is unique: done

  // 1. A neighbour we have already anchored pins this room exactly: if going
  //    `dir` from here reaches live room U, and U is Gaardian room M, then this
  //    room is whichever candidate has an exit `dir` to M.
  if(liveExits){
    for(const [dir, toUid] of Object.entries(liveExits)){
      const nb = anchoredLocalId(toUid, areaid);
      if(nb == null) continue;
      const hits = ids.filter(id => gaardianExitsOf(areaid, id).some(([d, to]) => d === dir && to === nb));
      if(hits.length === 1) return hits[0];
    }
  }

  // 2. A neighbour we merely know the NAME of still pins this room, and that is
  //    the common case: you arrive from a room you were just standing in. For
  //    each live exit, ask which candidates have that direction leading to a
  //    Gaardian room of that name, and intersect. Only 48% of Aardwolf rooms
  //    have a name unique within their area, so this carries most of the load.
  if(liveExits){
    let narrowed = ids;
    for(const [dir, toUid] of Object.entries(liveExits)){
      let nbName = null;
      try {
        const r = sqlDb.exec('SELECT name FROM rooms WHERE uid=?', [String(toUid)]);
        if(r.length && r[0].values.length) nbName = String(r[0].values[0][0] || '');
      } catch(e){ /* neighbour not seen yet */ }
      if(!nbName) continue;
      const hits = narrowed.filter(id =>
        gaardianExitsOf(areaid, id).some(([d, to]) => {
          if(d !== dir) return false;
          try {
            const g = gaardianDb.exec(
              'SELECT roomname FROM rooms WHERE areaid=? AND local_id=?', [areaid, to]);
            return g.length && g[0].values.length
              && String(g[0].values[0][0]).toLowerCase() === nbName.toLowerCase();
          } catch(e){ return false; }
        }));
      if(hits.length){ narrowed = hits; }
      if(narrowed.length === 1) return narrowed[0];
    }
  }

  // 3. Otherwise the set of exit directions, if it happens to be unique.
  if(liveDirs && liveDirs.length){
    const want = [...new Set(liveDirs)].sort().join(',');
    const hits = ids.filter(id => {
      const have = [...new Set(gaardianExitsOf(areaid, id).map(([d]) => d))].sort().join(',');
      return have === want;
    });
    if(hits.length === 1) return hits[0];
  }

  return null;   // ambiguous: refuse to guess
}

export function matchAardwolfToGaardian(uid, area, name, now, liveDirs, liveExits){
  if(!sqlDb) return null;
  const gaardianRoom = lookupGaardianRoom(area, name);
  if(!gaardianRoom) return null;

  // Import first: identification needs the area's rooms present, and it is the
  // skeleton that anchoring later replaces. This used to run on EVERY room.info,
  // re-importing everything and re-scanning the local map each step -- the single
  // biggest cause of the client feeling laggy while walking.
  if(!isAreaImported(gaardianRoom.areaid)){
    importGaardianArea(gaardianRoom.areaid, area);
  }

  const certain = identifyRoom(gaardianRoom.areaid, name, liveDirs, liveExits);
  if(certain == null){
    // Ambiguous. Leave the skeleton alone rather than rewiring a room's edges on
    // a coin flip -- a wrong promotion is unrecoverable and shows up much later
    // as a walk that starts off in the wrong direction.
    return gaardianRoom;
  }
  gaardianRoom.local_id = certain;
  sqlDb.run(`INSERT OR REPLACE INTO room_gaardian_map
    (aardwolf_uid, gaardian_areaid, gaardian_local_id, gaardian_name, matched_at)
    VALUES (?,?,?,?,?)`, [uid, gaardianRoom.areaid, gaardianRoom.local_id, gaardianRoom.roomname, now]);
  promoteGaardianRoom(uid, gaardianRoom.areaid, gaardianRoom.local_id, area);
  return gaardianRoom;
}

export function lookupGaardianRoom(areaName, roomName) {
  if (!gaardianDb || !areaName || !roomName) return null;
  try {
    const sql = `
      SELECT r.areaid, r.local_id, r.roomname, r.xpos, r.ypos
      FROM rooms r
      JOIN areas a ON a.areaid = r.areaid
      WHERE (a.areaname LIKE ? COLLATE NOCASE OR a.areaname LIKE ? COLLATE NOCASE)
        AND (r.roomname LIKE ? COLLATE NOCASE OR r.roomname LIKE ? COLLATE NOCASE)
      LIMIT 5
    `;
    const res = gaardianDb.exec(sql, [`%${areaName}%`, `%${roomName.split(' ').pop()}%`, `%${roomName}%`, `%${roomName.replace(/^\+|\+$/g, '')}%`]);
    if (!res.length || !res[0].values.length) return null;
    // Prefer exact match
    for (const row of res[0].values) {
      if (String(row[2]).toLowerCase() === roomName.toLowerCase()) {
        return { areaid: row[0], local_id: row[1], roomname: row[2], xpos: row[3], ypos: row[4] };
      }
    }
    const row = res[0].values[0];
    return { areaid: row[0], local_id: row[1], roomname: row[2], xpos: row[3], ypos: row[4] };
  } catch (e) {
    console.error('lookupGaardianRoom error', e);
    return null;
  }
}

// Alias persistence helpers
export function loadAliasesFromDb(){
  if(!sqlDb) return;
  try{
    const rows=sqlDb.exec("SELECT name, expansion FROM aliases");
    if(rows.length && rows[0].values){
      for(const r of rows[0].values){
        if(r[0] && r[1]) commandMap[r[0]]=r[1];
      }
    }
  }catch(e){ console.log('loadAliases error',e); }
}

export function seedFadoTriggers() {
  const triggers = [
    {name:'fado_t1',enabled:true,p:/A tiny, fiery|A freakish monkey demon is here|A demonic little monkey/i,cmd:'strang mo; back mo;ki mo;attmarbu2'},
    {name:'fado_t2',enabled:true,p:/training dummy stands here strapped to a pole waiting to get stabbed/i,cmd:'strang dummy; back dummy; ki dummy; attsweep'},
    {name:'fado_t3',enabled:true,p:/A yellow bird stands/i,cmd:'kill yellow'},
    {name:'fado_t4',enabled:true,p:/A red and white cockatoo is here/i,cmd:'strang red; back red;kill red; attmarbu'},
    {name:'fado_t5',enabled:true,p:/A lizardman trained|A lizardman citizen is here|A lizardman guard is here|A lizardman child is here/i,cmd:'attli'},
    {name:'fado_t6',enabled:true,p:/The tallest|A troll warrior is here|A tall,|A large troll/i,cmd:'strang tr; back tr; ki tr; attspi'},
    {name:'fado_t7',enabled:true,p:/A mosquito is here/i,cmd:'ki mos'},
    {name:'fado_t8',enabled:true,p:/Some withered, brown|Long reeds line/i,cmd:'strang reed; back reed; attspi2'},
    {name:'fado_t9',enabled:true,p:/You may now use Quickstab|You fail to focus on your backstab/i,cmd:'quick'},
    {name:'fado_t10',enabled:true,p:/A horse and carriage has been tied/i,cmd:'back h;ki h;attsweep'},
    {name:'fado_t11',enabled:true,p:/A monkey is here,/i,cmd:'stran m; back m; ki m; attsweep'},
    {name:'fado_t12',enabled:true,p:/while trying to cast earthquake/i,cmd:'cast earth'},
    {name:'fado_t13',enabled:true,p:/A lizardman is here|A lizardman priest is here/i,cmd:'back li;ki li;burnt'},
    {name:'fado_t14',enabled:true,p:/A very large snake/i,cmd:'ki snake;burnt'},
    {name:'fado_t15',enabled:true,p:/A lizardman hunter is here/i,cmd:'ki hunter;cir;cir;cir'},
    {name:'fado_t16',enabled:true,p:/A pocket of air is here/i,cmd:'back poc;kill poc;attgreen'},
    {name:'fado_t17',enabled:true,p:/A giant mosquito swarms/i,cmd:'back mos;ki mos;burnt;cir;cir;cir'},
    {name:'fado_t18',enabled:true,p:/A violent gale crashes/i,cmd:'back gale;ki gale;attgreen'},
    {name:'fado_t19',enabled:true,p:/The skeleton of a monkey is here/i,cmd:'strangle ske ; back ske; ki ske; attsweep'},
    {name:'fado_t20',enabled:true,p:/You dream about/i,cmd:'wake'},
    {name:'fado_t21',enabled:true,p:/A dreadful/i,cmd:'strang har ; back har;ki har;attmarbu2'},
    {name:'fado_t22',enabled:true,p:/A tiny spider runs/i,cmd:'strang spi; back spi ; kill spi; attsweep'},
    {name:'fado_t23',enabled:true,p:/very thirsty/i,cmd:"cast 'create water' ; drink spr; fill cara; dri cara"},
    {name:'fado_t24',enabled:true,p:/fountain of carved obsidian flows/i,cmd:'drink;fill cara;fill 2.cara'},
    {name:'fado_t25',enabled:true,p:/A kobold soldier is noisily/i,cmd:'back soldi;ki soldi;attksp2'},
    {name:'fado_t26',enabled:true,p:/A gorilla is here/i,cmd:'back gor;ki gor; burnt;cir;cir'},
    {name:'fado_t27',enabled:true,p:/This warrior was not/i,cmd:'strangle war;back warrior;kill warrior;attspi'},
    {name:'fado_t28',enabled:true,p:/A frightening monkey skeleton is here/i,cmd:'strangle ske; back ske;kill ske;attsweep'},
    {name:'fado_t29',enabled:true,p:/A dark storm/i,cmd:'back storm; ki storm;attmarbu2'},
    {name:'fado_t30',enabled:true,p:/A medic is here/i,cmd:'strangle med;back med;ki med;attspi'},
    {name:'fado_t31',enabled:true,p:/A tse tse fly is here/i,cmd:'strangle fly;back tse;ki tse;attmarbu'},
    {name:'fado_t32',enabled:true,p:/very hungry/i,cmd:"cast 'create food'; cast 'create food'; eat mush ; eat mush"},
    {name:'fado_t33',enabled:true,p:/The tribe has outcast/i,cmd:'strangle out;back out;ki out;attspi'},
    {name:'fado_t34',enabled:true,p:/A member of the Blood Ring High Council is handing/i,cmd:'strang high; back high; ki high; attsweep'},
    {name:'fado_t35',enabled:true,p:/A pair of kobolds/i,cmd:'back pair;ki pair;attksp2'},
    {name:'fado_t36',enabled:true,p:/An operator from an amusement park chats|One of the prize booth operators/i,cmd:'back op;ki op;attsweep'},
    {name:'fado_t37',enabled:true,p:/DISARMS you/i,cmd:'get wpn2;wear wpn2'},
    {name:'fado_t38',enabled:true,p:/A big, scary rat is here|A small, scary rat is here/i,cmd:'back rat;ki rat;attcobra'},
    {name:'fado_t39',enabled:true,p:/A doctor from/i,cmd:'back doc;ki doc;attmarbu'},
    {name:'fado_t40',enabled:true,p:/A taller green man is standing here|An odd green man is here/i,cmd:'back man;kill man;attcobra'},
    {name:'fado_t41',enabled:true,p:/This hawk/i,cmd:'strangle hawk; back hawk;kill hawk ; attspi'},
    {name:'fado_t42',enabled:true,p:/An apparition floats/i,cmd:'strangle app; back app;ki app;attsweep'},
    {name:'fado_t43',enabled:true,p:/Blood Ring Inquisitor is polishing an axe/i,cmd:'strang inqui; back inqui; ki inqui; attsweep'},
    {name:'fado_t44',enabled:true,p:/You fail to remove your curse/i,cmd:'crc'},
    {name:'fado_t45',enabled:true,p:/A team of kobolds/i,cmd:'back ladd;ki ladd;attraven'},
    {name:'fado_t46',enabled:false,p:/You are starving/i,cmd:'cf;cf'},
    {name:'fado_t47',enabled:true,p:/A big tuft of/i,cmd:'strang mars; back mars; attspi2'},
    {name:'fado_t48',enabled:true,p:/This chef seems/i,cmd:'strang chef; back chef; ki chef; attsweep'},
    {name:'fado_t49',enabled:true,p:/This termite is/i,cmd:'strang ter; back ter; ki ter; attsweep'},
    {name:'fado_t50',enabled:true,p:/A gentle breeze blows by/i,cmd:'strang gentle; back gentle;ki bree;attgreen'},
    {name:'fado_t51',enabled:true,p:/is closed/i,cmd:'op e; op w; op n; op s; op u; op d'},
    {name:'fado_t52',enabled:true,p:/A blue and green cockatoo is here/i,cmd:'strang blue; back blue;ki blue;attmarbu'},
    {name:'fado_t53',enabled:true,p:/is locked/i,cmd:'pick e;pick w;pick s; pick n; pick s'},
    {name:'fado_t54',enabled:true,p:/Carefully observing/i,cmd:'stran hawk; back hawk;kill hawk;attmarbu2'},
    {name:'fado_t55',enabled:true,p:/A mosquito flies about|A very large mosquito/i,cmd:'ki m;cir;cir;cir'},
    {name:'fado_t56',enabled:true,p:/You are dehydrated/i,cmd:"cast 'create water' ; drink spr; fill carr; dri carr"},
    {name:'fado_t57',enabled:true,p:/You fail to surround|You may now use your veil/i,cmd:'veil stone'},
    {name:'fado_t58',enabled:true,p:/A long, thin lizard/i,cmd:'strang li; back li;ki li  ;attmarbu2'},
    {name:'fado_t59',enabled:true,p:/A furry zombie is here/i,cmd:'strangle zom; back zom;ki zom;attsweep'},
    {name:'fado_t60',enabled:true,p:/A living blob of magma is here/i,cmd:'strang mag; back mag;ki mag;attmarbu2'},
    {name:'fado_t61',enabled:true,p:/Blood Ring Overlord is shouting commands/i,cmd:'strang over; back over; ki over ; attsweep'},
    {name:'fado_t62',enabled:true,p:/A paladin,/i,cmd:'strangle pal;back pal;ki pal;attmarbu2'},
    {name:'fado_t63',enabled:true,p:/A strong wind/i,cmd:'stran air ; back air;ki air; attmarbu2'},
    {name:'fado_t64',enabled:true,p:/A surgeon is trying/i,cmd:'back sur;ki sur;attsweep'},
    {name:'fado_t65',enabled:true,p:/An off-duty server stands/i,cmd:'back ser;ki ser;attsweep'},
    {name:'fado_t66',enabled:true,p:/A grease monster is filling/i,cmd:'strang grea; back grea; attsweep'},
    {name:'fado_t67',enabled:true,p:/A very tall lizardman/i,cmd:'back li;ki li; burnt;burnt'},
    {name:'fado_t68',enabled:true,p:/sanctuary shimmers/i,cmd:'cast sanctuary;cast sanc'},
    {name:'fado_t69',enabled:true,p:/A Blood Ring Soldier appears distracted/i,cmd:'strang sol; back sol; ki sol; sweep sol'},
    {name:'fado_t70',enabled:true,p:/A gust of wind blows/i,cmd:'strang gust; back gust;ki gust;attgreen'},
    {name:'fado_t71',enabled:true,p:/A kobold warlord|kobold warlord|Warlord Grash/i,cmd:'kill warlord'},
    {name:'fado_t72',enabled:true,p:/A kobold commander|kobold commander/i,cmd:'kill commander'},
    {name:'fado_t73',enabled:true,p:/A kobold assassin|kobold assassin/i,cmd:'kill assassin'},
    {name:'fado_t74',enabled:true,p:/A kobold sorcerer|kobold sorcerer/i,cmd:'kill sorcerer'},
    {name:'fado_t75',enabled:true,p:/A kobold brute|kobold brute/i,cmd:'kill brute'},
    {name:'fado_t76',enabled:true,p:/A kobold sniper|kobold sniper/i,cmd:'kill sniper'},
    {name:'fado_t77',enabled:true,p:/A kobold alchemist|kobold alchemist/i,cmd:'kill alchemist'},
    {name:'fado_t78',enabled:true,p:/A kobold tracker|kobold tracker/i,cmd:'kill tracker'},
    {name:'fado_t79',enabled:true,p:/A kobold miner|kobold miner/i,cmd:'kill miner'},
    {name:'fado_t80',enabled:true,p:/A kobold smith|kobold smith/i,cmd:'kill smith'},
  ];
  for (const t of triggers) {
    sqlDb.run("INSERT OR IGNORE INTO triggers(name, enabled, pattern, cmd) VALUES (?,?,?,?)",
      [t.name, t.enabled ? 1 : 0, t.p.source, t.cmd]);
  }
}

export function loadTriggersFromDb() {
  fadoTriggers = [];
  if (!sqlDb) return;
  try {
    const rows = sqlDb.exec("SELECT name, enabled, pattern, cmd FROM triggers WHERE name LIKE 'fado_%'");
    if (rows.length && rows[0].values) {
      for (const r of rows[0].values) {
        try {
          fadoTriggers.push({name:r[0], enabled:!!r[1], p:new RegExp(r[2],'i'), cmd:r[3]});
        } catch(e) { console.log('Bad trigger regex:', r[2]); }
      }
    }
  } catch(e) { console.log('loadTriggers error:', e); }
}

export function toggleTrigger(name) {
  if (!sqlDb) return;
  const t = fadoTriggers.find(x => x.name === name);
  if (t) {
    t.enabled = !t.enabled;
    sqlDb.run("UPDATE triggers SET enabled=? WHERE name=?", [t.enabled ? 1 : 0, name]);
    persistDb();
    renderTriggers();
  }
}

// Saving means serialising the WHOLE SQLite image and handing several megabytes
// to IndexedDB, on the main thread. Two things make that dangerous:
//
//  - it used to run on every single room.info, un-awaited, so writes piled up;
//  - the database only ever grows. Every area you walk into imports 50-500
//    rooms permanently, so each save costs more than the last. On a phone that
//    reads as lag that builds up the longer you play.
//
// So: only save when something actually changed, never more often than the
// interval below, and back off automatically if a save turns out to be slow.
// Nothing is lost on exit because we also flush when the page is hidden.
const PERSIST_MIN_MS = 20000;      // floor between saves
const PERSIST_BACKOFF = 25;        // keep saves under ~1/25th of wall time
let persistTimer = null, persistInFlight = false;
let persistDirty = false, persistDelay = PERSIST_MIN_MS;

/** Mark the database changed; a save will happen eventually. */
export function persistDb() {
  if (!sqlDb) return;
  persistDirty = true;
  if (persistTimer) return;
  persistTimer = setTimeout(() => { persistTimer = null; flushPersist(); }, persistDelay);
}

/** Write now and wait for it -- for export/import, where the user is waiting. */
export async function persistDbNow() {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  persistDirty = true;
  await flushPersist();
}

async function flushPersist() {
  if (!sqlDb || !persistDirty) return;
  if (persistInFlight) return;          // a later change re-arms the timer itself
  persistInFlight = true;
  persistDirty = false;
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  try {
    await idbSave('aardmap', sqlDb.export());
    // Adapt: if this save cost 400ms, do not run it every 20s -- run it every
    // 10s at most... i.e. keep the cost a small fraction of elapsed time.
    const took = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    persistDelay = Math.max(PERSIST_MIN_MS, Math.round(took * PERSIST_BACKOFF));
  } catch (e) {
    persistDirty = true;              // failed: try again on the next change
    console.error('persistDb', e);
  } finally {
    persistInFlight = false;
    if (persistDirty) persistDb();    // changed again while we were writing
  }
}

// Losing up to PERSIST_MIN_MS of map data on a crash is fine, but not on a
// normal close or app-switch -- which on a phone is the usual way a session
// ends. Flush when the page goes away.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPersist();
  });
  window.addEventListener('pagehide', () => { flushPersist(); });
}

// IndexedDB helpers. The connection is opened once and reused; the old code
// opened a fresh one for every save and never closed it.
let idbPromise = null;
function idbOpen() {
  if (idbPromise) return idbPromise;
  idbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open('aardclient', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('store');
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = reject;
  });
  return idbPromise;
}

export async function idbSave(key, data) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('store', 'readwrite');
    tx.objectStore('store').put(data, key);
    tx.oncomplete = resolve;
    tx.onerror = reject;
  });
}
export async function idbLoad(key) {
  let db;
  try { db = await idbOpen(); } catch (e) { return null; }
  return new Promise((resolve) => {
    const tx = db.transaction('store', 'readonly');
    const get = tx.objectStore('store').get(key);
    get.onsuccess = () => resolve(get.result || null);
    get.onerror = () => resolve(null);
  });
}


// =============================================================================
// DB IMPORT/EXPORT
// =============================================================================
export async function exportDb(){
  if(!sqlDb) return;
  const data=sqlDb.export();
  const blob=new Blob([data],{type:'application/octet-stream'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url; a.download='aardmap-'+new Date().toISOString().slice(0,10)+'.db'; a.click();
  URL.revokeObjectURL(url);
  appendOutput('Database exported.\n','system');
}

export async function importDb(){
  const input=document.createElement('input');
  input.type='file'; input.accept='.db';
  input.onchange=async e=>{
    const file=e.target.files[0];
    if(!file) return;
    const buf=await file.arrayBuffer();
    const SQL=await initSqlPromise;
    sqlDb=new SQL.Database(new Uint8Array(buf));
    await persistDbNow();
    appendOutput('Database imported: '+file.name+'\n','system');
    renderRooms();
  };
  input.click();
}
