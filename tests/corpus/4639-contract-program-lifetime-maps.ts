import type { ProgramLifetime } from "@scriptc/types";

// Maps from strings to ProgramLifetime class instances: get, set, has and
// delete, growth past the linear scan into bucket tables, deletion with
// compaction, clear, every iteration form, copies, Sets of keys and
// values, maps held in class fields, optional and nullable values,
// inspection, and a cast through unknown. Each read sees the same
// instance that was stored.

class Sym implements ProgramLifetime {
  readonly name: string;
  readonly rank: number;
  readonly members = new Map<string, Sym>();
  constructor(name: string, rank: number) {
    this.name = name;
    this.rank = rank;
  }
}

class Scope implements ProgramLifetime {
  readonly locals = new Map<string, Sym>();
  readonly maybe = new Map<string, Sym | undefined>();
  readonly nullable = new Map<string, Sym | null>();
}

function show<V extends Sym | undefined | null>(m: ReadonlyMap<string, V>): string {
  return [...m].map(([k, v]) => `${k}=${v === undefined ? "u" : v === null ? "n" : v.name}`).join(",");
}

const a = new Sym("a", 3);
const b = new Sym("b", 1);
const c = new Sym("c", 2);

// get, set, has, delete, overwrite and size.
const m = new Map<string, Sym>();
m.set("x", a).set("y", b);
m.set("z", c);
console.log(show(m), m.size, m.get("y") === b, m.has("z"), m.has("w"), m.get("w"));
m.set("x", c);
console.log(show(m), m.get("x") === c, m.delete("y"), m.delete("y"), show(m));
const seeded = new Map<string, Sym>([
  ["p", a],
  ["q", b],
]);
console.log(show(seeded), seeded.get("q")?.rank);

// Growth into bucket tables, then deletes that compact the entries.
const big = new Map<string, Sym>();
const all: Sym[] = [];
for (let i = 0; i < 3000; i++) {
  const s = new Sym(`s${i}`, i);
  all.push(s);
  big.set(s.name, s);
}
let same = 0;
for (let i = 0; i < 3000; i++) if (big.get(`s${i}`) === all[i]) same++;
console.log(big.size, same, big.get("s1234")?.rank, big.has("s3000"));
for (let i = 0; i < 3000; i++) if (i % 3 !== 0) big.delete(`s${i}`);
same = 0;
for (const [k, v] of big) if (v === all[Number(k.slice(1))] && v.rank % 3 === 0) same++;
console.log(big.size, same, big.get("s2997")?.name, big.get("s2998"));
for (let i = 0; i < 3000; i += 3) big.set(`s${i}`, all[(i + 1) % 3000]!);
console.log(big.get("s0")?.name, big.get("s2997")?.name, big.size);

// Iteration forms.
const order: string[] = [];
m.forEach((v, k) => {
  order.push(`${k}:${v.name}`);
});
console.log(order.join(" "));
console.log([...m.keys()].join(), [...m.values()].map((s) => s.name).join(), [...m.entries()].length);
console.log(Array.from(m.values(), (s) => s.rank).join(), Array.from(m).length);
for (const v of m.values()) v.members.set("owner", a);
console.log(c.members.get("owner") === a, a.members.size);

// Mutation during iteration: entries added by the callback are visited.
const grow = new Map<string, Sym>([["g0", a]]);
let visits = 0;
for (const [k] of grow) {
  visits++;
  if (visits < 4) grow.set(`${k}+`, b);
}
console.log(visits, show(grow));

// Copies, Sets of keys and values, clear.
const copy = new Map(m);
copy.set("extra", b);
console.log(show(m), show(copy), copy.get("x") === m.get("x"));
const keySet = new Set(m.keys());
const valueSet = new Set(m.values());
console.log([...keySet].join(), valueSet.has(c), valueSet.has(b), valueSet.size);
copy.clear();
console.log(copy.size, copy.get("x"), show(m));
copy.set("again", a);
console.log(show(copy));

// Maps in class fields, optional and nullable values.
const scope = new Scope();
scope.locals.set("a", a);
scope.maybe.set("a", a).set("gone", undefined);
scope.nullable.set("b", b).set("none", null);
console.log(show(scope.locals), show(scope.maybe), show(scope.nullable));
console.log(scope.maybe.has("gone"), scope.maybe.get("gone"), scope.nullable.get("none"), scope.nullable.get("b")?.name);
const v = scope.maybe.get("a");
console.log(v === a, v?.rank);

// Objects from entries, inspection and JSON.
const obj = Object.fromEntries(m);
console.log(Object.keys(obj).join(), obj["z"] === c);
console.log(new Map<string, Sym>([["only", b]]));
console.log(JSON.stringify([...m.keys()]), JSON.stringify(Object.fromEntries([...m].map(([k, s]) => [k, s.rank]))));

// Through unknown and back.
const u: unknown = m;
if (u instanceof Map) {
  const back = u as Map<unknown, unknown>;
  const seen: string[] = [];
  for (const [k, s] of back) seen.push(`${String(k)}:${(s as Sym).name}`);
  console.log(back.size, seen.join(), back.get("x") === c);
}
