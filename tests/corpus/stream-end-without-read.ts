// A Readable that reaches EOF emits 'end' only through a read (read(),
// read(0), a flowing consumer) or through flow: a stream nobody observes
// stays unended after push(null), readableEnded stays false, and a
// finished() watcher waits for the read that ends it.
import { Readable, finished } from "node:stream";

const log: string[] = [];

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  // Nobody observes the stream.
  const bare = new Readable({ read(): void {} });
  bare.on("end", () => log.push("bare end"));
  bare.push(null);
  log.push(`bare pushed ended ${bare.readableEnded} destroyed ${bare.destroyed}`);
  await wait(10);
  log.push(`bare after tick ended ${bare.readableEnded} destroyed ${bare.destroyed}`);

  // A 'readable' listener ends it through the read it schedules.
  const readable = new Readable({ read(): void {} });
  readable.on("end", () => log.push("readable-listener end"));
  readable.on("readable", () => {});
  readable.push(null);
  await wait(10);
  log.push(`readable-listener ended ${readable.readableEnded}`);

  // read(0) ends an empty stream that reached EOF.
  const zero = new Readable({ read(): void {} });
  zero.on("end", () => log.push("read0 end"));
  zero.push(null);
  log.push(`read0 before ${zero.read(0)}`);
  await wait(10);
  log.push(`read0 ended ${zero.readableEnded}`);

  // A 'data' listener flows the stream to its end.
  const flowing = new Readable({ read(): void {} });
  flowing.on("end", () => log.push("data end"));
  flowing.on("data", () => {});
  flowing.push("chunk");
  flowing.push(null);
  await wait(10);
  log.push(`data ended ${flowing.readableEnded}`);

  // finished() waits for the read that reaches the end.
  const watched = new Readable({ read(): void {} });
  let finishedCalls = 0;
  finished(watched, (err) => {
    finishedCalls++;
    log.push(`finished ${err === undefined || err === null ? "clean" : (err as Error).message}`);
  });
  watched.push(null);
  await wait(10);
  log.push(`watched before read ${finishedCalls} ended ${watched.readableEnded}`);
  log.push(`watched read ${String(watched.read())}`);
  await wait(10);
  log.push(`watched after read ${finishedCalls} ended ${watched.readableEnded}`);

  // A stream with buffered data is read to its end.
  const buffered = new Readable({ read(): void {} });
  buffered.on("end", () => log.push("buffered end"));
  buffered.push("ab");
  buffered.push(null);
  log.push(`buffered length ${buffered.readableLength}`);
  log.push(`buffered read ${String(buffered.read())}`);
  await wait(10);
  log.push(`buffered after first read ended ${buffered.readableEnded}`);
  log.push(`buffered read ${String(buffered.read())}`);
  await wait(10);
  log.push(`buffered ended ${buffered.readableEnded} destroyed ${buffered.destroyed}`);
}

main().then(() => {
  for (const line of log) console.log(line);
});
