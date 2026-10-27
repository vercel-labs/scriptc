import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  analyze,
  compile,
  compileC,
  deserializeModule,
  emitLlvmModule,
  serializeModule,
  validateModule,
} from "@scriptc/compiler";
import { moduleLinkFeatures } from "./link-features.js";
import { IR_VERSION } from "../../packages/compiler/src/ir/serialize.js";
import { F64, VOID, type IrModule } from "../../packages/compiler/src/ir/ir.js";
import { numLit } from "../../packages/compiler/src/ir/build.js";
import { validatorCases } from "./self-hosting-validator-cases.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const entry = join(root, "tests/fixtures/self-hosting/serialize.ts");
const runOptions = { cwd: root, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 };

function numericModule(): IrModule {
  const loc = { file: "native-numbers.ts", start: 0, end: 1 };
  const numbers = [Infinity, -Infinity, -0, 0, 0.1 + 0.2, Number.MAX_VALUE, Number.MIN_VALUE];
  return {
    irVersion: IR_VERSION,
    sourceFile: loc.file,
    entry: "main",
    functions: [
      {
        name: "main",
        params: [],
        returnType: VOID,
        locals: [],
        loc,
        body: [
          // The fixture can change this first literal to NaN before encoding.
          { kind: "exprStmt", expr: numLit(0, loc), loc },
          {
            kind: "exprStmt",
            expr: {
              kind: "intrinsic",
              name: "console.log",
              args: numbers.map((n) => numLit(n, loc)),
              type: VOID,
              loc,
            },
            loc,
          },
          {
            kind: "exprStmt",
            expr: {
              kind: "intrinsic",
              name: "console.log",
              args: [
                {
                  kind: "bin",
                  op: "/",
                  left: numLit(1, loc),
                  right: numLit(-0, loc),
                  type: F64,
                  loc,
                },
              ],
              type: VOID,
              loc,
            },
            loc,
          },
          { kind: "return", value: null, loc },
        ],
      },
    ],
  };
}

test("the production IR serialization and validation pipeline lowers entirely statically", () => {
  const { coverage } = analyze(entry, {});
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.stats.statementsTotal).toBeGreaterThan(3000);
  expect(coverage.stats.statementsFailed).toBe(0);
  expect(coverage.stats.functionsSkipped).toBe(0);
});

for (const backend of ["llvm"] as const) {
  test(`self-hosting serialization: ${backend} round-trips IR and produces a working program`, async () => {
    const dir = mkdtempSync(
      join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-native-serialize-"),
    );
    const sanitize = process.env["SCRIPTC_SAN"] === "1";
    const executable = (name: string): string =>
      join(dir, name + (process.platform === "win32" ? ".exe" : ""));
    try {
      const built = await compile(entry, {
        outDir: dir,
        outPath: executable("serializer"),
        backend,
        optimization: "dev",
        sanitize,
      });
      if (!built.ok)
        throw new Error(built.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      expect(built.backend).toBe(backend);
      const run = (input: string, args: string[] = []) => {
        const path = join(dir, "input.json");
        writeFileSync(path, input);
        const oracle = spawnSync(
          process.execPath,
          ["--import", "tsx", entry, path, ...args],
          runOptions,
        );
        const native = spawnSync(built.binaryPath, [path, ...args], runOptions);
        for (const result of [oracle, native]) {
          expect(result.error).toBeUndefined();
          expect(result.signal, result.stderr.toString()).toBeNull();
          expect(result.stderr.toString()).toBe("");
        }
        expect(native.status).toBe(oracle.status);
        return { oracle, native };
      };
      const roundTrip = (module: IrModule): IrModule => {
        const { oracle, native } = run(serializeModule(module));
        expect(native.status, native.stdout.toString()).toBe(0);
        // Native records use declaration order; JSON member order is not
        // part of the IR format. Compare all payloads after decoding the
        // production sentinel protocol, including the sign of zero.
        const actual = deserializeModule(native.stdout.toString());
        expect(actual).toEqual(deserializeModule(oracle.stdout.toString()));
        expect(actual).toEqual(module);
        expect(validateModule(actual)).toEqual([]);
        const again = run(native.stdout.toString());
        expect(again.native.stdout).toEqual(native.stdout);
        return actual;
      };

      const numeric = roundTrip(numericModule());
      const compact = run(serializeModule(numeric), ["compact"]);
      expect(compact.native.status).toBe(0);
      expect(compact.native.stdout.toString().trimEnd()).not.toContain("\n");
      expect(deserializeModule(compact.native.stdout.toString())).toEqual(numeric);
      expect(deserializeModule(compact.native.stdout.toString())).toEqual(
        deserializeModule(compact.oracle.stdout.toString()),
      );
      const finite: IrModule = {
        ...numeric,
        functions: [
          {
            ...numeric.functions[0]!,
            body: [
              numeric.functions[0]!.body[0]!,
              { kind: "return", value: null, loc: numeric.functions[0]!.loc },
            ],
          },
        ],
      };
      const finiteCompact = run(serializeModule(finite), ["compact"]);
      expect(finiteCompact.native.status).toBe(0);
      expect(deserializeModule(finiteCompact.native.stdout.toString())).toEqual(finite);
      expect(deserializeModule(finiteCompact.native.stdout.toString())).toEqual(
        deserializeModule(finiteCompact.oracle.stdout.toString()),
      );
      const manyFunctions: IrModule = {
        ...numeric,
        sourceFile: 'escaped "functions":[] $&.ts',
        functions: Array.from({ length: 64 }, (_, index) => ({
          ...(index % 8 === 0 ? numeric : finite).functions[0]!,
          name: `function${index}`,
        })),
      };
      const many = run(serializeModule(manyFunctions), ["compact"]);
      expect(many.native.status).toBe(0);
      expect(deserializeModule(many.native.stdout.toString())).toEqual(manyFunctions);
      expect(deserializeModule(many.native.stdout.toString())).toEqual(
        deserializeModule(many.oracle.stdout.toString()),
      );
      // Byte decoding and compact parts, from both encodings.
      for (const input of [serializeModule(manyFunctions), serializeModule(manyFunctions, true)]) {
        const parts = run(input, ["bytes"]);
        expect(parts.native.status, parts.native.stdout.toString()).toBe(0);
        expect(parts.native.stdout.toString().trimEnd()).not.toContain("\n");
        expect(deserializeModule(parts.native.stdout.toString())).toEqual(manyFunctions);
        expect(deserializeModule(parts.native.stdout.toString())).toEqual(
          deserializeModule(parts.oracle.stdout.toString()),
        );
      }
      const truncated = run(serializeModule(manyFunctions, true).slice(0, -1), ["bytes"]);
      expect(truncated.native.status).toBe(1);
      expect(truncated.oracle.status).toBe(1);
      const olderBytes = run(
        serializeModule({ ...manyFunctions, irVersion: IR_VERSION - 1 }, true),
        ["bytes"],
      );
      expect(olderBytes.native.status).toBe(1);
      expect(olderBytes.native.stdout).toEqual(olderBytes.oracle.stdout);
      expect(olderBytes.native.stdout.toString()).toContain("IR version mismatch");
      const print = numeric.functions[0]!.body[1]!;
      expect(print.kind).toBe("exprStmt");
      if (print.kind !== "exprStmt" || print.expr.kind !== "intrinsic")
        throw new Error("numeric IR changed");
      const third = print.expr.args[2]!;
      expect(third.kind).toBe("numLit");
      if (third.kind !== "numLit") throw new Error("literal changed");
      expect(Object.is(third.value, -0)).toBe(true);
      const cPath = join(dir, "numbers.ll");
      writeFileSync(cPath, emitLlvmModule(numeric));
      await compileC({
        cPath,
        outPath: executable("numbers"),
        sanitize,
        ...moduleLinkFeatures(numeric),
      });
      const program = spawnSync(executable("numbers"), [], runOptions);
      expect(program.error).toBeUndefined();
      expect(program.signal).toBeNull();
      expect(program.status, program.stderr.toString()).toBe(0);
      expect(program.stdout.toString()).toBe(
        "Infinity -Infinity -0 0 0.30000000000000004 1.7976931348623157e+308 5e-324\n-Infinity\n",
      );
      expect(program.stderr.toString()).toBe("");

      for (const item of validatorCases()) {
        if (!item.diagnostic) roundTrip(item.module);
        else {
          const { oracle, native } = run(serializeModule(item.module));
          expect(native.status).toBe(1);
          expect(native.stdout).toEqual(oracle.stdout);
          expect(native.stdout.toString()).toContain(item.diagnostic);
        }
      }
      for (const source of [
        "tests/corpus/3086-error-constructor-options.ts",
        "tests/corpus/3089-array-find-narrowing.ts",
        "tests/corpus/3091-json-recursive-discriminants.ts",
        "tests/corpus/3094-json-replacer-traversal.ts",
        "tests/corpus/1010-json-stringify-space.ts",
      ]) {
        const path = join(dir, "emitted.json");
        const emitted = await compile(join(root, source), {
          outDir: dir,
          outPath: path,
          outputKind: "ir",
        });
        if (!emitted.ok)
          throw new Error(emitted.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
        roundTrip(deserializeModule(readFileSync(path, "utf8")));
      }
      const previous = { ...numericModule(), irVersion: IR_VERSION - 1 };
      const mismatch = run(serializeModule(previous));
      expect(mismatch.native.status).toBe(1);
      expect(mismatch.native.stdout).toEqual(mismatch.oracle.stdout);
      expect(mismatch.native.stdout.toString()).toContain("IR version mismatch");
      const nan = run(serializeModule(numericModule()), ["nan"]);
      expect(nan.native.status).toBe(0);
      expect(deserializeModule(nan.native.stdout.toString())).toEqual(
        deserializeModule(nan.oracle.stdout.toString()),
      );
      expect(nan.native.stdout.toString()).toContain('"$nonfinite": "nan"');
      const fromNan = run(nan.native.stdout.toString());
      expect(fromNan.native.status).toBe(0);
      expect(fromNan.native.stdout).toEqual(nan.native.stdout);
      expect(fromNan.native.stdout).toEqual(fromNan.oracle.stdout);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
