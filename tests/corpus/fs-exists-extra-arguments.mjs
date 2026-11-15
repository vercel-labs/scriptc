// fs.existsSync over a Buffer or `any` path with arguments after the path.
// @normalize-pid
// Node ignores those arguments but still evaluates them, left to right,
// before the call, so the value form evaluates them too, ahead of the
// answer and in source order.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const scratch = path.join(os.tmpdir(), `scr-exists-extra-${process.pid}.txt`);
fs.writeFileSync(scratch, "x");

const order = [];
const note = (tag) => {
  order.push(tag);
  return tag;
};

console.log("buffer hit:", fs.existsSync(Buffer.from(scratch, "utf8"), note("buffer 2")));
console.log(
  "buffer miss:",
  fs.existsSync(Buffer.from(scratch + ".absent", "utf8"), note("miss 2"), note("miss 3")),
);
const dynamic = JSON.parse("null");
console.log("any:", fs.existsSync(dynamic, note("any 2")));
console.log("order:", order.join(","));
console.log("after:", fs.existsSync(dynamic, note("second any 2")));
console.log("order:", order.join(","));

fs.unlinkSync(scratch);
