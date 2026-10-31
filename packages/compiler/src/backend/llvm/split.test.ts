import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { splitLlvmLibraryProgram, splitLlvmProgram, splitLlvmProgramFile } from "./split.js";
import { LlvmDebugInfo } from "./debug-info.js";
import { BOOL, VOID } from "../../ir/ir.js";
import { expectDarwinDebugMap } from "../darwin-debug-map.test-support.js";
import { mangleFunction } from "../mangle.js";

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
  expect(actual!.shards[0]!.source()).toContain("@hidden_value = hidden global i64 7");
  expect(
    actual!.shards
      .slice(1)
      .every((shard) => shard.source().includes("@hidden_value = external hidden global i64")),
  ).toBe(true);
  expect(
    actual!.shards.some(
      (shard) =>
        !shard.source().includes("define hidden i64 @right() #0") &&
        shard.source().includes("declare hidden i64 @right() #0"),
    ),
  ).toBe(true);
});

test("thread-local definitions and declarations preserve their storage model across shards", () => {
  const tls = SAMPLE.replace(
    "@hidden_value = internal global i64 7",
    "@hidden_value = internal thread_local global i64 7",
  );
  const split = splitLlvmProgram(tls, { minimumBytes: 0, targetBytes: 64 * 1024 })!;
  expect(split.shards[0]!.source()).toContain("@hidden_value = hidden thread_local global i64 7");
  for (const shard of split.shards.slice(1)) {
    expect(shard.source()).toContain("@hidden_value = external hidden thread_local global i64");
  }
});

const PADDING = Array.from(
  { length: 80 },
  (_, i) =>
    `define internal i64 @pad_${i}() #0 {\nentry:\n  ; ${"x".repeat(2048)}\n  ret i64 ${i}\n}\n`,
).join("\n");

/** SAMPLE with more globals after @public_value and enough functions to
 * split into several shards. */
function withGlobals(globals: string, tail = ""): string {
  return `${SAMPLE.replace(
    "@public_value = constant i64 11",
    `@public_value = constant i64 11\n${globals}`,
  ).replace("define i64 @public_entry", `${PADDING}\ndefine i64 @public_entry`)}${tail}`;
}

/** Writes each shard and compiles it with clang. */
async function compileShards(
  shards: readonly { name: string; source: () => string }[],
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-llvm-split-shards-"));
  scratch.push(dir);
  for (const shard of shards) {
    const source = join(dir, shard.name);
    await writeFile(source, shard.source());
    execFileSync("clang", ["-Wno-override-module", "-c", source, "-o", `${source}.o`]);
  }
}

test("private unnamed_addr lookup tables are promoted like internal globals", async () => {
  const split = splitLlvmProgram(
    withGlobals('@table = private unnamed_addr constant [2 x i8] c"\\01\\02"'),
    { minimumBytes: 0, targetBytes: 64 * 1024 },
  )!;
  expect(split).not.toBeNull();
  const [globals, ...functions] = split.shards;
  expect(globals!.source()).toContain('@table = hidden unnamed_addr constant [2 x i8] c"\\01\\02"');
  for (const shard of functions)
    expect(shard.source()).toContain("@table = external hidden constant [2 x i8]");
  expect(split.promotedSymbols).toContain("table");
  await compileShards(split.shards);
});

test("aggregate initializers over several lines stay whole in the globals shard", async () => {
  // The regex global's comment holds unbalanced brackets.
  const split = splitLlvmProgram(
    withGlobals(`@regex = internal global { ptr, i64 } { ptr @left, i64 0 } ; /(a|[b/
@vt = internal constant [2 x { i64, ptr }] [
  { i64, ptr } { i64 1, ptr @left },
  { i64, ptr } { i64 2, ptr @right }
]`),
    { minimumBytes: 0, targetBytes: 64 * 1024 },
  )!;
  expect(split).not.toBeNull();
  const [globals, ...functions] = split.shards;
  expect(globals!.source()).toContain(
    "@vt = hidden constant [2 x { i64, ptr }] [\n  { i64, ptr } { i64 1, ptr @left },\n  { i64, ptr } { i64 2, ptr @right }\n]",
  );
  for (const shard of functions) {
    expect(shard.source()).toContain("@vt = external hidden constant [2 x { i64, ptr }]");
    expect(shard.source()).not.toContain("{ i64, ptr } { i64 1");
  }
  expect(split.promotedSymbols).toEqual(expect.arrayContaining(["regex", "vt"]));
  await compileShards(split.shards);
});

test("globals after the attributes and metadata join the globals shard", async () => {
  const split = splitLlvmProgram(withGlobals("", "@flag = internal constant i1 true\n"), {
    minimumBytes: 0,
    targetBytes: 64 * 1024,
  })!;
  expect(split).not.toBeNull();
  const [globals, ...functions] = split.shards;
  expect(globals!.source()).toContain("@flag = hidden constant i1 true");
  for (const shard of functions)
    expect(shard.source()).toContain("@flag = external hidden constant i1");
  await compileShards(split.shards);
});

test("a module split from its file has the shards of the same module split in memory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-llvm-split-file-"));
  scratch.push(dir);
  const options = { minimumBytes: 0, targetBytes: 64 * 1024 };
  const storage = withGlobals(
    `@table = private unnamed_addr constant [2 x i8] c"\\01\\02"
@vt = internal constant [2 x { i64, ptr }] [
  { i64, ptr } { i64 1, ptr @left },
  { i64, ptr } { i64 2, ptr @right }
]`,
    "@flag = internal constant i1 true\n",
  );
  for (const [name, source] of [
    ["sample.ll", withGlobals("")],
    ["storage.ll", storage],
  ] as const) {
    const path = join(dir, name);
    await writeFile(path, source);
    const fromFile = splitLlvmProgramFile(path, options)!;
    expect(fromFile).not.toBeNull();
    const materialize = (split: NonNullable<typeof fromFile>) => ({
      ...split,
      shards: split.shards.map((shard) => ({ name: shard.name, source: shard.source() })),
    });
    expect(materialize(fromFile)).toEqual(materialize(splitLlvmProgram(source, options)!));
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
      await writeFile(path, shard.source());
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
    split!.shards.reduce((bytes, shard) => bytes + Buffer.byteLength(shard.source()), 0),
  ).toBeLessThanOrEqual(2 * Buffer.byteLength(source));
  const definitions = split!.shards.flatMap((shard) =>
    [...shard.source().matchAll(/^define (?:hidden )?i64 @(\w+)\(/gm)].map((match) => match[1]),
  );
  expect(definitions.sort()).toEqual([...names, "left", "right", "public_entry"].sort());
  expect(split!.publicSymbols).toEqual(["public_value", "public_entry"]);

  // A metadata-heavy module with little code cannot repay duplication.
  const shared = SAMPLE + `!0 = !{!"${"x".repeat(2 * 1024 * 1024)}"}\n`;
  expect(splitLlvmProgram(shared, { minimumBytes: 0 })).toBeNull();
});

function debugSample(entry = "/source/main.ts"): string {
  const shared = "/source/shared.ts";
  const debug = new LlvmDebugInfo(
    entry,
    new Map([
      [entry, "console.log(1);\n"],
      [shared, "console.log(2);\n"],
    ]),
  );
  let source = SAMPLE;
  const loc = { file: shared, start: 0, end: 1 };
  const flag = debug.global({
    id: "debug_flag",
    name: "debug_flag",
    type: BOOL,
    mutable: true,
    source: { loc, scope: loc },
  });
  source = source.replace(
    "@hidden_value = internal global i64 7",
    `@hidden_value = internal global i64 7\n@debug_flag = internal global i8 1, !dbg ${flag}`,
  );
  for (const name of ["left", "right", "public_entry"]) {
    const loc = { file: name === "public_entry" ? entry : shared, start: 0, end: 1 };
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
  // The hand-written LLVM definitions use the same linkage names as the
  // emitter's debug metadata, so dsymutil can resolve their addresses.
  for (const name of ["left", "right", "public_entry"])
    source = source.replaceAll(`@${name}`, `@${mangleFunction(name)}`);
  return source + debug.render();
}

test.runIf(process.platform === "darwin")(
  "merged debug maps retain authored and generated functions in their defining shards",
  async () => {
    const source = debugSample().replace(
      "attributes #0",
      `define internal i64 @generated_helper() {
entry:
  %flag = load i8, ptr @debug_flag
  %value = zext i8 %flag to i64
  ret i64 %value
}

attributes #0`,
    );
    const split = splitLlvmProgram(source, { minimumBytes: 0 })!;
    const dir = await mkdtemp(join(tmpdir(), "scriptc-debug-map-"));
    scratch.push(dir);
    const objects: string[] = [];
    for (const shard of split.shards) {
      const path = join(dir, shard.name);
      await writeFile(path, shard.source());
      const object = `${path}.o`;
      execFileSync("clang", ["-Wno-override-module", "-c", path, "-o", object]);
      objects.push(object);
    }
    const keep = join(dir, "keep.syms");
    await writeFile(keep, split.publicSymbols.map((name) => `_${name}\n`).join(""));
    const merged = join(dir, "merged.o");
    execFileSync("ld", ["-r", ...objects, "-o", merged, "-exported_symbols_list", keep]);
    await expectDarwinDebugMap(objects, merged, [
      ...["left", "right", "public_entry"].map(mangleFunction),
      "generated_helper",
      "debug_flag",
    ]);
    const main = join(dir, "main.c");
    const entry = mangleFunction("public_entry");
    await writeFile(main, `long long ${entry}(void); int main(void) { return ${entry}() != 18; }\n`);
    const binary = join(dir, "program");
    execFileSync("clang", [main, merged, "-o", binary]);
    const symbols = spawnSync("dsymutil", [binary], { encoding: "utf8" });
    expect(symbols.status, symbols.stderr).toBe(0);
    expect(symbols.stderr).toBe("");
    expect(spawnSync(binary).status).toBe(0);
    const debug = execFileSync(
      "lldb",
      [
        "--batch",
        binary,
        "-o",
        "breakpoint set --file shared.ts --line 1 --move-to-nearest-code false",
        "-o",
        "breakpoint set --file main.ts --line 1 --move-to-nearest-code false",
        "-o",
        "breakpoint list",
      ],
      { encoding: "utf8" },
    );
    expect(debug).not.toContain("pending");
    expect(debug).toContain("shared.ts:1");
    expect(debug).toContain("main.ts:1");
  },
);

test("shard CUs have distinct physical identities and preserve authored metadata", async () => {
  const source = debugSample('/source space é "quoted"/main.ts');
  const options = { minimumBytes: 0 };
  const split = splitLlvmProgram(source, options)!;
  const original = source.split("\n").filter((line) => line.startsWith("!"));
  const units = original.filter((line) => line.includes("distinct !DICompileUnit("));
  expect(units).toHaveLength(2);
  const files = new Set<string>();
  for (const shard of split.shards) {
    const text = shard.source();
    for (const line of original.filter((line) => !units.includes(line)))
      expect(text).toContain(line);
    expect(text.match(/distinct !DICompileUnit\(/g)).toHaveLength(units.length);
    for (const unit of units) {
      const id = unit.split(" = ")[0]!;
      const projected = text.split("\n").find((line) => line.startsWith(`${id} = `))!;
      expect(projected.replace(/file: !\d+/, "file: !source")).toBe(
        unit.replace(/file: !\d+/, "file: !source"),
      );
      const fileId = /file: (!\d+)/.exec(projected)![1];
      const file = text.split("\n").find((line) => line.startsWith(`${fileId} = `))!;
      expect(file).toContain(`-${shard.name}"`);
      const descriptor = file.slice(file.indexOf(" = ") + 3);
      expect(files.has(descriptor)).toBe(false);
      files.add(descriptor);
    }
  }
  const dir = await mkdtemp(join(tmpdir(), "scriptc-debug-split-identity-"));
  scratch.push(dir);
  const path = join(dir, "input.ll");
  await writeFile(path, source);
  expect(splitLlvmProgramFile(path, options)!.shards.map((shard) => shard.source())).toEqual(
    split.shards.map((shard) => shard.source()),
  );

  const edited = splitLlvmProgram(source.replace("global i64 7", "global i64 9"), options)!;
  expect(edited.shards[0]!.source()).not.toBe(split.shards[0]!.source());
  expect(edited.shards.slice(1).map((shard) => shard.source())).toEqual(
    split.shards.slice(1).map((shard) => shard.source()),
  );
  // Different entries can share the same dependency CU in the same bucket.
  const other = splitLlvmProgram(debugSample("/other/main.ts"), options)!;
  for (const shard of other.shards) {
    for (const file of files) expect(shard.source()).not.toContain(file);
  }
});

test("unrecognized debug file forms retain the canonical module fallback", () => {
  const source = debugSample().replace(
    '!DIFile(filename: "main.ts", directory: "/source")',
    '!DIFile(filename: "main.ts", directory: "/source", checksumkind: CSK_MD5, checksum: "000102030405060708090a0b0c0d0e0f")',
  );
  expect(splitLlvmProgram(source, { minimumBytes: 0 })).toBeNull();
});

test("debug metadata stays on definitions when splitting LLVM modules", async () => {
  const source = debugSample();
  const split = splitLlvmProgram(source, { minimumBytes: 0 });
  expect(split).not.toBeNull();
  const dir = await mkdtemp(join(tmpdir(), "scriptc-debug-split-"));
  scratch.push(dir);
  for (const shard of split!.shards) {
    expect(shard.source()).not.toMatch(/^declare.*!dbg/m);
    const path = join(dir, shard.name);
    await writeFile(path, shard.source());
    const result = spawnSync("clang", ["-Wno-override-module", "-c", path, "-o", `${path}.o`], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
  }
});

test("personality routines stay on definitions when splitting LLVM modules", async () => {
  // Functions with landing pads (Linux unwinding) carry a personality; every
  // other shard declares them, and a declaration must not repeat it.
  const source =
    SAMPLE.replaceAll(") #0 {", ") #0 personality ptr @__gcc_personality_v0 {") +
    "declare i32 @__gcc_personality_v0(...)\n";
  const split = splitLlvmProgram(source, { minimumBytes: 0 });
  expect(split).not.toBeNull();
  const dir = await mkdtemp(join(tmpdir(), "scriptc-personality-split-"));
  scratch.push(dir);
  for (const shard of split!.shards) {
    expect(shard.source()).not.toMatch(/^declare.* personality ptr/m);
    const path = join(dir, shard.name);
    await writeFile(path, shard.source());
    const result = spawnSync("clang", ["-Wno-override-module", "-c", path, "-o", `${path}.o`], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
  }
  expect(
    split!.shards.flatMap((shard) => [
      ...shard.source().matchAll(/^define .* personality ptr @__gcc_personality_v0 \{/gm),
    ]).length,
  ).toBe(3);
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
    await writeFile(source, shard.source());
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
