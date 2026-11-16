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

  // A rejected web sink write reaches the caller's write callback, and the
  // duplex reports the failure.
  const rejected = Duplex.fromWeb({
    readable: new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.close();
      },
    }),
    writable: new WritableStream<Uint8Array>({
      write(): void {
        throw new Error("sink fail");
      },
    }),
  });
  rejected.on("error", (error: Error) => log.push(`rejected error ${error.message}`));
  await new Promise<void>((resolve) => {
    rejected.write(Buffer.from("x"), (error) => {
      log.push(`rejected cb ${error ? error.message : "ok"}`);
      resolve();
    });
  });
  await tick();

  // destroy() without an error closes cleanly: no error event.
  const cleanHooks: string[] = [];
  const clean = Duplex.fromWeb({
    readable: new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.close();
      },
    }),
    writable: new WritableStream<Uint8Array>({
      write(): void {},
      close(): void {
        cleanHooks.push("sink close");
      },
      abort(reason): void {
        cleanHooks.push(reason === null ? "sink abort null" : "sink abort reason");
      },
    }),
  });
  clean.on("error", (error: Error) => log.push(`clean error ${error.message}`));
  clean.destroy();
  await tick();
  log.push(
    `clean hooks ${cleanHooks.join(",")} destroyed ${clean.destroyed} errored ${clean.errored?.message ?? "-"}`,
  );

  // A web sink that settles after the Duplex was destroyed: the late write
  // completion must not touch the torn-down Duplex.
  let settleWrite: (() => void) | null = null;
  const late = Duplex.fromWeb({
    readable: new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.close();
      },
    }),
    writable: new WritableStream<Uint8Array>({
      write(): Promise<void> {
        return new Promise<void>((resolve) => {
          settleWrite = resolve;
        });
      },
    }),
  });
  late.write(Buffer.from("x"));
  await tick();
  late.destroy();
  if (settleWrite !== null) (settleWrite as () => void)();
  await tick();
  log.push(`late completion ${late.destroyed}`);
}

main().then(() => {
  for (const line of log) console.log(line);
});
