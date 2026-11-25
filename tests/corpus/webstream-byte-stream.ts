// A ReadableStream constructed with a byte source (type: "bytes"): enqueue
// and close, the default reader over it, autoAllocateChunkSize, error, and
// the constructor's own refusals.
import type { ReadableByteStreamController } from "node:stream/web";

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

function refuse(label: string, fn: () => unknown): void {
  try {
    fn();
    console.log(label, "no-throw");
  } catch (e) {
    console.log(label, describe(e));
  }
}

async function main(): Promise<void> {
  // enqueue copies the chunk: mutating the source afterwards does not
  // change the queued value, and the default reader gets the copy.
  {
    const chunk = new Uint8Array([1, 2, 3]);
    const stream = new ReadableStream({
      type: "bytes",
      start(c: ReadableByteStreamController) {
        c.enqueue(chunk);
        chunk[0] = 9;
        chunk[1] = 9;
        c.close();
      },
    });
    const reader = stream.getReader();
    const first = await reader.read();
    const value = first.value;
    // Node detaches the caller's buffer at enqueue; the queued value is
    // the copy either way.
    console.log(
      "copy",
      value,
      value === undefined || value === null ? "none" : value.constructor.name,
    );
    const end = await reader.read();
    console.log("end", end.done, end.value);
  }

  // A byte stream's queue is measured in bytes; its default high water
  // mark is zero.
  {
    const sizes: (number | null)[] = [];
    const stream = new ReadableStream({
      type: "bytes",
      start(c: ReadableByteStreamController) {
        sizes.push(c.desiredSize);
        c.enqueue(new Uint8Array(5));
        sizes.push(c.desiredSize);
        c.close();
        sizes.push(c.desiredSize);
      },
    });
    console.log("desired", sizes.join(","));
    await stream.cancel();
  }

  // autoAllocateChunkSize: a default read supplies the pull with a BYOB hay.
  {
    let step = 0;
    const stream = new ReadableStream({
      type: "bytes",
      autoAllocateChunkSize: 4,
      pull(c: ReadableByteStreamController) {
        const request = c.byobRequest;
        if (request === null) return;
        const view = request.view;
        if (view === null) return;
        step++;
        (view as Uint8Array).set([step, step + 10]);
        request.respond(2);
        if (step === 2) c.close();
      },
    });
    const reader = stream.getReader();
    const first = await reader.read();
    const second = await reader.read();
    const end = await reader.read();
    console.log("auto", first.value, first.done, second.value, second.done, end.done);
  }

  // enqueue in a pull-only source, driven by the default reader.
  {
    let pulls = 0;
    const stream = new ReadableStream({
      type: "bytes",
      pull(c: ReadableByteStreamController) {
        pulls++;
        c.enqueue(new Uint8Array([pulls]));
        if (pulls === 2) c.close();
      },
    });
    const reader = stream.getReader();
    const a = await reader.read();
    const b = await reader.read();
    const end = await reader.read();
    console.log("pull", a.value, b.value, end.done, pulls);
  }

  // An error reaches a waiting default read as the same value.
  {
    const stream = new ReadableStream({
      type: "bytes",
      start(c: ReadableByteStreamController) {
        c.enqueue(new Uint8Array([1]));
        c.error(new Error("boom"));
      },
    });
    const reader = stream.getReader();
    console.log("error queued", await settle(reader.read()));
    console.log("error next", await settle(reader.read()));
  }

  // Constructor refusals.
  refuse("auto-zero", () => new ReadableStream({ type: "bytes", autoAllocateChunkSize: 0 }));
  refuse(
    "byob-reader-default",
    () => new ReadableStream({ start() {} }).getReader({ mode: "byob" }),
  );

  // enqueue refuses a zero-length chunk; the source stays usable.
  {
    const log: string[] = [];
    const stream = new ReadableStream({
      type: "bytes",
      pull(c: ReadableByteStreamController) {
        try {
          c.enqueue(new Uint8Array(0));
          log.push("no-throw");
        } catch (e) {
          log.push(describe(e));
        }
        c.enqueue(new Uint8Array([1]));
        c.close();
      },
    });
    const reader = stream.getReader();
    const first = await reader.read();
    console.log("enqueue-zero", log[0], first.value);
  }
}

main();
