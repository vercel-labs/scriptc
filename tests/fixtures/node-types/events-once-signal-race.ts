// events.once under @types/node, which types the result Promise<any[]>:
// a NodeJS.ReadableStream slot and a PassThrough raced with an AbortSignal
// that the finally block aborts (the entries that throw are
// Promise<never>, so the race result is the any[] of the 'end' entry), an
// EventEmitter race, and a Transform whose completion callback is declared
// with the broad `Function` type.
import { EventEmitter, once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough, Transform } from "node:stream";

function copyPart(src: NodeJS.ReadableStream, out: PassThrough) {
  const ac = new AbortController();
  let failed = false;
  src.pipe(out, { end: false });
  return Promise.race([
    once(src, "end", { signal: ac.signal }),
    once(src, "error", { signal: ac.signal }).then(([error]) => {
      failed = true;
      throw error;
    }),
    once(out, "error", { signal: ac.signal }).then(([error]) => {
      failed = true;
      throw error;
    }),
    once(out, "close", { signal: ac.signal }).then(() => {
      failed = true;
      throw new Error("output closed before the part ended");
    }),
  ]).finally(() => {
    ac.abort();
    src.unpipe(out);
    console.log("part done", failed);
  });
}

function waitFor(a: EventEmitter) {
  const ac = new AbortController();
  return Promise.race([
    once(a, "done", { signal: ac.signal }),
    once(a, "error", { signal: ac.signal }).then(([error]) => {
      throw error;
    }),
  ]).finally(() => ac.abort());
}

class Prefixer extends Transform {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  _transform(chunk: Buffer, _encoding: string, cb: Function) {
    cb(null, "> " + chunk.toString());
  }
}

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriptc-once-race-"));
  const file = path.join(dir, "a.txt");
  fs.writeFileSync(file, "part\n");
  const out = new PassThrough();
  let text = "";
  out.on("data", (chunk: Buffer) => {
    text += chunk.toString();
  });
  const ended = await copyPart(fs.createReadStream(file), out);
  console.log("ended", ended.length);
  await copyPart(fs.createReadStream(file).pipe(new Prefixer()), out);
  console.log(JSON.stringify(text));
  try {
    await copyPart(fs.createReadStream(path.join(dir, "missing.txt")), out);
  } catch (err) {
    console.log("missing", (err as NodeJS.ErrnoException).code);
  }
  const a = new EventEmitter();
  setTimeout(() => a.emit("done", 1, "two"), 1);
  const args = (await waitFor(a)) as unknown[];
  console.log("done", JSON.stringify(args), a.listenerCount("done"), a.listenerCount("error"));
  setTimeout(() => a.emit("error", new Error("bad")), 1);
  try {
    await waitFor(a);
  } catch (err) {
    console.log("caught", (err as Error).message, a.listenerCount("done"));
  }
  fs.rmSync(dir, { recursive: true });
}

void main();
