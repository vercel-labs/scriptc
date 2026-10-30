// A group too large for one arena: past its byte cap the rest of the
// group goes to the heap, and both parts are released together.
interface Cell {
  index: number;
  label: string;
  next: Cell | null;
}

function list(n: number): Cell {
  let head: Cell = { index: 0, label: "c0", next: null };
  const first = head;
  for (let i = 1; i < n; i++) {
    const cell: Cell = { index: i, label: i % 1000 === 0 ? `c${i}` : "c", next: null };
    head.next = cell;
    head = cell;
  }
  return first;
}

function walk(c: Cell | null): number {
  let total = 0;
  let labels = 0;
  for (let at = c; at !== null; at = at.next) {
    total += at.index;
    if (at.label.length > 1) labels++;
  }
  return total + labels;
}

for (let round = 0; round < 3; round++) console.log("cells", walk(list(900000 + round)));
