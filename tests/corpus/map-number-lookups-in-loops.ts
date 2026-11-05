// Number-key Map and Set lookups inside loops while the collection changes
// between its direct index, a linear scan and a bucket table.

// Dense keys, then a sparse key mid-loop moves the map to hashing; later
// lookups of the same keys still find them.
function denseToHashed(): string {
  const m = new Map<number, number>();
  for (let i = 0; i < 64; i++) m.set(i, i * 3);
  let found = 0;
  let sum = 0;
  for (let i = 0; i < 200; i++) {
    if (i === 50) m.set(1_000_000_007, -1);
    const v = m.get(i % 80);
    if (v !== undefined) {
      found++;
      sum += v;
    }
    if (m.has(1_000_000_007)) sum += 1;
  }
  return `${found} ${sum} ${m.size}`;
}

// Counting into a map with many sparse keys: a bucket table from the start.
function hashedCounts(): string {
  const counts = new Map<number, number>();
  let key = 7;
  for (let i = 0; i < 4000; i++) {
    key = (key * 1103515245 + 12345) % 2147483648;
    const k = key % 1009;
    const c = counts.get(k * 1_000_003);
    counts.set(k * 1_000_003, c === undefined ? 1 : c + 1);
  }
  let max = 0;
  let total = 0;
  for (const [k, c] of counts) {
    total += c;
    if (c > max) max = c;
    if (k < 0) total = -1;
  }
  return `${counts.size} ${total} ${max}`;
}

// Integer keys in a counter object map, as a k-mer count keeps them.
class Counter {
  n: number;
  constructor(n: number) {
    this.n = n;
  }
}

function counterObjects(): string {
  const freq = new Map<number, Counter>();
  let key = 0;
  let seed = 11;
  for (let i = 0; i < 6000; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    key = (key * 4 + (Math.floor(seed / 65536) % 4)) % 262144;
    const cur = freq.get(key);
    if (cur === undefined) freq.set(key, new Counter(1));
    else cur.n++;
  }
  let best = 0;
  let bestKey = -1;
  for (const [k, c] of freq)
    if (c.n > best) {
      best = c.n;
      bestKey = k;
    }
  return `${freq.size} ${bestKey} ${best}`;
}

// Fractional, negative, -0 and NaN keys looked up in a loop.
function doubleKeys(): string {
  const m = new Map<number, string>();
  const keys = [0.5, -3, -0, NaN, 2 ** 40, 1e-9, Infinity, -Infinity, 7];
  for (let i = 0; i < keys.length; i++) m.set(keys[i]!, `k${i}`);
  const out: string[] = [];
  const probes = [0.5, -3, 0, NaN, 2 ** 40, 1e-9, Infinity, -Infinity, 7, 8, 0.25, -1];
  for (let i = 0; i < probes.length; i++) out.push(`${m.get(probes[i]!) ?? "-"}`);
  for (let i = 0; i < probes.length; i++) if (m.has(probes[i]!)) out.push("h");
  return out.join(",");
}

// Deletes inside the loop, then the map refills with small keys.
function deleteAndRefill(): string {
  const m = new Map<number, number>();
  for (let i = 0; i < 1000; i++) m.set(i * 7919, i);
  let hits = 0;
  for (let i = 0; i < 1000; i++) {
    if (m.has(i * 7919)) hits++;
    m.delete(i * 7919);
  }
  for (let i = 0; i < 100; i++) m.set(i, i);
  let sum = 0;
  for (let i = 0; i < 150; i++) sum += m.get(i) ?? 0;
  return `${hits} ${m.size} ${sum}`;
}

// A Set's membership tests while it grows from a scan to a bucket table.
function setGrowth(): string {
  const s = new Set<number>();
  let present = 0;
  for (let i = 0; i < 3000; i++) {
    if (s.has((i * 37) % 1009)) present++;
    s.add(((i * 37) % 1009) * 1000);
  }
  let again = 0;
  for (let i = 0; i < 1009; i++) if (s.has(i * 1000)) again++;
  return `${present} ${again} ${s.size}`;
}

// Nested loops over two maps, the inner one keyed by the outer's values.
function nested(): string {
  const outer = new Map<number, number>();
  const inner = new Map<number, number>();
  for (let i = 0; i < 300; i++) {
    outer.set(i * 101, i);
    inner.set(i, i * i);
  }
  let total = 0;
  for (let i = 0; i < 300; i++) {
    const v = outer.get(i * 101);
    if (v === undefined) continue;
    for (let j = 0; j < 3; j++) total += inner.get((v + j) % 300) ?? 0;
  }
  return `${total}`;
}

// has() then get() of one key, with and without a write between them.
function hasThenGet(): string {
  const m = new Map<number, number>();
  for (let i = 0; i < 400; i++) m.set(i * 1_000_003, i);
  let total = 0;
  let misses = 0;
  for (let i = 0; i < 800; i++) {
    const k = (i % 500) * 1_000_003;
    if (m.has(k)) total += m.get(k)!;
    else misses++;
    if (i % 3 === 0 && m.has(k)) {
      m.set(k, m.get(k)! + 1000);
      total += m.get(k)!;
    }
    if (i % 7 === 0 && !m.has(k + 1)) {
      m.set(k + 1, i);
      total += m.get(k + 1)! + (m.has(k + 1) ? 1 : 0);
    }
  }
  return `${total} ${misses} ${m.size}`;
}

console.log(denseToHashed());
console.log(hashedCounts());
console.log(counterObjects());
console.log(doubleKeys());
console.log(deleteAndRefill());
console.log(setGrowth());
console.log(nested());
console.log(hasThenGet());
