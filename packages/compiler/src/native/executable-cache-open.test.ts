import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { NativeLinkFeatures } from "../backend/native-link-info.js";
import type { NativeRuntimeSelection } from "../backend/runtime-pack-native.js";
import { NativeCache } from "./cache.js";
import { type ExecutableRuntimePack, openNativeExecutableCache } from "./executable-cache.js";
import type { NativeToolchain } from "./toolchain.js";

const directories: string[] = [];
const saved = new Map<string, string | undefined>();
beforeEach(() => {
  for (const name of ["SCRIPTC_LINKER", "SCRIPTC_LLVM_HELPER", "CC", "LDFLAGS", "LIBRARY_PATH"]) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
});
afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** A toolchain whose linker is a driver script named `driver`; it answers
 * `-print-prog-name=clang` with its own path. */
function fixture(platform: string, driver: string) {
  const root = mkdtempSync(join(tmpdir(), "scriptc-executable-cache-open-"));
  directories.push(root);
  const bin = join(root, "bin");
  const helper = join(root, "helper");
  const runtime = join(root, "runtime");
  for (const directory of [bin, helper, runtime]) mkdirSync(directory);
  const linker = join(bin, driver);
  writeFileSync(linker, '#!/bin/sh\necho "$0"\n');
  chmodSync(linker, 0o755);
  writeFileSync(join(helper, "codegen"), "helper");
  writeFileSync(join(helper, "package.json"), "{}");
  writeFileSync(join(runtime, "package.json"), "{}");
  writeFileSync(join(runtime, "runtime-pack.json"), "{}");
  const toolchain = {
    compilerVersion: "test",
    target: { platform },
    helperExecutable: join(helper, "codegen"),
    helperPackageRoot: helper,
    runtimePackRoot: runtime,
    linker,
    linkerArgs: [],
    dsymutil: "dsymutil",
  } as unknown as NativeToolchain;
  const pack: ExecutableRuntimePack = {
    root: runtime,
    features: {} as NativeLinkFeatures,
    flavor: "release",
    select: () =>
      ({
        root: runtime,
        licenses: [],
        packageText: "{}",
        manifestText: "{}",
        selected: { runtime: [], archives: [] },
        flavor: "release",
      }) as unknown as NativeRuntimeSelection,
  };
  const open = () =>
    openNativeExecutableCache(
      new NativeCache(join(root, "cache")),
      toolchain,
      () => "llvm digest",
      { outPath: join(root, "program"), outDir: root, optimization: "release" },
      null,
      pack,
    );
  return { open };
}

test.skipIf(process.platform === "win32")(
  "Linux builds that link with a clang driver use the executable cache",
  () => {
    expect(fixture("linux", "clang").open()).not.toBeNull();
    expect(fixture("linux", "clang-22").open()).not.toBeNull();
    expect(fixture("linux", "gcc").open()).toBeNull();
    expect(fixture("windows", "clang").open()).toBeNull();
    expect(fixture("wasi", "clang").open()).toBeNull();
    // On darwin only Apple's driver at /usr/bin/clang qualifies.
    expect(fixture("darwin", "clang").open()).toBeNull();
    process.env["SCRIPTC_LLVM_HELPER"] = "/elsewhere/codegen";
    expect(fixture("linux", "clang").open()).toBeNull();
  },
);
