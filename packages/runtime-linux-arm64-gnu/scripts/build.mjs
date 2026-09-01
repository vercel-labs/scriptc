import { dirname } from "node:path"; import { fileURLToPath } from "node:url";
if (process.platform !== "linux" || process.arch !== "arm64") { process.stdout.write("@scriptc/runtime-linux-arm64-gnu: skipped on this host\n"); process.exit(0); }
process.env.SCRIPTC_RUNTIME_PACK_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
process.env.SCRIPTC_RUNTIME_PACK_CONFIG = JSON.stringify({ platform: "linux", runtimeDefines: ["_GNU_SOURCE"], threadArgs: ["-pthread"], target: { name: "linux-arm64-gnu", llvm_triple: "aarch64-unknown-linux-gnu", architecture: "arm64", object_format: "elf", minimum_os: "glibc 2.36" }, targetArgs: ["-target", "aarch64-unknown-linux-gnu"], compileFlags: ["-ffunction-sections", "-fdata-sections"], systemLibraries: [{ name: "m", predicate: true }] });
await import("../../runtime-pack-common/scripts/build.mjs");
