// Scaling probes: Map/Set/object-as-dictionary and records. Usage: collections <case> <n>
let seed = 12345;
function rnd(): number {
  seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
function mapNum(n: number): string {
  const m = new Map<number, number>();
  for (let i = 0; i < n; i++) m.set(i * 7, i);
  let s = 0;
  for (let i = 0; i < n; i++) s += m.get(i * 7)!;
  for (let i = 0; i < n; i++) m.delete(i * 7);
  return `${s} ${m.size}`;
}
function mapStr(n: number): string {
  const m = new Map<string, number>();
  for (let i = 0; i < n; i++) m.set("key" + i, i);
  let s = 0;
  for (let i = 0; i < n; i++) s += m.get("key" + i) ?? 0;
  return `${s} ${m.size}`;
}
function mapChurn(n: number): string {
  // Sliding window: 1000 live keys, n insert+delete operations.
  const m = new Map<number, number>();
  let s = 0;
  for (let i = 0; i < n; i++) {
    m.set(i, i);
    if (i >= 1000) m.delete(i - 1000);
    if ((i & 1023) === 0) for (const v of m.values()) s += v & 1;
  }
  return `${s} ${m.size}`;
}
function mapChurnFirst(n: number): string {
  // LRU-style: delete the oldest via keys().next() (iteration start after many deletes).
  const m = new Map<number, number>();
  let s = 0;
  for (let i = 0; i < n; i++) {
    m.set(i, i);
    if (m.size > 100) {
      const first = m.keys().next().value!;
      s += first;
      m.delete(first);
    }
  }
  return `${s} ${m.size}`;
}
function lruTouch(n: number): string {
  // LRU cache touch: delete + re-set existing keys (moves to the end).
  const m = new Map<number, number>();
  for (let i = 0; i < 1000; i++) m.set(i, i);
  let s = 0;
  for (let i = 0; i < n; i++) {
    const k = Math.floor(rnd() * 1000);
    const v = m.get(k)!;
    m.delete(k);
    m.set(k, v + 1);
    s += v;
  }
  return `${s} ${m.size}`;
}
function setChurn(n: number): string {
  const st = new Set<string>();
  let c = 0;
  for (let i = 0; i < n; i++) {
    st.add("s" + i);
    if (i >= 500) st.delete("s" + (i - 500));
    if (st.has("s" + (i - 250))) c++;
  }
  return `${c} ${st.size}`;
}
function setIterDelete(n: number): string {
  const st = new Set<number>();
  for (let i = 0; i < n; i++) st.add(i);
  let c = 0;
  for (const v of st) {
    if (v % 2 === 0) st.delete(v);
    c++;
  }
  return `${c} ${st.size}`;
}
function setFromArray(n: number): string {
  const a: number[] = [];
  for (let i = 0; i < n; i++) a.push(i % 1000);
  const st = new Set(a);
  return `${st.size} ${[...st].length}`;
}
function objDict(n: number): string {
  const o: Record<string, number> = {};
  for (let i = 0; i < n; i++) o["k" + i] = i;
  let s = 0;
  for (let i = 0; i < n; i++) s += o["k" + i]!;
  let c = 0;
  for (let i = 0; i < n; i += 3) if ("k" + i in o) c++;
  return `${s} ${c}`;
}
function objDictDelete(n: number): string {
  const o: Record<string, number> = {};
  let s = 0;
  for (let i = 0; i < n; i++) {
    o["k" + i] = i;
    if (i >= 100) delete o["k" + (i - 100)];
  }
  for (const k in o) s += o[k]!;
  return `${s} ${Object.keys(o).length}`;
}
function objNumKeys(n: number): string {
  const o: Record<number, number> = {};
  for (let i = 0; i < n; i++) o[i * 3] = i;
  let s = 0;
  for (let i = 0; i < n; i++) s += o[i * 3]!;
  return `${s}`;
}
function objectKeys(n: number): string {
  const o: Record<string, number> = {};
  for (let i = 0; i < n; i++) o["p" + i] = i;
  let t = 0;
  for (let k = 0; k < 5; k++) {
    t += Object.keys(o).length;
    t += Object.entries(o).length;
    t += Object.values(o).length;
  }
  return `${t}`;
}
function spreadAccumulate(n: number): string {
  // reduce((acc, x) => ({...acc, [k]: v})) — quadratic by construction, compare to Node.
  let acc: Record<string, number> = {};
  for (let i = 0; i < n; i++) acc = { ...acc, ["f" + i]: i };
  return `${Object.keys(acc).length}`;
}
function spreadSmall(n: number): string {
  type P = { x: number; y: number; z: number; name: string };
  let p: P = { x: 0, y: 0, z: 0, name: "p" };
  let s = 0;
  for (let i = 0; i < n; i++) {
    p = { ...p, x: p.x + 1 };
    s += p.x;
  }
  return `${s}`;
}
function objectAssign(n: number): string {
  const o: Record<string, number> = {};
  for (let i = 0; i < n; i++) Object.assign(o, { ["a" + (i % 100)]: i });
  return `${Object.keys(o).length}`;
}
function fromEntries(n: number): string {
  const e: [string, number][] = [];
  for (let i = 0; i < n; i++) e.push(["e" + i, i]);
  const o = Object.fromEntries(e);
  return `${Object.keys(o).length}`;
}
function groupBy(n: number): string {
  const groups = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const k = "g" + (i % 100);
    let g = groups.get(k);
    if (!g) {
      g = [];
      groups.set(k, g);
    }
    g.push(i);
  }
  let s = 0;
  for (const [, g] of groups) s += g.length;
  return `${s}`;
}
function classInstances(n: number): string {
  class Pt {
    x: number;
    y: number;
    constructor(x: number, y: number) {
      this.x = x;
      this.y = y;
    }
    len(): number {
      return Math.abs(this.x) + Math.abs(this.y);
    }
  }
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) pts.push(new Pt(i, -i));
  let s = 0;
  for (const p of pts) s += p.len();
  return `${s}`;
}
function mapObjKeys(n: number): string {
  const keys: { id: number }[] = [];
  for (let i = 0; i < n; i++) keys.push({ id: i });
  const m = new Map<{ id: number }, number>();
  for (const k of keys) m.set(k, k.id);
  let s = 0;
  for (const k of keys) s += m.get(k)!;
  return `${s}`;
}

const which = process.argv[2] ?? "";
const n = Number(process.argv[3] ?? "1000");
const t0 = performance.now();
let out = "";
switch (which) {
  case "map-num": out = mapNum(n); break;
  case "map-str": out = mapStr(n); break;
  case "map-churn": out = mapChurn(n); break;
  case "map-churn-first": out = mapChurnFirst(n); break;
  case "lru-touch": out = lruTouch(n); break;
  case "set-churn": out = setChurn(n); break;
  case "set-iter-delete": out = setIterDelete(n); break;
  case "set-from-array": out = setFromArray(n); break;
  case "obj-dict": out = objDict(n); break;
  case "obj-dict-delete": out = objDictDelete(n); break;
  case "obj-num-keys": out = objNumKeys(n); break;
  case "object-keys": out = objectKeys(n); break;
  case "spread-accumulate": out = spreadAccumulate(n); break;
  case "spread-small": out = spreadSmall(n); break;
  case "object-assign": out = objectAssign(n); break;
  case "from-entries": out = fromEntries(n); break;
  case "group-by": out = groupBy(n); break;
  case "class-instances": out = classInstances(n); break;
  case "map-obj-keys": out = mapObjKeys(n); break;
  default: out = "unknown case";
}
const t1 = performance.now();
console.log(which, n, out);
console.error("T=" + (t1 - t0).toFixed(3));
