import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import type { IrModule } from "../src/ir/ir.js";
import { emitLlvmModuleSource, type LlvmTargetOptions } from "../src/backend/llvm/emitter.js";
import { inlineRcOption } from "../src/backend/llvm/shapes.js";

// Programs whose function bodies request module-level helpers and tables
// that the chunk journal (emit-journal.ts) carries: checked-dynamic
// conversions (with their discriminant tables), inspection, publication
// walkers, live record views, stream adapters, regex instances, colliding
// literal digests, interned C strings, speculative loop sites, typed message
// listeners and readers.
const PROGRAMS = [
  "1003-json-parse-unions.ts",
  "114-live-record-delete.ts",
  "1200-regex-test-basics.ts",
  "1631-inspect-arrays.ts",
  "4598-publish-constructor-stores.ts",
  "4900-console-instances.ts",
  "5612-readable-from-iterables.cjs",
  "5702-publish-candidate-buffers.ts",
  "6305-json-discriminant-dispatch.ts",
  "7321-speculative-loop-bail-sites.ts",
  "7360-worker-typed-records.ts",
  "7110-als-completion-callbacks.ts",
  "node24-text-utilities-coercion.js",
];

const OPTIONS: Record<string, LlvmTargetOptions> = {
  release: {},
  speed: {
    targetTriple: "x86_64-unknown-linux-gnu",
    pointerBits: 64,
    runtimeAbiMarker: true,
    lowRegion: true,
    ...inlineRcOption("speed", false),
  },
};

const text = (out: string | readonly string[]): string =>
  typeof out === "string" ? out : out.join("");

async function lower(program: string, dir: string): Promise<string> {
  const entry = join(import.meta.dirname, "../../../tests/corpus", program);
  const outPath = join(dir, `${program}.ir.json`);
  const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
  if (!result.ok)
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  return readFile(outPath, "utf8");
}

test("function bodies emitted in chunks merge into the text one emitter gives", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-chunked-emission-"));
  try {
    for (const program of PROGRAMS) {
      const ir = await lower(program, dir);
      const fresh = (): IrModule => deserializeModule(ir);
      for (const [name, options] of Object.entries(OPTIONS)) {
        const serial = text(emitLlvmModuleSource(fresh(), options));
        for (const functionChunks of [3, 7]) {
          const chunked = text(emitLlvmModuleSource(fresh(), { ...options, functionChunks }));
          expect(chunked === serial, `${program}, ${name}, ${functionChunks} chunks`).toBe(true);
        }
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 600_000);

// Thunks a range creates are journaled, so the merging emitter defines
// them: here Promise.all's tuple adapter, requested by a function that is
// not async (async functions are emitted again when the merging emitter
// selects stackless bodies).
test("a Promise.all tuple adapter requested in a range is defined", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-chunked-tuple-"));
  try {
    const entry = join(dir, "main.ts");
    await writeFile(
      entry,
      [
        "function both(a: Promise<number>, b: Promise<string>): Promise<[number, string]> {",
        "  return Promise.all([a, b]);",
        "}",
        'both(Promise.resolve(1), Promise.resolve("x")).then((v) => console.log(v[0], v[1]));',
        "",
      ].join("\n"),
    );
    const outPath = join(dir, "main.ir.json");
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const ir = await readFile(outPath, "utf8");
    const serial = text(emitLlvmModuleSource(deserializeModule(ir), {}));
    // The adapter is named from its key (contentSymbol).
    expect(serial).toMatch(/define internal void @sc_all_tuple_\d+\(/);
    const chunked = text(emitLlvmModuleSource(deserializeModule(ir), { functionChunks: 2 }));
    expect(chunked === serial).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);

// Debug builds journal their metadata requests (debug-info.ts): ranges
// merged in function order number every node as one emitter does.
const DEBUG_PROGRAMS: { entry: string; sources: string[] }[] = [
  {
    entry: "3066-source-debugging/main.ts",
    sources: ["3066-source-debugging/main.ts", "3066-source-debugging/helper.ts"],
  },
  ...[
    "1020-async-basics.ts",
    "7103-fiberless-plain-calls.ts",
    "7110-als-completion-callbacks.ts",
    "1301-errors-subclass.ts",
    "1529-class-with-statics.ts",
    "1591-js-closures.js",
    "2010-generators-basics.ts",
    "2013-generators-sent-values.ts",
    "4451-int32-field-storage.ts",
  ].map((program) => ({ entry: program, sources: [program] })),
];

test("debug builds emitted in ranges merge into the text one emitter gives", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-chunked-debug-"));
  const minFunctions = process.env["SCRIPTC_EMIT_WORKER_FUNCTIONS"];
  try {
    const corpus = join(import.meta.dirname, "../../../tests/corpus");
    for (const program of DEBUG_PROGRAMS) {
      const outPath = join(dir, "main.ir.json");
      const result = await compile(join(corpus, program.entry), {
        outDir: dir,
        outPath,
        outputKind: "ir",
        optimization: "dev",
      });
      if (!result.ok)
        throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      const ir = await readFile(outPath, "utf8");
      const debugSources = new Map<string, string>();
      for (const name of program.sources)
        debugSources.set(join(corpus, name), await readFile(join(corpus, name), "utf8"));
      const options: LlvmTargetOptions = { debugSources };
      const serial = text(emitLlvmModuleSource(deserializeModule(ir), options));
      expect(serial, program.entry).toContain("!DILocation");

      // A fork that fails leaves every range to the merging emitter.
      process.env["SCRIPTC_EMIT_WORKER_FUNCTIONS"] = "1";
      const forkPrimitives = {
        fork: (): number => -1,
        exit: (): void => {},
        wait: (): number => -1,
      };
      for (const variant of [
        { functionChunks: 2 },
        { functionChunks: 5 },
        { functionWorkers: 4, forkPrimitives },
      ] satisfies LlvmTargetOptions[]) {
        const emitted = text(
          emitLlvmModuleSource(deserializeModule(ir), { ...options, ...variant }),
        );
        expect(emitted === serial, `${program.entry} ${JSON.stringify(Object.keys(variant))}`).toBe(
          true,
        );
        const defined = new Set([...emitted.matchAll(/^(![0-9]+) = /gm)].map((m) => m[1]));
        const referenced = new Set([...emitted.matchAll(/(![0-9]+)\b/g)].map((m) => m[1]));
        expect([...referenced].filter((id) => !defined.has(id))).toEqual([]);
      }
      if (minFunctions === undefined) delete process.env["SCRIPTC_EMIT_WORKER_FUNCTIONS"];
      else process.env["SCRIPTC_EMIT_WORKER_FUNCTIONS"] = minFunctions;
    }
  } finally {
    if (minFunctions === undefined) delete process.env["SCRIPTC_EMIT_WORKER_FUNCTIONS"];
    else process.env["SCRIPTC_EMIT_WORKER_FUNCTIONS"] = minFunctions;
    await rm(dir, { recursive: true, force: true });
  }
}, 300_000);

// A method name holding a double quote is written into a comment after the
// function's `!dbg` attachment; the rename of the range's debug ids reads
// comments and string literals as ending at the end of their line.
test("debug ids after a comment that holds a quote are renamed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-chunked-debug-quote-"));
  try {
    const entry = join(dir, "main.ts");
    const source = [
      "class Greeter {",
      "  ['say \"hi'](n: number): number {",
      "    return n + 1;",
      "  }",
      "}",
      "const greeter = new Greeter();",
      "function twice(x: number): number {",
      "  return x * 2;",
      "}",
      "function report(label: string, value: number): void {",
      "  console.log(label, value);",
      "}",
      'report("method", greeter[\'say "hi\'](1));',
      'report("twice", twice(3));',
      "",
    ].join("\n");
    await writeFile(entry, source);
    const outPath = join(dir, "main.ir.json");
    const result = await compile(entry, {
      outDir: dir,
      outPath,
      outputKind: "ir",
      optimization: "dev",
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const ir = await readFile(outPath, "utf8");
    const options: LlvmTargetOptions = { debugSources: new Map([[entry, source]]) };
    const serial = text(emitLlvmModuleSource(deserializeModule(ir), options));
    expect(serial).toMatch(/!dbg ![0-9]+ \{ ;[^\n]*"/);
    for (const functionChunks of [2, 3]) {
      const chunked = text(
        emitLlvmModuleSource(deserializeModule(ir), { ...options, functionChunks }),
      );
      expect(chunked === serial, `${functionChunks} chunks`).toBe(true);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
