// An immediate queued by a poll callback rejects the awaited module root.
// Node ends the evaluation on that rejection: a timer armed beside it must
// not run first.
import { readFile, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const file = join(tmpdir(), `scriptc-module-root-${process.pid}.txt`);
writeFileSync(file, "x");
await new Promise((_, reject) => {
  readFile(file, () => {
    setImmediate(() => reject(new Error("root rejected")));
    setTimeout(() => console.log("timer ran"), 0);
  });
});
