import { dirname } from "node:path"; import { fileURLToPath } from "node:url";
if (process.platform !== "linux" || process.arch !== "x64") { process.stdout.write("@scriptc/runtime-linux-x64-musl: skipped on this host\n"); process.exit(0); }
process.env.SCRIPTC_RUNTIME_PACK_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
process.env.SCRIPTC_RUNTIME_PACK_CONFIG = JSON.stringify({ platform: "linux", runtimeDefines: ["_GNU_SOURCE", "SCR_MUSL"], threadArgs: ["-pthread"], extraRuntimeSources: ["scr_musl.c"], compiler: "zig", compilerArgs: ["cc"], archiver: "zig", archiverArgs: ["ar"], target: { name: "linux-x64-musl", llvm_triple: "x86_64-unknown-linux-musl", architecture: "x64", object_format: "elf", minimum_os: "musl 1.2" }, targetArgs: ["-target", "x86_64-linux-musl"], compileFlags: ["-ffunction-sections", "-fdata-sections"], systemLibraries: [{ name: "m", predicate: true }] });
await import("../../runtime-pack-common/scripts/build.mjs");
