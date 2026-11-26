// Readable state across a stream's life: destroyed, readableEnded,
// readableLength and errored before, during and after a read end, a destroy
// and a destroy with an error.
import { Readable } from "node:stream";

const fresh = Readable.from(["a", "b"]);
console.log("fresh", fresh.destroyed, fresh.readableEnded, fresh.readableLength, fresh.errored);

// readableLength counts the buffered bytes until read() takes them.
const buffered = new Readable({ read() {} });
buffered.push("xx");
console.log("buffered", buffered.readableLength, buffered.readableEnded, buffered.destroyed);
const chunk = buffered.read();
console.log("read", String(chunk), buffered.readableLength);
buffered.push("yy");
console.log("regrown", buffered.readableLength);

// A destroy with an error reports destroyed and that same error.
const failing = Readable.from(["c"]);
const boom = new Error("boom");
failing.on("error", () => {});
failing.destroy(boom);
console.log("errored", failing.destroyed, failing.errored === boom, String(failing.errored && failing.errored.message));

// A stream read to its end ends readable and is auto-destroyed.
const ended = Readable.from(["d"]);
const end = new Promise((resolve) => ended.on("end", resolve));
ended.resume();
await end;
console.log("ended", ended.readableEnded, ended.destroyed, ended.readableLength, ended.errored);

// A plain destroy before any read ends nothing.
const cancelled = Readable.from(["e"]);
cancelled.destroy();
console.log("cancelled", cancelled.destroyed, cancelled.readableEnded, cancelled.errored);
