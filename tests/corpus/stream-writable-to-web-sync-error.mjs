// A native writable that fails its write synchronously while the chunk is
// backpressured: the writer's first write resolves (the failure emptied the
// queue, so the sink needs no drain), and the writes after it reject with the
// stream's error.
import { Writable } from "node:stream";

const writable = new Writable({
  highWaterMark: 1,
  write(_chunk, _enc, cb) {
    cb(new Error("boom"));
  },
});
const writer = Writable.toWeb(writable).getWriter();

const first = await writer.write("x").then(() => "resolved", (e) => `rejected ${e.message}`);
const second = await writer.write("y").then(() => "resolved", (e) => `rejected ${e.message}`);
await new Promise((resolve) => setTimeout(resolve, 20));
const third = await writer.write("z").then(() => "resolved", (e) => `rejected ${e.message}`);
console.log("first", first, "| second", second, "| third", third);
