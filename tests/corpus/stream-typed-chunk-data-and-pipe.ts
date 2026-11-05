// A 'data' listener and a pipe on one object-mode stream receive the same
// object; a property the listener adds is visible to the untyped
// consumer downstream, and the typed consumer sees the same object.
import { Readable, Writable } from "node:stream";

type Point = { x: number; y: number };

const points: Point[] = [];
let i = 0;
const source = new Readable({
  objectMode: true,
  read() {
    if (i < 3) {
      const p = { x: i, y: i * i };
      points.push(p);
      i++;
      this.push(p);
    } else {
      this.push(null);
    }
  },
});
const log: string[] = [];
let lastData: any = null;
source.on("data", (p: any) => {
  lastData = p;
  p.label = `p${p.x}`;
  log.push(`data ${p.x},${p.y} same=${p === points[p.x]}`);
});
const typed = new Writable({
  objectMode: true,
  write(p: Point, _enc, cb) {
    log.push(`typed ${p.x},${p.y} same=${p === points[p.x]} last=${p === lastData}`);
    cb();
  },
});
const untyped = new Writable({
  objectMode: true,
  write(p: any, _enc, cb) {
    log.push(`untyped ${p.x} ${p.label} keys=${Object.keys(p).join("/")} same=${p === points[p.x]}`);
    cb();
  },
});
let finished = 0;
const done = (): void => {
  finished++;
  if (finished === 2) {
    for (const line of log) console.log(line);
    console.log(JSON.stringify(points));
  }
};
typed.on("finish", done);
untyped.on("finish", done);
source.pipe(typed);
source.pipe(untyped);
