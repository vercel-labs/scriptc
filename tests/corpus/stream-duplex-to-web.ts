// Duplex.toWeb: the { writable, readable } web pair over a native Duplex.
// The pair enumerates writable then readable; a writer's chunks arrive on the
// readable side, close() ends the duplex, cancel() destroys it, and a
// destroyed duplex adapts to a closed writable and an ended readable.
import { Duplex, PassThrough } from "node:stream";

const log: string[] = [];
const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function main(): Promise<void> {
  const duplex = new PassThrough();
  const pair = Duplex.toWeb(duplex);
  log.push(`keys ${Object.keys(pair).join(",")}`);
  log.push(
    `web ${pair.readable instanceof ReadableStream} ${pair.writable instanceof WritableStream}`,
  );
  const reader = pair.readable.getReader();
  const writer = pair.writable.getWriter();
  await writer.write(encoder.encode("hello "));
  await writer.write(encoder.encode("world"));
  const first = await reader.read();
  log.push(`first ${decoder.decode(first.value)} done ${first.done}`);
  const second = await reader.read();
  log.push(`second ${decoder.decode(second.value)}`);
  await writer.close();
  const tail = await reader.read();
  log.push(`tail done ${tail.done} ended ${duplex.readableEnded}`);
  log.push(`finished ${duplex.writableFinished} destroyed ${duplex.destroyed}`);

  // A readable cancel destroys the duplex.
  const settling = new PassThrough();
  const settlingPair = Duplex.toWeb(settling);
  await settlingPair.readable.cancel("later");
  log.push(`cancelled destroyed ${settling.destroyed}`);

  // A destroyed duplex adapts to closed streams.
  const dead = new PassThrough();
  dead.destroy();
  const deadPair = Duplex.toWeb(dead);
  const deadRead = deadPair.readable.getReader();
  log.push(`dead read done ${(await deadRead.read()).done}`);
  await deadPair.writable
    .getWriter()
    .close()
    .then(
      () => log.push("dead writable closed"),
      (error: Error) => log.push(`dead writable rejected ${(error as { code?: string }).code}`),
    );
}

await main();
console.log(log.join("\n"));
