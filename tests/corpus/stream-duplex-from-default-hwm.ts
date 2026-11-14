// Duplex.from's async-function body takes the object-mode default high-water
// mark: Node's duplexify builds an ordinary Duplex, whose highWaterMark is
// the module default at construction, so setDefaultHighWaterMark(true, n)
// moves both of the body's marks. A generator body keeps Readable.from's
// own 1.
import { Duplex, getDefaultHighWaterMark, setDefaultHighWaterMark } from "node:stream";

console.log("object default", getDefaultHighWaterMark(true));
setDefaultHighWaterMark(true, 3);
const fromAsync = Duplex.from(async function (source: AsyncIterable<string>): Promise<void> {
  for await (const chunk of source) console.log("chunk", chunk);
});
console.log(
  "async body",
  fromAsync.writableHighWaterMark,
  fromAsync.readableHighWaterMark,
  fromAsync.writableObjectMode,
  fromAsync.readableObjectMode,
);
const fromGenerator = Duplex.from(async function* () {
  yield "one";
});
console.log(
  "generator body",
  fromGenerator.writableHighWaterMark,
  fromGenerator.readableHighWaterMark,
);
fromAsync.end("x");
