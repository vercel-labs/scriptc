import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  validateModule,
} from "@scriptc/compiler";
import { moduleLinkFeatures } from "./link-features.js";

const root = fileURLToPath(new URL("../..", import.meta.url));

test("the complete IR validator lowers statically without skipped functions", () => {
  const entry = join(root, "tests/fixtures/self-hosting/validate.ts");
  const { coverage } = analyze(entry, {});
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.stats.statementsTotal).toBeGreaterThan(0);
  expect(coverage.stats.statementsFailed).toBe(0);
  expect(coverage.stats.functionsSkipped).toBe(0);
});

// Keep these outside the ordinary corpus: they import implementation files
// beyond the fixture directory, which the corpus oracle cache does not hash.
// Node executes the actual TS modules through tsx's .js → .ts resolution.
for (const component of [
  "source-locations",
  "ir-collections",
  "ir-types",
  "ir-control-flow",
  "ir-traversal",
  "union-discriminants",
  "emitter-literals",
]) {
  for (const backend of ["llvm"] as const) {
    test(`self-hosting ${component}: ${backend} matches Node`, async () => {
      const entry = join(root, "tests/fixtures/self-hosting", `${component}.ts`);
      const outDir = mkdtempSync(
        join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-self-hosting-"),
      );
      try {
        const oracle = spawnSync(process.execPath, ["--import", "tsx", entry], {
          cwd: root,
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        });
        expect(oracle.error).toBeUndefined();
        expect(oracle.signal).toBeNull();
        expect(oracle.status, oracle.stderr.toString()).toBe(0);
        expect(oracle.stdout.length).toBeGreaterThan(0);
        const built = await compile(entry, {
          outDir,
          outPath: join(outDir, process.platform === "win32" ? "program.exe" : "program"),
          backend,
          sanitize: process.env["SCRIPTC_SAN"] === "1",
        });
        if (!built.ok)
          throw new Error(built.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
        expect(built.backend).toBe(backend);
        const native = spawnSync(built.binaryPath, [], {
          cwd: root,
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        });
        expect(native.error).toBeUndefined();
        expect(native.signal).toBeNull();
        expect(native.status, native.stderr.toString()).toBe(oracle.status);
        expect(native.stdout).toEqual(oracle.stdout);
        expect(native.stderr).toEqual(oracle.stderr);
      } finally {
        rmSync(outDir, { recursive: true, force: true });
      }
    });
  }
}

// This is a native compiler stage: the executable imports and runs the
// actual IR builder, analysis functions and validator, writes IR, and that
// IR must produce a working executable. Comparing its serialized IR
// to Node also pins construction order and every recursive payload.
for (const [fixture, backend] of ["ir-build", "contextual-ir", "coercion-builders"].flatMap(
  (fixture) => (["llvm"] as const).map((backend) => [fixture, backend] as const),
)) {
  test(`self-hosting IR generation ${fixture}: ${backend} builds and validates an executable program`, async () => {
    const entry = join(root, "tests/fixtures/self-hosting", `${fixture}.ts`);
    const outDir = mkdtempSync(
      join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-ir-build-"),
    );
    const sanitize = process.env["SCRIPTC_SAN"] === "1";
    const exe = (name: string): string =>
      join(outDir, name + (process.platform === "win32" ? ".exe" : ""));
    try {
      const built = await compile(entry, {
        outDir,
        outPath: exe("builder"),
        backend,
        sanitize,
        optimization: "dev",
      });
      if (!built.ok)
        throw new Error(built.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      expect(built.backend).toBe(backend);
      for (const bound of [0, 6]) {
        const args = [String(bound)];
        const options = { cwd: root, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 };
        const oracle = spawnSync(process.execPath, ["--import", "tsx", entry, ...args], options);
        const native = spawnSync(built.binaryPath, args, options);
        for (const result of [oracle, native]) {
          expect(result.error).toBeUndefined();
          expect(result.signal).toBeNull();
          expect(result.status, result.stderr.toString()).toBe(0);
        }
        if (fixture === "coercion-builders") {
          // Captured functions use the native record's declaration order.
          // JSON member order is not part of the IR format.
          expect(deserializeModule(native.stdout.toString())).toEqual(
            deserializeModule(oracle.stdout.toString()),
          );
        } else {
          expect(native.stdout).toEqual(oracle.stdout);
        }
        expect(native.stderr).toEqual(oracle.stderr);
        const mod = deserializeModule(native.stdout.toString());
        expect(validateModule(mod)).toEqual([]);
        const llvmPath = join(outDir, `generated-${bound}.ll`);
        const outPath = exe(`generated-${bound}`);
        writeFileSync(llvmPath, emitLlvmModule(mod));
        // The emitted module is a compiler-generated TU, so it takes the same
        // cached runtime objects as compile() rather than rebuilding the whole
        // runtime from source for every bound.
        await compileC({
          cPath: llvmPath,
          outPath,
          sanitize,
          cacheIdentity: "scriptc-generated-v1",
          ...moduleLinkFeatures(mod),
        });
        const program = spawnSync(outPath, [], options);
        expect(program.error).toBeUndefined();
        expect(program.signal).toBeNull();
        expect(program.status, program.stderr.toString()).toBe(0);
        if (fixture === "coercion-builders") {
          expect(program.stdout.toString()).toBe(
            `${Array.from({ length: bound }, (_, i) => i * 2).join(",")} ${bound * 2} ${bound * 2}\n`,
          );
        } else {
          const label = fixture === "ir-build" ? "built" : "context";
          const suffix = fixture === "ir-build" ? " true" : "";
          expect(program.stdout.toString()).toBe(
            `${label}${"!".repeat(bound)} ${(bound * (bound - 1)) / 2}${suffix}\n`,
          );
        }
        expect(program.stderr.toString()).toBe("");
      }
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
}
