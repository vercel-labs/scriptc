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

/** A module with two generated dynamic-dispatch helpers (`%dyn.class.*` is
 * what the emitter names them). The small one branches on 7 and must return
 * 10; the large one is past `--dispatch-opt light`'s 512-instruction
 * threshold and must return 601 for 1. Main exits 42 only if both hold, so
 * each mode's machine code has to compute both helpers correctly. */
function program(): string {
  const steps = 600;
  const big = [
    "define internal i64 @sc_f__x25_dyn_class_big(i64 %value) {",
    "entry:",
    "  %v0 = add i64 %value, 0",
    ...Array.from({ length: steps }, (_, index) => `  %v${index + 1} = add i64 %v${index}, 1`),
    `  ret i64 %v${steps}`,
    "}",
    "",
  ];
  return `; dispatch helpers
define internal i64 @sc_f__x25_dyn_class_probe(i64 %value) {
entry:
  %slot = alloca i64
  store i64 %value, ptr %slot
  %loaded = load i64, ptr %slot
  %cmp = icmp sgt i64 %loaded, 10
  br i1 %cmp, label %big, label %small
big:
  %doubled = mul i64 %loaded, 2
  br label %done
small:
  %added = add i64 %loaded, 3
  br label %done
done:
  %result = phi i64 [ %doubled, %big ], [ %added, %small ]
  ret i64 %result
}

${big.join("\n")}
define i32 @main() {
entry:
  %probe = call i64 @sc_f__x25_dyn_class_probe(i64 7)
  %probeOk = icmp eq i64 %probe, 10
  %big = call i64 @sc_f__x25_dyn_class_big(i64 1)
  %bigOk = icmp eq i64 %big, 601
  %ok = and i1 %probeOk, %bigOk
  %exit = select i1 %ok, i32 42, i32 1
  ret i32 %exit
}
`;
}

async function emit(
  dir: string,
  options: { outputs: number; name: string; dispatchOpt?: string },
): Promise<string[]> {
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
    ...(options.dispatchOpt === undefined ? [] : ["--dispatch-opt", options.dispatchOpt]),
  ]);
  return outputs;
}

async function exitCode(dir: string, objects: string[], name: string): Promise<number> {
  const executable = join(dir, name);
  await execFileAsync(process.env["CC"] ?? "cc", [...objects, "-o", executable]);
  try {
    await execFileAsync(executable, []);
    return 0;
  } catch (error) {
    return (error as { code?: number }).code ?? -1;
  }
}

describe.runIf(helper !== null)("generated dispatch helpers", () => {
  test("the helper advertises the dispatch-opt feature", async () => {
    const { stdout } = await execFileAsync(helper!, ["version", "--format=json"]);
    const version = JSON.parse(stdout) as { features?: string[] };
    expect(version.features).toContain("dispatch-opt");
  });

  for (const dispatchOpt of ["off", "light"] as const) {
    test(`--dispatch-opt ${dispatchOpt} compiles the helpers to the same behaviour`, async () => {
      const dir = await mkdtemp(join(tmpdir(), `scriptc-dispatch-${dispatchOpt}-`));
      dirs.push(dir);
      for (const outputs of [1, 2]) {
        const objects = await emit(dir, { outputs, name: `${dispatchOpt}-${outputs}`, dispatchOpt });
        expect(await exitCode(dir, objects, `${dispatchOpt}-${outputs}`)).toBe(42);
      }
    });
  }

  test("an unknown --dispatch-opt value is an invalid invocation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-dispatch-invalid-"));
    dirs.push(dir);
    await expect(emit(dir, { outputs: 1, name: "bad", dispatchOpt: "fast" })).rejects.toThrow();
  });
});
