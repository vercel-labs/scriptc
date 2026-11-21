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
}

async function refusals(): Promise<void> {
  for (const [label, attempt] of [
    ["empty", () => Readable.toWeb(byteReadable(), { type: "" })],
    ["text", () => Readable.toWeb(byteReadable(), { type: "text" })],
    ["number", () => Readable.toWeb(byteReadable(), { type: 5 })],
    ["null", () => Readable.toWeb(byteReadable(), { type: null })],
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
