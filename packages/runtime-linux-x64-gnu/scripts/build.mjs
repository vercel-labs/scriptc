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
  // scr_unwind_raise: the static libgcc_eh, which loads no shared library.
  systemLibraries: [
    { name: "m", predicate: true },
    { name: "gcc_eh", predicate: true },
  ],
});
await import("../../runtime-pack-common/scripts/build.mjs");
