// An options value whose encoding is only known at run time types the
// result `string[] | Buffer[]` (the open-encoding overload). The runtime
// resolves the encoding and answers that arm: utf8 and other string
// encodings box the names array as strings, encoding: 'buffer' boxes the
// Buffers. The union's shared members (length, an element's typeof) read
// without choosing an arm.
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "scr-union-"));
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(`${dir}/sub`, { recursive: true });
fs.writeFileSync(`${dir}/a.txt`, "a");

type OpenOptions = { encoding?: BufferEncoding | null; recursive?: boolean };

function summarize(names: string[] | Buffer[]): string {
  return `${names.length}:${typeof names[0]}`;
}

function options(encoding: string, recursive: boolean): OpenOptions {
  return { encoding: encoding as BufferEncoding, recursive: recursive };
}

console.log("utf8", summarize(fs.readdirSync(dir, options("utf8", false))));
console.log("latin1", summarize(fs.readdirSync(dir, options("latin1", false))));
console.log("buffer", summarize(fs.readdirSync(dir, options("buffer", false))));
console.log("deep-utf8", summarize(fs.readdirSync(dir, options("utf8", true))));

async function main(): Promise<void> {
  console.log("p-utf8", summarize(await fsp.readdir(dir, options("utf8", false))));
  console.log("p-buffer", summarize(await fsp.readdir(dir, options("buffer", false))));
  console.log("p-deep-utf8", summarize(await fsp.readdir(dir, options("utf8", true))));

  // A conditional encoding picks the arm at run time.
  const pick: boolean = (fs.readdirSync(dir) as string[]).length > 1;
  const either = await fsp.readdir(dir, options(pick ? "buffer" : "utf8", false));
  console.log("either", summarize(either));
}

main().then(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
