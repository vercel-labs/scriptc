/** A valid IR construct missing LLVM lowering. Compilation stops with SC3001. */
import type { SrcLoc } from "../../ir/ir.js";

export class LlvmUnsupportedError extends Error {
  /** The source span of the IR node whose emission raised the refusal. A
   * site that knows its node passes it; any other takes the span of the
   * statement, function or global under emission (anchorRefusal). */
  loc: SrcLoc | undefined;
  /** The IR function under emission, once the refusal has left it. */
  functionName: string | undefined;

  /** `kind` is the machine-readable tag (construct and type kind) and
   * `detail` says what it applies to, such as the full type. */
  constructor(
    readonly kind: string,
    loc?: SrcLoc,
    readonly detail?: string,
    /** What the program can write instead, when the backend knows. */
    readonly hint?: string,
    /** Further sites refused for their own `kind`, each reported beside this one. */
    readonly also: readonly LlvmUnsupportedError[] = [],
  ) {
    super(`the LLVM backend does not support this construct yet (${kind})`);
    this.name = "LlvmUnsupportedError";
    this.loc = loc;
    this.functionName = undefined;
  }

  /** The diagnostic's text: the tagged message, then the detail and the
   * function the refusal was raised in. */
  describe(): string {
    const about: string[] = [];
    if (this.detail !== undefined) about.push(this.detail);
    if (this.functionName !== undefined) about.push(`in ${this.functionName}`);
    return about.length === 0 ? this.message : `${this.message}: ${about.join(", ")}`;
  }
}

/** Gives a refusal that left the emission of an IR node without a source
 * span that node's span, and names the function once it is known. Other
 * errors pass through. Returns the error to rethrow. */
export function anchorRefusal(
  error: unknown,
  loc: SrcLoc | undefined,
  functionName?: string,
): unknown {
  if (!(error instanceof LlvmUnsupportedError)) return error;
  if (error.loc === undefined && loc !== undefined) error.loc = loc;
  if (error.functionName === undefined && functionName !== undefined)
    error.functionName = functionName;
  return error;
}
