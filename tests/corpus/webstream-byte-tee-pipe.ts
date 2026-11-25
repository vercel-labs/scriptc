// tee() and pipeTo() on a byte stream: both branches stay byte streams
// with their own buffers, source errors reach both, and a pipe passes the
// same bytes on.
function describe(e: unknown): string {
  if (typeof e === "string") return `string:${e}`;
  const err = e as { code?: string; message?: string };
  return `${err.code}:${err.message}`;
}

function settle(p: Promise<unknown>): Promise<string> {
  return p.then(
    () => "resolved",
    (e) => `rejected:${describe(e)}`,
  );
}

async function main(): Promise<void> {
  // Both branches are byte streams and each answers the source's chunks.
  {
    const stream = new ReadableStream({
      type: "bytes",
      pull(c: ReadableByteStreamController) {
        c.enqueue(new Uint8Array([1, 2]));
        c.enqueue(new Uint8Array([3]));
        c.close();
      },
    });
    const branches = stream.tee();
    const a = branches[0];
    const b = branches[1];
    const ra = a.getReader({ mode: "byob" });
    const rb = b.getReader({ mode: "byob" });
    const a1 = await ra.read(new Uint8Array(4));
    const b1 = await rb.read(new Uint8Array(4));
    const a2 = await ra.read(new Uint8Array(4));
    const b2 = await rb.read(new Uint8Array(4));
    const a3 = await ra.read(new Uint8Array(4));
    console.log("tee", a1.value, b1.value, a2.value, b2.value, a3.done, a3.value);
  }

  // An error on the source reaches both branches.
  {
    const stream = new ReadableStream({
      type: "bytes",
      start(c: ReadableByteStreamController) {
        c.enqueue(new Uint8Array([7]));
        c.error(new Error("tee-boom"));
      },
    });
    const branches = stream.tee();
    const ra = branches[0].getReader();
    const rb = branches[1].getReader();
    console.log("tee error", await settle(ra.read()), await settle(rb.read()));
  }

  // A pipe hands each chunk to the sink unchanged.
  {
    const stream = new ReadableStream({
      type: "bytes",
      pull(c: ReadableByteStreamController) {
        c.enqueue(new Uint8Array([5, 6]));
        c.enqueue(new Uint8Array([7]));
        c.close();
      },
    });
    const seen: string[] = [];
    const sink = new WritableStream<Uint8Array>({
      write(chunk: Uint8Array) {
        seen.push(`${chunk.constructor.name}:${chunk.byteLength}`);
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
    const stream = new ReadableStream({
      type: "bytes",
      pull(c: ReadableByteStreamController) {
        c.enqueue(new Uint8Array([1]));
        c.error(new Error("boom"));
      },
    });
    const reason = { why: "stop" };
    const sink = new WritableStream<Uint8Array>({
      write() {},
      abort(r: unknown) {
        console.log("aborted", r === reason);
      },
    });
    console.log("pipe error", await settle(stream.pipeTo(sink)));
  }
}

main();
