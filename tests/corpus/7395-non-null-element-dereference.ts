// Member reads and writes through non-null asserted array element reads.
// `!` performs no runtime check: a missing element is undefined, so the
// member access throws Node's TypeError, which the program can catch.

class Cell {
  count = 0;
  label: string;
  constructor(label: string) {
    this.label = label;
  }
  bump(): number {
    return ++this.count;
  }
}

function cell(label: string): Cell {
  return new Cell(label);
}

const cells = [cell("a"), cell("b")];
const words = ["alpha", "beta"];
const grid = [
  [1, 2],
  [3, 4],
];
const maps = [new Map<string, number>([["x", 1]])];
const holey: Cell[] = [];
holey[2] = cell("z");
let reads = 0;
function at(n: number): number {
  reads++;
  return n;
}

function attempt(label: string, f: () => unknown): void {
  try {
    console.log(label.padEnd(12), "ok", f());
  } catch (e) {
    const error = e as Error;
    console.log(label.padEnd(12), error instanceof TypeError, error.message);
  }
}

for (const k of [0, 1, 2, -1]) {
  attempt(`label ${k}`, () => cells[k]!.label);
  attempt(`bump ${k}`, () => cells[k]!.bump());
  attempt(`set ${k}`, () => (cells[k]!.label = "set"));
  attempt(`count++ ${k}`, () => cells[k]!.count++);
  attempt(`length ${k}`, () => words[k]!.length);
  attempt(`upper ${k}`, () => words[k]!.toUpperCase());
  attempt(`grid ${k}`, () => grid[k]![0]);
  attempt(`row ${k}`, () => {
    const j = 1;
    return grid[k]![j];
  });
  attempt(`push ${k}`, () => grid[k]!.push(9));
  attempt(`map ${k}`, () => maps[k]!.get("x"));
}

attempt("hole", () => holey[0]!.label);
attempt("hole value", () => holey[2]!.label);
attempt("order", () => cells[at(7)]!.count + at(1));
console.log("reads", reads);

let total = 0;
try {
  for (let i = 0; i < 4; i++) total += grid[i]![0]!;
} catch (e) {
  console.log("loop", (e as Error).message, total);
}
console.log(cells.map((c) => `${c.label}:${c.count}`).join(" "));

// A write through a missing element evaluates the key and the value before
// it throws; an error the value throws is the one that propagates.
const events: string[] = [];
const note = (event: string, value: number): number => {
  events.push(event);
  return value;
};
attempt("write order", () => {
  cells[note("index", 7)]!.count = note("value", 1);
});
attempt("write key order", () => {
  grid[note("row", 9)]![note("column", 0)] = note("cell", 5);
});
attempt("write literal key", () => {
  grid[9]![0] = note("cell 0", 5);
});
attempt("value throws", () => {
  cells[7]!.count = (() => {
    throw new Error("from the value");
  })();
});
attempt("present write", () => {
  cells[0]!.count = note("present", 41) + 1;
  return cells[0]!.count;
});
console.log("events", events.join(","));

// The array is read before an index that replaces it.
let current = [new Cell("first")];
const replace = (): number => {
  current = [];
  return 0;
};
attempt("replaced read", () => current[replace()]!.label);
current = [new Cell("second")];
attempt("replaced write", () => {
  current[replace()]!.label = "written";
});
let names = ["kept"];
attempt("replaced string", () => `${names[(names = [], 0)]!}`);
console.log(current.length, names.length);

// The element is read before the key and the value: a value that replaces,
// removes or adds it writes to, or misses, the element the target read, and
// a key the value reassigns is the one read before it.
const slots = [new Cell("p"), new Cell("q")];
const original = slots[0]!;
attempt("value replaces", () => {
  slots[0]!.label = ((slots[0] = new Cell("r")), "set");
  return `${original.label} ${slots[0]!.label}`;
});
const tail = slots[1]!;
attempt("value removes", () => {
  slots[1]!.label = (slots.pop(), "gone");
  return `${tail.label} ${slots.length}`;
});
attempt("value adds", () => {
  slots[1]!.label = (slots.push(new Cell("s")), "added");
});
const table: number[][] = [[1, 2]];
let column = 0;
attempt("value moves key", () => {
  table[0]![column] = ((column = 1), 5);
  return table[0]!.join(",");
});
column = 0;
attempt("value moves missing key", () => {
  table[4]![column] = ((column = 1), 5);
});
console.log(slots.length, column);
