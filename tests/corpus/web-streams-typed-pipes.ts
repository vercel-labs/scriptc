// ReadableStream tee(), pipeTo() and pipeThrough() in TypeScript, with
// WritableStream sinks and TransformStream transformers: chunk order, close
// and flush, cancel through a tee branch, the pipe options, Node's
// TypeErrors for locked streams, error propagation through a pipe, and a
// Response body piped through a transform.

const describe = (e: unknown): string => `${(e as Error).name}: ${(e as Error).message}`;

function source(chunks: string[]): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function drain<T>(stream: ReadableStream<T>): Promise<T[]> {
  const out: T[] = [];
  const reader = stream.getReader();
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    out.push(result.value);
  }
  return out;
}

async function tees(): Promise<void> {
  const [left, right] = source(["a", "b", "c"]).tee();
  console.log("tee", (await drain(left)).join(""), (await drain(right)).join(""));

  const log: string[] = [];
  const watched = new ReadableStream<number>({
    start(controller) {
      controller.enqueue(1);
      controller.enqueue(2);
    },
    cancel(reason) {
      log.push(`source cancel ${String(reason)}`);
    },
  });
  const [a, b] = watched.tee();
  // The source is cancelled once both branches are, with both reasons.
  const leftDone = a.cancel("left done").then(() => log.push("left cancelled"));
  log.push("left requested");
  await Promise.all([leftDone, b.cancel("right done").then(() => log.push("right cancelled"))]);
  console.log("tee cancel", log.join(" | "), watched.locked);

  const locked = source(["x"]);
  locked.getReader();
  try {
    locked.tee();
  } catch (e) {
    console.log("tee locked", describe(e));
  }
}

async function pipes(): Promise<void> {
  const written: string[] = [];
  const sink = new WritableStream<string>({
    write(chunk) {
      written.push(chunk);
    },
    close() {
      written.push("<close>");
    },
  });
  await source(["one", "two"]).pipeTo(sink);
  console.log("pipeTo", written.join(","), sink.locked);

  const kept: string[] = [];
  const open = new WritableStream<string>({
    write(chunk) {
      kept.push(chunk);
    },
    close() {
      kept.push("<close>");
    },
  });
  await source(["p"]).pipeTo(open, { preventClose: true });
  const writer = open.getWriter();
  await writer.write("after");
  await writer.close();
  console.log("preventClose", kept.join(","));

  const failing = new ReadableStream<string>({
    start(controller) {
      controller.enqueue("ok");
      controller.error(new RangeError("source failed"));
    },
  });
  const aborted: string[] = [];
  try {
    await failing.pipeTo(
      new WritableStream<string>({
        write(chunk) {
          aborted.push(chunk);
        },
        abort(reason) {
          aborted.push(`abort ${describe(reason)}`);
        },
      }),
    );
  } catch (e) {
    console.log("pipeTo error", describe(e), aborted.join(" | "));
  }

  const busy = source(["q"]);
  busy.getReader();
  try {
    await busy.pipeTo(new WritableStream<string>());
  } catch (e) {
    console.log("pipeTo locked", describe(e));
  }
}

async function transforms(): Promise<void> {
  const upper = new TransformStream<string, string>({
    transform(chunk, controller) {
      controller.enqueue(chunk.toUpperCase());
    },
    flush(controller) {
      controller.enqueue("!");
    },
  });
  console.log("pipeThrough", (await drain(source(["ab", "cd"]).pipeThrough(upper))).join(""));

  const lengths = new TransformStream<string, number>({
    transform(chunk, controller) {
      controller.enqueue(chunk.length);
    },
  });
  console.log("lengths", (await drain(source(["a", "bbb", "cc"]).pipeThrough(lengths))).join(" "));

  const identity = new TransformStream<string, string>();
  console.log("identity", (await drain(source(["i", "j"]).pipeThrough(identity))).join(""));

  const body = new Response("fetch body").body!;
  const decoded = body.pipeThrough(
    new TransformStream<Uint8Array, string>({
      transform(chunk, controller) {
        controller.enqueue(new TextDecoder().decode(chunk));
      },
    }),
  );
  console.log("response body", (await drain(decoded)).join(""));

  const [first, second] = new Response("split").body!.tee();
  const decoder = new TextDecoder();
  const text = async (s: ReadableStream<Uint8Array>): Promise<string> =>
    (await drain(s)).map((chunk) => decoder.decode(chunk)).join("");
  console.log("response tee", await text(first), await text(second));
}

await tees();
await pipes();
await transforms();
