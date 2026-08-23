import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const sanitize = process.env["SCRIPTC_SAN"] === "1";

interface RunResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

async function run(cmd: string, args: string[]): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { encoding: "buffer" });
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    if (
      typeof err !== "object" || err === null ||
      !("code" in err) || typeof err.code !== "number" ||
      !("stdout" in err) || !Buffer.isBuffer(err.stdout) ||
      !("stderr" in err) || !Buffer.isBuffer(err.stderr)
    ) {
      throw err;
    }
    return { stdout: err.stdout, stderr: err.stderr, exitCode: err.code };
  }
}

async function compileAndCompare(source: string, backend: "c" | "llvm"): Promise<void> {
  const key = createHash("sha256")
    .update(source)
    .update(`${backend}-${sanitize ? "san" : "plain"}`)
    .digest("hex")
    .slice(0, 16);
  const outDir = join(tmpdir(), "scriptc-tests", `global-buffer-alias-${key}`);
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, "main.mts");
  writeFileSync(file, source);
  const result = await compile(file, {
    outPath: join(outDir, "program"),
    outDir,
    sanitize,
    backend,
  });
  if (!result.ok) {
    throw new Error(
      "guarded global Buffer alias program failed to compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  const [nodeResult, nativeResult] = await Promise.all([
    run("node", ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", file]),
    run(result.binaryPath, []),
  ]);
  expect(nativeResult.stdout).toEqual(nodeResult.stdout);
  expect(nativeResult.stderr).toEqual(nodeResult.stderr);
  expect(nativeResult.exitCode).toBe(nodeResult.exitCode);
}

async function compileAndExpectFence(source: string, backend: "c" | "llvm"): Promise<void> {
  const key = createHash("sha256").update(source).update(backend).digest("hex").slice(0, 16);
  const outDir = join(tmpdir(), "scriptc-tests", `global-buffer-alias-fence-${key}`);
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, "main.mts");
  writeFileSync(file, source);
  const result = await compile(file, {
    outPath: join(outDir, "program"),
    outDir,
    sanitize,
    backend,
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n")).toContain(
    "SC1090: the reference to 'runtimeBuffer' (a binding form with no lowering) is not supported yet",
  );
}

describe.each(["c", "llvm"] as const)(
  `guarded global Buffer alias, %s backend${sanitize ? " (sanitized)" : ""}`,
  (backend) => {
    test("counts UTF-8 bytes through the guarded constructor alias", async () => {
      await compileAndCompare(`
interface RuntimeBuffer {
  byteLength(value: string, encoding?: "utf8"): number;
}

const runtimeBuffer = (globalThis as { Buffer?: RuntimeBuffer }).Buffer;

function byteLength(content: string): number {
  return runtimeBuffer
    ? runtimeBuffer.byteLength(content, "utf8")
    : content.length;
}

console.log(byteLength("ascii"));
console.log(byteLength("é"));
console.log(byteLength("😀"));
console.log(runtimeBuffer ? runtimeBuffer.byteLength("Aé😀") : -1);
`, backend);
    });

    test("preserves unsupported member fences through the alias", async () => {
      await compileAndExpectFence(`
interface RuntimeBuffer {
  byteLength(value: string): number;
  poolSize?: number;
}

const runtimeBuffer = (globalThis as { Buffer?: RuntimeBuffer }).Buffer;
console.log(runtimeBuffer ? runtimeBuffer.poolSize : -1);
`, backend);
    });
  },
);
