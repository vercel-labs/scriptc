import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { compileInChild } from "./self-hosting-compiler-process.js";
import { ts7Executable } from "../../packages/compiler/src/frontend/ts7/rpc-api.js";
import type { MappingReport } from "../fixtures/self-hosting/type-mapper-cases.js";
import { typeMapperInput } from "./self-hosting-type-mapper-input.js";

const root = join(import.meta.dirname, "../..");
const entry = join(root, "tests/fixtures/self-hosting/type-mapper.ts");
const oracle = join(root, "tests/fixtures/self-hosting/type-mapper-node.ts");
const nativeSources = join(root, "packages/compiler/native");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

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

// One build lowers the fixture's 27k statements and emits them: measured as a
// single file on four pinned CPUs (the CI lane's size), 59 s plain and 78 s
// sanitized on a warm test CAS, 115 s sanitized on a cold one, which compiles
// the ASan runtime from C source. The analyze pass this replaces lowered the
// same program a second time and cost 43 s, taking the sanitized case to
// 120 s; under a loaded lane that second pass is what pushed this file past
// the 300 s budget (test (Linux, san, 8/20)). The budgets below leave that
// lane about a 5x band and still stop a hung frontend. The setup case is the
// Node oracle's load, which needs seconds, so it keeps the default 300 s hook
// budget.
const buildTimeout = sanitize ? 600_000 : 300_000;

const directory = mkdtempSync(
  join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-type-mapper-"),
);
const profile = join(directory, "ffi.json");
const source = join(directory, "input.ts");
let nodeStdout = "";
let nodeStderr = "";
let nodeReport: { first: MappingReport; second: MappingReport };

// The Node oracle loads and maps the fixture; its reports are the
// differential baseline the native build must reproduce. It runs once, in
// setup, so the case below reports its own budget.
beforeAll(() => {
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
  writeFileSync(
    profile,
    JSON.stringify({
      ...JSON.parse(readFileSync(join(nativeSources, "ts7-process.ffi.json"), "utf8")),
      libraries: [object],
    }),
  );
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
    ["--import", "tsx", oracle, ts7Executable(), source, expected],
    {
      encoding: "utf8",
      timeout: 90_000,
    },
  );
  expect(node.error, node.stderr).toBeUndefined();
  expect(node.status, node.stderr).toBe(0);
  expect(node.stdout).toBe("");
  expect(node.stderr).toBe("");
  nodeStdout = node.stdout;
  nodeStderr = node.stderr;
  nodeReport = JSON.parse(readFileSync(expected, "utf8")) as {
    first: MappingReport;
    second: MappingReport;
  };
  checkReport(nodeReport.first);
  expect(nodeReport.second).toEqual(nodeReport.first);
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

for (const backend of ["llvm"] as const) {
  test(
    `production type mapper runs against native TS7 (${backend})`,
    async () => {
      // The build's own frontend pass is the coverage check: a build fails on
      // a preflight diagnostic, and the stats below are what a second
      // analyze() pass would lower the same program again to compute. They
      // are absent only on an executable cache hit, which this case's fresh
      // temporary outDir keeps out of reach.
      const built = await compileInChild(
        entry,
        {
          backend,
          optimization: "dev",
          sanitize,
          ffiProfilePath: profile,
          outDir: directory,
          outPath: join(directory, process.platform === "win32" ? "mapper.exe" : "mapper"),
        },
        { timeout: buildTimeout },
      );
      if (!built.ok)
        throw new Error(built.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      if (built.stats === undefined)
        throw new Error("the build lowered the program but reported no lowering stats");
      expect(built.stats.statementsFailed).toBe(0);
      expect(built.stats.functionsSkipped).toBe(0);
      expect(built.backend).toBe(backend);

      const output = join(directory, "native.json");
      const run = spawnSync(built.binaryPath, [ts7Executable(), source, output], {
        encoding: "utf8",
        timeout: 90_000,
      });
      expect(run.error, run.stderr).toBeUndefined();
      expect(run.signal, run.stderr).toBeNull();
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toBe(nodeStdout);
      expect(run.stderr).toBe(nodeStderr);
      const nativeReport = JSON.parse(readFileSync(output, "utf8")) as {
        first: MappingReport;
        second: MappingReport;
      };
      expect(nativeReport.first.tuples).toEqual(nodeReport.first.tuples);
      expect(nativeReport).toEqual(nodeReport);
    },
    buildTimeout,
  );
}
