/* The node -> web adapters (Readable.toWeb, Writable.toWeb, Duplex.toWeb)
 * must stop rooting a conversion once it reaches a terminal state. Their
 * context is reachable from a live list so the stream's listeners cannot
 * keep it alive forever, but a context that stayed on that list after
 * completion (or cancellation, or an error) would keep the node stream, its
 * web controller and the listeners allocated until process exit: a compiled
 * service that adapts a stream per client operation would then accumulate
 * one conversion's graph per request until memory runs out.
 *
 * The fixture builds five conversions per round, one per terminal path, two
 * fromWeb constructions whose signal option is rejected, and yields to the
 * event loop so the stream's deferred close ticks run. It reports the
 * runtime heap after a warm-up: unlinked contexts leave only a few tens of
 * kilobytes of allocator noise, while one rooted context per conversion
 * adds megabytes. It also pins that a finished adapter keeps the listeners
 * Node's adapters leave on the stream, so the fix does not change what a
 * program can observe there, and that a rejected signal still reaches the
 * caller as the exception it is.
 *
 * The sanitized lane's allocator reports different figures, so this measures
 * the plain runtime only. */
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const fixture = join(repoRoot, "tests/fixtures/stream-web-reclamation/main.ts");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

test.skipIf(sanitize)(
  "a finished node -> web adapter releases the conversion before exit",
  { timeout: 300_000 },
  async () => {
    const key = createHash("sha256")
      .update(fixture)
      .update(readFileSync(fixture))
      .update("plain")
      .digest("hex")
      .slice(0, 16);
    const outDir = join(cacheDir, `stream-web-reclamation-${key}`);
    mkdirSync(outDir, { recursive: true });
    const result = await compile(fixture, {
      outPath: join(outDir, "program"),
      outDir,
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
    const lines = run.stdout.trim().split("\n");
    // Node's adapters leave the data and the post-eos error listener on a
    // completed readable (and drain/error on a completed writable).
    expect(lines.slice(0, 2)).toEqual(["listeners 1 1", "listeners 1 1"]);
    const growth = Number(/^growth (-?\d+)$/.exec(lines[2] ?? "")?.[1]);
    expect(Number.isFinite(growth)).toBe(true);
    // The fixed runtime stays within tens of kilobytes; retaining one
    // context per conversion adds a few kilobytes per round.
    expect(growth, `heap growth ${growth} KB`).toBeLessThan(1024);
    // Both rejected constructions still threw.
    expect(lines[3]).toBe("rejected 1000");
  },
);
