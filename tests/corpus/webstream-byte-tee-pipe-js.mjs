// tee() and pipeTo() on a byte stream from a JavaScript source.
function describe(e) {
  if (typeof e === "string") return `string:${e}`;
  return `${e && e.code}:${e && e.message}`;
}

function settle(p) {
  return p.then(
    () => "resolved",
    (e) => `rejected:${describe(e)}`,
  );
}

async function main() {
  // Both branches are byte streams and each answers the source's chunks.
  {
    const stream = new ReadableStream({
      type: "bytes",
      pull(c) {
        c.enqueue(new Uint8Array([1, 2]));
        c.enqueue(new Uint8Array([3]));
        c.close();
      },
    });
    const [a, b] = stream.tee();
    const ra = a.getReader({ mode: "byob" });
    const rb = b.getReader({ mode: "byob" });
    const a1 = await ra.read(new Uint8Array(4));
    const b1 = await rb.read(new Uint8Array(4));
    const a2 = await ra.read(new Uint8Array(4));
    const b2 = await rb.read(new Uint8Array(4));
    const a3 = await ra.read(new Uint8Array(4));
    console.log("tee", a1.value, b1.value, a2.value, b2.value, a3.done, a3.value);
    console.log("branch readers", ra.constructor.name, rb.constructor.name);
  }

  // The branches are independent: mutating one read's bytes does not
  // change the other branch's chunk.
  {
    const stream = new ReadableStream({
      type: "bytes",
      pull(c) {
        c.enqueue(new Uint8Array([4, 5]));
        c.close();
      },
    });
    const [a, b] = stream.tee();
    const ra = a.getReader({ mode: "byob" });
    const rb = b.getReader({ mode: "byob" });
    const a1 = await ra.read(new Uint8Array(4));
    a1.value[0] = 99;
    const b1 = await rb.read(new Uint8Array(4));
    console.log("tee copy", a1.value, b1.value);
  }

  // An error on the source reaches both branches.
  {
    const stream = new ReadableStream({
      type: "bytes",
      start(c) {
        c.enqueue(new Uint8Array([7]));
        c.error(new Error("tee-boom"));
      },
    });
    const [a, b] = stream.tee();
    const ra = a.getReader();
    const rb = b.getReader();
    console.log("tee error", await settle(ra.read()), await settle(rb.read()));
  }

  // A pipe hands each chunk to the sink unchanged.
  {
    const stream = new ReadableStream({
      type: "bytes",
      pull(c) {
        c.enqueue(new Uint8Array([5, 6]));
        c.enqueue(new Uint8Array([7]));
        c.close();
      },
    });
    const seen = [];
    const sink = new WritableStream({
      write(chunk) {
        seen.push(`${chunk.constructor.name}:${chunk.byteLength}:${chunk[0]}`);
      },
      close() {
        seen.push("close");
      },
    });
    const result = await settle(stream.pipeTo(sink));
    console.log("pipeTo", result, seen.join(","), stream.locked, sink.locked);
  }

  // A source error aborts the sink with the same value.
  {
    const boom = new Error("boom");
    const stream = new ReadableStream({
      type: "bytes",
      pull(c) {
        c.enqueue(new Uint8Array([1]));
        c.error(boom);
      },
    });
    let seen;
    const sink = new WritableStream({
      write() {},
      abort(r) {
        seen = r;
      },
    });
    console.log("pipe error", await settle(stream.pipeTo(sink)), seen === boom);
  }

  // pipeThrough with the identity transform keeps the bytes.
  {
    const stream = new ReadableStream({
      type: "bytes",
      pull(c) {
        c.enqueue(new Uint8Array([8, 9]));
        c.close();
      },
    });
    const through = stream.pipeThrough(new TransformStream());
    const reader = through.getReader();
    const first = await reader.read();
    const end = await reader.read();
    console.log("pipeThrough", first.value, first.done, end.done);
  }
}

main();
