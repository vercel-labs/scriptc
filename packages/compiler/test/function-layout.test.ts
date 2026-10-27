import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { expect, test, vi } from "vitest";
import { compile } from "../src/index.js";
import {
  functionLayoutKey,
  layoutTierOf,
  parseFunctionLayout,
} from "../src/backend/llvm/function-layout.js";

const source = `
function first(n: number): number { return n + 1; }
function second(n: number): number { return n * 2; }
function third(n: number): number { return n - 3; }
console.log(first(Number(process.argv.length)), second(4), third(5));
`;

async function emitLlvm(layout?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-function-layout-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ll");
    await writeFile(entry, source);
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
  const layout = parseFunctionLayout("1 sc_f_a\n2 sc_f_a\n2 sc_f_b\nnot a line\n0 sc_f_c\n\n");
  expect([...layout]).toEqual([
    ["sc_f_a", 1],
    ["sc_f_b", 2],
  ]);
  const text =
    "define internal void @sc_f_b() {\n  ret void\n}\n\ndefine void @sc_f_a() {\n  ret void\n}";
  expect(layoutTierOf(layout, text)).toBe(1);
  expect(layoutTierOf(layout, "define void @sc_f_z() {\n  ret void\n}")).toBeUndefined();
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
