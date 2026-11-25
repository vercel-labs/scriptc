/* A build from a lowered program (--emit-lowered, --from-lowered) against a
 * build from the sources: the same executable byte for byte, the same
 * warnings and islands, and a refusal when a source, an option or the
 * compiler changed since the program was lowered. The island program needs
 * a libnode pack (libnode.ts). */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test, vi } from "vitest";
import { compile, type CompileOptions } from "@scriptc/compiler";
import {
  decodeLoweredProgram,
  encodeLoweredProgram,
} from "../../packages/compiler/src/executable/lowered.js";
import { libnodePack } from "./libnode.js";

const execFileAsync = promisify(execFile);
// Outside the repository: a program under its node_modules is a package's.
const root = mkdtempSync(join(tmpdir(), "scriptc-lowered-program-"));
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const pack = libnodePack();
const scratch: string[] = [root];

afterAll(() => {
  for (const path of scratch) rmSync(path, { recursive: true, force: true });
});

function writeProject(name: string, files: Record<string, string>): string {
  const dir = join(root, name);
  rmSync(dir, { recursive: true, force: true });
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  return dir;
}

/** Builds `dir`'s program to `dir/main` with a build cache of its own and
 * returns the result with the executable's and the LLVM text's bytes. */
async function build(dir: string, extra: Partial<CompileOptions> = {}) {
  const cache = mkdtempSync(join(tmpdir(), "scriptc-lowered-cache-"));
  scratch.push(cache);
  const previous = process.env["SCRIPTC_CACHE_DIR"];
  process.env["SCRIPTC_CACHE_DIR"] = cache;
  try {
    const result = await compile(join(dir, "main.ts"), {
      outPath: join(dir, "main"),
      outDir: dir,
      sanitize,
      ...extra,
    });
    return {
      result,
      executable: result.ok ? readFileSync(join(dir, "main")) : Buffer.alloc(0),
      llvm: result.ok ? readFileSync(join(dir, "main.ll")) : Buffer.alloc(0),
    };
  } finally {
    if (previous === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
    else process.env["SCRIPTC_CACHE_DIR"] = previous;
  }
}

/** Whether two builds wrote the same program: the same LLVM text, and the
 * same executable byte for byte. A sanitized link is not reproducible (two
 * builds of one LLVM text differ), so there the LLVM text stands alone. */
function sameBuild(a: Awaited<ReturnType<typeof build>>, b: typeof a): boolean {
  return a.llvm.equals(b.llvm) && (sanitize || a.executable.equals(b.executable));
}

function refusals(result: Awaited<ReturnType<typeof build>>["result"]): string[] {
  if (result.ok) throw new Error("the build was expected to be refused");
  return result.diagnostics.map((d) => `${d.code}: ${d.message}`);
}

async function run(dir: string): Promise<string> {
  return (await execFileAsync(join(dir, "main"), [], { encoding: "utf8" })).stdout;
}

const MODULES = {
  "main.ts": `import { area, type Shape } from "./lib/shapes.js";
import { table } from "./lib/format.js";
const shapes: Shape[] = [
  { kind: "circle", radius: 2 },
  { kind: "rect", width: 3, height: 4 },
];
console.log(table(shapes.map((shape) => [shape.kind, area(shape).toFixed(2)])));
`,
  "lib/shapes.ts": `export type Shape =
  | { kind: "circle"; radius: number }
  | { kind: "rect"; width: number; height: number };
export function area(shape: Shape): number {
  return shape.kind === "circle" ? Math.PI * shape.radius ** 2 : shape.width * shape.height;
}
`,
  "lib/format.ts": `export function table(rows: string[][]): string {
  const width = Math.max(...rows.map((row) => row[0]!.length));
  return rows.map((row) => row[0]!.padEnd(width) + " " + row[1]!).join("\\n");
}
`,
};

test("a multi-module program builds from its lowered program to the same executable", async () => {
  const dir = writeProject("modules", MODULES);
  const lowered = join(dir, "main.lowered");
  const straight = await build(dir);
  if (!straight.result.ok) throw new Error(refusals(straight.result).join("\n"));
  expect(await run(dir)).toBe("circle 12.57\nrect   12.00\n");

  const emitted = await build(dir, { emitLowered: lowered });
  expect(emitted.result.ok).toBe(true);
  expect(sameBuild(emitted, straight)).toBe(true);

  const resumed = await build(dir, { fromLowered: lowered });
  expect(resumed.result.ok).toBe(true);
  expect(sameBuild(resumed, straight)).toBe(true);
  expect(resumed.result.ok && resumed.result.stats).toEqual(
    straight.result.ok && straight.result.stats,
  );
  expect(await run(dir)).toBe("circle 12.57\nrect   12.00\n");

  // A changed option.
  expect(refusals((await build(dir, { fromLowered: lowered, strip: true })).result)).toEqual([
    `SC3002: --from-lowered: ${lowered} does not match this build's options: the build that wrote it differs in option strip`,
  ]);
  // Another build of the compiler.
  const program = decodeLoweredProgram(readFileSync(lowered));
  const other = join(dir, "other.lowered");
  writeFileSync(
    other,
    encodeLoweredProgram(
      {
        ok: true,
        ...program.rest(),
        stats: program.manifest!.stats,
        warnings: program.manifest!.warnings,
      },
      { ...program.manifest!, compiler: "another build of the compiler" },
      program.inputs!,
    ),
  );
  const [compiler] = refusals((await build(dir, { fromLowered: other })).result);
  expect(compiler).toContain(`${other} does not match this build's compiler`);
  const warned = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const accepted = await build(dir, { fromLowered: other, fromLoweredAccept: ["compiler"] });
  warned.mockRestore();
  expect(accepted.result.ok).toBe(true);
  expect(sameBuild(accepted, straight)).toBe(true);
  // A changed source, last: the file no longer describes the sources.
  const edited = join(dir, "lib/format.ts");
  writeFileSync(edited, MODULES["lib/format.ts"].replace('" "', '"  "'));
  expect(refusals((await build(dir, { fromLowered: lowered })).result)).toEqual([
    `SC3002: --from-lowered: ${lowered} does not match this build's inputs: ${edited} changed since it was lowered`,
  ]);
  // The sources' program is another one.
  const rebuilt = await build(dir);
  expect(rebuilt.result.ok).toBe(true);
  expect(rebuilt.llvm.equals(straight.llvm)).toBe(false);
  expect(await run(dir)).toBe("circle  12.57\nrect    12.00\n");
}, 600_000);

describe.skipIf(pack === null)("with Node islands", () => {
  test("a program with a package island and a module island builds to the same executable", async () => {
    const dir = writeProject("islands", {
      ...MODULES,
      "main.ts": `import { area, type Shape } from "./lib/shapes.js";
import { table } from "./lib/format.js";
import { tally } from "tally";
import { legacy } from "./lib/legacy.cjs";
const shapes: Shape[] = [
  { kind: "circle", radius: 2 },
  { kind: "rect", width: 3, height: 4 },
];
console.log(table(shapes.map((shape) => [shape.kind, area(shape).toFixed(2)])));
console.log(tally(shapes.map((shape) => Math.round(area(shape)))), legacy("x"));
`,
      "lib/legacy.cjs": `exports.legacy = function (name) {
  with ({ suffix: "!" }) return name + suffix;
};
`,
      "lib/legacy.d.cts": "export declare function legacy(name: string): string;\n",
      "node_modules/tally/package.json": JSON.stringify({
        name: "tally",
        version: "1.0.0",
        main: "index.js",
        types: "index.d.ts",
      }),
      "node_modules/tally/index.js": `exports.tally = function (values) {
  return values.reduce((sum, value) => sum + value, 0);
};
`,
      "node_modules/tally/index.d.ts": "export declare function tally(values: number[]): number;\n",
    });
    const lowered = join(dir, "main.lowered");
    // The package is marked; the module is an island for its with statement.
    const options = { libnode: pack!, nodeIslands: { islands: ["tally"] } };
    const straight = await build(dir, options);
    if (!straight.result.ok) throw new Error(refusals(straight.result).join("\n"));
    expect(straight.result.islands?.packages).toEqual(["tally"]);
    expect(straight.result.islands?.modules).toEqual([join(dir, "lib/legacy.cjs")]);
    const output = await run(dir);
    expect(output).toBe("circle 12.57\nrect   12.00\n25 x!\n");

    const emitted = await build(dir, { ...options, emitLowered: lowered });
    expect(emitted.result.ok).toBe(true);
    expect(sameBuild(emitted, straight)).toBe(true);

    const resumed = await build(dir, { ...options, fromLowered: lowered });
    if (!resumed.result.ok) throw new Error(refusals(resumed.result).join("\n"));
    expect(sameBuild(resumed, straight)).toBe(true);
    // What the build reports: the islands and every warning, the island
    // notes among them.
    expect(resumed.result.islands).toEqual(straight.result.islands);
    expect(resumed.result.warnings).toEqual(straight.result.warnings);
    expect(resumed.result.warnings?.some((warning) => warning.code === "SC8001")).toBe(true);
    expect(await run(dir)).toBe(output);

    // An island's own file is an input the frontend read.
    const islandFile = join(dir, "node_modules/tally/index.js");
    writeFileSync(islandFile, readFileSync(islandFile, "utf8").replace(", 0)", ", 1)"));
    const [changed] = refusals((await build(dir, { ...options, fromLowered: lowered })).result);
    expect(changed).toContain("does not match this build's inputs");
    expect(changed).toContain(islandFile);
  }, 900_000);
});
