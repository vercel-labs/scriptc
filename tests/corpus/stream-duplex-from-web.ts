// Duplex.fromWeb: the readable side reads the pair's ReadableStream and the
// writable side writes its WritableStream, joined by duplexify (allowHalfOpen
// false, byte mode on both sides).
import { Duplex } from "node:stream";

const log: string[] = [];
const decoder = new TextDecoder();
const encoder = new TextEncoder();

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

async function main(): Promise<void> {
  const written: string[] = [];
  const readable = new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(encoder.encode("hi"));
      controller.close();
    },
  });
  const writable = new WritableStream<Uint8Array>({
    write(chunk): void {
      written.push(decoder.decode(chunk));
    },
  });
  const duplex = Duplex.fromWeb({ readable, writable });
  log.push(`allowHalfOpen ${duplex.allowHalfOpen} objectMode ${duplex.readableObjectMode}/${duplex.writableObjectMode}`);
  duplex.write(Buffer.from("out"));
  await tick();
  log.push(`written ${written.join("|")} destroyed ${duplex.destroyed}`);
  const read: string[] = [];
  for await (const chunk of duplex) read.push(decoder.decode(chunk as Uint8Array));
  log.push(`read ${read.join("|")}`);
  // The readable side ended, so the half-closed writable side and the duplex
  // finish: allowHalfOpen false closes it (Node's endReadableNT).
  await tick();
  log.push(`after end destroyed ${duplex.destroyed}`);
}

main().then(() => {
  for (const line of log) console.log(line);
});
