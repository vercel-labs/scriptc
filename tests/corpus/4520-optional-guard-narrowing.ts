// Guards that prove a value present before it reaches a typed parameter,
// next to unguarded and invalidated values that still reach it as undefined.
class Parcel {
  weight: number;
  constructor(weight: number) {
    this.weight = weight;
  }
}

function describe(parcel: Parcel): string {
  return parcel === undefined ? "missing" : `parcel ${parcel.weight}`;
}

function heavier(parcel: Parcel, limit: number): boolean {
  return parcel !== undefined && parcel.weight > limit;
}

const shelf: Parcel[] = [new Parcel(3), new Parcel(8)];

function strictGuard(index: number): string {
  const parcel = shelf[index];
  if (parcel === undefined) return "none";
  return describe(parcel);
}

function looseGuard(index: number): string {
  const parcel = shelf[index];
  if (parcel == null) return "none";
  return describe(parcel);
}

function truthyGuard(index: number): string {
  const parcel = shelf[index];
  return parcel ? describe(parcel) : "none";
}

function andGuard(index: number): boolean {
  const parcel = shelf[index];
  return parcel !== undefined && heavier(parcel, 5);
}

function orGuard(index: number): boolean {
  const parcel = shelf[index];
  return parcel === undefined || heavier(parcel, 5);
}

function typeofGuard(index: number): string {
  const parcel = shelf[index];
  if (typeof parcel !== "object") return "not a parcel";
  return describe(parcel);
}

function dereferenceGuard(index: number): string {
  const parcel = shelf[index];
  try {
    const weight = parcel.weight;
    return `${weight} ${describe(parcel)}`;
  } catch (error) {
    return String(error).startsWith("TypeError") ? "TypeError" : "other";
  }
}

function defaulted(index: number): string {
  const parcel = shelf[index] ?? new Parcel(0);
  return describe(parcel);
}

function unguarded(index: number): string {
  const parcel = shelf[index];
  return describe(parcel);
}

function guardThenReassign(index: number): string {
  let parcel = shelf[index];
  if (parcel === undefined) return "none";
  const first = describe(parcel);
  parcel = shelf[index + 5];
  return `${first} / ${describe(parcel)}`;
}

function guardInOtherBranch(index: number, flip: boolean): string {
  const parcel = shelf[index];
  if (flip) {
    if (parcel === undefined) return "none";
  }
  return describe(parcel);
}

function guardBeforeLoopExit(): string[] {
  const out: string[] = [];
  for (let i = 0; i < 4; i++) {
    const parcel = shelf[i];
    if (!parcel) continue;
    out.push(describe(parcel));
  }
  return out;
}

function guardedClosure(index: number): () => string {
  const parcel = shelf[index];
  if (parcel === undefined) return () => "closure none";
  return () => describe(parcel);
}

function hoistedReader(index: number): string {
  const parcel = shelf[index];
  if (parcel === undefined) return read();
  function read(): string {
    return describe(parcel);
  }
  return read();
}

for (const index of [0, 1, 4]) {
  console.log(
    strictGuard(index),
    looseGuard(index),
    truthyGuard(index),
    andGuard(index),
    orGuard(index),
    typeofGuard(index),
  );
  console.log(dereferenceGuard(index), defaulted(index), unguarded(index));
  console.log(guardThenReassign(index), guardInOtherBranch(index, true), guardInOtherBranch(index, false));
  console.log(guardedClosure(index)(), hoistedReader(index));
}
console.log(guardBeforeLoopExit().join(", "));

// A value narrowed from an optional source keeps its guard through a call.
const cache: (Parcel | undefined)[] = [new Parcel(1), undefined];
function lookup(index: number): Parcel | undefined {
  return cache[index];
}
for (const index of [0, 1, 2]) {
  const found = lookup(index);
  if (found !== undefined) console.log("found", describe(found));
  else console.log("not found", index);
}

// A callback slot typed with undefined passes through a guarded store.
function each(visit: (parcel: Parcel | undefined) => void): void {
  visit(new Parcel(4));
  visit(undefined);
}
let last: Parcel | undefined = undefined;
each((parcel) => {
  if (parcel !== undefined) last = parcel;
});
const kept: Parcel | undefined = last;
if (kept !== undefined) console.log("kept", describe(kept));

// Assertions on proven values forward present values; unproven ones may
// still forward undefined, which the callee observes.
function viaAssertion(index: number): string {
  const parcel = shelf[index];
  if (parcel === undefined) return "none";
  return describe(parcel!);
}
let checkedTotal = 0;
for (let i = 0; i < shelf.length; i++) checkedTotal += heavier(shelf[i]!, 4) ? 1 : 0;
console.log(viaAssertion(0), viaAssertion(7), checkedTotal, describe(shelf[9]!));
