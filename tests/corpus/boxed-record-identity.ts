// A native record, array or class instance seen as an untyped value is the
// same object: every box of it is one value, untyped writes and expandos
// show through typed reads and through other boxes, and it keys Map, Set
// and WeakMap entries as itself.

type Point = { x: number; y: number; tag?: string };
type Line = { a: Point; b: Point; pts: Point[] };

const p: Point = { x: 1, y: 2 };
const u1: any = p;
const u2: any = p;
console.log("same box", u1 === u2, u1 === (p as unknown));

// Expandos show through another box, JSON and Object.keys, and survive the
// call that added them.
u1.extra = 5;
console.log("expando via other box", u2.extra, JSON.stringify(u2), Object.keys(u2).join(","));
function tag(o: any): void {
  o.note = "n";
}
tag(p);
console.log("expando after call", (u2 as { note: string }).note);

// Untyped writes reach typed reads, also of optional fields, and deletes.
u1.x = 10;
console.log("typed sees write", p.x);
u1.tag = "t";
console.log("optional via dyn", p.tag, Object.keys(p).join(","));
delete u1.tag;
console.log("delete optional", p.tag, "tag" in p, Object.keys(p).join(","));

// Nested records and arrays are the typed program's own objects.
const line: Line = { a: { x: 0, y: 0 }, b: { x: 1, y: 1 }, pts: [{ x: 2, y: 2 }] };
const ul: any = line;
ul.a.x = 7;
ul.pts[0].y = 9;
ul.pts.push({ x: 3, y: 3 });
console.log("nested", line.a.x, line.pts[0]!.y, line.pts.length, ul.a === line.a, ul.pts === line.pts);

// Collection keys.
const m = new Map<unknown, number>();
m.set(p, 1);
console.log("map key", m.get(u1), m.has(p as unknown));
const wm = new WeakMap<object, number>();
wm.set(u1, 2);
console.log("weak key", wm.get(p));
const s = new Set<unknown>([u1, u2, p]);
console.log("set size", s.size);

// Class instances and arrays.
class Box {
  v = 1;
}
const bx = new Box();
const ub: any = bx;
ub.extra = 3;
const ub2: any = bx;
console.log("class expando", ub2.extra, ub === ub2, JSON.stringify(bx));
const arr: number[] = [1, 2];
const ua: any = arr;
ua.label = "L";
const ua2: any = arr;
console.log("array expando", ua2.label, ua === ua2);

// A box cast back to its own type is the original.
const back = u2 as Point;
back.y = 20;
console.log("cast back", back === p, p.y);
