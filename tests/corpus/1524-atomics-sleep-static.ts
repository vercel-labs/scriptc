// The RouteStore synchronous-sleep idiom, whole: a STATIC readonly class
// field holding `new Int32Array(new SharedArrayBuffer(4))`, slept on with
// Atomics.wait(buf, 0, 0, ms). This program has no notifying worker, so it times
// out — a true synchronous sleep. Timing facts are BOUNDED (slept at
// least ~ms, well under a generous ceiling), never exact tick counts.
// Plus the i32 element semantics (sign, ToInt32 wrap) and the static
// field's init-time visibility of earlier module bindings.
const SLEEP_MS = 120;

class Sleeper {
  private static readonly sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
  // A static initializer runs at the class statement's position, so the
  // module const above is already assigned.
  static readonly configuredMs = SLEEP_MS + 0;
  readonly label: string;
  constructor(label: string) {
    this.label = label;
  }
  syncSleep(ms: number): void {
    Atomics.wait(Sleeper.sleepBuffer, 0, 0, ms);
  }
}

const s = new Sleeper("nap");
console.log("static init saw the const:", Sleeper.configuredMs === 120, s.label);
const t0 = Date.now();
s.syncSleep(Sleeper.configuredMs);
const dt = Date.now() - t0;
console.log("slept at least ~120ms:", dt >= 110, "and under 5s:", dt < 5000);

// The wait's answers: not-equal short-circuits (no sleep), a matching
// expected value times out.
const buf = new Int32Array(new SharedArrayBuffer(8));
buf[1] = -5;
console.log(Atomics.wait(buf, 1, 0, 50), Atomics.wait(buf, 1, -5, 10));
const t1 = Date.now();
Atomics.wait(buf, 0, 123, 5000); // not-equal: returns immediately
console.log("no sleep on not-equal:", Date.now() - t1 < 4000);

// Int32Array semantics: sign round-trips, writes ToInt32-wrap, and the
// ordinary constructors work (length, array literal, copy).
console.log("i32:", buf[1], buf[0], buf.length);
const wrap = new Int32Array(2);
wrap[0] = 2147483648; // 2^31 wraps negative
wrap[1] = -2147483649; // wraps positive
console.log("wrap:", wrap[0], wrap[1]);
const seeded = new Int32Array([-1, 0, 7]);
console.log("seeded:", seeded[0], seeded[1], seeded[2], seeded.length);
const copied = new Int32Array(seeded);
copied[0] = 9;
console.log("copy independent:", seeded[0], copied[0]);
