/* The loop optimizations' per-function state: counted loops, dense array
 * loops, byte windows and typed-array loop versioning, and the unaliased
 * local arrays they rely on. */
import { findUnaliasedLocalArrays } from "../../ir/array-length-stability.js";
import type { IrFunction, IrStmt } from "../../ir/ir.js";
import { findInitializedByteLoopBindings } from "./byte-windows.js";
import type { DenseArrayLoop } from "./dense-array-loops.js";
import type { LlEmitter } from "./emitter.js";
import { defineModuleState } from "./emitter-state.js";

/** Sets the loop state for `fn` at the start of its emission; `numericFn`
 * is `fn` with its initializer bindings (emitFunction). */
export function beginFunctionLoops(
  emitter: LlEmitter,
  fn: IrFunction,
  numericFn: IrFunction,
): void {
  const loops = LOOPS.of(emitter);
  loops.unaliasedArrays = findUnaliasedLocalArrays(fn);
  loops.countedLoopsEnabled = emitter.debug === null && !fn.async && !fn.generator;
  loops.byteWindowsEnabled = loops.countedLoopsEnabled;
  loops.bytesLoopVersionsEnabled = loops.countedLoopsEnabled;
  loops.bytesLoopEntries = null;
  loops.bytesLoopFunction = fn;
  loops.denseLoopsEnabled = loops.countedLoopsEnabled;
  loops.denseLoop = null;
  loops.denseLoopEntries =
    loops.denseLoopsEnabled && numericFn.locals.some((l) => l.type.kind === "array")
      ? findInitializedByteLoopBindings(fn)
      : new Map();
  loops.byteWindowEntries =
    loops.byteWindowsEnabled && numericFn.locals.some((l) => l.type.kind === "bytes")
      ? findInitializedByteLoopBindings(fn)
      : new Map();
}

/** The state LOOPS holds on each emitter. */
export interface LoopState {
  /** Local arrays of the current function that no other binding can hold
   * (ir/array-length-stability.ts). */
  unaliasedArrays: ReadonlySet<string>;
  /** Dense array loops (dense-array-loops.ts) run in this function. */
  denseLoopsEnabled: boolean;
  denseLoopEntries: ReturnType<typeof findInitializedByteLoopBindings>;
  /** The fast copy of a dense array loop being emitted. */
  denseLoop: DenseArrayLoop | null;
  countedLoopsEnabled: boolean;
  byteWindowsEnabled: boolean;
  byteWindowEntries: ReturnType<typeof findInitializedByteLoopBindings>;
  /** Typed-array loop versioning (bytes-loop-versions.ts) for the current
   * function: off in debug and suspending functions and inside a copy. */
  bytesLoopVersionsEnabled: boolean;
  /** Loops being versioned around the statement being emitted: a loop is
   * never versioned inside its own copies, and versions nest boundedly. */
  readonly bytesLoopVersioning: Set<IrStmt>;
  bytesLoopEntries: ReturnType<typeof findInitializedByteLoopBindings> | null;
  bytesLoopFunction: IrFunction | null;
  /** Counted loops whose integer-form safety test an enclosing version
   * guard already passed. */
  readonly provenCountedGuards: Set<IrStmt>;
}

export const LOOPS = defineModuleState<LoopState>(() => ({
  unaliasedArrays: new Set(),
  denseLoopsEnabled: false,
  denseLoopEntries: new Map(),
  denseLoop: null,
  countedLoopsEnabled: false,
  byteWindowsEnabled: true,
  byteWindowEntries: new Map(),
  bytesLoopVersionsEnabled: false,
  bytesLoopVersioning: new Set<IrStmt>(),
  bytesLoopEntries: null,
  bytesLoopFunction: null,
  provenCountedGuards: new Set<IrStmt>(),
}));
