// Emitted constructors inline the small-object allocator's fast paths
// (llvm/alloc.ts): free-list reuse must clear every byte the constructor
// does not store, size classes must follow the object size, objects above
// the largest class must round-trip through the system allocator, and
// weak observers must still see every disposal.

class Opt {
  a: number;
  b?: string;
  c?: number[];
  d: string | undefined;
  constructor(a: number) {
    this.a = a;
  }
}

function recycleOptional(): void {
  let seen = "";
  for (let i = 0; i < 5; i++) {
    const o = new Opt(i);
    // A fresh object must not see the previous (recycled) block's fields.
    seen += `${o.b === undefined}/${o.c === undefined}/${o.d === undefined} `;
    o.b = "s" + i;
    o.c = [i, i + 1];
    o.d = "d" + i;
  }
  console.log("optional", seen.trim());
}

interface Small { x: number }
interface Mid { x: number; y: number; z: number; w: number; tag?: string }

function recordSizes(): void {
  let total = 0;
  let tags = 0;
  for (let i = 0; i < 20000; i++) {
    const s: Small = { x: i };
    const m: Mid = i % 3 === 0 ? { x: i, y: 1, z: 2, w: 3, tag: "t" } : { x: i, y: 2, z: 3, w: 4 };
    total += s.x + m.y + m.z + m.w;
    if (m.tag !== undefined) tags++;
  }
  console.log("records", total, tags);
}

class Big {
  f0: number;
  f1: number;
  f2: number;
  f3: number;
  f4: number;
  f5: number;
  f6: number;
  f7: number;
  f8: number;
  f9: number;
  f10: number;
  f11: number;
  f12: number;
  f13: number;
  f14: number;
  f15: number;
  f16: number;
  f17: number;
  f18: number;
  f19: number;
  f20: number;
  f21: number;
  f22: number;
  f23: number;
  f24: number;
  f25: number;
  f26: number;
  f27: number;
  f28: number;
  f29: number;
  f30: number;
  f31: number;
  f32: number;
  f33: number;
  f34: number;
  f35: number;
  f36: number;
  f37: number;
  f38: number;
  f39: number;
  f40: number;
  f41: number;
  f42: number;
  f43: number;
  f44: number;
  f45: number;
  f46: number;
  f47: number;
  f48: number;
  f49: number;
  f50: number;
  f51: number;
  f52: number;
  f53: number;
  f54: number;
  f55: number;
  f56: number;
  f57: number;
  f58: number;
  f59: number;
  f60: number;
  f61: number;
  f62: number;
  f63: number;
  f64: number;
  f65: number;
  f66: number;
  f67: number;
  f68: number;
  f69: number;
  constructor(seed: number) {
    this.f0 = seed + 0;
    this.f1 = seed + 1;
    this.f2 = seed + 2;
    this.f3 = seed + 3;
    this.f4 = seed + 4;
    this.f5 = seed + 5;
    this.f6 = seed + 6;
    this.f7 = seed + 7;
    this.f8 = seed + 8;
    this.f9 = seed + 9;
    this.f10 = seed + 10;
    this.f11 = seed + 11;
    this.f12 = seed + 12;
    this.f13 = seed + 13;
    this.f14 = seed + 14;
    this.f15 = seed + 15;
    this.f16 = seed + 16;
    this.f17 = seed + 17;
    this.f18 = seed + 18;
    this.f19 = seed + 19;
    this.f20 = seed + 20;
    this.f21 = seed + 21;
    this.f22 = seed + 22;
    this.f23 = seed + 23;
    this.f24 = seed + 24;
    this.f25 = seed + 25;
    this.f26 = seed + 26;
    this.f27 = seed + 27;
    this.f28 = seed + 28;
    this.f29 = seed + 29;
    this.f30 = seed + 30;
    this.f31 = seed + 31;
    this.f32 = seed + 32;
    this.f33 = seed + 33;
    this.f34 = seed + 34;
    this.f35 = seed + 35;
    this.f36 = seed + 36;
    this.f37 = seed + 37;
    this.f38 = seed + 38;
    this.f39 = seed + 39;
    this.f40 = seed + 40;
    this.f41 = seed + 41;
    this.f42 = seed + 42;
    this.f43 = seed + 43;
    this.f44 = seed + 44;
    this.f45 = seed + 45;
    this.f46 = seed + 46;
    this.f47 = seed + 47;
    this.f48 = seed + 48;
    this.f49 = seed + 49;
    this.f50 = seed + 50;
    this.f51 = seed + 51;
    this.f52 = seed + 52;
    this.f53 = seed + 53;
    this.f54 = seed + 54;
    this.f55 = seed + 55;
    this.f56 = seed + 56;
    this.f57 = seed + 57;
    this.f58 = seed + 58;
    this.f59 = seed + 59;
    this.f60 = seed + 60;
    this.f61 = seed + 61;
    this.f62 = seed + 62;
    this.f63 = seed + 63;
    this.f64 = seed + 64;
    this.f65 = seed + 65;
    this.f66 = seed + 66;
    this.f67 = seed + 67;
    this.f68 = seed + 68;
    this.f69 = seed + 69;
  }
}

function bigObjects(): void {
  let sum = 0;
  const keep: Big[] = [];
  for (let i = 0; i < 3000; i++) {
    const b = new Big(i);
    sum += b.f0 + b.f3 + b.f69 + b.f1;
    if (i % 100 === 0) keep.push(b);
  }
  console.log("big", sum, keep.length, keep[5].f66, keep[29].f2);
}

class Node {
  next: Node | null = null;
  label: string;
  constructor(label: string) {
    this.label = label;
  }
}

function cycles(): void {
  let labels = 0;
  for (let round = 0; round < 200; round++) {
    const a = new Node("a" + round);
    const b = new Node("b" + round);
    a.next = b;
    b.next = a; // a collectable cycle
    const c = new Node("c");
    labels += a.label.length + b.label.length + (c.next === null ? 1 : 0);
  }
  console.log("cycles", labels);
}

class Key {
  id: number;
  constructor(id: number) {
    this.id = id;
  }
}

function weakObservers(): void {
  const map = new WeakMap<Key, number>();
  const live: Key[] = [];
  for (let i = 0; i < 1000; i++) {
    const k = new Key(i);
    map.set(k, i * 2);
    if (i % 10 === 0) live.push(k);
  }
  // Freed keys are recycled for new keys; a recycled block must not
  // inherit the dead key's entry.
  let stale = 0;
  for (let i = 0; i < 1000; i++) if (map.has(new Key(i))) stale++;
  let found = 0;
  for (const k of live) if (map.get(k) === k.id * 2) found++;
  console.log("weak", stale, found);
}

recycleOptional();
recordSizes();
bigObjects();
cycles();
weakObservers();
