// A WeakMap and a WeakSet keyed by the objects a Readable pushes find
// them again in a typed Writable, in an untyped 'data' listener, and in
// an untyped Writable downstream.
import { PassThrough, Readable, Writable } from "node:stream";

type Item = { name: string; n: number };

const tags = new WeakMap<Item, string>();
const marked = new WeakSet<object>();
const items: Item[] = [];
for (let i = 0; i < 4; i++) {
  const item = { name: `item${i}`, n: i };
  items.push(item);
  tags.set(item, `tag-${i}`);
  if (i % 2 === 0) marked.add(item);
}
let next = 0;
const source = new Readable({
  objectMode: true,
  read() {
    const item = items[next++];
    if (item === undefined) this.push(null);
    else this.push(item);
  },
});
const out: string[] = [];
const typed = new Writable({
  objectMode: true,
  write(item: Item, _enc, cb) {
    out.push(`typed ${item.name} ${tags.get(item)} ${marked.has(item)}`);
    cb();
  },
});
const middle = new PassThrough({ objectMode: true });
middle.on("data", (item: any) => {
  out.push(`data ${item.name} ${tags.get(item)} ${marked.has(item)}`);
});
const untyped = new Writable({
  objectMode: true,
  write(item: any, _enc, cb) {
    out.push(`untyped ${item.name} ${tags.get(item)} ${items.indexOf(item)}`);
    cb();
  },
});
let finished = 0;
const done = (): void => {
  finished++;
  if (finished === 2) for (const line of out) console.log(line);
};
typed.on("finish", done);
untyped.on("finish", done);
source.pipe(typed);
source.pipe(middle).pipe(untyped);
