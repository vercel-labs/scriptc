// A Transform that declares fewer fields than the chunks carry: the
// fields it does not declare stay on the chunks it passes on, so the
// Writable after it, which declares them, reads them, and an untyped
// 'data' listener on the Transform lists them.
import { Readable, Transform, Writable } from "node:stream";

type Full = { id: number; name: string; score: number };
type Narrow = { id: number };

let k = 0;
const source = new Readable({
  objectMode: true,
  read() {
    if (k < 3) {
      this.push({ id: k, name: `n${k}`, score: k * 1.5 });
      k++;
    } else {
      this.push(null);
    }
  },
});
const log: string[] = [];
const narrow = new Transform({
  objectMode: true,
  transform(row: Narrow, _enc, cb) {
    log.push(`narrow ${row.id} ${JSON.stringify(row)}`);
    cb(null, row);
  },
});
narrow.on("data", (row: any) => log.push(`data ${Object.keys(row).join("/")} ${row.name}`));
const full = new Writable({
  objectMode: true,
  write(row: Full, _enc, cb) {
    log.push(`full ${row.id} ${row.name} ${row.score} ${JSON.stringify(row)}`);
    cb();
  },
});
full.on("finish", () => {
  for (const line of log) console.log(line);
});
source.pipe(narrow).pipe(full);
