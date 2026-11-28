// The node:stream events: a flowing readable's data/end/close, a readable
// pulled through 'readable', pause and resume around data, a writable's
// drain/finish/close with a one-byte high-water mark, an error followed by
// close, and the pipe/unpipe events a destination receives with its source.
import { PassThrough, Readable, Writable } from "node:stream";

const record = (emitter, names) => {
  const seen = [];
  for (const name of names) {
    if (name === "data") emitter.on("data", (chunk) => seen.push("data:" + String(chunk)));
    else if (name === "error") emitter.on("error", (error) => seen.push("error:" + String(error && error.message)));
    else if (name === "pipe") emitter.on("pipe", (source) => seen.push("pipe:" + (source === undefined ? "?" : "stream")));
    else if (name === "unpipe") emitter.on("unpipe", () => seen.push("unpipe"));
    else if (name === "close") emitter.on("close", () => seen.push("close"));
    else if (name === "end") emitter.on("end", () => seen.push("end"));
    else if (name === "drain") emitter.on("drain", () => seen.push("drain"));
    else if (name === "finish") emitter.on("finish", () => seen.push("finish"));
    else if (name === "pause") emitter.on("pause", () => seen.push("pause"));
    else if (name === "readable") emitter.on("readable", () => seen.push("readable"));
    else if (name === "resume") emitter.on("resume", () => seen.push("resume"));
  }
  return () => console.log(names.join("+"), seen.join(","));
};
const ended = (stream) => new Promise((resolve) => stream.on("end", resolve));
const closed = (stream) => new Promise((resolve) => stream.on("close", resolve));

// A flowing readable.
const flowing = Readable.from(["a", "b"]);
const flowingDone = record(flowing, ["data", "end", "close"]);
const flowingEnd = ended(flowing);
flowing.resume();
await flowingEnd;
await new Promise((resolve) => setTimeout(resolve, 10));
flowingDone();

// Pulled through 'readable'.
const pulled = Readable.from(["c", "d"]);
const pulledDone = record(pulled, ["readable", "end", "close"]);
const pulledEnd = ended(pulled);
pulled.on("readable", () => {
  pulled.read();
});
await pulledEnd;
await new Promise((resolve) => setTimeout(resolve, 10));
pulledDone();

// pause and resume around data.
const pausing = Readable.from(["e", "f"]);
const pausingDone = record(pausing, ["data", "pause", "resume", "end"]);
const pausingEnd = ended(pausing);
pausing.on("data", () => {
  pausing.pause();
  setImmediate(() => {
    if (!pausing.readableEnded) pausing.resume();
  });
});
await pausingEnd;
await new Promise((resolve) => setTimeout(resolve, 10));
pausingDone();

// A writable with a one-byte high-water mark: both writes buffer, drain
// follows, then finish and close.
const writable = new Writable({
  highWaterMark: 1,
  write(chunk, encoding, callback) {
    setImmediate(callback);
  },
});
const writableDone = record(writable, ["drain", "finish", "close", "error"]);
const writableClosed = closed(writable);
console.log("write", writable.write("x"), writable.write("y"));
writable.end();
await writableClosed;
await new Promise((resolve) => setTimeout(resolve, 10));
writableDone();

// An error is followed by close.
const erroring = Readable.from(["g"]);
const erroringDone = record(erroring, ["data", "error", "close"]);
erroring.resume();
erroring.destroy(new Error("boom"));
await new Promise((resolve) => setTimeout(resolve, 20));
erroringDone();

// A pipe and an unpipe reach the destination with the source stream.
const source = new PassThrough();
const destination = new PassThrough();
const destinationDone = record(destination, ["pipe", "unpipe", "data"]);
source.pipe(destination);
source.write("h");
await new Promise((resolve) => setTimeout(resolve, 10));
source.unpipe(destination);
await new Promise((resolve) => setTimeout(resolve, 10));
destinationDone();

// A listener attached through an untyped value reads the source stream
// itself: the comparison against the program's source holds, and a reference
// kept past the event reads the source's current state rather than a
// snapshot of it.
const piped = Readable.from(["i", "j"]);
/** @type {any} */
const untypedDestination = new PassThrough();
const sourceView = [];
untypedDestination.on("pipe", (s) => {
  sourceView.push(`identity:${s === piped}`);
  setTimeout(() => sourceView.push(`destroyed:${s.destroyed}`), 20);
});
untypedDestination.on("unpipe", (s) => sourceView.push(`unpipe:${s === piped}`));
piped.pipe(untypedDestination);
setTimeout(() => piped.destroy(), 10);
await new Promise((resolve) => setTimeout(resolve, 60));
console.log("source-view", sourceView.join(" "));
untypedDestination.destroy();
