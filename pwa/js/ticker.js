// ticker.js -- one heartbeat the whole client can trust.
//
// See tick-worker.js for why: a hidden tab has its timers throttled to about one a
// minute, which starves anything paced by setTimeout. The automation needs a clock that
// keeps time whether or not anyone is looking at the page -- on a phone, nobody is.
//
// This is deliberately small: subscribers get called about once a second with the
// current time, and each decides for itself whether enough time has passed. That turns
// "did my timer fire?" into "how long has it been?", which is the question that still
// has a correct answer after a throttled hour.

import { appendOutput } from './ui.js';

let worker = null;
let failed = false;
const subs = new Set();

function fanOut(now){
  for(const fn of subs){
    try { fn(now); } catch(e){ console.error('ticker subscriber', e); }
  }
}

function start(){
  if(worker || failed) return;
  try {
    worker = new Worker('/static/js/tick-worker.js');
    worker.onmessage = (e) => fanOut(Number(e.data) || Date.now());
    worker.onerror = (e) => {
      console.error('tick worker failed', e);
      if(!failed){
        failed = true;
        worker = null;
        appendOutput('[tick] the heartbeat worker would not start; falling back to page\n'
          + '       timers, which a hidden tab will throttle.\n','error');
        setInterval(() => fanOut(Date.now()), 1000);
      }
    };
  } catch(e){
    failed = true;
    setInterval(() => fanOut(Date.now()), 1000);
  }
}

/** Call `fn(now)` about once a second, hidden tab or not. Returns an unsubscribe. */
export function onTick(fn){
  start();
  subs.add(fn);
  return () => subs.delete(fn);
}

/**
 * A self-pacing repeat: `fn` runs when at least `everyMs` has passed since it last did.
 *
 * Written against elapsed time rather than a timer, so a throttled stretch means one
 * late call rather than a lost one.
 */
export function onInterval(everyMs, fn){
  let last = 0;
  return onTick((now) => {
    if(now - last < everyMs) return;
    last = now;
    fn(now);
  });
}
