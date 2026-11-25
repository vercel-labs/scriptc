// fs.readdir's callback options: a bare encoding, the `{ encoding }` record
// (utf8, `buffer` for the raw bytes, any other codec), `withFileTypes` for
// Dirent rows, and `recursive` with either result — in the synchronous
// queue order the callback form uses. Each call waits for the previous one,
// so the output order is the program's own.
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = fs.mkdtempSync(join(tmpdir(), "readdir-callback-"));
fs.writeFileSync(join(dir, "a.txt"), "a");
fs.writeFileSync(join(dir, "é.txt"), "e");
fs.mkdirSync(join(dir, "one", "one-deep"), { recursive: true });
fs.mkdirSync(join(dir, "two"), { recursive: true });
fs.writeFileSync(join(dir, "one", "f.txt"), "f");
fs.writeFileSync(join(dir, "one", "one-deep", "g.txt"), "g");
fs.writeFileSync(join(dir, "two", "h.txt"), "h");
fs.symlinkSync("../two", join(dir, "one", "link"));

const call = (run: (cb: (error: any, value: any) => void) => void): Promise<any[]> =>
  new Promise((resolve) => run((error, value) => resolve([error, value])));

const names = (value: string[]): string => value.slice().sort().join(",");
const rows = (value: fs.Dirent[]): string =>
  value
    .map(
      (entry) =>
        `${entry.name}:${entry.parentPath.split(dir).join("<d>")}:${
          entry.isDirectory() ? "d" : entry.isFile() ? "f" : "?"
        }`,
    )
    .sort()
    .join(",");
const fail = (error: any): string => (error === null ? "ok" : String(error.code));

async function main(): Promise<void> {
  let [error, value] = await call((cb) => fs.readdir(dir, { encoding: "utf8" }, cb));
  console.log("record utf8", fail(error), Array.isArray(value), names(value));

  [error, value] = await call((cb) => fs.readdir(dir, "buffer", cb));
  console.log(
    "bare buffer",
    fail(error),
    value.map((buffer: Buffer) => (Buffer.isBuffer(buffer) ? buffer.toString("hex") : "no")).sort().join(","),
  );

  [error, value] = await call((cb) => fs.readdir(dir, { encoding: "buffer" }, cb));
  console.log(
    "record buffer",
    fail(error),
    value.map((buffer: Buffer) => (Buffer.isBuffer(buffer) ? buffer.toString("hex") : "no")).sort().join(","),
  );

  [error, value] = await call((cb) => fs.readdir(dir, { encoding: "hex" }, cb));
  console.log("record hex", fail(error), names(value));

  [error, value] = await call((cb) => fs.readdir(dir, { withFileTypes: true }, cb));
  console.log("types", fail(error), rows(value));

  [error, value] = await call((cb) => fs.readdir(dir, { recursive: true }, cb));
  console.log("recursive", fail(error), names(value));

  [error, value] = await call((cb) => fs.readdir(dir, { recursive: true, withFileTypes: true }, cb));
  console.log("recursive types", fail(error), rows(value));

  // Node validates the encoding at the call, before any callback runs.
  try {
    fs.readdir(dir, { encoding: "zzz" as BufferEncoding }, () => console.log("bad encoding called"));
    console.log("bad encoding", "no throw");
  } catch (err) {
    const bad = err as NodeJS.ErrnoException;
    console.log("bad encoding", bad.code, bad.message.split(dir).join("<d>"));
  }

  [error, value] = await call((cb) => fs.readdir(join(dir, "missing"), cb));
  console.log("missing", fail(error), value === undefined);

  fs.rmSync(dir, { recursive: true, force: true });
}

await main();
console.log("done");
