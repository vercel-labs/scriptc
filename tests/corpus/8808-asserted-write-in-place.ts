// A member write through a type assertion mutates the object the operand
// names: Node erases `as`. A field the value's own layout already holds is
// written IN PLACE, never into the assertion's converted copy. A view that
// adds a member has no slot to write and is refused at compile time
// (tests/diagnostics/asserted-write-copy.ts).
interface Point {
  x: number;
  y: number;
}

const p: Point = { x: 1, y: 2 };
(p as Point).x = 8;
(p as { x: number }).x = 9;
((p as { x: number }) as Point).y = 10;
console.log("point", JSON.stringify(p));

// A compound assignment and an update write the same slot.
(p as { x: number }).x += 5;
(p as Point).y++;
console.log("update", JSON.stringify(p));

// A class instance reached through a structural view: the write reaches the
// instance's own field.
class Mover {
  x = 1;
  y = 2;
}
const mover = new Mover();
(mover as { x: number }).x = 5;
console.log("class", JSON.stringify(mover), (mover as { x: number }).x);

// An element read carries the undefined arm; the write still lands in the
// array the operand names.
const row: Point[] = [{ x: 1, y: 2 }];
(row[0] as Point).x = 42;
console.log("element", row[0].x);

// The write lands on the caller's value through a parameter, and aliases see
// it — the assertion is not a copy.
function reset(state: { ready: boolean }): void {
  (state as { ready: boolean }).ready = false;
}
const state = { ready: true };
const alias = state;
reset(state);
console.log("alias", state.ready, alias.ready, JSON.stringify(alias));

// A union member written through a view of the member's shared field: the
// dispatch runs over the arm the value actually has.
type Message = { role: string; content: string } | { role: string; summary: string };
interface Entry {
  type: string;
  message?: Message;
}
function migrate(entry: Entry): void {
  const message = entry.message;
  if (message && (message as { role: string }).role === "hookMessage") {
    (message as { role: string }).role = "custom";
  }
}
const entries: Entry[] = [
  { type: "message", message: { role: "hookMessage", content: "x" } },
  { type: "message", message: { role: "hookMessage", summary: "y" } },
];
for (const entry of entries) migrate(entry);
console.log("union", JSON.stringify(entries));

// `as unknown as T` over a record is the same erased write, not a trip
// through a dynamic copy.
const widened = { a: 1 };
(widened as unknown as { a: number }).a = 7;
(widened as unknown as { a: number }).a += 2;
console.log("widened", JSON.stringify(widened), widened.a);

// The operand is lowered once: a call in receiver position runs once, and
// the write still lands on the record the call returned.
let calls = 0;
function makeDyn(): any {
  calls++;
  return { x: 0, y: 0 };
}
function makeRecord(): { a: number } {
  calls++;
  return { a: 1 };
}
calls = 0;
(makeDyn() as { x: number }).x = 4;
(makeRecord() as { a: number }).a = 6;
console.log("calls", calls);
