// Writes through an untyped view of a native record store into the record
// itself: typed reads see them, the view keeps answering from the record
// (no snapshot), and typed writes show through the view again.
type Point = { x: number; y: number; label: string; tag?: string };
const p: Point = { x: 1, y: 2, label: "a" };
const d = p as unknown as Record<string, unknown>;
d.x = 10;
d.label = "b";
console.log(p.x, p.label, JSON.stringify(d), Object.keys(d).join(","));
p.y = 7;
console.log(d.y, JSON.stringify(p), "y" in d);
d.tag = "t";
console.log(p.tag, JSON.stringify(d), Object.keys(p).join(","));
d.tag = "u";
console.log(p.tag, d.tag);
d.label = "c";
console.log(p.label, JSON.stringify(Object.entries(d)));

// Nested values written through the view are the record's own.
type Nested = { inner: { v: number }; list: number[]; flag: boolean };
const n: Nested = { inner: { v: 1 }, list: [1], flag: false };
const dn = n as unknown as { inner: unknown; list: unknown; flag: unknown };
const fresh = { v: 2 };
dn.inner = fresh;
fresh.v = 3;
console.log(n.inner.v, JSON.stringify(dn));
dn.list = [4, 5];
n.list.push(6);
console.log(n.list.length, n.list[1], JSON.stringify(dn.list));
dn.flag = true;
console.log(n.flag, dn.flag);

// A counter updated through the view in a loop.
const acc: { total: number; count: number } = { total: 0, count: 0 };
const da = acc as unknown as { total: number; count: number };
for (let i = 0; i < 100000; i++) {
  da.total = da.total + i;
  da.count += 1;
}
console.log(acc.total, acc.count);

// Object.assign onto the view.
type Cfg = { host: string; port: number; debug: boolean; tags?: string[] };
const c: Cfg = { host: "a", port: 1, debug: false, tags: ["x"] };
const dc = c as unknown as object;
Object.assign(dc, { port: 2, debug: true });
console.log(c.port, c.debug, JSON.stringify(dc));
Object.assign(dc, { host: "z", extra: 1 });
console.log(c.host, JSON.stringify(dc), Object.keys(dc).length);
c.port = 3;
console.log(JSON.stringify(dc));

// Writes through a function that takes the record as unknown.
function bump(value: unknown, key: string): void {
  const object = value as Record<string, number>;
  object[key] = object[key]! + 1;
}
const counts = { a: 1, b: 2 };
bump(counts, "a");
bump(counts, "b");
bump(counts, "b");
console.log(counts.a, counts.b, JSON.stringify(counts));
