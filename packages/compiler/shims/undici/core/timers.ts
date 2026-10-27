// undici 7.x's fast timers (lib/util/timers.js): one unref'd native timer
// ticking every 499 ms drives every headers/body timeout, so those fire on
// the first tick at least `delay` after the timer (re)started.
const RESOLUTION_MS = 1e3;
const TICK_MS = (RESOLUTION_MS >> 1) - 1;
const NOT_IN_LIST = -2;
const TO_BE_CLEARED = -1;
const PENDING = 0;
const ACTIVE = 1;

let fastNow = 0;
// The ticking native timer, held as its refresh closure.
let refreshTick: (() => void) | null = null;
const fastTimers: FastTimer[] = [];

function onTick(): void {
  fastNow += TICK_MS;
  let idx = 0;
  let len = fastTimers.length;
  while (idx < len) {
    const timer = fastTimers[idx]!;
    if (timer.state === PENDING) {
      timer.idleStart = fastNow - TICK_MS;
      timer.state = ACTIVE;
    } else if (timer.state === ACTIVE && fastNow >= timer.idleStart + timer.idleTimeout) {
      timer.state = TO_BE_CLEARED;
      timer.idleStart = -1;
      timer.onTimeout();
    }
    if (timer.state === TO_BE_CLEARED) {
      timer.state = NOT_IN_LIST;
      if (--len !== 0) fastTimers[idx] = fastTimers[len]!;
    } else {
      ++idx;
    }
  }
  fastTimers.length = len;
  // An idle tick stops; the next timer schedules a new one.
  if (fastTimers.length !== 0) refreshTimeout();
  else refreshTick = null;
}

function refreshTimeout(): void {
  const refresh = refreshTick;
  if (refresh !== null) {
    refresh();
  } else {
    const timeout = setTimeout(onTick, TICK_MS);
    timeout.unref();
    refreshTick = () => {
      timeout.refresh();
    };
  }
}

export class FastTimer {
  state: number;
  idleTimeout: number;
  idleStart: number;
  onTimeout: () => void;

  constructor(callback: () => void, delay: number) {
    this.state = NOT_IN_LIST;
    this.idleTimeout = delay;
    this.idleStart = -1;
    this.onTimeout = callback;
    this.refresh();
  }

  refresh(): void {
    if (this.state === NOT_IN_LIST) fastTimers.push(this);
    if (refreshTick === null || fastTimers.length === 1) refreshTimeout();
    this.state = PENDING;
  }

  clear(): void {
    this.state = TO_BE_CLEARED;
    this.idleStart = -1;
  }
}
