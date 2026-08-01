// buttons.js -- the editable shortcut row above the command input.
//
// The row used to be hardcoded <button onclick="sendCmd('...')"> markup in
// index.html: to change a shortcut you had to edit the page. It is now rendered
// from the `buttons` table, with the original set seeded once so nothing is lost
// on upgrade.
//
// Tap  = send the command (via sendCmd, so aliases and ';' sequences work).
// Hold = open the editor for that button (rename, re-bind, delete).
// '+'  = open the editor with blank fields.
//
// The row is only ever action buttons -- movement lives in the joysticks -- so
// there is nothing here that has to keep working for the walker.

import { persistDb, sqlDb } from './db.js';
import { sendCmd } from './net.js';
import { appendOutput } from './ui.js';

const LONG_PRESS_MS = 500;
// How far a finger may drag and still count as a press rather than a scroll of
// the row. Without this, flicking the row sideways from a button opens the
// editor instead of scrolling.
const MOVE_TOLERANCE = 10;

// The set that was hardcoded in index.html, in its original order.
const DEFAULTS = [
  ['Mb',  'attmarbu', 'combat'],
  ['Sp',  'attspi',   'combat'],
  ['Gn',  'attgreen', 'combat'],
  ['Sw',  'attsweep', 'combat'],
  ['He',  'heal',     'heal'],
  ['GC',  'gc',       ''],
  ['Fd',  'food',     ''],
  ['Bl',  'bless',    ''],
  ['SpU', 'spellup',  ''],
  ['Eq',  'eqsearch', ''],
  ['Rc',  'rec',      ''],
  ['Wn',  'wpn',      ''],
  ['W1',  'wear171',  ''],
  ['W2',  'wear200',  ''],
  ['Q',   'quest',    ''],
  ['CR',  'crr',      ''],
];

const STYLES = ['', 'combat', 'heal', 'dir'];

// null while the editor is adding a new button; otherwise the id being edited.
let editingId = null;

// One press at a time; a second finger on another button is ignored.
const press = { pointerId: null, id: null, timer: null, x: 0, y: 0, fired: false };

// =============================================================================
// STORAGE
// =============================================================================

/** Seed the default row, but only into a genuinely empty, never-seeded table. */
function seedButtons() {
  if (!sqlDb) return;
  try {
    const have = sqlDb.exec('SELECT COUNT(*) FROM buttons');
    if (have.length && have[0].values[0][0] > 0) {
      // Rows survived a schema rebuild; record that so an empty row later
      // (the user deleted every button) is not treated as "needs seeding".
      sqlDb.run("INSERT OR REPLACE INTO meta(k,v) VALUES ('buttons_seeded','1')");
      return;
    }
    const seeded = sqlDb.exec("SELECT v FROM meta WHERE k='buttons_seeded'");
    if (seeded.length && seeded[0].values.length) return;   // deliberately empty
    DEFAULTS.forEach(([label, cmd, cls], i) => {
      sqlDb.run('INSERT INTO buttons(label, cmd, cls, pos) VALUES (?,?,?,?)',
                [label, cmd, cls, i]);
    });
    sqlDb.run("INSERT OR REPLACE INTO meta(k,v) VALUES ('buttons_seeded','1')");
    persistDb();
  } catch (e) { console.error('[buttons] seed failed', e); }
}

function loadButtons() {
  if (!sqlDb) return [];
  try {
    const r = sqlDb.exec('SELECT id, label, cmd, cls FROM buttons ORDER BY pos, id');
    if (!r.length) return [];
    return r[0].values.map(([id, label, cmd, cls]) => ({ id, label, cmd, cls: cls || '' }));
  } catch (e) { return []; }
}

function buttonById(id) {
  if (!sqlDb) return null;
  try {
    const r = sqlDb.exec('SELECT id, label, cmd, cls FROM buttons WHERE id=?', [id]);
    if (!r.length || !r[0].values.length) return null;
    const [bid, label, cmd, cls] = r[0].values[0];
    return { id: bid, label, cmd, cls: cls || '' };
  } catch (e) { return null; }
}

// =============================================================================
// RENDER
// =============================================================================

export function renderButtons() {
  const row = document.getElementById('bottomrow');
  if (!row) return;
  row.innerHTML = '';
  const list = loadButtons();
  for (const b of list) {
    const el = document.createElement('button');
    el.textContent = b.label;
    if (b.cls) el.className = b.cls;
    el.dataset.id = String(b.id);
    el.title = b.cmd;          // desktop hover shows what it sends
    row.appendChild(el);
  }
  if (!list.length) {
    const hint = document.createElement('span');
    hint.style.cssText = 'color:var(--muted);font-size:11px;padding:0 4px;white-space:nowrap;';
    hint.textContent = 'No shortcuts — tap + to add one';
    row.appendChild(hint);
  }
}

// =============================================================================
// EDITOR
// =============================================================================

function openEditor(id) {
  const box = document.getElementById('btn-overlay');
  if (!box) return;
  editingId = id;
  const b = id == null ? null : buttonById(id);
  document.getElementById('btn-ed-title').textContent = b ? 'Edit Button' : 'New Button';
  document.getElementById('btn-ed-label').value = b ? b.label : '';
  document.getElementById('btn-ed-cmd').value   = b ? b.cmd : '';
  document.getElementById('btn-ed-cls').value   = b ? b.cls : '';
  document.getElementById('btn-ed-del').style.display = b ? '' : 'none';
  // Position is 1-based and shown as it reads on screen, left to right. A new
  // button defaults to the end of the row.
  const list = loadButtons();
  const idx = b ? list.findIndex(x => x.id === b.id) : -1;
  const last = list.length + (b ? 0 : 1);
  const pos = document.getElementById('btn-ed-pos');
  if (pos) { pos.value = String((idx < 0 ? list.length : idx) + 1); pos.max = String(last); }
  const ofEl = document.getElementById('btn-ed-pos-of');
  if (ofEl) ofEl.textContent = '(1 – ' + last + ')';
  box.classList.add('show');
  // Focusing the label lets a hardware keyboard type straight away; on mobile
  // it also raises the keyboard, which is what you want when adding a button.
  setTimeout(() => { try { document.getElementById('btn-ed-label').focus(); } catch (e) {} }, 30);
}

function closeEditor() {
  const box = document.getElementById('btn-overlay');
  if (box) box.classList.remove('show');
  editingId = null;
}

function saveEditor() {
  const label = document.getElementById('btn-ed-label').value.trim();
  const cmd   = document.getElementById('btn-ed-cmd').value.trim();
  let cls     = document.getElementById('btn-ed-cls').value;
  if (!STYLES.includes(cls)) cls = '';
  if (!label || !cmd) { appendOutput('Button needs both a label and a command.\n', 'error'); return; }
  if (!sqlDb) { appendOutput('Database not ready.\n', 'error'); return; }
  const wantPos = parseInt((document.getElementById('btn-ed-pos') || {}).value, 10);
  try {
    let id = editingId;
    if (editingId == null) {
      // New buttons land on the end, then move to wherever the field says.
      const r = sqlDb.exec('SELECT COALESCE(MAX(pos), -1) + 1 FROM buttons');
      const pos = r.length ? r[0].values[0][0] : 0;
      sqlDb.run('INSERT INTO buttons(label, cmd, cls, pos) VALUES (?,?,?,?)', [label, cmd, cls, pos]);
      const got = sqlDb.exec('SELECT last_insert_rowid()');
      id = got.length ? got[0].values[0][0] : null;
      appendOutput('Button added: ' + label + ' -> ' + cmd + '\n', 'system');
    } else {
      sqlDb.run('UPDATE buttons SET label=?, cmd=?, cls=? WHERE id=?', [label, cmd, cls, editingId]);
      appendOutput('Button saved: ' + label + ' -> ' + cmd + '\n', 'system');
    }
    if (id != null) moveTo(id, wantPos);
    persistDb();
  } catch (e) {
    appendOutput('Could not save button: ' + e + '\n', 'error');
    return;
  }
  closeEditor();
  renderButtons();
}

/**
 * Move `id` to 1-based position `wanted`, then renumber the whole row.
 *
 * Renumbering every row rather than nudging one `pos` keeps the sequence dense,
 * so positions stay predictable after inserts and deletes and there is never a
 * tie for ORDER BY to resolve arbitrarily.
 */
function moveTo(id, wanted) {
  const order = loadButtons().map(b => b.id).filter(x => x !== id);
  let at = (isNaN(wanted) ? order.length + 1 : wanted) - 1;
  at = Math.max(0, Math.min(at, order.length));
  order.splice(at, 0, id);
  order.forEach((bid, n) => sqlDb.run('UPDATE buttons SET pos=? WHERE id=?', [n, bid]));
}

function deleteEditor() {
  if (editingId == null) { closeEditor(); return; }
  const b = buttonById(editingId);
  try {
    sqlDb.run('DELETE FROM buttons WHERE id=?', [editingId]);
    // Close the gap the delete left, so the position field keeps meaning
    // "nth button from the left".
    loadButtons().forEach((b, n) => sqlDb.run('UPDATE buttons SET pos=? WHERE id=?', [n, b.id]));
    persistDb();
    appendOutput('Button deleted: ' + (b ? b.label : editingId) + '\n', 'system');
  } catch (e) {
    appendOutput('Could not delete button: ' + e + '\n', 'error');
  }
  closeEditor();
  renderButtons();
}

// =============================================================================
// PRESS HANDLING
// =============================================================================

function buzz(ms) {
  try {
    const box = document.getElementById('set-vibrate');
    if ('vibrate' in navigator && (!box || box.checked)) navigator.vibrate(ms);
  } catch (e) { /* haptics are best-effort */ }
}

function cancelPress() {
  if (press.timer) { clearTimeout(press.timer); press.timer = null; }
  const el = press.id == null ? null : document.querySelector('#bottomrow button[data-id="' + press.id + '"]');
  if (el) el.classList.remove('pressing');
  press.pointerId = null;
  press.id = null;
}

function onDown(e) {
  const el = e.target.closest('button[data-id]');
  if (!el || press.pointerId !== null) return;
  press.pointerId = e.pointerId;
  press.id = el.dataset.id;
  press.x = e.clientX; press.y = e.clientY;
  press.fired = false;
  el.classList.add('pressing');
  press.timer = setTimeout(() => {
    press.timer = null;
    press.fired = true;                 // suppresses the tap on pointerup
    el.classList.remove('pressing');
    buzz(25);
    openEditor(parseInt(press.id, 10));
  }, LONG_PRESS_MS);
}

function onMove(e) {
  if (press.pointerId !== e.pointerId || !press.timer) return;
  if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_TOLERANCE) {
    // Treat it as a scroll of the row: no edit, and no send on release either.
    press.fired = true;
    cancelPress();
  }
}

function onUp(e) {
  if (press.pointerId !== e.pointerId) return;
  const id = press.id;
  const fired = press.fired;
  cancelPress();
  if (fired) return;                    // long press already handled it
  const b = id == null ? null : buttonById(parseInt(id, 10));
  if (b) sendCmd(b.cmd);
}

function onCancel(e) {
  if (press.pointerId !== e.pointerId) return;
  press.fired = true;
  cancelPress();
}

// =============================================================================
// INIT
// =============================================================================

export function initButtons() {
  seedButtons();
  renderButtons();

  const row = document.getElementById('bottomrow');
  if (row) {
    // Delegated, so buttons re-rendered after an edit need no re-wiring.
    row.addEventListener('pointerdown', onDown);
    row.addEventListener('pointermove', onMove);
    row.addEventListener('pointerup', onUp);
    row.addEventListener('pointercancel', onCancel);
    row.addEventListener('pointerleave', onCancel);
    // A long press on a <button> otherwise raises the platform callout menu on
    // top of our editor.
    row.addEventListener('contextmenu', (ev) => ev.preventDefault());
  }

  const add = document.getElementById('btn-add');
  if (add) add.addEventListener('click', () => openEditor(null));

  const wire = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
  wire('btn-ed-save', saveEditor);
  wire('btn-ed-del', deleteEditor);
  wire('btn-ed-cancel', closeEditor);

  const overlay = document.getElementById('btn-overlay');
  if (overlay) {
    // Tapping the backdrop dismisses; taps inside the box must not.
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) closeEditor(); });
  }
  for (const id of ['btn-ed-label', 'btn-ed-cmd', 'btn-ed-pos']) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); saveEditor(); }
      if (ev.key === 'Escape') { ev.preventDefault(); closeEditor(); }
    });
  }
}
