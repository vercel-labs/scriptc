import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { expect, test, vi } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import { emitLlvmModuleSource } from "../src/backend/llvm/emitter.js";
import {
  firstReachRanks,
  functionLayoutKey,
  hasStartupTier,
  layoutTierOf,
  parseFunctionLayout,
  startupCalleesOf,
  startupSymbolsOf,
} from "../src/backend/llvm/function-layout.js";

const source = `
function first(n: number): number { return n + 1; }
function second(n: number): number { return n * 2; }
function third(n: number): number { return n - 3; }
console.log(first(Number(process.argv.length)), second(4), third(5));
`;

async function emitLlvm(layout?: string, program = source): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-function-layout-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ll");
    await writeFile(entry, program);
    let functionLayout: string | undefined;
    if (layout !== undefined) {
      functionLayout = join(dir, "layout.gz");
      await writeFile(functionLayout, gzipSync(layout));
    }
    const result = await compile(entry, {
      outDir: dir,
      outPath,
      outputKind: "llvm",
      ...(functionLayout === undefined ? {} : { functionLayout }),
    });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    return await readFile(outPath, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Each defined function's name with the partition group line it follows. */
function definitions(llvm: string): { name: string; group: string }[] {
  const out: { name: string; group: string }[] = [];
  let group = "";
  for (const line of llvm.split("\n")) {
    if (line.startsWith("; scriptc-group")) group = line.slice("; scriptc-group".length).trim();
    const name = /^define [^@]*@([\w.$]+)\(/.exec(line)?.[1];
    if (name !== undefined) out.push({ name, group });
  }
  return out;
}

test("a layout writes the functions it lists first, by tier, in their tier's group", async () => {
  const plain = definitions(await emitLlvm()).filter((d) => /_(first|second|third)$/.test(d.name));
  expect(plain.map((d) => d.name.replace(/^sc_b?f_/, ""))).toEqual(["first", "second", "third"]);
  expect(plain.every((d) => !d.group.startsWith("layout-"))).toBe(true);

  const names = new Map(plain.map((d) => [d.name.replace(/^sc_b?f_/, ""), d.name]));
  const laid = definitions(await emitLlvm(`2 ${names.get("first")}\n1 ${names.get("third")}\n`));
  const index = (fn: string) => laid.findIndex((d) => d.name === names.get(fn));
  expect(index("third")).toBeLessThan(index("first"));
  expect(index("first")).toBeLessThan(index("second"));
  expect(laid[index("third")]!.group).toBe("layout-1");
  expect(laid[index("first")]!.group).toBe("layout-2");
  expect(laid[index("second")]!.group).not.toMatch(/^layout-/);
  // Listed functions precede every unlisted definition in the function section.
  const firstUnlisted = laid.findIndex(
    (d, i) => i > index("third") && !d.group.startsWith("layout-"),
  );
  expect(firstUnlisted).toBeGreaterThan(index("first"));
});

test("layout keys leave out module numbers", () => {
  expect(functionLayoutKey("sc_bf__x25_m447_lowerCall")).toBe(
    functionLayoutKey("sc_bf__x25_m12_lowerCall"),
  );
  expect(functionLayoutKey("sc_f__x25_init_253")).toBe(functionLayoutKey("sc_f__x25_init_7"));
  expect(functionLayoutKey("sc_bf__x25_m3_Lexer_scan")).not.toBe(
    functionLayoutKey("sc_bf__x25_m3_Lexer_peek"),
  );
});

test("a function listed twice keeps its first tier, and malformed lines are skipped", () => {
  const layout = parseFunctionLayout(
    "1 sc_f_a\n2 sc_f_a\n2 sc_f_b\nnot a line\n-1 sc_f_d\n0 sc_f_c\n0 sc_f_b\n\n",
  );
  expect([...layout]).toEqual([
    ["sc_f_a", 1],
    ["sc_f_b", 2],
    ["sc_f_c", 0],
  ]);
  const text =
    "define internal void @sc_f_b() {\n  ret void\n}\n\ndefine void @sc_f_a() {\n  ret void\n}";
  expect(layoutTierOf(layout, text)).toBe(1);
  expect(layoutTierOf(layout, "define void @sc_f_z() {\n  ret void\n}")).toBeUndefined();
  expect(hasStartupTier(layout)).toBe(true);
  expect(hasStartupTier(parseFunctionLayout("1 sc_f_a"))).toBe(false);
});

test("the start-up walk ranks the functions a run reaches first, by depth", () => {
  const defined = (symbol: string, calls: string[] = []): string =>
    [
      `define internal double @${symbol}(double %p) #0 { ; ${symbol}`,
      ...calls.map((callee) => `  %a = call double @${callee}(double %p)`),
      "  ret double %p",
      "}",
    ].join("\n");
  // The entry reaches c, then b, then a, whatever order the texts come in.
  const texts = [defined("sc_f_a"), defined("sc_f_b", ["sc_f_a"]), defined("sc_f_c", ["sc_f_b"])];
  expect(firstReachRanks(texts, [defined("sc_f__x25_main", ["sc_f_c"])])).toEqual([2, 1, 0]);
  // An entry among the texts is a root itself.
  expect(firstReachRanks([...texts, defined("sc_f__x25_main", ["sc_f_a"])])).toEqual([
    1,
    Infinity,
    Infinity,
    0,
  ]);
  // A walk that reaches nothing keeps the texts' order.
  expect(firstReachRanks(texts)).toEqual([Infinity, Infinity, Infinity]);
});

test("a module's start-up symbols are the ones its marker line lists", () => {
  expect(startupSymbolsOf("define void @f() {\n}\n\n; scriptc-startup sc_f_b sc_f_a")).toEqual([
    "sc_f_b",
    "sc_f_a",
  ]);
  expect(startupSymbolsOf(["; scriptc-group\n", "; scriptc-startup sc_f_a\n"])).toEqual(["sc_f_a"]);
  expect(startupSymbolsOf("define void @f() {\n}")).toEqual([]);
});

test("the runtime-pack functions start-up definitions call are named, in first-call order", () => {
  const texts = [
    [
      "declare void @scr_arr_new(ptr)",
      "declare void @scr_str_concat(ptr, ptr)",
      "declare void @snprintf(ptr)",
      'define internal void @sc_f_a() section ".text.startup" {',
      "  call void @scr_str_concat(ptr null, ptr null)",
      "  call void @scr_arr_new(ptr null)",
      "  call void @sc_f_b()",
      "  call void @scr_str_concat(ptr null, ptr null)",
      "  call void @snprintf(ptr null)",
      "  ret void",
      "}",
      "define internal void @sc_f_b() {",
      "  call void @scr_arr_new(ptr null)",
      "  ret void",
      "}",
    ].join("\n"),
  ];
  // scr_str_concat and scr_arr_new once each, in the order the start-up
  // definition calls them: scr_f_b is defined here, snprintf is the C library's.
  expect(startupCalleesOf(texts)).toEqual(["scr_str_concat", "scr_arr_new"]);
  // A definition outside the start-up section names nothing.
  expect(startupCalleesOf([texts[0]!.replace(' section ".text.startup"', "")])).toEqual([]);
});

test("an executable built with a layout that lists helpers and functions runs unchanged", async () => {
  const program = `
class Point { constructor(public x: number, public y: number) {} }
function norm(p: Point): number { return Math.sqrt(p.x * p.x + p.y * p.y); }
const points = [new Point(3, 4), new Point(6, 8)];
console.log(points.map(norm).join(","), points[0]!.x === 3 ? "three" : "other");
`;
  const dir = await mkdtemp(join(tmpdir(), "scriptc-function-layout-exe-"));
  try {
    const entry = join(dir, "main.ts");
    await writeFile(entry, program);
    const llvmPath = join(dir, "main.ll");
    const emitted = await compile(entry, { outDir: dir, outPath: llvmPath, outputKind: "llvm" });
    expect(emitted.ok, JSON.stringify(emitted.diagnostics)).toBe(true);
    // The generated helpers written before the functions, and one function,
    // in two tiers.
    const names = definitions(await readFile(llvmPath, "utf8")).map((d) => d.name);
    const helpers = names.slice(
      0,
      names.findIndex((name) => /^sc_b?f_/.test(name)),
    );
    expect(helpers.length).toBeGreaterThan(0);
    const norm = names.find((name) => /^sc_b?f_norm$/.test(name))!;
    const layout = join(dir, "layout");
    await writeFile(layout, [`1 ${norm}`, ...helpers.map((name) => `2 ${name}`)].join("\n"));
    const laid = join(dir, "laid.ll");
    const laidOut = await compile(entry, {
      outDir: dir,
      outPath: laid,
      outputKind: "llvm",
      functionLayout: layout,
    });
    expect(laidOut.ok, JSON.stringify(laidOut.diagnostics)).toBe(true);
    const order = definitions(await readFile(laid, "utf8"));
    expect(order.filter((d) => d.group === "layout-2").map((d) => d.name)).toEqual(helpers);
    expect(order.find((d) => d.name === norm)!.group).toBe("layout-1");
    const exe = join(dir, "main");
    const built = await compile(entry, {
      outputKind: "exe",
      outDir: dir,
      outPath: exe,
      functionLayout: layout,
    });
    expect(built.ok, JSON.stringify(built.diagnostics)).toBe(true);
    expect(execFileSync(exe, { encoding: "utf8" })).toBe("5,10 three\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the start-up tier runs its functions first, in first-reach order, in their own section", async () => {
  const chain = `
function third(n: number): number { return n <= 1 ? 1 : n * third(n - 1); }
function second(n: number): number { return third(n) + 1; }
function first(n: number): number { return second(n) * 2; }
console.log(first(Number(process.argv.length) + 3));
`;
  const named = (llvm: string): Map<string, string> =>
    new Map(
      definitions(llvm)
        .map((d) => [d.name, /_(first|second|third)$/.exec(d.name)?.[1]] as const)
        .filter((entry): entry is readonly [string, string] => entry[1] !== undefined)
        .map(([name, short]) => [short, name]),
    );
  const plain = named(await emitLlvm(undefined, chain));
  expect([...plain.keys()].sort()).toEqual(["first", "second", "third"]);
  // The layout lists the start-up functions in reverse of the order a run
  // reaches them: the walk decides the order, the layout only the tier.
  const laid = await emitLlvm(
    ["third", "second", "first"].map((name) => `0 ${plain.get(name)}`).join("\n"),
    chain,
  );
  // The walk orders the tier on every platform. The section attribute and the
  // marker line that carries the symbols to the link plan are how an ELF link
  // is told, so those are asserted where the emitter writes them.
  const startup = ["first", "second", "third"].map((name) => plain.get(name)!);
  const laidOut = definitions(laid);
  expect(laidOut.map((d) => d.name).filter((name) => startup.includes(name))).toEqual(startup);
  for (const name of startup) {
    expect(laidOut.find((d) => d.name === name)!.group, name).toBe("layout-0");
  }
  if (process.platform === "linux") {
    expect(startupSymbolsOf(laid)).toEqual(startup);
    for (const name of startup) {
      const header = new RegExp(`^define [^\\n]*@${name}\\([^\\n]*$`, "m").exec(laid)?.[0];
      expect(header, name).toContain('section ".text.startup"');
    }
  }
});

// The Darwin and Windows builds emit the same order without the section, since
// that flag is the emitter's, not the target triple's. This runs that path on
// every host rather than only where the platform skips the section.
test("a start-up tier without the ELF section keeps the order and writes no marker", async () => {
  const chain = `
function third(n: number): number { return n <= 1 ? 1 : n * third(n - 1); }
function second(n: number): number { return third(n) + 1; }
function first(n: number): number { return second(n) * 2; }
console.log(first(Number(process.argv.length) + 3));
`;
  const dir = await mkdtemp(join(tmpdir(), "scriptc-function-layout-startup-plain-"));
  try {
    const entry = join(dir, "main.ts");
    await writeFile(entry, chain);
    const irPath = join(dir, "main.ir.json");
    const lowered = await compile(entry, { outDir: dir, outPath: irPath, outputKind: "ir" });
    expect(lowered.ok, JSON.stringify(lowered.diagnostics)).toBe(true);
    const names = definitions(await emitLlvm(undefined, chain)).map((d) => d.name);
    const startup = ["first", "second", "third"].map((short) =>
      names.find((name) => new RegExp(`_${short}$`).test(name))!,
    );
    const emitted = emitLlvmModuleSource(deserializeModule(await readFile(irPath, "utf8")), {
      pointerBits: 64,
      functionLayout: parseFunctionLayout(startup.map((name) => `0 ${name}`).join("\n")),
      startupSection: false,
    });
    const laid = typeof emitted === "string" ? emitted : emitted.join("");
    expect(
      definitions(laid)
        .map((d) => d.name)
        .filter((name) => startup.includes(name)),
    ).toEqual(startup);
    expect(startupSymbolsOf(laid)).toEqual([]);
    for (const name of startup) {
      const header = new RegExp(`^define [^\\n]*@${name}\\([^\\n]*$`, "m").exec(laid)?.[0];
      expect(header, name).toBeDefined();
      expect(header, name).not.toContain('section ".text.startup"');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "linux")(
  "an executable places its start-up code before the rest of the text",
  async () => {
    const chain = `
function third(n: number): number { return n <= 1 ? 1 : n * third(n - 1); }
function second(n: number): number { return third(n) + 1; }
function first(n: number): number { return second(n) * 2; }
console.log(first(Number(process.argv.length) + 3));
`;
    const dir = await mkdtemp(join(tmpdir(), "scriptc-function-layout-startup-"));
    try {
      const entry = join(dir, "main.ts");
      await writeFile(entry, chain);
      const llvmPath = join(dir, "main.ll");
      const emitted = await compile(entry, { outDir: dir, outPath: llvmPath, outputKind: "llvm" });
      expect(emitted.ok, JSON.stringify(emitted.diagnostics)).toBe(true);
      const names = definitions(await readFile(llvmPath, "utf8")).map((d) => d.name);
      const startup = ["first", "second", "third"].map((short) =>
        names.find((name) => new RegExp(`_${short}$`).test(name))!,
      );
      const layout = join(dir, "layout");
      await writeFile(layout, startup.map((name) => `0 ${name}`).join("\n"));
      // The text's start address and the entry's, as the toolchain reports
      // them: a build that places nothing before the entry has them equal.
      const codeStart = (path: string): number => {
        const table = execFileSync("objdump", ["-h", path], { encoding: "utf8" });
        // Idx Name Size VMA LMA FileOff Algn.
        const text = table.split("\n").find((line) => /^ *\d+ \.text\b/.test(line))!;
        return Number.parseInt(text.trim().split(/\s+/)[3]!, 16);
      };
      const start = (path: string): number => {
        const symbols = execFileSync("nm", ["-n", path], { encoding: "utf8" });
        const entry = symbols.split("\n").find((line) => line.endsWith(" _start"))!;
        return Number.parseInt(entry.split(/\s+/)[0]!, 16);
      };
      const plainExe = join(dir, "plain");
      const laidExe = join(dir, "laid");
      for (const [outPath, functionLayout] of [
        [plainExe, undefined],
        [laidExe, layout],
      ] as const) {
        const built = await compile(entry, {
          outputKind: "exe",
          outDir: dir,
          outPath,
          ...(functionLayout === undefined ? {} : { functionLayout }),
        });
        expect(built.ok, JSON.stringify(built.diagnostics)).toBe(true);
      }
      expect(start(plainExe)).toBe(codeStart(plainExe));
      expect(start(laidExe)).toBeGreaterThan(codeStart(laidExe));
      expect(execFileSync(laidExe, { encoding: "utf8" })).toBe(
        execFileSync(plainExe, { encoding: "utf8" }),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("a changed function layout misses the executable cache", async () => {
  vi.stubEnv("SCRIPTC_NO_CACHE", undefined);
  const dir = await mkdtemp(join(tmpdir(), "scriptc-function-layout-cache-"));
  try {
    vi.stubEnv("SCRIPTC_CACHE_DIR", join(dir, "cache"));
    const entry = join(dir, "main.ts");
    await writeFile(entry, source);
    const exe = join(dir, "main");
    const llvm = join(dir, "main.ll");
    const build = async (functionLayout?: string) => {
      const built = await compile(entry, {
        outputKind: "exe",
        outDir: dir,
        outPath: exe,
        ...(functionLayout === undefined ? {} : { functionLayout }),
      });
      expect(built.ok, JSON.stringify(built.diagnostics)).toBe(true);
      return definitions(await readFile(llvm, "utf8"));
    };
    const plain = await build();
    const third = plain.find((d) => /^sc_b?f_third$/.test(d.name))!.name;
    const first = plain.find((d) => /^sc_b?f_first$/.test(d.name))!.name;
    const layout = join(dir, "layout");
    await writeFile(layout, `1 ${third}\n`);
    expect((await build(layout)).find((d) => d.name === third)!.group).toBe("layout-1");
    // The same path with other contents is another layout.
    await writeFile(layout, `1 ${first}\n`);
    const edited = await build(layout);
    expect(edited.find((d) => d.name === first)!.group).toBe("layout-1");
    expect(edited.find((d) => d.name === third)!.group).not.toMatch(/^layout-/);
  } finally {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the entry line precedes only the entry module's top-level code", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-partition-entry-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ll");
    await writeFile(
      join(dir, "lib.ts"),
      `function libOnly(n: number): number { return n * 2; }
export function libValue(): number { return libOnly(Number(process.argv.length)); }
console.log("lib");
`,
    );
    await writeFile(
      entry,
      `import { libValue } from "./lib";
function entryOnly(n: number): number { return n + 1; }
console.log(entryOnly(libValue()));
`,
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "llvm" });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    const lines = (await readFile(outPath, "utf8")).split("\n");
    const marked: string[] = [];
    let pending = false;
    for (const line of lines) {
      if (line === "; scriptc-entry") pending = true;
      const name = /^define [^@]*@([\w.$]+)\(/.exec(line)?.[1];
      if (name !== undefined) {
        if (pending) marked.push(name);
        pending = false;
      }
    }
    expect(marked).toHaveLength(1);
    const defs = definitions(lines.join("\n"));
    const groupOf = (pattern: RegExp) => defs.find((d) => pattern.test(d.name))?.group;
    expect(marked[0]).toMatch(/init/);
    expect(groupOf(new RegExp(`^${marked[0]!.replace(/[.$]/g, "\\$&")}$`))).toBe(
      groupOf(/_entryOnly$/),
    );
    expect(groupOf(/_entryOnly$/)).not.toBe(groupOf(/_libOnly$/));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
