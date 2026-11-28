// Readable.from over a stream subclass uses the built-in fast path only when
// the effective Symbol.asyncIterator is the built-in one: a subclass that
// overrides it answers through that method, as from.js calls it. Option
// initializers evaluate as the call's arguments run — a throwing
// highWaterMark throws before the source's iterator opens — and a computed
// one is forwarded to both plain and stream sources.
import { PassThrough, Readable } from "node:stream";

const drain = (stream) =>
  new Promise((resolve) => {
    const out = [];
    stream.on("data", (chunk) => out.push(String(chunk)));
    stream.on("end", () => resolve(out.join(",")));
    stream.on("error", (error) => resolve(`error ${error.message}`));
  });

class Always extends PassThrough {
  async *[Symbol.asyncIterator]() {
    yield "from-override";
  }
}
class Denying extends PassThrough {
  async *[Symbol.asyncIterator]() {
    yield "start";
    throw new Error("denied");
  }
}
class Plain extends PassThrough {}

{
  const source = new Always();
  source.write("buffered");
  source.end();
  console.log("override", await drain(Readable.from(source)));
}

{
  console.log("rejecting override", await drain(Readable.from(new Denying())));
}

{
  const source = new Plain();
  source.write("buffered");
  source.end();
  const wrapped = Readable.from(source);
  console.log("plain subclass", wrapped.readableObjectMode, wrapped.readableHighWaterMark, await drain(wrapped));
}

// A throwing highWaterMark initializer runs, for a plain and a stream source.
const log = [];
const quota = () => {
  log.push("quota");
  throw new Error("quota exceeded");
};
const five = () => {
  log.push("five");
  return 5;
};

try {
  Readable.from(["a"], { highWaterMark: quota() });
  console.log("array quota missed", log.join(","));
} catch (error) {
  console.log("array quota", error.message, log.join(","));
}
log.length = 0;
try {
  Readable.from(new PassThrough(), { highWaterMark: quota() });
  console.log("stream quota missed", log.join(","));
} catch (error) {
  console.log("stream quota", error.message, log.join(","));
}

// A computed highWaterMark is forwarded to both sources.
const array = Readable.from(["a"], { highWaterMark: five() });
console.log("array hwm", array.readableHighWaterMark, log.join(","));
await drain(array);
const inner = new PassThrough();
const wrapped = Readable.from(inner, { highWaterMark: five() });
console.log("stream hwm", wrapped.readableHighWaterMark, log.join(","));
inner.end();
await drain(wrapped);
