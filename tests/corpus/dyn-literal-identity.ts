// Object and array literals in untyped contexts (an `unknown` or `any`
// slot, an `unknown[]` element, a thrown value, an `unknown`/`any`
// parameter) keep one identity through later checked casts.

type Counter = { count: number };
type Item = { name: string; tags: string[] };

// The original example: a write through the cast shows through the holder.
const holder: any = { count: 1 };
const item = holder as Counter;
item.count++;
console.log("any holder", holder.count, item === holder);

const box: unknown = { count: 10 };
const viewA = box as Counter;
const viewB = box as Counter;
viewA.count += 5;
console.log("unknown holder", viewB.count, viewA === viewB, JSON.stringify(box));

// Elements of an unknown[] array literal.
const values: unknown[] = [
  { name: "a", tags: ["x"] },
  { name: "b", tags: [] },
];
const second = values[1] as Item;
second.tags.push("y");
console.log("unknown[] element", JSON.stringify(values), (values[1] as Item) === second);

// Nested literals inside an untyped literal.
const tree: unknown = { name: "root", children: [{ name: "leaf", tags: ["t"] }] };
const root = tree as { name: string; children: Item[] };
const leaf = (tree as { children: unknown[] }).children[0] as Item;
leaf.tags.push("u");
console.log("nested", root.children[0]!.tags.join(","), root.children[0] === leaf);

// A thrown literal.
try {
  throw { code: "E_BUSY", attempts: [1] };
} catch (error) {
  const failure = error as { code: string; attempts: number[] };
  failure.attempts.push(2);
  console.log("thrown", failure.code, (error as { attempts: number[] }).attempts.length, failure === error);
}

// Literals passed to unknown and any parameters.
function remember(value: unknown): Counter {
  const counter = value as Counter;
  counter.count *= 2;
  return value as Counter;
}
console.log("unknown parameter", remember({ count: 4 }).count);

function relabel(value: any): Item {
  const target = value as Item;
  target.name = target.name.toUpperCase();
  return value;
}
const relabeled = relabel({ name: "pkg", tags: [] });
console.log("any parameter", relabeled.name, relabeled.tags.length);

// A literal returned as unknown, and one stored in an unknown field.
function make(): unknown {
  return { count: 0 };
}
const made = make();
(made as Counter).count = 7;
console.log("returned", (made as Counter).count);

class Slot {
  value: unknown = { name: "slot", tags: ["s"] };
}
const slot = new Slot();
(slot.value as Item).tags.push("t");
console.log("field", JSON.stringify(slot.value));

// Untyped literals keep JavaScript's own key order and extra keys.
const extra: unknown = { name: "e", z: 1, tags: [], a: 2 };
const typed = extra as Item;
typed.tags.push("k");
console.log("extra keys", JSON.stringify(extra), Object.keys(typed).join(","));

// Literals handed to library calls are unchanged.
console.log(JSON.stringify({ count: 3 }), [{ n: 1 }].length);
