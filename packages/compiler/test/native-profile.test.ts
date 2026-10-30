import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { nativeCodegenTarget, nativeHelperForTarget } from "../src/backend/targets.js";

const execFileAsync = promisify(execFile);
const isElf = (object: Buffer) => object.subarray(0, 4).equals(Buffer.from("\x7fELF", "latin1"));
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
 * records which side each takes. `edit` changes one function's constant.
 * `branch` adds a branch to the same function, which changes its control
 * flow without changing its result. */
function program(edit = 0, branch = false): string {
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
      ...(branch && index === 4
        ? [
            "  %large = icmp ugt i64 %n, 150",
            "  br i1 %large, label %large.sum, label %small.sum",
            "large.sum:",
            "  %offset = call i64 @offset(i64 %n)",
            "  %sum.large = add i64 %offset, " + index,
            "  br label %done",
            "small.sum:",
            `  %sum.small = add i64 %n, ${index}`,
            "  br label %done",
            "done:",
            "  %result = phi i64 [ %product, %scaled ], [ %sum.large, %large.sum ], [ %sum.small, %small.sum ]",
          ]
        : [
            `  %sum = add i64 %n, ${index}`,
            "  br label %done",
            "done:",
            "  %result = phi i64 [ %product, %scaled ], [ %sum, %shifted ]",
          ]),
      "  ret i64 %result",
      "}",
    );
  }
  if (branch)
    lines.push("define internal i64 @offset(i64 %n) noinline {", "entry:", "  ret i64 %n", "}");
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

/** A program whose `rare` runs only with more than ten arguments, which
 * training never passes; `added` (with `extra`) is defined after the
 * profile was collected. */
function rareProgram(extra = false): string {
  const lines = ["; profiled program with a function training never runs"];
  const helpers: [string, number][] = [
    ["hot", 5],
    ["rare", 9],
    ...(extra ? [["added", 11]] : []),
  ] as [string, number][];
  for (const [name, factor] of helpers)
    lines.push(
      `define internal i64 @${name}(i64 %n) noinline {`,
      "entry:",
      `  %m = mul i64 %n, ${factor}`,
      "  %bit = and i64 %m, 1",
      "  %odd = icmp ne i64 %bit, 0",
      "  br i1 %odd, label %a, label %b",
      "a:",
      `  %x = add i64 %m, ${factor}`,
      "  br label %c",
      "b:",
      "  %y = sub i64 %m, 1",
      "  br label %c",
      "c:",
      "  %r = phi i64 [ %x, %a ], [ %y, %b ]",
      "  ret i64 %r",
      "}",
    );
  lines.push(
    "define i32 @main(i32 %argc, ptr %argv) {",
    "entry:",
    "  %w = sext i32 %argc to i64",
    "  %h = call i64 @hot(i64 %w)",
    "  %many = icmp ugt i32 %argc, 10",
    "  br i1 %many, label %rare.call, label %done",
    "rare.call:",
    "  %r = call i64 @rare(i64 %h)",
    ...(extra ? ["  %e = call i64 @added(i64 %r)"] : []),
    "  br label %done",
    "done:",
    `  %v = phi i64 [ %h, %entry ], [ ${extra ? "%e" : "%r"}, %rare.call ]`,
    "  %low = and i64 %v, 127",
    "  %code = trunc i64 %low to i32",
    "  ret i32 %code",
    "}",
  );
  return lines.join("\n") + "\n";
}

function rareExit(argc: number): number {
  const step = (n: number, factor: number) => {
    const m = n * factor;
    return m % 2 === 1 ? m + factor : m - 1;
  };
  let v = step(argc, 5);
  if (argc > 10) v = step(v, 9);
  return v & 127;
}

/** The target writes ELF objects. */
const elfTarget = target !== null && !/apple|darwin|windows|mingw/.test(target.llvmTriple);

/** The section that holds `name` in an object file. */
async function sectionOf(object: string, name: string): Promise<string | undefined> {
  const { stdout } = await execFileAsync("objdump", ["-t", object]);
  return stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find((fields) => fields.at(-1) === name)
    ?.at(-3);
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
  blocks?: string;
  record?: string;
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
    ...(options.blocks === undefined ? [] : ["--profile-blocks", options.blocks]),
    ...(options.record === undefined ? [] : ["--record-profile-blocks", options.record]),
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

async function merge(output: string, inputs: string[], sparse = false) {
  return execFileAsync(helper!, [
    "merge-profiles",
    "--output",
    output,
    ...(sparse ? ["--sparse"] : []),
    ...inputs,
  ]);
}

/** An instrumented build of `source` run with 1 and 3 arguments, its raw
 * profiles merged into one indexed profile. */
async function collect(
  dir: string,
  source: string,
  outputs: number,
  name: string,
  expected: (argc: number) => number = expectedExit,
  sparse = false,
) {
  const raw = join(dir, `${name}-raw`);
  const objects = await emit(dir, source, { outputs, name, generate: join(raw, "%p.profraw") });
  const executable = await link(dir, objects, name, true);
  expect(await run(executable, 1)).toBe(expected(1));
  expect(await run(executable, 3)).toBe(expected(3));
  const profiles = (await readdir(raw)).map((file) => join(raw, file));
  expect(profiles).toHaveLength(2);
  const profile = join(dir, `${name}.profdata`);
  await merge(profile, profiles, sparse);
  return { profile, raws: profiles };
}

async function cacheEntries(cache: string): Promise<Set<string>> {
  const entries = new Set<string>();
  for (const bucket of await readdir(cache).catch(() => []))
    for (const name of await readdir(join(cache, bucket)).catch(() => [])) entries.add(name);
  return entries;
}

describe.runIf(helper !== null)("LLVM profile-guided optimization", () => {
  test.runIf(profileLinker !== null)(
    "a second phase records context-sensitive counts that lay out the code",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "scriptc-profile-context-"));
      dirs.push(dir);
      const first = await collect(dir, inlinedProgram(), 2, "first", inlinedExit);
      // The second phase: optimized by the first profile, instrumented after inlining.
      const raw = join(dir, "context-raw");
      const instrumented = await emit(dir, inlinedProgram(), {
        outputs: 2,
        name: "context",
        generate: join(raw, "%p.profraw"),
        use: first.profile,
      });
      const executable = await link(dir, instrumented, "context", true);
      expect(await run(executable, 1)).toBe(inlinedExit(1));
      expect(await run(executable, 3)).toBe(inlinedExit(3));
      const raws = (await readdir(raw)).map((file) => join(raw, file));
      expect(raws).toHaveLength(2);
      const merged = join(dir, "context.profdata");
      await merge(merged, [first.profile, ...raws]);
      // VARIANT_MASK_CSIR_PROF, bit 57 of the header's version word.
      expect((await readFile(merged))[15]! & 0x02).toBe(0x02);
      expect((await readFile(first.profile))[15]! & 0x02).toBe(0);
      // A build with the merged profile gives every function its own section.
      const objects = await emit(dir, inlinedProgram(), {
        outputs: 2,
        name: "laidout",
        use: merged,
      });
      const bytes = Buffer.concat(await Promise.all(objects.map((object) => readFile(object))));
      // ELF objects name each function's section by its profile temperature;
      // Mach-O sections carry no such prefix.
      if (isElf(bytes)) expect(bytes.includes(".text.hot.main")).toBe(true);
      const optimized = await link(dir, objects, "laidout");
      expect(await run(optimized, 1)).toBe(inlinedExit(1));
      expect(await run(optimized, 3)).toBe(inlinedExit(3));
      // A profile that has context-sensitive counts cannot start another second phase.
      await expect(
        emit(dir, inlinedProgram(), {
          outputs: 1,
          name: "again",
          generate: join(dir, "again-raw", "%p.profraw"),
          use: merged,
        }),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("already holds context-sensitive counts"),
      });
    },
  );

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
    test("profiles name local functions after the entry's file name, not its directory", async () => {
      const dir = await mkdtemp(join(tmpdir(), "scriptc-profile-names-"));
      dirs.push(dir);
      const { profile } = await collect(dir, program(), 1, "names");
      const { stdout } = await execFileAsync(helper!, ["profile-functions", "--input", profile]);
      const { functions } = JSON.parse(stdout) as { functions: string[] };
      expect(functions.filter((name) => name.startsWith("program.ts;")).length).toBeGreaterThan(0);
      expect(functions.filter((name) => name.includes("/"))).toEqual([]);
    });

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

    test("the match report weighs the functions that changed by their counts", async () => {
      const dir = await mkdtemp(join(tmpdir(), "scriptc-profile-weights-"));
      dirs.push(dir);
      const { profile } = await collect(dir, program(), 1, "train");
      // f4 gained a branch, so the profile no longer describes it.
      const edited = program(0, true);
      const { outputs, stdout } = await emitReporting(dir, edited, {
        outputs: 1,
        name: "edited",
        use: profile,
      });
      expect(await run(await link(dir, outputs, "edited"), 2)).toBe(expectedExit(2));
      const { profile: match } = JSON.parse(stdout.trim().split("\n").at(-1)!) as {
        profile: Record<string, number>;
      };
      expect(match["mismatched"]).toBe(1);
      // main and the other f<index> keep their counts; f4's are reported apart.
      expect(match["mismatched_counts"]).toBeGreaterThan(0);
      expect(match["annotated_counts"]).toBeGreaterThan(match["mismatched_counts"]!);
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
      const report = JSON.parse(stdout.trim().split("\n").at(-1)!) as {
        ok: boolean;
        profile: Record<string, number>;
      };
      expect(report).toMatchObject({
        ok: true,
        profile: {
          annotated: INLINED + 1,
          mismatched: 0,
          missing: 0,
          recovered: 0,
          unknown_partitions: 0,
          mismatched_counts: 0,
        },
      });
      expect(report.profile["annotated_counts"]).toBeGreaterThan(0);
      const symbols = await execFileAsync("nm", [outputs[0]!]);
      expect(symbols.stdout).not.toMatch(/\bg\d\b/);
    });

    test("block counts annotate the functions whose control flow changed", async () => {
      const dir = await mkdtemp(join(tmpdir(), "scriptc-profile-blocks-"));
      dirs.push(dir);
      // External functions are placed by name, so the program is divided into
      // partitions that the cache keeps.
      const divided = (source: string) =>
        source.replaceAll("define internal i64 @f", "define i64 @f");
      const { profile } = await collect(dir, divided(program()), 4, "train");
      // A build with a warm partition cache still records every partition.
      const cache = join(dir, "cache");
      await emit(dir, divided(program()), { outputs: 4, name: "warm", cache, use: profile });
      const blocks = join(dir, "train.blocks");
      const recorded = await emitReporting(dir, divided(program()), {
        outputs: 4,
        name: "recorded",
        cache,
        use: profile,
        record: blocks,
      });
      const report = (stdout: string) => JSON.parse(stdout.trim().split("\n").at(-1)!).profile;
      expect(report(recorded.stdout)).toMatchObject({ annotated: FUNCTIONS + 1, recovered: 0 });
      const text = await readFile(blocks, "utf8");
      expect(text.split("\n")[0]).toBe("scriptc-profile-blocks 1");
      expect(text.match(/^f /gm)).toHaveLength(FUNCTIONS + 1);
      expect(text).toMatch(/^f f4 [1-9]\d* [1-9]\d*$/m);

      // f4 gained a branch, so the profile no longer describes it.
      const stale = await emitReporting(dir, divided(program(0, true)), {
        outputs: 4,
        name: "stale",
        use: profile,
      });
      expect(report(stale.stdout)).toMatchObject({ mismatched: 1, recovered: 0 });
      const recovered = await emitReporting(dir, divided(program(0, true)), {
        outputs: 4,
        name: "recovered",
        use: profile,
        blocks,
      });
      expect(report(recovered.stdout)).toMatchObject({
        annotated: FUNCTIONS + 1 - 1,
        mismatched: 1,
        recovered: 1,
      });
      expect(await run(await link(dir, recovered.outputs, "recovered"), 2)).toBe(expectedExit(2));
      // The recovered counts move f4 into the hot section. ELF objects name
      // it (.text.hot.); Mach-O sections carry no such prefix, so there the
      // two builds are the same.
      const bytes = (paths: string[]) => Promise.all(paths.map((path) => readFile(path)));
      const recoveredBytes = await bytes(recovered.outputs);
      if (isElf(recoveredBytes[0]!)) expect(recoveredBytes).not.toEqual(await bytes(stale.outputs));

      // The block counts key the partition cache.
      const before = await cacheEntries(cache);
      await emit(dir, divided(program()), {
        outputs: 4,
        name: "keyed",
        cache,
        use: profile,
        blocks,
      });
      expect((await cacheEntries(cache)).size).toBeGreaterThan(before.size);
    });

    test("one module counts a function that both annotations miss once", async () => {
      const dir = await mkdtemp(join(tmpdir(), "scriptc-profile-blocks-context-"));
      dirs.push(dir);
      const first = await collect(dir, program(), 1, "first");
      const raw = join(dir, "context-raw");
      const blocks = join(dir, "context.blocks");
      const instrumented = await emit(dir, program(), {
        outputs: 1,
        name: "context",
        generate: join(raw, "%p.profraw"),
        use: first.profile,
        record: blocks,
      });
      const executable = await link(dir, instrumented, "context", true);
      expect(await run(executable, 1)).toBe(expectedExit(1));
      const merged = join(dir, "context.profdata");
      await merge(merged, [first.profile, ...(await readdir(raw)).map((file) => join(raw, file))]);
      const report = (stdout: string) => JSON.parse(stdout.trim().split("\n").at(-1)!).profile;
      const stale = await emitReporting(dir, program(0, true), {
        outputs: 1,
        name: "stale",
        use: merged,
        blocks,
      });
      expect(report(stale.stdout)).toMatchObject({ mismatched: 1, recovered: 1 });
      expect(await run(await link(dir, stale.outputs, "stale"), 2)).toBe(expectedExit(2));
    });

    test("block counts annotate only the functions whose control flow changed", async () => {
      const dir = await mkdtemp(join(tmpdir(), "scriptc-profile-blocks-missing-"));
      dirs.push(dir);
      const { profile } = await collect(dir, program(), 1, "train");
      const blocks = join(dir, "train.blocks");
      await emit(dir, program(), { outputs: 1, name: "recorded", use: profile, record: blocks });
      // program(0, true) adds offset, which the profile has no record of; a
      // record for it in the block file is not used, so the recovered
      // functions stay among the mismatched ones.
      await writeFile(blocks, `${await readFile(blocks, "utf8")}f offset 1000 1\nentry 1000\n`);
      const { stdout } = await emitReporting(dir, program(0, true), {
        outputs: 1,
        name: "stale",
        use: profile,
        blocks,
      });
      expect(JSON.parse(stdout.trim().split("\n").at(-1)!).profile).toMatchObject({
        mismatched: 1,
        missing: 1,
        recovered: 1,
      });
    });

    test("block counts mark the functions a sparse profile never ran as cold", async () => {
      const dir = await mkdtemp(join(tmpdir(), "scriptc-profile-blocks-never-"));
      dirs.push(dir);
      const { profile } = await collect(dir, rareProgram(), 1, "train", rareExit, true);
      const blocks = join(dir, "train.blocks");
      await emit(dir, rareProgram(), {
        outputs: 1,
        name: "recorded",
        use: profile,
        record: blocks,
      });
      const text = await readFile(blocks, "utf8");
      expect(text).toMatch(/^f hot [1-9]\d* [1-9]\d*$/m);
      expect(text).toMatch(/^f rare 0 0$/m);

      // Without the block counts rare keeps no counts; with them it is cold
      // code. added, which the block counts do not name, keeps no counts.
      const [plain] = await emit(dir, rareProgram(), { outputs: 1, name: "plain", use: profile });
      const [marked] = await emit(dir, rareProgram(), {
        outputs: 1,
        name: "marked",
        use: profile,
        blocks,
      });
      expect(await readFile(marked!)).not.toEqual(await readFile(plain!));
      const [cold] = await emit(dir, rareProgram(true), {
        outputs: 1,
        name: "cold",
        use: profile,
        blocks,
      });
      // ELF objects name the sections of hot and unlikely code; Mach-O and
      // COFF objects keep every function in one text section.
      if (elfTarget) {
        expect(await sectionOf(plain!, "rare")).toBe(".text");
        expect(await sectionOf(cold!, "rare")).toMatch(/^\.text\.unlikely/);
        expect(await sectionOf(cold!, "added")).toBe(".text");
        expect(await sectionOf(cold!, "hot")).toMatch(/^\.text\.hot/);
      }
      expect(await run(await link(dir, [cold!], "cold"), 2)).toBe(rareExit(2));
    });

    test("block counts need a profile and a file that parses", async () => {
      const dir = await mkdtemp(join(tmpdir(), "scriptc-profile-blocks-error-"));
      dirs.push(dir);
      const blocks = join(dir, "bad.blocks");
      await writeFile(blocks, "scriptc-profile-blocks 1\nf f0 10\n");
      await expect(
        emit(dir, program(), { outputs: 1, name: "alone", blocks }),
      ).rejects.toMatchObject({ stderr: expect.stringContaining("invalid_profile_blocks") });
      const { profile } = await collect(dir, program(), 1, "train");
      await expect(
        emit(dir, program(), { outputs: 1, name: "bad", use: profile, blocks }),
      ).rejects.toMatchObject({ stderr: expect.stringContaining("profile_blocks_read_failed") });
    });

    test("the profile keys the partition cache", async () => {
      const dir = await mkdtemp(join(tmpdir(), "scriptc-profile-cache-"));
      dirs.push(dir);
      // External functions are placed by name, so the program is divided
      // instead of following main into one partition and being optimized
      // whole.
      const source = program().replaceAll("define internal i64 @f", "define i64 @f");
      const { profile } = await collect(dir, source, 4, "train");
      const cache = join(dir, "cache");
      await emit(dir, source, { outputs: 4, name: "plain", cache });
      const plain = await cacheEntries(cache);
      expect(plain.size).toBeGreaterThan(0);
      await emit(dir, source, { outputs: 4, name: "guided", cache, use: profile });
      const guided = await cacheEntries(cache);
      expect(guided.size).toBeGreaterThan(plain.size);
      // The same profile again reuses every partition.
      await emit(dir, source, { outputs: 4, name: "again", cache, use: profile });
      expect(await cacheEntries(cache)).toEqual(guided);
    });
  });
});
