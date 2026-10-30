// Localized failure, stage L1: locals, loop variables and module globals
// whose declared type has no static lowering hold checked-dynamic values.
type Progress = (done: number, total: number) => void;
type Callbacks = Progress | AbortSignal | Map<string, (x: number) => string> | Set<number>;

const report: Progress = (done, total) => console.log(`progress ${done}/${total}`);
const seen = new Set<number>([1, 2, 3]);

// A module global, written with typed values of several arms.
let current: Callbacks | undefined = report;

function describe(label: string): void {
  // A local of the same declared type.
  const local: Callbacks | undefined = current;
  if (local === undefined) {
    console.log(label, "none");
  } else if (typeof local === "function") {
    local(1, 2);
    console.log(label, "function", local === report);
  } else if (local instanceof Set) {
    console.log(label, "set", local.size, local.has(2), local === seen);
    local.add(4);
  } else {
    console.log(label, "other");
  }
}

describe("first");
current = seen;
describe("second");
console.log("typed alias sees the write", seen.size, seen.has(4));
current = undefined;
describe("third");

// A loop variable over an array whose element type does not compile.
const all: (Callbacks | number)[] = [report, seen, 7];
for (const item of all) {
  if (typeof item === "number") console.log("number", item + 1);
  else if (typeof item === "function") item(3, 4);
  else console.log("object", item instanceof Set);
}
all.push(9);
console.log(all.length);
