// db.js -- extracted from index.html

import { renderRooms } from './nav.js';
import { areaNameMatches, resolveAreaUid, resolveRoomsByName } from './snd.js';
import { commandMap } from './state.js';
import { seedAreas } from './areas.js';
import { initInventory } from './dinv.js';
import { appendOutput, renderTriggers } from './ui.js';
import { isNativeHost, nativeOpenFile, nativeSaveFile } from './transport.js';
// --- state owned by this module ---
export let sqlDb=null; // Browser SQLite (live/discovered map)
export let fadoTriggers=[]; // populated from SQLite on init

// =============================================================================
// SQLITE INITIALIZATION
// =============================================================================
export let initSqlPromise = initSqlJs({ locateFile: file => `/static/vendor/${file}` });

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
    -- Aardwolf's own coordinate frame from room.info.coord, as opposed to x/y/z
    -- above, which this client derives from the exit graph in order to draw.
    -- A refused runto answers with a coordinate, so these are what make that
    -- answer usable. (No backticks in here: SCHEMA_SQL is a template literal.)
    acoord_x INTEGER, acoord_y INTEGER, acoord_id INTEGER,
    first_seen TEXT, last_visited TEXT);
  CREATE TABLE IF NOT EXISTS exits(
    from_uid TEXT NOT NULL,
    dir      TEXT NOT NULL,   -- 'n'..'d', or a literal command for custom exits
    to_uid   TEXT NOT NULL,
    level    INTEGER DEFAULT 0,   -- min level to use; 999 = never auto-path
    door     INTEGER DEFAULT 0,   -- 0 none, 1 door, 2 locked
    key_name TEXT,
    key_desc TEXT,                -- how to get past it, from Gaardian
    key_room TEXT,                -- where the key comes from
    random   INTEGER DEFAULT 0,   -- destination is randomised; to_uid is one sample
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
    nogo INTEGER DEFAULT 0,  -- refuse to auto-navigate here
    norunto INTEGER DEFAULT 0, -- runto refuses this area; use entry_* instead
    -- What the game said when it refused, e.g. "Look for the Andromeda Galaxy in
    -- Vidblain. Coords 14,23." For areas reached only via a landmark elsewhere,
    -- this is the only routing information that exists.
    entry_note TEXT, entry_area TEXT, entry_x INTEGER, entry_y INTEGER);
  CREATE INDEX IF NOT EXISTS idx_areas_key ON areas(key);
  CREATE TABLE IF NOT EXISTS mobs(
    mob TEXT NOT NULL, area TEXT NOT NULL, room TEXT, room_uid TEXT,
    seen_count INTEGER DEFAULT 1, last_seen TEXT,
    PRIMARY KEY(mob, area, room));
  -- Surviving hypotheses for a live room whose Gaardian twin is not yet certain.
  -- See "ROOM IDENTITY" below: identification is constraint propagation, and a
  -- room keeps a candidate set until the graph narrows it to exactly one.
  CREATE TABLE IF NOT EXISTS room_candidates(
    uid TEXT NOT NULL, areaid INTEGER NOT NULL, local_id INTEGER NOT NULL,
    PRIMARY KEY(uid, areaid, local_id));
  CREATE INDEX IF NOT EXISTS idx_cand_uid ON room_candidates(uid);
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

  // Columns added after the first release; ALTER is the only way to reach an
  // exits table that already exists (CREATE TABLE IF NOT EXISTS will not).
  let addedKeyCols = false;
  for(const col of ['key_desc TEXT', 'key_room TEXT']){
    try { sqlDb.run('ALTER TABLE exits ADD COLUMN ' + col); addedKeyCols = true; }
    catch(e){ /* already there */ }
  }
  let addedRandomCol = false;
  try { sqlDb.run('ALTER TABLE exits ADD COLUMN random INTEGER DEFAULT 0'); addedRandomCol = true; }
  catch(e){ /* already there */ }
  for(const col of ['norunto INTEGER DEFAULT 0', 'entry_note TEXT', 'entry_area TEXT',
                    'entry_x INTEGER', 'entry_y INTEGER']){
    try { sqlDb.run('ALTER TABLE areas ADD COLUMN ' + col); } catch(e){ /* already there */ }
  }
  // Aardwolf's own coordinates, straight off room.info. Distinct from rooms.x/y,
  // which this client derives from the exit graph for drawing. A refused runto
  // answers with a coordinate ("Coords 14,23"), so the game's own frame has to be
  // stored for that hint to be worth anything.
  for(const col of ['acoord_x INTEGER', 'acoord_y INTEGER', 'acoord_id INTEGER']){
    try { sqlDb.run('ALTER TABLE rooms ADD COLUMN ' + col); } catch(e){ /* already there */ }
  }

  seedAreas();   // minimal area keyword seed; /areas harvests the real list
  initInventory();

  // Load Gaardian map database (read-only reference, not persisted with user data)
  await loadGaardianDb();

  // Areas imported before the key columns existed still have the exits; only the
  // notes are missing. Fill those in rather than re-importing, which would undo
  // the room promotions.
  if(addedKeyCols){
    const n = backfillKeyNotes();
    if(n) appendOutput('[Gaardian] Added key notes to ' + n + ' exit(s)\n', 'system');
  }

  // Likewise for the random exits every earlier import threw away. Re-importing
  // the area would undo the room promotions, so add just the missing rows.
  if(addedRandomCol){
    const n = backfillRandomExits();
    if(n) appendOutput('[Gaardian] Restored ' + n + ' random exit(s) dropped by an earlier import\n', 'system');
  }

  // Rooms identified but never merged leave the map split in two at exactly the
  // boundary between the rooms you have walked and the ones you have not.
  const merged = promoteAnchoredRooms();
  if(merged) appendOutput('[Gaardian] Merged ' + merged + ' identified room(s) into the live map\n', 'system');
  const joined = reconnectDanglingExits();
  if(joined) appendOutput('[Gaardian] Joined ' + joined + ' room(s) our exits pointed at but the map held separately\n', 'system');

  // Aliases live in the table, not in state.js: seed the built-ins once, then
  // the table is the only source of truth so a deletion actually sticks.
  seedAliases();
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
  try {
    // Resolve properly rather than by LIKE: GMCP keywords have the spaces
    // squeezed out, and 249 of the 269 Gaardian names contain one.
    const areaid=gaardianAreaIdFor(name);
    if(areaid!=null){
      if(isAreaImported(areaid)) return true;      // already have it
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
        // That Gaardian room may already have been merged into a live one, in
        // which case the synthetic uid no longer exists and pathing to it fails.
        // Seen in The Land of Oz: the target was returned as gaardian:94:45
        // while the room itself was uid 583, one step west of where we stood.
        let uid=gaardianUid(areaid, local_id);
        try {
          const promoted=sqlDb.exec(
            'SELECT aardwolf_uid FROM room_gaardian_map WHERE gaardian_areaid=? AND gaardian_local_id=?',
            [areaid, local_id]);
          if(promoted.length && promoted[0].values.length) uid=String(promoted[0].values[0][0]);
        } catch(e){ /* keep the synthetic uid */ }
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

/**
 * The one name an area's rooms are stored under.
 *
 * `rooms.area` was written from whatever string the caller happened to hold:
 * GMCP's zone ("aardington") when walking in, but the campaign/Gaardian display
 * name ("aardington estate") when a room was resolved by name. The same area
 * then existed twice, so picking it in the map dropdown showed half its rooms
 * and the room you were standing in was often in the other half -- visible only
 * under "All Areas".
 *
 * GMCP's zone wins, because that is what live room.info writes and what
 * `runto` takes. `areas(name, key)` is populated from room.area (see gmcp.js).
 */
export function canonicalArea(name){
  const n = String(name || '').trim().toLowerCase();
  if(!n || !sqlDb) return n;
  try {
    const r = sqlDb.exec('SELECT key FROM areas WHERE name=? OR key=? LIMIT 1', [n, n]);
    const key = (r.length && r[0].values.length) ? r[0].values[0][0] : null;
    return key ? String(key).toLowerCase() : n;
  } catch(e){ return n; }
}

/** Fold rooms stored under an area's display name onto its canonical key. */
export function mergeAreaAliases(displayName, key){
  if(!sqlDb) return 0;
  const from = String(displayName || '').trim().toLowerCase();
  const to = String(key || '').trim().toLowerCase();
  if(!from || !to || from === to) return 0;
  try {
    const r = sqlDb.exec('SELECT COUNT(*) FROM rooms WHERE area=?', [from]);
    const n = r.length ? r[0].values[0][0] : 0;
    if(n) sqlDb.run('UPDATE rooms SET area=? WHERE area=?', [to, from]);
    return n;
  } catch(e){ return 0; }
}

export function importGaardianArea(gaardianAreaid, aardwolfAreaName, force){
  if(!sqlDb || !gaardianDb || !gaardianAreaid) return 0;
  // The guard belongs HERE, not in one caller. importGaardianAreaByName had its
  // own, `resolveAreaUid('keep of the kobaloi')`, which can never match because
  // rooms are stored under the canonical keyword ('kobaloi') -- so the area was
  // re-imported on every room lookup. Each re-import re-creates gaardian: rows
  // for rooms already promoted to live uids and re-inserts their exits, which
  // splits the graph in half underneath a walk that is already in progress: the
  // route to the Kobaloi throne room began with a step the room did not have.
  if(!force && isAreaImported(gaardianAreaid)) return 0;
  try {
    let areaName = canonicalArea(aardwolfAreaName || '');
    if(!areaName){
      const areaRes=gaardianDb.exec('SELECT areaname FROM areas WHERE areaid=?', [gaardianAreaid]);
      if(areaRes.length && areaRes[0].values.length){
        areaName=canonicalArea(String(areaRes[0].values[0][0]));
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

    // Exits FIRST, then promotion. The other way round, a room promoted here
    // had no Gaardian exits to merge yet, so its door and key columns -- the
    // note saying which pass you need and where to buy it -- were silently
    // lost for precisely the rooms you have stood in, the only ones that can
    // ever block you.
    const stats = importGaardianExits(gaardianAreaid);
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

    markAreaImported(gaardianAreaid);
    appendOutput(`[Gaardian] Imported ${inserted} rooms and ${stats.total} exits for ${areaName}`
      + (stats.custom ? ` (${stats.custom} custom, ${stats.doors} doors)` : '')
      + (stats.random ? `, ${stats.random} random` : '')
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

// Gaardian records how to get past a locked door or a guard -- what the key is,
// where to buy it and for how much -- in exits.key_desc/key_room. 882 exits
// across 132 areas carry one, and none of it was being read: a blocked walk
// could only say "the way is guarded" when the database already knew the answer.
// key_desc is a scrap of HTML; key_room is a reference of the form "rooms[12]".
function cleanKeyDesc(html){
  if(!html) return null;
  const t = String(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
  return t || null;
}

function resolveKeyRoom(areaid, ref){
  if(!ref) return null;
  const m = String(ref).match(/rooms\[(\d+)\]/i);
  if(!m) return String(ref);
  try {
    const r = gaardianDb.exec('SELECT roomname FROM rooms WHERE areaid=? AND local_id=?',
      [areaid, parseInt(m[1])]);
    if(r.length && r[0].values.length) return String(r[0].values[0][0]);
  } catch(e){ /* fall through to the raw reference */ }
  return null;
}

/**
 * Fill in key notes for areas imported before those columns existed.
 *
 * A plain re-import would undo the promotion work -- it re-creates gaardian:
 * rows for rooms already merged into live uids -- so this touches only the two
 * new columns, on both the skeleton uid and the promoted one.
 */
export function backfillKeyNotes(){
  if(!sqlDb || !gaardianDb) return 0;
  let n = 0;
  try {
    const areas = sqlDb.exec('SELECT areaid FROM gaardian_imported');
    for(const [areaid] of (areas[0]?.values || [])){
      const g = gaardianDb.exec(
        `SELECT from_room, exit_type, exit_action, key_name, key_desc, key_room
           FROM exits WHERE areaid=? AND key_desc IS NOT NULL AND key_desc!=''`, [areaid]);
      for(const [fromRoom, exitType, exitAction, keyName, keyDesc, keyRoom] of (g[0]?.values || [])){
        let dir = null;
        if(exitType >= 0 && exitType <= 5) dir = GAARDIAN_DIRS[exitType];
        else if(exitType === 6 && exitAction) dir = 'enter ' + String(exitAction).trim().toLowerCase();
        else if(exitType === 7 && exitAction) dir = String(exitAction).trim().toLowerCase();
        if(!dir) continue;
        const uids = [gaardianUid(areaid, fromRoom)];
        try {
          const m = sqlDb.exec(
            'SELECT aardwolf_uid FROM room_gaardian_map WHERE gaardian_areaid=? AND gaardian_local_id=?',
            [areaid, fromRoom]);
          if(m.length && m[0].values.length) uids.push(String(m[0].values[0][0]));
        } catch(e){ /* no map row yet */ }
        for(const u of uids){
          sqlDb.run(
            `UPDATE exits SET key_name=COALESCE(key_name, ?), key_desc=?, key_room=?
              WHERE from_uid=? AND dir=?`,
            [keyName || null, cleanKeyDesc(keyDesc), resolveKeyRoom(areaid, keyRoom), u, dir]);
          n++;
        }
      }
    }
  } catch(e){ console.error('backfillKeyNotes error', e); }
  return n;
}

/**
 * Add the random exits that earlier imports dropped.
 *
 * A re-import is not an option: importGaardianArea re-creates `gaardian:` rows
 * for rooms that have since been promoted to live uids, which splits the graph.
 * So insert only the missing edges, onto whichever uid each end now lives under.
 * INSERT OR IGNORE, because a row already there was observed from GMCP and an
 * observation beats Gaardian's sample.
 */
export function backfillRandomExits(){
  if(!sqlDb || !gaardianDb) return 0;
  let n = 0;
  // A room may have been promoted since import, so ask where each end lives now.
  const liveUid = (areaid, localId) => {
    try {
      const m = sqlDb.exec(
        'SELECT aardwolf_uid FROM room_gaardian_map WHERE gaardian_areaid=? AND gaardian_local_id=?',
        [areaid, localId]);
      if(m.length && m[0].values.length) return String(m[0].values[0][0]);
    } catch(e){ /* no map row */ }
    return gaardianUid(areaid, localId);
  };
  try {
    const areas = sqlDb.exec('SELECT areaid FROM gaardian_imported');
    for(const [areaid] of (areas[0]?.values || [])){
      const g = gaardianDb.exec(
        `SELECT from_room, to_room, exit_type, exit_action
           FROM exits WHERE areaid=? AND random=1 AND to_room IS NOT NULL`, [areaid]);
      for(const [fromRoom, toRoom, exitType, exitAction] of (g[0]?.values || [])){
        let dir = null;
        if(exitType >= 0 && exitType <= 5) dir = GAARDIAN_DIRS[exitType];
        else if(exitType === 6 && exitAction) dir = 'enter ' + String(exitAction).trim().toLowerCase();
        else if(exitType === 7 && exitAction) dir = String(exitAction).trim().toLowerCase();
        if(!dir) continue;
        sqlDb.run(
          `INSERT OR IGNORE INTO exits(from_uid, dir, to_uid, random) VALUES (?,?,?,1)`,
          [liveUid(areaid, fromRoom), dir, liveUid(areaid, toRoom)]);
        n++;
      }
    }
  } catch(e){ console.error('backfillRandomExits error', e); }
  return n;
}

export function importGaardianExits(gaardianAreaid){
  const stats = {total:0, custom:0, doors:0, skipped:0, random:0};
  const res = gaardianDb.exec(
    `SELECT from_room, to_room, exit_type, exit_action, target_areaid,
            door_type, key_name, random, key_desc, key_room
       FROM exits WHERE areaid=?`, [gaardianAreaid]);
  const rows = res[0]?.values || [];
  for(const [fromRoom, toRoom, exitType, exitAction, targetAreaid, doorType, keyName, random,
             keyDesc, keyRoom] of rows){
    // Random exits used to be dropped here, on the reasoning that you cannot
    // route through an exit whose destination you do not know. That is true of a
    // single step and false of the graph: in The Goblin Fortress the eight random
    // exits between "Fortress intersection" and the hallways are the ONLY link
    // between the entrance and the interior, so dropping them left 34 of 50 rooms
    // -- including every "The forgotten halls" room -- unreachable, and `/xcp`
    // reported "no route" for a mob sitting a few rooms away.
    //
    // They are kept and flagged instead. `to_uid` is one sample rather than a
    // fact, so the pathfinder breaks ties against them and the walker expects to
    // land somewhere else (see nav.js): re-pathing from wherever you come out is
    // exactly how you cross a maze.

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
      `INSERT OR REPLACE INTO exits(from_uid, dir, to_uid, level, door, key_name, key_desc, key_room, random)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [gaardianUid(gaardianAreaid, fromRoom), dir, toUid, level, door, keyName || null,
       cleanKeyDesc(keyDesc), resolveKeyRoom(gaardianAreaid, keyRoom), random ? 1 : 0]);
    stats.total++;
    if(random) stats.random++;
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
 * Carry a *certain* anchor outwards along the exits.
 *
 * Once a live room is known to be Gaardian room L, every one of its GMCP exits
 * resolves a neighbour for free: going `dir` from here reaches live room U, and
 * L's own `dir` exit reaches Gaardian room M, so U is M. Repeat breadth-first
 * and one confirmed room aligns the reachable part of the area.
 *
 * This is only ever seeded from a certain identification. Seeding it from a
 * guess is what previously corrupted the graph: promotion rewrites a room's
 * edges, so a wrong seed propagated the error across the whole area and the
 * walk died with "lost the route".
 */
function cascadeAnchors(seedUid, areaid, seedLocalId, areaName, now){
  const queue = [[String(seedUid), seedLocalId]];
  const seen = new Set([String(seedUid)]);
  let anchored = 0;
  while(queue.length && anchored < 500){
    const [uid, localId] = queue.shift();
    const gexits = new Map(gaardianExitsOf(areaid, localId));
    if(!gexits.size) continue;
    for(const [dir, toUid] of liveExitsOf(uid)){
      const target = String(toUid);
      if(target.startsWith('gaardian:') || seen.has(target)) continue;
      const m = gexits.get(dir);
      if(m == null) continue;
      seen.add(target);
      if(anchoredLocalId(target, areaid) != null){
        // Already identified -- but "identified" and "merged" are different
        // things, and an anchor recorded without its promotion leaves the
        // Gaardian row sitting there under its synthetic uid with nothing
        // pointing at it. Re-promoting is a no-op once the rows are one.
        promoteGaardianRoom(target, areaid, anchoredLocalId(target, areaid), areaName);
        continue;
      }
      recordAnchor(target, areaid, m, areaName, now);
      anchored++;
      queue.push([target, m]);
    }
  }
  return anchored;
}

export function promoteGaardianRoom(aardwolfUid, gaardianAreaid, gaardianLocalId, aardwolfAreaName){
  if(!sqlDb) return;
  const oldUid = gaardianUid(gaardianAreaid, gaardianLocalId);
  // The GMCP row wins on to_uid -- it is observed rather than inferred -- but it
  // carries no door or key information, and the merge below drops the Gaardian
  // row it collided with. That lost the "you need a pass, buy it here" note for
  // exactly the rooms you have actually stood in, which are the only ones you
  // can be blocked in. Keep those columns before they go.
  let carried = [];
  try {
    const r = sqlDb.exec('SELECT dir, door, key_name, key_desc, key_room FROM exits WHERE from_uid=?', [oldUid]);
    carried = r.length ? r[0].values : [];
  } catch(e){ /* nothing to carry */ }
  try {
    // Merge Gaardian-preloaded room into the real Aardwolf room record.
    sqlDb.run("UPDATE OR IGNORE rooms SET uid=? WHERE uid=?", [aardwolfUid, oldUid]);
    // Ensure the promoted room uses the Aardwolf area name
    if(aardwolfAreaName){
      sqlDb.run("UPDATE rooms SET area=? WHERE uid=?", [canonicalArea(aardwolfAreaName), aardwolfUid]);
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
    // Put the door and key columns back onto whichever row survived.
    for(const [dir, door, keyName, keyDesc, keyRoom] of carried){
      if(!door && !keyName && !keyDesc) continue;
      sqlDb.run(
        `UPDATE exits SET door=COALESCE(NULLIF(door,0), ?),
                          key_name=COALESCE(key_name, ?),
                          key_desc=COALESCE(key_desc, ?),
                          key_room=COALESCE(key_room, ?)
          WHERE from_uid=? AND dir=?`,
        [door || 0, keyName || null, keyDesc || null, keyRoom || null, aardwolfUid, dir]);
    }
  } catch(e){ console.error('promoteGaardianRoom error', e); }
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

// =============================================================================
// ROOM IDENTITY
// =============================================================================
//
// Matching a live Aardwolf room to its room in the Gaardian map is the hard part
// of using an imported map, because neither of the obvious keys identifies a
// room:
//
//   - Names repeat. Only 10,740 of the 22,362 Gaardian rooms (48%) have a name
//     unique within their own area. Aardington Estate alone has twelve called
//     "Path around the manor" and eight called "Catacombs".
//   - GMCP `coord` is the AREA's position on the world map, not the room's:
//     every room in the estate reports {x:38, y:25}, the same value `room.area`
//     carries. Verified against three different rooms.
//
// What does identify a room is the shape of the graph around it. GMCP publishes
// exits as {direction: neighbour-uid}, so every edge is a constraint tying two
// rooms together. So identification is constraint propagation: hold a SET of
// candidates per room, shrink it using every edge whose other end is known, and
// commit only when a set collapses to exactly one.
//
// Committing early is what breaks the map. Promotion rewrites a room's edges, so
// a wrong guess is unrecoverable and surfaces much later as a walk that sets off
// in the wrong direction. When nothing is conclusive we store the set and wait:
// the next room the player walks into usually settles it.

const DIR_OF_TYPE = {0:'n', 1:'e', 2:'s', 3:'w', 4:'u', 5:'d'};

/** [[dir, to_local_id], ...] for a Gaardian room, same-area compass exits only. */
function gaardianExitsOf(areaid, localId){
  try {
    const e = gaardianDb.exec(
      `SELECT exit_type, to_room FROM exits
        WHERE areaid=? AND from_room=?
          AND (target_areaid IS NULL OR target_areaid=0 OR target_areaid=?)
          AND (random IS NULL OR random=0)`,
      [areaid, localId, areaid]);
    return (e[0]?.values || [])
      .map(([t, to]) => [DIR_OF_TYPE[t], to])
      .filter(([d, to]) => d && to != null);
  } catch(e){ return []; }
}

function gaardianRoomName(areaid, localId){
  try {
    const r = gaardianDb.exec(
      'SELECT roomname FROM rooms WHERE areaid=? AND local_id=?', [areaid, localId]);
    return (r.length && r[0].values.length) ? r[0].values[0][0] : '';
  } catch(e){ return ''; }
}

function getCandidates(uid, areaid){
  try {
    const r = sqlDb.exec(
      'SELECT local_id FROM room_candidates WHERE uid=? AND areaid=?', [String(uid), areaid]);
    return r.length ? r[0].values.map(v => v[0]) : [];
  } catch(e){ return []; }
}

function putCandidates(uid, areaid, ids){
  try {
    sqlDb.run('DELETE FROM room_candidates WHERE uid=? AND areaid=?', [String(uid), areaid]);
    for(const id of ids){
      sqlDb.run('INSERT OR IGNORE INTO room_candidates(uid, areaid, local_id) VALUES (?,?,?)',
        [String(uid), areaid, id]);
    }
  } catch(e){ /* candidates are an optimisation, never load-bearing */ }
}

function clearCandidates(uid){
  try { sqlDb.run('DELETE FROM room_candidates WHERE uid=?', [String(uid)]); } catch(e){}
}

/**
 * Merge any room that is identified but not yet merged.
 *
 * `room_gaardian_map` says "live room X is Gaardian room Y". promoteGaardianRoom
 * is what makes that true in the graph -- one row, one set of edges. If the
 * anchor was written without the promotion, both rows survive, and the effect is
 * worse than never having identified the room at all:
 *
 *   Backstage (gaardian:319:26) is promoted to live uid 47057, so its exits move
 *   with it. Its `n` exit collides with the one GMCP observed -- n leads to
 *   47061 -- and the observed row wins, which is right. But room 27, the Star
 *   Dressing Room, had exactly one inbound edge: that one. It is now a row no
 *   edge reaches, under a uid nothing refers to, while 47061 is a uid with no
 *   row. Two halves of one room, and "no route" to a mob standing next door.
 *
 * Returns how many rooms were merged. Idempotent, so it can run on every load.
 */
export function promoteAnchoredRooms(){
  if(!sqlDb) return 0;
  let n = 0;
  try {
    // Only rows whose synthetic twin is still present need anything doing.
    const r = sqlDb.exec(
      `SELECT m.aardwolf_uid, m.gaardian_areaid, m.gaardian_local_id, r.area
         FROM room_gaardian_map m
         JOIN rooms r ON r.uid = 'gaardian:' || m.gaardian_areaid || ':' || m.gaardian_local_id`);
    for(const [uid, areaid, localId, area] of (r[0]?.values || [])){
      promoteGaardianRoom(String(uid), areaid, localId, area);
      n++;
    }
  } catch(e){ console.error('promoteAnchoredRooms error', e); }
  return n;
}

/**
 * Identify the rooms our own exits point at but that we have never stood in.
 *
 * An edge whose `to_uid` has no row in `rooms` is the map's ragged edge: GMCP
 * told us "north of here is 47061" without us ever going there. Meanwhile the
 * Gaardian import holds that room under a synthetic uid, with the name we path
 * by. Two halves of one room, and the join between them is pure deduction:
 *
 *   this room is Gaardian 26, Gaardian says 26's `n` is room 27,
 *   GMCP says this room's `n` is 47061,  therefore 47061 IS room 27.
 *
 * cascadeAnchors does this reasoning already, but only outward from a room at
 * the moment it is identified. Anything it did not reach then -- because the
 * room was anchored by another path, or the exit was learned afterwards -- stays
 * split forever, and walking cannot repair it: the edge that would re-identify
 * the room is the one the live observation replaced. The Star Dressing Room sat
 * one step north of a room the player was standing in, with `where` naming it
 * and the map holding it, and no route between them.
 *
 * So do the same deduction as a sweep over the ragged edge, which does not care
 * what order anything happened in. Returns how many rooms were joined up.
 */
export function reconnectDanglingExits(){
  if(!sqlDb || !gaardianDb) return 0;
  let fixed = 0;
  try {
    for(let round = 0; round < 3; round++){
      const r = sqlDb.exec(
        `SELECT e.from_uid, e.dir, e.to_uid
           FROM exits e LEFT JOIN rooms r ON r.uid = e.to_uid
          WHERE r.uid IS NULL AND e.to_uid NOT LIKE 'gaardian:%'`);
      const dangling = r[0]?.values || [];
      if(!dangling.length) break;
      let changed = 0;
      for(const [fromUid, dir, toUid] of dangling){
        const a = sqlDb.exec(
          'SELECT gaardian_areaid, gaardian_local_id FROM room_gaardian_map WHERE aardwolf_uid=?',
          [String(fromUid)]);
        if(!a.length || !a[0].values.length) continue;      // this end is not identified either
        const [areaid, localId] = a[0].values[0];
        const target = new Map(gaardianExitsOf(areaid, localId)).get(dir);
        if(target == null) continue;                        // Gaardian has no such exit
        const known = anchoredLocalId(String(toUid), areaid);
        if(known != null && known !== target) continue;     // conflicting evidence: leave it alone
        const synthetic = gaardianUid(areaid, target);
        const row = sqlDb.exec('SELECT area FROM rooms WHERE uid=?', [synthetic]);
        if(!row.length || !row[0].values.length) continue;  // already merged, or never imported
        recordAnchor(String(toUid), areaid, target, String(row[0].values[0][0] || ''),
                     new Date().toISOString());
        changed++;
      }
      fixed += changed;
      if(!changed) break;
    }
  } catch(e){ console.error('reconnectDanglingExits error', e); }
  return fixed;
}

/**
 * The Gaardian rooms a live room might still be, as uids the pathfinder can use.
 *
 * A room whose name repeats within its area -- "Backstage" is three rooms in The
 * Palace of Song -- cannot be identified on sight, so matchAardwolfToGaardian
 * deliberately records a candidate set instead of guessing. Correct, but it left
 * the room an island: no anchor means no edges into the imported area, so
 * findPath from it returned null and `/xcp` reported "no route" to a mob three
 * rooms away.
 *
 * The candidates are exactly the hypotheses worth pathing from. See planRoute
 * in nav.js, which walks the shortest of them; moving is itself what settles
 * which room this was.
 */
export function gaardianCandidateUids(uid){
  if(!sqlDb || !uid) return [];
  try {
    const r = sqlDb.exec('SELECT areaid, local_id FROM room_candidates WHERE uid=?', [String(uid)]);
    return (r[0]?.values || []).map(([areaid, localId]) => gaardianUid(areaid, localId));
  } catch(e){ return []; }
}

/** Every Gaardian room in this area with this name. */
function roomsNamed(areaid, roomName){
  try {
    const r = gaardianDb.exec(
      'SELECT local_id FROM rooms WHERE areaid=? AND roomname=? COLLATE NOCASE', [areaid, roomName]);
    return r.length ? r[0].values.map(v => v[0]) : [];
  } catch(e){ return []; }
}

/** What we currently believe about a live room: [L] if anchored, else its set. */
function knownIds(uid, areaid){
  const a = anchoredLocalId(uid, areaid);
  if(a != null) return [a];
  return getCandidates(uid, areaid);
}

/** Record a certain identification and merge the skeleton room into the live one. */
function recordAnchor(uid, areaid, localId, areaName, now){
  try {
    sqlDb.run(`INSERT OR REPLACE INTO room_gaardian_map
      (aardwolf_uid, gaardian_areaid, gaardian_local_id, gaardian_name, matched_at)
      VALUES (?,?,?,?,?)`,
      [String(uid), areaid, localId, gaardianRoomName(areaid, localId), now || new Date().toISOString()]);
  } catch(e){ /* the map row is a record, the promotion below is the effect */ }
  clearCandidates(uid);
  promoteGaardianRoom(String(uid), areaid, localId, areaName);
}

/**
 * Shrink a room's candidate set using every edge whose other end we know.
 *
 * Four constraints, applied in order of strength. Each only narrows -- a
 * constraint that would empty the set is treated as unreliable and skipped,
 * because GMCP omits closed exits and the imported data is not perfect.
 */
function narrowCandidates(uid, areaid, roomName, liveExits){
  const already = anchoredLocalId(uid, areaid);
  if(already != null) return [already];

  let ids = getCandidates(uid, areaid);
  if(!ids.length) ids = roomsNamed(areaid, roomName);
  if(ids.length <= 1) return ids;

  // Outbound edges, from GMCP and from anything already stored for this room.
  const out = new Map();
  if(liveExits){
    for(const [d, u] of Object.entries(liveExits)){
      if(u && String(u) !== '0' && String(u) !== '?') out.set(d, String(u));
    }
  }
  for(const [d, u] of liveExitsOf(uid)) if(!out.has(d)) out.set(d, String(u));

  const shrink = hits => { if(hits.length && hits.length < ids.length) ids = hits; };

  // 1. Going `dir` from here reaches a room we know: keep candidates whose own
  //    `dir` exit lands on one of that room's possibilities.
  for(const [dir, nbUid] of out){
    if(ids.length === 1) break;
    if(nbUid.startsWith('gaardian:')) continue;
    const allow = new Set(knownIds(nbUid, areaid));
    if(!allow.size) continue;
    shrink(ids.filter(L => gaardianExitsOf(areaid, L).some(([d, to]) => d === dir && allow.has(to))));
  }

  // 2. The same in reverse: some room we know says `dir` leads here.
  if(ids.length > 1){
    let inbound = [];
    try {
      const r = sqlDb.exec(
        "SELECT from_uid, dir FROM exits WHERE to_uid=? AND from_uid NOT LIKE 'gaardian:%'",
        [String(uid)]);
      inbound = r.length ? r[0].values : [];
    } catch(e){ /* no inbound edges recorded yet */ }
    for(const [fromUid, dir] of inbound){
      if(ids.length === 1) break;
      const fromIds = knownIds(String(fromUid), areaid);
      if(!fromIds.length) continue;
      const allow = new Set();
      for(const L of fromIds){
        for(const [d, to] of gaardianExitsOf(areaid, L)) if(d === dir) allow.add(to);
      }
      if(!allow.size) continue;
      shrink(ids.filter(i => allow.has(i)));
    }
  }

  // 3. A neighbour we have never anchored but whose NAME we know from having
  //    stood in it. This is the common case when you walk in from next door.
  if(ids.length > 1){
    for(const [dir, nbUid] of out){
      if(ids.length === 1) break;
      if(nbUid.startsWith('gaardian:')) continue;
      let nbName = null;
      try {
        const r = sqlDb.exec('SELECT name FROM rooms WHERE uid=?', [nbUid]);
        if(r.length && r[0].values.length) nbName = String(r[0].values[0][0] || '').toLowerCase();
      } catch(e){ /* neighbour not seen yet */ }
      if(!nbName) continue;
      shrink(ids.filter(L => gaardianExitsOf(areaid, L).some(([d, to]) =>
        d === dir && String(gaardianRoomName(areaid, to)).toLowerCase() === nbName)));
    }
  }

  // 4. Weakest: the set of exit directions. GMCP hides closed doors, so this can
  //    legitimately disagree -- hence shrink(), which ignores an empty result.
  if(ids.length > 1 && out.size){
    const want = [...out.keys()].sort().join(',');
    shrink(ids.filter(L => {
      const have = [...new Set(gaardianExitsOf(areaid, L).map(([d]) => d))].sort().join(',');
      return have === want;
    }));
  }

  return ids;
}

/**
 * Re-run narrowing over every still-ambiguous room in the area.
 *
 * Anchoring one room is new information for its neighbours, and for their
 * neighbours in turn. A few rounds of this is ordinary arc consistency and it is
 * what lets a single certain room resolve a whole corridor of identical ones.
 */
function reconcileArea(areaid, areaName, now){
  for(let round = 0; round < 4; round++){
    let changed = false;
    let uids = [];
    try {
      const r = sqlDb.exec('SELECT DISTINCT uid FROM room_candidates WHERE areaid=?', [areaid]);
      uids = r.length ? r[0].values.map(v => String(v[0])) : [];
    } catch(e){ return; }
    if(!uids.length) return;
    for(const uid of uids){
      let name = '';
      try {
        const r = sqlDb.exec('SELECT name FROM rooms WHERE uid=?', [uid]);
        if(r.length && r[0].values.length) name = String(r[0].values[0][0] || '');
      } catch(e){ continue; }
      const before = getCandidates(uid, areaid).length;
      const ids = narrowCandidates(uid, areaid, name, null);
      if(ids.length === 1){
        recordAnchor(uid, areaid, ids[0], areaName, now);
        cascadeAnchors(uid, areaid, ids[0], areaName, now);
        changed = true;
      } else if(ids.length && ids.length < before){
        putCandidates(uid, areaid, ids);
        changed = true;
      }
    }
    if(!changed) return;
  }
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

export function matchAardwolfToGaardian(uid, area, name, now, liveExits){
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

  const areaid = gaardianRoom.areaid;
  const known = anchoredLocalId(uid, areaid);
  if(known != null){ gaardianRoom.local_id = known; return gaardianRoom; }

  const ids = narrowCandidates(uid, areaid, name, liveExits);
  if(ids.length === 1){
    gaardianRoom.local_id = ids[0];
    recordAnchor(uid, areaid, ids[0], area, now);
    // One certain room resolves everything reachable from it, and that in turn
    // is new evidence for rooms still holding a candidate set.
    cascadeAnchors(uid, areaid, ids[0], area, now);
    reconcileArea(areaid, area, now);
  } else {
    // Still ambiguous: remember what is still possible instead of guessing. The
    // next room walked into normally settles it, and reconcileArea will pick
    // this room up then.
    putCandidates(uid, areaid, ids);
  }
  return gaardianRoom;
}

const squash = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Which Gaardian area is this? Takes either a GMCP zone keyword or a display
 * name.
 *
 * GMCP's zone has the spaces squeezed out -- `earthplane`, `landofoz`,
 * `crusaders` -- while Gaardian stores display names, and **249 of its 269 area
 * names contain a space**. The old `areaname LIKE '%earthplane%'` therefore
 * missed most areas outright, so no Gaardian data was ever imported for them:
 * the map held only the handful of rooms you had physically walked, and clicking
 * anything else on it said "no path found".
 *
 * `areas(name, key)` is populated from GMCP room.area, which hands us the exact
 * display name for the keyword, so that is tried first and is authoritative.
 */
// Words an area name carries that its keyword drops.
const AREA_STOPWORDS = new Set(['the', 'of', 'a', 'an', 'and', 'to', 'in']);

/**
 * True when `want` is this area's significant words concatenated in some order.
 *
 * 'songpalace' is "Palace" + "Song" reversed; 'goblinfortress' is "Goblin" +
 * "Fortress" in order with "The" dropped. Both are invisible to a substring
 * test. The length check first makes this cheap and keeps it strict -- every
 * word must be used exactly once, with nothing left over.
 */
function wordsConcatMatch(want, areaName){
  const all = String(areaName || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  const sig = all.filter(w => !AREA_STOPWORDS.has(w));
  if(!sig.length) return false;
  if(sig.reduce((n, w) => n + w.length, 0) !== want.length) return false;
  let rest = want;
  const pool = sig.slice();
  while(pool.length){
    const i = pool.findIndex(w => rest.startsWith(w));
    if(i < 0) return false;
    rest = rest.slice(pool[i].length);
    pool.splice(i, 1);
  }
  return rest === '';
}

export function gaardianAreaIdFor(areaName){
  if(!gaardianDb || !areaName) return null;
  const n = String(areaName).trim().toLowerCase();
  if(!n) return null;

  // 1. The display name GMCP gave us for this keyword (or vice versa).
  const names = [n];
  try {
    const r = sqlDb.exec('SELECT name, key FROM areas WHERE key=? OR name=? LIMIT 1', [n, n]);
    if(r.length && r[0].values.length){
      const [nm, key] = r[0].values[0];
      if(nm) names.unshift(String(nm).toLowerCase());
      if(key) names.push(String(key).toLowerCase());
    }
  } catch(e){ /* areas table is a hint, not a requirement */ }

  try {
    const all = gaardianDb.exec('SELECT areaid, areaname FROM areas');
    const rows = all[0]?.values || [];
    // 2. Exact match once punctuation and spaces are removed from both sides.
    for(const want of names.map(squash)){
      if(want.length < 3) continue;
      for(const [id, nm] of rows) if(squash(nm) === want) return id;
    }
    // 3. Containment either way -- 'landofoz' inside 'thelandofoz', or
    //    'aardington' as the start of 'aardingtonestate'.
    for(const want of names.map(squash)){
      if(want.length < 5) continue;
      for(const [id, nm] of rows){
        const s = squash(nm);
        if(s.includes(want) || want.includes(s)) return id;
      }
    }
    // 4. The keyword is the area's significant words in a different ORDER.
    //    GMCP calls The Palace of Song 'songpalace', which is neither an exact
    //    squash of it nor a substring in either direction, so without a
    //    harvested areas row the area was never matched at all: not imported,
    //    not anchored, no candidates, and every route into it "no route".
    //    Checked against all 269 Gaardian names: no collisions.
    for(const want of names.map(squash)){
      if(want.length < 5) continue;
      for(const [id, nm] of rows) if(wordsConcatMatch(want, nm)) return id;
    }
  } catch(e){ /* fall through */ }
  return null;
}

export function lookupGaardianRoom(areaName, roomName) {
  if (!gaardianDb || !areaName || !roomName) return null;
  try {
    const areaid = gaardianAreaIdFor(areaName);
    if (areaid == null) return null;
    // Exact name first; the LIKE is only for the odd trailing marker.
    const res = gaardianDb.exec(
      `SELECT areaid, local_id, roomname, xpos, ypos FROM rooms
        WHERE areaid=? AND (roomname=? COLLATE NOCASE OR roomname LIKE ? COLLATE NOCASE)
        ORDER BY (roomname=? COLLATE NOCASE) DESC LIMIT 5`,
      [areaid, roomName, `%${roomName}%`, roomName]);
    if (!res.length || !res[0].values.length) return null;
    const row = res[0].values[0];
    return { areaid: row[0], local_id: row[1], roomname: row[2], xpos: row[3], ypos: row[4] };
  } catch (e) {
    console.error('lookupGaardianRoom error', e);
    return null;
  }
}

// Alias persistence helpers
/**
 * Copy the built-in aliases into the table once, so the table can become the
 * only source of truth.
 *
 * `commandMap` in state.js ships a set of defaults, and loadAliasesFromDb used
 * to merge DB rows *on top* of them. Deleting a built-in alias therefore removed
 * the row and the in-memory copy but not the default, so it reappeared on the
 * next load -- deleting `spellup` never stuck. User-created aliases deleted fine,
 * which made the bug look intermittent.
 *
 * Guarded by a meta flag so deleting every alias does not re-seed them.
 */
export function seedAliases(){
  if(!sqlDb) return;
  try{
    const seeded = sqlDb.exec("SELECT v FROM meta WHERE k='aliases_seeded'");
    if(seeded.length && seeded[0].values.length) return;
    for(const [name, expansion] of Object.entries(commandMap)){
      // OR IGNORE: anything the user has already customised wins.
      sqlDb.run('INSERT OR IGNORE INTO aliases(name, expansion) VALUES (?,?)', [name, expansion]);
    }
    sqlDb.run("INSERT OR REPLACE INTO meta(k,v) VALUES ('aliases_seeded','1')");
    persistDb();
  }catch(e){ console.error('seedAliases error', e); }
}

export function loadAliasesFromDb(){
  if(!sqlDb) return;
  try{
    const rows=sqlDb.exec("SELECT name, expansion FROM aliases");
    // REPLACE the map rather than merging into it. Merging left every built-in
    // alias permanently undeletable (see seedAliases above).
    for(const k of Object.keys(commandMap)) delete commandMap[k];
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
  const name='aardmap-'+new Date().toISOString().slice(0,10)+'.db';
  if(isNativeHost()){
    // A blob URL with a download attribute is a silent no-op in a WebView.
    nativeSaveFile(name, data);
    appendOutput('Database exported.\n','system');
    return;
  }
  const blob=new Blob([data],{type:'application/octet-stream'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url; a.download=name; a.click();
  URL.revokeObjectURL(url);
  appendOutput('Database exported.\n','system');
}

export async function importDb(){
  if(isNativeHost()){
    // <input type=file> never opens a picker in a WebView either.
    try{
      const bytes=await nativeOpenFile('*/*');
      if(!bytes || !bytes.length){ appendOutput('[Import] Empty file\n','error'); return; }
      const SQL=await initSqlPromise;
      sqlDb=new SQL.Database(bytes);
      await persistDbNow();
      appendOutput('Database imported ('+bytes.length+' bytes)\n','system');
      renderRooms();
    }catch(e){
      appendOutput('[Import] '+(e && e.message ? e.message : e)+'\n','error');
    }
    return;
  }
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
