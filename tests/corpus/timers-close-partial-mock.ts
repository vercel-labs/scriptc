// Timeout.close() and the clear functions under a PARTIAL timer mock: the
// handle names exactly one queued timer, and closing it clears that timer
// whichever API created it. mock.timers.enable({ apis: ["setInterval"] })
// leaves clearTimeout unmocked, so close(), clearTimeout(interval) and
// interval[Symbol.dispose]() must still remove the mocked interval from
// the mock's queue instead of reaching the loop's timers; the same holds
// for a timeout cleared by clearInterval when only setTimeout is mocked.
// The clears answer the handle and a second close is a no-op.
import { mock } from "node:test";
import { setInterval as intervalTimer, clearInterval as unmockInterval } from "node:timers";

mock.timers.enable({ apis: ["setInterval"] });
let beats = 0;
const closed = setInterval(() => beats++, 100);
console.log("close chains", closed.close() === closed, closed.close() === closed);
mock.timers.tick(500);
console.log("closed interval", beats);

const viaClear = intervalTimer(() => beats++, 100);
mock.timers.tick(250);
console.log("running", beats);
clearTimeout(viaClear);
mock.timers.tick(500);
console.log("clearTimeout", beats);

const disposed = setInterval(() => beats++, 100);
disposed[Symbol.dispose]();
mock.timers.tick(500);
console.log("disposed", beats);

const still = setInterval(() => beats++, 100);
mock.timers.tick(150);
console.log("still", beats, still.hasRef());
still.close();
mock.timers.tick(500);
console.log("after close", beats);
mock.timers.reset();

mock.timers.enable({ apis: ["setTimeout"] });
let fired = 0;
const crossed = setTimeout(() => fired++, 50);
unmockInterval(crossed);
mock.timers.tick(200);
console.log("clearInterval on a timeout", fired);

const cancelled = setTimeout(() => fired++, 50);
cancelled.close();
mock.timers.tick(200);
console.log("closed timeout", fired);
const armed = setTimeout(() => fired++, 50);
mock.timers.tick(60);
console.log("armed timeout", fired, armed.hasRef());
mock.timers.reset();

// A loop timer armed before enable() is not a mock entry. Node's mocked
// clearTimeout only takes a timer from the mock's queue, so the real timer
// stays armed; Timeout.close() on it still clears the loop's timer.
const armedBefore = setTimeout(() => console.log("real timeout survived the mocked clear"), 1);
mock.timers.enable({ apis: ["setTimeout"] });
clearTimeout(armedBefore);
const closedReal = setTimeout(() => console.log("closed real timeout still ran"), 1);
closedReal.close();

// Symbol.dispose is the handle's own clear, so it works whatever the mock
// configuration: a real immediate is cleared while setInterval is mocked,
// and a mocked immediate leaves the queue while setImmediate is mocked.
mock.timers.reset();
mock.timers.enable({ apis: ["setInterval"] });
const realImmediate = setImmediate(() => console.log("disposed real immediate ran"));
realImmediate[Symbol.dispose]();
mock.timers.reset();
mock.timers.enable({ apis: ["setImmediate"] });
const mockImmediate = setImmediate(() => console.log("disposed mocked immediate ran"));
mockImmediate[Symbol.dispose]();
mock.timers.runAll();
mock.timers.reset();

// `using` disposes through the handle too (the mock interval is cleared
// while only setInterval is mocked).
mock.timers.enable({ apis: ["setInterval"] });
{
  using ticker = setInterval(() => console.log("using interval fired"), 100);
  console.log("using bound", ticker.hasRef());
}
mock.timers.tick(300);
mock.timers.reset();
