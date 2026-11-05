// Object-mode chunks keep their identity through a Readable, a Transform
// and a Writable: each stage receives the object the previous stage
// pushed or passed to its callback.
import { Readable, Transform, Writable } from "node:stream";

type Row = { id: number; qty: number };

const pushed: Row[] = [];
const made: Row[] = [];
const seen = new Map<Row, number>();
let produced = 0;
const source = new Readable({
  objectMode: true,
  highWaterMark: 2,
  read() {
    while (produced < 6) {
      produced++;
      const row = { id: produced, qty: produced * 3 };
      pushed.push(row);
      seen.set(row, produced);
      if (!this.push(row)) return;
    }
    this.push(null);
  },
});
const lines: string[] = [];
const pass = new Transform({
  objectMode: true,
  transform(row: Row, _enc, cb) {
    lines.push(`transform ${row.id} same=${row === pushed[row.id - 1]} map=${seen.get(row)}`);
    if (row.id % 2 === 0) {
      cb(null, row);
      return;
    }
    const next = { id: row.id, qty: row.qty + 1 };
    made.push(next);
    cb(null, next);
  },
});
const sink = new Writable({
  objectMode: true,
  highWaterMark: 1,
  write(row: Row, _enc, cb) {
    const original = row === pushed[row.id - 1];
    const fresh = made.includes(row);
    lines.push(`write ${row.id} qty=${row.qty} original=${original} fresh=${fresh}`);
    cb();
  },
});
sink.on("finish", () => {
  for (const line of lines) console.log(line);
  console.log(`pushed ${pushed.length} made ${made.length}`);
});
source.pipe(pass).pipe(sink);
