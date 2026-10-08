// A function keeps one identity when a slot with a different signature
// views it: strict equality, Object.is, searches, returns, optional slots
// and Map/Set keys all observe the original function, while bound
// copies, wrappers and other functions stay distinct.
function log(x: number): void {
  console.log("log", x);
}
const quiet = (x: number): void => {};

const wide: (x: number, i: number) => void = log;
console.log("wide", wide === log, log === wide, wide !== log, Object.is(wide, log));
console.log("other", wide === quiet, Object.is(wide, quiet));

function same(f: (x: number, i: number) => void, g: (x: number) => void): boolean {
  return f === g;
}
console.log("params", same(log, log), same(log, quiet), same(quiet, quiet));

function viaZero(f: (x: number) => void, g: () => void): boolean {
  return Object.is(f, g);
}
const noop = (): void => {};
console.log("zero", viaZero(noop, noop), viaZero(log, noop));

function widen(f: (x: number) => void): (x: number, i: number) => void {
  return f;
}
console.log("return", widen(log) === log, widen(log) === widen(log), widen(quiet) === widen(log));

const first: (x: number, i: number) => void = log;
const second: (x: number, i: number) => void = log;
console.log("twice", first === second, first === wide);

const handlers: ((x: number, i: number) => void)[] = [];
handlers.push(log);
handlers.push(quiet);
handlers.push(log);
console.log("array", handlers[0] === log, handlers[1] === quiet, handlers[1] === log);
console.log("search", handlers.includes(log), handlers.indexOf(quiet), handlers.lastIndexOf(log));
console.log("miss", handlers.includes((x: number) => {}), handlers.indexOf(noop));
const exact: ((x: number) => void)[] = [log, quiet];
console.log("exact", exact.indexOf(log), exact.lastIndexOf(quiet), exact.includes(quiet));

let slot: ((x: number, i: number) => void) | undefined = undefined;
console.log("unset", slot === log);
slot = log;
console.log("slot", slot === log, slot === quiet);
function optional(f?: (x: number, i: number) => void): string {
  return f === log ? "log" : f === quiet ? "quiet" : "none";
}
console.log("optional", optional(log), optional(quiet), optional());

const one = (): number => 1;
const either: () => number | string = one;
const loose: () => void = one;
console.log("result", either === one, loose === one, either === (() => 1));

const b1 = quiet.bind(null);
const b2 = quiet.bind(null);
console.log("bind", b1 === quiet, b1 === b2, b1 === b1);
const wrapper = (x: number): void => quiet(x);
const wideWrapper: (x: number, i: number) => void = wrapper;
const wideQuiet: (x: number, i: number) => void = quiet;
console.log("wrapper", wrapper === quiet, wideWrapper === wideQuiet, wideWrapper === wrapper);

const names = new Map<unknown, string>();
names.set(log, "log");
names.set(wideQuiet, "quiet");
console.log("map", names.get(wide), names.get(quiet), names.has(wrapper), names.size);
const seen = new Set<unknown>([wide]);
seen.add(log);
seen.add(wideWrapper);
console.log("set", seen.has(log), seen.has(wrapper), seen.has(quiet), seen.size);

[3, 4].forEach(log);
