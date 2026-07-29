import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const cacheDir = join(tmpdir(), "scriptc-unknown-fields-tests");
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

async function compileAndCompare(name: string, source: string, backend: "c" | "llvm"): Promise<void> {
  const key = createHash("sha256")
    .update(source)
    .update(backend)
    .update(sanitize ? "san" : "plain")
    .digest("hex")
    .slice(0, 16);
  const outDir = join(cacheDir, key);
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${name}.ts`);
  writeFileSync(file, source);
  const result = await compile(file, {
    outPath: join(outDir, "program"),
    outDir,
    sanitize,
    backend,
  });
  if (!result.ok) {
    throw new Error(
      "unknown-fields program failed to compile:\n" +
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

const source = `class Base {
  inherited: unknown;
}

class Holder extends Base {
  value: unknown;
  initialized: unknown = { count: 3 };
  static current: unknown = "ready";

  constructor(public argument: unknown) {
    super();
  }
}

const h = new Holder(42);
console.log(h.inherited === undefined);
h.inherited = "from base";
console.log(h.inherited === "from base");
console.log(h.value === undefined, h.argument === 42);
if (typeof h.initialized === "object" && h.initialized !== null && "count" in h.initialized) {
  console.log((h.initialized as { count: number }).count);
}
console.log(typeof Holder.current, Holder.current);
h.value = ["a", "b"];
if (Array.isArray(h.value)) console.log(h.value.length, h.value[1]);
Holder.current = false;
console.log(Holder.current === false);
`;

describe.each(["c", "llvm"] as const)(
  `unknown-typed class fields, %s backend${sanitize ? " (sanitized)" : ""}`,
  (backend) => {
    test("matches Node", async () => {
      await compileAndCompare(`${backend}-backend`, source, backend);
    });
  },
);
