import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import {
  compile,
  compileC,
  deserializeModule,
  emitLlvmModule,
  serializeModule,
  validateModule,
  type AnalyzeResult,
} from "@scriptc/compiler";
import { everyStmtList } from "../../packages/compiler/src/ir/traverse.js";
import { type IrModule } from "../../packages/compiler/src/ir/ir.js";
import { moduleLinkFeatures } from "./link-features.js";
import { backendAnalysisCases } from "./self-hosting-backend-cases.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const entry = join(root, "tests/fixtures/self-hosting/backend-analysis.ts");
const options = { cwd: root, timeout: 30_000, maxBuffer: 32 * 1024 * 1024 };
const execFileAsync = promisify(execFile);
interface Analysis {
  mayThrow: string[];
  indirect: boolean;
  tracedShapes: string[];
  tracedUnions: string[];
  tables: { id: string; symbol: string; values: string[] }[];
  loops: { fn: string; localId: string; receiver: string }[];
}

function counts(mod: IrModule): { calls: number; reads: number; records: number } {
  const out = { calls: 0, reads: 0, records: 0 };
  for (const fn of mod.functions) {
    for (const local of fn.locals) if (local.type.kind === "record") out.records++;
    everyStmtList(fn.body, {
      stmt: () => true,
      expr: (expr) => {
        if (expr.kind === "call" && expr.type.kind === "record") out.calls++;
        if (expr.kind === "recordGet") out.reads++;
        return true;
      },
    });
  }
  return out;
}

test("the production optimization and backend analysis pipeline lowers entirely statically", async () => {
  // Lowering this entire stage is synchronous and can outlast Vitest's
  // status-RPC timeout. Keep its worker responsive while the child lowers
  // the same source API; compiler failures still fail the awaited process.
  const sourceApi = pathToFileURL(join(root, "packages/compiler/src/index.ts")).href;
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `import { analyze } from ${JSON.stringify(sourceApi)};
     const { coverage } = analyze(process.argv[1], {});
     console.log(JSON.stringify({ preflightFailed: coverage.preflightFailed, diagnostics: coverage.diagnostics, stats: coverage.stats }));`,
      entry,
    ],
    { ...options, timeout: 180_000 },
  );
  const coverage = JSON.parse(stdout) as AnalyzeResult["coverage"];
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.diagnostics).toEqual([]);
  expect(coverage.stats.statementsTotal).toBeGreaterThan(3800);
  expect(coverage.stats.statementsFailed).toBe(0);
  expect(coverage.stats.functionsSkipped).toBe(0);
});

for (const backend of ["llvm"] as const) {
  test(`self-hosting backend analysis and optimization (${backend})`, async () => {
    const dir = mkdtempSync(
      join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-native-analysis-"),
    );
    const sanitize = process.env["SCRIPTC_SAN"] === "1";
    const executable = (name: string): string =>
      join(dir, name + (process.platform === "win32" ? ".exe" : ""));
    try {
      const built = await compile(entry, {
        outDir: dir,
        outPath: executable("stage"),
        backend,
        optimization: "dev",
        sanitize,
      });
      if (!built.ok)
        throw new Error(built.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      expect(built.backend).toBe(backend);
      const run = (mod: IrModule, mode: string, name: string) => {
        const path = join(dir, "input.json");
        writeFileSync(path, serializeModule(mod));
        const oracle = spawnSync(process.execPath, ["--import", "tsx", entry, path, mode], options);
        const native = spawnSync(built.binaryPath, [path, mode], options);
        for (const result of [oracle, native]) {
          expect(result.error, name).toBeUndefined();
          expect(result.signal, name).toBeNull();
          expect(result.status, `${name}: ${result.stdout}\n${result.stderr}`).toBe(0);
          expect(result.stderr.toString(), name).toBe("");
        }
        return { oracle: oracle.stdout.toString(), native: native.stdout.toString() };
      };
      for (const item of backendAnalysisCases()) {
        const result = run(item.module, "analysis", item.name);
        const actual = JSON.parse(result.native) as Analysis;
        expect(actual, item.name).toEqual(JSON.parse(result.oracle));
        if (item.mayThrow) expect(actual.mayThrow, item.name).toEqual(item.mayThrow);
        if (item.indirect !== undefined) expect(actual.indirect, item.name).toBe(item.indirect);
        if (item.shapes) expect(actual.tracedShapes, item.name).toEqual(item.shapes);
        if (item.unions) expect(actual.tracedUnions, item.name).toEqual(item.unions);
        if (item.tables)
          expect(
            actual.tables.map((t) => t.id),
            item.name,
          ).toEqual(item.tables);
        if (item.loops)
          expect(
            actual.loops.map((l) => l.localId),
            item.name,
          ).toEqual(item.loops);
      }
      for (const source of [
        "3103-scalar-record-nested-control-flow.ts",
        "3104-native-analysis-tables-loops.ts",
        "2481-mutual-recursive-records.ts",
        "3094-json-replacer-traversal.ts",
      ]) {
        const sourcePath = join(root, "tests/corpus", source);
        const irPath = join(dir, "frontend.json");
        const emitted = await compile(sourcePath, {
          outDir: dir,
          outPath: irPath,
          outputKind: "ir",
        });
        if (!emitted.ok)
          throw new Error(emitted.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
        const original = deserializeModule(readFileSync(irPath, "utf8"));
        const summary = run(original, "analysis", source);
        const analysis = JSON.parse(summary.native) as Analysis;
        expect(analysis).toEqual(JSON.parse(summary.oracle));
        if (source.startsWith("3104")) {
          expect(analysis.tables).toHaveLength(1);
          expect(analysis.tables[0]!.values).toEqual(["7", "-0", "2.5", "Infinity", "-Infinity"]);
          expect(analysis.loops).toHaveLength(1);
        }
        const result = run(original, "optimize", source);
        const optimized = deserializeModule(result.native);
        expect(optimized).toEqual(deserializeModule(result.oracle));
        expect(validateModule(optimized)).toEqual([]);
        if (source.startsWith("3103")) {
          expect(counts(optimized).records).toBeLessThan(counts(original).records);
          expect(counts(optimized).reads).toBeLessThan(counts(original).reads);
          expect(counts(optimized).calls).toBeLessThan(counts(original).calls);
        }
        // Feed the native result to each production backend. This pins
        // optimizer semantics beyond matching Node's JSON: the resulting
        // native executable must agree with the original TypeScript.
        const path = join(dir, "optimized.ll");
        writeFileSync(path, emitLlvmModule(optimized));
        const outPath = executable("program");
        await compileC({
          cPath: path,
          outPath,
          sanitize,
          ...moduleLinkFeatures(optimized),
        });
        const oracle = spawnSync(process.execPath, [sourcePath], options);
        const program = spawnSync(outPath, [], options);
        for (const process of [oracle, program]) {
          expect(process.error, source).toBeUndefined();
          expect(process.signal, source).toBeNull();
          expect(process.status, `${source}: ${process.stderr}`).toBe(0);
        }
        expect(program.stdout, source).toEqual(oracle.stdout);
        expect(program.stderr, source).toEqual(oracle.stderr);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // Compiling this much of the backend under the sanitizer takes most of
    // the default five minutes on a loaded runner.
  }, 600_000);
}
