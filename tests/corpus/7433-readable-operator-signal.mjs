// The Readable operators pass their callbacks { signal } as the second
// argument; map and filter's signal aborts when the options' signal
// does, reduce's signal is aborted once reduce settles, and map may
// return any value.
import { Readable } from "node:stream";
const log = [];
log.push(JSON.stringify(await Readable.from([1, 2, 3]).map((n) => ({ n, sq: n * n })).toArray()));
log.push(JSON.stringify(await Readable.from(["a", "bb"]).map((s) => s.length).toArray()));
log.push(JSON.stringify(await Readable.from([1, 2]).map((n, { signal }) => `${n}:${signal.aborted}`).toArray()));
log.push(JSON.stringify(await Readable.from([1, 2, 3, 4]).filter(async (n, opts) => n % 2 === 0 && !opts.signal.aborted).toArray()));
log.push(String(await Readable.from([1, 2, 3]).reduce((acc, n, { signal }) => acc + n + (signal.aborted ? 100 : 0), 0)));
let kept;
await Readable.from([1]).reduce((acc, n, { signal }) => { kept = signal; return acc + n; }, 0);
log.push(`reduce signal after ${kept.aborted}`);
let mapKept;
await Readable.from([1]).map((n, { signal }) => { mapKept = signal; return n; }).toArray();
log.push(`map signal after ${mapKept.aborted}`);
const ac = new AbortController();
const events = [];
const p = Readable.from([1, 2, 3]).map(async (n, { signal }) => {
  signal.addEventListener("abort", () => events.push(`abort ${n}`));
  await new Promise((r) => setTimeout(r, 10));
  return n;
}, { signal: ac.signal }).toArray();
setTimeout(() => ac.abort(), 5);
try { await p; } catch (e) { log.push(`map aborted ${e.name}`); }
log.push(events.join(","));
const dyn = [Readable.from([4, 5])][0];
log.push(JSON.stringify(await dyn.map((n, { signal }) => n + Number(signal.aborted)).toArray()));
let seen = 0;
await Readable.from([5, 6]).forEach((n, { signal }) => { if (signal) seen++; });
log.push(`forEach ${seen}`);
log.push(String(await Readable.from([1, 2, 3]).some((n, { signal }) => n > 2 && !signal.aborted)));
log.push(String(await Readable.from([1, 2, 3]).find((n, { signal }) => n > 1 && !signal.aborted)));
log.push(String(await Readable.from([1, 2, 3]).every((n, { signal }) => n > 0 && !signal.aborted)));
// A callback forwarded through an untyped parameter gets { signal } too.
const mapWith = (fn) => Readable.from([1, 2]).map(fn).toArray();
log.push(JSON.stringify(await mapWith((n, { signal }) => `${n}:${signal.aborted}`)));
const reduceWith = (fn) => Readable.from([1, 2]).reduce(fn, 0);
log.push(String(await reduceWith((acc, n, { signal }) => acc + n + (signal.aborted ? 10 : 0))));
console.log(log.join("\n"));
