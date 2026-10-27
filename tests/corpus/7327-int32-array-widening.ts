// Local number arrays with checked int32 stores: `new Array(n).fill(v)`
// arrays whose stores are exact integers but not proven int32s. A fill of
// at least 4096 elements creates int32 slots, and the first store past the
// int32 range widens the array to doubles in place; a shorter fill creates
// doubles. Each case runs at both sizes. Arrays with a store that has no
// exact integer range (a product of two int32s, a fraction, a value that may
// be -0), and arrays allocated as literals, keep doubles throughout.

function counters(n: number, rounds: number): string {
  const c: number[] = new Array(n).fill(0);
  for (let r = 0; r < rounds; r++)
    for (let i = 0; i < c.length; i++) c[i] = c[i]! + ((i & 3) + 1) * 1000000;
  return `counters ${n} ${c[0]} ${c[1]} ${c[2]} ${c[3]} ${c[n - 1]} ${c.length}`;
}

// The store at i = 45 passes 2^31 and widens the array partway through a
// loop; the remaining passes store doubles.
function denseLoop(n: number, k: number): string {
  const a: number[] = new Array(n).fill(0);
  for (let i = 0; i < a.length; i++) a[i] = i + k + 2147483600;
  let s = 0;
  for (let i = 0; i < a.length; i++) s = (s + a[i]!) % 1000003;
  return `dense ${n} ${a[44]} ${a[45]} ${a[n - 1]} ${s}`;
}

// Checked stores whose values stay int32: no widening.
function bfs(n: number): string {
  const dist: number[] = new Array(n).fill(-1);
  const queue: number[] = [0];
  dist[0] = 0;
  for (let h = 0; h < queue.length; h++) {
    const u = queue[h]!;
    const edges = [(u + 1) & (n - 1), (u * 5 + 1) & (n - 1)];
    for (let j = 0; j < edges.length; j++) {
      const v = edges[j]!;
      if (dist[v]! < 0) {
        dist[v] = dist[u]! + 1;
        queue.push(v);
      }
    }
  }
  let far = 0,
    sum = 0;
  for (let i = 0; i < n; i++) {
    if (dist[i]! > far) far = dist[i]!;
    sum += dist[i]!;
  }
  return `bfs ${n} ${far} ${sum} ${queue.length}`;
}

// A fill value that is not an int32 widens the new array before the fill.
function filledPastInt32(n: number, k: number): string {
  const a: number[] = new Array(n).fill(k * 1000000000);
  a[1] = a[1]! + 1;
  const b: number[] = new Array(n).fill(k);
  b[2] = b[2]! * 2;
  return `filled ${n} ${a[0]} ${a[1]} ${a.length} ${b[0]} ${b[2]}`;
}

// A chain of sums crosses 2^31 partway through; the second loop runs after
// the array widened.
function chain(n: number, step: number): string {
  const a: number[] = new Array(n).fill(0);
  for (let i = 1; i < n; i++) a[i] = a[i - 1]! + (i < 16 ? step : 1);
  let s = 0;
  for (let i = 0; i < n; i++) s = (s + (a[i]! % 1000003)) % 1000003;
  for (let i = 1; i < n; i++) a[i] = a[i]! - a[i - 1]!;
  return `chain ${n} ${step} ${a[1]} ${a[5]} ${a[6]} ${a[n - 1]} ${s}`;
}

// Two arrays in one loop: one widens partway through, the other keeps
// int32 slots; then both are read in another loop.
function twoArrays(n: number, m: number, k: number): string {
  const small: number[] = new Array(n).fill(1);
  const big: number[] = new Array(m).fill(k);
  const count = Math.min(n, m);
  for (let i = 1; i < count; i++) {
    small[i] = small[i - 1]! + 1;
    big[i] = big[i - 1]! + (i < 8 ? 700000000 : 1);
  }
  let s = 0,
    t = 0;
  for (let i = 0; i < count; i++) {
    s += small[i]!;
    t = (t + (big[i]! % 997)) % 997;
  }
  return `two ${n} ${m} ${small[count - 1]} ${big[2]} ${big[3]} ${big[count - 1]} ${s} ${t}`;
}

// Pushes that pass 2^31 widen the array before they append.
function pushes(n: number, k: number): string {
  const a: number[] = new Array(n).fill(k);
  for (let i = 0; i < 8; i++) a.push(a[a.length - 1]! + 900000000);
  let s = 0;
  for (let i = 0; i < a.length; i++) s = (s + (a[i]! % 10007)) % 10007;
  return `pushes ${n} ${a.length} ${a[n]} ${a[n + 2]} ${a[n + 7]} ${s}`;
}

function controlFlow(n: number, k: number): string {
  const a: number[] = new Array(n).fill(k);
  let stores = 0;
  for (let i = 1; i < n; i++) {
    if (i % 2 === 0) continue;
    a[i] = a[i - 1]! + 1000000000 * (i % 4);
    stores++;
    if (a[i]! > 2500000000) break;
  }
  let i = 0;
  while (i < n && a[i]! < 2000000000) i++;
  let j = n;
  do j--;
  while (j > 0 && a[j] === k);
  return `flow ${n} ${stores} ${a[1]} ${a[2]} ${a[3]} ${i} ${j}`;
}

function readOnly(n: number, wide: boolean): string {
  const a: number[] = new Array(n).fill(2);
  if (wide) a[0] = a[0]! + 3000000000;
  let s = 0,
    present = 0;
  for (let i = 0; i < n + 2; i++) {
    s += a[i] ?? 0;
    if (i in a) present++;
  }
  return `read ${n} ${wide} ${s} ${present}`;
}

function holes(n: number): string {
  // Holes, present undefined and sparse entries survive widening.
  const a: number[] = new Array(n).fill(3);
  a[n + 3] = a[1]! + 1;
  a[n + 2] = a[n + 3]! - 1;
  a[2 * n + 100000] = a[0]! + 1;
  a[n + 1] = a[n + 2]! + 3000000000;
  return `holes ${n} ${a.length} ${a[n]} ${n in a} ${a[n + 1]} ${a[n + 2]} ${a[2 * n + 100000]}`;
}

// These arrays never take int32 slots: a fractional store, a product of
// two int32s, -0, an escape, and arrays allocated as literals.
function neverInt32(n: number, x: number, y: number): string[] {
  const f: number[] = new Array(n).fill(1);
  f[0] = f[0]! / x;
  const m: number[] = new Array(n).fill(3);
  m[1] = m[1]! * y;
  const z: number[] = new Array(n).fill(4);
  z[1] = z[1]! % 2;
  z[2] = -z[0]! % 2;
  const j: number[] = new Array(n).fill(3);
  j[0] = j[0]! + 1;
  const lit = [1, 2, 3];
  lit[0] = lit[0]! + 3000000000;
  const pushed: number[] = [];
  for (let i = 0; i < 4; i++) pushed.push(i * 1000000000);
  pushed[0] = pushed[3]! + pushed[2]!;
  return [
    `never ${f[0]} ${m[1]} ${z[1]} ${Object.is(z[2], -0)} ${j.slice(0, 2).join("|")}`,
    `literals ${lit[0]} ${lit[2]} ${pushed[0]} ${pushed.length}`,
  ];
}

const config = JSON.parse('{"small": 64, "large": 8192, "k": 3, "y": 2000000000}') as {
  small: number;
  large: number;
  k: number;
  y: number;
};
const lines: string[] = [];
for (const n of [config.small | 0, config.large | 0]) {
  lines.push(counters(n, 1000));
  lines.push(denseLoop(n, config.k | 0));
  lines.push(bfs(n));
  lines.push(filledPastInt32(n, config.k | 0));
  lines.push(chain(n, 400000000));
  lines.push(chain(n, 100000000));
  lines.push(twoArrays(n, n, config.k | 0));
  lines.push(pushes(n, config.k | 0));
  lines.push(controlFlow(n, config.k | 0));
  lines.push(readOnly(n, false));
  lines.push(readOnly(n, true));
  lines.push(holes(n));
}
// One long array and one short: their kinds differ on entry to the loop.
lines.push(twoArrays(config.large | 0, config.small | 0, config.k | 0));
lines.push(twoArrays(config.small | 0, config.large | 0, config.k | 0));
lines.push(...neverInt32(config.small | 0, config.k, config.y | 0));
for (const line of lines) console.log(line);
