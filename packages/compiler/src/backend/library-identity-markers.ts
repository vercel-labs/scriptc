import { InternalCompilerError } from "../errors.js";
import { alignFunctionEntries } from "./llvm/function-alignment.js";

const LLVM_LIBRARY_IDENTITY_BEGIN = "; scriptc-library-identity: begin";
const LLVM_LIBRARY_IDENTITY_END = "; scriptc-library-identity: end";

export interface LibraryIdentityValues {
  buildIdSymbol: string;
  abiVersionSymbol: string;
  buildId: string;
  abiVersion: number;
}

function identityMarkers(): { begin: string; end: string } {
  return { begin: LLVM_LIBRARY_IDENTITY_BEGIN, end: LLVM_LIBRARY_IDENTITY_END };
}

export function emitLibraryIdentityLines(
  identity: LibraryIdentityValues,
  llvmFunctionAttrs = "#0",
): string[] {
  if (!/^[0-9a-f]{16}$/.test(identity.buildId)) {
    throw new InternalCompilerError("library build id must be exactly 16 lowercase hex digits");
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

function identityOffsets(source: string): { start: number; end: number } | null {
  const { begin, end } = identityMarkers();
  const start = source.indexOf(`${begin}\n`);
  if (start < 0) return null;
  if (source.indexOf(begin, start + begin.length) >= 0) {
    throw new InternalCompilerError("generated library TU contains multiple identity regions");
  }
  const endStart = source.indexOf(end, start + begin.length);
  if (endStart < 0)
    throw new InternalCompilerError("generated library TU has an unterminated identity region");
  return { start, end: endStart + end.length };
}

/** Refresh only the volatile identity block in a cached public TU. */
export function replaceLibraryIdentity(source: string, identity: LibraryIdentityValues): string {
  const offsets = identityOffsets(source);
  if (offsets === null)
    throw new InternalCompilerError("generated public library TU has no identity region");
  // The emitter aligns every function entry in the TU it writes, so the
  // refreshed region must carry the same alignment as the one it replaces.
  const replacement = alignFunctionEntries(emitLibraryIdentityLines(identity)).join("\n");
  return source.slice(0, offsets.start) + replacement + source.slice(offsets.end);
}

/** Remove the generated identity region from a complete caller-visible
 * library TU. Archive assembly compiles this stable projection beside the
 * small volatile identity object, while the public TU remains complete. */
export function stripLibraryIdentity(source: string): string {
  const offsets = identityOffsets(source);
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
