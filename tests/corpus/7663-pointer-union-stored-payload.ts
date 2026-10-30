// Records passed to `T | undefined` parameters whose callee keeps the
// narrowed record: pushed into a global array (also through a non-null
// assertion), kept through `??`, stored in a nullable class field or a record
// field, or passed on to a callee that keeps it. Each record must outlive its
// caller's frame. A callee that only reads the narrowed record lets it stay
// where it is.
interface Tagged {
  id: number;
  tags: string[];
}
interface Slot {
  held: Tagged | undefined;
}
const kept: Tagged[] = [];
const slot: Slot = { held: undefined };
function pushNarrowed(t: Tagged | undefined): void {
  if (t !== undefined) kept.push(t);
}
function pushAsserted(t: Tagged | undefined): void {
  kept.push(t!);
}
function keepDefaulted(t: Tagged | undefined): void {
  kept.push(t ?? { id: -1, tags: [] });
}
function storeInSlot(t: Tagged | undefined): void {
  if (t !== undefined) slot.held = t;
}
function keepRecord(t: Tagged): void {
  kept.push(t);
}
function passOn(t: Tagged | undefined): void {
  if (t !== undefined) keepRecord(t);
}
function readOnly(t: Tagged | undefined): number {
  return t === undefined ? 0 : t.id + t.tags.length;
}
class Holder {
  last: Tagged | undefined = undefined;
  take(t: Tagged | undefined): void {
    this.last = t;
  }
}
const holder = new Holder();
function fill(round: number): number {
  let read = 0;
  for (let i = 0; i < 3; i++) {
    const a: Tagged = { id: round * 10 + i, tags: ["a", String(i)] };
    pushNarrowed(a);
    const b: Tagged = { id: round * 10 + i + 100, tags: ["b"] };
    keepDefaulted(b);
    const c: Tagged = { id: round * 10 + i + 200, tags: ["c"] };
    storeInSlot(c);
    const d: Tagged = { id: round * 10 + i + 300, tags: ["d", "d"] };
    holder.take(d);
    const e: Tagged = { id: round * 10 + i + 400, tags: [] };
    passOn(e);
    const g: Tagged = { id: round * 10 + i + 600, tags: ["g", "g", "g"] };
    pushAsserted(g);
    const f: Tagged = { id: round * 10 + i + 500, tags: ["f"] };
    read += readOnly(f);
  }
  return read;
}
// Reuses the stack the callers above ran on, and allocates collectable
// records, before the kept ones are read.
function churn(n: number): number {
  let total = 0;
  for (let i = 0; i < n; i++) {
    const t: Tagged = { id: i, tags: [String(i), String(i + 1)] };
    total += t.tags.length + readOnly(t);
  }
  return total;
}
let reads = 0;
for (let round = 0; round < 4; round++) {
  reads += fill(round);
  reads += churn(200);
}
console.log("reads", reads);
console.log("kept", kept.length);
for (const t of kept) console.log(t.id, t.tags.join("+"));
console.log("slot", slot.held === undefined ? "none" : slot.held.id, slot.held?.tags.join("+"));
console.log("holder", holder.last === undefined ? "none" : holder.last.id, holder.last?.tags.join("+"));
