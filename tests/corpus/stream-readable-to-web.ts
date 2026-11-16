// Readable.toWeb: a web ReadableStream over a Node readable. Reads pull one
// chunk at a time, the readable's error rejects the read, cancelling destroys
// the readable, and the stream is a Response body.
import { Readable } from "node:stream";

const log: string[] = [];
const decoder = new TextDecoder();

async function main(): Promise<void> {
  const readable = Readable.from([Buffer.from("ab"), Buffer.from("cd")]);
  const web = Readable.toWeb(readable);
  log.push(`locked ${web.locked} stream ${web instanceof ReadableStream}`);
  const reader = web.getReader();
  const first = await reader.read();
  const firstChunk = first.value as Uint8Array;
  log.push(`first ${first.done} ${firstChunk instanceof Uint8Array} ${decoder.decode(firstChunk)}`);
  const second = await reader.read();
  log.push(`second ${second.done} ${decoder.decode(second.value as Uint8Array)}`);
  const end = await reader.read();
  log.push(`end ${end.done} ${end.value === undefined}`);

  const failing = new Readable({
    read(): void {
      this.destroy(new Error("boom"));
    },
  });
  try {
    await Readable.toWeb(failing).getReader().read();
    log.push("error read resolved");
  } catch (e: unknown) {
    log.push(`error read rejected ${(e as Error).message}`);
  }

  const endless = new Readable({ read(): void {} });
  endless.on("close", () => log.push("cancel close"));
  const endlessWeb = Readable.toWeb(endless);
  const endlessReader = endlessWeb.getReader();
  const parked = endlessReader.read();
  await endlessReader.cancel("stop");
  const settled = await parked;
  log.push(`parked ${settled.done} destroyed ${endless.destroyed} length ${endless.readableLength}`);

  const response = new Response(
    Readable.toWeb(Readable.from([Buffer.from("hello "), Buffer.from("world")])),
  );
  log.push(`response ${await response.text()}`);

  // Node's adapter enqueues each buffered chunk by itself, and copies a
  // Buffer chunk into a plain Uint8Array detached from the readable.
  const buffered = new Readable({ read(): void {} });
  buffered.push(Buffer.from("ab"));
  buffered.push(Buffer.from("cd"));
  buffered.push(null);
  const bufferedReader = Readable.toWeb(buffered).getReader();
  const bufferedOne = await bufferedReader.read();
  const bufferedTwo = await bufferedReader.read();
  const bufferedFirst = bufferedOne.value as Uint8Array;
  const bufferedSecond = bufferedTwo.value as Uint8Array;
  log.push(`chunks ${decoder.decode(bufferedFirst)}/${decoder.decode(bufferedSecond)} ${bufferedFirst.length}/${bufferedSecond.length}`);

}

main().then(
  () => {
    for (const line of log) console.log(line);
  },
  (e: unknown) => console.log("main rejected", (e as Error).message),
);
