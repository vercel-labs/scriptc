// fs.createReadStream's 'open' (the descriptor) and 'ready' emissions reach
// listeners registered through an untyped value, as they do in Node.
import { createReadStream } from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "scriptc-erased-open-"));
const file = join(dir, "data.txt");
writeFileSync(file, "abc");
const stream: any = createReadStream(file);
stream.on("open", (fd: any) => {
  console.log(`open ${typeof fd}`);
});
stream.on("ready", () => {
  console.log("ready");
});
stream.on("data", (chunk: any) => {
  console.log(`data ${String(chunk)}`);
});
stream.on("end", () => {
  console.log("end");
  rmSync(dir, { recursive: true, force: true });
});
