// Readable.from evaluates its source argument, then the options object's
// values, and only then takes the source's iterator (from.js opens it
// inside the call). A source that updates a value the encoding option
// reads is therefore observed before the option is read, not after.
import { Readable } from "node:stream";

const out = (line: string): void => console.log(line);
const log: string[] = [];
let encoding: BufferEncoding = "utf8";

class SyncSource {
  [Symbol.iterator](): IterableIterator<Buffer> {
    log.push("sync open");
    encoding = "latin1";
    return [Buffer.from([0xe9])][Symbol.iterator]();
  }
}

class AsyncSource {
  [Symbol.asyncIterator](): AsyncIterableIterator<Buffer> {
    log.push("async open");
    encoding = "latin1";
    return (async function* (): AsyncGenerator<Buffer> {
      yield Buffer.from([0xe9]);
    })();
  }
}

const holder = {
  get current(): BufferEncoding {
    log.push("option read");
    return encoding;
  },
};

function source<T>(make: () => T, label: string): T {
  log.push(`arg ${label}`);
  return make();
}

async function drain(label: string, stream: Readable): Promise<void> {
  const seen: string[] = [];
  for await (const chunk of stream) seen.push(typeof chunk === "string" ? `string ${String(chunk)}` : `bytes ${(chunk as Buffer).length}`);
  out(`${label} ${seen.join(",")} ${log.join("|")}`);
}

async function main(): Promise<void> {
  await drain("sync", Readable.from(source(() => new SyncSource(), "sync"), { encoding: holder.current }));
  await drain("async", Readable.from(source(() => new AsyncSource(), "async"), { encoding: holder.current }));
}

void main();
