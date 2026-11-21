// The validation errors of node:util's command-line helpers and node:perf_hooks:
// util.parseArgs' ERR_PARSE_ARGS_INVALID_OPTION_VALUE and
// ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL, performance.measure's/mark's
// ERR_PERFORMANCE_INVALID_TIMESTAMP and
// ERR_PERFORMANCE_MEASURE_INVALID_OPTIONS, and util.throttle's
// ERR_THROTTLED rejection when the pending queue is full.
import { parseArgs, throttle } from "node:util";

const kind = (e) => (e instanceof TypeError ? "TypeError" : e instanceof RangeError ? "RangeError" : e instanceof SyntaxError ? "SyntaxError" : e instanceof Error ? "Error" : typeof e);
function shape(label, fn) {
  try {
    console.log(label, "ok", String(fn()));
  } catch (e) {
    console.log(label, kind(e), e.name, e.code, JSON.stringify(e.message));
  }
}

// A boolean option given a value and a string option missing its value.
shape("boolean value", () => parseArgs({ args: ["--flag=1"], options: { flag: { type: "boolean" } } }));
shape("string missing", () => parseArgs({ args: ["--name"], options: { name: { type: "string" } } }));
shape("string short missing", () => parseArgs({ args: ["-n"], options: { name: { type: "string", short: "n" } } }));
// A positional argument when positionals are not allowed.
shape("positional", () => parseArgs({ args: ["x"], allowPositionals: false }));
shape("positional after option", () => parseArgs({ args: ["--name", "v", "x"], options: { name: { type: "string" } }, allowPositionals: false }));

// Timestamps outside the valid range, and the option-combination check.
for (const [label, call] of [
  ["measure start", () => performance.measure("m", { start: -1, end: 1 })],
  ["measure duration", () => performance.measure("m", { start: 1, duration: -1 })],
  ["mark start", () => performance.mark("m", { startTime: -5 })],
  ["measure combination", () => performance.measure("m", { start: 1, end: 2, duration: 3 })],
]) {
  shape(label, call);
}
console.log("measure ok", performance.measure("m", { start: 1, end: 2 }).name);

// ERR_THROTTLED: a drop when the window is full, and one when the queue is
// full. Both are promise rejections, so the message and code are read from
// the rejection.
const settled = (promise) =>
  promise.then(
    (value) => `ok ${value}`,
    (error) => `${error.name} ${error.code} ${JSON.stringify(error.message)}`,
  );

const drop = throttle((x) => x, 1, 1000, { overflow: "drop" });
const dropFirst = drop(1);
const dropSecond = drop(2);
console.log("drop", await settled(dropFirst), await settled(dropSecond), drop.pendingCount);
drop.cancel();

const queue = throttle((x) => x, 1, 1000, { maxPending: 0 });
const queueFirst = queue(1);
const queueSecond = queue(2);
console.log("queue", await settled(queueFirst), await settled(queueSecond));
queue.cancel();
