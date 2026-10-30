import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { glibcRuntimeToolchain } from "../../runtime-pack-common/scripts/glibc-toolchain.mjs";

if (
  process.env.SCRIPTC_BUILD_CROSS !== "1" &&
  (process.platform !== "linux" || process.arch !== "x64")
) {
  process.stdout.write("@scriptc/runtime-linux-x64-gnu: skipped on this host\n");
  process.exit(0);
}
process.env.SCRIPTC_RUNTIME_PACK_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const { minimumOs, ...toolchain } = glibcRuntimeToolchain("x64");
process.env.SCRIPTC_RUNTIME_PACK_CONFIG = JSON.stringify({
  platform: "linux",
  runtimeDefines: ["_GNU_SOURCE"],
  threadArgs: ["-pthread"],
  target: {
    name: "linux-x64-gnu",
    llvm_triple: "x86_64-unknown-linux-gnu",
    architecture: "x64",
    object_format: "elf",
    minimum_os: minimumOs,
  },
  ...toolchain,
  compileFlags: ["-ffunction-sections", "-fdata-sections"],
  // Intl over ICU. The pack ships the C++ ICU archive and its data file
  // (artifacts/icu/icudt78l.dat); the cross and non-Linux packs omit both,
  // and the compiler refuses Intl there (SC3002). This slice is
  // linux-x64-gnu, the target the archive's Zig C++ recipe builds for.
  icu: true,
  // scr_unwind_raise: the static libgcc_eh, which loads no shared library.
  systemLibraries: [
    { name: "m", predicate: true },
    { name: "gcc_eh", predicate: true },
  ],
});
await import("../../runtime-pack-common/scripts/build.mjs");
