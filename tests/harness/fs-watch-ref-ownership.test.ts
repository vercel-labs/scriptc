/* FSWatcher.ref()/unref() answer the receiver, and a program may keep that
 * answer (const same = watcher.ref()) or chain from it. The value the call
 * answers carries its own reference like every other refcounted result; a
 * borrowed one made the compiler's ownership check reject such a program
 * with an internal error, so this compiles and runs rather than differing
 * from Node. */
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);

const source = `import { watch } from "node:fs";

const watcher = watch(process.argv[2]!, () => {});
const same = watcher.ref();
const again = same.unref();
const chained = again.ref().unref();
chained.close();
console.log("ok", true);
`;

test("a watcher's ref() and unref() answer a value a program can keep", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-watch-ref-"));
  const file = join(dir, "watched.txt");
  writeFileSync(file, "x");
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-watch-ref-build-"));
  const entry = join(outDir, "main.ts");
  writeFileSync(entry, source);
  const result = await compile(entry, {
    backend: "llvm",
    sanitize: process.env["SCRIPTC_SAN"] === "1",
    outDir,
    outPath: join(outDir, "program"),
  });
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
  if (!result.ok) return;
  const { stdout } = await execFileAsync(result.binaryPath, [file], {
    encoding: "utf8",
    timeout: 20_000,
  });
  expect(stdout).toBe("ok true\n");
});
