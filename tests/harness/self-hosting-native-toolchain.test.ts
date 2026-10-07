import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyzeInChild, compileInChild } from "./self-hosting-compiler-process.js";
import { nativeCodegenTarget } from "../../packages/compiler/src/backend/targets.js";
import type { NativeLinkFeatures } from "../../packages/compiler/src/backend/native-link-info.js";
import type { RuntimePackManifest } from "../../packages/compiler/src/backend/runtime-pack-core.js";
import type { NativeToolchainManifest } from "../../packages/compiler/src/native/toolchain.js";

const root = join(import.meta.dirname, "../..");
const entry = join(root, "tests/fixtures/self-hosting/native-toolchain.ts");
const features: NativeLinkFeatures = {
  dynamic: false,
  regex: false,
  copying: false,
  textDecoderLegacy: false,
  fileHandle: false,
  fetch: false,
  netIsland: false,
  zlib: false,
  assert: false,
  inspect: false,
  dynInvoke: false,
  dc: false,
  dynAsync: false,
  events: false,
  emitter: false,
  symbol: false,
  bigint: false,
  searchParams: false,
  qs: false,
  parseArgs: false,
  stream: false,
  net: false,
  http: false,
  http2: false,
  dgram: false,
  watch: false,
  foreignFfi: false,
  nodeTest: false,
  tls: false,
  tlsCa: false,
};

test("native toolchain configuration, staging and helper validation are static", async () => {
  const coverage = await analyzeInChild(entry, { dynamic: false });
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.stats.statementsFailed).toBe(0);
  expect(coverage.stats.statementsIsland).toBe(0);
  expect(coverage.stats.functionsSkipped).toBe(0);
});

for (const backend of ["llvm"] as const) {
  test(`native toolchain integrity and failure behavior match Node (${backend})`, async () => {
    const directory = mkdtempSync(
      join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-native-integrity-"),
    );
    const target = nativeCodegenTarget()!;
    try {
      const built = await compileInChild(entry, {
        outDir: directory,
        outPath: join(directory, "toolchain" + target.outputSuffixes.exe),
        backend,
        optimization: "dev",
        dynamic: false,
        sanitize: process.env["SCRIPTC_SAN"] === "1",
      });
      if (!built.ok) throw new Error(JSON.stringify(built.diagnostics));
      expect(built.backend).toBe(backend);
      const pack = join(directory, "pack");
      mkdirSync(pack);
      const bytes = Buffer.from([0, 255, 1, 128, 10, 0]);
      const artifact = {
        path: "objects/base.o",
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
      mkdirSync(join(pack, "objects"));
      writeFileSync(join(pack, artifact.path), bytes);
      writeFileSync(join(pack, "license.txt"), "license");
      const units = [
        {
          source: "base.c",
          predicate: true,
          variants: [{ id: "default", when: {}, defines: [], ...artifact }],
        },
      ];
      const manifest: RuntimePackManifest = {
        schema: "scriptc.runtime-pack.v1",
        format: 1,
        package: target.runtimePackPackage,
        version: "1.2.3",
        target: {
          name: target.name,
          llvm_triple: target.llvmTriple,
          architecture: target.architecture,
          object_format: target.objectFormat,
          minimum_os: target.minimumOs,
        },
        runtime_abi: { version: 7, marker: "scr_runtime_abi_v7" },
        compiler: { command: "fixture", identity: "fixture", target: target.llvmTriple },
        macros: { executable: [], excluded: [], sanitizer: "external-toolchain-required" },
        flavors: {
          release: { optimization: "-O2", runtime_units: units },
          dev: { optimization: "-O0", runtime_units: units },
        },
        archives: [],
        system_libraries: [{ name: "fixture", predicate: true }],
        licenses: [{ path: "license.txt", license: "fixture" }],
      };
      const manifestPath = join(pack, "runtime-pack.json");
      writeFileSync(manifestPath, JSON.stringify(manifest));
      writeFileSync(
        join(pack, "package.json"),
        JSON.stringify({ name: manifest.package, version: manifest.version }),
      );
      const toolchain = join(directory, "toolchain.json");
      const config: NativeToolchainManifest = {
        schema: "scriptc.native-toolchain.v1",
        compiler_version: manifest.version,
        target: target.name,
        ts7: "ts7",
        llvm_package: "llvm",
        runtime_pack: "pack",
        linker: "ld",
        linker_args: [],
        dsymutil: "dsymutil",
      };
      writeFileSync(toolchain, JSON.stringify(config));
      const input = join(directory, "request.json");
      const stage = join(directory, "stage");
      const version = {
        ok: true,
        protocol_version: "1",
        scriptc_package_version: manifest.version,
        llvm_version: "22.1.8",
        host_triple: target.llvmTriple,
        targets: [target.llvmBackend],
        supported_targets: [target.llvmTriple],
        default_target: target.helper.defaultTarget,
        data_layout: target.helper.defaultDataLayout,
      };
      const check = (
        status: number,
        message: string,
        action = "stage",
        helperVersion: object = version,
      ) => {
        writeFileSync(
          input,
          JSON.stringify({ toolchain, stage, features, action, version: helperVersion }),
        );
        const options = { cwd: root, timeout: 30_000, maxBuffer: 1024 * 1024 };
        const results = [];
        for (const native of [false, true]) {
          rmSync(stage, { recursive: true, force: true });
          const result = spawnSync(
            native ? built.binaryPath : process.execPath,
            native ? [input] : ["--import", "tsx", entry, input],
            native ? { ...options, env: { ...process.env, PATH: "" } } : options,
          );
          expect(result.error).toBeUndefined();
          expect(result.signal).toBeNull();
          expect(result.status, result.stderr.toString()).toBe(status);
          expect(result.stdout.toString()).toContain(message);
          results.push(result);
        }
        expect(results[1]!.stdout).toEqual(results[0]!.stdout);
        expect(results[1]!.stderr).toEqual(results[0]!.stderr);
      };
      check(0, "base.o");
      expect(readFileSync(join(stage, artifact.path))).toEqual(bytes);
      // A later replacement of the installed input cannot change staged bytes.
      writeFileSync(join(pack, artifact.path), Buffer.from("changed"));
      expect(readFileSync(join(stage, artifact.path))).toEqual(bytes);
      check(1, "hash mismatch");
      expect(existsSync(join(stage, artifact.path))).toBe(false);
      writeFileSync(join(pack, artifact.path), bytes);
      rmSync(join(pack, "license.txt"));
      check(1, "license payload is incomplete");
      writeFileSync(join(pack, "license.txt"), "license");
      rmSync(join(pack, artifact.path));
      check(1, "artifact is missing");
      writeFileSync(join(pack, artifact.path), bytes);
      writeFileSync(toolchain, JSON.stringify({ ...config, compiler_version: "other" }));
      check(1, "version mismatch");
      writeFileSync(toolchain, JSON.stringify(config));
      check(0, "1 1.2.3 22.1.8", "helper");
      for (const [field, value] of Object.entries({
        protocol_version: "2",
        llvm_version: "0",
        scriptc_package_version: "other",
        targets: [],
        supported_targets: [],
        default_target: "other",
        data_layout: "other",
        host_triple: null,
      })) {
        check(1, field, "helper", { ...version, [field]: value });
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
