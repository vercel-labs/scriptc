export interface NativeTargetSpec {
  /** Stable scriptc-facing identity used in cache keys and diagnostics. */
  name: "macos-arm64";
  llvmTriple: "arm64-apple-macosx14.0.0";
  dataLayout: "e-m:o-p270:32:32-p271:32:32-p272:64:64-i64:64-i128:128-n32:64-S128-Fn32";
  cpu: "generic";
  features: "";
  pointerBits: 64;
  endianness: "little";
  objectFormat: "macho";
  relocationModel: "pic";
  codeModel: "small";
  minimumOs: "14.0";
  outputSuffixes: { asm: ".s"; obj: ".o"; exe: "" };
  supports: { asm: true; obj: true; exe: true; library: false };
  helperPackage: "@scriptc/llvm-darwin-arm64";
}

export const MACOS_ARM64_TARGET: NativeTargetSpec = {
  name: "macos-arm64",
  llvmTriple: "arm64-apple-macosx14.0.0",
  dataLayout: "e-m:o-p270:32:32-p271:32:32-p272:64:64-i64:64-i128:128-n32:64-S128-Fn32",
  cpu: "generic",
  features: "",
  pointerBits: 64,
  endianness: "little",
  objectFormat: "macho",
  relocationModel: "pic",
  codeModel: "small",
  minimumOs: "14.0",
  outputSuffixes: { asm: ".s", obj: ".o", exe: "" },
  supports: { asm: true, obj: true, exe: true, library: false },
  helperPackage: "@scriptc/llvm-darwin-arm64",
};

export function nativeCodegenTarget(
  env: NodeJS.ProcessEnv = process.env,
  hostPlatform: NodeJS.Platform = process.platform,
  hostArch: string = process.arch,
): NativeTargetSpec | null {
  // The first helper is host-native only. In particular, do not reinterpret
  // an existing SCRIPTC_TARGET cross-build as macOS merely because its OS
  // family is Darwin.
  if ((env["SCRIPTC_TARGET"] ?? "") !== "") return null;
  return hostPlatform === "darwin" && hostArch === "arm64"
    ? MACOS_ARM64_TARGET
    : null;
}

export function nativeCodegenTargetRefusal(
  env: NodeJS.ProcessEnv = process.env,
  hostPlatform: NodeJS.Platform = process.platform,
  hostArch: string = process.arch,
): string | null {
  if (nativeCodegenTarget(env, hostPlatform, hostArch) !== null) return null;
  const crossTarget = env["SCRIPTC_TARGET"] ?? "";
  if (crossTarget !== "") {
    return `native assembly/object emission does not support SCRIPTC_TARGET=${crossTarget}; the first supported target is host-native macOS arm64`;
  }
  return `native assembly/object emission is supported on macOS arm64 hosts; this host is ${hostPlatform} ${hostArch}`;
}
