import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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

/** A module with generated dynamic-dispatch helpers (`%dyn.class.*` is what
 * the emitter names them). `sc_f__x25_dyn_class_probe` branches on 7 and must
 * return 10; each `sc_f__x25_dyn_class_big<N>` is past `--dispatch-opt
 * light`'s 512-instruction threshold and must return 601 for 1. Main exits 42
 * only if all of them hold, so every mode's machine code has to compute them
 * correctly. `bigCount` also spreads a module evenly over several partitions,
 * so a divided build does not fall back to whole-module optimization. */
function program(bigCount = 1): string {
  const steps = 600;
  const big: string[] = [];
  for (let index = 0; index < bigCount; index++)
    big.push(
      `define internal i64 @sc_f__x25_dyn_class_big${index}(i64 %value) {`,
      "entry:",
      "  %v0 = add i64 %value, 0",
      ...Array.from({ length: steps }, (_, step) => `  %v${step + 1} = add i64 %v${step}, 1`),
      `  ret i64 %v${steps}`,
      "}",
      "",
    );
  const calls: string[] = [];
  let ok = "%probeOk";
  for (let index = 0; index < bigCount; index++) {
    calls.push(
      `  %big${index} = call i64 @sc_f__x25_dyn_class_big${index}(i64 1)`,
      `  %bigOk${index} = icmp eq i64 %big${index}, 601`,
    );
    const next = index === bigCount - 1 ? "%ok" : `%ok${index}`;
    calls.push(`  ${next} = and i1 ${ok}, %bigOk${index}`);
    ok = next;
  }
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
${calls.join("\n")}
  %exit = select i1 ${ok}, i32 42, i32 1
  ret i32 %exit
}
`;
}

/** A divided program with no generated dispatch helper: four balanced
 * partitions that go through the helper's partition cache, so a test can see
 * whether a second build reused the first one's summary bitcode. */
function cacheProgram(): string {
  const lines = [
    "; partitioned program",
    "%Pair = type { i64, i64 }",
    "@total = internal global i64 0",
    "@pair = internal global %Pair { i64 3, i64 4 }",
    "define internal void @bump(i64 %value) {",
    "  %old = load i64, ptr @total",
    "  %new = add i64 %old, %value",
    "  store i64 %new, ptr @total",
    "  ret void",
    "}",
  ];
  for (let index = 0; index < 24; index++)
    lines.push(
      `define internal void @step${index}(i64 %value) noinline {`,
      `  %scaled = mul i64 %value, ${index}`,
      "  call void @bump(i64 %scaled)",
      ...(index + 1 < 24 ? [`  call void @step${index + 1}(i64 %value)`] : []),
      "  ret void",
      "}",
    );
  lines.push(
    "define i32 @main() {",
    "  %second = load i64, ptr @pair",
    "  call void @step0(i64 %second)",
    ...Array.from({ length: 23 }, (_, index) => `  call void @step${index + 1}(i64 1)`),
    "  %total = load i64, ptr @total",
    "  %low = urem i64 %total, 251",
    "  %code = trunc i64 %low to i32",
    "  ret i32 %code",
    "}",
  );
  return lines.join("\n") + "\n";
}

async function emit(
  dir: string,
  options: {
    outputs: number;
    name: string;
    dispatchOpt?: string;
    cache?: string;
    bigCount?: number;
    source?: string;
  },
): Promise<string[]> {
  const input = join(dir, `${options.name}.ll`);
  await writeFile(input, options.source ?? program(options.bigCount));
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
    ...(options.cache === undefined ? [] : ["--cache-dir", options.cache]),
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
        const objects = await emit(dir, {
          outputs,
          name: `${dispatchOpt}-${outputs}`,
          dispatchOpt,
        });
        expect(await exitCode(dir, objects, `${dispatchOpt}-${outputs}`)).toBe(42);
      }
    });
  }

  test("a reused partition cache keeps the two dispatch levels apart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-dispatch-cache-"));
    dirs.push(dir);
    const cache = join(dir, "cache");
    const summaries = async (): Promise<number> =>
      (await readdir(cache, { recursive: true }).catch(() => [] as string[])).filter((name) =>
        String(name).endsWith(".bc"),
      ).length;
    // The first build fills the partition cache at the program's own level;
    // the second asks for the cheap level with the same cache directory. A
    // cache keyed without the level would hand the second build the first
    // one's summary bitcode and store nothing of its own.
    const plain = await emit(dir, {
      outputs: 4,
      name: "plain",
      dispatchOpt: "off",
      cache,
      source: cacheProgram(),
    });
    const cached = await summaries();
    expect(cached).toBeGreaterThan(0);
    const light = await emit(dir, {
      outputs: 4,
      name: "light",
      dispatchOpt: "light",
      cache,
      source: cacheProgram(),
    });
    expect(await summaries()).toBeGreaterThan(cached);
    // Both levels still produce a program that runs the same way.
    expect(await exitCode(dir, light, "light-binary")).toBe(
      await exitCode(dir, plain, "plain-binary"),
    );
  });

  test("an unknown --dispatch-opt value is an invalid invocation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-dispatch-invalid-"));
    dirs.push(dir);
    await expect(emit(dir, { outputs: 1, name: "bad", dispatchOpt: "fast" })).rejects.toThrow();
  });
});
