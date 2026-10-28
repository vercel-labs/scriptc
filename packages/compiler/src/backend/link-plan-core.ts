/** Ordered link inputs shared by synchronous native and asynchronous Node hosts. */
import type { NativeOptimization } from "./optimization.js";
import {
  executableOptimizationLinkerArgs,
  executableStaticLinkerArgs,
  executableStripLinkerArgs,
  windowsSubsystemLinkerArgs,
  type NativeTargetSpec,
  type WindowsSubsystem,
} from "./targets.js";
import { profileGenerateLinkerArgs, profileLayoutLinkerArgs } from "./native-profile.js";

export interface ExecutableLinkInputs {
  inputs: string[];
  systemLibraries: string[];
  driverFlags: string[];
}

export function executableLinkInputs(options: {
  target: NativeTargetSpec;
  programObject: string;
  /** Further objects of the same partitioned program. */
  programPartitions?: readonly string[];
  ffiLibraries: readonly string[];
  ffiSystemLibraries: readonly string[];
  ffiFrameworks: readonly string[];
  runtimeObjects: readonly string[];
  runtimeArchives: readonly string[];
  runtimeSystemLibraries: readonly string[];
  optimization: NativeOptimization;
  strip?: boolean;
  /** Link the C library and the other system libraries statically (`--static`). */
  staticLink?: boolean;
  windowsSubsystem?: WindowsSubsystem;
  /** Instrumented for profile-guided optimization. */
  profileGenerate?: boolean;
  /** Laid out by a profile's context-sensitive counts (nativeProfileLayout). */
  profileLayout?: boolean;
}): ExecutableLinkInputs {
  if (options.ffiFrameworks.length !== 0 && options.target.platform !== "darwin")
    throw new Error("FFI frameworks require a Darwin target");
  return {
    // Linkers lay out code in input order. The precompiled runtime and its
    // archives go first so their addresses do not depend on the size of the
    // program object: otherwise any program edit shifts every runtime
    // function, and hot interpreter loops (the regex engine's especially)
    // swing by double-digit percentages with incidental cache-line
    // placement. Program code never references archive members directly,
    // so single-pass archive resolution (GNU ld) still sees every runtime
    // reference first. FFI libraries stay after the program that uses them;
    // single-pass linkers get the archives once more after them in case a
    // foreign library depends on a vendored one.
    inputs: [
      ...options.runtimeObjects,
      ...options.runtimeArchives,
      options.programObject,
      ...(options.programPartitions ?? []),
      ...options.ffiLibraries,
      ...(options.ffiLibraries.length !== 0 && options.target.platform !== "darwin"
        ? options.runtimeArchives
        : []),
    ],
    systemLibraries: [
      ...new Set([...options.ffiSystemLibraries, ...options.runtimeSystemLibraries]),
    ],
    driverFlags: [
      ...options.ffiFrameworks.flatMap((name) => ["-framework", name]),
      ...options.target.executableLinkerArgs.map((arg, index, args) =>
        index > 0 && args[index - 1] === "-target" ? options.target.linkerTargetTriple : arg,
      ),
      ...executableOptimizationLinkerArgs(options.target.platform, options.optimization),
      ...executableStripLinkerArgs(options.target.platform, options.strip ?? false),
      ...executableStaticLinkerArgs(options.target, options.staticLink ?? false),
      ...windowsSubsystemLinkerArgs(options.target.platform, options.windowsSubsystem),
      ...profileGenerateLinkerArgs(options.profileGenerate ?? false),
      ...profileLayoutLinkerArgs(options.target, options.profileLayout ?? false),
    ],
  };
}

/** The linker arguments for an executable's system libraries. On Linux, libm
 * links as needed: the runtime defines the libm functions most programs
 * reach (scr_glibc_math.c) and Math's transcendentals (scr_ieee754.c), so a
 * program that calls no other libm function, such as pow, starts without
 * loading libm.so when it links with lld (see inputsWithoutLld). */
export function systemLibraryLinkerArgs(
  target: Pick<NativeTargetSpec, "platform">,
  names: readonly string[],
): string[] {
  return names.flatMap((name) =>
    name === "m" && target.platform === "linux"
      ? ["-Wl,--as-needed", "-lm", "-Wl,--no-as-needed"]
      : [`-l${name}`],
  );
}
