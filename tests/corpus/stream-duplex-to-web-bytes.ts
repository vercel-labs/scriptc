// Duplex.toWeb({ readableType: 'bytes' }): the readable side of the pair is
// a byte stream, so a BYOB reader reads through its own view and a chunk
// larger than the view keeps its tail. The check reads the option as a
// shared `type`: null is its absent value, and another value is Node's
// ERR_INVALID_ARG_VALUE. The default pair keeps refusing a BYOB reader.
import { Duplex, PassThrough } from "node:stream";

const log: string[] = [];

async function main(): Promise<void> {
  const pair = Duplex.toWeb(new PassThrough(), { readableType: "bytes" });
  const writer = pair.writable.getWriter();
  const reader = pair.readable.getReader({ mode: "byob" });
  const pending = reader.read(new Uint8Array(4));
  await writer.write(Buffer.from("abcdef"));
  const first = await pending;
  log.push(
    `first ${first.done} ${first.value?.byteLength} ${Buffer.from(first.value ?? new Uint8Array()).toString()}`,
  );
  const second = await reader.read(new Uint8Array(4));
  log.push(
    `second ${second.done} ${second.value?.byteLength} ${Buffer.from(second.value ?? new Uint8Array()).toString()}`,
  );
  const pendingEnd = reader.read(new Uint8Array(4));
  await writer.close();
  const end = await pendingEnd;
  log.push(`end ${end.done}`);
  log.push(`keys ${Object.keys(pair).join(",")}`);

  const plain = Duplex.toWeb(new PassThrough());
  try {
    plain.readable.getReader({ mode: "byob" });
    log.push("plain byob accepted");
  } catch (error) {
    log.push(`plain byob ${(error as Error).name}`);
  }
}

async function refusals(): Promise<void> {
  for (const [label, attempt] of [
    ["empty", () => Duplex.toWeb(new PassThrough(), { readableType: "" })],
    ["text", () => Duplex.toWeb(new PassThrough(), { readableType: "text" })],
    ["number", () => Duplex.toWeb(new PassThrough(), { readableType: 5 })],
    ["true", () => Duplex.toWeb(new PassThrough(), { readableType: true })],
    ["null", () => Duplex.toWeb(new PassThrough(), { readableType: null })],
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
