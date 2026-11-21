import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
if (
  process.env.SCRIPTC_BUILD_CROSS !== "1" &&
  (process.platform !== "darwin" || process.arch !== "arm64")
) {
  process.stdout.write("@scriptc/runtime-darwin-arm64: skipped on this host\n");
  process.exit(0);
}
// The pack builds with the shared builder and matrix
// (runtime-pack-common/scripts/build.mjs, runtime-pack-matrix.mjs), as every
// other platform pack does, so its runtime units, vendor archives and macros
// cannot drift from theirs.
process.env.SCRIPTC_RUNTIME_PACK_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
process.env.SCRIPTC_RUNTIME_PACK_CONFIG = JSON.stringify({
  platform: "darwin",
  runtimeDefines: [],
  threadArgs: ["-pthread"],
  target: {
    name: "macos-arm64",
    llvm_triple: "arm64-apple-macosx14.0.0",
    architecture: "arm64",
    object_format: "macho",
    minimum_os: "14.0",
  },
  targetArgs: ["-target", "arm64-apple-macosx14.0.0"],
  // ld64 dead-strips Mach-O symbol subsections without an ELF-style compile
  // flag; the compiler passes -Wl,-dead_strip when it links.
  compileFlags: [],
  systemLibraries: [{ name: "System", predicate: true }],
});
await import("../../runtime-pack-common/scripts/build.mjs");
