import type { CompileOutputKind } from "../compile-types.js";
import type { CliOutputKind } from "./paths.js";

export interface OutputOptionValues {
  emit?: string;
  emitIr: boolean;
  backend?: string;
  keepLlvm: boolean;
  sanitize: boolean;
  optimization?: string;
  strip?: boolean;
  staticLink?: boolean;
  windowsSubsystem?: string;
  detachedExit?: boolean;
  largePages?: boolean;
  cpuDispatch?: boolean;
  profileGenerate?: string;
  profileUse?: string;
  ffi?: string;
}

export type OutputOptionResolution =
  | {
      ok: true;
      outputKind: CompileOutputKind;
      cliOutputKind: CliOutputKind;
      backend?: "llvm";
      emitIr: boolean;
      deprecateEmitIr: boolean;
    }
  | { ok: false; message: string };

const SOURCE_KINDS = new Set<CliOutputKind>(["ir", "llvm"]);
const NATIVE_ARTIFACT_KINDS = new Set<CliOutputKind>(["asm", "obj"]);

/** Pure compatibility/validation matrix for build/run output selection. */
export function resolveOutputOptions(
  command: "build" | "run",
  values: OutputOptionValues,
): OutputOptionResolution {
  if (values.backend !== undefined && values.backend !== "llvm") {
    return { ok: false, message: `unknown backend "${values.backend}" (supported: llvm)` };
  }
  const backend = values.backend as "llvm" | undefined;
  const rawEmit = values.emit;
  if (
    rawEmit !== undefined &&
    rawEmit !== "ir" &&
    rawEmit !== "llvm" &&
    rawEmit !== "asm" &&
    rawEmit !== "obj" &&
    rawEmit !== "exe"
  ) {
    return {
      ok: false,
      message: `unknown emit kind "${rawEmit}" (supported: ir, llvm, asm, obj, exe)`,
    };
  }
  const emit = (rawEmit ?? "exe") as CliOutputKind;
  if (command === "run" && emit !== "exe") {
    return { ok: false, message: `scriptc run requires --emit=exe` };
  }
  if (values.emitIr && rawEmit !== undefined && emit !== "ir" && emit !== "exe") {
    return {
      ok: false,
      message: `--emit-ir cannot be combined with --emit=${emit}; use --emit=ir`,
    };
  }
  if (values.emitIr && emit === "ir") {
    return { ok: false, message: `--emit-ir and --emit=ir select the same output; use --emit=ir` };
  }
  if (values.windowsSubsystem !== undefined && emit !== "exe") {
    return { ok: false, message: `--windows-subsystem is only supported with --emit=exe` };
  }
  if (values.strip && emit !== "exe") {
    return { ok: false, message: `--strip is only supported with --emit=exe` };
  }
  if (values.staticLink && emit !== "exe") {
    return { ok: false, message: `--static is only supported with --emit=exe` };
  }
  if (values.detachedExit && emit !== "exe") {
    return { ok: false, message: `--detached-exit is only supported with --emit=exe` };
  }
  if (values.largePages && emit !== "exe") {
    return { ok: false, message: `--large-pages is only supported with --emit=exe` };
  }
  if (values.cpuDispatch && emit !== "exe") {
    return { ok: false, message: `--cpu-dispatch is only supported with --emit=exe` };
  }
  if (values.profileGenerate !== undefined && emit !== "exe") {
    return { ok: false, message: `--profile-generate is only supported with --emit=exe` };
  }
  if (values.profileUse !== undefined && emit !== "exe") {
    return { ok: false, message: `--profile-use is only supported with --emit=exe` };
  }
  if (emit === "ir" && backend !== undefined) {
    return {
      ok: false,
      message: `--emit=ir cannot be combined with --backend; IR is emitted before backend selection`,
    };
  }
  if (SOURCE_KINDS.has(emit)) {
    if (!values.keepLlvm) {
      return { ok: false, message: `--no-keep-llvm is only meaningful with --emit=exe` };
    }
    if (values.sanitize) {
      return { ok: false, message: `--sanitize is only meaningful with --emit=exe` };
    }
    if (values.optimization !== undefined) {
      return { ok: false, message: `--optimization is only meaningful with --emit=exe` };
    }
  }
  if (NATIVE_ARTIFACT_KINDS.has(emit) && !values.keepLlvm) {
    return { ok: false, message: `--no-keep-llvm is only meaningful with --emit=exe` };
  }
  const outputKind = emit as CompileOutputKind;
  return {
    ok: true,
    outputKind,
    cliOutputKind: emit,
    ...(emit === "ir" && backend === undefined ? {} : { backend: "llvm" as const }),
    emitIr: values.emitIr && emit === "exe",
    deprecateEmitIr: values.emitIr,
  };
}
