// events.once over a checked-dynamic NodeJS.ReadableStream slot: the
// program also moves a JavaScript stream object into such a slot, so the
// slots hold native streams through their typed capsules.
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { part } from "./sources.js";

function collect(src: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    src.on("data", (chunk: Buffer | string) => {
      text += chunk.toString();
    });
    src.on("end", () => resolve(text));
  });
}

function copyPart(src: NodeJS.ReadableStream, out: PassThrough) {
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
  });
}

async function main(): Promise<void> {
  console.log("js part", await collect(part(["a", "b"])));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriptc-once-dyn-"));
  const file = path.join(dir, "a.txt");
  fs.writeFileSync(file, "native part\n");
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
  fs.rmSync(dir, { recursive: true });
}

void main();
