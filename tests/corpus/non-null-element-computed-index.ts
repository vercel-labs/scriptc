// Member reads through non-null asserted element reads at computed indexes:
// `xs[xs.length - 1]!`, `xs[i + 1]!`, `xs[-i]!` and indexes read from
// fields. A missing element (past the end, before the start, a fraction,
// NaN, or an empty array) is undefined, so the member access throws Node's
// TypeError; a present one reads the member.

interface Gene {
  c: number;
  sc: number;
}

class Cell {
  label: string;
  constructor(label: string) {
    this.label = label;
  }
  shout(): string {
    return this.label.toUpperCase();
  }
}

function attempt(label: string, f: () => unknown): void {
  try {
    console.log(label.padEnd(16), "ok", f());
  } catch (e) {
    const error = e as Error;
    console.log(label.padEnd(16), error instanceof TypeError, error.message);
  }
}

// The fallback of a cumulative search, as fasta writes it.
function pick(genes: Gene[], rand: number): number {
  for (const gene of genes) {
    if (rand < gene.c) return gene.sc;
  }
  return genes[genes.length - 1]!.sc;
}

const genes: Gene[] = [
  { c: 0.25, sc: 97 },
  { c: 0.5, sc: 99 },
  { c: 0.75, sc: 103 },
];
const codes: number[] = [];
for (let k = 0; k < 8; k++) codes.push(pick(genes, k / 8));
console.log("codes", codes.join(","));
attempt("fallback", () => pick(genes, 2));
attempt("empty fallback", () => pick([], 0.5));

const cells = [new Cell("a"), new Cell("b"), new Cell("c")];
const none: Cell[] = [];
const holey: Cell[] = [];
holey[3] = new Cell("d");
const box = { at: 1, size: 3 };

for (const i of [0, 1, 2, 3, -1, 0.5, NaN]) {
  attempt(`last - ${i}`, () => cells[cells.length - 1 - i]!.label);
  attempt(`next ${i}`, () => cells[i + 1]!.label);
  attempt(`neg ${i}`, () => cells[-i]!.label);
  attempt(`double ${i}`, () => cells[i * 2]!.shout());
}
attempt("empty last", () => none[none.length - 1]!.label);
attempt("empty method", () => none[none.length - 1]!.shout());
attempt("hole last", () => holey[holey.length - 1]!.label);
attempt("hole before", () => holey[holey.length - 2]!.label);
attempt("field index", () => cells[box.at - 1]!.label);
attempt("field past", () => cells[box.size + box.at]!.label);
attempt("other length", () => cells[holey.length - 2]!.label);

const rows = [
  [1, 2],
  [3, 4],
];
attempt("row last", () => rows[rows.length - 1]![0]);
attempt("row past", () => rows[rows.length]![1]);
attempt("row length", () => rows[rows.length - 2]!.length);

// The same read in a loop that runs past the end.
let total = 0;
try {
  for (let i = 0; i < 5; i++) total += cells[cells.length - 1 - i]!.label.length;
} catch (e) {
  console.log("loop", (e as Error).message, total);
}
