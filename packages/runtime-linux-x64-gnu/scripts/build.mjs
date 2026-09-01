import { dirname } from "node:path"; import { fileURLToPath } from "node:url";
if (process.platform !== "linux" || process.arch !== "x64") { process.stdout.write("@scriptc/runtime-linux-x64-gnu: skipped on this host\n"); process.exit(0); }
process.env.SCRIPTC_RUNTIME_PACK_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
process.env.SCRIPTC_RUNTIME_PACK_CONFIG = JSON.stringify({ platform: "linux", runtimeDefines: ["_GNU_SOURCE"], threadArgs: ["-pthread"], target: { name: "linux-x64-gnu", llvm_triple: "x86_64-unknown-linux-gnu", architecture: "x64", object_format: "elf", minimum_os: "glibc 2.36" }, targetArgs: ["-target", "x86_64-unknown-linux-gnu"], compileFlags: ["-ffunction-sections", "-fdata-sections"], systemLibraries: [{ name: "m", predicate: true }] });
await import("../../runtime-pack-common/scripts/build.mjs");
