/* The LLVM backend's refusal: an IR construct outside the current tier.
 * `kind` is a stable machine-readable tag ("stmt:switch", "expr:closure",
 * "type:union", ...) — the differential harness histograms the next
 * phase's queue from it. Never catch-and-continue: any refusal aborts the
 * whole module. compile()'s DEFAULT lane catches exactly this error and
 * re-emits through the C backend (the transparent fallback); an explicit
 * backend "llvm" surfaces it as diagnostic SC3001 instead — the
 * fail-loudly pin. Its own module so the emitter and the shape/RC tables
 * can both throw it without an import cycle. */
import type { SrcLoc } from "../../ir/ir.js";

export class LlvmUnsupportedError extends Error {
  constructor(
    readonly kind: string,
    readonly loc?: SrcLoc,
  ) {
    super(
      `the LLVM backend does not support this construct yet (${kind}); ` +
        `build with the debugging C backend (--backend c, or the native default's transparent fallback)`,
    );
    this.name = "LlvmUnsupportedError";
  }
}
