// Local number arrays whose every stored element is an int32: reads, writes,
// holes, present undefined, out-of-range and noncanonical indexes, growth,
// pop, the fill form, reassignment, and arrays that do not qualify.

function compose(n: number, rounds: number): number {
  const p: number[] = [];
  const q: number[] = [];
  for (let i = 0; i < n; i++) p.push((i * 7919 + 3) & (n - 1));
  for (let i = 0; i < n; i++) q.push(i);
  let check = 0;
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < n; i++) q[i] = p[q[i]!]!;
    check = (check + q[r % n]!) | 0;
  }
  return check;
}

function insertionSort(n: number): string {
  const a: number[] = [];
  let seed = 12345;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    a.push((seed % 2001) - 1000);
  }
  for (let i = 1; i < n; i++) {
    for (let j = i; j > 0 && a[j - 1]! > a[j]!; j--) {
      const t = a[j]!;
      a[j] = a[j - 1]!;
      a[j - 1] = t;
    }
  }
  let sorted = true;
  for (let i = 1; i < n; i++) if (a[i - 1]! > a[i]!) sorted = false;
  return `${sorted} ${a[0]} ${a[n >> 1]} ${a[n - 1]} ${a.length}`;
}

function reads(): string[] {
  const a = [7, -3, 2147483647, -2147483648, 0];
  const out: string[] = [];
  out.push(`${a[0]} ${a[1]} ${a[2]} ${a[3]} ${a[4]} ${a[5]}`);
  out.push(`${a[2]! + 1} ${a[3]! - 1} ${a[1]! / 2} ${a[2]! * 2}`);
  const idx = [0, 4, 5, -1, 1.5, NaN, -0, 2 ** 32, Infinity];
  for (const i of idx) out.push(`${i}: ${a[i]} ${a[i] === undefined} ${i in a}`);
  out.push(`len ${a.length}`);
  return out;
}

function holes(): string[] {
  const a = [1, 2, 3];
  const out: string[] = [];
  a[6] = 9;
  out.push(`len ${a.length} ${a[3]} ${a[6]} ${4 in a} ${6 in a}`);
  a[4] = -5;
  let sum = 0,
    present = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== undefined) {
      sum += a[i]!;
      present++;
    }
  }
  out.push(`sum ${sum} present ${present}`);
  // A hole read through a non-null assertion stores a present undefined.
  const q = [10, 20, 30];
  q[1] = a[3]!;
  out.push(`q ${q[0]} ${q[1]} ${q[2]} ${1 in q} ${q.length}`);
  q[1] = 21;
  out.push(`q ${q[1]} ${(q[0]! + q[1]!) | 0}`);
  return out;
}

function sparse(): string[] {
  const a = [1, 2];
  const out: string[] = [];
  a[100000] = 42;
  a[3] = 4;
  out.push(`len ${a.length} ${a[100000]} ${a[3]} ${a[2]} ${a[99999]}`);
  a[100000] = -42;
  out.push(`${a[100000]} ${a[100001]}`);
  return out;
}

function growth(n: number): string[] {
  const a: number[] = [];
  const out: string[] = [];
  for (let i = 0; i < n; i++) a.push((i * i) | 0);
  out.push(`len ${a.length} ${a[0]} ${a[n - 1]} ${a[n]}`);
  let sum = 0;
  while (a.length > n / 2) sum = (sum + a.pop()!) | 0;
  out.push(`popped ${sum} len ${a.length} last ${a[a.length - 1]}`);
  for (let i = 0; i < 3; i++) a.push(i - 3);
  out.push(`len ${a.length} ${a[a.length - 3]} ${a[a.length - 1]}`);
  while (a.length > 0) a.pop();
  out.push(`empty ${a.length} ${a.pop()} ${a[0]}`);
  a.push(5);
  out.push(`again ${a.length} ${a[0]}`);
  return out;
}

function filled(n: number): string[] {
  const counts = new Array(n).fill(0) as number[];
  const marks: number[] = new Array(n).fill(-1);
  for (let i = 0; i < 3 * n; i++) {
    const k = ((i * 37) % n) | 0;
    counts[k] = (i * 3 - 7) | 0;
    marks[(k + 1) % n] = k;
  }
  let a = 0,
    b = 0;
  for (let i = 0; i < n; i++) {
    a = (a + counts[i]!) | 0;
    b = (b + marks[i]!) | 0;
  }
  return [`fill ${counts.length} ${a} ${b} ${counts[n]} ${marks[0]}`];
}

function reassigned(rounds: number): string {
  let a = [1, 2, 3];
  let total = 0;
  for (let r = 0; r < rounds; r++) {
    if (r % 3 === 0) a = [r, r + 1];
    else a.push(r);
    total = (total + a[a.length - 1]! + a.length) | 0;
  }
  return `reassigned ${total} ${a.length} ${a[0]}`;
}

// These arrays do not qualify; they print the same values as before.
function disqualified(): string[] {
  const out: string[] = [];
  const negZero = [0, -0];
  out.push(`${Object.is(negZero[1], -0)} ${1 / negZero[1]!}`);
  const fraction = [1, 2];
  fraction[1] = 2.5;
  out.push(`${fraction[1]}`);
  const big = [1];
  big[0] = big[0]! + 2147483647;
  out.push(`${big[0]}`);
  const joined = [3, 1, 2];
  joined.sort((x, y) => x - y);
  out.push(joined.join(","));
  const escaped = [4, 5];
  const alias = escaped;
  alias[0] = 6;
  out.push(`${escaped[0]} ${alias[1]}`);
  const counter = [0];
  for (let i = 0; i < 10; i++) counter[0] = counter[0]! + 1;
  out.push(`${counter[0]}`);
  return out;
}

const config = JSON.parse('{"n": 256, "rounds": 50, "sort": 300}') as {
  n: number;
  rounds: number;
  sort: number;
};
console.log(compose(config.n | 0, config.rounds | 0));
console.log(insertionSort(config.sort | 0));
for (const line of reads()) console.log(line);
for (const line of holes()) console.log(line);
for (const line of sparse()) console.log(line);
for (const line of growth(config.n | 0)) console.log(line);
for (const line of filled(17)) console.log(line);
console.log(reassigned(config.rounds | 0));
for (const line of disqualified()) console.log(line);
