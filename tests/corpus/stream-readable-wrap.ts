// readable.wrap: the receiver answers for an old-style source. Each 'data'
// chunk becomes one of its chunks (a push past its high-water mark pauses the
// source, and its next read resumes it), the source's 'end' is EOF, its error
// destroys the receiver with the error, and the source closing or being
// destroyed destroys it too. wrap() answers the receiver itself.
import { PassThrough, Readable } from "node:stream";

// Flow: the source's chunks come out of the receiver.
const src = new PassThrough();
const receiver = new Readable({ read() {} });
const wrapped = receiver.wrap(src);
console.log("returns receiver", wrapped === receiver, receiver instanceof Readable);
const got: string[] = [];
wrapped.on("data", (c: Buffer) => got.push(c.toString()));
src.write("one");
src.write("two");
console.log("flow", got.join("|"), src.readableFlowing);
src.end("three");
wrapped.on("end", () => console.log("end", got.join("|"), wrapped.readableEnded));

// Paused: a push past the high-water mark pauses the source, and reading the
// receiver resumes it.
const slowSrc = new PassThrough();
const slow = new Readable({ highWaterMark: 4, read() {} }).wrap(slowSrc);
slowSrc.write("abcdef");
console.log("paused", slowSrc.isPaused(), slow.readableLength, slowSrc.readableLength);
console.log("read all", String(slow.read()), slow.readableLength);
console.log("resumed", slowSrc.isPaused());

// A string source: setEncoding on the source delivers strings.
const textSrc = new PassThrough();
textSrc.setEncoding("utf8");
const text = new Readable({ read() {} }).wrap(textSrc);
const parts: string[] = [];
text.on("data", (c) => parts.push(String(c)));
textSrc.write(Buffer.from("héllo"));
textSrc.end();
text.on("end", () => console.log("text", parts.join("|")));

// Object mode: the values come through as they are.
const objectSrc = new PassThrough({ objectMode: true });
const objects = new Readable({ objectMode: true, read() {} }).wrap(objectSrc);
const values: unknown[] = [];
objects.on("data", (v) => values.push(v));
objectSrc.write({ a: 1 });
objectSrc.write([2, 3]);
objectSrc.end();
objects.on("end", () => console.log("objects", JSON.stringify(values)));

// The source's error destroys the receiver with it.
const errSrc = new PassThrough();
const errWrapped = new Readable({ read() {} }).wrap(errSrc);
errWrapped.on("error", (e: Error) => console.log("error", e.message, errWrapped.destroyed));
errSrc.destroy(new Error("source failed"));

// The source closing destroys the receiver without an error.
const closeSrc = new PassThrough();
const closeWrapped = new Readable({ read() {} }).wrap(closeSrc);
closeWrapped.on("close", () => console.log("closed", closeWrapped.destroyed, closeWrapped.errored));
closeSrc.destroy();

// The source's 'destroy' event destroys the receiver too.
const destroySrc = new PassThrough();
const destroyWrapped = new Readable({ read() {} }).wrap(destroySrc);
destroyWrapped.on("close", () => console.log("destroyed with source"));
destroySrc.emit("destroy");

// Destroying the receiver leaves the source alone (wrap only listens).
const indepSrc = new PassThrough();
const indep = new Readable({ read() {} }).wrap(indepSrc);
indep.destroy();
console.log("independent", indep.destroyed, indepSrc.destroyed);
