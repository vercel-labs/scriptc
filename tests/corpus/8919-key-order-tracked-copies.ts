// Copies keep their source's key order over the keys they hold: a rest
// binding of values built in several orders, and the copy a rest binding
// takes after a key was written late.
function keysIn(value: object): string {
  const out: string[] = [];
  for (const k in value) out.push(k);
  return out.join(",");
}
interface Whole { a: number; b: number; c: number; d?: number }
interface Rest { b: number; c: number; d?: number }
function drop(w: Whole): Rest {
  const { a, ...rest } = w;
  return rest;
}
function show(tag: string, r: Rest): void {
  console.log(tag, Object.keys(r).join(","), keysIn(r), JSON.stringify(r), r);
  console.log(tag, Object.keys({ ...r }).join(","), Object.entries(r).map((e) => e[0]).join(","));
}
show("reordered", drop({ c: 1, b: 2, a: 3 }));
const whole: Whole = { a: 1, b: 2, c: 3 };
whole.d = 4;
show("late-d", drop(whole));
show("d-first", drop({ d: 0, a: 1, b: 2, c: 3 }));
const rests = [drop({ b: 1, a: 0, c: 2 }), drop({ c: 5, d: 6, a: 0, b: 7 })];
console.log(JSON.stringify(rests));
for (const r of rests) {
  r.d ??= 9;
  show("each", r);
}
// A record checked from a dynamic value and then converted to a wider record
// type keeps the order of the value it was checked from.
interface Item { id: string; tags: string[]; ready: boolean }
type Wide = { id: string; tags: string[]; ready: boolean; opts?: { a?: number } };
const data = { id: "a", ready: true, tags: ["x"] };
const loose: object = data;
const item = loose as Item;
console.log("checked:", Object.keys(item).join(","), JSON.stringify(item));
const wide: Wide = item;
console.log("widened:", Object.keys(wide).join(","), JSON.stringify(wide));
const list: Wide[] = [item];
console.log("in array:", Object.keys(list[0]!).join(","), JSON.stringify(list));
function take(w: Wide): string {
  return Object.keys(w).join(",");
}
console.log("argument:", take(item));
const items: Item[] = [item];
const wides: readonly Wide[] = [...items];
console.log("spread:", Object.keys(wides[0]!).join(","));
