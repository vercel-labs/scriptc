// setTimeout and setInterval delays typed `number | undefined`: an optional
// `ms?: number` passed on, a number[] element read (its storage keeps the
// out-of-range undefined), and a read past the end. Node converts the delay
// with ToNumber, so undefined is NaN and the timer waits the default 1ms,
// like an omitted delay. Timers sharing the 1ms bucket fire in registration
// order; the other timers report through a counter so wall-clock timing
// never decides the output.

interface RefreshOptions {
  label: string;
  timeoutMs?: number;
}

const DELAYS = [1, 5];
const firstBucket: string[] = [];
const events: string[] = [];
let pending = 0;

function track(): () => void {
  pending++;
  return () => {
    pending--;
    if (pending === 0) {
      console.log("1ms bucket:", firstBucket.join(", "));
      console.log("events:", events.sort().join(", "));
    }
  };
}

// An optional field passed on, absent and present; the handle form clears.
function schedule(options: RefreshOptions): ReturnType<typeof setTimeout> {
  const done = track();
  return setTimeout(() => {
    firstBucket.push(options.label);
    done();
  }, options.timeoutMs);
}
schedule({ label: "absent" });
schedule({ label: "one", timeoutMs: 1 });

// Element reads in statement position: in range, and past the end.
const doneFirst = track();
setTimeout(() => {
  firstBucket.push("DELAYS[0]");
  doneFirst();
}, DELAYS[0]);
const doneMissing = track();
setTimeout(() => {
  firstBucket.push("DELAYS[9]");
  doneMissing();
}, DELAYS[9]);

const cancelled = schedule({ label: "cancelled", timeoutMs: DELAYS[1] });
clearTimeout(cancelled);
pending--;

// A binding initialized from an element read.
const retry = DELAYS[1];
const doneRetry = track();
setTimeout(() => {
  events.push(`retry after ${retry}`);
  doneRetry();
}, retry);

// A guard that narrows the controller, not the delay.
function withTimeout(ms?: number): void {
  const controller = ms !== undefined ? new AbortController() : undefined;
  const done = controller ? track() : undefined;
  const timer = controller
    ? setTimeout(() => {
        controller.abort();
        events.push(`aborted ${controller.signal.aborted}`);
        done?.();
      }, ms)
    : undefined;
  if (timer === undefined) events.push("no timer");
}
withTimeout();
withTimeout(3);

// An interval with an optional delay, cleared through its handle.
function tickTwice(label: string, ms?: number): void {
  const done = track();
  let ticks = 0;
  const id = setInterval(() => {
    ticks++;
    if (ticks === 2) {
      clearInterval(id);
      events.push(`${label} ticked ${ticks}`);
      done();
    }
  }, ms);
}
tickTwice("default interval");
tickTwice("element interval", DELAYS[0]);

// The sleep idiom with an element delay.
async function sleepThenLog(): Promise<void> {
  const done = track();
  await new Promise((resolve) => setTimeout(resolve, DELAYS[0]));
  events.push("slept");
  done();
}
void sleepThenLog();

// A narrowed delay keeps the plain number path.
function narrowed(ms: number | undefined): void {
  if (ms === undefined) return;
  const done = track();
  setTimeout(() => {
    events.push(`narrowed ${ms + 1}`);
    done();
  }, ms);
}
narrowed(2);
narrowed(undefined);

console.log("scheduled", pending);

export {};
