import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyzeInChild, compileInChild } from "./self-hosting-compiler-process.js";
import {
  NATIVE_TARGETS,
  nativeCodegenTarget,
} from "../../packages/compiler/src/backend/targets.js";
import type { NativeLinkFeatures } from "../../packages/compiler/src/backend/native-link-info.js";
import type { RuntimePackManifest } from "../../packages/compiler/src/backend/runtime-pack-core.js";

const root = join(import.meta.dirname, "../..");
const entry = join(root, "tests/fixtures/self-hosting/runtime-pack.ts");
const base: NativeLinkFeatures = {
  regex: false,
  copying: false,
  textDecoderLegacy: false,
  fileHandle: false,
  fetch: false,
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
  utilPromisify: false,
  dynBuiltinClass: false,
  dynBuiltinStream: false,
  parseArgs: false,
  stream: false,
  net: false,
  http: false,
  http2: false,
  dgram: false,
  dnsPromises: false,
  dgramDyn: false,
  textCodecDyn: false,
  watch: false,
  foreignFfi: false,
  nodeTest: false,
  tls: false,
  tlsCa: false,
  cipher: false,
  ecdh: false,
  dh: false,
  pki: false,
  ed25519: false,
  x509: false,
  webcrypto: false,
  perfLoop: false,
};

test("runtime manifest validation and selection are entirely static", async () => {
  const coverage = await analyzeInChild(entry, {});
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.stats.statementsTotal).toBeGreaterThan(50);
  expect(coverage.stats.statementsFailed).toBe(0);
  expect(coverage.stats.functionsSkipped).toBe(0);
});

for (const backend of ["llvm"] as const) {
  test(`native runtime manifest selection matches Node (${backend})`, async () => {
    const directory = mkdtempSync(
      join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-pack-selection-"),
    );
    try {
      const built = await compileInChild(entry, {
        outDir: directory,
        outPath: join(directory, "selection" + (process.platform === "win32" ? ".exe" : "")),
        backend,
        optimization: "dev",
        sanitize: process.env["SCRIPTC_SAN"] === "1",
      });
      if (!built.ok) throw new Error(JSON.stringify(built.diagnostics));
      expect(built.backend).toBe(backend);
      const input = join(directory, "request.json");
      const check = (request: object, status: number, name: string) => {
        writeFileSync(input, JSON.stringify(request));
        const options = { cwd: root, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 };
        const oracle = spawnSync(process.execPath, ["--import", "tsx", entry, input], options);
        const native = spawnSync(built.binaryPath, [input], {
          ...options,
          env: { ...process.env, PATH: "" },
        });
        for (const result of [oracle, native]) {
          expect(result.error, name).toBeUndefined();
          expect(result.signal, name).toBeNull();
          expect(result.status, `${name}: ${result.stderr}`).toBe(status);
        }
        if (status === 0)
          expect(JSON.parse(native.stdout.toString()), name).toEqual(
            JSON.parse(oracle.stdout.toString()),
          );
        else expect(native.stdout.toString(), name).toBe(oracle.stdout.toString());
        expect(native.stderr, name).toEqual(oracle.stderr);
        return native.stdout.toString();
      };
      // The installed manifest exercises the actual predicates and variants.
      // Substitute each target identity to exercise validation on every host.
      const hostTarget = nativeCodegenTarget()!;
      const packageDir = join(
        root,
        "packages",
        hostTarget.runtimePackPackage.replace("@scriptc/", ""),
      );
      const installed = JSON.parse(
        readFileSync(join(packageDir, "runtime-pack.json"), "utf8"),
      ) as RuntimePackManifest;
      for (const target of NATIVE_TARGETS) {
        const manifest: RuntimePackManifest = {
          ...installed,
          package: target.runtimePackPackage,
          target: {
            name: target.name,
            llvm_triple: target.llvmTriple,
            architecture: target.architecture,
            object_format: target.objectFormat,
            minimum_os: target.minimumOs,
          },
          compiler: { ...installed.compiler, target: target.llvmTriple },
        };
        const request = {
          manifest,
          target,
          packageName: manifest.package,
          packageVersion: manifest.version,
          compilerVersion: manifest.version,
          features: base,
          flavor: "release",
        };
        check(request, 0, target.name + " base");
        if (target.name === hostTarget.name) {
          for (const name of Object.keys(base)) {
            check({ ...request, features: { ...base, [name]: true } }, 0, target.name + " " + name);
          }
          const all = Object.fromEntries(Object.keys(base).map((name) => [name, true]));
          check({ ...request, features: all, flavor: "dev" }, 0, target.name + " all");
        }
        check({ ...request, packageVersion: "mismatch" }, 1, "package version");
        check(
          {
            ...request,
            manifest: { ...manifest, target: { ...manifest.target, minimum_os: "other" } },
          },
          1,
          "target identity",
        );
        check(
          { ...request, manifest: { ...manifest, runtime_abi: { version: 0, marker: "wrong" } } },
          1,
          "runtime ABI",
        );
        check({ ...request, manifest: { ...manifest, flavors: {} } }, 1, "missing flavor");
        check(
          {
            ...request,
            manifest: {
              ...manifest,
              archives: [
                { path: "../escape", sha256: "0".repeat(64), size: 1, id: "zlib", predicate: true },
              ],
            },
          },
          1,
          "artifact traversal",
        );
        check(
          {
            ...request,
            manifest: { ...manifest, system_libraries: [{ name: "m", predicate: { any: [1] } }] },
          },
          1,
          "invalid predicate",
        );
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
