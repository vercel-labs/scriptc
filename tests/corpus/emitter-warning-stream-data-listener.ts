// @exit: 1
// The leak warning's emitter over a stream: emitting 'data' through it
// reaches the typed listener the program registered on the stream, with the
// argument converted to the listener's parameter. The default report prints
// the pid on stderr, so the @exit directive keeps stderr out of the
// comparison.
import { Buffer } from "node:buffer";
import { Readable } from "node:stream";

const stream = new Readable({ read() {} });
stream.setMaxListeners(1);
stream.on("data", (chunk: Buffer) => {
  console.log(`data ${chunk.toString()} ${Buffer.isBuffer(chunk)}`);
});
process.on("warning", (warning: Error) => {
  console.log(`warning ${warning.name}`);
  const emitter = (warning as any).emitter;
  console.log(`fired ${emitter.emit("data", Buffer.from("xy"))}`);
});
stream.on("data", () => {});
stream.on("data", () => {});
process.exitCode = 1;
