// The stream error codes of Node's errors chapter: what a Readable, a
// Writable, a Transform and pipeline() report when they are used out of
// order. Each case prints the class, name, code and message of the
// error, where it arrives (an 'error' event, a callback, a throw), and
// the stream's state after it.
import { PassThrough, Readable, Transform, Writable, pipeline } from "node:stream";
import { pipeline as pipelinePromise } from "node:stream/promises";

const kind = (e) => (e instanceof TypeError ? "TypeError" : e instanceof RangeError ? "RangeError" : e instanceof Error ? "Error" : typeof e);
const show = (label, e) => console.log(label, [kind(e), e.name, e.code, e.message].join(" | "));

// push() after the end of the data.
await new Promise((resolve) => {
  const readable = new Readable({ read() {} });
  readable.on("error", (e) => show("push after EOF", e));
  readable.on("close", () => {
    console.log("closed", readable.destroyed, readable.errored !== null);
    resolve(undefined);
  });
  readable.push(null);
  console.log("push", readable.push("late"));
  readable.resume();
});

// unshift() after 'end': the chunk is not delivered.
await new Promise((resolve) => {
  const readable = new Readable({ read() {} });
  readable.on("error", (e) => show("unshift after end", e));
  readable.on("data", (chunk) => console.log("data", String(chunk)));
  readable.on("end", () => {
    console.log("end");
    readable.unshift("again");
  });
  readable.on("close", () => {
    console.log("closed", readable.destroyed, readable.errored !== null);
    resolve(undefined);
  });
  readable.push("one");
  readable.push(null);
});

// unshift() of a chunk that adds nothing — an empty string, an empty view,
// undefined — in a byte-mode stream's 'end' listener reports nothing.
await new Promise((resolve) => {
  const readable = new Readable({ read() {} });
  readable.on("error", (e) => show("unshift nothing after end", e));
  readable.on("data", (chunk) => console.log("data", String(chunk)));
  readable.on("end", () => {
    console.log("end");
    readable.unshift("");
    readable.unshift(Buffer.alloc(0));
    readable.unshift(undefined);
    console.log("unshift nothing", readable.errored === null, readable.destroyed);
  });
  readable.on("close", () => {
    console.log("closed", readable.destroyed, readable.errored !== null);
    resolve(undefined);
  });
  readable.push("one");
  readable.push(null);
});

// unshift() in an 'end' listener, chunk by chunk: the three that add
// nothing to a byte stream (empty string, empty Buffer, undefined) are
// no-ops there and errors in object mode, where every value is a chunk;
// a chunk with bytes is an error in both. Each stream stays in the scope
// that creates it.
const chunks = ["empty string", "empty buffer", "undefined", "string", "buffer"];
for (let pick = 0; pick < chunks.length; pick++) {
  await new Promise((resolve) => {
    const readable = new Readable({ read() {} });
    let error = "none";
    readable.on("error", (e) => {
      error = e.code;
    });
    readable.on("data", () => {});
    readable.on("end", () => {
      if (pick === 0) readable.unshift("");
      else if (pick === 1) readable.unshift(Buffer.alloc(0));
      else if (pick === 2) readable.unshift(undefined);
      else if (pick === 3) readable.unshift("x");
      else readable.unshift(Buffer.from("x"));
    });
    readable.on("close", () => {
      console.log("bytes", chunks[pick], error, readable.destroyed);
      resolve(undefined);
    });
    readable.push("a");
    readable.push(null);
  });
  await new Promise((resolve) => {
    const readable = new Readable({ objectMode: true, read() {} });
    let error = "none";
    readable.on("error", (e) => {
      error = e.code;
    });
    readable.on("data", () => {});
    readable.on("end", () => {
      if (pick === 0) readable.unshift("");
      else if (pick === 1) readable.unshift(Buffer.alloc(0));
      else if (pick === 2) readable.unshift(undefined);
      else if (pick === 3) readable.unshift("x");
      else readable.unshift(Buffer.from("x"));
    });
    readable.on("close", () => {
      console.log("objects", chunks[pick], error, readable.destroyed);
      resolve(undefined);
    });
    readable.push("a");
    readable.push(null);
  });
}

// write() after end(), and after destroy().
await new Promise((resolve) => {
  const writable = new Writable({ write(chunk, encoding, callback) { callback(); } });
  writable.on("error", (e) => show("write after end", e));
  writable.on("close", () => resolve(undefined));
  writable.end();
  console.log("write", writable.write("late"));
});
await new Promise((resolve) => {
  const writable = new Writable({ write(chunk, encoding, callback) { callback(); } });
  writable.on("error", (e) => show("unexpected", e));
  writable.destroy();
  writable.write("late", (e) => {
    show("write after destroy", e);
    resolve(undefined);
  });
});

// A Transform that calls back twice.
await new Promise((resolve) => {
  const transform = new Transform({
    transform(chunk, encoding, callback) {
      callback();
      callback();
    },
  });
  transform.on("error", (e) => show("callback twice", e));
  transform.on("close", () => resolve(undefined));
  transform.write("a");
});

// A Readable without the method it needs.
await new Promise((resolve) => {
  const readable = new Readable();
  readable.on("error", (e) => {
    show("no _read", e);
    resolve(undefined);
  });
  readable.read();
});
// A chunk of the wrong type.
{
  const writable = new Writable({ write(chunk, encoding, callback) { callback(); } });
  try {
    writable.write(5);
  } catch (e) {
    show("number chunk", e);
  }
  writable.destroy();
}

// pipeline() into a stream that is already closed, and a source that
// ends early.
await new Promise((resolve) => {
  const writable = new Writable({ write(chunk, encoding, callback) { callback(); } });
  writable.destroy();
  writable.on("close", async () => {
    try {
      pipeline(Readable.from(["a"]), writable, (e) => show("unexpected callback", e));
      console.log("no throw");
    } catch (e) {
      show("pipeline to closed", e);
    }
    try {
      await pipelinePromise(Readable.from(["a"]), writable);
      console.log("no throw");
    } catch (e) {
      show("pipeline promise to closed", e);
    }
    resolve(undefined);
  });
});
await new Promise((resolve) => {
  const source = new PassThrough();
  const target = new Writable({ write(chunk, encoding, callback) { callback(); } });
  pipeline(source, target, (e) => {
    show("premature close", e);
    resolve(undefined);
  });
  source.destroy();
});
