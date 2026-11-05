// Arrays, union-typed values, strings and Buffers in object-mode streams,
// alone and mixed with records in one stream, reach their consumers as
// the values that were pushed.
import { Readable, Transform, Writable } from "node:stream";

type Pair = { a: number; b: number };
type Shape = { kind: "circle"; r: number } | { kind: "square"; side: number };

const log: string[] = [];
const arrays: number[][] = [[1, 2], [3], []];
const shapes: Shape[] = [
  { kind: "circle", r: 2 },
  { kind: "square", side: 3 },
];
const first: Pair = { a: 1, b: 2 };
const second: Pair = { a: 3, b: 4 };
const pairs: Pair[] = [first, second];

const arraySource = new Readable({ objectMode: true, read() {} });
for (const arr of arrays) arraySource.push(arr);
arraySource.push(null);
const arraySink = new Writable({
  objectMode: true,
  write(arr: number[], _enc, cb) {
    log.push(`array [${arr.join(",")}] same=${arrays.includes(arr)}`);
    cb();
  },
});

const shapeSource = new Readable({ objectMode: true, read() {} });
for (const shape of shapes) shapeSource.push(shape);
shapeSource.push(null);
const area = new Transform({
  objectMode: true,
  transform(shape: Shape, _enc, cb) {
    const size = shape.kind === "circle" ? shape.r : shape.side;
    log.push(`shape ${shape.kind} ${size} same=${shapes.includes(shape)}`);
    cb(null, shape);
  },
});
const shapeSink = new Writable({
  objectMode: true,
  write(shape: Shape, _enc, cb) {
    log.push(`shape out ${shape.kind} same=${shapes.includes(shape)}`);
    cb();
  },
});

const mixed = new Readable({ objectMode: true, read() {} });
mixed.push(first);
mixed.push("text");
mixed.push(second);
mixed.push(Buffer.from("buf"));
mixed.push(null);
const mixedSink = new Writable({
  objectMode: true,
  write(value: any, _enc, cb) {
    if (typeof value === "string") log.push(`mixed string ${value}`);
    else if (Buffer.isBuffer(value)) log.push(`mixed buffer ${value.toString()}`);
    else log.push(`mixed pair ${value.a},${value.b} same=${pairs.includes(value)}`);
    cb();
  },
});

const later = new Readable({ objectMode: true, read() {} });
later.push("first");
later.push(first);
later.push(null);
const laterSink = new Writable({
  objectMode: true,
  write(value: any, _enc, cb) {
    log.push(`later ${typeof value} ${value === first}`);
    cb();
  },
});

let finished = 0;
const done = (): void => {
  finished++;
  if (finished === 4) for (const line of log) console.log(line);
};
arraySink.on("finish", done);
shapeSink.on("finish", done);
mixedSink.on("finish", done);
laterSink.on("finish", done);
arraySource.pipe(arraySink);
shapeSource.pipe(area).pipe(shapeSink);
mixed.pipe(mixedSink);
later.pipe(laterSink);
