// clearTimeout, clearInterval and clearImmediate on handles that may be
// undefined or null: an absent handle clears nothing, a present one clears
// its timer, as in Node. Covers a debounce that re-arms through
// `Timeout | undefined`, array elements read with `!`, intervals that
// clear themselves through an optional handle, and immediates.

const log: string[] = [];

// A debounce: each call clears the pending timer, which is undefined at first.
let pending: ReturnType<typeof setTimeout> | undefined;
function debounce(label: string, ms: number): void {
  clearTimeout(pending);
  pending = setTimeout(() => {
    log.push(`debounced ${label}`);
    pending = undefined;
  }, ms);
}
debounce("a", 20);
debounce("b", 20);
debounce("c", 5);

// Null-initialized handles, cleared before and after they are set.
let retry: ReturnType<typeof setTimeout> | null = null;
clearTimeout(retry);
retry = setTimeout(() => log.push("retry fired"), 1);
let cancelled: ReturnType<typeof setTimeout> | null = setTimeout(() => log.push("cancelled fired"), 1);
clearTimeout(cancelled);
cancelled = null;
clearTimeout(cancelled);

// Handles kept in an array, cleared through `!` element reads.
const handles = [setTimeout(() => log.push("kept 0"), 2)];
for (let i = 1; i < 6; i++) handles.push(setTimeout(() => log.push(`kept ${i}`), 2 + i));
for (let i = 1; i < handles.length; i += 2) clearTimeout(handles[i]!);

// An interval that clears itself through its optional handle.
let ticks = 0;
let ticker: ReturnType<typeof setInterval> | undefined;
clearInterval(ticker);
ticker = setInterval(() => {
  ticks++;
  if (ticks === 3) {
    clearInterval(ticker);
    ticker = undefined;
    log.push(`ticker stopped at ${ticks}`);
  }
}, 1);
let idle: ReturnType<typeof setInterval> | null = null;
clearInterval(idle);

// Immediates: an optional handle, cleared while pending and when absent.
let soon: ReturnType<typeof setImmediate> | undefined = setImmediate(() => log.push("soon fired"));
clearImmediate(soon);
soon = undefined;
clearImmediate(soon);
let later: ReturnType<typeof setImmediate> | null = setImmediate(() => log.push("later fired"));
const keep = later;
later = null;
clearImmediate(later);
console.log("kept immediate", keep !== null);

// A class that owns an optional timer.
class Poller {
  timer: ReturnType<typeof setTimeout> | undefined = undefined;
  runs = 0;
  start(): void {
    this.stop();
    this.timer = setTimeout(() => {
      this.runs++;
      log.push(`poller run ${this.runs}`);
      this.timer = undefined;
    }, 3);
  }
  stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
const poller = new Poller();
poller.stop();
poller.start();
poller.start();

setTimeout(() => {
  clearTimeout(pending);
  clearInterval(ticker);
  console.log(log.sort().join("\n"));
  console.log("pending", pending === undefined, "ticker", ticker === undefined, "runs", poller.runs);
}, 60);
