/* A file-backed Blob reads its path at every read and, like libuv's
 * FdEntry check, compares the size and mtime nanoseconds with the snapshot
 * taken when it was made. Those two values are visible to whoever can write
 * the containing directory, so a file substituted there with the same
 * length and the same mtime passes the check and the Blob reads a file its
 * owner never opened. The runtime also requires the object's identity: the
 * device and inode on POSIX, the volume serial number and file index the
 * creation handle reports on Windows. A substitution is then a
 * NotReadableError — both when the file itself is renamed over, and when a
 * junction redirects the whole directory to a substitute the attacker
 * controls. Node reads the substitute here, so this is not a differential
 * program. */
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);

async function compileAndRun(source: string, args: string[]): Promise<string> {
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
  if (!result.ok) return "";
  const { stdout } = await execFileAsync(result.binaryPath, args, { encoding: "utf8" });
  return stdout;
}

const renameSource = `import { openAsBlob, renameSync, utimesSync, writeFileSync } from "node:fs";

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

const junctionSource = `import { mkdirSync, openAsBlob, renameSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";

const root: string = process.argv[2]!;
const stamp = 1700000000;

mkdirSync(root + "/target");
writeFileSync(root + "/target/data.bin", "PUBLIC");
utimesSync(root + "/target/data.bin", stamp, stamp);

const blob = await openAsBlob(root + "/target/data.bin");
console.log("live", JSON.stringify(await blob.text()));

// The Blob was made from root/target/data.bin. Move that directory aside
// and put a junction in its place that points at a directory holding a
// same-length file with the same whole-second mtime: the path now resolves
// to a file with matching metadata that the Blob's owner never opened.
mkdirSync(root + "/attacker");
writeFileSync(root + "/attacker/data.bin", "SECRET");
utimesSync(root + "/attacker/data.bin", stamp, stamp);
renameSync(root + "/target", root + "/target.moved");
symlinkSync(root + "/attacker", root + "/target", "junction");

try {
  console.log("substituted", JSON.stringify(await blob.text()));
} catch (error) {
  console.log("substituted", (error as Error).name);
}
`;

test("a Blob refuses a substitute with the same size and mtime", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-blob-identity-"));
  const stdout = await compileAndRun(renameSource, [dir]);
  expect(stdout).toBe(['live "AAAAAA"', "substituted NotReadableError", ""].join("\n"));
});

test("a Blob refuses a directory redirected to a substitute the same size and mtime", async () => {
  const root = mkdtempSync(join(tmpdir(), "scriptc-blob-junction-"));
  const stdout = await compileAndRun(junctionSource, [root]);
  expect(stdout).toBe(['live "PUBLIC"', "substituted NotReadableError", ""].join("\n"));
});
