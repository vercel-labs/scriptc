import { dirname, join } from "node:path"; import { fileURLToPath } from "node:url";
if (process.platform !== "darwin" || process.arch !== "x64") { process.stdout.write("@scriptc/runtime-darwin-x64: skipped on this host\n"); process.exit(0); }
process.env.SCRIPTC_RUNTIME_PACK_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
process.env.SCRIPTC_RUNTIME_PACK_CONFIG = JSON.stringify({ platform: "darwin", runtimeDefines: [], threadArgs: ["-pthread"], target: { name: "macos-x64", llvm_triple: "x86_64-apple-macosx14.0.0", architecture: "x64", object_format: "macho", minimum_os: "14.0" }, targetArgs: ["-target", "x86_64-apple-macosx14.0.0"], compileFlags: [], systemLibraries: [{ name: "System", predicate: true }, { name: "m", predicate: "dynamic" }] });
await import("../../runtime-pack-common/scripts/build.mjs");
