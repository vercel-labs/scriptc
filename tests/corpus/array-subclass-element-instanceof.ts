// Instances of classes that extend Array read back from an array of them
// (an element read is `Row | undefined`) still answer instanceof for their
// own class and Array, false for another Array subclass, and plain arrays
// answer false.
class Row extends Array<number> {
  sum(): number {
    let s = 0;
    for (const v of this) s += v;
    return s;
  }
}
class Column extends Array<number> {}

function rows(n: number): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < n; i++) {
    const row = new Row();
    for (let j = 0; j <= i; j++) row.push(j);
    out.push(row);
  }
  return out;
}

const lines: number[][] = [new Row(), new Column(), [1, 2]];

const table = rows(6);
console.log(table.length, table[5]!.sum(), table[5] instanceof Row, table[5] instanceof Column);
console.log(table[4] instanceof Row, table[4] instanceof Array);
console.log(table.at(-1) instanceof Row, table.at(10) instanceof Row);
const plain: number[][] = [[1, 2]];
console.log(plain[0] instanceof Row, plain[0] instanceof Array);
const kinds = lines.map((r) => (r instanceof Column ? "column" : r instanceof Row ? "row" : "plain"));
console.log(kinds.join(","));
let checks = 0;
for (let round = 0; round < 20; round++)
  checks += rows(6).reduce((s, r) => s + (r instanceof Row ? r.sum() : 0), 0);
console.log(checks);
