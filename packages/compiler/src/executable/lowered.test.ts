import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import type { CompileRequestOptions, CompileRequestResult } from "../compile-types.js";
import { compile } from "../index.js";
import type { IrModule } from "../ir/ir.js";
import {
  decodeLoweredProgram,
  encodeLoweredProgram,
  isLoweredProgram,
  loweredMismatches,
  loweringOptions,
  prepareLoweredProgram,
  usesLoweredProgram,
} from "./lowered.js";
import type { PreparedExecutableModule } from "./prepare.js";

const project = mkdtempSync(join(tmpdir(), "scriptc-lowered-"));
const entry = join(project, "src/main.ts");
const shapes = join(project, "src/shapes.ts");
const out = join(project, "out");
const lowered = join(project, "main.lowered");
let straight = "";

const SHAPES = `export interface Shape { name: string; sides: number }
export function describe(shape: Shape): string {
  return shape.name + " has " + String(shape.sides) + " sides";
}
`;

function llvmOptions(name: string, extra: Partial<CompileRequestOptions> = {}) {
  return {
    outDir: out,
    outPath: join(out, `${name}.ll`),
    outputKind: "llvm" as const,
    ...extra,
  };
}

async function build(
  name: string,
  extra: Partial<CompileRequestOptions> = {},
): Promise<CompileRequestResult> {
  return compile(entry, llvmOptions(name, extra));
}

function llvm(name: string): string {
  return readFileSync(join(out, `${name}.ll`), "utf8");
}

function messages(result: CompileRequestResult): string[] {
  if (result.ok) throw new Error("the build was expected to be refused");
  for (const diagnostic of result.diagnostics) expect(diagnostic.code).toBe("SC3002");
  return result.diagnostics.map((diagnostic) => diagnostic.message);
}

/** What the builds below wrote to stderr. */
function stderrLines(): string[] {
  return vi
    .mocked(process.stderr.write)
    .mock.calls.map((call) => String(call[0]))
    .filter((line) => line.startsWith("scriptc: "));
}

beforeAll(async () => {
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(shapes, SHAPES);
  writeFileSync(
    entry,
    `import { describe, type Shape } from "./shapes.js";
const all: Shape[] = [{ name: "triangle", sides: 3 }, { name: "square", sides: 4 }];
for (const shape of all) console.log(describe(shape));
console.log(0.1 + 0.2, -0, "\\ud83d");
`,
  );
  const first = await build("straight");
  if (!first.ok) throw new Error(first.diagnostics.map((d) => d.message).join("\n"));
  straight = llvm("straight");
  const emitted = await build("emitted", { emitLowered: lowered });
  expect(emitted.ok).toBe(true);
  // Writing the file leaves the build as it was.
  expect(llvm("emitted")).toBe(straight);
}, 120_000);

afterEach(() => {
  vi.restoreAllMocks();
  writeFileSync(shapes, SHAPES);
});

afterAll(() => {
  rmSync(project, { recursive: true, force: true });
});

test("a build from the file writes what a build from the sources writes", async () => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const resumed = await build("resumed", { fromLowered: lowered });
  expect(resumed.ok).toBe(true);
  expect(llvm("resumed")).toBe(straight);
  expect(stderrLines()).toEqual([]);
  // Another output path is not a difference.
  const elsewhere = await compile(entry, {
    outDir: join(project, "elsewhere"),
    outPath: join(project, "elsewhere/main.ll"),
    outputKind: "llvm",
    fromLowered: lowered,
  });
  expect(elsewhere.ok).toBe(true);
  expect(readFileSync(join(project, "elsewhere/main.ll"), "utf8")).toBe(straight);
}, 120_000);

test("the file holds the program, its sources and what it was lowered from", () => {
  const bytes = readFileSync(lowered);
  expect(isLoweredProgram(bytes)).toBe(true);
  const program = decodeLoweredProgram(bytes);
  expect(program.manifest).toMatchObject({
    schema: "scriptc.lowered.v1",
    entry,
    ffi: null,
    options: { outputKind: "llvm" },
    stable: true,
    warnings: [],
  });
  expect(program.manifest!.outputs).toContain(lowered);
  const read = program.inputs!.probes.filter((probe) => probe.op === "file");
  expect(read.map((probe) => probe.path)).toEqual(expect.arrayContaining([entry, shapes]));
  const { mod, sourceTexts } = program.rest();
  expect(mod.sourceFile).toBe(entry);
  expect(sourceTexts.get(shapes)).toBe(SHAPES);
});

test("a changed source refuses the file, and accepting it builds the old program", async () => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  writeFileSync(shapes, SHAPES.replace('sides"', 'edges"'));
  const refused = messages(await build("stale", { fromLowered: lowered }));
  expect(refused).toEqual([
    `--from-lowered: ${lowered} does not match this build's inputs: ${shapes} changed since it was lowered`,
  ]);
  const accepted = await build("stale", { fromLowered: lowered, fromLoweredAccept: ["inputs"] });
  expect(accepted.ok).toBe(true);
  expect(llvm("stale")).toBe(straight);
  expect(stderrLines()).toEqual([
    `scriptc: warning: --from-lowered: building from ${lowered} although its inputs differ: ${shapes} changed since it was lowered\n`,
  ]);
}, 120_000);

test("a file that appears where the frontend looked refuses the file", async () => {
  const added = join(project, "tsconfig.json");
  writeFileSync(added, "{}\n");
  try {
    expect(messages(await build("added", { fromLowered: lowered }))).toEqual([
      `--from-lowered: ${lowered} does not match this build's inputs: ${added} exists now since it was lowered`,
    ]);
  } finally {
    rmSync(added);
  }
}, 120_000);

test("a changed option or variable refuses the file by name", async () => {
  expect(
    messages(await build("option", { fromLowered: lowered, tier: "static-only", strip: false })),
  ).toEqual([
    `--from-lowered: ${lowered} does not match this build's options: the build that wrote it differs in option strip, option tier`,
  ]);
  vi.stubEnv("SCRIPTC_SHAPE_OVERLAY", "0");
  try {
    expect(messages(await build("variable", { fromLowered: lowered }))).toEqual([
      `--from-lowered: ${lowered} does not match this build's options: the build that wrote it differs in environment variable SCRIPTC_SHAPE_OVERLAY`,
    ]);
  } finally {
    vi.unstubAllEnvs();
  }
  // Variables that do not reach the frontend are not compared.
  vi.stubEnv("SCRIPTC_EMIT_WORKERS", "1");
  try {
    expect((await build("workers", { fromLowered: lowered })).ok).toBe(true);
  } finally {
    vi.unstubAllEnvs();
  }
}, 120_000);

test("the entry, the target platform and the FFI manifest are options too", () => {
  const program = decodeLoweredProgram(readFileSync(lowered));
  const manifest = program.manifest!;
  expect(loweredMismatches(program, manifest)).toEqual([]);
  expect(
    loweredMismatches(program, {
      ...manifest,
      entry: shapes,
      platform: "wasi",
      ffi: "0".repeat(64),
    }),
  ).toEqual([
    {
      kind: "options",
      detail: `the build that wrote it differs in the entry (${entry}), the target platform (${manifest.platform}), the FFI manifest`,
    },
  ]);
});

test("another build of the compiler refuses the file until it is accepted", async () => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const program = decodeLoweredProgram(readFileSync(lowered));
  const manifest = program.manifest!;
  const { mod, sourceTexts } = program.rest();
  const other = join(project, "other.lowered");
  writeFileSync(
    other,
    encodeLoweredProgram(
      {
        ok: true,
        mod,
        sourceTexts,
        stats: manifest.stats,
        warnings: manifest.warnings,
      },
      { ...manifest, compiler: "0123456789abcdef0123" },
      program.inputs!,
    ),
  );
  const [message] = messages(await build("compiler", { fromLowered: other }));
  expect(message).toMatch(
    /does not match this build's compiler: it was lowered by another build of the compiler \(0123456789ab; this one is [0-9a-f]{12}\)$/,
  );
  const accepted = await build("compiler", {
    fromLowered: other,
    fromLoweredAccept: ["compiler"],
  });
  expect(accepted.ok).toBe(true);
  expect(llvm("compiler")).toBe(straight);
  expect(stderrLines()).toHaveLength(1);
  expect(stderrLines()[0]).toContain("although its compiler differs");
}, 120_000);

test("every difference is reported, and each needs its own acceptance", async () => {
  writeFileSync(shapes, SHAPES + "\n");
  const refused = messages(await build("both", { fromLowered: lowered, tier: "static-only" }));
  expect(refused).toHaveLength(2);
  expect(refused[0]).toContain("this build's options");
  expect(refused[1]).toContain("this build's inputs");
  const half = messages(
    await build("both", {
      fromLowered: lowered,
      tier: "static-only",
      fromLoweredAccept: ["options"],
    }),
  );
  expect(half).toHaveLength(1);
  expect(half[0]).toContain("this build's inputs");
}, 120_000);

test("an IR artifact records nothing, so it builds only with every kind accepted", async () => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const artifact = join(out, "main.ir.json");
  const ir = await compile(entry, { outDir: out, outPath: artifact, outputKind: "ir" });
  expect(ir.ok).toBe(true);
  const refused = messages(await build("artifact", { fromLowered: artifact }));
  expect(refused.map((message) => message.slice(message.indexOf("this build's")))).toEqual([
    "this build's compiler: the file holds only an IR module, which does not record its compiler",
    "this build's options: the file holds only an IR module, which does not record its options",
    "this build's inputs: the file holds only an IR module, which does not record its inputs",
  ]);
  const all = ["compiler", "options", "inputs"];
  const accepted = await build("artifact", { fromLowered: artifact, fromLoweredAccept: all });
  expect(accepted.ok).toBe(true);
  expect(llvm("artifact")).toBe(straight);
  expect(stderrLines()).toHaveLength(3);
  // Line tables read the sources, which an IR module does not carry.
  const debug = messages(
    await build("artifact", {
      fromLowered: artifact,
      fromLoweredAccept: all,
      optimization: "dev",
    }),
  );
  expect(debug[0]).toContain("holds only an IR module, without the sources");
  // Another entry's module is never accepted.
  const [wrong] = messages(
    await compile(shapes, llvmOptions("wrong", { fromLowered: artifact, fromLoweredAccept: all })),
  );
  expect(wrong).toContain(`was lowered from another entry (${entry})`);
}, 120_000);

test("a file this compiler cannot read is refused whatever is accepted", async () => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const all = ["compiler", "options", "inputs"];
  const bytes = readFileSync(lowered);
  const damaged = join(project, "damaged.lowered");
  const refusedWith = async (content: Uint8Array): Promise<string> => {
    writeFileSync(damaged, content);
    const [message] = messages(
      await build("damaged", { fromLowered: damaged, fromLoweredAccept: all }),
    );
    expect(message).toContain(`--from-lowered: cannot read ${damaged}: `);
    return message!;
  };
  expect(await refusedWith(bytes.subarray(0, bytes.length - 9))).toContain("IR codec");
  expect(await refusedWith(bytes.subarray(0, 40))).toContain("IR codec");
  const format = Buffer.from(bytes);
  format[4] = 99;
  expect(await refusedWith(format)).toContain("it has format 99, and this compiler reads format 1");
  const layout = Buffer.from(bytes);
  // The layout digest follows the magic, the format byte and two length bytes.
  layout[7] = layout[7] === 0x30 ? 0x31 : 0x30;
  expect(await refusedWith(layout)).toMatch(/it holds IR version \d+ in layout [0-9a-f]{16}, and/);
  expect(await refusedWith(Buffer.from("not IR"))).toContain("cannot read");
  const [missing] = messages(await build("missing", { fromLowered: join(project, "none") }));
  expect(missing).toContain("ENOENT");
}, 120_000);

test("contradictory options are refused", async () => {
  expect(messages(await build("both", { emitLowered: lowered, fromLowered: lowered }))).toEqual([
    "--emit-lowered and --from-lowered cannot be combined: a build from a lowered program lowers nothing",
  ]);
  expect(messages(await build("accept", { fromLoweredAccept: ["compiler"] }))).toEqual([
    "--from-lowered-accept needs --from-lowered",
  ]);
});

test("an object whose keys the binary encoding would reorder reads back as it was", () => {
  const program = decodeLoweredProgram(readFileSync(lowered));
  const manifest = program.manifest!;
  const { mod, sourceTexts } = program.rest();
  const fn = mod.functions[0]!;
  const { name, ...rest } = fn;
  // A function with its keys in another order than the type declares, one
  // with a key the type does not declare, and a module whose own keys are
  // in another order.
  const { irVersion, ...fields } = mod;
  const shuffled = {
    ...fields,
    irVersion,
    functions: [{ ...rest, name }, { ...fn, undeclared: 1 }, ...mod.functions.slice(1)],
  } as IrModule;
  const bytes = encodeLoweredProgram(
    { ok: true, mod: shuffled, sourceTexts, stats: manifest.stats, warnings: [] },
    manifest,
    program.inputs!,
  );
  const back = decodeLoweredProgram(bytes).rest().mod;
  expect(JSON.stringify(back)).toBe(JSON.stringify(shuffled));
  expect(Object.keys(back).at(-1)).toBe("irVersion");
  expect(Object.keys(back.functions[0]!).at(-1)).toBe("name");
  expect(Object.keys(back.functions[1]!).at(-1)).toBe("undeclared");
});

test("a build without the options is the frontend's result, untouched", () => {
  const prepared: PreparedExecutableModule = {
    ok: true,
    mod: decodeLoweredProgram(readFileSync(lowered)).rest().mod,
    sourceTexts: new Map(),
    stats: { statementsTotal: 0, statementsFailed: 0, functionsSkipped: 0 },
    warnings: [],
  };
  const options: CompileRequestOptions = { outDir: out, outPath: join(out, "main") };
  expect(usesLoweredProgram(options)).toBe(false);
  const result = prepareLoweredProgram(
    entry,
    options,
    "linux",
    () => {
      throw new Error("no timing phase is reported");
    },
    {
      compiler: () => {
        throw new Error("the compiler's identity is not read");
      },
      outputs: [],
    },
    () => prepared,
  );
  expect(result).toBe(prepared);
});

test("the options lowering reads leave out the outputs and the file itself", () => {
  expect(
    loweringOptions({
      outDir: out,
      outPath: join(out, "main"),
      emitLowered: lowered,
      fromLowered: lowered,
      fromLoweredAccept: ["compiler"],
      tier: "static-only",
      sanitize: true,
    }),
  ).toEqual({ tier: "static-only", sanitize: true });
});
