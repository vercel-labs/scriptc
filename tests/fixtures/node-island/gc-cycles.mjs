// Cross-heap garbage cycles (scope-B NI-8), for node-island-gc.test.ts.
// Each iteration makes and drops one cycle of every shape: a native object
// holding an island emitter whose listener captures it, an island object
// holding a native closure that captures it, a native promise held by an
// island object that it settles with, an island WeakMap entry keyed by a
// native object whose value captures the key, and a native object of a
// shared module paired with an island object. Some cycles stay held
// by one side only (native roots, a native closure, island roots, an
// island WeakRef next to a native root, a pending promise); they must
// survive every collection and keep working. Usage: gc-cycles <n> [gc]
// (gc: force a full V8 collection every 64 iterations).
import { requireModule } from "@scriptc/node";
import { openSessions } from "./gc-cycles-sessions.mjs";

const lib = requireModule("./gc-cycles.cjs");
const peers = requireModule("./gc-cycles-peers.mjs");
const n = Number(process.argv[2] ?? "1000");
const forceGc = process.argv[3] === "gc";

class Holder {
  constructor(i) {
    this.i = i;
    this.hits = 0;
    this.ticker = new lib.Ticker();
    this.ticker.on("tick", (k) => {
      this.hits += k;
    });
  }
}

const nativeKept = [];
const closures = [];
const pending = [];
let sum = 0;
for (let i = 0; i < n; i++) {
  // 1. native -> island emitter -> native listener -> native
  const h = new Holder(i);
  h.ticker.tick(1);
  sum += h.hits;

  // 2. island object -> native closure -> island object
  const b = lib.box(i);
  b.cb = () => b.n + b.payload.length;
  sum += lib.call(b);

  // 3. island object -> native promise -> settled with the island object
  const o = lib.box(i);
  const np = new Promise((resolve) => {
    o.cb = () => resolve(o);
  });
  o.p = np;
  lib.call(o);
  sum += (await np).n;

  // 4. island WeakMap: native key -> island value -> native closure -> key
  const key = { i };
  const value = lib.box(i);
  value.cb = () => key.i;
  key.value = value;
  lib.remember(key, value);
  sum += lib.call(lib.recall(key));

  // 5. shared-module native session <-> island peer
  sum += peers.pair(i, i < 10000 && i % 967 === 0);

  // Some cycles stay reachable from one side only (the same ones for
  // every n of at least 10000, so what stays alive does not grow with n).
  const keep = i < 10000;
  if (keep && i % 997 === 0) nativeKept.push(h);
  if (keep && i % 991 === 0) closures.push(() => lib.call(b) + lib.call(key.value));
  if (keep && i % 983 === 0) lib.hold(o);
  if (keep && i % 977 === 0) {
    nativeKept.push(key);
    lib.watch(key);
  }
  if (keep && i % 971 === 0) {
    const d = lib.deferred();
    const ticker = new Holder(-i);
    pending.push(
      d.promise.then((v) => {
        ticker.ticker.tick(v);
        return ticker.hits;
      }),
    );
    lib.hold(d);
  }
  if (forceGc && i % 64 === 63) lib.fullGc();
}
lib.fullGc();
await new Promise((resolve) => setTimeout(resolve, 1));
lib.fullGc();

// Everything held from one side still works.
let check = 0;
for (const k of nativeKept) check += k instanceof Holder ? k.ticker.tick(2) && k.hits : lib.call(k.value);
for (const f of closures) check += f();
for (const o of lib.held) {
  if (o.resolve) o.resolve(3);
  else check += (await o.p).n + 1;
}
for (const p of pending) check += await p;
for (const s of openSessions()) check += s.send("again");
const watched = nativeKept.filter((k) => !(k instanceof Holder)).length;
console.log("sum", sum, "check", check, "watched alive", lib.alive(), "of", watched);
console.error(`peak rss ${lib.maxRss()} KiB`);
