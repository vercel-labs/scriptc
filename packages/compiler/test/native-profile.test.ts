import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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

/** clang links the LLVM profile runtime into instrumented executables; hosts
 * without it (the no-clang lanes) skip the cases that run one. */
const profileLinker = await (async () => {
  if (helper === null) return null;
  const dir = await mkdtemp(join(tmpdir(), "scriptc-profile-probe-"));
  try {
    await writeFile(join(dir, "probe.c"), "int main(void) { return 0; }\n");
    await execFileAsync("clang", [
      "-fprofile-generate",
      join(dir, "probe.c"),
      "-o",
      join(dir, "probe"),
    ]);
    return "clang";
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
})();

const FUNCTIONS = 12;

/** A program whose functions branch on their argument's parity, so a profile
 * records which side each takes. `edit` changes one function's constant. */
function program(edit = 0): string {
  const lines = ["; profiled program"];
  for (let index = 0; index < FUNCTIONS; index++) {
    const factor = index === 4 ? index + 3 + edit : index + 3;
    lines.push(
      `define internal i64 @f${index}(i64 %n) noinline {`,
      "entry:",
      "  %bit = and i64 %n, 1",
      "  %odd = icmp ne i64 %bit, 0",
      "  br i1 %odd, label %scaled, label %shifted",
      "scaled:",
      `  %product = mul i64 %n, ${factor}`,
      "  br label %done",
      "shifted:",
      `  %sum = add i64 %n, ${index}`,
      "  br label %done",
      "done:",
      "  %result = phi i64 [ %product, %scaled ], [ %sum, %shifted ]",
      "  ret i64 %result",
      "}",
    );
  }
  lines.push(
    "define i32 @main(i32 %argc, ptr %argv) {",
    "entry:",
    "  %wide = sext i32 %argc to i64",
    "  %limit = mul i64 %wide, 100",
    "  br label %loop",
    "loop:",
    "  %i = phi i64 [ 0, %entry ], [ %next, %loop ]",
    "  %total = phi i64 [ 0, %entry ], [ %grown, %loop ]",
    ...Array.from({ length: FUNCTIONS }, (_, index) => [
      `  %v${index} = call i64 @f${index}(i64 %i)`,
      `  %t${index} = add i64 ${index === 0 ? "%total" : `%t${index - 1}`}, %v${index}`,
    ]).flat(),
    `  %grown = add i64 %t${FUNCTIONS - 1}, 0`,
    "  %next = add i64 %i, 1",
    "  %again = icmp ult i64 %next, %limit",
    "  br i1 %again, label %loop, label %exit",
    "exit:",
    "  %low = urem i64 %grown, 251",
    "  %code = trunc i64 %low to i32",
    "  ret i32 %code",
    "}",
  );
  return lines.join("\n") + "\n";
}

function expectedExit(argc: number, edit = 0): number {
  let total = 0n;
  for (let i = 0n; i < BigInt(argc * 100); i++)
    for (let index = 0; index < FUNCTIONS; index++) {
      const factor = BigInt(index === 4 ? index + 3 + edit : index + 3);
      total += i % 2n === 1n ? i * factor : i + BigInt(index);
    }
  return Number(total % 251n);
}

const INLINED = 6;

/** A program whose helpers are too large for the inliner that runs before the
 * profile annotation and each called twice, so they reach the annotation,
 * and which the profile-guided inliner then inlines into their hot call
 * sites in `main` and deletes. */
function inlinedProgram(): string {
  const lines = ["; profiled program, helpers inlined after annotation"];
  for (let index = 0; index < INLINED; index++) {
    lines.push(
      `define internal i64 @g${index}(i64 %n) {`,
      "entry:",
      "  %x0 = add i64 %n, " + index,
    );
    for (let step = 1; step <= 40; step++)
      lines.push(`  %x${step} = ${step % 2 === 0 ? "xor" : "mul"} i64 %x${step - 1}, ${step + 3}`);
    lines.push("  ret i64 %x40", "}");
  }
  lines.push(
    "define i32 @main(i32 %argc, ptr %argv) {",
    "entry:",
    "  %wide = sext i32 %argc to i64",
    "  %limit = mul i64 %wide, 1000",
    "  br label %loop",
    "loop:",
    "  %i = phi i64 [ 0, %entry ], [ %next, %loop ]",
    "  %total = phi i64 [ 0, %entry ], [ %grown, %loop ]",
    ...Array.from({ length: INLINED }, (_, index) => [
      `  %a${index} = call i64 @g${index}(i64 %i)`,
      `  %b${index} = call i64 @g${index}(i64 %a${index})`,
      `  %t${index} = add i64 ${index === 0 ? "%total" : `%t${index - 1}`}, %b${index}`,
    ]).flat(),
    `  %grown = add i64 %t${INLINED - 1}, 0`,
    "  %next = add i64 %i, 1",
    "  %again = icmp ult i64 %next, %limit",
    "  br i1 %again, label %loop, label %exit",
    "exit:",
    "  %low = urem i64 %grown, 251",
    "  %code = trunc i64 %low to i32",
    "  ret i32 %code",
    "}",
  );
  return lines.join("\n") + "\n";
}

function inlinedExit(argc: number): number {
  const mask = (1n << 64n) - 1n;
  const g = (index: number, n: bigint) => {
    let x = (n + BigInt(index)) & mask;
    for (let step = 1; step <= 40; step++)
      x = step % 2 === 0 ? x ^ BigInt(step + 3) : (x * BigInt(step + 3)) & mask;
    return x;
  };
  let total = 0n;
  for (let i = 0n; i < BigInt(argc * 1000); i++)
    for (let index = 0; index < INLINED; index++) total = (total + g(index, g(index, i))) & mask;
  return Number(total % 251n);
}

type EmitOptions = {
  outputs: number;
  name: string;
  generate?: string;
  use?: string;
  cache?: string;
};

async function emit(dir: string, source: string, options: EmitOptions): Promise<string[]> {
  return (await emitReporting(dir, source, options)).outputs;
}

/** `emit`, also returning the helper's stdout (its profile match report). */
async function emitReporting(dir: string, source: string, options: EmitOptions) {
  const input = join(dir, `${options.name}.ll`);
  await writeFile(input, source);
  const outputs = Array.from({ length: options.outputs }, (_, index) =>
    join(dir, `${options.name}.${index}.o`),
  );
  const { stdout } = await execFileAsync(helper!, [
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
    ...(options.generate === undefined ? [] : ["--profile-generate", options.generate]),
    ...(options.use === undefined ? [] : ["--profile-use", options.use]),
    ...(options.cache === undefined ? [] : ["--cache-dir", options.cache]),
  ]);
  return { outputs, stdout };
}

async function link(dir: string, objects: string[], name: string, instrumented = false) {
  const executable = join(dir, name);
  await execFileAsync(instrumented ? profileLinker! : (process.env["CC"] ?? "cc"), [
    ...(instrumented ? ["-fprofile-generate"] : []),
    ...objects,
    "-o",
    executable,
  ]);
  return executable;
}

/** Runs the executable with `argc` arguments and returns its exit code. */
async function run(executable: string, argc: number, env: NodeJS.ProcessEnv = {}) {
  try {
    await execFileAsync(
      executable,
      Array.from({ length: argc - 1 }, () => "x"),
      {
        env: { ...process.env, ...env },
      },
    );
    return 0;
  } catch (error) {
    return (error as { code: number }).code;
  }
}

async function merge(output: string, inputs: string[]) {
  return execFileAsync(helper!, ["merge-profiles", "--output", output, ...inputs]);
}

/** An instrumented build of `source` run with 1 and 3 arguments, its raw
 * profiles merged into one indexed profile. */
async function collect(
  dir: string,
  source: string,
  outputs: number,
  name: string,
  expected: (argc: number) => number = expectedExit,
) {
  const raw = join(dir, `${name}-raw`);
  const objects = await emit(dir, source, { outputs, name, generate: join(raw, "%p.profraw") });
  const executable = await link(dir, objects, name, true);
  expect(await run(executable, 1)).toBe(expected(1));
  expect(await run(executable, 3)).toBe(expected(3));
  const profiles = (await readdir(raw)).map((file) => join(raw, file));
  expect(profiles).toHaveLength(2);
  const profile = join(dir, `${name}.profdata`);
  await merge(profile, profiles);
  return { profile, raws: profiles };
}

async function cacheEntries(cache: string): Promise<Set<string>> {
  const entries = new Set<string>();
  for (const bucket of await readdir(cache).catch(() => []))
    for (const name of await readdir(join(cache, bucket)).catch(() => [])) entries.add(name);
  return entries;
}

describe.runIf(helper !== null)("LLVM profile-guided optimization", () => {
  test("a profile and instrumentation together are a usage error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-profile-usage-"));
    dirs.push(dir);
    await expect(
      emit(dir, program(), {
        outputs: 1,
        name: "both",
        generate: join(dir, "%p.profraw"),
        use: join(dir, "missing.profdata"),
      }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining('"code":"usage"') });
  });

  test("merge-profiles reports an input that is not a profile", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-profile-merge-error-"));
    dirs.push(dir);
    await writeFile(join(dir, "not-a-profile"), "text\n");
    await expect(
      merge(join(dir, "out.profdata"), [join(dir, "not-a-profile")]),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("profile_read_failed") });
  });

  test("merge-profiles leaves a link at the old temporary path untouched", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-profile-merge-link-"));
    dirs.push(dir);
    const input = join(dir, "input.proftext");
    await writeFile(input, ":ir\nf0\n# Func Hash:\n1\n# Num Counters:\n1\n# Counter Values:\n3\n");
    const target = join(dir, "target");
    await writeFile(target, "unchanged\n");
    const output = join(dir, "out.profdata");
    await symlink(target, `${output}.tmp`);
    await merge(output, [input]);
    expect(await readFile(target, "utf8")).toBe("unchanged\n");
    expect((await lstat(`${output}.tmp`)).isSymbolicLink()).toBe(true);
    expect((await lstat(output)).isFile()).toBe(true);
    expect((await readFile(output)).subarray(0, 8)).toEqual(
      Buffer.from([0xff, 0x6c, 0x70, 0x72, 0x6f, 0x66, 0x69, 0x81]),
    );
    expect((await readdir(dir)).sort()).toEqual(
      ["input.proftext", "out.profdata", "out.profdata.tmp", "target"].sort(),
    );
  });

  describe.runIf(profileLinker !== null)("with the profile runtime", () => {
    for (const outputs of [1, 4]) {
      test(`${outputs === 1 ? "one module" : "partitions"}: the merged profile guides emission`, async () => {
        const dir = await mkdtemp(join(tmpdir(), "scriptc-profile-use-"));
        dirs.push(dir);
        const { profile } = await collect(dir, program(), outputs, "train");

        const objects = await emit(dir, program(), { outputs, name: "guided", use: profile });
        const executable = await link(dir, objects, "guided");
        expect(await run(executable, 2)).toBe(expectedExit(2));

        // The profile changes the generated code. Partitions each carry the
        // profile variables, and a build whose variables lost to the profile
        // runtime's defaults would record a profile emission cannot use.
        const plain = await emit(dir, program(), { outputs, name: "plain" });
        const control = await emit(dir, program(), { outputs, name: "control" });
        const bytes = (paths: string[]) => Promise.all(paths.map((path) => readFile(path)));
        expect(await bytes(control)).toEqual(await bytes(plain));
        expect(await bytes(objects)).not.toEqual(await bytes(plain));
      });
    }

    test("merge-profiles combines raw and indexed profiles", async () => {
      const dir = await mkdtemp(join(tmpdir(), "scriptc-profile-merge-"));
      dirs.push(dir);
      const { profile, raws } = await collect(dir, program(), 1, "train");
      const combined = join(dir, "combined.profdata");
      await merge(combined, [profile, raws[0]!]);
      const objects = await emit(dir, program(), { outputs: 1, name: "guided", use: combined });
      expect(await run(await link(dir, objects, "guided"), 1)).toBe(expectedExit(1));
    });

    test("a profile of an older program still builds the current one", async () => {
      const dir = await mkdtemp(join(tmpdir(), "scriptc-profile-stale-"));
      dirs.push(dir);
      const { profile } = await collect(dir, program(), 4, "train");
      // f4's constant changed since the profile was collected.
      const objects = await emit(dir, program(7), { outputs: 4, name: "edited", use: profile });
      expect(await run(await link(dir, objects, "edited"), 2)).toBe(expectedExit(2, 7));
    });

    test("the match report counts annotated functions that inlining removes", async () => {
      const dir = await mkdtemp(join(tmpdir(), "scriptc-profile-match-"));
      dirs.push(dir);
      const { profile } = await collect(dir, inlinedProgram(), 1, "train", inlinedExit);
      const { outputs, stdout } = await emitReporting(dir, inlinedProgram(), {
        outputs: 1,
        name: "guided",
        use: profile,
      });
      expect(await run(await link(dir, outputs, "guided"), 2)).toBe(inlinedExit(2));
      // Every g<index> and main received counts, though optimization then
      // inlined the helpers into main and deleted them.
      expect(JSON.parse(stdout.trim().split("\n").at(-1)!)).toEqual({
        ok: true,
        profile: { annotated: INLINED + 1, mismatched: 0, missing: 0, unknown_partitions: 0 },
      });
      const symbols = await execFileAsync("nm", [outputs[0]!]);
      expect(symbols.stdout).not.toMatch(/\bg\d\b/);
    });

    test("the profile keys the partition cache", async () => {
      const dir = await mkdtemp(join(tmpdir(), "scriptc-profile-cache-"));
      dirs.push(dir);
      const { profile } = await collect(dir, program(), 4, "train");
      const cache = join(dir, "cache");
      await emit(dir, program(), { outputs: 4, name: "plain", cache });
      const plain = await cacheEntries(cache);
      await emit(dir, program(), { outputs: 4, name: "guided", cache, use: profile });
      const guided = await cacheEntries(cache);
      expect(guided.size).toBeGreaterThan(plain.size);
      // The same profile again reuses every partition.
      await emit(dir, program(), { outputs: 4, name: "again", cache, use: profile });
      expect(await cacheEntries(cache)).toEqual(guided);
    });
  });
});
