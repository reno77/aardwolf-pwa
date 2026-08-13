// roomid.js -- deciding which Gaardian room a live Aardwolf room IS.
//
// Split out of db.js at 2064 lines, where this sat in the middle under a banner reading
// "ROOM IDENTITY" -- the file already knew it was a separate subject.
//
// It is the hard part of using an imported map, because neither obvious key identifies a
// room: Aardwolf's `num` is not in the Gaardian data at all, and names repeat by the dozen.
// So identity is treated as constraint propagation -- anchors that are certain, candidates
// that are still possible, and a cascade that narrows the candidates every time something
// new is learned. Everything here is about that: recording anchors, narrowing candidates,
// promoting a room once it is certain, and routing through the reference map while it is not.

import { canonicalArea, cleanExitAction, GAARDIAN_DIRS, gaardianDb, gaardianUid, importGaardianArea,
         isAreaImported, persistDb, sqlDb, IS_PROSE, UNTYPEABLE } from './db.js';
import { appendOutput } from './ui.js';

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
/** The name we recorded for a live room, or '' if we have never been in it. */
function liveRoomName(uid){
  try {
    const r = sqlDb.exec('SELECT name FROM rooms WHERE uid=?', [String(uid)]);
    return (r.length && r[0].values.length) ? String(r[0].values[0][0] || '') : '';
  } catch(e){ return ''; }
}

/**
 * Does the live room agree with the Gaardian room it is about to be called?
 *
 * Unknown live name means we have never stood there -- the row is a stub created
 * from someone else's exit -- and there is nothing to contradict, so allow it.
 * Two known names that differ is a contradiction, and the anchor is refused.
 */
function nameAgrees(uid, areaid, localId){
  const live = liveRoomName(uid).trim().toLowerCase();
  if(!live) return true;
  const ref = String(gaardianRoomName(areaid, localId) || '').trim().toLowerCase();
  if(!ref) return true;
  return live === ref;
}

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
      // The cascade is only as good as the two exit lists agreeing. Where they
      // do not -- Gaardian recorded an exit the game no longer has, or the game
      // grew one Gaardian never saw -- the two walks slip by a room and every
      // anchor after that is wrong. The room name is the cheap check: we have
      // stood in the live room, so we know what it is called, and Gaardian knows
      // what room M is called. If they disagree, this is not room M.
      //
      // Seen in Wedded Bliss, where "Decorated Path" was anchored to Gaardian
      // 124:2 "Comfrey Fountain". That severed the route to At the Band, and the
      // walker paced between two rooms because from each of them the only route
      // it could still see ran through the other.
      if(!nameAgrees(target, areaid, m)) continue;
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
 * Forget any identification the room's own name contradicts.
 *
 * An anchor records the Gaardian name it claimed at the time, and we know what
 * the live room is actually called, so a disagreement is a plain contradiction:
 * whatever produced it, this room is not that room. Dropping the anchor puts the
 * room back to "unidentified", where the candidate machinery can work on it,
 * instead of leaving a confident wrong answer that no later evidence overturns.
 *
 * Runs at load and is a no-op on a clean database.
 */
export function dropContradictedAnchors(){
  if(!sqlDb) return 0;
  try {
    const r = sqlDb.exec(
      `SELECT m.aardwolf_uid FROM room_gaardian_map m
         JOIN rooms r ON r.uid = m.aardwolf_uid
        WHERE m.gaardian_name IS NOT NULL AND TRIM(m.gaardian_name) <> ''
          AND r.name IS NOT NULL AND TRIM(r.name) <> ''
          AND LOWER(TRIM(r.name)) <> LOWER(TRIM(m.gaardian_name))`);
    const uids = (r.length ? r[0].values : []).map(v => v[0]);
    for(const u of uids){
      sqlDb.run('DELETE FROM room_gaardian_map WHERE aardwolf_uid=?', [u]);
    }
    return uids.length;
  } catch(e){ return 0; }
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
      // Every exit that leaves an IDENTIFIED room and lands on a room we have not
      // identified. The first version of this asked for a to_uid with no row at
      // all, which only caught neighbours never visited. But the split happens
      // just as readily between two rooms you have both stood in: promoting the
      // first one moves its Gaardian exits onto the live uid, GMCP wins the
      // directions it already knew, and the Gaardian destinations are left under
      // synthetic uids with nothing pointing at them.
      //
      // Seen in Hedgehogs' Paradise: standing in A flower garden, correctly
      // identified as gaardian:330:16, with only its two GMCP edges -- and both
      // "A grove of apple trees" rooms unreachable, though Gaardian connects all
      // 51 rooms of that area from room 16.
      const r = sqlDb.exec(
        `SELECT e.from_uid, e.dir, e.to_uid
           FROM exits e
           JOIN room_gaardian_map m  ON m.aardwolf_uid  = e.from_uid
           LEFT JOIN room_gaardian_map m2 ON m2.aardwolf_uid = e.to_uid
          WHERE m2.aardwolf_uid IS NULL AND e.to_uid NOT LIKE 'gaardian:%'`);
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
/**
 * Which Gaardian room a local uid is, or might be, as [areaid, local_id] pairs.
 *
 * Three sources, in descending confidence: a synthetic uid says so outright, an
 * anchor is a settled identification, and a candidate set is the surviving
 * hypotheses for a room whose name repeats.
 */
function gaardianIdsFor(uid){
  const s = String(uid || '');
  const syn = s.match(/^gaardian:(\d+):(\d+)$/);
  if(syn) return [[parseInt(syn[1]), parseInt(syn[2])]];
  const out = [];
  try {
    const r = sqlDb.exec(
      'SELECT gaardian_areaid, gaardian_local_id FROM room_gaardian_map WHERE aardwolf_uid=?', [s]);
    for(const [a, l] of (r[0]?.values || [])) out.push([a, l]);
  } catch(e){ /* no anchor */ }
  if(out.length) return out;
  try {
    const r = sqlDb.exec('SELECT areaid, local_id FROM room_candidates WHERE uid=?', [s]);
    for(const [a, l] of (r[0]?.values || [])) out.push([a, l]);
  } catch(e){ /* no candidates */ }
  return out;
}

/**
 * A route computed in the REFERENCE map rather than the local graph.
 *
 * This is the step that kept forcing a human into the loop. When promotion splits
 * the local graph -- its Gaardian exits move onto the live uid and GMCP wins the
 * directions it already knew, orphaning the rest -- findPath returns null even
 * though Gaardian itself connects the two rooms perfectly well. Every "no route"
 * of that shape was resolved by computing the path against gaardian_maps.db by
 * hand and typing the directions: `s s s s s e e e e` into The King's Royal Box,
 * which the walker could not produce and Gaardian could.
 *
 * So do that here. Both ends are resolved to Gaardian rooms (anchor, candidate or
 * synthetic uid), breadth-first inside the area, shortest over every candidate
 * pairing. Returns [{dir, uid:null}] for the walker to follow blind -- the uids
 * are deliberately absent, because a reference route says which way to go and
 * nothing about which live room you will land in.
 */
// The same weights nav.js applies, kept here rather than imported because nav.js
// imports this module. A command exit is worth 8 plain steps: it may want an item
// we are not carrying or a password the character was never told, which is a stall
// with nothing to recover from, so take the walk unless it is genuinely long.
const REF_CUSTOM_COST = 8;
const REF_RANDOM_COST = 25;
// A spoken password is near-last-resort: it needs area-quest knowledge the
// character may never have been told, and it fails silently, so there is nothing
// for the walker to react to. See isSpeechExit in nav.js.
const REF_SPEECH_COST = 40;
function refStepCost(dir, random){
  const d = String(dir);
  const base = d.length <= 1 ? 1 : (/^say\b/i.test(d) ? REF_SPEECH_COST : REF_CUSTOM_COST);
  return (random ? REF_RANDOM_COST : 0) + base;
}

export function gaardianPath(fromUid, toUid, maxDepth){
  if(!gaardianDb) return null;
  const froms = gaardianIdsFor(fromUid);
  const tos = gaardianIdsFor(toUid);
  if(!froms.length || !tos.length) return null;
  // A cost ceiling now, not a hop ceiling -- a 200-room walk still resolves and
  // there is room for the command exits some areas genuinely require.
  const depth = maxDepth || 400;
  let best = null, bestCost = Infinity;

  for(const [fArea, fLocal] of froms){
    for(const [tArea, tLocal] of tos){
      if(fArea !== tArea) continue;            // one area at a time; runto crosses them
      if(fLocal === tLocal) return [];
      // Backwards from the target, cheapest-first, so the first time we settle the
      // source we have the cheapest route -- the same cost model findPath uses, and
      // for the same reason. Hop-counting picked Kobold Siege Camp's `say glurpp`
      // teleport over a walk three steps longer; this fallback would have gone on
      // recommending it after findPath stopped.
      const cameFrom = new Map();              // local_id -> {dir, next}
      const best2 = new Map([[tLocal, 0]]);
      const settled = new Set();
      const buckets = new Map([[0, [tLocal]]]);
      let found = false;
      for(let cost = 0; cost <= depth && !found; cost++){
        const bucket = buckets.get(cost);
        if(!bucket) continue;
        buckets.delete(cost);
        const frontier = bucket.filter(u => !settled.has(u) && best2.get(u) === cost);
        for(const u of frontier) settled.add(u);
        if(settled.has(fLocal)){ found = true; break; }
        for(const to of frontier){
          let rows = [];
          try {
            // Random exits are usable, just costed against -- the same policy
            // findPath applies. Excluding them would make The Goblin Fortress
            // unroutable all over again: its eight random exits are the ONLY link
            // between the entrance and the interior.
            const r = gaardianDb.exec(
              `SELECT from_room, exit_type, exit_action, COALESCE(random,0) FROM exits
                WHERE areaid=? AND to_room=?
                  AND (target_areaid IS NULL OR target_areaid=0 OR target_areaid=?)
                ORDER BY exit_type ASC`,
              [fArea, to, fArea]);
            rows = r[0]?.values || [];
          } catch(e){ /* no rows */ }
          for(const [from, type, action, rnd] of rows){
            if(settled.has(from)) continue;
            const dir = dirForExit(type, action);
            if(!dir) continue;
            const next = cost + refStepCost(dir, rnd);
            if(next > depth) continue;
            const known = best2.get(from);
            if(known !== undefined && known <= next) continue;
            best2.set(from, next);
            cameFrom.set(from, {dir, next: to});
            if(!buckets.has(next)) buckets.set(next, []);
            buckets.get(next).push(from);
          }
        }
      }
      if(!found) continue;
      const path = [];
      let cur = fLocal;
      while(cur !== tLocal){
        const step = cameFrom.get(cur);
        if(!step) break;
        path.push({dir: step.dir, uid: null, random: false});
        cur = step.next;
      }
      // Compare candidate pairings by cost, not hop count -- otherwise the choice
      // between two possible identities for the same room reintroduces exactly the
      // preference this function just stopped applying.
      const cost = best2.get(fLocal);
      if(cur === tLocal && cost !== undefined && cost < bestCost){ best = path; bestCost = cost; }
    }
  }
  return best;
}

/** The command for a Gaardian exit row, or null if it is not typeable. */
function dirForExit(type, action){
  if(type >= 0 && type <= 5) return GAARDIAN_DIRS[type];
  const a = cleanExitAction(action);
  if(!a) return null;
  if(type === 6) return 'enter ' + a.toLowerCase();
  if(type === 7){
    const d = a.toLowerCase();
    return (UNTYPEABLE.test(d) || IS_PROSE.test(d)) ? null : d;
  }
  return null;
}

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
