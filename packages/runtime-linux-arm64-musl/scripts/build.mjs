import { dirname } from "node:path"; import { fileURLToPath } from "node:url";
if (process.platform !== "linux" || process.arch !== "arm64") { process.stdout.write("@scriptc/runtime-linux-arm64-musl: skipped on this host\n"); process.exit(0); }
process.env.SCRIPTC_RUNTIME_PACK_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
process.env.SCRIPTC_RUNTIME_PACK_CONFIG = JSON.stringify({ platform: "linux", runtimeDefines: ["_GNU_SOURCE", "SCR_MUSL"], threadArgs: ["-pthread"], extraRuntimeSources: ["scr_musl.c"], compiler: "zig", compilerArgs: ["cc"], archiver: "zig", archiverArgs: ["ar"], target: { name: "linux-arm64-musl", llvm_triple: "aarch64-unknown-linux-musl", architecture: "arm64", object_format: "elf", minimum_os: "musl 1.2" }, targetArgs: ["-target", "aarch64-linux-musl"], compileFlags: ["-ffunction-sections", "-fdata-sections"], systemLibraries: [{ name: "m", predicate: true }] });
await import("../../runtime-pack-common/scripts/build.mjs");
