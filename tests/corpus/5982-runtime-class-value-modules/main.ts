// Runtime class values exported from one module and used in another:
// arrays of error and stream classes, and functions taking a class.
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { build, describe, errorKinds, streamKinds } from "./kinds.ts";
import * as kinds from "./kinds.ts";

for (const Kind of errorKinds) console.log(describe(Kind, "from main"));
for (const Kind of kinds.streamKinds) {
  const stream = new Kind();
  console.log(Kind.name, stream instanceof Kind, stream instanceof Readable);
}
const emitter = build(EventEmitter);
emitter.on("done", () => console.log("done"));
emitter.emit("done");
console.log(streamKinds.length, errorKinds[0] === TypeError, kinds.errorKinds[1] === RangeError);
