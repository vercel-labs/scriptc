// A native record converted from an untyped value into another record type
// that names some of its fields, in any order, is the same object: writes
// through either name show through the other, identity holds, and the
// untyped views, JSON and spreads of the narrower name see every field.
type Wide = { a: number; b: string; c: boolean; d: number[] };
type AC = { a: number; c: boolean };
type DB = { d: number[]; b: string };
const wide: Wide = { a: 1, b: "x", c: true, d: [1] };
const o: unknown = wide;
const v = o as AC;
v.c = false;
console.log((o as Wide).c, wide.c, o === v, (v as unknown) === o);
wide.a = 5;
console.log(v.a, JSON.stringify(v), Object.keys(v).join(","));
const w = o as DB;
w.d.push(2);
w.b = "y";
w.d = [7, 8];
console.log(wide.b, wide.d.length, JSON.stringify(o), w === (o as DB), v === (o as AC));
const v2 = { ...v };
console.log(JSON.stringify(v2));
function bump(x: AC): void { x.a += 1; }
bump(v);
console.log(wide.a, v.a);
const list: AC[] = [v, { a: 9, c: true }];
console.log(list.map((x) => x.a).join(","), JSON.stringify(list));
