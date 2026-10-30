// for await over an object-mode Readable and over a Transform's output
// yields the objects that were pushed.
import { Readable, Transform } from "node:stream";

type Entry = { key: string; value: number };

const entries: Entry[] = [];
let n = 0;
const source = new Readable({
  objectMode: true,
  read() {
    if (n < 4) {
      const entry = { key: `k${n}`, value: n * 10 };
      entries.push(entry);
      n++;
      this.push(entry);
    } else {
      this.push(null);
    }
  },
});
const outputs: Entry[] = [];
const double = new Transform({
  objectMode: true,
  transform(entry: Entry, _enc, cb) {
    const out = { key: entry.key.toUpperCase(), value: entry.value * 2 };
    outputs.push(out);
    cb(null, out);
  },
});

async function main(): Promise<void> {
  const copy = new Readable({ objectMode: true, read() {} });
  for (const entry of [{ key: "a", value: 1 }, { key: "b", value: 2 }]) copy.push(entry);
  copy.push(null);
  for await (const entry of copy) console.log(`copy ${entry.key}=${entry.value}`);
  let index = 0;
  for await (const entry of source.pipe(double)) {
    console.log(`${entry.key}=${entry.value} same=${entry === outputs[index]} source=${entries.includes(entry)}`);
    index++;
  }
  console.log(`count ${index}`);
}
void main();
