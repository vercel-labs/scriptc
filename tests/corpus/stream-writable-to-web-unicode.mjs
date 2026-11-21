// Writable.toWeb's queuing strategy measures a string chunk's UTF-16 length,
// as Node's size function reads chunk.length.
import { Writable } from "node:stream";

const writable = new Writable({
  highWaterMark: 2,
  write(chunk, encoding, done) {
    setTimeout(done, 5);
  },
});
const writer = Writable.toWeb(writable).getWriter();
const pending = writer.write("é");
console.log("unicode desired pending", writer.desiredSize);
await pending;
console.log("unicode desired drained", writer.desiredSize);
