/* The builtin path/os surface TYPED BY @types/node (the fallback
 * declarations stand down in this fixture): named imports resolve through
 * @types/node's `export =` PlatformPath shape and still lower to the same
 * static libCalls — bare and node:-prefixed specifiers alike. The test
 * pins the (machine-independent) output. */
import { basename, join, sep } from "path";
import { dirname, extname, isAbsolute } from "node:path";
import { EOL, platform } from "node:os";
import { tmpdir } from "os";
import { rmSync, statSync, writeFileSync } from "fs";
import { readFile } from "fs/promises";

console.log(join("a", "..", "b", "c.txt"));
console.log(dirname("/x/y/z"), basename("/x/y/z.md", ".md"), extname("q.tar.gz"));
console.log(isAbsolute(tmpdir()), sep);
console.log(platform() === process.platform, EOL === "\n");
// @types/node's Stats class maps to the runtime Stats value; fs/promises'
// "utf8" overload resolves to Promise<string> and lowers. A scratch file
// under tmpdir keeps the fixture cwd-independent.
const scratch = join(tmpdir(), "scr-fixture-path-os.txt");
writeFileSync(scratch, "stat me");
const scratchStats = statSync(scratch);
console.log(
  scratchStats.isFile(),
  scratchStats.blocks >= 0,
  scratchStats.nlink >= 1,
  scratchStats.atimeMs > 0,
  statSync(tmpdir()).isDirectory(),
);
async function main(): Promise<void> {
  const text = await readFile(scratch, "utf8");
  console.log(text === "stat me");
  rmSync(scratch);
}
main();
