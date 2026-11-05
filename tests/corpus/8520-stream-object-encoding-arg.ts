// The encoding argument a typed write or transform callback receives:
// undefined for an object-mode write without one, the given string with
// one, and 'buffer' for byte-mode chunks.
import { Transform, Writable } from "node:stream";

const seen: string[] = [];
const objects = new Writable({
  objectMode: true,
  write(chunk: { n: number }, encoding, cb) {
    seen.push(`object ${chunk.n} ${typeof encoding} ${String(encoding)}`);
    cb();
  },
});
objects.write({ n: 1 });
objects.write({ n: 2 }, "utf8");
objects.write({ n: 3 }, undefined);
objects.end(() => {
  const bytes = new Writable({
    write(chunk: Buffer, encoding, cb) {
      seen.push(`bytes ${chunk.length} ${typeof encoding} ${String(encoding)}`);
      cb();
    },
  });
  bytes.write("abc");
  bytes.write(Buffer.from("de"));
  bytes.end(() => {
    const upper = new Transform({
      objectMode: true,
      transform(row: { n: number }, encoding, cb) {
        seen.push(`transform ${row.n} ${typeof encoding} ${String(encoding)}`);
        cb(null, { n: row.n * 10 });
      },
    });
    upper.on("data", (row: { n: number }) => seen.push(`data ${row.n}`));
    upper.on("end", () => {
      for (const line of seen) console.log(line);
    });
    upper.write({ n: 4 });
    upper.write({ n: 5 }, "latin1");
    upper.end();
  });
});
