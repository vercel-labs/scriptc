import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compileC, deserializeModule, emitLlvmModule, validateModule } from "@scriptc/compiler";
import type { AnalyzeResult, compile } from "@scriptc/compiler";
import { moduleLinkFeatures } from "./link-features.js";

const root = join(import.meta.dirname, "../..");
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const execFileAsync = promisify(execFile);
const runOptions = { encoding: "utf8" as const, timeout: 60_000, maxBuffer: 32 * 1024 * 1024 };

for (const fixture of ["ir-refinements", "union-conversions"]) {
  for (const backend of ["llvm"] as const) {
    test(`self-hosting ${fixture} executes natively (${backend})`, async () => {
      const dir = mkdtempSync(
        join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-union-conversions-"),
      );
      const exe = (name: string) => join(dir, name + (process.platform === "win32" ? ".exe" : ""));
      const entry = join(root, "tests/fixtures/self-hosting", `${fixture}.ts`);
      try {
        const api = pathToFileURL(join(root, "packages/compiler/src/index.ts")).href;
        const result = await execFileAsync(
          process.execPath,
          [
            "--import",
            "tsx",
            "--input-type=module",
            "--eval",
            `import { analyze, compile } from ${JSON.stringify(api)};
           const { coverage } = analyze(process.argv[1], {});
           const built = await compile(process.argv[1], {
             outDir: process.argv[2], outPath: process.argv[3], backend: process.argv[4],
             optimization: 'dev', sanitize: process.argv[5] === '1',
           });
           console.log(JSON.stringify({ stats: coverage.stats, diagnostics: coverage.diagnostics, built }));`,
            entry,
            dir,
            exe("stage"),
            backend,
            sanitize ? "1" : "0",
          ],
          { ...runOptions, cwd: root, timeout: 300_000 },
        );
        expect(result.stderr).toBe("");
        const { stats, diagnostics, built } = JSON.parse(result.stdout) as {
          stats: AnalyzeResult["coverage"]["stats"];
          diagnostics: AnalyzeResult["coverage"]["diagnostics"];
          built: Awaited<ReturnType<typeof compile>>;
        };
        expect(diagnostics).toEqual([]);
        expect(stats.statementsTotal).toBeGreaterThan(0);
        expect(stats.statementsFailed).toBe(0);
        expect(stats.functionsSkipped).toBe(0);
        if (!built.ok)
          throw new Error(built.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
        if (!("binaryPath" in built)) throw new Error("native stage did not produce an executable");
        expect(built.backend).toBe(backend);

        const nodePath = join(dir, "node.json"),
          nativePath = join(dir, "native.json");
        const oracle = spawnSync(process.execPath, ["--import", "tsx", entry, nodePath], {
          ...runOptions,
          cwd: root,
        });
        const native = spawnSync(built.binaryPath, [nativePath], runOptions);
        for (const run of [oracle, native]) {
          expect(run.error, run.stderr).toBeUndefined();
          expect(run.signal, run.stderr).toBeNull();
          expect(run.status, run.stderr).toBe(0);
          expect(run.stderr).toBe("");
        }
        expect(native.stdout).toBe(oracle.stdout);
        if (fixture === "ir-refinements") {
          expect(native.stdout).toContain("direct bin:array");
          expect(native.stdout).toContain("direct logical:array");
          expect(native.stdout).toContain("absent true true\n");
          expect(native.stdout).toContain("checksum 2560\n");
          expect(
            native.stdout.split("\n").filter((line) => line.startsWith("ordered ")),
          ).toHaveLength(3);
        } else {
          // Compare complete production IR, then execute that generated IR.
          // Correct plan text alone cannot prove layout dispatch or ownership.
          const text = readFileSync(nativePath, "utf8");
          const module = deserializeModule(text);
          expect(module).toEqual(deserializeModule(readFileSync(nodePath, "utf8")));
          expect(validateModule(module)).toEqual([]);
          expect(module.functions.filter((fn) => fn.name.endsWith("retag"))).toHaveLength(5);
          const cPath = join(dir, "generated.ll");
          writeFileSync(cPath, emitLlvmModule(module));
          await compileC({
            cPath,
            outPath: exe("generated"),
            sanitize,
            optimization: "dev",
            ...moduleLinkFeatures(module),
          });
          const generated = spawnSync(exe("generated"), [], runOptions);
          expect(generated.error).toBeUndefined();
          expect(generated.signal, generated.stderr).toBeNull();
          expect(generated.status, generated.stderr).toBe(0);
          expect(generated.stderr).toBe("");
          expect(generated.stdout).toBe(
            [
              "s:0 17",
              "s:1 43",
              "s:0 17",
              "s:undefined true",
              "s:invalid TypeError",
              "s:narrow TypeError",
              "n:0 17",
              "n:1 43",
              "n:undefined true",
              "n:invalid TypeError",
              "n:narrow TypeError",
              "b:0 17",
              "b:1 43",
              "b:undefined true",
              "b:narrow TypeError",
              "i:0 17",
              "i:1 43",
              "i:0 17",
              "i:undefined true",
              "i:invalid TypeError",
              "i:narrow TypeError",
              ...Array.from({ length: 32 }, (_, index) => `large:${index} ${index}`),
              "extract_bool true",
              "extract_bool:undefined TypeError",
              "extract_bool:wrong TypeError",
              "deferred_bool false",
              "deferred_bool:present true",
              "deferred_bool:wrong TypeError",
              "extract_f64 37",
              "extract_f64:undefined TypeError",
              "extract_f64:wrong TypeError",
              "deferred_f64 NaN",
              "deferred_f64:present 37",
              "deferred_f64:wrong TypeError",
              "extract_string retained",
              "extract_string:undefined TypeError",
              "extract_string:wrong TypeError",
              "",
            ].join("\n"),
          );
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}
