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
    .update(`${backend}-${sanitize ? "san" : "plain"}`)
    .digest("hex")
    .slice(0, 16);
  const outDir = join(cacheDir, `union-receiver-${key}`);
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${name}.cjs`);
  writeFileSync(file, source);
  const result = await compile(file, {
    outPath: join(outDir, "program"),
    outDir,
    sanitize,
    dynamic: true,
    backend,
  });
  if (!result.ok) {
    throw new Error(
      "union-receiver program failed to compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  const [nodeResult, nativeResult] = await Promise.all([
    run("node", [file]),
    run(result.binaryPath, []),
  ]);
  expect(nativeResult.stdout).toEqual(nodeResult.stdout);
  expect(nativeResult.stderr).toEqual(nodeResult.stderr);
  expect(nativeResult.exitCode).toBe(nodeResult.exitCode);
}

const prelude = `// @ts-check
class A { value = "A"; }
class B { value = "B"; }
/** @typedef {A | B} Item */
const concrete = new A();
`;

describe.each(["c", "llvm"] as const)(
  `union receivers through dynamic calls, %s backend${sanitize ? " (sanitized)" : ""}`,
  (backend) => {
    test("preserves a concrete class receiver in a dyn object-literal argument", async () => {
      await compileAndCompare(
      "dyn-object-arg",
      `${prelude}
const dyn = JSON.parse('{"values":[]}');
dyn.values.push({ value: /** @type {Item} */ (concrete).value });
console.log(dyn.values[0].value);
`,
        backend,
      );
    });

    test("covers direct dyn-call arguments and optional property access", async () => {
      await compileAndCompare(
      "dyn-call-variants",
      `${prelude}
const dyn = JSON.parse('{"values":[]}');
dyn.values.push(/** @type {Item} */ (concrete).value);
dyn.values.push({
  direct: /** @type {Item} */ (concrete).value,
  optional: /** @type {Item} */ (concrete)?.value,
});
console.log(dyn.values[0], dyn.values[1].direct, dyn.values[1].optional);
`,
        backend,
      );
    });
  },
);
