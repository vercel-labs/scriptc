// A conveyor that never stops: every immediate queues the next one, so the
// queue is never empty at the end of a check phase. Callbacks still run once
// each, in the order they were queued, one phase after they were queued; an
// immediate cleared while it waits never runs, also when it was queued in an
// earlier phase than the one that clears it.
const TURNS = 6000;

let turn = 0;
let order = 0;
let ran = 0;
let extras = 0;
let cleared = 0;
let wronglyRan = 0;
let lateHandle: ReturnType<typeof setImmediate> | null = null;
const phases: Array<number> = [];

function note(tag: number): void {
  order = (order * 31 + tag) % 1000000007;
  ran++;
}

function belt(): void {
  note(turn % 97);
  turn++;
  if (turn % 250 === 0) {
    // Three more in this phase's queue: the middle one is cleared at once.
    const queuedAt = turn;
    setImmediate(() => {
      extras++;
      note(1000 + (queuedAt % 13));
      phases.push(turn - queuedAt);
    });
    const dropped = setImmediate(() => {
      wronglyRan++;
    });
    setImmediate(() => {
      extras++;
      note(2000 + (queuedAt % 13));
    });
    clearImmediate(dropped);
    cleared++;
  }
  if (lateHandle !== null) {
    // Queued behind this turn of the belt, in the phase before this one.
    clearImmediate(lateHandle);
    lateHandle = null;
    cleared++;
  }
  if (turn < TURNS) {
    setImmediate(belt);
    if (turn % 400 === 1) {
      // Waits in the queue behind the belt's next turn, which clears it.
      lateHandle = setImmediate(() => {
        wronglyRan++;
      });
    }
  } else {
    setImmediate(() => {
      const distinct = new Set(phases);
      console.log('turns ' + turn + ', callbacks ' + ran + ', extras ' + extras + ', cleared ' + cleared);
      console.log('ran after being cleared: ' + wronglyRan);
      console.log('order ' + order);
      console.log('an extra runs ' + [...distinct].join(',') + ' turn(s) of the belt after it was queued');
    });
  }
}

setImmediate(belt);

// A second, slower belt on the same queue: it queues its next step from a
// microtask of its own callback.
let slow = 0;
function slowBelt(): void {
  slow++;
  if (slow < 500) {
    queueMicrotask(() => {
      setImmediate(slowBelt);
    });
  } else {
    console.log('slow belt ' + slow + ' at turn ' + (turn > 0 ? 'later' : 'zero'));
  }
}
setImmediate(slowBelt);
