// Duplex.fromWeb completions consume each rejected operation's error
// exactly once: a rejected sink write reaches the caller's write callback,
// and a rejected sink close fails end(). The sanitized lane's allocator
// reports an over-released completion error as a use-after-free.
import { Duplex } from "node:stream";

const log: string[] = [];

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

// Duplex.fromWeb completions consume each rejected operation's error exactly once:
// a rejected sink write reaches the caller's write callback, and a rejected
// sink close fails end(). The sanitized lane's allocator reports an
// over-released error as a use-after-free.
function main(): Promise<void> {
  const writeRejected = Duplex.fromWeb({
    readable: new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.close();
      },
    }),
    writable: new WritableStream<Uint8Array>({
      write(): void {
        throw new Error("write failed");
      },
    }),
  });
  writeRejected.on("error", (error: Error) => log.push(`write error ${error.message}`));
  writeRejected.on("close", () => log.push(`write close destroyed=${writeRejected.destroyed}`));
  return new Promise<void>((resolve) => {
    writeRejected.write(Buffer.from("x"), (error?: Error | null) => {
      log.push(`write cb ${error ? error.message : "ok"}`);
      resolve();
    });
  })
    .then(tick)
    .then(() => {
      const closeRejected = Duplex.fromWeb({
        readable: new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.close();
          },
        }),
        writable: new WritableStream<Uint8Array>({
          write(): void {},
          close(): void {
            throw new Error("close failed");
          },
        }),
      });
      closeRejected.on("error", (error: Error) => log.push(`final error ${error.message}`));
      closeRejected.on("close", () => log.push(`final close destroyed=${closeRejected.destroyed}`));
      return new Promise<void>((resolve) => {
        closeRejected.on("close", () => resolve());
        closeRejected.end();
      });
    });
}

main().then(() => console.log(log.join("\n")));
