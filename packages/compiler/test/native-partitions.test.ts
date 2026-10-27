import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

/** A program whose internal functions, constants and state must stay
 * reachable across partitions. `edit` changes one function's addend. */
function program(edit = 0, extra = "", count = 24): string {
  const lines = [
    "; partitioned program",
    "%Pair = type { i64, i64 }",
    "@total = internal global i64 0",
    "@pair = internal global %Pair { i64 3, i64 4 }",
    '@label = private unnamed_addr constant [6 x i8] c"total\\00"',
    "declare i64 @strlen(ptr)",
    extra,
    "define internal void @bump(i64 %value) {",
    "  %old = load i64, ptr @total",
    "  %new = add i64 %old, %value",
    "  store i64 %new, ptr @total",
    "  ret void",
    "}",
  ];
  for (let index = 0; index < count; index++) {
    const addend = index === 5 ? index + edit : index;
    lines.push(
      `define internal void @step${index}(i64 %value) noinline {`,
      `  %scaled = mul i64 %value, ${addend}`,
      `  call void @bump(i64 %scaled)`,
      ...(index + 1 < count ? [`  call void @step${index + 1}(i64 %value)`] : []),
      "  ret void",
      "}",
    );
  }
  lines.push(
    "define i32 @main() {",
    "  %second = load i64, ptr getelementptr (%Pair, ptr @pair, i32 0, i32 1)",
    "  call void @step0(i64 %second)",
    // A second caller for every step keeps the steps in separate partitions.
    ...Array.from({ length: count - 1 }, (_, index) => `  call void @step${index + 1}(i64 1)`),
    "  %length = call i64 @strlen(ptr @label)",
    "  call void @bump(i64 %length)",
    "  %total = load i64, ptr @total",
    "  %low = urem i64 %total, 251",
    "  %code = trunc i64 %low to i32",
    "  ret i32 %code",
    "}",
  );
  return lines.join("\n") + "\n";
}

function expectedExit(edit = 0, count = 24): number {
  const addends = Array.from({ length: count }, (_, index) => (index === 5 ? index + edit : index));
  let total = 5; // strlen("total")
  for (let start = 0; start < count; start++)
    for (let index = start; index < count; index++)
      total += (start === 0 ? 4 : 1) * addends[index]!;
  return total % 251;
}

async function emit(
  dir: string,
  source: string,
  options: {
    outputs: number;
    optLevel: "0" | "2";
    cache?: string;
    split?: boolean;
    name: string;
  },
): Promise<string[]> {
  const input = join(dir, `${options.name}.ll`);
  await writeFile(input, source);
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
    options.optLevel,
    "--relocation-model",
    "pic",
    "--diagnostic-format",
    "json",
    "--source-path",
    "/src/program.ts",
    ...(options.cache === undefined ? [] : ["--cache-dir", options.cache]),
    ...(options.split === true ? ["--split", "codegen"] : []),
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
    return (error as { code: number }).code;
  }
}

async function cacheEntries(cache: string, suffix: string): Promise<Set<string>> {
  const entries = new Set<string>();
  for (const bucket of await readdir(cache).catch(() => [])) {
    for (const name of await readdir(join(cache, bucket)).catch(() => []))
      if (name.endsWith(suffix)) entries.add(name);
  }
  return entries;
}

describe.runIf(helper !== null)("LLVM program partitions", () => {
  for (const optLevel of ["2", "0"] as const) {
    test(`opt-level ${optLevel} partitions link deterministically and reuse unchanged partitions`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "scriptc-partitions-"));
      dirs.push(dir);
      const cache = join(dir, "cache");
      const first = await emit(dir, program(), { outputs: 4, optLevel, cache, name: "first" });
      const whole = await emit(dir, program(), { outputs: 1, optLevel, name: "whole" });
      expect(await exitCode(dir, first, "first")).toBe(expectedExit());
      expect(await exitCode(dir, whole, "whole")).toBe(expectedExit());

      // The same module always yields the same objects, with or without reuse.
      const fresh = await emit(dir, program(), { outputs: 4, optLevel, name: "fresh" });
      const reused = await emit(dir, program(), { outputs: 4, optLevel, cache, name: "reused" });
      const contents = (paths: string[]) => Promise.all(paths.map((path) => readFile(path)));
      expect(await contents(fresh)).toEqual(await contents(first));
      expect(await contents(reused)).toEqual(await contents(first));

      // An edit to one function changes one partition's source; the rest
      // are reused.
      const sources = await cacheEntries(cache, optLevel === "0" ? ".o" : ".bc");
      const edited = await emit(dir, program(7), { outputs: 4, optLevel, cache, name: "edited" });
      const after = await cacheEntries(cache, optLevel === "0" ? ".o" : ".bc");
      expect([...after].filter((entry) => !sources.has(entry))).toHaveLength(1);
      expect(await exitCode(dir, edited, "edited")).toBe(expectedExit(7));
    });
  }

  test("split code generation links deterministically and defines every function once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-split-codegen-"));
    dirs.push(dir);
    const parts = await emit(dir, program(), {
      outputs: 3,
      optLevel: "2",
      split: true,
      name: "split",
    });
    expect(await exitCode(dir, parts, "split")).toBe(expectedExit());
    const again = await emit(dir, program(), {
      outputs: 3,
      optLevel: "2",
      split: true,
      name: "again",
    });
    const contents = (paths: string[]) => Promise.all(paths.map((path) => readFile(path)));
    expect(await contents(again)).toEqual(await contents(parts));

    // The module is optimized whole, so the parts define the same functions as
    // a single object, each in one part.
    const defined = async (object: string) => {
      const { stdout } = await execFileAsync("nm", ["--defined-only", object]);
      return stdout
        .split("\n")
        .map((line) => /^[0-9a-fA-F]+ [Tt] _?(\w+)$/.exec(line.trim())?.[1])
        .filter((name): name is string => name !== undefined);
    };
    const whole = await defined(
      (await emit(dir, program(), { outputs: 1, optLevel: "2", name: "whole" }))[0]!,
    );
    const split = await Promise.all(parts.map(defined));
    expect(split.flat().sort()).toEqual([...whole].sort());
    for (const names of split) expect(names.length).toBeGreaterThan(0);
  });

  test("split code generation keeps local a definition that only its own part uses", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-split-codegen-local-"));
    dirs.push(dir);
    const count = 24;
    const lines = ["@seed = internal global i64 5", "@total = internal global i64 0"];
    for (let index = 0; index < count; index++)
      lines.push(
        `define internal i64 @leaf${index}(i64 %value) noinline {`,
        `  %scaled = mul i64 %value, ${index + 3}`,
        "  ret i64 %scaled",
        "}",
        `define internal void @step${index}(i64 %value) noinline {`,
        `  %scaled = call i64 @leaf${index}(i64 %value)`,
        "  %old = load i64, ptr @total",
        "  %new = add i64 %old, %scaled",
        "  store i64 %new, ptr @total",
        "  ret void",
        "}",
      );
    lines.push(
      "define i32 @main() {",
      "  %seed = load volatile i64, ptr @seed",
      ...Array.from({ length: count }, (_, index) => `  call void @step${index}(i64 %seed)`),
      "  %total = load i64, ptr @total",
      "  %low = urem i64 %total, 251",
      "  %code = trunc i64 %low to i32",
      "  ret i32 %code",
      "}",
    );
    const parts = await emit(dir, lines.join("\n") + "\n", {
      outputs: 3,
      optLevel: "2",
      split: true,
      name: "local",
    });
    let sum = 0;
    for (let index = 0; index < count; index++) sum += 5 * (index + 3);
    expect(await exitCode(dir, parts, "local")).toBe(sum % 251);
    const symbols = await Promise.all(
      parts.map(async (part) => (await execFileAsync("nm", ["--defined-only", part])).stdout),
    );
    const bindings = (listing: string, prefix: string) =>
      [...listing.matchAll(new RegExp(`^[0-9a-fA-F]+ ([Tt]) _?${prefix}\\d+$`, "gm"))].map(
        (match) => match[1],
      );
    // A step in another part than main's is called across parts. A leaf is
    // called only by its step, which is in the same part unless a part
    // boundary falls between them.
    const mainPart = symbols.findIndex((listing) => / T _?main$/m.test(listing));
    expect(mainPart).toBeGreaterThan(0);
    const crossPart = symbols
      .filter((_, index) => index !== mainPart)
      .flatMap((listing) => bindings(listing, "step"));
    expect(crossPart.length).toBeGreaterThan(0);
    expect(new Set(crossPart)).toEqual(new Set(["T"]));
    const leaves = symbols.flatMap((listing) => bindings(listing, "leaf"));
    expect(leaves).toHaveLength(count);
    expect(leaves.filter((bound) => bound === "t").length).toBeGreaterThanOrEqual(count - 2);
  });

  test("split code generation links a thread-local global that only one part uses", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-split-codegen-tls-"));
    dirs.push(dir);
    // @touch and main reach @slots through one constant expression, which
    // outlives their bodies in the part that holds neither.
    const thread = [
      "@calls = internal thread_local(localexec) global i64 0",
      "@slots = internal thread_local(localexec) global [2 x i64] zeroinitializer",
      "define internal void @touch() noinline {",
      "  store volatile i64 1, ptr getelementptr inbounds (i8, ptr @slots, i64 8)",
      "  ret void",
      "}",
    ].join("\n");
    const source = program(0, thread).replace(
      "  %total = load i64, ptr @total",
      [
        "  store volatile i64 1, ptr @calls",
        "  call void @touch()",
        "  %slot = load volatile i64, ptr getelementptr inbounds (i8, ptr @slots, i64 8)",
        "  %total = load i64, ptr @total",
      ].join("\n"),
    );
    const parts = await emit(dir, source, { outputs: 3, optLevel: "2", split: true, name: "tls" });
    expect(await exitCode(dir, parts, "tls")).toBe(expectedExit());
  });

  test("split code generation keeps a module that one function dominates whole", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-split-codegen-whole-"));
    dirs.push(dir);
    const body = Array.from(
      { length: 400 },
      (_, index) => `  %v${index + 1} = mul i64 %v${index}, %v${index}`,
    );
    const heavy = [
      "@sink = internal global i64 0",
      "define internal void @heavy(i64 %v0) noinline {",
      ...body,
      "  store volatile i64 %v400, ptr @sink",
      "  ret void",
      "}",
    ].join("\n");
    const source = program(0, heavy, 2).replace(
      "  %total = load i64, ptr @total",
      "  call void @heavy(i64 %second)\n  %total = load i64, ptr @total",
    );
    const parts = await emit(dir, source, {
      outputs: 3,
      optLevel: "2",
      split: true,
      name: "whole",
    });
    expect(await exitCode(dir, parts, "whole")).toBe(expectedExit(0, 2));
    const { stdout } = await execFileAsync("nm", ["--defined-only", parts[0]!]);
    expect(stdout).toMatch(/ t _?heavy$/m);
    for (const part of parts.slice(1)) {
      const listed = await execFileAsync("nm", ["--defined-only", part]);
      expect(listed.stdout.trim()).toBe("");
    }
    // The first output is the object that a single output produces.
    const first = await readFile(parts[0]!);
    const [single] = await emit(dir, source, { outputs: 1, optLevel: "2", name: "whole" });
    expect(await readFile(single!)).toEqual(first);
    // The empty parts name the source path, so they do not depend on the
    // input's file name either.
    const renamed = await emit(dir, source, {
      outputs: 3,
      optLevel: "2",
      split: true,
      name: "renamed",
    });
    for (let index = 0; index < parts.length; index++)
      expect(await readFile(renamed[index]!)).toEqual(await readFile(parts[index]!));
  });

  test("split code generation requires several optimized outputs and no cache", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-split-codegen-invalid-"));
    dirs.push(dir);
    for (const options of [
      { outputs: 1, optLevel: "2" },
      { outputs: 3, optLevel: "0" },
      { outputs: 3, optLevel: "2", cache: join(dir, "cache") },
    ] as const) {
      const failure = emit(dir, program(), { ...options, split: true, name: "invalid" });
      await expect(failure).rejects.toMatchObject({
        stderr: expect.stringContaining("invalid_split"),
      });
    }
  });

  test("functions under one group line share a partition", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-partitions-groups-"));
    dirs.push(dir);
    // Groups of four steps, each smaller than the mean partition; main ends
    // the last group. Placement by group applies from 32 partitions.
    const steps = 128;
    const grouped = (edit: number, count = steps) =>
      program(edit, "", count)
        .split("\n")
        .flatMap((line) => {
          const step = /^define internal void @step(\d+)\(/.exec(line);
          if (step !== null && Number(step[1]) % 4 === 0)
            return [`; scriptc-group ${Number(step[1]) / 4}`, line];
          return line.startsWith("define i32 @main(") ? ["; scriptc-group", line] : [line];
        })
        .join("\n");
    const cache = join(dir, "cache");
    const options = { outputs: 32, optLevel: "0", cache } as const;
    const objects = await emit(dir, grouped(0), { ...options, name: "grouped" });
    expect(await exitCode(dir, objects, "grouped")).toBe(expectedExit(0, steps));
    const owner = new Map<number, number>();
    for (const [index, object] of objects.entries()) {
      const { stdout } = await execFileAsync("nm", [object]);
      for (const line of stdout.split("\n")) {
        const defined = /^[0-9a-fA-F]+ [A-Za-z] _?step(\d+)$/.exec(line.trim());
        if (defined !== null) owner.set(Number(defined[1]), index);
      }
    }
    expect(owner.size).toBe(steps);
    // step0's only caller is main, so it goes with main.
    for (let group = 0; group < steps / 4; group++) {
      const members = [0, 1, 2, 3].map((offset) => group * 4 + offset).filter((step) => step > 0);
      expect(new Set(members.map((step) => owner.get(step))).size).toBe(1);
    }

    // An edit to one function still changes one partition's source.
    const sources = await cacheEntries(cache, ".o");
    const edited = await emit(dir, grouped(7), { ...options, name: "edited" });
    const after = await cacheEntries(cache, ".o");
    expect([...after].filter((entry) => !sources.has(entry))).toHaveLength(1);
    expect(await exitCode(dir, edited, "edited")).toBe(expectedExit(7, steps));

    // With fewer partitions, functions keep their placement by name, and a
    // group line only stops a single-caller chain: step0 joins main without
    // groups, and keeps its own placement in group 0.
    const few = { outputs: 4, optLevel: "0" } as const;
    const placed = async (objects: string[]) => {
      const where = new Map<string, number>();
      for (const [index, object] of objects.entries()) {
        const { stdout } = await execFileAsync("nm", [object]);
        for (const line of stdout.split("\n")) {
          const defined = /^[0-9a-fA-F]+ [A-Za-z] _?(step\d+|main)$/.exec(line.trim());
          if (defined !== null) where.set(defined[1]!, index);
        }
      }
      return where;
    };
    const fewGrouped = await placed(
      await emit(dir, grouped(0, 24), { ...few, name: "few-grouped" }),
    );
    const fewPlain = await placed(await emit(dir, program(), { ...few, name: "few-plain" }));
    expect(fewPlain.get("step0")).toBe(fewPlain.get("main"));
    for (let step = 1; step < 24; step++)
      expect(fewGrouped.get(`step${step}`)).toBe(fewPlain.get(`step${step}`));
    expect(fewGrouped.get("main")).toBe(fewPlain.get("main"));
  });

  test("internal definitions nothing reaches are left out of every partition", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-partitions-unreachable-"));
    dirs.push(dir);
    // An unreferenced internal function that uses live code and its own
    // state, which only it references.
    const unused = (name: string) =>
      [
        `@${name}State = internal global i64 7`,
        `define internal void @${name}(i64 %value) {`,
        `  %state = load i64, ptr @${name}State`,
        "  call void @bump(i64 %state)",
        "  ret void",
        "}",
      ].join("\n");
    const cache = join(dir, "cache");
    const options = { outputs: 4, optLevel: "0", cache } as const;
    const objects = await emit(dir, program(0, unused("unusedOne")), { ...options, name: "first" });
    expect(await exitCode(dir, objects, "first")).toBe(expectedExit());
    for (const object of objects) {
      const { stdout } = await execFileAsync("nm", [object]);
      expect(stdout).not.toMatch(/unusedOne/);
    }
    // Adding another one changes no partition.
    const before = await cacheEntries(cache, ".o");
    const more = await emit(dir, program(0, `${unused("unusedOne")}\n${unused("unusedTwo")}`), {
      ...options,
      name: "more",
    });
    expect(await cacheEntries(cache, ".o")).toEqual(before);
    expect(await exitCode(dir, more, "more")).toBe(expectedExit());
  });

  test("a helper that one function uses goes to that function's partition", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-partitions-helpers-"));
    dirs.push(dir);
    // step7 calls @helper directly, and step9 calls @viaTable through an
    // internal global only step9 reads.
    const helpers = (withHelpers: boolean) =>
      program()
        .split("\n")
        .flatMap((line) => {
          if (!withHelpers) return [line];
          if (line === "define internal void @step7(i64 %value) noinline {")
            return [
              "define internal void @helper(i64 %value) noinline {",
              "  call void @bump(i64 %value)",
              "  ret void",
              "}",
              "@table = internal constant ptr @viaTable",
              "define internal void @viaTable(i64 %value) noinline {",
              "  call void @bump(i64 %value)",
              "  ret void",
              "}",
              line,
              "  call void @helper(i64 0)",
            ];
          if (line === "define internal void @step9(i64 %value) noinline {")
            return [line, "  %fn = load ptr, ptr @table", "  call void %fn(i64 0)"];
          return [line];
        })
        .join("\n");
    const cache = join(dir, "cache");
    const options = { outputs: 4, optLevel: "0", cache } as const;
    await emit(dir, helpers(false), { ...options, name: "before" });
    const before = await cacheEntries(cache, ".o");
    const objects = await emit(dir, helpers(true), { ...options, name: "after" });
    expect(await exitCode(dir, objects, "after")).toBe(expectedExit());
    const where = new Map<string, number>();
    for (const [index, object] of objects.entries()) {
      const { stdout } = await execFileAsync("nm", [object]);
      for (const line of stdout.split("\n")) {
        const defined = /^[0-9a-fA-F]+ [A-Za-z] _?(step7|step9|helper|viaTable)$/.exec(line.trim());
        if (defined !== null) where.set(defined[1]!, index);
      }
    }
    expect(where.get("helper")).toBe(where.get("step7"));
    expect(where.get("viaTable")).toBe(where.get("step9"));
    // Only the partitions of step7 and step9 change.
    const changed = [...(await cacheEntries(cache, ".o"))].filter((entry) => !before.has(entry));
    expect(changed).toHaveLength(new Set([where.get("step7"), where.get("step9")]).size);
  });

  test("a table written one element per line keeps the text partitioner and its reuse", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-partitions-table-"));
    dirs.push(dir);
    // The emitter writes interface dispatch tables one element per line.
    const table = [
      "@table = internal constant [2 x ptr] [",
      "  ptr @step3,",
      "  ptr @step9",
      "]",
    ].join("\n");
    const source = (edit: number) =>
      program(edit, table).replace(
        "  %total = load i64, ptr @total",
        "  %entry = load ptr, ptr @table\n  call void %entry(i64 0)\n  %total = load i64, ptr @total",
      );
    const cache = join(dir, "cache");
    const first = await emit(dir, source(0), { outputs: 4, optLevel: "2", cache, name: "first" });
    expect(await exitCode(dir, first, "first")).toBe(expectedExit());
    const sources = await cacheEntries(cache, ".bc");
    const edited = await emit(dir, source(7), { outputs: 4, optLevel: "2", cache, name: "edited" });
    const after = await cacheEntries(cache, ".bc");
    expect([...after].filter((entry) => !sources.has(entry))).toHaveLength(1);
    expect(await exitCode(dir, edited, "edited")).toBe(expectedExit(7));
  });

  test("inputs outside the text partitioner's grammar are still partitioned", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-partitions-fallback-"));
    dirs.push(dir);
    const source = program(0, '@"quoted name" = internal global i64 1').replace(
      "  %old = load i64, ptr @total",
      '  %old = load i64, ptr @total\n  %unused = load i64, ptr @"quoted name"',
    );
    for (const optLevel of ["2", "0"] as const) {
      const objects = await emit(dir, source, {
        outputs: 3,
        optLevel,
        name: `fallback${optLevel}`,
      });
      expect(await exitCode(dir, objects, `fallback${optLevel}`)).toBe(expectedExit());
    }
  });

  test("debug metadata follows the functions that reference it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-partitions-debug-"));
    dirs.push(dir);
    const debug = program()
      .split("\n")
      .map((line) => {
        const definition =
          /^define internal void @step(\d+)(?:\.i32)?\(i64 %value\) noinline \{$/.exec(line);
        if (definition !== null)
          return line.replace(" {", ` !dbg !${10 + Number(definition[1])} {`);
        const call = /^ {2}call void @step(\d+)\(i64 %value\)$/.exec(line);
        return call === null ? line : `${line}, !dbg !${40 + Number(call[1]) - 1}`;
      });
    const source = [
      ...debug,
      "!llvm.dbg.cu = !{!0}",
      "!llvm.module.flags = !{!2, !3}",
      '!0 = distinct !DICompileUnit(language: DW_LANG_C, file: !1, producer: "test", isOptimized: false, runtimeVersion: 0, emissionKind: FullDebug)',
      '!1 = !DIFile(filename: "program.ts", directory: "/src")',
      '!2 = !{i32 2, !"Debug Info Version", i32 3}',
      '!3 = !{i32 7, !"Dwarf Version", i32 5}',
      "!4 = !DISubroutineType(types: !{})",
      ...Array.from(
        { length: 24 },
        (_, index) =>
          `!${10 + index} = distinct !DISubprogram(name: "step${index}", scope: !1, file: !1, line: ${index + 1}, type: !4, spFlags: DISPFlagDefinition, unit: !0)`,
      ),
      ...Array.from(
        { length: 23 },
        (_, index) =>
          `!${40 + index} = !DILocation(line: ${index + 1}, column: 3, scope: !${10 + index})`,
      ),
      "",
    ].join("\n");
    const cache = join(dir, "cache");
    const objects = await emit(dir, source, { outputs: 4, optLevel: "0", cache, name: "debug" });
    const bytes = await Promise.all(objects.map((path) => readFile(path)));
    // ELF and COFF name the section .debug_info; Mach-O names it __debug_info.
    expect(bytes.filter((object) => object.includes("debug_info")).length).toBeGreaterThan(1);
    expect(await exitCode(dir, objects, "debug")).toBe(expectedExit());

    // Partitions number their metadata locally, so a module whose node
    // numbers all shift still reuses every partition.
    const before = await cacheEntries(cache, ".o");
    const shifted = source.replace(/!(\d+)/g, (_, number: string) => `!${Number(number) + 100}`);
    const renumbered = await emit(dir, shifted, {
      outputs: 4,
      optLevel: "0",
      cache,
      name: "renumbered",
    });
    expect(await cacheEntries(cache, ".o")).toEqual(before);
    expect(await Promise.all(renumbered.map((path) => readFile(path)))).toEqual(bytes);
  });
});
