// Number-keyed Map and Set lookups whose keys are integers the compiler
// tracks as integers (loop counters, literals, integer arithmetic) on
// hashed storage, and lookups of absent keys on small bucket tables.

// Keys spread past the direct index's range, so the maps hash them.
const spread = new Map<number, number>();
for (let i = 0; i < 500; i++) spread.set(i * 104729 - 26000000, i);
let found = 0,
  absent = 0,
  total = 0;
for (let i = -10; i < 520; i++) {
  const v = spread.get(i * 104729 - 26000000);
  if (v === undefined) absent++;
  else {
    found++;
    total += v;
  }
}
console.log("spread", spread.size, found, absent, total);
console.log("spread literals", spread.get(-26000000), spread.get(-25895271), spread.get(0), spread.has(-1));

// Zero stored through -0 and through an integer; read back through both.
const zeros = new Map<number, string>();
for (let i = 1; i <= 20; i++) zeros.set(i * 1000003, "k" + i);
zeros.set(-0, "minus zero");
let z = 0;
console.log("zeros", zeros.size, zeros.get(z), zeros.get(0), zeros.get(-0), zeros.get(z * -1));
zeros.set(z, "zero");
console.log("zeros overwrite", zeros.size, zeros.get(-0), [...zeros.keys()].includes(0));

// Large and negative integer keys.
const wide = new Map<number, number>();
for (let i = 0; i < 64; i++) wide.set(2 ** 40 + i * 3, i);
for (let i = 0; i < 64; i++) wide.set(-(2 ** 33) - i, -i);
let wideUp = 0,
  wideDown = 0,
  wideMissing = 0;
for (let i = 0; i < 200; i++) {
  const a = wide.get(2 ** 40 + i);
  const b = wide.get(-(2 ** 33) - i);
  if (a === undefined) wideMissing++;
  else wideUp += a;
  if (b === undefined) wideMissing++;
  else wideDown += b;
}
console.log("wide", wide.size, wideUp, wideDown, wideMissing, wide.get(1099511627776), wide.get(-8589934592));

// Absent keys on bucket tables just past the linear scan, and as they grow.
for (const size of [9, 12, 16, 33, 64, 100, 257, 400]) {
  const m = new Map<number, number>();
  for (let i = 0; i < size; i++) m.set(i * 7919 + 1000000, i);
  let hits = 0,
    misses = 0;
  for (let i = 0; i < size * 4; i++) {
    if (m.has(i * 7919 + 1000000)) hits++;
    else misses++;
    if (m.get(i * 7919 + 1000001) !== undefined) hits += 1000;
  }
  for (let i = 0; i < size; i += 2) m.delete(i * 7919 + 1000000);
  let after = 0;
  for (let i = 0; i < size; i++) if (m.has(i * 7919 + 1000000)) after++;
  console.log("size", size, hits, misses, m.size, after, m.get(1000000), m.get(1007919));
}

// Small maps that scan their entries, with integer keys.
const tiny = new Map<number, string>();
for (let i = 0; i < 8; i++) tiny.set(i * 5000011, "t" + i);
let tinyHits = 0;
for (let i = 0; i < 40; i++) if (tiny.has(i * 5000011)) tinyHits++;
console.log("tiny", tiny.size, tinyHits, tiny.get(0), tiny.get(35000077), tiny.has(5000012));

// Sets with integer keys.
const seen = new Set<number>();
let dupes = 0;
for (let i = 0; i < 3000; i++) {
  const k = ((i * 2654435761) % 1000003) - 500000;
  if (seen.has(k)) dupes++;
  else seen.add(k);
}
let present = 0;
for (let i = -500000; i < 500003; i += 997) if (seen.has(i)) present++;
console.log("set", seen.size, dupes, present, seen.has(-500000), seen.has(500002));

// A counting loop like a k-mer histogram: get, then update the found entry.
class Count {
  n = 0;
}
const counts = new Map<number, Count>();
let key = 0;
for (let i = 0; i < 20000; i++) {
  key = ((key * 4) % 4194304) + (i % 7 === 0 ? 3 : i % 3);
  const c = counts.get(key);
  if (c === undefined) {
    const fresh = new Count();
    fresh.n = 1;
    counts.set(key, fresh);
  } else c.n++;
}
let most = 0,
  mostKey = -1;
for (const [k, c] of counts) if (c.n > most) [most, mostKey] = [c.n, k];
console.log("counts", counts.size, most, mostKey);
