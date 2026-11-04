// A member WRITE through an erased type assertion: `(p as View).x = v`.
// Node erases the assertion, so the write mutates the object the operand
// names; the assertion only decides what the checker accepts. A record
// view the source layout hosts writes the field in place (never into a
// width copy), and a union field dispatch runs over the underlying
// value's arms.

interface Pt {
  x: number;
  y: number;
}

function move(p: Pt): void {
  p.x = 7;
  console.log("plain", JSON.stringify(p));
  (p as Pt).x = 8;
  console.log("assert", JSON.stringify(p));
  (p as { x: number }).x = 9;
  console.log("width", JSON.stringify(p));
  (p as unknown as { x: number }).x = 11;
  console.log("chain", JSON.stringify(p));
}

const p: Pt = { x: 1, y: 2 };
const alias = p;
move(p);
console.log("after", JSON.stringify(p), JSON.stringify(alias));

// Compound assignment and update through the assertion.
function bump(p: Pt): void {
  (p as { x: number }).x += 5;
  (p as { x: number }).x++;
  console.log("bump", JSON.stringify(p));
}
const q: Pt = { x: 0, y: 0 };
bump(q);
console.log("bumped", JSON.stringify(q));

// A union field written through an assertion on the member: the dispatch
// still runs over the arms the stored value actually has.
type Message = { role: string; content: string } | { role: string; summary: string };
interface Entry {
  type: string;
  message?: Message;
}

function migrate(entry: Entry): void {
  if (entry.message && (entry.message as { role: string }).role === "hookMessage") {
    (entry.message as { role: string }).role = "custom";
  }
}

const entries: Entry[] = [
  { type: "message", message: { role: "hookMessage", content: "x" } },
  { type: "message", message: { role: "hookMessage", summary: "y" } },
  { type: "message", message: { role: "other", content: "z" } },
];
for (const entry of entries) migrate(entry);
console.log(JSON.stringify(entries));

// The write lands on the value a function received, not on a caller's
// temporary: the caller observes it after the call.
function reset(state: { ready: boolean }): void {
  (state as { ready: boolean }).ready = false;
}
const state = { ready: true };
reset(state);
console.log("reset", JSON.stringify(state));
