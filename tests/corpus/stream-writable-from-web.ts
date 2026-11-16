// Writable.fromWeb: a Writable over a web WritableStream's writer. A write
// completes when the writer's write() settles, end() closes the writer, and a
// failing sink reaches the write callback and destroys the Writable.
import { Writable } from "node:stream";

const log: string[] = [];
const decoder = new TextDecoder();

async function main(): Promise<void> {
  const chunks: string[] = [];
  const web = new WritableStream<Uint8Array>({
    write(chunk): void {
      chunks.push(decoder.decode(chunk));
    },
  });
  const writable = Writable.fromWeb(web);
  log.push(`objectMode ${writable.writableObjectMode} ended ${writable.writableEnded}`);
  await new Promise<void>((resolve, reject) => {
    writable.write(Buffer.from("ab"), (error) => {
      if (error) reject(error);
    });
    writable.end(Buffer.from("cd"), () => resolve());
  });
  log.push(`chunks ${chunks.join("|")} finished ${writable.writableFinished} ended ${writable.writableEnded}`);

  const failing = new WritableStream<Uint8Array>({
    write(): void {
      throw new Error("boom");
    },
  });
  const broken = Writable.fromWeb(failing);
  broken.on("error", (error: Error) => log.push(`error ${error.message}`));
  await new Promise<void>((resolve) => {
    broken.write(Buffer.from("x"), (error) => {
      log.push(`write cb ${error ? error.message : "null"}`);
      resolve();
    });
  });
  log.push(`destroyed ${broken.destroyed}`);

  // destroy() without an error closes the sink; destroy(err) aborts it, and
  // the stream reports the destroy's own error even when abort() rejects.
  const closedSink: string[] = [];
  const closing = Writable.fromWeb(
    new WritableStream<Uint8Array>({
      write(): void {},
      close(): void {
        closedSink.push("close");
      },
      abort(): void {
        closedSink.push("abort");
      },
    }),
  );
  closing.on("error", (error: Error) => closedSink.push(`error ${error.message}`));
  closing.destroy();
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  log.push(`close-only ${closedSink.join(",")} destroyed ${closing.destroyed}`);

  const abortLog: string[] = [];
  const aborting = Writable.fromWeb(
    new WritableStream<Uint8Array>({
      write(): void {},
      abort(reason): void {
        abortLog.push(`abort ${(reason as Error).message}`);
        throw new Error("abort failed");
      },
    }),
  );
  aborting.on("error", (error: Error) => abortLog.push(`error ${error.message}`));
  aborting.destroy(new Error("boom"));
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  log.push(`abort-path ${abortLog.join(",")} errored ${aborting.errored?.message}`);

  // A write callback that throws reports on the stream, as Node's afterWrite
  // does, and the 'drain' listener's throw reaches it the same way.
  const throwLog: string[] = [];
  const throwing = Writable.fromWeb(new WritableStream<Uint8Array>({ write(): void {} }));
  throwing.on("error", (error: Error) => throwLog.push(`error ${error.message}`));
  throwing.write(Buffer.from("x"), () => {
    throw new Error("callback boom");
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  throwLog.push(`destroyed ${throwing.destroyed}`);

  log.push(`callback-throw ${throwLog.join(",")}`);

  // An identity TransformStream's writable side is a WritableStream too.
  const fromTransform = Writable.fromWeb(new TransformStream().writable);
  log.push(`transform ${fromTransform instanceof Writable}`);
}

main().then(() => {
  for (const line of log) console.log(line);
});
