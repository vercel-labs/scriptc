import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { analyze, compile, compileC, deserializeModule, serializeModule } from "@scriptc/compiler";
import { emitLlvmModule } from "../../packages/compiler/src/backend/llvm/emitter.js";
import { scalarizeNumericRecords } from "../../packages/compiler/src/ir/scalar-records.js";
import { everyStmtList } from "../../packages/compiler/src/ir/traverse.js";
import { type IrModule } from "../../packages/compiler/src/ir/ir.js";
import {
  moduleUsesCopying,
  moduleUsesDynInvoke,
  moduleUsesInspect,
  moduleUsesRegex,
} from "../../packages/compiler/src/ir/runtime-features.js";
import {
  emissionCases,
  emissionModule,
  emissionRequest,
  type EmissionRequest,
} from "./self-hosting-emission-cases.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const entry = join(root, "tests/fixtures/self-hosting/llvm-layouts.ts");
const options = { cwd: root, timeout: 30_000, maxBuffer: 32 * 1024 * 1024 };

interface Emission {
  layouts: {
    records: { typeDefs: string[]; defs: string[] };
    classes: { typeDefs: string[]; defs: string[] };
    classObjects: string[];
  };
  classes: {
    name: string;
    root: string;
    base: string | null;
    children: string[];
    pre: number;
    post: number;
    hierarchy: boolean;
    fields: { name: string; index: number }[];
    slots: { method: string; declarer: string; function: string }[];
  }[];
  declarations: string[];
  walkers: string[];
  strings: string[];
  units: { union: string; tag: number }[];
  needsOom: boolean;
  bindings: string[];
  debug: string;
  block: string;
}

test("the production layout and metadata stage lowers statically", () => {
  const { coverage } = analyze(entry, { dynamic: false });
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.diagnostics).toEqual([]);
  expect(coverage.stats.statementsTotal).toBeGreaterThan(1200);
  expect(coverage.stats.statementsFailed).toBe(0);
  expect(coverage.stats.statementsIsland).toBe(0);
  expect(coverage.stats.functionsSkipped).toBe(0);
});

for (const backend of ["llvm"] as const) {
  test(`native LLVM layout and metadata emission (${backend})`, async () => {
    const dir = mkdtempSync(
      join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-native-emission-"),
    );
    const sanitize = process.env["SCRIPTC_SAN"] === "1";
    const executable = (name: string): string =>
      join(dir, name + (process.platform === "win32" ? ".exe" : ""));
    try {
      const built = await compile(entry, {
        outDir: dir,
        outPath: executable("stage"),
        backend,
        dynamic: false,
        optimization: "dev",
        sanitize,
      });
      if (!built.ok)
        throw new Error(built.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      expect(built.backend).toBe(backend);
      const run = (mod: IrModule, request: EmissionRequest, name: string, status = 0): string => {
        const input = join(dir, "input.json");
        const config = join(dir, "config.json");
        writeFileSync(input, serializeModule(mod));
        writeFileSync(config, JSON.stringify(request));
        const args = [input, config];
        const oracle = spawnSync(process.execPath, ["--import", "tsx", entry, ...args], options);
        const native = spawnSync(built.binaryPath, args, options);
        for (const result of [oracle, native]) {
          expect(result.error, name).toBeUndefined();
          expect(result.signal, `${name}: ${result.stderr}`).toBeNull();
          expect(result.status, `${name}: ${result.stdout}\n${result.stderr}`).toBe(status);
          expect(result.stderr.toString(), name).toBe("");
        }
        if (status === 0)
          expect(JSON.parse(native.stdout.toString()), name).toEqual(
            JSON.parse(oracle.stdout.toString()),
          );
        else expect(native.stdout, name).toEqual(oracle.stdout);
        return native.stdout.toString();
      };

      for (const item of emissionCases()) {
        const text = run(item.module, item.request, item.name);
        const emitted = JSON.parse(text) as Emission;
        const definitions = [
          ...emitted.declarations,
          ...emitted.layouts.records.typeDefs,
          ...emitted.layouts.records.defs,
          ...emitted.layouts.classes.typeDefs,
          ...emitted.layouts.classes.defs,
          ...emitted.layouts.classObjects,
          ...emitted.walkers,
          emitted.debug,
        ].join("\n");
        for (const expected of item.contains) expect(definitions, item.name).toContain(expected);
        if ((item.request.joinUnions?.length ?? 0) > 1) {
          expect(definitions.match(/define internal ptr @sc_uj_/g), item.name).toHaveLength(1);
        }
        if (item.name.startsWith("class forest")) {
          expect(
            emitted.classes.map((meta) => [meta.name, meta.root, meta.pre, meta.post]),
          ).toEqual([
            ["Base", "Base", 0, 2],
            ["Child", "Base", 1, 2],
            ["Unrelated", "Unrelated", 3, 3],
            ["Leaf", "Base", 2, 2],
          ]);
        }
      }

      const invalid = emissionModule();
      invalid.classes = [
        {
          name: "Child",
          base: "Missing",
          fields: [],
          loc: { file: invalid.sourceFile, start: 0, end: 0 },
        },
      ];
      expect(run(invalid, emissionRequest(), "missing base", 1)).toContain(
        "undeclared base class Missing",
      );
      const absent = emissionRequest();
      absent.classObjects = ["Missing"];
      expect(run(emissionModule(), absent, "missing class object", 1)).toContain(
        "class object for unknown class Missing",
      );

      // A native bootstrap must preserve emitter refusals too: unsupported
      // requests must not quietly return partial helper definitions.
      const invalidRequests: { request: EmissionRequest; message: string }[] = [
        {
          request: {
            ...emissionRequest(),
            writers: [{ kind: "map", key: { kind: "string" }, value: { kind: "f64" } }],
          },
          message: "jsonStringify:map",
        },
        {
          request: { ...emissionRequest(), writers: [{ kind: "record", shapeId: "Missing" }] },
          message: "jsonStringify of unknown shape Missing",
        },
        {
          request: { ...emissionRequest(), writers: [{ kind: "union", unionId: "Missing" }] },
          message: "jsonStringify of unknown union Missing",
        },
        {
          request: { ...emissionRequest(), joinUnions: ["Missing"] },
          message: "join of unknown union Missing",
        },
      ];
      for (const { request, message } of invalidRequests) {
        expect(run(emissionModule(), request, message, 1)).toContain(message);
      }
      const unsupported = emissionModule();
      unsupported.unions = [
        {
          id: "containers",
          arms: [{ kind: "array", elem: { kind: "string" } }, { kind: "undefinedT" }],
        },
      ];
      expect(
        run(
          unsupported,
          { ...emissionRequest(), joinUnions: ["containers"] },
          "unsupported union join",
          1,
        ),
      ).toContain("unionJoin:array");

      for (const source of [
        "711-inheritance-dispatch.ts",
        "756-cycle-inheritance.ts",
        "3103-scalar-record-nested-control-flow.ts",
      ]) {
        const sourcePath = join(root, "tests/corpus", source);
        const irPath = join(dir, "frontend.json");
        const frontend = await compile(sourcePath, {
          outDir: dir,
          outPath: irPath,
          outputKind: "ir",
          dynamic: false,
        });
        if (!frontend.ok)
          throw new Error(frontend.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
        const mod = scalarizeNumericRecords(deserializeModule(readFileSync(irPath, "utf8")));
        const request = emissionRequest();
        request.sources = [{ file: sourcePath, text: readFileSync(sourcePath, "utf8") }];
        for (const fn of mod.functions)
          everyStmtList(fn.body, {
            stmt: () => true,
            expr: (expr) => {
              if (
                expr.kind === "recordClone" &&
                expr.type.kind === "record" &&
                !request.clones.includes(expr.type.shapeId)
              )
                request.clones.push(expr.type.shapeId);
              return true;
            },
          });
        const native = JSON.parse(run(mod, request, source)) as Emission;
        // Splice the native-generated sections into the real program. The
        // full emitter still runs on Node; these type and helper definitions
        // are supplied by the compiled production stage under test.
        let llvm = emitLlvmModule(mod);
        let supplied = 0;
        for (const lines of [
          native.layouts.records.typeDefs,
          native.layouts.records.defs,
          native.layouts.classes.typeDefs,
          native.layouts.classes.defs,
        ]) {
          const section = lines.join("\n");
          if (section.length === 0) continue;
          expect(llvm, source).toContain(section);
          llvm = llvm.replace(section, `; native layout stage\n${section}`);
          supplied++;
        }
        expect(supplied, source).toBeGreaterThan(0);
        const path = join(dir, "generated.ll");
        writeFileSync(path, llvm);
        const outPath = executable("generated");
        await compileC({
          cPath: path,
          outPath,
          sanitize,
          inspect: moduleUsesInspect(mod),
          dynInvoke: moduleUsesDynInvoke(mod),
          regex: moduleUsesRegex(mod),
          copying: moduleUsesCopying(mod),
        });
        const oracle = spawnSync(process.execPath, [sourcePath], options);
        const program = spawnSync(outPath, [], options);
        for (const result of [oracle, program]) {
          expect(result.error, source).toBeUndefined();
          expect(result.signal, `${source}: ${result.stderr}`).toBeNull();
          expect(result.status, `${source}: ${result.stderr}`).toBe(0);
        }
        expect(program.stdout, source).toEqual(oracle.stdout);
        expect(program.stderr, source).toEqual(oracle.stderr);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
