/**
 * The explicitly external C toolchain path.
 *
 * This module is deliberately narrow at the executable boundary: normal
 * macOS arm64 LLVM builds emit a program object through the bundled helper
 * and hand it to `linker.ts`.  Generated C, `--from-c`, sanitizer builds,
 * cross targets, and the temporary LLVM fallback continue to use this path.
 * Keeping that distinction here prevents a platform linker driver from
 * accidentally becoming the abstraction that compiles scriptc programs.
 */
import {
  compileC,
  compileLibArchive,
  prepareBuildCacheRoot,
  resolveBuildCacheRoot,
  targetPlatform,
  type CcOptions,
  type LibArchiveOptions,
} from "./native-toolchain.js";

export {
  CcCompileError,
  compileC,
  compileLibArchive,
  compilerDriverSupportsPersistentCache,
  executableNativeEnvironmentFingerprint,
  isAndroidTarget,
  isIosTarget,
  isMobileTarget,
  mobileLibraryTarget,
  mobileTargetRefusal,
  prepareBuildCacheRoot,
  resolveCc,
  resolveBuildCacheRoot,
  runtimeSrcDir,
  subprocessFailureDetail,
  toolchainEnvironmentCachePolicy,
  toolchainEnvironmentFingerprint,
  targetPlatform,
  type CcDriver,
  type CcOptions,
  type LibArchiveOptions,
  type NativeCacheWarmProfile,
  type WarmNativeCachesOptions,
  type WarmNativeCachesResult,
  warmNativeCaches,
} from "./native-toolchain.js";

export {
  ANDROID_MIN_API,
  IPHONEOS_MIN_VERSION,
} from "./native-toolchain.js";

/** Compile a caller-provided C or LLVM source file through an external C
 * toolchain.  The CLI uses this only for its explicit `--from-c` escape
 * hatch; generated program C uses the same implementation only on the
 * documented legacy/fallback routes. */
export async function compileExternalC(options: CcOptions): Promise<void> {
  await compileC(options);
}

/** Build a library archive through the external C toolchain. Library packs
 * are intentionally out of scope for the first executable-linking split. */
export async function compileExternalCLibrary(options: LibArchiveOptions): Promise<void> {
  await compileLibArchive(options);
}

/** Internal migration guard used by CI to ensure an LLVM-tier executable did
 * not regress from helper-object linking to compiling its generated .ll.
 * Explicit `--backend=c` and `--from-c` remain deliberate developer paths. */
export function legacyCExecutablePipelineEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env["SCRIPTC_LEGACY_C_PIPELINE"] !== "0";
}

/** `SCRIPTC_CC` selects the external C compiler route during the migration.
 * An unset value lets an LLVM-tier macOS build use the helper plus runtime
 * pack and reserve `SCRIPTC_LINKER` for the platform-linker driver. */
export function legacyCExecutablePathRequested(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const configured = env["SCRIPTC_CC"];
  return configured !== undefined && configured !== "";
}

export class LegacyCExecutablePipelineDisabledError extends Error {
  constructor() {
    super(
      "the legacy generated-C executable pipeline is disabled (SCRIPTC_LEGACY_C_PIPELINE=0); " +
      "use the supported LLVM helper/runtime-pack route or remove the internal comparison switch",
    );
    this.name = "LegacyCExecutablePipelineDisabledError";
  }
}

export function assertLegacyCExecutablePipelineEnabled(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!legacyCExecutablePipelineEnabled(env)) {
    throw new LegacyCExecutablePipelineDisabledError();
  }
}
