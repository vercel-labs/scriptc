/* A file-backed Blob re-opens its path on every read. Whoever can write the
 * containing directory can rename a FIFO over that path first; a blocking
 * open then waits for a writer before the identity check can reject the
 * substitute, parking the thread that runs the loop. The runtime opens with
 * O_NONBLOCK on POSIX and requires the descriptor to be a regular file, so
 * the substitute is a NotReadableError instead. Node keeps the descriptor
 * from creation and never re-opens, so this is not a differential program. */
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);

const source = `import { openAsBlob, renameSync, writeFileSync } from "node:fs";

const dir: string = process.argv[2]!;
writeFileSync(dir + "/data.bin", "ready");
const before = await openAsBlob(dir + "/data.bin");
console.log("before", JSON.stringify(await before.text()));

const stale = await openAsBlob(dir + "/data.bin");
renameSync(dir + "/pipe", dir + "/data.bin");
const started = Date.now();
try {
  console.log("after", JSON.stringify(await stale.text()));
} catch (error) {
  console.log("after", (error as Error).name, Date.now() - started < 5000);
}
`;

test.runIf(process.platform !== "win32")(
  "a Blob refuses a FIFO renamed over its path without waiting for a writer",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "scriptc-blob-fifo-"));
    execFileSync("mkfifo", [join(dir, "pipe")]);
    const outDir = mkdtempSync(join(tmpdir(), "scriptc-blob-fifo-build-"));
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
    // The pre-fix open blocks until a writer appears; the timeout fails the
    // test instead of hanging the suite.
    const { stdout } = await execFileAsync(result.binaryPath, [dir], {
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(stdout).toBe(['before "ready"', "after NotReadableError true", ""].join("\n"));
  },
);
