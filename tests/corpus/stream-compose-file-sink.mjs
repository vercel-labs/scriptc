// compose with a file write stream as its last stage: the chunks reach the
// file as the bytes the readable produced, and the file holds them.
import { Readable, compose } from "node:stream";
import { createWriteStream, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "compose-sink-"));
const path = join(dir, "out.bin");
const make = (sink) => compose(Readable.from([Buffer.from("abc"), Buffer.from("def")]), sink);

const sink = createWriteStream(path);
const composed = make(sink);
composed.on("error", (error) => console.log("error", error.code));
await new Promise((resolve, reject) => sink.on("finish", resolve).on("error", reject));
await new Promise((resolve) => setTimeout(resolve, 20));
console.log("file", JSON.stringify(readFileSync(path, "utf8")));
