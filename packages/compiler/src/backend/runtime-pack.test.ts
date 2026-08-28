import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { compilerReleaseVersion } from "../library/sidecar.js";
import type { NativeLinkFeatures } from "./native-link-info.js";
import {
  effectiveRuntimeFeatures,
  evaluateRuntimePredicate,
  loadRuntimePack,
  parseRuntimePackManifest,
  type RuntimePackManifest,
} from "./runtime-pack.js";
import { MACOS_ARM64_TARGET } from "./targets.js";

const VERSION = compilerReleaseVersion();

const BASE: NativeLinkFeatures = {
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

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "scriptc-runtime-pack-unit-"));
  const packagePath = join(root, "package.json");
  await writeFile(packagePath, JSON.stringify({
    name: "@scriptc/runtime-darwin-arm64",
    version: VERSION,
  }));
  const artifact = async (path: string, bytes: string) => {
    const output = join(root, path);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, bytes);
    return {
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: Buffer.byteLength(bytes),
    };
  };
  const base = await artifact("artifacts/base.o", "base");
  const legacy = await artifact("artifacts/legacy.o", "legacy");
  const dynamic = await artifact("artifacts/dynamic.o", "dynamic");
  const regex = await artifact("artifacts/regex.a", "regex");
  const quickjs = await artifact("artifacts/qjs.a", "qjs");
  await writeFile(join(root, "license.txt"), "license");
  const units = [{
    source: "scr_bytes.c",
    predicate: true,
    variants: [
      { id: "default", when: {}, defines: [], ...base },
      { id: "legacy", when: { textDecoderLegacy: true }, defines: ["SCR_TEXT_DECODER_LEGACY"], ...legacy },
      { id: "dynamic", when: { dynamic: true }, defines: ["SCR_DYNAMIC"], ...dynamic },
    ],
  }];
  const manifest: RuntimePackManifest = {
    schema: "scriptc.runtime-pack.v1",
    format: 1,
    package: "@scriptc/runtime-darwin-arm64",
    version: VERSION,
    target: {
      name: "macos-arm64",
      llvm_triple: "arm64-apple-macosx14.0.0",
      architecture: "arm64",
      object_format: "macho",
      minimum_os: "14.0",
    },
    runtime_abi: { version: 1, marker: "scr_runtime_abi_v1" },
    compiler: {
      command: "clang",
      identity: "fixture clang",
      target: "arm64-apple-macosx14.0.0",
    },
    macros: {
      executable: ["SCR_DYNAMIC", "SCR_TEXT_DECODER_LEGACY"],
      excluded: ["SCR_LIB", "SCR_THREAD_INSTANCES", "SCR_RC_AUDIT"],
      sanitizer: "external-toolchain-required",
    },
    flavors: {
      release: { optimization: "-O2", runtime_units: units },
      dev: { optimization: "-O0", runtime_units: units },
    },
    archives: [
      { id: "libregexp", predicate: { all: ["regex"], not: ["dynamic"] }, ...regex },
      { id: "quickjs", predicate: "dynamic", ...quickjs },
    ],
    system_libraries: [{ name: "System", predicate: true }],
    licenses: [{ path: "license.txt", license: "fixture" }],
  };
  await writeFile(join(root, "runtime-pack.json"), JSON.stringify(manifest));
  return { root, packagePath, manifest };
}

describe("runtime pack manifests", () => {
  test("feature implications and predicates are deterministic", () => {
    const features = effectiveRuntimeFeatures({ ...BASE, dynamic: true, fetch: true });
    expect(features).toMatchObject({
      nativeFetch: true,
      netIslandEffective: true,
      netEffective: true,
      httpEffective: true,
      tlsEffective: true,
      tlsCaEffective: true,
      zlibEffective: true,
    });
    expect(evaluateRuntimePredicate({ all: ["fetch"], not: ["regex"] }, features)).toBe(true);
    expect(evaluateRuntimePredicate({ any: ["regex", "dynamic"] }, features)).toBe(true);
  });

  test("selection chooses the most-specific variant and feature archive", async () => {
    const { packagePath } = await fixture();
    const resolver = () => packagePath;
    const legacy = await loadRuntimePack({
      target: MACOS_ARM64_TARGET,
      features: { ...BASE, textDecoderLegacy: true, regex: true },
      optimization: "release",
      resolver,
    });
    expect(legacy.runtimeObjects.map((path) => path.split("/").at(-1))).toEqual(["legacy.o"]);
    expect(legacy.archives.map((path) => path.split("/").at(-1))).toEqual(["regex.a"]);
    const dynamic = await loadRuntimePack({
      target: MACOS_ARM64_TARGET,
      features: { ...BASE, dynamic: true, regex: true },
      optimization: "dev",
      resolver,
    });
    expect(dynamic.flavor).toBe("dev");
    expect(dynamic.runtimeObjects.map((path) => path.split("/").at(-1))).toEqual(["dynamic.o"]);
    expect(dynamic.archives.map((path) => path.split("/").at(-1))).toEqual(["qjs.a"]);
  });

  test("malformed manifests and damaged artifacts fail before linking", async () => {
    const { packagePath, manifest, root } = await fixture();
    expect(() => parseRuntimePackManifest({ ...manifest, format: 2 })).toThrow("malformed");
    await writeFile(join(root, "artifacts/base.o"), "damaged");
    await expect(loadRuntimePack({
      target: MACOS_ARM64_TARGET,
      features: BASE,
      optimization: "release",
      resolver: () => packagePath,
    })).rejects.toThrow("hash mismatch");
    expect(await readFile(packagePath, "utf8")).toContain("runtime-darwin-arm64");
  });
});
