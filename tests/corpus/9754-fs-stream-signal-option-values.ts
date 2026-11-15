// The `signal` of an fs stream through an options value instead of a literal
// at the call: a record built first (the member is there, its value is often
// undefined), a value of a declared options type, a spread, and readline
// over the stream. Each form behaves as the literal does.
import {
  createReadStream,
  createWriteStream,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const dir = mkdtempSync(join(tmpdir(), "scr-ssv-"));
const file = join(dir, "data.jsonl");
writeFileSync(file, '{"a":1}\n{"a":2}\n\n{"a":3}\n');

interface ReadOptions {
  encoding?: "utf8";
  highWaterMark?: number;
  signal?: AbortSignal;
}

interface WriteOptions {
  flags?: string;
  signal?: AbortSignal;
}

function nameOf(error: unknown): string {
  return error instanceof Error ? `${error.name} ${(error as NodeJS.ErrnoException).code}` : "?";
}

async function countLines(path: string, signal?: AbortSignal): Promise<number> {
  const options = { encoding: "utf8" as const, signal };
  const lines = createInterface({ input: createReadStream(path, options), crlfDelay: Infinity });
  let count = 0;
  for await (const line of lines) if (line.length > 0) count++;
  return count;
}

async function readAll(options: ReadOptions): Promise<string> {
  let text = "";
  try {
    for await (const chunk of createReadStream(file, options)) text += String(chunk);
  } catch (error) {
    return `failed: ${nameOf(error)}`;
  }
  return JSON.stringify(text.length);
}

function write(path: string, options: WriteOptions): Promise<string> {
  return new Promise<string>((resolve) => {
    const stream = createWriteStream(path, options);
    let failure = "";
    stream.on("error", (error: Error) => {
      failure = nameOf(error);
    });
    stream.on("close", () => resolve(failure === "" ? readFileSync(path, "utf8") : `failed: ${failure}`));
    stream.end("written");
  });
}

async function main(): Promise<void> {
  try {
    console.log("no signal:", await countLines(file));
  } catch (error) {
    console.log("no signal: failed:", nameOf(error));
  }
  try {
    console.log("a live signal:", await countLines(file, new AbortController().signal));
  } catch (error) {
    console.log("a live signal: failed:", nameOf(error));
  }
  try {
    console.log("an aborted signal:", await countLines(file, AbortSignal.abort()));
  } catch (error) {
    console.log("an aborted signal: failed:", nameOf(error));
  }

  console.log("declared type, no signal:", await readAll({ encoding: "utf8" }));
  console.log("declared type, live:", await readAll({ signal: new AbortController().signal }));
  console.log("declared type, aborted:", await readAll({ signal: AbortSignal.abort() }));

  const base = { highWaterMark: 8 };
  const controller = new AbortController();
  let chunks = 0;
  let caught = "nothing";
  try {
    for await (const chunk of createReadStream(file, { ...base, signal: controller.signal })) {
      if (chunk.length > 0 && ++chunks === 2) controller.abort();
    }
  } catch (error) {
    caught = nameOf(error);
  }
  console.log("spread:", chunks, "chunks, caught", caught);

  console.log("write, declared type, no signal:", await write(join(dir, "a.txt"), {}));
  console.log(
    "write, declared type, live:",
    await write(join(dir, "b.txt"), { signal: new AbortController().signal }),
  );
  console.log(
    "write, declared type, aborted:",
    await write(join(dir, "c.txt"), { signal: AbortSignal.abort() }),
  );
}

main();
