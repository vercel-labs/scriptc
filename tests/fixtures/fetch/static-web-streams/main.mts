// ReadableStream tee(), pipeTo() and pipeThrough() in a static build: a
// fetched body (whole and chunked) tee'd, piped into a WritableStream and
// through a TransformStream, constructed streams through a transformer,
// and Node's TypeErrors for locked streams and errors through a pipe.
const base = process.argv[2]!;
const describe = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));
const decoder = new TextDecoder();

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let text = "";
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    text += decoder.decode(result.value, { stream: true });
  }
  return text + decoder.decode();
}

const fetched = await fetch(`${base}/text`);
const [left, right] = fetched.body!.tee();
console.log("tee", await collect(left), await collect(right), fetched.bodyUsed);

const chunked = await fetch(`${base}/chunked`);
const parts: string[] = [];
await chunked.body!.pipeTo(
  new WritableStream<Uint8Array>({
    write(chunk) {
      parts.push(decoder.decode(chunk, { stream: true }));
    },
    close() {
      parts.push("<close>");
    },
  }),
);
console.log("pipeTo", parts.join("").length > 0, parts[parts.length - 1], chunked.bodyUsed);

const upper = await fetch(`${base}/text`);
const shouted = upper.body!.pipeThrough(
  new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(new TextEncoder().encode(decoder.decode(chunk).toUpperCase()));
    },
  }),
);
console.log("pipeThrough", await collect(shouted));

const words = new ReadableStream<string>({
  start(controller) {
    controller.enqueue("alpha");
    controller.enqueue("beta");
    controller.close();
  },
});
const counted = words.pipeThrough(
  new TransformStream<string, number>({
    transform(chunk, controller) {
      controller.enqueue(chunk.length);
    },
    flush(controller) {
      controller.enqueue(-1);
    },
  }),
);
const counts: number[] = [];
const reader = counted.getReader();
for (;;) {
  const result = await reader.read();
  if (result.done) break;
  counts.push(result.value);
}
console.log("constructed", counts.join(" "));

const locked = await fetch(`${base}/text`);
locked.body!.getReader();
try {
  locked.body!.tee();
} catch (e) {
  console.log("tee locked", describe(e));
}
try {
  await locked.body!.pipeTo(new WritableStream<Uint8Array>());
} catch (e) {
  console.log("pipeTo locked", describe(e));
}

const failing = new ReadableStream<string>({
  start(controller) {
    controller.error(new TypeError("source failed"));
  },
});
try {
  await failing.pipeTo(new WritableStream<string>());
} catch (e) {
  console.log("pipeTo error", describe(e));
}
