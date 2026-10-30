import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { glibcRuntimeToolchain } from "../../runtime-pack-common/scripts/glibc-toolchain.mjs";

if (
  process.env.SCRIPTC_BUILD_CROSS !== "1" &&
  (process.platform !== "linux" || process.arch !== "arm64")
) {
  process.stdout.write("@scriptc/runtime-linux-arm64-gnu: skipped on this host\n");
  process.exit(0);
}
process.env.SCRIPTC_RUNTIME_PACK_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const { minimumOs, ...toolchain } = glibcRuntimeToolchain("arm64");
process.env.SCRIPTC_RUNTIME_PACK_CONFIG = JSON.stringify({
  platform: "linux",
  runtimeDefines: ["_GNU_SOURCE"],
  threadArgs: ["-pthread"],
  target: {
    name: "linux-arm64-gnu",
    llvm_triple: "aarch64-unknown-linux-gnu",
    architecture: "arm64",
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
