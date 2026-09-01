import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { loadRuntimePack, type RuntimePackManifest } from "./runtime-pack.js";
import {
  LINUX_ARM64_GNU_TARGET,
  LINUX_ARM64_MUSL_TARGET,
  LINUX_X64_GNU_TARGET,
  LINUX_X64_MUSL_TARGET,
  MACOS_X64_TARGET,
  WASM32_WASI_TARGET,
  WINDOWS_X64_MSVC_TARGET,
  type NativeTargetSpec,
} from "./targets.js";
import { compilerReleaseVersion } from "../library/sidecar.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

async function fixture(target: NativeTargetSpec) {
  const root = await mkdtemp(join(tmpdir(), "scriptc-runtime-pack-target-"));
  dirs.push(root);
  const packagePath = join(root, "package.json");
  const bytes = Buffer.from("runtime object");
  const artifact = { path: "artifacts/runtime.o", sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
  await mkdir(dirname(join(root, artifact.path)), { recursive: true });
  await Promise.all([
    writeFile(join(root, artifact.path), bytes),
    writeFile(join(root, "LICENSE"), "license"),
    writeFile(packagePath, JSON.stringify({ name: target.runtimePackPackage, version: compilerReleaseVersion() })),
  ]);
  const manifest: RuntimePackManifest = {
    schema: "scriptc.runtime-pack.v1", format: 1, package: target.runtimePackPackage, version: compilerReleaseVersion(),
    target: { name: target.name, llvm_triple: target.llvmTriple, architecture: target.architecture, object_format: target.objectFormat, minimum_os: target.minimumOs },
    runtime_abi: { version: 1, marker: "scr_runtime_abi_v1" },
    compiler: { command: "fixture", identity: "fixture", target: target.llvmTriple },
    macros: { executable: [], excluded: ["SCR_LIB"], sanitizer: "external-toolchain-required" },
    flavors: {
      release: { optimization: "-O2", runtime_units: [{ source: "scr_runtime.c", predicate: true, variants: [{ id: "default", when: {}, defines: [], ...artifact }] }] },
      dev: { optimization: "-O0", runtime_units: [{ source: "scr_runtime.c", predicate: true, variants: [{ id: "default", when: {}, defines: [], ...artifact }] }] },
    },
    archives: [], system_libraries: [], licenses: [{ path: "LICENSE", license: "fixture" }],
  };
  await writeFile(join(root, "runtime-pack.json"), JSON.stringify(manifest));
  return { packagePath };
}

const features = {
  dynamic: false, regex: false, copying: false, textDecoderLegacy: false, fileHandle: false,
  fetch: false, netIsland: false, zlib: false, assert: false, inspect: false, dynInvoke: false,
  dc: false, dynAsync: false, events: false, emitter: false, symbol: false, searchParams: false,
  qs: false, parseArgs: false, stream: false, net: false, http: false, http2: false,
  dgram: false, watch: false, foreignFfi: false, nodeTest: false, tls: false, tlsCa: false,
};

test.each([
  MACOS_X64_TARGET, LINUX_X64_GNU_TARGET, LINUX_ARM64_GNU_TARGET,
  WINDOWS_X64_MSVC_TARGET, LINUX_X64_MUSL_TARGET, LINUX_ARM64_MUSL_TARGET, WASM32_WASI_TARGET,
])("runtime-pack validation selects the exact $name package", async (target) => {
  const pack = await fixture(target);
  const result = await loadRuntimePack({ target, features, optimization: "release", resolver: () => pack.packagePath });
  expect(result.manifest.package).toBe(target.runtimePackPackage);
  expect(result.manifest.target).toMatchObject({ name: target.name, architecture: target.architecture, object_format: target.objectFormat });
});
