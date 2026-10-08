// Presence tests on bindings that hold an array element read past the end.
// The declared element type omits undefined, so each test must inspect the
// stored value rather than assume the element is present.

class Crate {
  label: string;
  constructor(label: string) {
    this.label = label;
  }
}

const crates: Crate[] = [new Crate("north"), new Crate("south")];
const spare = new Crate("spare");

// Annotated optional bindings narrowed by assignment.
let slot: Crate | undefined = crates[9];
console.log("annotated", slot === undefined, slot !== undefined, slot == null, slot != null);
console.log("truthiness", !slot, slot ? "present" : "absent", typeof slot === "undefined");
console.log("fallbacks", (slot ?? spare).label, (slot || spare).label, slot?.label);
if (slot) console.log("unexpected", slot.label);
else console.log("absent branch");

let held: Crate | undefined = crates[1];
console.log("present", held === undefined, held == null, !held, (held ?? spare).label, typeof held);

// Unannotated bindings and reassignment.
const loose = crates[5];
console.log("loose", loose === undefined, typeof loose, loose === spare, spare === loose);
let moving: Crate | undefined = new Crate("start");
console.log("before", moving === undefined);
moving = crates[4];
console.log("after", moving === undefined ? "gone" : moving.label);

// A loop that walks past the end of the array.
let seen = "";
for (let i = 0; i < 4; i++) {
  const item: Crate | undefined = crates[i];
  seen += item === undefined ? "-" : item.label[0];
}
console.log("loop", seen);
let cursor: Crate | undefined = crates[0];
let steps = 0;
while (cursor !== undefined) {
  steps++;
  cursor = crates[steps];
}
console.log("walk", steps);

// Function locals, closures and parameters.
function inspect(index: number): string {
  const found = crates[index];
  const late = (): boolean => found === undefined;
  if (found !== undefined) return `found ${found.label} ${late()}`;
  return `missing ${late()} ${!found}`;
}
console.log(inspect(0), inspect(7));

function describe(crate: Crate): string {
  return crate === undefined ? "none" : crate.label;
}
console.log(describe(crates[0]), describe(crates[3]));

// Strings and records follow the same rule.
const words: string[] = ["alpha"];
let word: string | undefined = words[2];
console.log("word", word === undefined, word ?? "fallback", typeof word);
type Point = { x: number; y: number };
const points: Point[] = [{ x: 1, y: 2 }];
let point: Point | undefined = points[3];
console.log("point", point === undefined, point == null, point ? point.x : -1);
point = points[0];
console.log("point again", point === undefined, point ? point.x : -1);

// A value proven present by a guard keeps its fast path.
const first = crates[0];
if (first !== undefined) console.log("guarded", first === undefined, !first, first.label);
