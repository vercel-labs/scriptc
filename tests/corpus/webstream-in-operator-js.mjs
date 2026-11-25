function probe(label, target, keys) {
  const out = [];
  for (const key of keys) out.push(`${key}:${key in target}`);
  console.log(label, out.join(" "));
}

async function main() {
  // A stream answers every member it has, inherited or not, and nothing else.
  {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(1);
      },
    });
    probe("readable", stream, ["locked", "getReader", "tee", "pipeTo", "pipeThrough", "values", "constructor", "toString", "nope"]);
    const reader = stream.getReader();
    probe("reader", reader, ["closed", "desiredSize", "read", "cancel", "releaseLock", "constructor", "nope"]);
    const first = await reader.read();
    console.log("reader-read", first.value, "read" in reader);
  }

  // A writable stream and its writer do the same.
  {
    const stream = new WritableStream({ write() {} });
    probe("writable", stream, ["locked", "getWriter", "abort", "close", "nope"]);
    const writer = stream.getWriter();
    probe("writer", writer, [
      "closed",
      "ready",
      "desiredSize",
      "write",
      "close",
      "abort",
      "releaseLock",
      "nope",
    ]);
  }

  // A transform stream's two sides are getters on its class, and each side is
  // a stream in its own right.
  {
    const transform = new TransformStream();
    probe("transform", transform, ["readable", "writable", "constructor", "toString", "nope"]);
    probe("transform-readable", transform.readable, ["locked", "getReader", "pipeTo", "nope"]);
    probe("transform-writable", transform.writable, ["locked", "getWriter", "close", "nope"]);
  }

  // The queuing strategies answer their high-water mark getter and their size
  // method, and the stream classes' other keys stay absent.
  {
    const count = new CountQueuingStrategy({ highWaterMark: 3 });
    probe("count", count, ["highWaterMark", "size", "constructor", "toString", "nope"]);
    console.log("count-values", count.highWaterMark, count.size("chunk"));
    const bytes = new ByteLengthQueuingStrategy({ highWaterMark: 4 });
    probe("byteLength", bytes, ["highWaterMark", "size", "constructor", "nope"]);
    console.log("byteLength-values", bytes.highWaterMark, bytes.size(new Uint8Array(6)));
  }

  // The text codec streams answer their getters too.
  {
    const encoder = new TextEncoderStream();
    probe("encoder", encoder, ["encoding", "readable", "writable", "nope"]);
    const decoder = new TextDecoderStream();
    probe("decoder", decoder, ["encoding", "fatal", "ignoreBOM", "readable", "writable", "nope"]);
  }

  // A key from an expression reads the same way as a literal one.
  {
    const strategy = new CountQueuingStrategy({ highWaterMark: 1 });
    const key = process.argv.length > 99 ? "nope" : "highWaterMark";
    console.log("computed", key in strategy, ["size"][0] in strategy, `${"nope"}` in strategy);
  }

  // The answer does not depend on the stream's state.
  {
    const stream = new ReadableStream({
      start(c) {
        c.close();
      },
    });
    const reader = stream.getReader();
    probe("closing-reader", reader, ["closed", "read", "nope"]);
    console.log("closing-read", (await reader.read()).done, "read" in reader);
  }

  // A handle that is not a stream keeps its own answers.
  {
    const signal = new AbortController().signal;
    probe("signal", signal, ["aborted", "reason", "throwIfAborted", "addEventListener", "nope"]);
    const headers = new Headers({ a: "b" });
    probe("headers", headers, ["get", "append", "size", "nope"]);
  }
}

void main();
