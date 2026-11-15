/* Writable.fromWeb and Duplex.fromWeb call the web stream's overridable
 * getWriter/getReader, and the value those answer need not be the native
 * writer or reader: a stream can return any value. The runtime reads
 * `closed` from it and later calls write/close/abort through the checked
 * dynamic invocation, so the answer must be treated as the value it is.
 * Dispatching on it as a native handle would take its union fields as a
 * registry tag and a pointer and touch invalid memory in a compiled
 * program.
 *
 * Node throws a TypeError out of these factories for the same inputs (its
 * adapter passes the answer to Promise.prototype.then). The runtime's
 * observable answer differs there, so this is not a differential corpus
 * program: it pins that the construction, the destroy and the exit stay
 * clean, and in the sanitized lane it pins that no invalid access happens. */
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const fixture = join(repoRoot, "tests/fixtures/stream-web-adapter-returns/main.ts");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

test(
  "a fromWeb adapter reads an ordinary writer or reader answer as a value",
  { timeout: 300_000 },
  async () => {
    const key = createHash("sha256")
      .update(fixture)
      .update(readFileSync(fixture))
      .update(sanitize ? "san" : "plain")
      .digest("hex")
      .slice(0, 16);
    const outDir = join(cacheDir, `stream-web-adapter-returns-${key}`);
    mkdirSync(outDir, { recursive: true });
    const result = await compile(fixture, {
      outPath: join(outDir, "program"),
      outDir,
      sanitize,
      backend: "llvm",
    });
    if (!result.ok)
      throw new Error(
        "fixture failed to compile:\n" +
          result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
      );
    const run = await execFileAsync(result.binaryPath, [], {
      encoding: "utf8",
      timeout: 240_000,
    });
    expect(run.stderr).toBe("");
    expect(run.stdout.trim().split("\n")).toEqual(["writable true", "duplex true"]);
  },
);
