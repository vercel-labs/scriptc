// `(p as any).k = v` on a record: Node erases the assertion, so the write
// reaches the object `p` names. `any` has no layout of its own, and the
// write used to be refused as an "assignment to non-variables" whatever the
// member was. A member the record's own layout declares is that slot, so it
// is written in place, through any erased wrapper, with the value converted
// into the slot's type like any other write. A member the layout does not
// declare stays refused, by name
// (tests/diagnostics/any-asserted-undeclared-write.ts).
interface Point {
  x: number;
  y?: number;
  label: string;
}

const p: Point = { x: 1, label: "p" };
(p as any).x = 2;
(p as any).label = "moved";
console.log("write", p.x, p.label, Object.keys(p), JSON.stringify(p));

// An optional member becomes present, in the layout's key order.
(p as any).y = 3;
console.log("optional", p.y, "y" in p, Object.keys(p), JSON.stringify(p));

// Updates read and write the same slot.
(p as any).x += 5;
(p as any).x++;
console.log("update", p.x, (p as any).x);

// The other erased wrappers do not hide the operand.
(p as any)!.x = 10;
((p as any) satisfies unknown).label = "wrapped";
console.log("wrappers", p.x, p.label);

// A value from the dynamic tier converts into the slot's type.
const parsed: unknown = JSON.parse('{"x":41,"label":"parsed"}');
(p as any).x = (parsed as { x: number }).x;
(p as any).label = (parsed as { label: string }).label;
console.log("dynamic", p.x, p.label);

// The operand is evaluated once, before the value.
let calls = 0;
const order: string[] = [];
function get(): Point {
  calls++;
  order.push("receiver");
  return p;
}
function next(): number {
  order.push("value");
  return 99;
}
(get() as any).x = next();
console.log("order", calls, order.join(","), p.x);

// An operand that may be undefined: the stored object takes the write, and
// a missing one throws Node's TypeError for the operation.
function maybe(flag: boolean): Point | undefined {
  return flag ? p : undefined;
}
(maybe(true) as any).x = 7;
console.log("optional operand", p.x);
function attempt(label: string, run: () => void): void {
  try {
    run();
    console.log(label, "no throw");
  } catch (e) {
    console.log(label, (e as Error).name, (e as Error).message);
  }
}
attempt("undefined write", () => {
  (maybe(false) as any).x = 1;
});
attempt("undefined update", () => {
  (maybe(false) as any).x += 1;
});

// Function locals take the same rule.
function local(): void {
  const q: Point = { x: 1, label: "q" };
  (q as any).x = 4;
  (q as any).y = 5;
  console.log("local", q.x, q.y, JSON.stringify(q));
}
local();

// A class instance keeps its dynamic own-property write.
class Box {
  size = 1;
}
const box = new Box();
(box as any).extra = "e";
(box as any).size = 2;
console.log("class", (box as any).extra, box.size, Object.keys(box));
export {};
