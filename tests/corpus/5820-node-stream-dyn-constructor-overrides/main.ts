// Constructor-function streams in NodeJS.ReadableStream / WritableStream
// slots: member calls run the stream's own pause, resume and on, and a pipe
// into one, and an unpipe of it, are the runtime's.
import { Readable } from "node:stream";
import { collector, recordingSource } from "./sources.js";

function control(stream: NodeJS.ReadableStream): void {
  stream.pause();
  stream.resume();
  stream.on("end", () => {});
}

function attach(src: Readable, dst: NodeJS.WritableStream): void {
  src.pipe(dst);
}

function detach(src: Readable, dst: NodeJS.WritableStream): void {
  src.unpipe(dst);
}

const recording = recordingSource();
control(recording);
console.log("recorded", recording.calls.join(","));

const sink = collector();
sink.on("pipe", () => console.log("pipe event"));
sink.on("unpipe", () => console.log("unpipe event"));
const source = new Readable({ read() {} });
attach(source, sink);
source.push("a");
setImmediate(() => {
  detach(source, sink);
  source.push("b");
  setImmediate(() => console.log("collected", sink.chunks.join(","), source.isPaused()));
});
