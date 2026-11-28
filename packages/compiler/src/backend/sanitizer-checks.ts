/** The checks the sanitized lane builds with: AddressSanitizer for memory
 * errors, plus UBSan's function-type check. The function check traps a call
 * through a function pointer whose type is not the callee's: the runtime
 * stores every listener and thunk in a `ScrClosure`'s untyped `fn`, and the
 * caller's pointer type must name the function the same way the function
 * names itself. A mismatch is undefined on native targets and traps on
 * wasm32, where an indirect call checks the signature.
 *
 * The vendored archives (zlib, mbedtls, brotli, zstd, ICU) keep
 * AddressSanitizer alone: their call sites are their own code, and no
 * function pointer the runtime stores is called from inside them. */
export const SANITIZER_CHECKS = "address,function";

/** `-fsanitize=` with {@link SANITIZER_CHECKS}: the flag for compiling,
 * and for the link, which brings the sanitizers' runtimes. */
export const SANITIZER_FLAG = `-fsanitize=${SANITIZER_CHECKS}`;
