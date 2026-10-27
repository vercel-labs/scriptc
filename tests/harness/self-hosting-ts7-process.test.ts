import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze, compile } from "@scriptc/compiler";
import { expect, test } from "vitest";
import { tsgoExecutable } from "../../packages/compiler/src/frontend/ts7/rpc-api.js";
import { runClient } from "./ts7-client-harness.js";

const root = join(import.meta.dirname, "../..");
const nativeSources = join(root, "packages/compiler/native");
const entry = join(root, "tests/fixtures/self-hosting/ts7-native-process.ts");
const oracleEntry = join(root, "tests/fixtures/self-hosting/ts7-client.ts");
const tempRoot = process.platform === "win32" ? tmpdir() : "/tmp";
const sanitize = process.env["SCRIPTC_SAN"] === "1";

for (const backend of ["llvm"] as const) {
  test(`the native client owns its TypeScript server from startup through exit (${backend})`, async () => {
    const dir = mkdtempSync(join(tempRoot, "scriptc-ts7-owned-"));
    try {
      const object = join(dir, "process.o");
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
      const profile = join(dir, "ffi.json");
      writeFileSync(
        profile,
        JSON.stringify({
          ...JSON.parse(readFileSync(join(nativeSources, "ts7-process.ffi.json"), "utf8")),
          libraries: [object],
        }),
      );
      const { coverage } = analyze(entry, { ffiProfilePath: profile });
      expect(coverage.preflightFailed, JSON.stringify(coverage.diagnostics)).toBe(false);
      expect(coverage.stats.statementsFailed, JSON.stringify(coverage.diagnostics)).toBe(0);
      expect(coverage.stats.functionsSkipped).toBe(0);
      const built = await compile(entry, {
        backend,
        optimization: "dev",
        sanitize,
        ffiProfilePath: profile,
        outDir: dir,
        outPath: join(dir, process.platform === "win32" ? "client.exe" : "client"),
      });
      if (!built.ok)
        throw new Error(built.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      const child = join(dir, process.platform === "win32" ? "child.exe" : "child");
      const target =
        process.platform === "win32"
          ? execFileSync("clang", ["-dumpmachine"], { encoding: "utf8" })
          : "";
      execFileSync("clang", [
        "-std=c11",
        ...(/mingw|windows-gnu/.test(target) ? ["-municode"] : []),
        join(nativeSources, "ts7-process-child.test.c"),
        "-o",
        child,
      ]);
      const transport = spawnSync(built.binaryPath, [child, dir, "unused", "transport"], {
        encoding: "utf8",
        timeout: 15_000,
      });
      expect(transport.error, transport.stderr).toBeUndefined();
      expect(transport.status, transport.stderr).toBe(0);
      expect(transport.stdout).toBe("native transport passed\n");
      expect(transport.stderr).toBe("");
      if (process.platform !== "win32") {
        // A shared server in a private server directory, which the stand-in
        // leaves after its idle time.
        const runtime = join(dir, "run");
        mkdirSync(runtime, { mode: 0o700 });
        const shared = spawnSync(built.binaryPath, [child, dir, "unused", "shared"], {
          encoding: "utf8",
          timeout: 15_000,
          env: { ...process.env, XDG_RUNTIME_DIR: runtime, TSC_TS_LISTEN_MEMORY: undefined },
        });
        expect(shared.status, shared.stderr).toBe(0);
        expect(shared.stdout).toBe("native shared server passed\n");
        expect(shared.stderr).toBe("");
      }
      for (const mode of ["normal-exit", "exit"]) {
        const pidFile = join(dir, mode + ".pid");
        const run = spawnSync(built.binaryPath, [child, dir, pidFile, mode], {
          encoding: "utf8",
          timeout: 15_000,
        });
        expect(run.status, run.stderr).toBe(0);
        expect(run.stderr).toBe("");
        expect(run.stdout).toBe("");
        const pid = Number(readFileSync(pidFile, "utf8"));
        expect(pid).toBeGreaterThan(0);
        expect(() => process.kill(pid, 0)).toThrow();
      }
      writeFileSync(join(dir, "disk.ts"), "export const disk = true;\n");
      writeFileSync(join(dir, "hidden.ts"), "export const hidden = true;\n");
      writeFileSync(join(dir, "empty.ts"), "INVALID TYPESCRIPT !\n");
      const oracle = await runClient(
        process.execPath,
        ["--import", "tsx", oracleEntry],
        dir,
        join(dir, "oracle.json"),
      );
      if (process.platform !== "win32") {
        // With the shared server requested, a checker without --listen exits
        // as it starts and the build checks with its own process.
        const runtime = join(dir, "api-run");
        mkdirSync(runtime, { mode: 0o700 });
        const api = spawnSync(built.binaryPath, [tsgoExecutable(), dir, "unused", "api"], {
          encoding: "utf8",
          timeout: 45_000,
          env: { ...process.env, XDG_RUNTIME_DIR: runtime, SCRIPTC_CHECKER_SERVER: "1" },
        });
        expect(api.status, api.stderr).toBe(0);
        expect(api.stdout).toBe("");
        expect(api.stderr).toBe("");
      }
      const report = join(dir, "native.json");
      // Only ordinary stdio is inherited. The native executable starts the
      // actual tsgo process; the test runner never creates its RPC pipes. As in
      // ts7-client-harness.ts, the protocol cases run against tsgo.
      const run = spawnSync(built.binaryPath, [tsgoExecutable(), dir, report], {
        encoding: "utf8",
        timeout: 45_000,
      });
      expect(run.error, run.stderr).toBeUndefined();
      expect(run.signal, run.stderr).toBeNull();
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toBe("");
      expect(run.stderr).toBe("");
      const {
        surrogateBoundary: oracleAst,
        semanticSurrogateBoundary: oracleSemantic,
        ...oracleFacts
      } = JSON.parse(oracle);
      const {
        surrogateBoundary: nativeAst,
        semanticSurrogateBoundary: nativeSemantic,
        ...nativeFacts
      } = JSON.parse(readFileSync(report, "utf8"));
      expect([oracleAst, oracleSemantic]).toEqual(["preserved", "preserved"]);
      expect([nativeAst, nativeSemantic]).toEqual(["preserved", "preserved"]);
      expect(nativeFacts).toEqual(oracleFacts);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
