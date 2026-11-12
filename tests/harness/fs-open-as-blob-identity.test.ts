/* A file-backed Blob reads its path at every read and, like libuv's
 * FdEntry check, compares the size and mtime nanoseconds with the snapshot
 * taken when it was made. Those two values are visible to whoever can write
 * the containing directory, so a file substituted there with the same
 * length and the same mtime passes the check and the Blob reads a file its
 * owner never opened. On POSIX the runtime also requires the device and
 * inode the Blob was created from, so the substitution is a
 * NotReadableError. Node reads the substitute here, so this is not a
 * differential program. */
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);

const source = `import { openAsBlob, renameSync, utimesSync, writeFileSync } from "node:fs";

const dir: string = process.argv[2]!;
const stamp = 1700000000;

// Same length and the same mtime: only the identity separates them.
writeFileSync(dir + "/a.bin", "AAAAAA");
writeFileSync(dir + "/protected.bin", "SECRET");
utimesSync(dir + "/a.bin", stamp, stamp);
utimesSync(dir + "/protected.bin", stamp, stamp);

const live = await openAsBlob(dir + "/a.bin");
console.log("live", JSON.stringify(await live.text()));

const stale = await openAsBlob(dir + "/a.bin");
renameSync(dir + "/protected.bin", dir + "/a.bin");
try {
  console.log("substituted", JSON.stringify(await stale.text()));
} catch (error) {
  console.log("substituted", (error as Error).name);
}
`;

test("a Blob refuses a substitute with the same size and mtime", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-blob-identity-"));
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-blob-identity-build-"));
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
  const { stdout } = await execFileAsync(result.binaryPath, [dir], { encoding: "utf8" });
  expect(stdout).toBe(['live "AAAAAA"', "substituted NotReadableError", ""].join("\n"));
});
