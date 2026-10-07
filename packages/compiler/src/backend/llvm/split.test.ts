import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { splitLlvmLibraryProgram, splitLlvmProgram } from "./split.js";
import { LlvmDebugInfo } from "./debug-info.js";
import { VOID } from "../../ir/ir.js";

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
  expect(
    actual!.shards
      .slice(1)
      .every((shard) => shard.source.includes("@hidden_value = external hidden global i64")),
  ).toBe(true);
  expect(
    actual!.shards.some(
      (shard) =>
        !shard.source.includes("define hidden i64 @right() #0") &&
        shard.source.includes("declare hidden i64 @right() #0"),
    ),
  ).toBe(true);
});

test("thread-local definitions and declarations preserve their storage model across shards", () => {
  const tls = SAMPLE.replace(
    "@hidden_value = internal global i64 7",
    "@hidden_value = internal thread_local global i64 7",
  );
  const split = splitLlvmProgram(tls, { minimumBytes: 0, targetBytes: 64 * 1024 })!;
  expect(split.shards[0]!.source).toContain("@hidden_value = hidden thread_local global i64 7");
  for (const shard of split.shards.slice(1)) {
    expect(shard.source).toContain("@hidden_value = external hidden thread_local global i64");
  }
});

test.skipIf(process.platform === "win32")(
  "split and merged native modules keep globals independent on concurrent threads",
  async () => {
    const source = `%State = type { i64, i64 }
@state = internal thread_local global %State { i64 7, i64 0 }
@foreign = external thread_local global i64

define void @set_owner(i64 %owner) {
entry:
  store i64 %owner, ptr getelementptr inbounds (%State, ptr @state, i64 0, i32 1)
  ret void
}

define i64 @get_owner() {
entry:
  %owner = load i64, ptr getelementptr inbounds (%State, ptr @state, i64 0, i32 1)
  ret i64 %owner
}

define i64 @next_value() {
entry:
  %current = load i64, ptr @state
  %next = add i64 %current, 1
  store i64 %next, ptr @state
  %other = load i64, ptr @foreign
  %after = add i64 %other, 1
  store i64 %after, ptr @foreign
  %result = add i64 %current, %other
  ret i64 %result
}
`;
    const split = splitLlvmProgram(source, { minimumBytes: 0, targetBytes: 64 * 1024 })!;
    expect(split.shards.length).toBeGreaterThan(2);
    const dir = await mkdtemp(join(tmpdir(), "scriptc-llvm-thread-state-"));
    scratch.push(dir);
    const objects: string[] = [];
    for (const shard of split.shards) {
      const path = join(dir, shard.name);
      const object = `${path}.o`;
      await writeFile(path, shard.source);
      execFileSync("clang", ["-Wno-override-module", "-O2", "-c", path, "-o", object]);
      objects.push(object);
    }
    const combined = join(dir, "combined.o");
    execFileSync("ld", ["-r", ...objects, "-o", combined]);
    if (process.platform === "linux") {
      const keep = join(dir, "keep.txt");
      await writeFile(keep, "set_owner\nget_owner\nnext_value\n");
      execFileSync("objcopy", [`--keep-global-symbols=${keep}`, combined]);
    }
    const binary = join(dir, "thread-state");
    execFileSync("clang", [
      "-std=c11",
      "-O2",
      "-pthread",
      join(import.meta.dirname, "split-thread-state.test.c"),
      combined,
      "-o",
      binary,
    ]);
    expect(execFileSync(binary, { encoding: "utf8", timeout: 10000 })).toBe(
      "thread state stays isolated across compiled partitions\n",
    );
  },
);

test("shared metadata bounds shard growth while preserving every definition", () => {
  const names = Array.from({ length: 120 }, (_, i) => `metadata_pad_${i}`);
  const body = names
    .map(
      (name) =>
        `define internal i64 @${name}() #0 {\nentry:\n  ; ${"x".repeat(32 * 1024)}\n  ret i64 1\n}\n`,
    )
    .join("\n");
  const source =
    SAMPLE.replace("define i64 @public_entry", `${body}\ndefine i64 @public_entry`) +
    `!0 = !{!"${"x".repeat(256 * 1024)}"}\n`;
  const split = splitLlvmProgram(source, { minimumBytes: 0, targetBytes: 64 * 1024 });
  expect(split).not.toBeNull();
  expect(split!.shards.length).toBeGreaterThan(1);
  expect(
    split!.shards.reduce((bytes, shard) => bytes + Buffer.byteLength(shard.source), 0),
  ).toBeLessThanOrEqual(2 * Buffer.byteLength(source));
  const definitions = split!.shards.flatMap((shard) =>
    [...shard.source.matchAll(/^define (?:hidden )?i64 @(\w+)\(/gm)].map((match) => match[1]),
  );
  expect(definitions.sort()).toEqual([...names, "left", "right", "public_entry"].sort());
  expect(split!.publicSymbols).toEqual(["public_value", "public_entry"]);

  // A metadata-heavy module with little code cannot repay duplication.
  const shared = SAMPLE + `!0 = !{!"${"x".repeat(2 * 1024 * 1024)}"}\n`;
  expect(splitLlvmProgram(shared, { minimumBytes: 0 })).toBeNull();
});

test("debug metadata stays on definitions when splitting LLVM modules", async () => {
  const debug = new LlvmDebugInfo(
    "/source/main.ts",
    new Map([["/source/main.ts", "console.log(1);\n"]]),
  );
  let source = SAMPLE;
  for (const name of ["left", "right", "public_entry"]) {
    const loc = { file: "/source/main.ts", start: 0, end: 1 };
    const scope = debug.function({ name, loc, params: [], locals: [], body: [], returnType: VOID });
    const location = debug.location(loc, scope);
    source = source.replace(
      new RegExp(`(@${name}\\(\\) #0) \\{([\\s\\S]*?)\\n\\}`),
      (_, header: string, body: string) =>
        `${header} !dbg ${scope} {${body
          .split("\n")
          .map((line) => (line.startsWith("  ") ? `${line}, !dbg ${location}` : line))
          .join("\n")}\n}`,
    );
  }
  source += debug.render();
  const split = splitLlvmProgram(source, { minimumBytes: 0 });
  expect(split).not.toBeNull();
  const dir = await mkdtemp(join(tmpdir(), "scriptc-debug-split-"));
  scratch.push(dir);
  for (const shard of split!.shards) {
    expect(shard.source).not.toMatch(/^declare.*!dbg/m);
    const path = join(dir, shard.name);
    await writeFile(path, shard.source);
    const result = spawnSync("clang", ["-Wno-override-module", "-c", path, "-o", `${path}.o`], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
  }
});

test("dev libraries split at the measured 2MB crossover while executables retain 4MB", () => {
  const body = Array.from(
    { length: 700 },
    (_, i) =>
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
  const body = Array.from(
    { length: 120 },
    (_, i) =>
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
