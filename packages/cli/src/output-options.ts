import type { CompileOutputKind, ExecutableSubsystem } from "@scriptc/compiler";
import type { CliOutputKind } from "./paths.js";

export interface OutputOptionValues {
  emit?: string;
  subsystem?: string;
  emitIr: boolean;
  backend?: string;
  fromC: boolean;
  keepC: boolean;
  sanitize: boolean;
  optimization?: string;
  ffi?: string;
}

export type OutputOptionResolution =
  | {
      ok: true;
      outputKind: CompileOutputKind;
      cliOutputKind: CliOutputKind;
      backend?: "c" | "llvm";
      executableSubsystem?: ExecutableSubsystem;
      emitIr: boolean;
      deprecateEmitIr: boolean;
    }
  | { ok: false; message: string };

const SOURCE_KINDS = new Set<CliOutputKind>(["ir", "c", "llvm"]);
const NATIVE_ARTIFACT_KINDS = new Set<CliOutputKind>(["asm", "obj"]);

/** Pure compatibility/validation matrix for build/run output selection. */
export function resolveOutputOptions(
  command: "build" | "run",
  values: OutputOptionValues,
): OutputOptionResolution {
  if (values.backend !== undefined && values.backend !== "c" && values.backend !== "llvm") {
    return { ok: false, message: `unknown backend "${values.backend}" (supported: c, llvm)` };
  }
  const backend = values.backend as "c" | "llvm" | undefined;
  const rawEmit = values.emit;
  if (
    rawEmit !== undefined && rawEmit !== "ir" && rawEmit !== "c" && rawEmit !== "llvm" &&
    rawEmit !== "asm" && rawEmit !== "obj" && rawEmit !== "exe"
  ) {
    return {
      ok: false,
      message: `unknown emit kind "${rawEmit}" (supported: ir, c, llvm, asm, obj, exe)`,
    };
  }
  const emit = (rawEmit ?? "exe") as CliOutputKind;
  if (values.subsystem !== undefined && values.subsystem !== "console" && values.subsystem !== "windows") {
    return {
      ok: false,
      message: `unknown subsystem "${values.subsystem}" (supported: console, windows)`,
    };
  }
  if (values.subsystem !== undefined && emit !== "exe") {
    return {
      ok: false,
      message: "--subsystem is supported only for executable output (--emit=exe)",
    };
  }
  if (command === "run" && emit !== "exe") {
    return { ok: false, message: `scriptc run requires --emit=exe` };
  }
  if (values.emitIr && rawEmit !== undefined && emit !== "ir" && emit !== "exe") {
    return { ok: false, message: `--emit-ir cannot be combined with --emit=${emit}; use --emit=ir` };
  }
  if (values.emitIr && emit === "ir") {
    return { ok: false, message: `--emit-ir and --emit=ir select the same output; use --emit=ir` };
  }
  if (values.fromC && emit !== "exe") {
    return { ok: false, message: `--from-c only supports --emit=exe` };
  }
  if (emit === "ir" && backend !== undefined) {
    return { ok: false, message: `--emit=ir cannot be combined with --backend; IR is emitted before backend selection` };
  }
  if (emit === "c" && backend === "llvm") {
    return { ok: false, message: `--emit=c cannot be combined with --backend=llvm` };
  }
  if ((emit === "llvm" || NATIVE_ARTIFACT_KINDS.has(emit)) && backend === "c") {
    return { ok: false, message: `--emit=${emit} cannot be combined with --backend=c` };
  }
  if (SOURCE_KINDS.has(emit)) {
    if (!values.keepC) {
      return { ok: false, message: `--no-keep-c is only meaningful with --emit=exe` };
    }
    if (values.sanitize) {
      return { ok: false, message: `--sanitize is only meaningful with --emit=exe` };
    }
    if (values.optimization !== undefined) {
      return { ok: false, message: `--optimization is only meaningful with --emit=exe` };
    }
  }
  if (NATIVE_ARTIFACT_KINDS.has(emit) && !values.keepC) {
    return { ok: false, message: `--no-keep-c is only meaningful with --emit=exe` };
  }
  const outputKind = emit as CompileOutputKind;
  return {
    ok: true,
    outputKind,
    cliOutputKind: emit,
    ...(emit === "c"
      ? { backend: "c" as const }
      : emit === "llvm" || NATIVE_ARTIFACT_KINDS.has(emit)
        ? { backend: "llvm" as const }
        : backend === undefined ? {} : { backend }),
    ...(values.subsystem === "windows"
      ? { executableSubsystem: "windows" as const }
      : values.subsystem === "console"
        ? { executableSubsystem: "console" as const }
        : {}),
    emitIr: values.emitIr && emit === "exe",
    deprecateEmitIr: values.emitIr,
  };
}
