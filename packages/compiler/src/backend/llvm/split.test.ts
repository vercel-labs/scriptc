import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { splitLlvmLibraryProgram, splitLlvmProgram } from "./split.js";

const scratch: string[] = [];
afterAll(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(scratch.map((path) => rm(path, { recursive: true, force: true })));
});

const SAMPLE = `%Pair = type { i64, i64 }
declare void @runtime(ptr)

@hidden_value = internal global i64 7
@public_value = constant i64 11

define internal i64 @left() #0 {
entry:
  %v = load i64, ptr @hidden_value
  ret i64 %v
}

define internal i64 @right() #0 {
entry:
  %v = call i64 @left()
  ret i64 %v
}

define i64 @public_entry() #0 {
entry:
  %a = call i64 @right()
  %b = load i64, ptr @public_value
  %r = add i64 %a, %b
  ret i64 %r
}

attributes #0 = { sanitize_address }
`;

test("splits generated LLVM functions and promotes only private cross-shard definitions", () => {
  const split = splitLlvmProgram(SAMPLE, { minimumBytes: 0, targetBytes: 64 * 1024 });
  // The production floor is 64 KiB. Make enough functions to cross it while
  // retaining the readable SAMPLE assertions below.
  expect(split).not.toBeNull();
  expect(splitLlvmProgram(SAMPLE)).toBeNull();
  const large = SAMPLE.replace(
    "define i64 @public_entry",
    `${Array.from({ length: 80 }, (_, i) => `define internal i64 @pad_${i}() #0 {\nentry:\n  ; ${"x".repeat(2048)}\n  ret i64 ${i}\n}\n`).join("\n")}\ndefine i64 @public_entry`,
  );
  const actual = splitLlvmProgram(large, { minimumBytes: 0, targetBytes: 64 * 1024 });
  expect(actual).not.toBeNull();
  expect(actual!.shards.length).toBeGreaterThan(1);
  expect(actual!.promotedSymbols).toContain("hidden_value");
  expect(actual!.promotedSymbols).toContain("left");
  expect(actual!.promotedSymbols).not.toContain("public_value");
  expect(actual!.promotedSymbols).not.toContain("public_entry");
  expect(actual!.publicSymbols).toEqual(["public_value", "public_entry"]);
  expect(actual!.shards[0]!.name).toBe("program-globals.ll");
  expect(actual!.shards[0]!.source).toContain("@hidden_value = hidden global i64 7");
  expect(actual!.shards.slice(1).every((shard) =>
    shard.source.includes("@hidden_value = external hidden global i64")
  )).toBe(true);
  expect(actual!.shards.some((shard) =>
    !shard.source.includes("define hidden i64 @right() #0") &&
    shard.source.includes("declare hidden i64 @right() #0")
  )).toBe(true);
});

test("thread-local program state conservatively keeps the single-TU path", () => {
  const tls = SAMPLE.replace(
    "@hidden_value = internal global i64 7",
    "@hidden_value = internal thread_local global i64 7",
  );
  expect(splitLlvmProgram(tls, { minimumBytes: 0, targetBytes: 64 * 1024 })).toBeNull();
});

test("dev libraries split at the measured 2MB crossover while executables retain 4MB", () => {
  const body = Array.from({ length: 700 }, (_, i) =>
    `define internal i64 @library_pad_${i}() #0 {\nentry:\n  ; ${"x".repeat(3072)}\n  ret i64 ${i}\n}\n`,
  ).join("\n");
  const source = SAMPLE.replace("define i64 @public_entry", `${body}\ndefine i64 @public_entry`);
  expect(Buffer.byteLength(source)).toBeGreaterThan(2 * 1024 * 1024);
  expect(Buffer.byteLength(source)).toBeLessThan(4 * 1024 * 1024);
  expect(splitLlvmProgram(source)).toBeNull();
  expect(splitLlvmLibraryProgram(source)?.shards).toHaveLength(5);

  const belowCrossover = source.slice(0, Math.floor(1.9 * 1024 * 1024));
  expect(splitLlvmLibraryProgram(belowCrossover)).toBeNull();
});

test("every shard compiles and its merged object exposes only canonical public definitions", async () => {
  const body = Array.from({ length: 120 }, (_, i) =>
    `define internal i64 @pad_${i}() #0 {\nentry:\n  ; ${"x".repeat(2048)}\n  ret i64 ${i}\n}\n`,
  ).join("\n");
  const split = splitLlvmProgram(
    SAMPLE.replace("define i64 @public_entry", `${body}\ndefine i64 @public_entry`),
    { minimumBytes: 0, targetBytes: 64 * 1024 },
  )!;
  const dir = await mkdtemp(join(tmpdir(), "scriptc-llvm-split-"));
  scratch.push(dir);
  const objects: string[] = [];
  for (const shard of split.shards) {
    const source = join(dir, shard.name);
    const object = `${source}.o`;
    await writeFile(source, shard.source);
    execFileSync("clang", ["-Wno-override-module", "-c", source, "-o", object]);
    objects.push(object);
  }
  const combined = join(dir, "combined.o");
  execFileSync("ld", ["-r", ...objects, "-o", combined]);
  if (process.platform === "linux") {
    const keep = join(dir, "keep.txt");
    await writeFile(keep, "public_entry\npublic_value\n");
    execFileSync("objcopy", [`--keep-global-symbols=${keep}`, combined]);
  }
  const globals = execFileSync("nm", ["-g", combined], { encoding: "utf8" });
  expect(globals).toContain("public_entry");
  expect(globals).toContain("public_value");
  expect(globals).not.toContain("hidden_value");
  expect(globals).not.toContain("left");
  expect((await readFile(combined)).length).toBeGreaterThan(0);
});
