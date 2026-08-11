// sync.js -- share the learned map between this client and the others.
//
// Every client keeps its map in its own browser IndexedDB, so the phone and the
// PC learn the world separately. Rooms walked on one are simply absent on the
// other, and the expensive part -- which live room is which Gaardian room -- has
// to be earned twice. The relay holds a shared copy they merge through
// (see MAP SYNC in relay_minimal.py).
//
// The unit is the row, not the file. Uploading a database would make whichever
// client synced last the winner and silently discard the other one's mapping;
// merging rows means both sides end up with the union. A client pushes what it
// has learned since its last sync, the relay stamps those rows with a revision
// and returns every row stamped by anyone else since the revision this client
// last saw.
//
// What travels, and what does not:
//
//   rooms/exits    only rows for live Aardwolf uids. The `gaardian:<area>:<id>`
//                  rows are the imported reference skeleton -- both clients ship
//                  the same gaardian_maps.db and re-derive them for free, so
//                  sending them would be pure weight.
//   anchors        room_gaardian_map, the identifications. The whole point: this
//                  is what costs a walk to work out and what /navdiag reports.
//   areas          harvested runto keywords and entry hints.
//   mobs           sightings, merged on the larger seen_count.
//
//   room_candidates    NOT sent: hypotheses, not knowledge. Each client narrows
//                      its own from what it has actually seen, and importing
//                      another client's guesses would let a wrong one win.
//   gaardian_imported  NOT sent: it records what THIS client has imported. Sent,
//                      it would make a client believe it holds rooms it has
//                      never loaded, and skip the import that would fix that.
//   aliases/triggers/  NOT sent: user configuration rather than map data.
//   buttons            /export still moves those, deliberately and visibly.
//
// One known limitation: deletions do not travel. When the walker proves an exit
// does not exist it deletes the row; the other client still has it and will push
// it back. That is the safe direction to fail in -- a row is re-learned rather
// than lost -- and the walker deletes it again the first time it tries to use it.

import { sqlDb, persistDb, promoteAnchoredRooms, reconnectDanglingExits,
         dropContradictedAnchors } from './db.js';
import { appendOutput } from './ui.js';
import { isNativeHost } from './transport.js';

// Wire name -> local table, primary key, columns. Must agree with SYNC_TABLES in
// relay_minimal.py. `room_gaardian_map` travels as `anchors`.
const SPEC = [
  { wire: 'rooms', table: 'rooms', key: ['uid'],
    cols: ['uid','area','name','terrain','info','x','y','z','exits','noportal','norecall',
           'acoord_x','acoord_y','acoord_id','first_seen','last_visited'] },
  { wire: 'exits', table: 'exits', key: ['from_uid','dir'],
    cols: ['from_uid','dir','to_uid','level','door','key_name','key_desc','key_room','random'] },
  { wire: 'anchors', table: 'room_gaardian_map', key: ['aardwolf_uid'],
    cols: ['aardwolf_uid','gaardian_areaid','gaardian_local_id','gaardian_name','matched_at'] },
  { wire: 'areas', table: 'areas', key: ['name'],
    cols: ['name','key','minlvl','maxlvl','lock','nogo','norunto','entry_note','entry_area',
           'entry_x','entry_y','entry_landmark','entry_item'] },
  { wire: 'mobs', table: 'mobs', key: ['mob','area','room'],
    cols: ['mob','area','room','room_uid','seen_count','last_seen'] },
];

// Rows to send in one request. A well-walked map is tens of thousands of rows and
// a phone should not be asked to build one JSON body out of all of them; the
// relay pages its replies for the same reason and says when there is more.
const PUSH_CHUNK = 4000;
// How many request/reply rounds one /sync may take before it gives up. Each round
// strictly advances the watermark, so this is a backstop, not the mechanism.
const MAX_ROUNDS = 40;

/**
 * Where the relay is.
 *
 * In the browser the page came from the relay, so its own origin is right. In the
 * Android app the page is served from https://appassets.androidplatform.net by
 * the asset loader and the MUD socket is held natively -- there is no relay in
 * the request path at all -- so the address has to be configured. `/syncurl`
 * sets it; the default is the public tunnel, which is what the phone can reach.
 */
export function syncBase(){
  const saved = (() => { try { return localStorage.getItem('aard_sync_url') || ''; } catch(e){ return ''; } })();
  if(saved) return saved.replace(/\/+$/, '');
  if(isNativeHost()) return 'https://mud.bedok77.win';
  return location.origin;
}

export function setSyncBase(url){
  try {
    if(url) localStorage.setItem('aard_sync_url', String(url).replace(/\/+$/, ''));
    else localStorage.removeItem('aard_sync_url');
  } catch(e){ /* private mode: this session only */ }
}

function syncToken(){
  try { return localStorage.getItem('aard_sync_token') || ''; } catch(e){ return ''; }
}

export function setSyncToken(tok){
  try {
    if(tok) localStorage.setItem('aard_sync_token', String(tok));
    else localStorage.removeItem('aard_sync_token');
  } catch(e){ /* private mode: this session only */ }
}

// ---------------------------------------------------------------------------
// watermarks
// ---------------------------------------------------------------------------
// Two of them, and they measure different things:
//
//   sync_rev   the relay's revision counter as of our last pull. Theirs, opaque
//              to us, and the only thing that decides what we are sent.
//   sync_mark  the newest local timestamp we have already pushed. Ours, and it
//              decides what we send. It is a timestamp we wrote ourselves rather
//              than `now`, so a clock that disagrees with the relay's -- or with
//              the phone's -- cannot make us skip rows.

function metaGet(k, dflt){
  try {
    const r = sqlDb.exec('SELECT v FROM meta WHERE k=?', [k]);
    return (r.length && r[0].values.length) ? String(r[0].values[0][0]) : dflt;
  } catch(e){ return dflt; }
}

function metaSet(k, v){
  try { sqlDb.run('INSERT OR REPLACE INTO meta(k,v) VALUES (?,?)', [k, String(v)]); }
  catch(e){ /* meta is a cache of our own position, not load-bearing */ }
}

/** The newest "we learned this" timestamp anywhere in the local map. */
function localHighWater(){
  const q = (sql) => {
    try {
      const r = sqlDb.exec(sql);
      return (r.length && r[0].values.length) ? String(r[0].values[0][0] || '') : '';
    } catch(e){ return ''; }
  };
  return [
    q("SELECT MAX(COALESCE(last_visited,'')) FROM rooms"),
    q("SELECT MAX(COALESCE(matched_at,'')) FROM room_gaardian_map"),
    q("SELECT MAX(COALESCE(last_seen,'')) FROM mobs"),
  ].reduce((a, b) => (b > a ? b : a), '');
}

// ---------------------------------------------------------------------------
// collecting what to push
// ---------------------------------------------------------------------------
//
// The rooms worth sending are the ones something has happened to since the last
// sync: either we stood in one (last_visited moved) or we worked out which room
// it is (its anchor is new). A room's exits change only while you are in it, so
// the same predicate picks the exits out -- as a subquery rather than an IN list
// of uids, which on a first sync would be thousands of bound parameters.
const FRESH_ROOMS = `
  SELECT r.uid FROM rooms r
    LEFT JOIN room_gaardian_map m ON m.aardwolf_uid = r.uid
   WHERE r.uid NOT LIKE 'gaardian:%'
     AND (COALESCE(r.last_visited,'') > $mark OR COALESCE(m.matched_at,'') > $mark)`;

function selectFor(spec, mark){
  const cols = spec.cols.map(c => '"' + c + '"').join(', ');
  if(spec.wire === 'rooms'){
    return { sql: `SELECT ${cols} FROM rooms WHERE uid IN (${FRESH_ROOMS.replace(/\$mark/g, '?')})`,
             args: [mark, mark] };
  }
  if(spec.wire === 'exits'){
    return { sql: `SELECT ${cols} FROM exits WHERE from_uid NOT LIKE 'gaardian:%'`
                + ` AND from_uid IN (${FRESH_ROOMS.replace(/\$mark/g, '?')})`,
             args: [mark, mark] };
  }
  if(spec.wire === 'anchors'){
    return { sql: `SELECT ${cols} FROM room_gaardian_map WHERE COALESCE(matched_at,'') > ?`,
             args: [mark] };
  }
  if(spec.wire === 'mobs'){
    return { sql: `SELECT ${cols} FROM mobs WHERE COALESCE(last_seen,'') > ?`, args: [mark] };
  }
  // areas has no timestamp and is at most a few hundred rows -- the whole table
  // costs less than the machinery to work out which part of it moved. Only rows
  // that carry something learned, though: the seed is on every client already.
  return { sql: `SELECT ${cols} FROM areas WHERE key IS NOT NULL OR minlvl IS NOT NULL`
              + ` OR entry_note IS NOT NULL OR norunto=1 OR nogo=1`, args: [] };
}

/** Cheap content hash, so an unchanged table can be left out of the push. */
function digest(str){
  let h = 0x811c9dc5;
  for(let i = 0; i < str.length; i++){
    h ^= str.charCodeAt(i);
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return h.toString(16);
}

function collect(mark){
  const push = {};
  let total = 0;
  let areasSum = '';
  for(const spec of SPEC){
    const { sql, args } = selectFor(spec, mark);
    let values = [];
    try {
      const r = sqlDb.exec(sql, args);
      values = r.length ? r[0].values : [];
    } catch(e){ console.error('sync collect ' + spec.wire, e); continue; }
    if(!values.length) continue;
    const rows = values.map(row => {
      const o = {};
      spec.cols.forEach((c, i) => { o[c] = row[i]; });
      return o;
    });
    // areas is sent whole because it has no timestamp to filter on, which meant
    // every sync from every client wrote the same few hundred rows again and
    // bumped the shared revision -- so every other client then had something to
    // pull, forever, for nothing. Send it only when it has actually changed.
    if(spec.wire === 'areas'){
      areasSum = digest(JSON.stringify(rows));
      if(areasSum === metaGet('sync_areas_sum', '')) continue;
    }
    push[spec.wire] = rows;
    total += rows.length;
  }
  return { push, total, areasSum };
}

/** Split one push into bodies of at most PUSH_CHUNK rows, table boundaries kept. */
function pages(push){
  const out = [];
  let cur = {}, n = 0;
  for(const spec of SPEC){
    const rows = push[spec.wire] || [];
    for(let i = 0; i < rows.length; i += PUSH_CHUNK){
      const slice = rows.slice(i, i + PUSH_CHUNK);
      if(n && n + slice.length > PUSH_CHUNK){ out.push(cur); cur = {}; n = 0; }
      cur[spec.wire] = (cur[spec.wire] || []).concat(slice);
      n += slice.length;
    }
  }
  if(n) out.push(cur);
  return out.length ? out : [{}];
}

// ---------------------------------------------------------------------------
// applying what came back
// ---------------------------------------------------------------------------

function apply(pull){
  let n = 0;
  for(const spec of SPEC){
    const rows = pull[spec.wire];
    if(!Array.isArray(rows) || !rows.length) continue;
    const cols = spec.cols.map(c => '"' + c + '"').join(', ');
    const qs = spec.cols.map(() => '?').join(', ');
    const sql = `INSERT OR REPLACE INTO "${spec.table}" (${cols}) VALUES (${qs})`;
    for(const r of rows){
      if(!r || typeof r !== 'object') continue;
      // A row missing part of its key would be stored as a nonsense row rather
      // than merged onto anything.
      if(spec.key.some(k => r[k] === null || r[k] === undefined || r[k] === '')) continue;
      const args = spec.cols.map(c => (r[c] === undefined ? null : r[c]));
      try { sqlDb.run(sql, args); n++; } catch(e){ /* one bad row is not the batch */ }
    }
  }
  return n;
}

async function post(path, body){
  const headers = { 'Content-Type': 'application/json' };
  const tok = syncToken();
  if(tok) headers['X-Aard-Sync'] = tok;
  const resp = await fetch(syncBase() + path, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  if(!resp.ok){
    let detail = '';
    try { detail = (await resp.json()).error || ''; } catch(e){ /* not JSON */ }
    throw new Error('relay said ' + resp.status + (detail ? ': ' + detail : ''));
  }
  return resp.json();
}

let syncing = false;

/**
 * Push what we have learned, pull what everyone else has.
 *
 * `quiet` reports only when something actually moved -- for the automatic sync at
 * login, which should not put five lines on screen every time it finds nothing.
 */
export async function syncMap(opts){
  const quiet = !!(opts && opts.quiet);
  if(!sqlDb){ if(!quiet) appendOutput('[sync] no map database yet\n','error'); return false; }
  if(syncing){ if(!quiet) appendOutput('[sync] already running\n','system'); return false; }
  syncing = true;
  const say = (t, k) => appendOutput('[sync] ' + t + '\n', k || 'system');
  try {
    const mark = metaGet('sync_mark', '');
    // Read this BEFORE pulling: a pulled row can carry a newer timestamp than
    // anything we learned ourselves, and taking the mark afterwards would push
    // the watermark past our own unsent rows and lose them.
    const nextMark = localHighWater();
    const { push, total, areasSum } = collect(mark);
    const bodies = pages(push);

    let rev = parseInt(metaGet('sync_rev', '0'), 10) || 0;
    let sent = 0, received = 0, rounds = 0;
    for(let i = 0; i < bodies.length; i++){
      const out = await post('/sync', { since: rev, push: bodies[i] });
      rev = Number(out.rev) || rev;
      received += apply(out.pull || {});
      for(const k in (out.pushed || {})) sent += out.pushed[k];
      rounds++;
      // The relay pages its replies. Keep asking while it says there is more,
      // pushing nothing further, until it stops or the backstop trips.
      while(out.more && rounds < MAX_ROUNDS && i === bodies.length - 1){
        const nxt = await post('/sync', { since: rev, push: {} });
        rev = Number(nxt.rev) || rev;
        received += apply(nxt.pull || {});
        rounds++;
        out.more = nxt.more;
      }
    }

    metaSet('sync_rev', rev);
    if(nextMark) metaSet('sync_mark', nextMark);
    // Only after the exchange succeeded: a failed push must be retried, not
    // remembered as sent.
    if(areasSum) metaSet('sync_areas_sum', areasSum);

    if(received){
      // Incoming anchors are identifications, and an identification is only
      // useful once the row it names has been merged into the live graph. Same
      // three passes initDb runs, for the same reason.
      const bad = dropContradictedAnchors();
      const merged = promoteAnchoredRooms();
      const joined = reconnectDanglingExits();
      if(bad) say('ignored ' + bad + ' identification(s) the room name contradicts');
      if(merged) say('merged ' + merged + ' newly identified room(s) into the live map');
      if(joined) say('rejoined ' + joined + ' room(s) held separately');
    }
    if(received || sent) persistDb();

    if(!quiet || received || sent){
      say('sent ' + sent + ' row(s), received ' + received + ' row(s)'
        + (total > sent ? ' (' + total + ' offered)' : '')
        + '; relay revision ' + rev);
    }
    return true;
  } catch(e){
    const msg = (e && e.message) ? e.message : String(e);
    // A phone out of range of the relay is normal, not an error worth shouting
    // about at every login.
    appendOutput('[sync] ' + msg + '\n', quiet ? 'system' : 'error');
    return false;
  } finally {
    syncing = false;
  }
}

/** `/syncstatus` -- what the relay is holding, and whether we can reach it. */
export async function syncStatus(){
  try {
    const headers = {};
    const tok = syncToken();
    if(tok) headers['X-Aard-Sync'] = tok;
    const resp = await fetch(syncBase() + '/sync/status', { headers });
    if(!resp.ok) throw new Error('relay said ' + resp.status);
    const s = await resp.json();
    appendOutput('[sync] relay ' + syncBase() + ' revision ' + s.rev
      + (s.auth ? ' (token required)' : '') + '\n', 'system');
    for(const k of Object.keys(s.counts || {})){
      appendOutput('[sync]   ' + k + ': ' + s.counts[k] + '\n', 'system');
    }
    appendOutput('[sync] this client is at revision ' + metaGet('sync_rev', '0')
      + ', pushed up to ' + (metaGet('sync_mark', '') || '(nothing yet)') + '\n', 'system');
  } catch(e){
    appendOutput('[sync] ' + ((e && e.message) ? e.message : e) + '\n', 'error');
  }
}

/**
 * Forget where we had got to, so the next sync re-sends and re-reads everything.
 *
 * For the case where the two clients have diverged and you would rather pay for
 * a full exchange than work out which rows went missing.
 */
export function syncReset(){
  metaSet('sync_rev', '0');
  metaSet('sync_mark', '');
  metaSet('sync_areas_sum', '');
  persistDb();
  appendOutput('[sync] watermarks cleared; the next /sync exchanges everything\n','system');
}

// The automatic one. `noticeInGame` in net.js fires once per session, when the
// first prompt with hit points arrives -- which is the moment the character is
// actually in the world, and the moment the player asked for this to happen.
let loginSyncDone = false;
export function syncOnLogin(){
  if(loginSyncDone) return;
  loginSyncDone = true;
  // Let the login settle and the first room.info land before adding a few
  // hundred kilobytes of upload to the same moment.
  setTimeout(() => { syncMap({ quiet: true }); }, 3000);
}
