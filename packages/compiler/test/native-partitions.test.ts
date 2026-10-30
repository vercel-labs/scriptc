import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { nativeCodegenTarget, nativeHelperForTarget } from "../src/backend/targets.js";

const execFileAsync = promisify(execFile);
// Mach-O objects define a local label (ltmp0, ltmp1, ...) at the start of
// each section; it names no function.
const machoSectionLabel = /^ltmp\d+$/;
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
    profileGenerate?: string;
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
    ...(options.profileGenerate === undefined
      ? []
      : ["--profile-generate", options.profileGenerate]),
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

  test("an internal function that other partitions reach through an import keeps its name across edits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-partitions-imports-"));
    dirs.push(dir);
    const count = 24;
    const factor = (index: number, edit: number) => index + 3 + (index === 5 ? edit : 0);
    // Each leaf is internal and called only by its wrapper. The wrappers are
    // small, and main and the steps import them from other partitions, with
    // a reference to the leaf, which its partition then exports.
    const source = (edit: number) => {
      const lines: string[] = [];
      for (let index = 0; index < count; index++)
        lines.push(
          `define internal i64 @leaf${index}(i64 %value) noinline {`,
          `  %scaled = mul i64 %value, ${factor(index, edit)}`,
          "  ret i64 %scaled",
          "}",
          `define internal i64 @wrap${index}(i64 %value) {`,
          `  %leaf = call i64 @leaf${index}(i64 %value)`,
          "  %next = add i64 %leaf, 1",
          "  ret i64 %next",
          "}",
          `define i64 @step${index}(i64 %value) noinline {`,
          `  %wrapped = call i64 @wrap${index}(i64 %value)`,
          "  ret i64 %wrapped",
          "}",
        );
      lines.push("define i32 @main() {", "entry:");
      for (let index = 0; index < count; index++)
        lines.push(
          `  %s${index} = call i64 @step${index}(i64 1)`,
          `  %w${index} = call i64 @wrap${index}(i64 2)`,
          `  %a${index} = add i64 ${index === 0 ? "0" : `%t${index - 1}`}, %s${index}`,
          `  %t${index} = add i64 %a${index}, %w${index}`,
        );
      lines.push(
        `  %low = urem i64 %t${count - 1}, 251`,
        "  %code = trunc i64 %low to i32",
        "  ret i32 %code",
        "}",
      );
      return lines.join("\n") + "\n";
    };
    const expected = (edit: number) => {
      let total = 0;
      for (let index = 0; index < count; index++) total += 3 * factor(index, edit) + 2;
      return total % 251;
    };
    // ThinLTO renames an exported internal function <name>.llvm.<module
    // hash>. The hash is the partition number, so an edit of the leaf's
    // partition leaves the name, and the importing partitions, unchanged.
    const promoted = async (objects: string[]) => {
      const names = new Set<string>();
      for (const object of objects)
        for (const match of (await execFileAsync("nm", [object])).stdout.matchAll(
          /^[0-9a-fA-F ]+ ([TU]) _?(leaf\d+\.llvm\.\d+)$/gm,
        ))
          names.add(`${match[1]} ${match[2]}`);
      return names;
    };
    const first = await emit(dir, source(0), { outputs: 4, optLevel: "2", name: "first" });
    expect(await exitCode(dir, first, "first")).toBe(expected(0));
    const edited = await emit(dir, source(4), { outputs: 4, optLevel: "2", name: "edited" });
    expect(await exitCode(dir, edited, "edited")).toBe(expected(4));
    const names = await promoted(first);
    expect([...names].some((name) => name.startsWith("U "))).toBe(true);
    for (const name of names) expect(name).toMatch(/\.llvm\.[1-4]$/);
    expect(await promoted(edited)).toEqual(names);
  });

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
        .filter((name): name is string => name !== undefined && !machoSectionLabel.test(name));
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
      const symbols = listed.stdout
        .split("\n")
        .filter(
          (line) => line.trim() !== "" && !machoSectionLabel.test(line.trim().split(" ").at(-1)!),
        );
      expect(symbols).toEqual([]);
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

  test("an optimized module whose largest partition would hold most of its function text is optimized whole", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-partitions-dominated-"));
    dirs.push(dir);
    // One function of 400 instructions and four small ones.
    const lines = [
      "@sink = global i64 0",
      "define void @large(i64 %x) noinline {",
      "  %v0 = add i64 %x, 1",
    ];
    for (let step = 1; step < 400; step++)
      lines.push(`  %v${step} = mul i64 %v${step - 1}, ${step}`);
    lines.push("  store volatile i64 %v399, ptr @sink", "  ret void", "}");
    for (let index = 0; index < 4; index++)
      lines.push(
        `define void @small${index}(i64 %x) noinline {`,
        `  %v = add i64 %x, ${index}`,
        "  store volatile i64 %v, ptr @sink",
        "  ret void",
        "}",
      );
    lines.push("define i32 @main() {", "  call void @large(i64 1)");
    for (let index = 0; index < 4; index++) lines.push(`  call void @small${index}(i64 1)`);
    lines.push("  ret i32 0", "}");
    const source = lines.join("\n") + "\n";
    const cache = join(dir, "cache");
    const contents = (paths: string[]) => Promise.all(paths.map((path) => readFile(path)));
    const partitioned = await emit(dir, source, {
      outputs: 4,
      optLevel: "2",
      cache,
      name: "partitioned",
    });
    const whole = await emit(dir, source, {
      outputs: 4,
      optLevel: "2",
      split: true,
      name: "whole",
    });
    expect(await contents(partitioned)).toEqual(await contents(whole));
    // No partition was simplified for a thin link.
    expect(await cacheEntries(cache, ".bc")).toHaveProperty("size", 0);
    expect(await exitCode(dir, partitioned, "partitioned")).toBe(0);
    // Unoptimized partitions are compiled once each, so they stay divided.
    await emit(dir, source, { outputs: 4, optLevel: "0", cache, name: "unoptimized" });
    expect((await cacheEntries(cache, ".o")).size).toBeGreaterThan(1);
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

  test("in a small module, a function that one function of another source file calls shares its partition", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-partitions-chains-"));
    dirs.push(dir);
    const count = 8;
    const lines: string[] = ["; scriptc-group 0"];
    for (let index = 0; index < count; index++)
      lines.push(
        `define internal i64 @helper${index}(i64 %value) noinline {`,
        `  %scaled = mul i64 %value, ${index + 2}`,
        "  ret i64 %scaled",
        "}",
      );
    lines.push("; scriptc-group 1");
    for (let index = 0; index < count; index++)
      lines.push(
        `define i64 @caller${index}(i64 %value) noinline {`,
        `  %helped = call i64 @helper${index}(i64 %value)`,
        "  ret i64 %helped",
        "}",
      );
    lines.push("; scriptc-group", "define i32 @main() {", "entry:");
    for (let index = 0; index < count; index++)
      lines.push(
        `  %c${index} = call i64 @caller${index}(i64 1)`,
        `  %t${index} = add i64 ${index === 0 ? "0" : `%t${index - 1}`}, %c${index}`,
      );
    lines.push(`  %code = trunc i64 %t${count - 1} to i32`, "  ret i32 %code", "}");
    const objects = await emit(dir, lines.join("\n") + "\n", {
      outputs: 4,
      optLevel: "0",
      name: "chains",
    });
    let sum = 0;
    for (let index = 0; index < count; index++) sum += index + 2;
    expect(await exitCode(dir, objects, "chains")).toBe(sum);
    const listings = await Promise.all(
      objects.map(async (object) => (await execFileAsync("nm", ["--defined-only", object])).stdout),
    );
    const home = (name: string) =>
      listings.findIndex((listing) =>
        new RegExp(`^[0-9a-fA-F]+ [Tt] _?${name}$`, "m").test(listing),
      );
    for (let index = 0; index < count; index++) {
      expect(home(`caller${index}`)).toBeGreaterThanOrEqual(0);
      expect(home(`helper${index}`)).toBe(home(`caller${index}`));
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

  test.runIf(target?.llvmTriple.startsWith("x86_64") === true)(
    "an x86-64-v3 copy shares its baseline copy's partition and takes its code unless it has wider vectors",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "scriptc-partitions-cpu-copies-"));
      dirs.push(dir);
      // Copies as --cpu-dispatch emits them: `<name>.base` in #0 and
      // `<name>.v3` in #1. Two callers each, so that every copy is placed by
      // its own name. Each f calls h in its own tier; f and h have 128-bit
      // vectors, g a 256-bit vector, and s only scalar code.
      const pairs = 4;
      const copies = (tier: "base" | "v3", group: number): string[] => [
        `define internal void @h.${tier}(ptr %p) #${group} {`,
        "  %v = load <2 x double>, ptr %p",
        "  %w = fmul <2 x double> %v, splat (double 3.0)",
        "  store <2 x double> %w, ptr %p",
        "  ret void",
        "}",
        ...Array.from({ length: pairs }, (_, index) => [
          `define internal void @f${index}.${tier}(ptr %p) #${group} {`,
          "  %v = load <2 x double>, ptr %p",
          `  %w = fadd <2 x double> %v, splat (double ${index + 1}.0)`,
          "  store <2 x double> %w, ptr %p",
          `  call void @h.${tier}(ptr %p)`,
          "  ret void",
          "}",
        ]).flat(),
        `define internal void @g.${tier}(ptr %p) #${group} {`,
        "  %v = load <4 x double>, ptr %p",
        "  %w = fadd <4 x double> %v, %v",
        "  store <4 x double> %w, ptr %p",
        "  ret void",
        "}",
        `define internal double @s.${tier}(double %x) #${group} {`,
        "  %y = fadd double %x, 1.0",
        "  ret double %y",
        "}",
      ];
      const calls = (result: string): string[] =>
        (["base", "v3"] as const).flatMap((tier) => [
          ...Array.from(
            { length: pairs },
            (_, index) => `  call void @f${index}.${tier}(ptr @sink)`,
          ),
          `  call void @g.${tier}(ptr @sink)`,
          `  %${result}.${tier} = call double @s.${tier}(double 1.0)`,
        ]);
      const source = [
        "@sink = global [4 x double] zeroinitializer",
        ...copies("base", 0),
        ...copies("v3", 1),
        "define void @other() {",
        ...calls("o"),
        "  ret void",
        "}",
        "define i32 @main() {",
        ...calls("m"),
        "  ret i32 0",
        "}",
        "attributes #0 = { noinline uwtable }",
        'attributes #1 = { noinline uwtable "target-cpu"="x86-64-v3" "scriptc-cpu-copy" }',
      ].join("\n");
      // Each function's object and disassembly, by its name without the
      // thin link's `.llvm.<n>` suffix.
      const disassemble = async (objects: string[]) => {
        const functions = new Map<string, { object: number; code: string }>();
        for (const [index, object] of objects.entries()) {
          const { stdout } = await execFileAsync("objdump", ["-dr", "--no-show-raw-insn", object]);
          for (const part of stdout.split(/\n(?=[0-9a-f]+ <)/)) {
            const name = /^[0-9a-f]+ <([^>]+)>:/.exec(part)?.[1]?.replace(/\.llvm\.\d+$/, "");
            if (name !== undefined) functions.set(name, { object: index, code: part });
          }
        }
        return (name: string) => {
          const found = functions.get(name);
          expect(found, name).toBeDefined();
          return found!;
        };
      };
      const at = await disassemble(
        await emit(dir, source + "\n", { outputs: 8, optLevel: "2", name: "copies" }),
      );
      for (const stem of [
        "h",
        "g",
        "s",
        ...Array.from({ length: pairs }, (_, index) => `f${index}`),
      ])
        expect(at(`${stem}.v3`).object, stem).toBe(at(`${stem}.base`).object);
      // 128-bit vectors: the v3 copies run the baseline's code (SSE2, without
      // VEX encodings), and f's still calls h's v3 copy.
      for (let index = 0; index < pairs; index++) {
        const code = at(`f${index}.v3`).code;
        expect(code).toMatch(/\saddpd\s/);
        expect(code).not.toMatch(/\svaddpd\s/);
        expect(code).toMatch(/[\s<]h\.v3(?:\.llvm\.\d+)?[-+>]/);
      }
      expect(at("h.v3").code).toMatch(/\smulpd\s/);
      // A 256-bit vector keeps the v3 code, and so does scalar code.
      expect(at("g.v3").code).toContain("%ymm");
      expect(at("s.v3").code).toMatch(/\svaddsd\s/);
      expect(at("g.base").code).not.toContain("%ymm");
      // An instrumented build keeps every copy's code: a baseline body would
      // count the v3 copy's executions against the baseline copy.
      const counted = await disassemble(
        await emit(dir, source + "\n", {
          outputs: 8,
          optLevel: "2",
          profileGenerate: join(dir, "copies-%p.profraw"),
          name: "counted",
        }),
      );
      for (let index = 0; index < pairs; index++)
        expect(counted(`f${index}.v3`).code).toMatch(/\svaddpd\s/);
      expect(counted("h.v3").code).toMatch(/\svmulpd\s/);
      // A profile that gives f0's baseline copy fewer runs than its v3 copy
      // (collected on an x86-64-v3 machine) keeps f0's v3 code: the baseline
      // body is optimized as colder code. f1 has no profile counts.
      const profiled = source
        .replace(
          "define internal void @f0.v3(ptr %p) #1 {",
          "define internal void @f0.v3(ptr %p) #1 !prof !90 {",
        )
        .replace(
          "define internal void @f0.base(ptr %p) #0 {",
          "define internal void @f0.base(ptr %p) #0 !prof !91 {",
        );
      const runs = await disassemble(
        await emit(
          dir,
          [
            profiled,
            '!90 = !{!"function_entry_count", i64 1000}',
            '!91 = !{!"function_entry_count", i64 0}',
          ].join("\n") + "\n",
          { outputs: 8, optLevel: "2", name: "runs" },
        ),
      );
      expect(runs("f0.v3").code).toMatch(/\svaddpd\s/);
      expect(runs("f1.v3").code).not.toMatch(/\svaddpd\s/);
    },
  );

  test("an !invariant.group load whose pointer becomes a constant keeps its own function's value", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-partitions-invariant-group-"));
    dirs.push(dir);
    // After inlining, both reads load through `getelementptr (ptr null, 4)`,
    // a constant whose uses include the other function's load. LLVM 22.1.8's
    // memory dependence analysis gave each load the other function's load as
    // its value, and the optimizer crashed (MemoryDependenceAnalysis.cpp).
    const read = (name: string, type: "i32" | "i64") => [
      `define ${type} @${name}(ptr %p) {`,
      "  %tag = call i32 @tag(ptr %p)",
      "  %other = icmp eq i32 %tag, 0",
      "  br i1 %other, label %done, label %read",
      "done:",
      `  ret ${type} 0`,
      "read:",
      "  %field = getelementptr i8, ptr %p, i64 4",
      "  %value = load i32, ptr %field, !invariant.group !0",
      ...(type === "i32"
        ? ["  ret i32 %value"]
        : ["  %wide = zext i32 %value to i64", "  ret i64 %wide"]),
      "}",
    ];
    const source = [
      ...read("first", "i32"),
      ...read("second", "i64"),
      "define i32 @tag(ptr %p) {",
      "  %null = icmp eq ptr %p, null",
      "  %tag = zext i1 %null to i32",
      "  ret i32 %tag",
      "}",
      "!0 = !{}",
    ].join("\n");
    const [object] = await emit(dir, source + "\n", { outputs: 1, optLevel: "2", name: "reads" });
    expect((await readFile(object!)).length).toBeGreaterThan(0);
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

  test("a function that its referrer only takes the address of is placed by its own name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-partitions-address-"));
    dirs.push(dir);
    // A body of `lines` additions, past the size under which an
    // address-only function still follows its referrer.
    const body = (name: string, lines: number) => [
      `define internal void @${name}(i64 %value) noinline {`,
      ...Array.from(
        { length: lines },
        (_, index) => `  %v${index} = add i64 ${index === 0 ? "%value" : `%v${index - 1}`}, 1`,
      ),
      "  call void @bump(i64 0)",
      "  ret void",
      "}",
    ];
    // step7 passes @closure and @trampoline to @spawn; step9 calls
    // @matcher through a mutable global only it reads.
    const source = program()
      .split("\n")
      .flatMap((line) => {
        if (line === "define internal void @step7(i64 %value) noinline {")
          return [
            ...body("closure", 40),
            ...body("trampoline", 1),
            "define internal void @spawn(ptr %fn) noinline {",
            "  call void %fn(i64 1)",
            "  ret void",
            "}",
            line,
            "  call void @spawn(ptr @closure)",
            "  call void @spawn(ptr @trampoline)",
          ];
        if (line === "define internal void @step9(i64 %value) noinline {")
          return [
            "@descriptor = internal global ptr @matcher",
            ...body("matcher", 40),
            line,
            "  %fn = load ptr, ptr @descriptor",
            "  call void %fn(i64 0)",
          ];
        return [line];
      })
      .join("\n");
    const objects = await emit(dir, source, { outputs: 4, optLevel: "0", name: "address" });
    expect(await exitCode(dir, objects, "address")).toBe(expectedExit());
    const where = new Map<string, number>();
    for (const [index, object] of objects.entries()) {
      const { stdout } = await execFileAsync("nm", [object]);
      for (const line of stdout.split("\n")) {
        const defined = /^[0-9a-fA-F]+ [A-Za-z] _?(step7|step9|closure|trampoline|matcher)$/.exec(
          line.trim(),
        );
        if (defined !== null) where.set(defined[1]!, index);
      }
    }
    expect(where.size).toBe(5);
    expect(where.get("trampoline")).toBe(where.get("step7"));
    expect(where.get("closure")).not.toBe(where.get("step7"));
    expect(where.get("matcher")).not.toBe(where.get("step9"));
  });

  test("functions are balanced over a few partitions, and a small edit keeps their places", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-partitions-balance-"));
    dirs.push(dir);
    // Eight exported functions of about 7 KiB each, which main calls; each
    // returns its argument plus its number of additions. By the hash of
    // their names alone, six of them would share one partition.
    const count = 8;
    const additions = (index: number, edit: number) => 280 + (index === 3 ? edit : 0);
    const source = (edit: number) => {
      const lines: string[] = [];
      for (let index = 0; index < count; index++) {
        lines.push(`define i64 @big${index * 4}(i64 %value) noinline {`);
        for (let step = 0; step < additions(index, edit); step++)
          lines.push(`  %v${step} = add i64 ${step === 0 ? "%value" : `%v${step - 1}`}, 1`);
        lines.push(`  ret i64 %v${additions(index, edit) - 1}`, "}");
      }
      lines.push("define i32 @main() {");
      for (let index = 0; index < count; index++)
        lines.push(
          `  %r${index} = call i64 @big${index * 4}(i64 ${index})`,
          `  %t${index} = add i64 ${index === 0 ? "0" : `%t${index - 1}`}, %r${index}`,
        );
      lines.push(
        `  %low = urem i64 %t${count - 1}, 251`,
        "  %code = trunc i64 %low to i32",
        "  ret i32 %code",
        "}",
      );
      return lines.join("\n") + "\n";
    };
    const expected = (edit: number) => {
      let total = 0;
      for (let index = 0; index < count; index++) total += index + additions(index, edit);
      return total % 251;
    };
    const placed = async (objects: string[]) => {
      const where = new Map<string, number>();
      for (const [index, object] of objects.entries()) {
        const { stdout } = await execFileAsync("nm", ["--defined-only", object]);
        for (const line of stdout.split("\n")) {
          const defined = /^[0-9a-fA-F]+ [A-Za-z] _?(big\d+)$/.exec(line.trim());
          if (defined !== null) where.set(defined[1]!, index);
        }
      }
      return where;
    };
    const cache = join(dir, "cache");
    const options = { outputs: 4, optLevel: "0", cache } as const;
    const objects = await emit(dir, source(0), { ...options, name: "balanced" });
    expect(await exitCode(dir, objects, "balanced")).toBe(expected(0));
    const where = await placed(objects);
    expect(where.size).toBe(count);
    for (let partition = 0; partition < 4; partition++)
      expect([...where.values()].filter((home) => home === partition)).toHaveLength(2);

    // Growing one function by a few hundred bytes recompiles only its
    // partition and moves no function.
    const before = await cacheEntries(cache, ".o");
    const edited = await emit(dir, source(8), { ...options, name: "edited" });
    expect(await exitCode(dir, edited, "edited")).toBe(expected(8));
    expect(await placed(edited)).toEqual(where);
    const changed = [...(await cacheEntries(cache, ".o"))].filter((entry) => !before.has(entry));
    expect(changed).toHaveLength(1);
  });

  test("the entry line gives the top-level code and its chain a partition of their own", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-partitions-entry-"));
    dirs.push(dir);
    // Eight exported functions of about 7 KiB, and the marked top-level
    // function @top, which only main calls, so it follows main.
    const count = 8;
    const body = (header: string, lines: number, ret: string) => [
      header,
      ...Array.from(
        { length: lines },
        (_, step) => `  %v${step} = add i64 ${step === 0 ? "%value" : `%v${step - 1}`}, 1`,
      ),
      ret.replace("LAST", `%v${lines - 1}`),
      "}",
    ];
    const source = (marked: boolean) => {
      const lines: string[] = [];
      for (let index = 0; index < count; index++)
        lines.push(
          ...body(`define i64 @big${index * 4}(i64 %value) noinline {`, 280, "  ret i64 LAST"),
        );
      if (marked) lines.push("; scriptc-entry");
      lines.push(
        ...body("define internal i64 @top(i64 %value) noinline {", 280, "  ret i64 LAST"),
        "define i32 @main() {",
        "  %t = call i64 @top(i64 0)",
      );
      for (let index = 0; index < count; index++)
        lines.push(
          `  %r${index} = call i64 @big${index * 4}(i64 ${index})`,
          `  %s${index} = add i64 ${index === 0 ? "%t" : `%s${index - 1}`}, %r${index}`,
        );
      lines.push(
        `  %low = urem i64 %s${count - 1}, 251`,
        "  %code = trunc i64 %low to i32",
        "  ret i32 %code",
        "}",
      );
      return lines.join("\n") + "\n";
    };
    let total = 280;
    for (let index = 0; index < count; index++) total += index + 280;
    const placed = async (objects: string[]) => {
      const where = new Map<string, number>();
      for (const [index, object] of objects.entries()) {
        const { stdout } = await execFileAsync("nm", ["--defined-only", object]);
        for (const line of stdout.split("\n")) {
          const defined = /^[0-9a-fA-F]+ [A-Za-z] _?(big\d+|top|main)$/.exec(line.trim());
          if (defined !== null) where.set(defined[1]!, index);
        }
      }
      return where;
    };
    for (const marked of [false, true]) {
      const objects = await emit(dir, source(marked), {
        outputs: 4,
        optLevel: "0",
        name: marked ? "marked" : "plain",
      });
      expect(await exitCode(dir, objects, marked ? "marked" : "plain")).toBe(total % 251);
      const where = await placed(objects);
      expect(where.get("top")).toBe(where.get("main"));
      const beside = [...where].filter(
        ([name, home]) => name.startsWith("big") && home === where.get("top"),
      );
      // Without the line, balancing places other functions beside main's
      // chain; with it, none.
      if (marked) expect(beside).toEqual([]);
      else expect(beside.length).toBeGreaterThan(0);
    }
  });

  test("a small helper that an edit adds moves no other function", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-partitions-helper-roots-"));
    dirs.push(dir);
    // Eight exported functions of these instruction counts and three small
    // exported helpers, each a root of its own. The edit adds a fourth
    // helper, which big1 calls. Counted in the loads, the added helper would
    // raise the cap and move other functions.
    const sizes = [426, 201, 333, 376, 152, 339, 327, 218];
    const helper = (name: string) => [
      `define i64 @${name}(i64 %value) noinline {`,
      "  %r = add i64 %value, 1",
      "  ret i64 %r",
      "}",
    ];
    const source = (edited: boolean) => {
      const lines: string[] = [];
      sizes.forEach((size, index) => {
        lines.push(`define i64 @big${index}(i64 %value) noinline {`);
        for (let step = 0; step < size; step++)
          lines.push(`  %v${step} = add i64 ${step === 0 ? "%value" : `%v${step - 1}`}, 1`);
        if (edited && index === 1)
          lines.push(`  %h = call i64 @added(i64 %v${size - 1})`, "  ret i64 %h");
        else lines.push(`  ret i64 %v${size - 1}`);
        lines.push("}");
      });
      for (let index = 0; index < 3; index++) lines.push(...helper(`helper${index}`));
      if (edited) lines.push(...helper("added"));
      lines.push("define i32 @main() {");
      sizes.forEach((_, index) =>
        lines.push(
          `  %r${index} = call i64 @big${index}(i64 ${index})`,
          `  %t${index} = add i64 ${index === 0 ? "0" : `%t${index - 1}`}, %r${index}`,
        ),
      );
      for (let index = 0; index < 3; index++) {
        const operand = index === 0 ? `%t${sizes.length - 1}` : `%h${index - 1}`;
        lines.push(`  %h${index} = call i64 @helper${index}(i64 ${operand})`);
      }
      lines.push(
        "  %low = urem i64 %h2, 251",
        "  %code = trunc i64 %low to i32",
        "  ret i32 %code",
        "}",
      );
      return lines.join("\n") + "\n";
    };
    const expected = (edited: boolean) => {
      let total = 3 + (edited ? 1 : 0);
      sizes.forEach((size, index) => (total += index + size));
      return total % 251;
    };
    const placed = async (objects: string[]) => {
      const where = new Map<string, number>();
      for (const [index, object] of objects.entries()) {
        const { stdout } = await execFileAsync("nm", ["--defined-only", object]);
        for (const line of stdout.split("\n")) {
          const defined = /^[0-9a-fA-F]+ [A-Za-z] _?(big\d+|helper\d+|main)$/.exec(line.trim());
          if (defined !== null) where.set(defined[1]!, index);
        }
      }
      return where;
    };
    const cache = join(dir, "cache");
    const options = { outputs: 4, optLevel: "0", cache } as const;
    const objects = await emit(dir, source(false), { ...options, name: "before" });
    expect(await exitCode(dir, objects, "before")).toBe(expected(false));
    const before = await cacheEntries(cache, ".o");
    const edited = await emit(dir, source(true), { ...options, name: "after" });
    expect(await exitCode(dir, edited, "after")).toBe(expected(true));
    expect(await placed(edited)).toEqual(await placed(objects));
    // Only big1's partition and the new helper's change.
    const changed = [...(await cacheEntries(cache, ".o"))].filter((entry) => !before.has(entry));
    expect(changed.length).toBeLessThanOrEqual(2);
  });

  test("small helpers spread when one partition is left below the cap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-partitions-small-spread-"));
    dirs.push(dir);
    // Three exported functions of about 16 KiB, each over the cap of four
    // partitions, whose names hash to partitions 3, 0 and 1, and forty
    // exported helpers of about 2.5 KiB. Partition 2 is the only one left
    // below the cap; counted only against the larger roots' loads, every
    // helper would go there.
    const chain = (header: string, lines: number) => [
      header,
      ...Array.from(
        { length: lines },
        (_, step) => `  %v${step} = add i64 ${step === 0 ? "%value" : `%v${step - 1}`}, 1`,
      ),
      `  ret i64 %v${lines - 1}`,
      "}",
    ];
    const helpers = 40;
    const lines: string[] = [];
    for (let index = 0; index < 3; index++)
      lines.push(...chain(`define i64 @big${index}(i64 %value) noinline {`, 640));
    for (let index = 0; index < helpers; index++)
      lines.push(...chain(`define i64 @helper${index}(i64 %value) noinline {`, 100));
    lines.push("define i32 @main() {");
    const calls = [
      ...[0, 1, 2].map((i) => `big${i}`),
      ...Array.from({ length: helpers }, (_, i) => `helper${i}`),
    ];
    calls.forEach((name, index) =>
      lines.push(
        `  %r${index} = call i64 @${name}(i64 ${index})`,
        `  %s${index} = add i64 ${index === 0 ? "0" : `%s${index - 1}`}, %r${index}`,
      ),
    );
    lines.push(
      `  %low = urem i64 %s${calls.length - 1}, 251`,
      "  %code = trunc i64 %low to i32",
      "  ret i32 %code",
      "}",
    );
    let total = 3 * 640 + helpers * 100;
    calls.forEach((_, index) => (total += index));
    const objects = await emit(dir, lines.join("\n") + "\n", {
      outputs: 4,
      optLevel: "0",
      name: "spread",
    });
    expect(await exitCode(dir, objects, "spread")).toBe(total % 251);
    const homes = new Map<number, number>();
    for (const [index, object] of objects.entries()) {
      const { stdout } = await execFileAsync("nm", ["--defined-only", object]);
      for (const line of stdout.split("\n"))
        if (/^[0-9a-fA-F]+ [A-Za-z] _?helper\d+$/.test(line.trim()))
          homes.set(index, (homes.get(index) ?? 0) + 1);
    }
    expect([...homes.values()].reduce((sum, count) => sum + count, 0)).toBe(helpers);
    expect(Math.max(...homes.values())).toBeLessThan(helpers);
    expect(homes.size).toBeGreaterThan(1);
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
