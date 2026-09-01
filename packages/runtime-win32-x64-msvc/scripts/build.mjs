import { dirname } from "node:path"; import { fileURLToPath } from "node:url";
if (process.platform !== "win32" || process.arch !== "x64") { process.stdout.write("@scriptc/runtime-win32-x64-msvc: skipped on this host\n"); process.exit(0); }
process.env.SCRIPTC_RUNTIME_PACK_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// The helper emits x64 COFF objects, whose calling convention is compatible
// with Zig's MinGW runtime. The runtime itself intentionally uses the
// POSIX-shaped Windows surface (unistd, dirent, clock_gettime), so compile it
// against Zig's Windows GNU sysroot rather than MSVC's headers.
process.env.SCRIPTC_RUNTIME_PACK_CONFIG = JSON.stringify({ platform: "win32", runtimeDefines: [], extraRuntimeSources: ["scr_win.c"], compiler: "zig", compilerArgs: ["cc"], archiver: "zig", archiverArgs: ["ar"], target: { name: "windows-x64-msvc", llvm_triple: "x86_64-pc-windows-msvc", architecture: "x64", object_format: "coff", minimum_os: "Windows 10" }, targetArgs: ["-target", "x86_64-windows-gnu"], compileFlags: ["-ffunction-sections", "-fdata-sections"], systemLibraries: [{ name: "advapi32", predicate: true }, { name: "iphlpapi", predicate: true }, { name: "ws2_32", predicate: true }, { name: "bcrypt", predicate: "tlsEffective" }, { name: "crypt32", predicate: "tlsCaEffective" }] });
await import("../../runtime-pack-common/scripts/build.mjs");
