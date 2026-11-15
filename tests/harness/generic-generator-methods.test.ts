import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);

// Generic generator methods compile (tests/corpus/998x-generic-generator-
// methods-*). An async generator has no checked-dynamic form, so a generic
// ASYNC generator method called by name (through an untyped value, or an
// interface whose receiver's class the build does not know) keeps the
// run-time fence generic members have, instead of answering a value that
// can neither be iterated nor checked back into its type.
async function run(source: string): Promise<{ stdout: string; stderr: string; code: number }> {
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-generic-generator-methods-"));
  const entry = join(outDir, "main.ts");
  writeFileSync(entry, source);
  const result = await compile(entry, {
    backend: "llvm",
    sanitize: process.env["SCRIPTC_SAN"] === "1",
    outDir,
    outPath: join(outDir, "program"),
  });
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
  if (!result.ok) return { stdout: "", stderr: "", code: -1 };
  try {
    const { stdout, stderr } = await execFileAsync(result.binaryPath, [], { encoding: "utf8" });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failed.stdout ?? "", stderr: failed.stderr ?? "", code: failed.code ?? -1 };
  }
}

test("a generic async generator method called by name throws the coded refusal", async () => {
  const { stdout, stderr, code } = await run(`
interface Reader { chunks<T>(wrap: (index: number) => T): AsyncGenerator<T>; }
class Tape implements Reader {
  length = 2;
  async *chunks<T>(wrap: (index: number) => T): AsyncGenerator<T> {
    for (let index = 0; index < this.length; index++) yield wrap(index);
  }
}
const tape = new Tape();
const direct: string[] = [];
for await (const chunk of tape.chunks((index) => "c" + index)) direct.push(chunk);
console.log(direct.join(","));
const reader: Reader = tape;
try {
  for await (const chunk of reader.chunks((index) => index * 2)) console.log(chunk);
} catch (error) {
  console.log("threw", (error as Error).message, (error as { code?: string }).code);
}
`);
  expect(stdout).toBe(
    "c0,c1\nthrew calling 'chunks' on this native class through an untyped value is not supported yet SC2020\n",
  );
  expect(stderr).toBe("");
  expect(code).toBe(0);
});
