// Writes that create a key on a value whose type has no one key order: the
// key becomes the value's last key, whatever came before, and a key written
// again after `delete` moves last too. The orders here depend on the value
// (clones that add a key, copies written afterwards, writes through a
// parameter of a narrower type, records parsed from JSON), so each value
// keeps its own.
function keysIn(value: object): string {
  const out: string[] = [];
  for (const k in value) out.push(k);
  return out.join(",");
}

interface Item { id: number; x?: number; y?: number; z?: number }
function show(tag: string, r: Item): void {
  console.log(tag, Object.keys(r).join(","), keysIn(r), JSON.stringify(r), r);
  console.log(tag, Object.keys({ ...r }).join(","), Object.entries(r).map((e) => e[0]).join(","));
}
function build(flip: boolean): Item {
  const p: Item = { id: 0 };
  if (flip) {
    p.y = 1;
    p.x = 2;
  } else {
    p.x = 2;
    p.y = 1;
  }
  return p;
}
show("flip", build(true));
show("straight", build(false));

// A clone that adds a key, then a write of another.
const plain: Item = { id: 1 };
const cloned: Item = { ...plain, y: 3 };
show("clone-adds-y", cloned);
cloned.x = 4;
show("then-x", cloned);
show("clone-of-flip", { ...build(true), id: 5 });
show("clone-existing-x", { ...build(false), x: 9 });

// A copy taken before the writes, and one after.
const source: Item = { id: 0 };
source.z = 1;
const copy = { ...source };
copy.x = 2;
copy.y = 3;
show("copy-then-late", copy);
show("source-unchanged", source);
const all: Item[] = [];
for (let i = 0; i < 3; i++) {
  const t: Item = i === 0 ? { id: i, y: 1 } : i === 1 ? { z: 2, id: i } : { id: i };
  all.push(i === 2 ? { x: 7, ...t } : { ...t, x: 7 });
}
for (const t of all) show("loop" + t.id, t);
console.log(JSON.stringify(all));

// delete, then the key again.
const cycled: Item = { y: 1, id: 0, x: 2 };
delete cycled.y;
show("deleted", cycled);
cycled.y = 3;
show("readded", cycled);
const late: Item = { id: 1 };
late.y = 1;
late.x = 2;
delete late.y;
late.y = 5;
show("late-readd", late);

// Writes through a parameter of a narrower type reach the same object.
type Base = { id?: string | null; format?: string; index?: number };
type Detail = Base & { text?: string; signature?: string | null };
function fill(target: Base, from: Detail): void {
  target.id ??= from.id;
  target.format ||= from.format;
  target.index ??= from.index;
}
const first: Detail = { text: "a" };
const second: Detail = { text: "b", id: "x", format: "f", index: 2 };
fill(first, second);
first.text += second.text ?? "";
console.log(JSON.stringify(first), Object.keys(first).join(","), keysIn(first), first);

// A record parsed from JSON keeps the text's order, and a key written
// after `delete` moves last in it.
interface Parsed { a: number; b?: string; c?: boolean; d?: number }
function showParsed(tag: string, r: Parsed): void {
  console.log(tag, Object.keys(r).join(","), keysIn(r), JSON.stringify(r), r);
}
const again = JSON.parse('{"b":"x","a":1,"c":false}') as Parsed;
delete again.b;
again.b = "again";
showParsed("parsed-readd", again);
const two = JSON.parse('{"d":1,"a":2}') as Parsed;
two.c = true;
two.b = "late";
showParsed("parsed-c-b", two);
const inOrder = JSON.parse('{"a":2}') as Parsed;
inOrder.d = 3;
inOrder.b = "late";
showParsed("plain-d-b", inOrder);

// Keys created by keyed writes come in the order of the writes, and the
// copies made of the record keep it.
type Slot = "zeta" | "alpha" | "mid" | "beta";
const slots: Slot[] = ["zeta", "alpha", "mid", "beta"];
function fillSlots(order: Slot[]): Partial<Record<Slot, number>> {
  const out: Partial<Record<Slot, number>> = {};
  let n = 0;
  for (const slot of order) out[slot] = ++n;
  return out;
}
const filled = fillSlots(["zeta", "alpha", "mid", "beta"]);
console.log(Object.keys(filled).join(","), JSON.stringify(filled));
const refilled = { ...filled };
refilled.mid = 9;
console.log(Object.keys(refilled).join(","), JSON.stringify(refilled));
console.log(Object.keys(fillSlots(["alpha", "beta"])).join(","), Object.keys(fillSlots(["beta", "alpha", "zeta"])).join(","));
const completed = { ...fillSlots(["mid", "zeta"]) };
for (const slot of slots) if (completed[slot] === undefined) completed[slot] = 0;
console.log(
  Object.entries(completed as Record<Slot, number>)
    .map(([key, value]) => key + "=" + value)
    .join(","),
);
