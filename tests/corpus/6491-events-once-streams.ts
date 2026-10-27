// events.once over streams: file streams, Readable.from, a PassThrough
// destroyed with an error, a Writable, and a NodeJS.ReadableStream slot
// raced against its destination's 'close' with an AbortSignal that the
// finally block aborts.
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";

function copyPart(src: NodeJS.ReadableStream, out: PassThrough): Promise<unknown> {
  const ac = new AbortController();
  src.pipe(out, { end: false });
  return Promise.race([
    once(src, "end", { signal: ac.signal }),
    once(src, "error", { signal: ac.signal }).then(([error]) => {
      throw error;
    }),
    once(out, "close", { signal: ac.signal }).then(() => {
      throw new Error("output closed before the part ended");
    }),
  ]).finally(() => {
    ac.abort();
    src.unpipe(out);
    console.log("part done", out.listenerCount("close"), out.listenerCount("error"));
  });
}

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriptc-once-streams-"));
  const file = path.join(dir, "a.txt");
  fs.writeFileSync(file, "part one\n");

  const rs = fs.createReadStream(file);
  rs.resume();
  console.log("file end", JSON.stringify(await once(rs, "end")));
  const ws = fs.createWriteStream(path.join(dir, "b.txt"));
  ws.end("x");
  await once(ws, "finish");
  console.log("write stream finish");
  await once(ws, "close");
  console.log("write stream close");

  const pt = new PassThrough();
  setTimeout(() => pt.destroy(new Error("pt broke")), 1);
  try {
    await once(pt, "end");
  } catch (err) {
    console.log("passthrough error", (err as Error).message, pt.listenerCount("end"));
  }
  const r = Readable.from(["a", "b"]);
  r.resume();
  await once(r, "close");
  console.log("readable close");
  const w = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  w.end("z");
  await once(w, "finish");
  console.log("writable finish");

  const out = new PassThrough();
  let text = "";
  out.on("data", (chunk: Buffer) => {
    text += chunk.toString();
  });
  await copyPart(fs.createReadStream(file), out);
  await copyPart(fs.createReadStream(file), out);
  console.log(JSON.stringify(text));
  try {
    await copyPart(fs.createReadStream(path.join(dir, "missing.txt")), out);
  } catch (err) {
    console.log("missing", (err as NodeJS.ErrnoException).code);
  }
  const closing = new PassThrough();
  setTimeout(() => closing.destroy(), 1);
  try {
    await copyPart(new Readable({ read() {} }), closing);
  } catch (err) {
    console.log("closed", (err as Error).message);
  }
  fs.rmSync(dir, { recursive: true });
}

void main();
