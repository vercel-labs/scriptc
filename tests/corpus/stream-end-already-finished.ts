// writable.end's completion callback: no argument when the stream finishes,
// and ERR_STREAM_ALREADY_FINISHED when the stream already finished — the
// error-first end callback Node 24 answers.
import { Writable } from "node:stream";

const log: string[] = [];

function describe(error: unknown): string {
  if (error === null || error === undefined) return "none";
  return `${(error as { code?: string }).code}:${(error as { message?: string }).message}`;
}

async function main(): Promise<void> {
  {
    const writable = new Writable({
      write(_chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void) {
        callback();
      },
    });
    await new Promise<void>((resolve) => {
      writable.end(() => log.push("first none"));
      writable.on("finish", () => {
        writable.end((error?: Error | null) => {
          log.push(`after finish ${describe(error)}`);
          resolve();
        });
      });
    });
  }

  {
    const writable = new Writable({
      write(_chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void) {
        callback();
      },
    });
    await new Promise<void>((resolve) => {
      writable.end((error?: Error | null) => {
        log.push(`plain ${describe(error)}`);
        resolve();
      });
    });
  }

  {
    const writable = new Writable({
      write(_chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void) {
        callback();
      },
    });
    await new Promise<void>((resolve) => {
      writable.end("data", (error?: Error | null) => {
        log.push(`chunk ${describe(error)}`);
        resolve();
      });
    });
  }
}

await main();
console.log(log.join("\n"));
