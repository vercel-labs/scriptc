// Builders whose groups hold instances of a class that extends Array,
// beside a builder whose group takes an arena. An Array subclass's
// instance is an array, so a group that allocates one keeps its objects on
// the heap; the results and their teardown match Node either way.
class Row extends Array<number> {
  sum(): number {
    let s = 0;
    for (const v of this) s += v;
    return s;
  }
}

class Branch {
  row: Row;
  left: Branch | null;
  right: Branch | null;
  constructor(row: Row, left: Branch | null, right: Branch | null) {
    this.row = row;
    this.left = left;
    this.right = right;
  }
  total(): number {
    return this.row.sum() + (this.left ? this.left.total() : 0) + (this.right ? this.right.total() : 0);
  }
}

class Pair {
  left: Pair | null;
  right: Pair | null;
  constructor(left: Pair | null, right: Pair | null) {
    this.left = left;
    this.right = right;
  }
  count(): number {
    return 1 + (this.left ? this.left.count() : 0) + (this.right ? this.right.count() : 0);
  }
}

function row(n: number): Row {
  const r = new Row();
  for (let j = 0; j <= n; j++) r.push(j);
  return r;
}

function branches(depth: number): Branch {
  return depth === 0
    ? new Branch(row(depth), null, null)
    : new Branch(row(depth), branches(depth - 1), branches(depth - 1));
}

function pairs(depth: number): Pair {
  return depth === 0 ? new Pair(null, null) : new Pair(pairs(depth - 1), pairs(depth - 1));
}

let checks = 0;
for (let round = 0; round < 20; round++) {
  const b = branches(6);
  const p = pairs(8);
  const r = row(round);
  checks += b.total() + p.count() + r.sum() + r.length;
  if (round === 0) console.log(b.total(), b.row.length, b.row instanceof Row, p.count(), r.sum());
}
console.log(checks);
