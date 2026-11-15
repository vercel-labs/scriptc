/* fs.openAsBlob records the file's size when it creates the Blob. Reading
 * the Blob builds a buffer of that length before copying into it, and a
 * length past 2^53 - 1 is where the runtime's buffer constructor throws its
 * RangeError; the read must reject with that error rather than continue
 * into the buffer it did not get. A sparse file costs almost no disk blocks,
 * and reading one under Node runs out of memory, so this is not a
 * differential program. */
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);

const source = `import { openAsBlob } from "node:fs";

const blob = await openAsBlob(process.argv[2]!);
console.log("past-safe-length", blob.size > 9007199254740991);
try {
  const bytes = await blob.arrayBuffer();
  console.log("read", bytes.byteLength);
} catch (error) {
  console.log("rejected", (error as Error).name);
}
`;

test.runIf(process.platform !== "win32")(
  "reading a Blob past the largest buffer length rejects instead of crashing",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "scriptc-blob-oversized-"));
    const file = join(dir, "huge.bin");
    writeFileSync(file, "");
    try {
      execFileSync("truncate", ["-s", "10P", file], { stdio: "ignore" });
    } catch {
      return; // the filesystem cannot hold a sparse file that large
    }
    if (statSync(file).size <= Number.MAX_SAFE_INTEGER) return;

    const outDir = mkdtempSync(join(tmpdir(), "scriptc-blob-oversized-build-"));
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
    expect(stdout).toBe(["past-safe-length true", "rejected RangeError", ""].join("\n"));
  },
);
