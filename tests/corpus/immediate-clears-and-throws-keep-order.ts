// Immediates that never get their turn, and turns that end early. A timer
// drives turns in which every immediate is cleared before it can run; a
// crowd of immediates is queued in one turn and thinned by clearImmediate,
// unref and ref before it runs; a chain's callbacks all throw into the
// 'uncaughtException' listener. Whatever was cleared never runs, the rest
// runs once and in the order it was queued, and an immediate queued while
// the others run waits for the next turn of the loop.
const log: Array<string> = [];
let wronglyRan = 0;

function never(): void {
  wronglyRan++;
}

// 1. Turns of a timer: each queues immediates and clears them all.
const TURNS = 40;
let turns = 0;
let clearedInTurns = 0;
let deadHasRef = 0;

function quietTurn(): void {
  turns++;
  const handles: Array<ReturnType<typeof setImmediate>> = [];
  for (let i = 0; i < 30; i++) handles.push(setImmediate(never));
  // Front to back in even turns, back to front in odd ones.
  for (let i = 0; i < 30; i++) {
    const handle = handles[turns % 2 === 0 ? i : 29 - i]!;
    clearImmediate(handle);
    clearImmediate(handle);
    if (handle.hasRef()) deadHasRef++;
    if (handle.ref() !== handle || handle.unref() !== handle) deadHasRef++;
    clearedInTurns++;
  }
  if (turns < TURNS) {
    setTimeout(quietTurn, 1);
  } else {
    console.log('quiet turns ' + turns + ', cleared ' + clearedInTurns + ', dead handles with a ref ' + deadHasRef);
    crowd();
  }
}

// 2. A crowd queued in one turn, thinned before it runs.
const CROWD = 3000;

function crowd(): void {
  const handles: Array<ReturnType<typeof setImmediate>> = [];
  const ran: Array<number> = [];
  let expected = 0;
  let refs = 0;
  for (let i = 0; i < CROWD; i++) {
    handles.push(
      setImmediate(() => {
        ran.push(i);
        // A later one of this same phase, cleared from inside it.
        if (i % 11 === 2 && i + 5 < CROWD) clearImmediate(handles[i + 5]!);
        // One that already ran: nothing to clear.
        if (i > 0) clearImmediate(handles[i - 1]!);
      }),
    );
  }
  const live: Array<boolean> = [];
  for (let i = 0; i < CROWD; i++) live.push(true);
  for (let i = 0; i < CROWD; i++) {
    const handle = handles[(i * 7) % CROWD]!;
    const at = (i * 7) % CROWD;
    if (at % 3 === 0) {
      clearImmediate(handle);
      live[at] = false;
    } else if (at % 5 === 0) {
      handle.unref();
      if (at % 10 === 0) handle.ref();
    }
  }
  for (let i = 0; i < CROWD; i++) {
    if (handles[i]!.hasRef()) refs++;
  }
  // What the callbacks themselves clear, in the order they run.
  for (let i = 0; i < CROWD; i++) {
    if (!live[i]) continue;
    expected++;
    if (i % 11 === 2 && i + 5 < CROWD) live[i + 5] = false;
  }
  setImmediate(() => {
    let ordered = ran.length === expected;
    for (let i = 1; i < ran.length; i++) {
      if (ran[i - 1]! >= ran[i]!) ordered = false;
    }
    let ranCleared = 0;
    for (const i of ran) {
      if (!live[i]) ranCleared++;
    }
    console.log('crowd of ' + CROWD + ': ' + ran.length + ' ran, ' + refs + ' held a ref before, in order ' + ordered + ', cleared ones that ran ' + ranCleared);
    emptied();
  });
}

// 3. A phase whose first callback clears everything behind it and queues
// anew: the new immediate waits for the next turn, behind a timer that is due.
function emptied(): void {
  const behind: Array<ReturnType<typeof setImmediate>> = [];
  setImmediate(() => {
    log.push('clears');
    for (const handle of behind) clearImmediate(handle);
    setImmediate(() => {
      log.push('queued in the phase');
      console.log('emptied phase: ' + log.join(', '));
      throwing();
    });
    setTimeout(() => {
      log.push('timer');
    }, 1);
    const until = Date.now() + 8;
    while (Date.now() < until) {
      // The timer is due when the phase ends.
    }
  });
  for (let i = 0; i < 20; i++) behind.push(setImmediate(never));
}

// 4. Callbacks that throw: the listener takes each error, the rest of the
// phase and the immediates queued meanwhile still run, in order.
const THROWS = 150;
let thrown = 0;
let taken = 0;
let afterThrow = '';

function throwing(): void {
  process.on('uncaughtException', (error: unknown) => {
    taken += error instanceof Error ? error.message.length : 100;
  });
  setImmediate(() => {
    afterThrow += 'a';
    setImmediate(() => {
      afterThrow += 'd';
      thrower();
    });
    throw new Error('one');
  });
  setImmediate(() => {
    afterThrow += 'b';
  });
  const dropped = setImmediate(never);
  setImmediate(() => {
    afterThrow += 'c';
    throw new Error('three');
  });
  clearImmediate(dropped);
}

function thrower(): void {
  thrown++;
  if (thrown < THROWS) {
    setImmediate(thrower);
    if (thrown % 10 === 0) clearImmediate(setImmediate(never));
    throw new Error('step ' + (thrown % 10));
  }
  console.log('thrown ' + thrown + ', taken ' + taken + ', around the first throws ' + afterThrow);
  console.log('ran after being cleared: ' + wronglyRan);
}

setTimeout(quietTurn, 1);
