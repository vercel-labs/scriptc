// 'data' listeners on runtime streams may declare the chunk as
// `Buffer | string` (the @types/node ReadStream listener type): the
// listener receives a Buffer, or a string once an encoding applies.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough, Readable } from "node:stream";

function describe(label: string, chunk: Buffer | string): void {
  if (typeof chunk === "string") console.log(label, "string", JSON.stringify(chunk));
  else console.log(label, "buffer", chunk.length, JSON.stringify(chunk.toString()));
}

const raw = new PassThrough();
raw.on("data", (chunk: Buffer | string) => describe("raw", chunk));
raw.write("abc");
raw.end(Buffer.from("de"));

const text = new PassThrough();
text.setEncoding("utf8");
text.on("data", (chunk: Buffer | string) => describe("text", chunk));
text.end("héllo");

const r = new Readable({ read() {} });
r.on("data", (chunk: Buffer | string) => describe("readable", chunk));
r.on("end", () => console.log("readable end"));
r.push("one");
r.push(null);

const file = path.join(os.tmpdir(), `scriptc-6471-${process.pid}.txt`);
fs.writeFileSync(file, "file contents\n");
const stream = fs.createReadStream(file);
const release = (): void => console.log("released");
stream.on("data", (chunk: Buffer | string) => describe("file", chunk));
stream.on("error", release);
// The second read starts once the first stream has closed its file, so the
// order of its 'close' and the second stream's data does not depend on
// which file operation finishes first.
stream.on("close", () => {
  release();
  const encoded = fs.createReadStream(file, { encoding: "utf8" });
  encoded.on("data", (chunk: Buffer | string) => describe("file utf8", chunk));
  encoded.on("close", () => {
    fs.unlinkSync(file);
    console.log("done");
  });
});
