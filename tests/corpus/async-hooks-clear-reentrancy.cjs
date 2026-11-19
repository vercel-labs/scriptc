// A destroy hook that queues and clears timers and immediates while a
// timeout, an interval or an immediate is being cleared must not corrupt
// the timer heap or the immediate queue: the entry is taken out before the
// hook runs, and nothing the hook does can invalidate it afterwards.
'use strict';
const ah = require('async_hooks');

const scheduled = [];
let budget = 3;
let spareCleared = false;
const spare = setTimeout(() => scheduled.push('spare-ran'), 1000);
const hook = ah.createHook({
  destroy() {
    if (!spareCleared) {
      /* Clearing a different entry reorders the heap during the clear. */
      spareCleared = true;
      clearTimeout(spare);
    }
    if (budget === 0) return;
    budget--;
    /* Growing the timer heap from inside the hook is the other hazard; the
     * callback has nothing to report (its firing is host-timing dependent). */
    setTimeout(() => {}, 1);
    setImmediate(() => scheduled.push('immediate'));
  },
});
hook.enable();
const timeout = setTimeout(() => scheduled.push('timeout-ran'), 1000);
clearTimeout(timeout);
const interval = setInterval(() => scheduled.push('interval-ran'), 1000);
clearInterval(interval);
const immediate = setImmediate(() => scheduled.push('immediate-ran'));
clearImmediate(immediate);
setTimeout(() => {
  hook.disable();
  scheduled.sort();
  console.log('scheduled:', scheduled.join(','), '| budget:', budget, '| spare cleared:', spareCleared);
}, 10);
