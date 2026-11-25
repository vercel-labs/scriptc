/** The message a compiler-internal failure reports when it was created
 * without one: a diagnostic for a compiler bug must never carry its code
 * alone. */
export const INTERNAL_COMPILER_ERROR_FALLBACK = "a compiler invariant failed without a message";

/** A compiler invariant failed. Callers can distinguish these bugs from
 * environmental failures such as filesystem and toolchain errors. */
export class InternalCompilerError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(
      message === undefined || message.trim() === "" ? INTERNAL_COMPILER_ERROR_FALLBACK : message,
      options,
    );
    this.name = "InternalCompilerError";
  }
}
