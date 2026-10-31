// Chunks are shared, not copied: a change to an object after push() is
// visible to the consumer that reads it later, and a change a Transform
// makes reaches the next stage.
import { PassThrough, Transform, Writable } from "node:stream";

type Cell = { row: number; value: number };

const cells: Cell[] = [];
const log: string[] = [];
const bump = new Transform({
  objectMode: true,
  transform(cell: Cell, _enc, cb) {
    log.push(`transform ${cell.row} value=${cell.value}`);
    cell.value += 100;
    cb(null, cell);
  },
});
const sink = new Writable({
  objectMode: true,
  write(cell: Cell, _enc, cb) {
    log.push(`write ${cell.row} value=${cell.value} same=${cell === cells[cell.row]}`);
    cb();
  },
});
const source = new PassThrough({ objectMode: true });
source.pause();
for (let r = 0; r < 3; r++) {
  const cell = { row: r, value: r };
  cells.push(cell);
  source.write(cell);
  cell.value = r * 10;
}
sink.on("finish", () => {
  for (const line of log) console.log(line);
  console.log(cells.map((c) => c.value).join(","));
});
source.pipe(bump).pipe(sink);
source.end();
