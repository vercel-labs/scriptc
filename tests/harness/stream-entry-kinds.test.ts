/* Stream chunk kinds Node cannot oracle — scriptc-only.
 *
 * Under SCRIPTC_SAN=1 (ASan and the RC audit, like every harness lane)
 * these pins prove no string reaches Buffer code. The Node-observable
 * cases are corpus programs (stream-dynamic-entry-kinds.*, and
 * 7439-readable-read-string-chunks for read() of strings).
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function compileAndRun(name: string, source: string, ext = "ts"): Promise<RunResult> {
  const key = createHash("sha256")
    .update(source)
    .update(sanitize ? "san" : "plain")
    .digest("hex")
    .slice(0, 16);
  const outDir = join(cacheDir, `stream-kinds-${key}`);
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${name}.${ext}`);
  writeFileSync(file, source);
  const result = await compile(file, {
    outPath: join(outDir, name),
    outDir,
    sanitize,
    backend: "llvm",
  });
  if (!result.ok) {
    throw new Error(
      "stream program failed to compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  try {
    const { stdout, stderr } = await execFileAsync(result.binaryPath, [], { encoding: "utf8" });
    return { stdout, stderr: stripAsanFiberWarning(stderr), exitCode: 0 };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: string; stderr?: string };
    if (typeof e.code !== "number") throw err;
    return {
      stdout: e.stdout ?? "",
      stderr: stripAsanFiberWarning(e.stderr ?? ""),
      exitCode: e.code,
    };
  }
}

/** Linux ASan's once-per-process swapcontext warning (see errors.test.ts). */
function stripAsanFiberWarning(s: string): string {
  return s.replace(
    /^==\d+==WARNING: ASan doesn't fully support makecontext\/swapcontext.*\n/gm,
    "",
  );
}

describe(`typed stream reads of string chunks (scriptc-only${sanitize ? ", sanitized" : ""})`, () => {
  test("a dynamic source that mixes Buffers and strings yields each as it is, as Node does", async () => {
    const r = await compileAndRun(
      "mixed-dynamic-source",
      `import { Readable } from "node:stream";
const values: any = JSON.parse('["s1"]');
values.unshift(Buffer.from("b1"));
const r = Readable.from(values);
r.on("data", (c: any) => console.log("data", Buffer.isBuffer(c), String(c)));
r.on("error", (err: Error) => console.log("error", err.message));
r.on("close", () => console.log("close"));
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("data true b1\ndata false s1\nclose\n");
  });
});
