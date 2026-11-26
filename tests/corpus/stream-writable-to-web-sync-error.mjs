// A native writable that fails its write synchronously while the chunk is
// backpressured: the writer's first write resolves (the failure emptied the
// queue, so the sink needs no drain), and the writes after it reject with the
// stream's error. The writable keeps its own lifecycle there: a stream with
// autoDestroy: false stays open and runs no _destroy.
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

const events = [];
const open = new Writable({
  autoDestroy: false,
  highWaterMark: 1,
  write(_chunk, _enc, cb) {
    cb(new Error("boom"));
  },
  destroy(error, cb) {
    events.push(`destroy ${error === null ? "none" : error.message}`);
    cb(error);
  },
});
open.on("error", (error) => events.push(`error ${error.message}`));
const openWriter = Writable.toWeb(open).getWriter();
const openFirst = await openWriter.write("x").then(() => "resolved", (e) => `rejected ${e.message}`);
const openSecond = await openWriter.write("y").then(() => "resolved", (e) => `rejected ${e.message}`);
await new Promise((resolve) => setTimeout(resolve, 20));
console.log(
  "autoDestroy false",
  openFirst,
  "|",
  openSecond,
  "| destroyed",
  open.destroyed,
  "| events",
  events.join(","),
);
