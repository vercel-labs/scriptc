export type LibraryEmission = "c" | "llvm";

const C_LIBRARY_IDENTITY_BEGIN = "/* scriptc-library-identity: begin */";
const C_LIBRARY_IDENTITY_END = "/* scriptc-library-identity: end */";
const LLVM_LIBRARY_IDENTITY_BEGIN = "; scriptc-library-identity: begin";
const LLVM_LIBRARY_IDENTITY_END = "; scriptc-library-identity: end";

export interface LibraryIdentityValues {
  buildIdSymbol: string;
  abiVersionSymbol: string;
  buildId: string;
  abiVersion: number;
}

function identityMarkers(emission: LibraryEmission): { begin: string; end: string } {
  return emission === "c"
    ? { begin: C_LIBRARY_IDENTITY_BEGIN, end: C_LIBRARY_IDENTITY_END }
    : { begin: LLVM_LIBRARY_IDENTITY_BEGIN, end: LLVM_LIBRARY_IDENTITY_END };
}

export function emitLibraryIdentityLines(
  emission: LibraryEmission,
  identity: LibraryIdentityValues,
  llvmFunctionAttrs = "#0",
): string[] {
  if (!/^[0-9a-f]{16}$/.test(identity.buildId)) {
    throw new Error("library build id must be exactly 16 lowercase hex digits");
  }
  if (emission === "c") {
    return [
      C_LIBRARY_IDENTITY_BEGIN,
      `uint64_t ${identity.buildIdSymbol}(void) {`,
      `  return UINT64_C(0x${identity.buildId});`,
      `}`,
      ``,
      `uint32_t ${identity.abiVersionSymbol}(void) {`,
      `  return ${identity.abiVersion}u;`,
      `}`,
      ``,
      C_LIBRARY_IDENTITY_END,
    ];
  }
  const signedBuildId = BigInt.asIntN(64, BigInt(`0x${identity.buildId}`)).toString();
  return [
    LLVM_LIBRARY_IDENTITY_BEGIN,
    `define i64 @${identity.buildIdSymbol}() ${llvmFunctionAttrs} { ; identity getter build_id 0x${identity.buildId}`,
    `entry:`,
    `  ret i64 ${signedBuildId}`,
    `}`,
    ``,
    `define i32 @${identity.abiVersionSymbol}() ${llvmFunctionAttrs} { ; identity getter abi_version`,
    `entry:`,
    `  ret i32 ${identity.abiVersion}`,
    `}`,
    ``,
    LLVM_LIBRARY_IDENTITY_END,
  ];
}

function identityOffsets(
  source: string,
  emission: LibraryEmission,
): { start: number; end: number } | null {
  const { begin, end } = identityMarkers(emission);
  const start = source.indexOf(`${begin}\n`);
  if (start < 0) return null;
  if (source.indexOf(begin, start + begin.length) >= 0) {
    throw new Error("generated library TU contains multiple identity regions");
  }
  const endStart = source.indexOf(end, start + begin.length);
  if (endStart < 0) throw new Error("generated library TU has an unterminated identity region");
  return { start, end: endStart + end.length };
}

/** Refresh only the volatile identity block in a cached public TU. */
export function replaceLibraryIdentity(
  source: string,
  emission: LibraryEmission,
  identity: LibraryIdentityValues,
): string {
  const offsets = identityOffsets(source, emission);
  if (offsets === null) throw new Error("generated public library TU has no identity region");
  const replacement = emitLibraryIdentityLines(emission, identity).join("\n");
  return source.slice(0, offsets.start) + replacement + source.slice(offsets.end);
}

function escapedRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sourceCommentPattern(sourceFile: string): RegExp {
  // Emission appends these comments at physical line ends. Requiring that
  // boundary prevents source-looking text inside a generated C string from
  // being mistaken for an annotation and changing program semantics. An
  // uninitialized reference declaration appends its own `/* let ... */`
  // explanation after the location, so admit that one generated suffix too.
  return new RegExp(
    ` /\\* ${escapedRegExp(sourceFile)}:(\\d+) \\*/` +
      `(?= /\\* let [^\\r\\n]*; \\*/(?=\\r?\\n|$)|\\r?\\n|$)`,
    "g",
  );
}

/** Refresh the source-line annotations retained in a caller-visible C TU. */
export function rebaseLibrarySourceComments(
  source: string,
  sourceFile: string,
  rebaseLine: (line: number) => number,
): string {
  return source.replace(sourceCommentPattern(sourceFile), (_match, line: string) =>
    ` /* ${sourceFile}:${rebaseLine(Number(line))} */`);
}

/** Remove C-only debugging annotations from the private native-cache input. */
export function stripLibrarySourceComments(source: string, sourceFile: string): string {
  return source.replace(sourceCommentPattern(sourceFile), "");
}

/** Remove the generated identity region from a complete caller-visible
 * library TU. Archive assembly compiles this stable projection beside the
 * small volatile identity C object, while the public TU remains complete. */
export function stripLibraryIdentity(
  source: string,
  emission: LibraryEmission,
): string {
  const offsets = identityOffsets(source, emission);
  if (offsets === null) return source;
  const endOffset = offsets.end;
  const suffix = source[endOffset] === "\n" ? endOffset + 1 : endOffset;
  let prefix = source.slice(0, offsets.start);
  // An omitted final region leaves the emitter's preceding empty array entry
  // as one trailing newline; a marked final region has material after that
  // entry and therefore renders it as two. Restore the omitted form exactly.
  if (suffix === source.length && prefix.endsWith("\n\n")) {
    prefix = prefix.slice(0, -1);
  }
  return prefix + source.slice(suffix);
}
