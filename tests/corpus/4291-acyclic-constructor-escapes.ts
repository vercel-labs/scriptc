// Fields that are only assigned in a constructor still form cycles when
// `this` escapes before (or while) they are assigned. Every class below
// declares only readonly reference fields, yet each instance ends up on a
// reference cycle. The compiler must keep these hierarchies on the cycle
// collector; the sanitized lane's RC audit fails if any dropped cycle leaks.
const ROUNDS = 300;

// 1. `this` stored directly into its own field.
class SelfLoop {
  readonly self: SelfLoop | null;
  readonly id: number;
  constructor(id: number) {
    this.id = id;
    this.self = this;
  }
}

// 2. `this` returned through a closure captured in the constructor.
class ViaClosure {
  readonly next: ViaClosure | null;
  constructor(make: (get: () => ViaClosure) => ViaClosure | null) {
    this.next = make(() => this);
  }
}

// 3. `this` escaping through a method call on itself.
class ViaMethod {
  readonly next: ViaMethod | null;
  constructor() {
    this.next = this.pick();
  }
  pick(): ViaMethod {
    return this;
  }
}

// 4. `this` passed to a helper that hands it back.
function identity<T>(value: T): T {
  return value;
}
class ViaHelper {
  readonly next: ViaHelper | null;
  constructor() {
    this.next = identity<ViaHelper>(this);
  }
}

// 5. A base constructor registers `this`; the derived constructor then
// reads it back from the registry into its own readonly field.
const registry: Registered[] = [];
class Registered {
  constructor() {
    registry.push(this);
  }
}
class Derived extends Registered {
  readonly peer: Registered | null;
  constructor() {
    super();
    this.peer = registry.pop() ?? null;
  }
}

// 6. A two-node cycle: the first node's constructor creates the second,
// handing it `this` before its own field is assigned.
class Ping {
  readonly pong: Pong;
  constructor() {
    this.pong = new Pong(this);
  }
}
class Pong {
  readonly ping: Ping;
  constructor(ping: Ping) {
    this.ping = ping;
  }
}

// 7. `this` captured by a local class-valued closure stored elsewhere.
const later: (() => Later)[] = [];
class Later {
  readonly back: Later | null;
  constructor(prev: Later | null) {
    this.back = prev;
    later.push(() => this);
  }
}

let seen = 0;
for (let i = 0; i < ROUNDS; i++) {
  const a = new SelfLoop(i);
  if (a.self === a) seen++;
  const b = new ViaClosure((get) => get());
  if (b.next === b) seen++;
  const c = new ViaMethod();
  if (c.next === c) seen++;
  const d = new ViaHelper();
  if (d.next === d) seen++;
  const e = new Derived();
  if (e.peer === e) seen++;
  const f = new Ping();
  if (f.pong.ping === f) seen++;
}
console.log("cycles", seen, "registry", registry.length);

let tail: Later | null = null;
for (let i = 0; i < ROUNDS; i++) tail = new Later(tail);
let back = 0;
for (let cur = tail; cur !== null; cur = cur.back) back++;
const first = later[0]!();
console.log("later", back, later.length, first.back === null);
// Close the loop: make the oldest entry's closure point at the newest one.
later[0] = () => tail!;
console.log("closed", later[0]!() === tail);
later.length = 0;
tail = null;
console.log("done", later.length, tail === null);
