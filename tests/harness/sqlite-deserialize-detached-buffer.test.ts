/* A getter read from deserialize's options can detach the input buffer. The
 * copy reads the view's state after the options, so the call answers the
 * empty-buffer argument error instead of copying storage the program has
 * already given up.
 *
 * This is a harness test rather than a corpus program: Node measures the
 * buffer's length before it reads the options, so it copies nothing and
 * accepts a buffer that is no longer there, which is not a behavior a
 * compiled program can reproduce without reading detached storage. */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const nativeToolchainTest = process.platform === "win32" ? test.skip : test;

const SOURCE = `import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE t (a)");
const bytes = db.serialize();
console.log("length", bytes.byteLength > 0);
try {
  db.deserialize(bytes, {
    get dbName() {
      bytes.buffer.transfer(0);
      console.log("detached", bytes.byteLength);
      return "main";
    },
  });
  console.log("accepted");
} catch (error) {
  console.log("error", error.code, error.message);
}
db.close();
console.log("closed");
`;

nativeToolchainTest("deserialize re-reads a buffer its options getter detached", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-sqlite-detach-"));
  try {
    const entry = join(dir, "main.mjs");
    writeFileSync(entry, SOURCE);
    const result = await compile(entry, { outDir: dir, outPath: join(dir, "program") });
    expect(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics)).toBe(true);
    const binary = result.binaryPath;
    if (!binary) throw new Error("compile produced no binary");
    const run = await execFileAsync(binary, {
      encoding: "utf8",
      env: { ...process.env },
    });
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe(
      [
        "length true",
        "detached 0",
        'error ERR_INVALID_ARG_VALUE The "buffer" argument must not be empty.',
        "closed",
        "",
      ].join("\n"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
