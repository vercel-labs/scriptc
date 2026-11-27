/* A published array is shared across workers by pointer, so the runtime
 * refuses one that carries a prototype it received: the prototype is a
 * mutable, refcounted reference of this thread, exactly like the array's
 * other out-of-line state (properties). Refusing keeps a published graph
 * immutable for every worker. */
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

test(`publishing an array with a prototype refuses${sanitize ? " (sanitized)" : ""}`, async () => {
  const file = join(repoRoot, "tests/fixtures/publish-array-prototype/main.ts");
  const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests", "publish-array-prototype");
  const result = await compile(file, {
    outPath: join(outDir, "program"),
    outDir,
    sanitize,
    backend: "llvm",
  });
  if (!result.ok) {
    throw new Error(
      "program failed to compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  const run = await execFileAsync(result.binaryPath, [], { encoding: "utf8" });
  expect(run.stdout).toBe(
    [
      "plain published",
      "prototyped Cannot publish an array with non-index properties",
      "null-prototype Cannot publish an array with non-index properties",
      "record published",
      "record-prototype Cannot publish a record with a prototype",
      "",
    ].join("\n"),
  );
  expect(run.stderr).toBe("");
});
