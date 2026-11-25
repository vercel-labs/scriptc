// A FileHandle reads its own content: readLines() is Node's
// readline.Interface over the handle's read stream (crlfDelay Infinity, the
// caller's options forwarded to createReadStream), and
// [Symbol.asyncDispose]() is `await close()`. The stream a handle makes has
// autoClose on, so reading it to the end closes the handle itself; a handle
// disposed directly reports fd -1 and closing it again still resolves.
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = fs.mkdtempSync(join(tmpdir(), "scr-fh-lines-"));
const file = join(dir, "lines.txt");
fs.writeFileSync(file, "alpha\nbeta\r\ngamma\n");
const other = join(dir, "other.txt");
fs.writeFileSync(other, "one\ntwo\nthree\n");

// 1. Every line, in order, with the trailing CR of a CRLF pair dropped;
// reading the stream to its end closes the handle.
const first = await fs.promises.open(file, "r");
const lines: string[] = [];
for await (const line of first.readLines()) lines.push(String(line));
console.log("lines", lines.length, JSON.stringify(lines), first.fd >= 0);

// 2. The options reach createReadStream: a start offset and an end bound
// cut the text the lines are split from.
const second = await fs.promises.open(file, "r");
const window: string[] = [];
for await (const line of second.readLines({ start: 6, end: 12 })) {
  window.push(String(line));
}
console.log("window", JSON.stringify(window), second.fd >= 0);

// 3. Symbol.asyncDispose is close(): the handle answers fd -1 afterwards,
// and closing again resolves rather than throwing.
const third = await fs.promises.open(other, "r");
await third[Symbol.asyncDispose]();
console.log("disposed", third.fd >= 0);
await third.close();
console.log("closed twice", third.fd >= 0);

// 4. A handle's read stream is the same text in chunks.
const fourth = await fs.promises.open(other, "r");
let text = "";
for await (const chunk of fourth.createReadStream({ encoding: "utf8" })) text += String(chunk);
console.log("stream", JSON.stringify(text));

fs.rmSync(dir, { recursive: true, force: true });
