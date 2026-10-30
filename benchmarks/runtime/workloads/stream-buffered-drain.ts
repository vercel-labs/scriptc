// Readable streams that buffer many chunks before anyone reads them, then
// drain: 200,000 objects pushed into an object-mode Readable and taken
// with read() in a 'readable' handler, and 100,000 small Buffers pushed
// into a byte-mode Readable and piped into a Writable.
import { Readable, Writable } from "node:stream";

const objects = new Readable({ objectMode: true, highWaterMark: 16, read() {} });
for (let i = 0; i < 200000; i++) objects.push({ id: i, qty: i % 9 });
objects.push(null);

let taken = 0;
let qty = 0;
objects.on("readable", () => {
  let row: { id: number; qty: number } | null;
  while ((row = objects.read() as { id: number; qty: number } | null) !== null) {
    taken++;
    qty += row.qty;
  }
});
objects.on("end", () => {
  console.log(`objects taken=${taken} qty=${qty}`);
  const bytes = new Readable({ read() {} });
  for (let i = 0; i < 100000; i++) bytes.push(Buffer.from([i & 0xff, (i >> 8) & 0xff, 7]));
  bytes.push(null);
  let length = 0;
  let sum = 0;
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      length += chunk.length;
      for (const b of chunk) sum = (sum + b) % 65521;
      cb();
    },
  });
  sink.on("finish", () => console.log(`bytes length=${length} sum=${sum}`));
  bytes.pipe(sink);
});
