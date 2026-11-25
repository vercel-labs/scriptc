// Compound assignments to the fields of a typed record that reaches a helper
// through an untyped parameter, or through an interface a class also
// implements. Each helper only performs the assignment, so the record is used
// through property operations alone; the totals are read from the record
// afterwards.
type Ledger = { credit: number; debit: number; note: string };

let draws = 0;
function draw(): number {
  draws += 1;
  return draws * 10;
}

function addCredit(target: unknown): void {
  const book = target as Record<string, number>;
  book.credit += 2;
}
function subtractDebit(target: unknown): void {
  const book = target as Record<string, number>;
  book.debit -= 3;
}
function scaleCredit(target: any): void {
  target.credit *= 4;
}
function addDrawn(target: any): void {
  target.credit += draw();
}
function settle(target: unknown): void {
  const book = target as Record<string, number>;
  book.credit += 1;
  book.debit += book.credit!;
}

const ledger: Ledger = { credit: 1, debit: 20, note: "open" };
addCredit(ledger);
console.log(ledger.credit, ledger.debit, ledger.note);
subtractDebit(ledger);
console.log(ledger.credit, ledger.debit, ledger.note);
scaleCredit(ledger);
console.log(ledger.credit, ledger.debit, ledger.note);
addDrawn(ledger);
addDrawn(ledger);
console.log(ledger.credit, ledger.debit, ledger.note, draws);
settle(ledger);
console.log(ledger.credit, ledger.debit, ledger.note);

// The same assignment through an interface: the gauge class makes the
// interface a view of any object, and the reading record is passed as one.
interface Level {
  depth: number;
  width: number;
  label: string;
}
interface Reading extends Level {
  station: string;
}
class Gauge implements Level {
  depth: number;
  width: number;
  label: string;
  constructor(depth: number, width: number) {
    this.depth = depth;
    this.width = width;
    this.label = "g";
  }
}
function deepen(level: Level): void {
  level.depth += 1;
}
function widen(level: Level | null): void {
  if (level === null) return;
  level.width *= 2;
}
function shrink<T extends Level>(level: T): void {
  level.depth -= 5;
  level.width -= level.depth;
}

function relabel(level: Level): void {
  level.label += "!";
}

const reading: Reading = { depth: 1, width: 2, label: "r", station: "north" };
const gauge = new Gauge(1, 2);
deepen(reading);
deepen(gauge);
console.log(reading.depth, reading.width, reading.station, gauge.depth, gauge.width);
widen(reading);
widen(gauge);
widen(null);
console.log(reading.depth, reading.width, gauge.depth, gauge.width);
shrink(reading);
shrink(gauge);
console.log(reading.depth, reading.width, gauge.depth, gauge.width);
for (let round = 0; round < 3; round++) deepen(reading);
console.log(reading.depth, gauge.depth);
relabel(reading);
relabel(gauge);
relabel(reading);
console.log(reading.label, gauge.label, reading.station);
