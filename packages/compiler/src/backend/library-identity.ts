export type LibraryEmission = "c" | "llvm";

export const C_LIBRARY_IDENTITY_BEGIN = "/* scriptc-library-identity: begin */";
export const C_LIBRARY_IDENTITY_END = "/* scriptc-library-identity: end */";
export const LLVM_LIBRARY_IDENTITY_BEGIN = "; scriptc-library-identity: begin";
export const LLVM_LIBRARY_IDENTITY_END = "; scriptc-library-identity: end";

/** Remove the generated identity region from a complete caller-visible
 * library TU. Archive assembly compiles this stable projection beside the
 * small volatile identity C object, while the public TU remains complete. */
export function stripLibraryIdentity(
  source: string,
  emission: LibraryEmission,
): string {
  const begin = emission === "c"
    ? C_LIBRARY_IDENTITY_BEGIN
    : LLVM_LIBRARY_IDENTITY_BEGIN;
  const end = emission === "c"
    ? C_LIBRARY_IDENTITY_END
    : LLVM_LIBRARY_IDENTITY_END;
  const start = source.indexOf(`${begin}\n`);
  if (start < 0) return source;
  if (source.indexOf(begin, start + begin.length) >= 0) {
    throw new Error("generated library TU contains multiple identity regions");
  }
  const endStart = source.indexOf(end, start + begin.length);
  if (endStart < 0) throw new Error("generated library TU has an unterminated identity region");
  const endOffset = endStart + end.length;
  const suffix = source[endOffset] === "\n" ? endOffset + 1 : endOffset;
  let prefix = source.slice(0, start);
  // An omitted final region leaves the emitter's preceding empty array entry
  // as one trailing newline; a marked final region has material after that
  // entry and therefore renders it as two. Restore the omitted form exactly.
  if (suffix === source.length && prefix.endsWith("\n\n")) {
    prefix = prefix.slice(0, -1);
  }
  return prefix + source.slice(suffix);
}
