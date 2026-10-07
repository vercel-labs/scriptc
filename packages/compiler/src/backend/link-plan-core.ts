/** Ordered link inputs shared by synchronous native and asynchronous Node hosts. */
import {
  executableOptimizationLinkerArgs,
  executableStripLinkerArgs,
  windowsSubsystemLinkerArgs,
  type NativeTargetSpec,
  type WindowsSubsystem,
} from "./targets.js";

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
  optimization: "release" | "dev";
  strip?: boolean;
  windowsSubsystem?: WindowsSubsystem;
}): ExecutableLinkInputs {
  if (options.ffiFrameworks.length !== 0 && options.target.platform !== "darwin")
    throw new Error("FFI frameworks require a Darwin target");
  return {
    inputs: [
      options.programObject,
      ...(options.programPartitions ?? []),
      ...options.ffiLibraries,
      ...options.runtimeObjects,
      ...options.runtimeArchives,
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
      ...windowsSubsystemLinkerArgs(options.target.platform, options.windowsSubsystem),
    ],
  };
}
