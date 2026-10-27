// A program without weak collections still keeps the undeclared keys of
// checked records, and forgets them when the record is freed: a record
// built later at the same address (the allocator reuses freed blocks of
// its size) serializes only its own fields. Class instances and records
// of shapes that never keep a source free without the dispose hook.
interface Row {
  id: number;
  name: string;
}
class Point {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
}

function parsedRows(round: number): Row[] {
  const text =
    `[{"id":${round},"extra":"kept-${round}","name":"a"},` +
    `{"name":"b","id":${round + 1}},` +
    `{"id":${round + 2},"name":"c","tags":[${round}]}]`;
  return JSON.parse(text) as Row[];
}

let checksum = 0;
for (let round = 0; round < 3; round++) {
  const rows = parsedRows(round);
  console.log(JSON.stringify(rows));
  // Drop the parsed rows, then build fresh rows of the same shape.
  rows.length = 0;
  const fresh: Row[] = [];
  for (let i = 0; i < 64; i++) fresh.push({ id: i, name: "n" + i });
  const text = JSON.stringify(fresh);
  checksum += text.length;
  console.log(text.includes("extra"), text.includes("tags"), Object.keys(fresh[0]!).join(","));
}
console.log(checksum);

let sum = 0;
for (let i = 0; i < 10000; i++) {
  const p = new Point(i, -i);
  const r = { a: p.x, b: [p.y] };
  sum += r.a + r.b[0]!;
}
console.log(sum);
