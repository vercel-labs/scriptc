import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { nativeCodegenTarget, nativeHelperForTarget } from "../src/backend/targets.js";

const execFileAsync = promisify(execFile);
const target = nativeCodegenTarget();
const helperSpec = target === null ? null : nativeHelperForTarget(target);
const helper = (() => {
  if (helperSpec === null || process.platform === "win32") return null;
  try {
    const packageJson = createRequire(import.meta.url).resolve(
      `${helperSpec.packageName}/package.json`,
    );
    return join(dirname(packageJson), "bin", "scriptc-llvm-codegen");
  } catch {
    return null;
  }
})();
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A module whose constructor sets the value main returns. Functions after
 * the constructor give split code generation and partitions something to
 * divide. */
function program(): string {
  const lines = [
    "@value = internal global i32 0",
    "@llvm.global_ctors = appending global [1 x { i32, ptr, ptr }] [{ i32, ptr, ptr } { i32 65535, ptr @init, ptr null }]",
    "define internal void @init() {",
    // Volatile, so the optimizer cannot evaluate the constructor at compile time.
    "  store volatile i32 42, ptr @value",
    "  ret void",
    "}",
  ];
  for (let index = 0; index < 8; index++)
    lines.push(
      `define internal i32 @step${index}(i32 %v) noinline {`,
      `  %r = add i32 %v, ${index}`,
      "  ret i32 %r",
      "}",
    );
  lines.push(
    "define i32 @main() {",
    "  %value = load i32, ptr @value",
    ...Array.from({ length: 8 }, (_, index) => `  %s${index} = call i32 @step${index}(i32 0)`),
    "  ret i32 %value",
    "}",
  );
  return lines.join("\n") + "\n";
}

/** The objects' section names, on ELF targets (null elsewhere). */
async function sectionNames(objects: string[]): Promise<string[] | null> {
  if (process.platform !== "linux") return null;
  const names: string[] = [];
  for (const object of objects) {
    const { stdout } = await execFileAsync("readelf", ["-S", "-W", object]);
    for (const match of stdout.matchAll(/^\s*\[\s*\d+\]\s+(\S+)/gm)) names.push(match[1]!);
  }
  return names;
}

/** Links with lld when the C compiler driver can use it, as scriptc's Linux
 * links do: unlike the BFD linker's default script, lld does not run .ctors
 * entries from .init_array. */
async function link(objects: string[], executable: string): Promise<void> {
  const cc = process.env["CC"] ?? "cc";
  try {
    await execFileAsync(cc, ["-fuse-ld=lld", ...objects, "-o", executable]);
  } catch {
    await execFileAsync(cc, [...objects, "-o", executable]);
  }
}

async function exitCode(options: {
  outputs: number;
  split?: boolean;
  name: string;
}): Promise<{ code: number; sections: string[] | null }> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-constructors-"));
  dirs.push(dir);
  const input = join(dir, `${options.name}.ll`);
  await writeFile(input, program());
  const outputs = Array.from({ length: options.outputs }, (_, index) =>
    join(dir, `${options.name}.${index}.o`),
  );
  await execFileAsync(helper!, [
    "emit",
    "--input",
    input,
    ...outputs.flatMap((output) => ["--output", output]),
    "--filetype",
    "obj",
    "--target",
    target!.llvmTriple,
    "--opt-level",
    "2",
    "--relocation-model",
    "pic",
    "--diagnostic-format",
    "json",
    "--source-path",
    "/src/program.ts",
    ...(options.split === true ? ["--split", "codegen"] : []),
  ]);
  const sections = await sectionNames(outputs);
  const executable = join(dir, options.name);
  await link(outputs, executable);
  try {
    await execFileAsync(executable, []);
    return { code: 0, sections };
  } catch (error) {
    return { code: (error as { code: number }).code, sections };
  }
}

/** The constructor ran, and on ELF it is in .init_array, never .ctors. */
function expectConstructorRan(result: { code: number; sections: string[] | null }): void {
  expect(result.code).toBe(42);
  if (result.sections === null) return;
  expect(result.sections).toContain(".init_array");
  expect(result.sections).not.toContain(".ctors");
}

describe.runIf(helper !== null)("program constructors", () => {
  test("a constructor runs before main in a single object", async () => {
    expectConstructorRan(await exitCode({ outputs: 1, name: "single" }));
  });

  test("a constructor runs before main with split code generation", async () => {
    expectConstructorRan(await exitCode({ outputs: 3, split: true, name: "split" }));
  });

  test("a constructor runs before main across program partitions", async () => {
    expectConstructorRan(await exitCode({ outputs: 3, name: "partitions" }));
  });
});
