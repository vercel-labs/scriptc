// readdir evaluates its arguments in JavaScript's order — the path, then the
// options record's own expressions — and a listing whose names are known to
// be Buffers still runs the encoding expression. Both hold for the runtime
// forms the checker cannot pin: an encoding expression typed "buffer" and a
// recursive flag that is only a boolean.
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = fs.mkdtempSync(join(tmpdir(), "scr-readdir-order-"));
fs.mkdirSync(join(dir, "sub"));
fs.writeFileSync(join(dir, "a.txt"), "a");
fs.writeFileSync(join(dir, "sub", "b.txt"), "b");

const log: string[] = [];
function pathOf(): string {
  log.push("path");
  return dir;
}
function bufferEncoding(): "buffer" {
  log.push("encoding");
  return "buffer";
}
function utf8Encoding(): BufferEncoding {
  log.push("encoding");
  return "utf8";
}
function flag(value: boolean): boolean {
  log.push("flag");
  return value;
}
function boom(): "buffer" {
  log.push("boom");
  throw new Error("encoding threw");
}

// 1. A Buffer[] listing still runs the encoding expression, after the path.
const buffers = fs.readdirSync(pathOf(), bufferEncoding());
console.log("buffers", buffers.length > 0, Buffer.isBuffer(buffers[0]), log.join(","));
log.length = 0;

// 2. A runtime recursive flag is read last: the path and the encoding
// expression run before it.
const walk = fs.readdirSync(pathOf(), { encoding: utf8Encoding(), recursive: flag(true) });
console.log("recursive", walk.includes("sub/b.txt"), log.join(","));
log.length = 0;

// 3. A throwing encoding expression throws before the listing, after the
// path.
try {
  fs.readdirSync(pathOf(), boom());
  console.log("no throw");
} catch (err) {
  console.log("threw", (err as Error).message, log.join(","));
}
log.length = 0;

// 4. A falsy runtime flag takes the plain listing, in the same order.
const flat = fs.readdirSync(pathOf(), { recursive: flag(false) });
console.log("flat", flat.includes("a.txt"), log.join(","));
log.length = 0;

// 5. The options record's expressions run in the order the literal spells
// them, whichever order that is.
const spelled = fs.readdirSync(pathOf(), { recursive: flag(true), encoding: utf8Encoding() });
console.log("flag first", spelled.includes("sub/b.txt"), log.join(","));

fs.rmSync(dir, { recursive: true, force: true });
