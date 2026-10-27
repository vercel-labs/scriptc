// mock.timers lowers enable(), enable({ apis, now }), tick, runAll, reset,
// setTime and [Symbol.dispose](), on the module's `mock` and on t.mock, and
// timers/promises scheduler.wait(delay) lowers. The rest is refused, each
// with a named diagnostic: an apis list or options object that is not a
// literal, and the MockTimers object used as a value.
import { mock, test } from "node:test";
import { scheduler } from "node:timers/promises";

mock.timers.enable({ apis: ["setTimeout", "setInterval"], now: 10 }); // lowers
mock.timers.tick(5); // lowers
mock.timers.setTime(20); // lowers
mock.timers.runAll(); // lowers
mock.timers.reset(); // lowers

mock.timers.enable(); // lowers
mock.timers.enable({ apis: ["Date"] }); // lowers
mock.timers.enable({ apis: ["setTimeout", "setImmediate"] }); // lowers

const apis: ("setTimeout" | "setInterval")[] = ["setTimeout"];
mock.timers.enable({ apis }); // apis list that is not a literal

const options = { apis: ["setTimeout"] as const };
mock.timers.enable(options); // options object that is not a literal

const timers = mock.timers; // the object as a value
timers.tick(1);

test("t.mock.timers", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] }); // lowers
  t.mock.timers.tick(); // lowers
  t.mock.timers.enable({ apis: ["setTimeout"], now: new Date(0) }); // lowers
  t.mock.timers[Symbol.dispose](); // lowers
});

void scheduler.wait(1); // lowers
