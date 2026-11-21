// Readable.toWeb({ type: 'bytes' }): the web readable is a byte stream, so a
// BYOB reader reads through its own view; a chunk larger than the view keeps
// its tail for the next read. Another type value is Node's
// ERR_INVALID_ARG_VALUE, and the default stream refuses a BYOB reader.
import { PassThrough, Readable } from "node:stream";

const log: string[] = [];

function byteReadable(): PassThrough {
  const readable = new PassThrough();
  readable.end(Buffer.from("abcdef"));
  return readable;
}

function traced(tag: string): PassThrough {
  log.push(`source ${tag}`);
  return byteReadable();
}

async function main(): Promise<void> {
  const web = Readable.toWeb(byteReadable(), { type: "bytes" });
  const reader = web.getReader({ mode: "byob" });
  const first = await reader.read(new Uint8Array(4));
  log.push(
    `first ${first.done} ${first.value?.byteLength} ${Buffer.from(first.value ?? new Uint8Array()).toString()}`,
  );
  const second = await reader.read(new Uint8Array(4));
  log.push(
    `second ${second.done} ${second.value?.byteLength} ${Buffer.from(second.value ?? new Uint8Array()).toString()}`,
  );
  await reader.cancel();

  const plain = Readable.toWeb(byteReadable());
  try {
    plain.getReader({ mode: "byob" });
    log.push("plain byob accepted");
  } catch (error) {
    log.push(`plain byob ${(error as Error).name}`);
  }

  // A typed array that is not a Uint8Array reaches the byte stream as its
  // raw bytes (Node's enqueue conversion), and the view still bounds it.
  const typed = Readable.toWeb(
    Readable.from([new Uint16Array([0x0102, 0x0304, 0x0506])], { objectMode: true }),
    { type: "bytes" },
  );
  const typedReader = typed.getReader({ mode: "byob" });
  for (const size of [4, 4]) {
    const chunk = await typedReader.read(new Uint8Array(size));
    log.push(
      `typed ${chunk.done} ${chunk.value?.byteLength} ${Buffer.from(chunk.value ?? new Uint8Array()).toString("hex")}`,
    );
  }
  await typedReader.cancel();

  // Many small views over one chunk: every read takes its own bytes.
  const small = Readable.toWeb(byteReadable(), { type: "bytes" });
  const smallReader = small.getReader({ mode: "byob" });
  const bytes: string[] = [];
  for (let i = 0; i < 7; i++) {
    const chunk = await smallReader.read(new Uint8Array(1));
    if (chunk.done) {
      bytes.push("done");
      break;
    }
    bytes.push(Buffer.from(chunk.value ?? new Uint8Array()).toString());
  }
  log.push(`small ${bytes.join("")}`);
  await smallReader.cancel();
}

async function refusals(): Promise<void> {
  for (const [label, attempt] of [
    ["empty", () => Readable.toWeb(traced("empty"), { type: "" })],
    ["text", () => Readable.toWeb(traced("text"), { type: "text" })],
    ["number", () => Readable.toWeb(traced("number"), { type: 5 })],
    ["null", () => Readable.toWeb(traced("null"), { type: null })],
    // The refusal comes after everything the call evaluates: the stream
    // argument, then each option initializer in order.
    [
      "strategy",
      () =>
        Readable.toWeb(traced("strategy"), {
          type: "text",
          strategy: (log.push("strategy evaluated"), undefined),
        }),
    ],
  ] as const) {
    try {
      attempt();
      log.push(`type ${label} accepted`);
    } catch (error) {
      const typed = error as Error & { code?: string };
      log.push(`type ${label} ${typed.name} ${typed.code}`);
    }
  }
}

main()
  .then(refusals)
  .then(() => {
    for (const line of log) console.log(line);
  });
