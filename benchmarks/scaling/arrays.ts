// Scaling probes: array operations. Usage: arrays <case> <n>
// stdout: deterministic checksum (compared with Node); stderr: T=<ms>.
let seed = 12345;
function rnd(): number {
  seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
function make(n: number): number[] {
  const a: number[] = [];
  for (let i = 0; i < n; i++) a.push(i);
  return a;
}
function push(n: number): string {
  const a: number[] = [];
  for (let i = 0; i < n; i++) a.push(i * 2);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]!;
  return `${a.length} ${s}`;
}
function pop(n: number): string {
  const a = make(n);
  let s = 0;
  while (a.length > 0) s += a.pop()!;
  return `${s}`;
}
function shift(n: number): string {
  const a = make(n);
  let s = 0;
  while (a.length > 0) s += a.shift()!;
  return `${s}`;
}
function queue(n: number): string {
  // BFS-style queue: push at the back, shift from the front, ~100 live.
  const q: number[] = [];
  let s = 0;
  for (let i = 0; i < 100; i++) q.push(i);
  for (let i = 0; i < n; i++) {
    s += q.shift()!;
    q.push(i);
  }
  return `${s} ${q.length}`;
}
function unshift(n: number): string {
  const a: number[] = [];
  for (let i = 0; i < n; i++) a.unshift(i);
  return `${a.length} ${a[0]} ${a[a.length - 1]}`;
}
function spliceTail(n: number): string {
  const a = make(n);
  let s = 0;
  while (a.length > 0) s += a.splice(a.length - 1, 1)[0]!;
  return `${s}`;
}
function spliceMid(n: number): string {
  const a = make(n);
  let s = 0;
  for (let k = 0; k < 1000; k++) {
    const at = Math.floor(rnd() * a.length);
    s += a.splice(at, 1)[0]!;
    a.splice(at, 0, k);
  }
  return `${s} ${a.length}`;
}
function sliceSmall(n: number): string {
  const a = make(n);
  let s = 0;
  for (let i = 0; i + 8 <= n; i++) s += a.slice(i, i + 8).length;
  return `${s}`;
}
function concat(n: number): string {
  const a = make(n);
  const b = make(n);
  let s = 0;
  for (let k = 0; k < 10; k++) s += a.concat(b).length;
  return `${s}`;
}
function indexOf(n: number): string {
  const a = make(n);
  let s = 0;
  for (let k = 0; k < 100; k++) s += a.indexOf(n - 1 - k);
  return `${s}`;
}
function includesStr(n: number): string {
  const a: string[] = [];
  for (let i = 0; i < n; i++) a.push("k" + i);
  let s = 0;
  for (let k = 0; k < 100; k++) if (a.includes("k" + (n - 1 - k))) s++;
  return `${s}`;
}
function sortNum(n: number): string {
  const a: number[] = [];
  for (let i = 0; i < n; i++) a.push(Math.floor(rnd() * 1e9));
  a.sort((x, y) => x - y);
  return `${a[0]} ${a[n >> 1]} ${a[n - 1]}`;
}
function sortSorted(n: number): string {
  const a = make(n);
  a.sort((x, y) => x - y);
  a.sort((x, y) => y - x);
  return `${a[0]} ${a[n - 1]}`;
}
function sortStr(n: number): string {
  const a: string[] = [];
  for (let i = 0; i < n; i++) a.push("s" + Math.floor(rnd() * 1e9));
  a.sort();
  return `${a[0]} ${a[n - 1]}`;
}
function sortObj(n: number): string {
  const a: { k: number; v: string }[] = [];
  for (let i = 0; i < n; i++) a.push({ k: Math.floor(rnd() * 1000), v: "v" + i });
  a.sort((x, y) => x.k - y.k);
  return `${a[0]!.v} ${a[n - 1]!.v}`;
}
function reverse(n: number): string {
  const a = make(n);
  for (let k = 0; k < 10; k++) a.reverse();
  return `${a[0]} ${a[n - 1]}`;
}
function inArr(n: number): string {
  const a = make(n);
  let c = 0;
  for (let i = 0; i < n * 2; i++) if (i in a) c++;
  return `${c}`;
}
function inArrStr(n: number): string {
  const a: string[] = [];
  for (let i = 0; i < n; i++) a.push("x" + i);
  let c = 0;
  for (let i = 0; i < n * 2; i++) if (i in a) c++;
  return `${c}`;
}
function holes(n: number): string {
  const a = new Array<number>(n);
  for (let i = 1; i < n; i += 2) a[i] = i;
  let c = 0;
  let s = 0;
  for (let i = 0; i < n; i++) if (i in a) c++;
  a.forEach((v) => {
    s += v;
  });
  return `${c} ${s} ${a.length}`;
}
function sparse(n: number): string {
  const a: number[] = [];
  for (let i = 0; i < n; i++) a[i * 1000] = i;
  let s = 0;
  a.forEach((v) => {
    s += v;
  });
  return `${a.length} ${s}`;
}
function spread(n: number): string {
  const a = make(n);
  let s = 0;
  for (let k = 0; k < 10; k++) s += [...a].length;
  return `${s}`;
}
function mapFilterReduce(n: number): string {
  const a = make(n);
  const r = a
    .map((x) => x * 3)
    .filter((x) => x % 2 === 0)
    .reduce((acc, x) => acc + x, 0);
  return `${r}`;
}
function arrayFrom(n: number): string {
  const a = Array.from({ length: n }, (_, i) => i * 2);
  return `${a.length} ${a[n - 1]}`;
}
function join(n: number): string {
  const a = make(n);
  return `${a.join(",").length}`;
}
function flat(n: number): string {
  const a: number[][] = [];
  for (let i = 0; i < n; i += 4) a.push([i, i + 1, i + 2, i + 3]);
  return `${a.flat().length}`;
}
function lastIndexOf(n: number): string {
  const a = make(n);
  let s = 0;
  for (let k = 0; k < 100; k++) s += a.lastIndexOf(k);
  return `${s}`;
}
function findIndex(n: number): string {
  const a = make(n);
  let s = 0;
  for (let k = 0; k < 20; k++) s += a.findIndex((x) => x === n - 1 - k);
  return `${s}`;
}
function nested2d(n: number): string {
  const side = Math.floor(Math.sqrt(n));
  const g: number[][] = [];
  for (let i = 0; i < side; i++) g.push(new Array<number>(side).fill(i));
  let s = 0;
  for (let i = 0; i < side; i++) for (let j = 0; j < side; j++) s += g[i]![j]!;
  return `${s}`;
}
function lengthTruncate(n: number): string {
  const a = make(n);
  let s = 0;
  while (a.length > 0) {
    s += a[a.length - 1]!;
    a.length = a.length - 1;
  }
  return `${s}`;
}

const which = process.argv[2] ?? "";
const n = Number(process.argv[3] ?? "1000");
const t0 = performance.now();
let out = "";
switch (which) {
  case "push": out = push(n); break;
  case "pop": out = pop(n); break;
  case "shift": out = shift(n); break;
  case "queue": out = queue(n); break;
  case "unshift": out = unshift(n); break;
  case "splice-tail": out = spliceTail(n); break;
  case "splice-mid": out = spliceMid(n); break;
  case "slice-small": out = sliceSmall(n); break;
  case "concat": out = concat(n); break;
  case "indexOf": out = indexOf(n); break;
  case "includes-str": out = includesStr(n); break;
  case "sort-num": out = sortNum(n); break;
  case "sort-sorted": out = sortSorted(n); break;
  case "sort-str": out = sortStr(n); break;
  case "sort-obj": out = sortObj(n); break;
  case "reverse": out = reverse(n); break;
  case "in-arr": out = inArr(n); break;
  case "in-arr-str": out = inArrStr(n); break;
  case "holes": out = holes(n); break;
  case "sparse": out = sparse(n); break;
  case "spread": out = spread(n); break;
  case "map-filter-reduce": out = mapFilterReduce(n); break;
  case "array-from": out = arrayFrom(n); break;
  case "join": out = join(n); break;
  case "flat": out = flat(n); break;
  case "lastIndexOf": out = lastIndexOf(n); break;
  case "findIndex": out = findIndex(n); break;
  case "nested2d": out = nested2d(n); break;
  case "length-truncate": out = lengthTruncate(n); break;
  default: out = "unknown case";
}
const t1 = performance.now();
console.log(which, n, out);
console.error("T=" + (t1 - t0).toFixed(3));
