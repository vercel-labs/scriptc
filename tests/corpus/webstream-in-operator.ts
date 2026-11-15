function probe(label: string, target: object, keys: string[]): void {
  const out: string[] = [];
  for (const key of keys) out.push(`${key}:${key in target}`);
  console.log(label, out.join(" "));
}

async function main(): Promise<void> {
  // The queuing strategies answer their high-water mark getter and their size
  // method, and the members they do not have stay absent.
  {
    const count = new CountQueuingStrategy({ highWaterMark: 3 });
    probe("count", count, ["highWaterMark", "size", "constructor", "toString", "nope"]);
    console.log("count-values", count.highWaterMark, count.size("chunk"));
    const bytes = new ByteLengthQueuingStrategy({ highWaterMark: 4 });
    probe("byteLength", bytes, ["highWaterMark", "size", "constructor", "nope"]);
    console.log("byteLength-values", bytes.highWaterMark, bytes.size(new Uint8Array(6)));
  }

  // A transform stream's two sides are getters on its class, and each side is
  // a stream in its own right.
  {
    const transform = new TransformStream<number, number>();
    probe("transform", transform, ["readable", "writable", "constructor", "nope"]);
    probe("transform-readable", transform.readable, ["locked", "getReader", "pipeTo", "nope"]);
    probe("transform-writable", transform.writable, ["locked", "getWriter", "close", "nope"]);
  }

  // A stream, its reader and its writer answer the members they have.
  {
    const stream = new ReadableStream<number>({
      start(c) {
        c.enqueue(1);
      },
    });
    probe("readable", stream, [
      "locked",
      "getReader",
      "tee",
      "pipeTo",
      "values",
      "constructor",
      "nope",
    ]);
    const reader = stream.getReader();
    probe("reader", reader, ["closed", "desiredSize", "read", "cancel", "releaseLock", "nope"]);
    console.log("read", (await reader.read()).value, "read" in reader);
    const writable = new WritableStream<number>({ write() {} });
    probe("writable", writable, ["locked", "getWriter", "abort", "close", "nope"]);
    const writer = writable.getWriter();
    probe("writer", writer, ["closed", "ready", "desiredSize", "write", "close", "nope"]);
  }

  // A key held in a variable reads the same way as a literal one.
  {
    const strategy = new CountQueuingStrategy({ highWaterMark: 1 });
    const key: string = "highWaterMark";
    console.log("computed", key in strategy, `${"nope"}` in strategy);
  }
}

void main();
