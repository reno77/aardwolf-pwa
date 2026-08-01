// joystick.js -- the two on-screen movement sticks.
//
// Right stick = compass (n/s/e/w). Left stick = up/down.
//
// This replaces a touch/mouse implementation that read `e.touches[0]` -- the
// first touch anywhere on the document, not the one belonging to this stick.
// With both thumbs down (the normal way to play) the second stick computed its
// offset from the *other* thumb's coordinates, which put it far to the left of
// its own centre and made it send 'w' whichever way it was pushed. PointerEvents
// with setPointerCapture make each stick track exactly one pointer, and fold the
// duplicated mouse fallback into the same code path.

import { queueMove } from './net.js';

const MAX_DIST = 40;    // knob travel limit, px
const DEADZONE = 22;    // no direction inside this radius, px

// How much one axis must beat the other before a direction is accepted.
// With four equal 90-degree sectors, a push that is mostly south but drifting
// west crosses into the west sector well before it looks diagonal to the
// player, and the stick fires 'w' during a move meant to be 's'. Requiring a
// dominant axis leaves a neutral wedge either side of each diagonal in which
// nothing changes, so a sloppy push keeps doing what it was already doing.
const DOMINANCE = 1.6;          // ~32 degrees either side of each axis
// Samples the new direction must persist for before it is accepted.
const HYSTERESIS = 3;
// Floor on how often one press may emit, so a wobbling thumb cannot spam moves.
const MIN_REPEAT_MS = 250;

// One entry per stick. `pointerId` is null when the stick is idle.
const sticks = {
  right: { pointerId: null, cx: 0, cy: 0, dir: '', pending: '', frames: 0, lastEmit: 0 },
  left:  { pointerId: null, cx: 0, cy: 0, dir: '', pending: '', frames: 0, lastEmit: 0 },
};

function directionFor(side, dx, dy, dist) {
  if (dist <= DEADZONE) return '';
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (side === 'right') {
    // Screen coords: +y is down, so the southern sector is the positive one.
    if (ax >= ay * DOMINANCE) return dx > 0 ? 'e' : 'w';
    if (ay >= ax * DOMINANCE) return dy > 0 ? 's' : 'n';
    return '';    // in the neutral wedge: too diagonal to call
  }
  // Left stick is vertical-only, and wants the same dominance rule.
  if (ay < ax * DOMINANCE) return '';
  return dy < 0 ? 'u' : 'd';
}

function moveKnob(side, dx, dy) {
  const knob = document.querySelector('#joy-' + side + ' .joystick-knob');
  if (!knob) return;
  knob.style.transform = dx || dy
    ? `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`
    : 'translate(-50%,-50%)';
}

function emit(side, dir) {
  const s = sticks[side];
  if (!dir || dir === s.dir) return;    // still the committed direction
  const now = Date.now();
  if (now - s.lastEmit < MIN_REPEAT_MS) return;
  s.dir = dir;
  s.lastEmit = now;
  queueMove(dir);
  try {
    const box = document.getElementById('set-vibrate');
    if ('vibrate' in navigator && (!box || box.checked)) navigator.vibrate(15);
  } catch (e) { /* haptics are best-effort */ }
}

function onDown(e, side) {
  const s = sticks[side];
  if (s.pointerId !== null) return;            // already owned by another finger
  e.preventDefault();
  const joy = document.getElementById('joy-' + side);
  const rect = joy.getBoundingClientRect();
  s.pointerId = e.pointerId;
  s.cx = rect.left + rect.width / 2;
  s.cy = rect.top + rect.height / 2;
  s.dir = ''; s.pending = ''; s.frames = 0; s.lastEmit = 0;
  try { joy.setPointerCapture(e.pointerId); } catch (err) { /* not fatal */ }
  joy.classList.add('active');
}

function onMove(e, side) {
  const s = sticks[side];
  if (s.pointerId !== e.pointerId) return;     // not this stick's pointer
  e.preventDefault();

  let dx = e.clientX - s.cx;
  let dy = e.clientY - s.cy;
  const dist = Math.hypot(dx, dy);
  if (dist > MAX_DIST) { dx = (dx / dist) * MAX_DIST; dy = (dy / dist) * MAX_DIST; }
  moveKnob(side, dx, dy);

  // Re-aim continuously instead of latching the first sample past the deadzone,
  // but only commit to a direction the thumb actually holds. A roll through the
  // diagonal on the way out lands in the neutral wedge, where nothing changes,
  // rather than firing a stray move in the crossed sector.
  const dir = directionFor(side, dx, dy, dist);
  if (!dir) { s.pending = ''; s.frames = 0; return; }   // ambiguous: hold
  if (dir !== s.pending) { s.pending = dir; s.frames = 0; return; }
  if (++s.frames < HYSTERESIS) return;
  emit(side, dir);
}

function onUp(e, side) {
  const s = sticks[side];
  if (s.pointerId !== e.pointerId) return;
  const joy = document.getElementById('joy-' + side);
  try { joy.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
  s.pointerId = null;
  s.dir = ''; s.pending = ''; s.frames = 0;
  joy.classList.remove('active');
  moveKnob(side, 0, 0);
}

export function initJoysticks() {
  for (const side of ['right', 'left']) {
    const joy = document.getElementById('joy-' + side);
    if (!joy) continue;
    joy.addEventListener('pointerdown',   (e) => onDown(e, side), { passive: false });
    joy.addEventListener('pointermove',   (e) => onMove(e, side), { passive: false });
    joy.addEventListener('pointerup',     (e) => onUp(e, side),   { passive: false });
    joy.addEventListener('pointercancel', (e) => onUp(e, side),   { passive: false });
    // Capture normally keeps events coming until pointerup, but if the browser
    // drops the capture (element removed, gesture stolen) release the stick
    // rather than leaving it latched to a pointer that will never come back.
    joy.addEventListener('lostpointercapture', (e) => onUp(e, side));
  }
}

initJoysticks();
