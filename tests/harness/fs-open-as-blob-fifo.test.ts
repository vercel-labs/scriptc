/* fs.openAsBlob opens the path to stat it before answering the Blob. Node
 * does that open off the event loop, so a FIFO in the path cannot stall the
 * caller; a compiled program opens on its own event-loop thread, so the
 * open has to be non-blocking. The fixture runs against a FIFO with no
 * writer: a blocking open parked the loop forever, while the non-blocking
 * one answers like Node's (size 0, and the timer scheduled before the call
 * has not run yet). Needs a native toolchain; skipped on Windows, where
 * mkfifo does not exist. */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const entry = join(repoRoot, "tests/fixtures/fs-open-as-blob-fifo/main.ts");
const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests/fs-open-as-blob-fifo");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

let binary = "";
let dir = "";
let fifo = "";

async function run(program: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(program, args, { encoding: "utf8", timeout: 20_000 });
  return stdout;
}

describe.skipIf(process.platform === "win32")("fs.openAsBlob over a FIFO", () => {
  beforeAll(async () => {
    mkdirSync(outDir, { recursive: true });
    const result = await compile(entry, { outPath: join(outDir, "main"), outDir, sanitize });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    binary = result.binaryPath;
    dir = mkdtempSync(join(tmpdir(), "scriptc-open-as-blob-"));
    fifo = join(dir, "pipe");
    await execFileAsync("mkfifo", [fifo]);
  }, 600_000);

  afterAll(() => {
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
  });

  test("the call answers at once instead of waiting for a writer, as Node's does", async () => {
    const expected = await run(process.execPath, [
      "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      entry,
      fifo,
    ]);
    const actual = await run(binary, [fifo]);
    expect(actual).toBe(expected);
    expect(actual).toBe("after 0 false\n");
  }, 60_000);
});
