// fs streams over a cached regular file: chunk sizes of a positioned read
// with a small highWaterMark, a write stream with a start position into an
// existing file, and an append stream, checked against the file contents.
import { createReadStream, createWriteStream, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "scr-fs-cached-"));
const file = join(dir, "data.bin");
const bytes = Buffer.alloc(100000);
for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 0xff;
writeFileSync(file, bytes);

const sizes: number[] = [];
let sum = 0;
createReadStream(file, { start: 1000, end: 50999, highWaterMark: 4096 })
  .on("data", (c: Buffer) => {
    sizes.push(c.length);
    for (const b of c) sum = (sum + b) % 65521;
  })
  .on("end", () => {
    console.log(`read chunks=${sizes.length} first=${sizes[0]} last=${sizes[sizes.length - 1]} sum=${sum}`);
    const out = createWriteStream(file, { flags: "r+", start: 10 });
    for (let i = 0; i < 50; i++) out.write(Buffer.alloc(1000, i));
    out.end(() => {
      const after = readFileSync(file);
      console.log(`positioned len=${after.length} at10=${after[10]} at1009=${after[1009]} at1010=${after[1010]} at50009=${after[50009]} at50010=${after[50010]}`);
      const app = createWriteStream(file, { flags: "a" });
      app.write("tail-1;");
      app.end("tail-2", () => {
        const final = readFileSync(file);
        console.log(`append len=${final.length} end=${final.subarray(final.length - 13).toString()}`);
        rmSync(dir, { recursive: true });
      });
    });
  });
