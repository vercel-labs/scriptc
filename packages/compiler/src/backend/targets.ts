import { release } from "node:os";

/** A helper package is host-specific, even when it emits a portable target
 * (the WASI helpers are the first intentionally cross-host case). */
export interface NativeHelperSpec {
  packageName: string;
  /** The helper protocol reports this primary target and its layout. */
  defaultTarget: string;
  defaultDataLayout: string;
  backend: "AArch64" | "X86" | "WebAssembly";
}

export type NativeTargetName =
  | "macos-arm64"
  | "macos-x64"
  | "linux-x64-gnu"
  | "linux-arm64-gnu"
  | "windows-x64-msvc"
  | "linux-x64-musl"
  | "linux-arm64-musl"
  | "wasm32-wasi";

export type NativeObjectFormat = "macho" | "elf" | "coff" | "wasm";
export type NativeTargetPlatform = "darwin" | "linux" | "win32" | "wasi";

export interface NativeTargetSpec {
  /** Stable scriptc-facing identity used in cache keys and diagnostics. */
  name: NativeTargetName;
  llvmTriple: string;
  dataLayout: string;
  cpu: "generic";
  features: "";
  pointerBits: 32 | 64;
  endianness: "little";
  objectFormat: NativeObjectFormat;
  relocationModel: "pic";
  codeModel: "small";
  /** OS deployment level, libc floor, or WASI ABI contract. */
  minimumOs: string;
  /** Minimum host contract for the helper package itself. */
  helperMinimumOs: string;
  architecture: "arm64" | "x64" | "wasm32";
  platform: NativeTargetPlatform;
  outputSuffixes: { asm: ".s" | ".asm"; obj: ".o" | ".obj"; exe: "" | ".exe" | ".wasm" };
  /** Arguments for the platform linker driver once scriptc has produced an
   * object. These are target ABI policy, rather than C compiler settings. */
  executableLinkerArgs: readonly string[];
  defaultLinker: string;
  defaultLinkerArgs: readonly string[];
  /** Driver spelling for the native-codegen triple. Linker drivers such as
   * zig use a different user-facing triple from LLVM's canonical spelling. */
  linkerTargetTriple: string;
  runtimeSystemLibraries: readonly string[];
  /** A source-level flag needed by the matching precompiled runtime units.
   * The helper's program object never needs this (it is already LLVM IR). */
  runtimeCompileDefines: readonly string[];
  supports: { asm: boolean; obj: boolean; exe: boolean; library: boolean };
  /** Primary host-native helper. The resolved helper can differ for WASI. */
  helperPackage: string;
  helper: NativeHelperSpec;
  llvmBackend: NativeHelperSpec["backend"];
  hostHelpers?: Partial<Record<NativeHelperHost, NativeHelperSpec>>;
  runtimePackPackage: string;
}

export type NativeHelperHost =
  | "darwin-arm64"
  | "darwin-x64"
  | "linux-x64-gnu"
  | "linux-x64-musl"
  | "linux-arm64-gnu"
  | "linux-arm64-musl"
  | "win32-x64";

export type LinuxLibc = "gnu" | "musl";

const ARM64_DARWIN_LAYOUT = "e-m:o-p270:32:32-p271:32:32-p272:64:64-i64:64-i128:128-n32:64-S128-Fn32";
const X64_DARWIN_LAYOUT = "e-m:o-p270:32:32-p271:32:32-p272:64:64-i64:64-i128:128-f80:128-n8:16:32:64-S128";
const X64_ELF_LAYOUT = "e-m:e-p270:32:32-p271:32:32-p272:64:64-i64:64-i128:128-f80:128-n8:16:32:64-S128";
const ARM64_ELF_LAYOUT = "e-m:e-p270:32:32-p271:32:32-p272:64:64-i8:8:32-i16:16:32-i64:64-i128:128-n32:64-S128-Fn32";
const X64_COFF_LAYOUT = "e-m:w-p270:32:32-p271:32:32-p272:64:64-i64:64-i128:128-f80:128-n8:16:32:64-S128";
const WASI_LAYOUT = "e-m:e-p:32:32-p10:8:8-p20:8:8-i64:64-i128:128-n32:64-S128-ni:1:10:20";

const DARWIN_ARM64_HELPER: NativeHelperSpec = {
  packageName: "@scriptc/llvm-darwin-arm64",
  defaultTarget: "arm64-apple-macosx14.0.0",
  defaultDataLayout: ARM64_DARWIN_LAYOUT,
  backend: "AArch64",
};
const DARWIN_X64_HELPER: NativeHelperSpec = {
  packageName: "@scriptc/llvm-darwin-x64",
  defaultTarget: "x86_64-apple-macosx14.0.0",
  defaultDataLayout: X64_DARWIN_LAYOUT,
  backend: "X86",
};
const LINUX_X64_HELPER: NativeHelperSpec = {
  packageName: "@scriptc/llvm-linux-x64-gnu",
  defaultTarget: "x86_64-unknown-linux-gnu",
  defaultDataLayout: X64_ELF_LAYOUT,
  backend: "X86",
};
const LINUX_ARM64_HELPER: NativeHelperSpec = {
  packageName: "@scriptc/llvm-linux-arm64-gnu",
  defaultTarget: "aarch64-unknown-linux-gnu",
  defaultDataLayout: ARM64_ELF_LAYOUT,
  backend: "AArch64",
};
const LINUX_X64_MUSL_HELPER: NativeHelperSpec = {
  packageName: "@scriptc/llvm-linux-x64-musl",
  defaultTarget: "x86_64-unknown-linux-musl",
  defaultDataLayout: X64_ELF_LAYOUT,
  backend: "X86",
};
const LINUX_ARM64_MUSL_HELPER: NativeHelperSpec = {
  packageName: "@scriptc/llvm-linux-arm64-musl",
  defaultTarget: "aarch64-unknown-linux-musl",
  defaultDataLayout: ARM64_ELF_LAYOUT,
  backend: "AArch64",
};
const WINDOWS_X64_HELPER: NativeHelperSpec = {
  packageName: "@scriptc/llvm-win32-x64-msvc",
  defaultTarget: "x86_64-pc-windows-msvc",
  defaultDataLayout: X64_COFF_LAYOUT,
  backend: "X86",
};

export const MACOS_ARM64_TARGET: NativeTargetSpec = {
  name: "macos-arm64", llvmTriple: "arm64-apple-macosx14.0.0", dataLayout: ARM64_DARWIN_LAYOUT,
  cpu: "generic", features: "", pointerBits: 64, endianness: "little", objectFormat: "macho",
  relocationModel: "pic", codeModel: "small", minimumOs: "14.0", helperMinimumOs: "15.0",
  architecture: "arm64", platform: "darwin", outputSuffixes: { asm: ".s", obj: ".o", exe: "" },
  executableLinkerArgs: ["-target", "arm64-apple-macosx14.0.0", "-pthread", "-Wl,-dead_strip"],
  defaultLinker: "clang", defaultLinkerArgs: [], runtimeSystemLibraries: ["System"],
  linkerTargetTriple: "arm64-apple-macosx14.0.0",
  runtimeCompileDefines: [],
  supports: { asm: true, obj: true, exe: true, library: false },
  helperPackage: DARWIN_ARM64_HELPER.packageName, helper: DARWIN_ARM64_HELPER,
  llvmBackend: "AArch64",
  runtimePackPackage: "@scriptc/runtime-darwin-arm64",
};

export const MACOS_X64_TARGET: NativeTargetSpec = {
  name: "macos-x64", llvmTriple: "x86_64-apple-macosx14.0.0", dataLayout: X64_DARWIN_LAYOUT,
  cpu: "generic", features: "", pointerBits: 64, endianness: "little", objectFormat: "macho",
  relocationModel: "pic", codeModel: "small", minimumOs: "14.0", helperMinimumOs: "15.0",
  architecture: "x64", platform: "darwin", outputSuffixes: { asm: ".s", obj: ".o", exe: "" },
  executableLinkerArgs: ["-target", "x86_64-apple-macosx14.0.0", "-pthread", "-Wl,-dead_strip"],
  defaultLinker: "clang", defaultLinkerArgs: [], runtimeSystemLibraries: ["System"],
  linkerTargetTriple: "x86_64-apple-macosx14.0.0",
  runtimeCompileDefines: [],
  supports: { asm: true, obj: true, exe: true, library: false },
  helperPackage: DARWIN_X64_HELPER.packageName, helper: DARWIN_X64_HELPER,
  llvmBackend: "X86",
  runtimePackPackage: "@scriptc/runtime-darwin-x64",
};

export const LINUX_X64_GNU_TARGET: NativeTargetSpec = {
  name: "linux-x64-gnu", llvmTriple: "x86_64-unknown-linux-gnu", dataLayout: X64_ELF_LAYOUT,
  cpu: "generic", features: "", pointerBits: 64, endianness: "little", objectFormat: "elf",
  relocationModel: "pic", codeModel: "small", minimumOs: "glibc 2.36", helperMinimumOs: "glibc 2.35",
  architecture: "x64", platform: "linux", outputSuffixes: { asm: ".s", obj: ".o", exe: "" },
  executableLinkerArgs: ["-target", "x86_64-unknown-linux-gnu", "-pthread", "-Wl,--gc-sections"],
  defaultLinker: "clang", defaultLinkerArgs: [], runtimeSystemLibraries: ["m"],
  linkerTargetTriple: "x86_64-unknown-linux-gnu",
  runtimeCompileDefines: ["_GNU_SOURCE"],
  supports: { asm: true, obj: true, exe: true, library: true },
  helperPackage: LINUX_X64_HELPER.packageName, helper: LINUX_X64_HELPER,
  llvmBackend: "X86",
  runtimePackPackage: "@scriptc/runtime-linux-x64-gnu",
};

export const LINUX_ARM64_GNU_TARGET: NativeTargetSpec = {
  name: "linux-arm64-gnu", llvmTriple: "aarch64-unknown-linux-gnu", dataLayout: ARM64_ELF_LAYOUT,
  cpu: "generic", features: "", pointerBits: 64, endianness: "little", objectFormat: "elf",
  relocationModel: "pic", codeModel: "small", minimumOs: "glibc 2.36", helperMinimumOs: "glibc 2.35",
  architecture: "arm64", platform: "linux", outputSuffixes: { asm: ".s", obj: ".o", exe: "" },
  executableLinkerArgs: ["-target", "aarch64-unknown-linux-gnu", "-pthread", "-Wl,--gc-sections"],
  defaultLinker: "clang", defaultLinkerArgs: [], runtimeSystemLibraries: ["m"],
  linkerTargetTriple: "aarch64-unknown-linux-gnu",
  runtimeCompileDefines: ["_GNU_SOURCE"],
  supports: { asm: true, obj: true, exe: true, library: true },
  helperPackage: LINUX_ARM64_HELPER.packageName, helper: LINUX_ARM64_HELPER,
  llvmBackend: "AArch64",
  runtimePackPackage: "@scriptc/runtime-linux-arm64-gnu",
};

export const WINDOWS_X64_MSVC_TARGET: NativeTargetSpec = {
  name: "windows-x64-msvc", llvmTriple: "x86_64-pc-windows-msvc", dataLayout: X64_COFF_LAYOUT,
  cpu: "generic", features: "", pointerBits: 64, endianness: "little", objectFormat: "coff",
  relocationModel: "pic", codeModel: "small", minimumOs: "Windows 10", helperMinimumOs: "Windows 10",
  architecture: "x64", platform: "win32", outputSuffixes: { asm: ".asm", obj: ".obj", exe: ".exe" },
  // The runtime pack is built against Zig's MinGW-compatible Windows sysroot;
  // its x64 COFF ABI is compatible with the helper's MSVC-flavored object.
  executableLinkerArgs: ["-target", "x86_64-windows-gnu", "-Wl,--gc-sections"],
  defaultLinker: "zig", defaultLinkerArgs: ["cc"], runtimeSystemLibraries: ["advapi32", "iphlpapi", "ws2_32"],
  linkerTargetTriple: "x86_64-windows-gnu",
  runtimeCompileDefines: [],
  supports: { asm: true, obj: true, exe: true, library: true },
  helperPackage: WINDOWS_X64_HELPER.packageName, helper: WINDOWS_X64_HELPER,
  llvmBackend: "X86",
  runtimePackPackage: "@scriptc/runtime-win32-x64-msvc",
};

export const LINUX_X64_MUSL_TARGET: NativeTargetSpec = {
  ...LINUX_X64_GNU_TARGET,
  name: "linux-x64-musl", llvmTriple: "x86_64-unknown-linux-musl",
  minimumOs: "musl 1.2", helperMinimumOs: "glibc 2.35",
  executableLinkerArgs: ["-target", "x86_64-unknown-linux-musl", "-pthread", "-Wl,--gc-sections"],
  defaultLinker: "zig", defaultLinkerArgs: ["cc"], linkerTargetTriple: "x86_64-linux-musl",
  runtimePackPackage: "@scriptc/runtime-linux-x64-musl",
  runtimeCompileDefines: ["_GNU_SOURCE", "SCR_MUSL"],
  helperPackage: LINUX_X64_MUSL_HELPER.packageName,
  helper: LINUX_X64_MUSL_HELPER,
};

export const LINUX_ARM64_MUSL_TARGET: NativeTargetSpec = {
  ...LINUX_ARM64_GNU_TARGET,
  name: "linux-arm64-musl", llvmTriple: "aarch64-unknown-linux-musl",
  minimumOs: "musl 1.2", helperMinimumOs: "glibc 2.35",
  executableLinkerArgs: ["-target", "aarch64-unknown-linux-musl", "-pthread", "-Wl,--gc-sections"],
  defaultLinker: "zig", defaultLinkerArgs: ["cc"], linkerTargetTriple: "aarch64-linux-musl",
  runtimePackPackage: "@scriptc/runtime-linux-arm64-musl",
  runtimeCompileDefines: ["_GNU_SOURCE", "SCR_MUSL"],
  helperPackage: LINUX_ARM64_MUSL_HELPER.packageName,
  helper: LINUX_ARM64_MUSL_HELPER,
};

export const WASM32_WASI_TARGET: NativeTargetSpec = {
  name: "wasm32-wasi", llvmTriple: "wasm32-unknown-wasi", dataLayout: WASI_LAYOUT,
  cpu: "generic", features: "", pointerBits: 32, endianness: "little", objectFormat: "wasm",
  relocationModel: "pic", codeModel: "small", minimumOs: "WASI Preview 1", helperMinimumOs: "host helper contract",
  architecture: "wasm32", platform: "wasi", outputSuffixes: { asm: ".s", obj: ".o", exe: ".wasm" },
  executableLinkerArgs: ["-target", "wasm32-wasi"], defaultLinker: "zig", defaultLinkerArgs: ["cc"],
  linkerTargetTriple: "wasm32-wasi",
  runtimeSystemLibraries: ["wasi-emulated-signal", "wasi-emulated-process-clocks"],
  runtimeCompileDefines: ["_GNU_SOURCE", "_WASI_EMULATED_SIGNAL", "_WASI_EMULATED_PROCESS_CLOCKS"],
  supports: { asm: true, obj: true, exe: true, library: false },
  helperPackage: DARWIN_ARM64_HELPER.packageName, helper: DARWIN_ARM64_HELPER,
  llvmBackend: "WebAssembly",
  hostHelpers: {
    "darwin-arm64": DARWIN_ARM64_HELPER,
    "darwin-x64": DARWIN_X64_HELPER,
    "linux-x64-gnu": LINUX_X64_HELPER,
    "linux-x64-musl": LINUX_X64_MUSL_HELPER,
    "linux-arm64-gnu": LINUX_ARM64_HELPER,
    "linux-arm64-musl": LINUX_ARM64_MUSL_HELPER,
    "win32-x64": WINDOWS_X64_HELPER,
  },
  runtimePackPackage: "@scriptc/runtime-wasm32-wasi",
};

export const NATIVE_TARGETS = [
  MACOS_ARM64_TARGET, MACOS_X64_TARGET, LINUX_X64_GNU_TARGET,
  LINUX_ARM64_GNU_TARGET, WINDOWS_X64_MSVC_TARGET, LINUX_X64_MUSL_TARGET,
  LINUX_ARM64_MUSL_TARGET, WASM32_WASI_TARGET,
] as const;

function detectedLinuxLibc(): LinuxLibc {
  // Node exposes glibc's runtime version without any external command or
  // filesystem probe. Its absence on Linux is the portable musl signal used
  // by npm's own optional-dependency selection conventions.
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: unknown } } | undefined;
  const header = report?.header;
  return typeof header?.glibcVersionRuntime === "string" ? "gnu" : "musl";
}

function helperHost(
  platform: NodeJS.Platform,
  arch: string,
  linuxLibc: LinuxLibc = detectedLinuxLibc(),
): NativeHelperHost | null {
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "darwin" && arch === "x64") return "darwin-x64";
  if (platform === "linux" && arch === "x64") return `linux-x64-${linuxLibc}`;
  if (platform === "linux" && arch === "arm64") return `linux-arm64-${linuxLibc}`;
  if (platform === "win32" && arch === "x64") return "win32-x64";
  return null;
}

export function nativeHelperForTarget(
  target: NativeTargetSpec,
  hostPlatform: NodeJS.Platform = process.platform,
  hostArch: string = process.arch,
  linuxLibc?: LinuxLibc,
): NativeHelperSpec | null {
  const host = helperHost(hostPlatform, hostArch, linuxLibc);
  if (host === null) return null;
  return target.hostHelpers?.[host] ?? (
    target.platform === hostPlatform && target.architecture === hostArch ? target.helper : null
  );
}

function nativeHostTarget(
  hostPlatform: NodeJS.Platform,
  hostArch: string,
  hostRelease: string,
  linuxLibc: LinuxLibc,
): NativeTargetSpec | null {
  if (hostPlatform === "darwin") {
    const major = Number.parseInt(hostRelease.split(".", 1)[0] ?? "", 10);
    if (!Number.isFinite(major) || major < 24) return null;
    return hostArch === "arm64" ? MACOS_ARM64_TARGET : hostArch === "x64" ? MACOS_X64_TARGET : null;
  }
  if (hostPlatform === "linux") {
    return hostArch === "x64"
      ? linuxLibc === "musl" ? LINUX_X64_MUSL_TARGET : LINUX_X64_GNU_TARGET
      : hostArch === "arm64"
        ? linuxLibc === "musl" ? LINUX_ARM64_MUSL_TARGET : LINUX_ARM64_GNU_TARGET
        : null;
  }
  return hostPlatform === "win32" && hostArch === "x64" ? WINDOWS_X64_MSVC_TARGET : null;
}

function requestedTarget(
  raw: string,
  host: NativeTargetSpec | null,
  hostPlatform: NodeJS.Platform,
  hostArch: string,
  linuxLibc: LinuxLibc,
): NativeTargetSpec | null {
  if (raw === "") return host;
  switch (raw) {
    case "arm64-apple-macosx14.0.0": return host?.name === "macos-arm64" ? MACOS_ARM64_TARGET : null;
    case "x86_64-apple-macosx14.0.0":
    case "x86_64-apple-macos": return host?.name === "macos-x64" ? MACOS_X64_TARGET : null;
    case "x86_64-unknown-linux-gnu":
    case "x86_64-linux-gnu":
    case "x86_64-linux-gnu.2.36": return host?.name === "linux-x64-gnu" ? LINUX_X64_GNU_TARGET : null;
    case "aarch64-unknown-linux-gnu":
    case "aarch64-linux-gnu":
    case "aarch64-linux-gnu.2.36": return host?.name === "linux-arm64-gnu" ? LINUX_ARM64_GNU_TARGET : null;
    case "x86_64-unknown-linux-musl":
    case "x86_64-linux-musl":
      return host?.platform === "linux" && host.architecture === "x64" ? LINUX_X64_MUSL_TARGET : null;
    case "aarch64-unknown-linux-musl":
    case "aarch64-linux-musl":
      return host?.platform === "linux" && host.architecture === "arm64" ? LINUX_ARM64_MUSL_TARGET : null;
    case "wasm32-wasi":
    case "wasm32-unknown-wasi":
      return helperHost(hostPlatform, hostArch, linuxLibc) === null ? null : WASM32_WASI_TARGET;
    case "x86_64-pc-windows-msvc": return host?.name === "windows-x64-msvc" ? WINDOWS_X64_MSVC_TARGET : null;
    default: return null;
  }
}

/** Select only a fully described scriptc target. LLVM accepting an arbitrary
 * triple is never evidence of its object ABI, runtime pack, link, or run. */
export function nativeCodegenTarget(
  env: NodeJS.ProcessEnv = process.env,
  hostPlatform: NodeJS.Platform = process.platform,
  hostArch: string = process.arch,
  hostRelease: string = release(),
  linuxLibc: LinuxLibc = detectedLinuxLibc(),
): NativeTargetSpec | null {
  const host = nativeHostTarget(hostPlatform, hostArch, hostRelease, linuxLibc);
  const target = requestedTarget(env["SCRIPTC_TARGET"] ?? "", host, hostPlatform, hostArch, linuxLibc);
  return target !== null && nativeHelperForTarget(target, hostPlatform, hostArch, linuxLibc) !== null ? target : null;
}

export function nativeCodegenTargetRefusal(
  env: NodeJS.ProcessEnv = process.env,
  hostPlatform: NodeJS.Platform = process.platform,
  hostArch: string = process.arch,
  hostRelease: string = release(),
  linuxLibc: LinuxLibc = detectedLinuxLibc(),
): string | null {
  if (nativeCodegenTarget(env, hostPlatform, hostArch, hostRelease, linuxLibc) !== null) return null;
  const requested = env["SCRIPTC_TARGET"] ?? "";
  if (requested !== "") {
    return `native assembly/object emission does not support SCRIPTC_TARGET=${requested} on this ${hostPlatform} ${hostArch} host; supported hosts are macOS arm64/x64, Linux x64/arm64, and Windows x64 (with wasm32-wasi on each)`;
  }
  if (hostPlatform === "darwin" && (hostArch === "arm64" || hostArch === "x64")) {
    const major = Number.parseInt(hostRelease.split(".", 1)[0] ?? "", 10);
    const macos = Number.isFinite(major) && major >= 20 ? String(major - 9) : "unknown";
    return `native assembly/object emission requires macOS 15.0 or newer; this host is macOS ${macos} (Darwin ${hostRelease})`;
  }
  return `native assembly/object emission is supported on macOS arm64/x64, Linux x64/arm64, and Windows x64 hosts; this host is ${hostPlatform} ${hostArch}`;
}
