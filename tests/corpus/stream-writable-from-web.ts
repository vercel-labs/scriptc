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
}

main().then(() => {
  for (const line of log) console.log(line);
});
