import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { nativeCodegenDiag } from "../diagnostics/diagnostic.js";
import { compilerReleaseVersion } from "../library/sidecar.js";
import type { NativeLinkFeatures } from "./native-link-info.js";
import { RUNTIME_ABI_MARKER, RUNTIME_ABI_VERSION } from "./runtime-abi.js";
import { RuntimePackError, type RuntimePackManifest } from "./runtime-pack-core.js";
import {
  runtimePackManifest,
  selectNativeRuntimePack,
  stageNativeRuntimeSelection,
  type NativeRuntimeSelection,
  type RuntimePackStore,
} from "./runtime-pack-native.js";
import { MACOS_ARM64_TARGET, WASM32_WASI_TARGET } from "./targets.js";

vi.mock("node:crypto", async (original) => {
  const crypto = await original<typeof import("node:crypto")>();
  return { ...crypto, createHash: vi.fn(crypto.createHash) };
});
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, readFileSync: vi.fn(fs.readFileSync) };
});

const dirs: string[] = [];
afterEach(async () =>
  Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))),
);

test("a missing cross-target runtime pack names its package in the diagnostic", async () => {
  const root = await mkdtemp(join(tmpdir(), "scriptc-runtime-pack-native-"));
  dirs.push(root);
  let error: unknown;
  try {
    selectNativeRuntimePack(
      join(root, "runtime-wasm32-wasi"),
      WASM32_WASI_TARGET,
      "0.3.5",
      {} as NativeLinkFeatures,
      "release",
    );
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(RuntimePackError);
  const pack = error as RuntimePackError;
  expect(pack.code).toBe("missing");
  const diagnostic = nativeCodegenDiag("SC3003", pack.message, "main.ts", pack.hint);
  expect(diagnostic.message).toBe(
    "runtime pack for wasm32-wasi is not installed; install @scriptc/runtime-wasm32-wasi@0.3.5 in your project or set SCRIPTC_RUNTIME_PACK to its directory",
  );
  expect(diagnostic.hint).toBe(
    "scriptc includes the runtime pack for its own platform only; other targets need their runtime pack package in the project",
  );
});

test("a missing native helper keeps the reinstall hint", () => {
  expect(nativeCodegenDiag("SC3003", "helper missing", "main.ts").hint).toBe(
    "reinstall scriptc with optional dependencies enabled for this host",
  );
});

/** A runtime pack with one runtime object and a license, and a store that
 * keeps entries in memory. */
async function packFixture() {
  const root = await mkdtemp(join(tmpdir(), "scriptc-runtime-pack-store-"));
  dirs.push(root);
  const target = MACOS_ARM64_TARGET;
  const version = compilerReleaseVersion();
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: target.runtimePackPackage, version }),
  );
  mkdirSync(join(root, "artifacts"));
  const object = join(root, "artifacts", "base.o");
  writeFileSync(object, "base object");
  writeFileSync(join(root, "license.txt"), "license");
  const unit = {
    source: "scr_base.c",
    predicate: true,
    variants: [
      {
        id: "default",
        when: {},
        defines: [],
        path: "artifacts/base.o",
        sha256: createHash("sha256").update("base object").digest("hex"),
        size: Buffer.byteLength("base object"),
      },
    ],
  };
  const manifest: RuntimePackManifest = {
    schema: "scriptc.runtime-pack.v1",
    format: 1,
    package: target.runtimePackPackage,
    version,
    target: {
      name: target.name,
      llvm_triple: target.llvmTriple,
      architecture: target.architecture,
      object_format: target.objectFormat,
      minimum_os: target.minimumOs,
    },
    runtime_abi: { version: RUNTIME_ABI_VERSION, marker: RUNTIME_ABI_MARKER },
    compiler: { command: "clang", identity: "fixture clang", target: target.llvmTriple },
    macros: {
      executable: [],
      excluded: ["SCR_LIB", "SCR_THREAD_INSTANCES", "SCR_RC_AUDIT"],
      sanitizer: "external-toolchain-required",
    },
    flavors: {
      release: { optimization: "-O2", runtime_units: [unit] },
      dev: { optimization: "-O0", runtime_units: [unit] },
    },
    archives: [],
    system_libraries: [{ name: "System", predicate: true }],
    licenses: [{ path: "license.txt", license: "fixture" }],
  };
  const manifestText = JSON.stringify(manifest);
  writeFileSync(join(root, "runtime-pack.json"), manifestText);
  const entries = new Map<string, string>();
  const store: RuntimePackStore = {
    read: (key) => entries.get(key) ?? null,
    write: (key, text) => void entries.set(key, text),
  };
  const select = () =>
    selectNativeRuntimePack(
      root,
      target,
      version,
      {} as NativeLinkFeatures,
      "release",
      "executable",
      store,
    );
  let stages = 0;
  const stage = (selection: NativeRuntimeSelection) => {
    const directory = join(root, `stage-${stages++}`);
    mkdirSync(directory);
    return stageNativeRuntimeSelection(selection, directory, store);
  };
  return { root, object, manifestText, entries, select, stage };
}

test("a stored selection answers while the pack's files keep their identities", async () => {
  const f = await packFixture();
  const first = f.select();
  expect(first.selected.systemLibraries).toEqual(["System"]);
  expect(f.entries.size).toBe(1);
  // The next selection reads the stored answer instead of the manifest.
  const [key, text] = [...f.entries][0]!;
  const stored = JSON.parse(text);
  stored.selected.systemLibraries = ["Stored"];
  f.entries.set(key, JSON.stringify(stored));
  const second = f.select();
  expect(second.selected.systemLibraries).toEqual(["Stored"]);
  expect(second.licenses).toEqual(first.licenses);
  expect(second.manifest).toBeUndefined();
  expect(runtimePackManifest(second).flavors.release).toEqual(first.manifest!.flavors.release);
  // Writing the manifest again, with the same text, gives it a new identity.
  writeFileSync(join(f.root, "runtime-pack.json"), f.manifestText);
  expect(f.select().selected.systemLibraries).toEqual(["System"]);
});

test.each(["replaced", "rewritten in place"])(
  "staging hashes an artifact again when it is %s, even at the same size and mtime",
  async (change) => {
    const f = await packFixture();
    const selection = f.select();
    f.stage(selection);
    const before = statSync(f.object);
    const changed = change === "replaced" ? f.object + ".new" : f.object;
    writeFileSync(changed, "x".repeat(before.size));
    utimesSync(changed, before.atime, before.mtime);
    if (changed !== f.object) renameSync(changed, f.object);
    expect(() => f.stage(selection)).toThrow(
      "runtime pack artifact hash mismatch: artifacts/base.o",
    );
  },
);

test("staging does not hash an unchanged artifact again", async () => {
  const f = await packFixture();
  const selection = f.select();
  const hashes = () => vi.mocked(createHash).mock.calls.length;
  let start = hashes();
  f.stage(selection);
  const firstStage = hashes() - start;
  start = hashes();
  const staged = f.stage(selection);
  // Only the store key is hashed; the staged copy has the verified bytes.
  expect(hashes() - start).toBe(firstStage - 1);
  expect(readFileSync(staged.runtimeObjects[0]!, "utf8")).toBe("base object");
});

test.skipIf(process.platform === "win32")(
  "staging reads an artifact's bytes from the file whose identity it checks",
  async () => {
    const f = await packFixture();
    // The artifact path is a symbolic link to the verified file.
    const real = f.object + ".real";
    renameSync(f.object, real);
    symlinkSync(real, f.object);
    const selection = f.select();
    f.stage(selection);
    // During the next read the link names another file of the same size,
    // and it names the verified file again before the read ends.
    const other = f.object + ".other";
    writeFileSync(other, "x".repeat(statSync(real).size));
    const read = vi.mocked(readFileSync);
    const original = read.getMockImplementation()!;
    read.mockImplementation(((source: Parameters<typeof readFileSync>[0], ...rest: unknown[]) => {
      if (typeof source === "string" && !source.endsWith("base.o"))
        return (original as (...args: unknown[]) => unknown)(source, ...rest);
      read.mockImplementation(original);
      unlinkSync(f.object);
      symlinkSync(other, f.object);
      try {
        return (original as (...args: unknown[]) => unknown)(source, ...rest);
      } finally {
        unlinkSync(f.object);
        symlinkSync(real, f.object);
      }
    }) as typeof readFileSync);
    const staged = f.stage(selection);
    expect(read.getMockImplementation()).toBe(original);
    expect(readFileSync(staged.runtimeObjects[0]!, "utf8")).toBe("base object");
  },
);
