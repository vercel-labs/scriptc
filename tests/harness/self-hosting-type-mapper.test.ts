import { execFile, execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import type { AnalyzeResult, compile } from "@scriptc/compiler";
import { ts7Executable } from "../../packages/compiler/src/frontend/ts7/rpc-api.js";
import type { MappingReport } from "../fixtures/self-hosting/type-mapper-cases.js";
import { typeMapperInput } from "./self-hosting-type-mapper-input.js";

const root = join(import.meta.dirname, "../..");
const fixtures = join(root, "tests/fixtures/self-hosting");
const nativeSources = join(root, "packages/compiler/native");
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const execFileAsync = promisify(execFile);

function checkReport(report: MappingReport): void {
  const byName = new Map(report.mappings.map((entry) => [entry.name, entry]));
  expect(byName.size).toBe(73);
  expect(byName.get("Text")!.type).toEqual({ kind: "string" });
  expect(byName.get("NumberValue")!.type).toEqual({ kind: "f64" });
  expect(byName.get("Flag")!.type).toEqual({ kind: "bool" });
  expect(byName.get("AnyValue")!.type).toBeNull();
  expect(byName.get("UnknownValue")!.type).toEqual({ kind: "dyn" });
  expect(byName.get("TextLiteral")!.literals).toEqual(["text"]);
  expect(byName.get("NumberLiteral")!.literals).toEqual([-2.5]);
  expect(byName.get("BooleanLiteral")!.literals).toEqual([false]);
  expect(byName.get("MixedLiterals")!.literals).toEqual(expect.arrayContaining(["1", 1, false]));
  expect(byName.get("Text")!.literals).toBeNull();
  expect(byName.get("RecordValue")!.type?.kind).toBe("record");
  expect(byName.get("LinkedRecord")!.display).toContain("...");
  expect(byName.get("MutualRecord")!.display).toContain("...");
  expect(byName.get("StringMap")!.type?.kind).toBe("map");
  expect(byName.get("StringSet")!.type?.kind).toBe("set");
  expect(byName.get("Call")!.type?.kind).toBe("func");
  expect(byName.get("ClassInstance")!.type).toEqual({ kind: "object", className: "Named" });
  expect(byName.get("ClassValue")!.type).toEqual({ kind: "classval", className: "Named" });
  for (const name of ["ProductionType", "ProductionExpression", "ProductionStatement"]) {
    const type = byName.get(name)!.type;
    expect(type?.kind, name).toBe("union");
    if (type?.kind !== "union") throw new Error(`${name} did not map`);
    const def = report.unions.find((union) => union.id === type.unionId)!;
    expect(def.arms.length, name).toBeGreaterThan(10);
    expect(def.discriminant?.field, name).toBe("kind");
  }
  expect(byName.get("ProductionModule")!.type?.kind).toBe("record");
  expect(byName.get("ProductionFunction")!.type?.kind).toBe("record");
  for (const name of [
    "Expression",
    "NumericVariant",
    "BooleanVariant",
    "MixedVariant",
    "AliasedVariant",
    "OtherVariant",
  ]) {
    const type = byName.get(name)!.type;
    if (type?.kind !== "union") throw new Error(`${name} did not map to a union`);
    const def = report.unions.find((union) => union.id === type.unionId)!;
    expect(def.discriminant?.field, name).toBe("kind");
    expect(def.discriminant!.cases.length, name).toBeGreaterThanOrEqual(2);
  }
  for (const name of ["PlainUnion", "OptionalKind", "AccessorKind", "BroadKind"]) {
    const type = byName.get(name)!.type;
    if (type?.kind !== "union") throw new Error(`${name} did not map to a union`);
    expect(
      report.unions.find((union) => union.id === type.unionId)!.discriminant,
      name,
    ).toBeUndefined();
  }
  expect(byName.get("AliasedVariant")!.type).not.toEqual(byName.get("OtherVariant")!.type);
  expect(report.variants.length).toBeGreaterThanOrEqual(18);
  expect(report.memoEntries).toBeGreaterThan(30);
  expect(report.hooks).toEqual([
    "Box:first:f64",
    "Box:second:f64",
    "parameter:f64:string",
    "HookIndexed:f64:string",
    "HookKeys:f64:string",
    "HookLiteral:f64:string",
  ]);
}

// Main SAN CI passed this full test in 289 s, leaving 11 s below the
// default whole-test bound. Keep the compiler and execution limits below.
const testTimeout = sanitize ? 600_000 : undefined;

for (const backend of ["llvm"] as const) {
  const runNativeCase = async () => {
    const directory = mkdtempSync(
      join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-type-mapper-"),
    );
    try {
      const object = join(directory, "process.o");
      execFileSync("clang", [
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        ...(sanitize ? ["-fsanitize=address"] : []),
        "-c",
        join(nativeSources, "ts7-process.c"),
        "-o",
        object,
      ]);
      const profile = join(directory, "ffi.json");
      writeFileSync(
        profile,
        JSON.stringify({
          ...JSON.parse(readFileSync(join(nativeSources, "ts7-process.ffi.json"), "utf8")),
          libraries: [object],
        }),
      );
      const source = join(directory, "input.ts");
      writeFileSync(
        source,
        typeMapperInput +
          `
        import type { IrType, IrExpr, IrStmt, IrModule, IrFunction } from ${JSON.stringify(join(root, "packages/compiler/src/ir/ir.js"))};
        export type ProductionType = IrType;
        export type ProductionExpression = IrExpr;
        export type ProductionStatement = IrStmt;
        export type ProductionModule = IrModule;
        export type ProductionFunction = IrFunction;
      `,
      );
      const expected = join(directory, "node.json");
      const node = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          join(fixtures, "type-mapper-node.ts"),
          ts7Executable(),
          source,
          expected,
        ],
        {
          encoding: "utf8",
          timeout: 90_000,
        },
      );
      expect(node.error, node.stderr).toBeUndefined();
      expect(node.status, node.stderr).toBe(0);
      expect(node.stdout).toBe("");
      expect(node.stderr).toBe("");
      const nodeReport = JSON.parse(readFileSync(expected, "utf8")) as {
        first: MappingReport;
        second: MappingReport;
      };
      checkReport(nodeReport.first);
      expect(nodeReport.second).toEqual(nodeReport.first);

      const api = pathToFileURL(join(root, "packages/compiler/src/index.ts")).href;
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "--eval",
          `import { analyze, compile } from ${JSON.stringify(api)};
         const options = { ffiProfilePath: process.argv[2] };
         const { coverage } = analyze(process.argv[1], options);
         const built = await compile(process.argv[1], {
           ...options, backend: process.argv[3], optimization: 'dev', sanitize: process.argv[4] === '1',
           outDir: process.argv[5], outPath: process.argv[6],
         });
         console.log(JSON.stringify({ coverage: {
           preflightFailed: coverage.preflightFailed, diagnostics: coverage.diagnostics, stats: coverage.stats,
         }, built }));`,
          join(fixtures, "type-mapper.ts"),
          profile,
          backend,
          sanitize ? "1" : "0",
          directory,
          join(directory, process.platform === "win32" ? "mapper.exe" : "mapper"),
        ],
        { cwd: root, timeout: 300_000, maxBuffer: 32 * 1024 * 1024 },
      );
      expect(stderr).toBe("");
      const { coverage, built } = JSON.parse(stdout) as {
        coverage: AnalyzeResult["coverage"];
        built: Awaited<ReturnType<typeof compile>>;
      };
      expect(coverage.preflightFailed, JSON.stringify(coverage.diagnostics)).toBe(false);
      expect(coverage.diagnostics).toEqual([]);
      expect(coverage.stats.statementsFailed).toBe(0);
      expect(coverage.stats.functionsSkipped).toBe(0);
      if (!built.ok)
        throw new Error(built.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      if (!("binaryPath" in built))
        throw new Error("type mapper did not produce a native executable");
      expect(built.backend).toBe(backend);

      const output = join(directory, "native.json");
      const native = spawnSync(built.binaryPath, [ts7Executable(), source, output], {
        encoding: "utf8",
        timeout: 90_000,
      });
      expect(native.error, native.stderr).toBeUndefined();
      expect(native.signal, native.stderr).toBeNull();
      expect(native.status, native.stderr).toBe(0);
      expect(native.stdout).toBe(node.stdout);
      expect(native.stderr).toBe(node.stderr);
      const nativeReport = JSON.parse(readFileSync(output, "utf8")) as {
        first: MappingReport;
        second: MappingReport;
      };
      expect(nativeReport.first.tuples).toEqual(nodeReport.first.tuples);
      expect(nativeReport).toEqual(nodeReport);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
  test(`production type mapper runs against native TS7 (${backend})`, runNativeCase, testTimeout);
}
