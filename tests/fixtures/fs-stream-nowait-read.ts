// Reads a file it writes first through a ReadStream and prints the byte
// count and a checksum (fs-stream-nowait.test.ts runs it with a preadv2
// shim).
import { createReadStream, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "scr-nowait-"));
const file = join(dir, "data.bin");
const data = Buffer.alloc(300000);
for (let i = 0; i < data.length; i++) data[i] = (i * 13) & 0xff;
writeFileSync(file, data);
let bytes = 0;
let sum = 0;
createReadStream(file, { highWaterMark: 16384 })
  .on("data", (c: Buffer) => {
    bytes += c.length;
    for (const b of c) sum = (sum + b) % 65521;
  })
  .on("end", () => {
    console.log(`bytes=${bytes} sum=${sum}`);
    rmSync(dir, { recursive: true });
  });
