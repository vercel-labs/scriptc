// A dep-style module: the shape an npm package's entry takes — its own
// import of a node: builtin, re-exported through a small named API. The
// static program graph compiles it like any program file, so the crypto
// libCall lives in a NON-entry module: the moduleUses* gating walks must
// see it there, and the binary links the native crypto runtime with no
// island (no --dynamic anywhere).
import { randomUUID } from "node:crypto";

export function v4(): string {
  return randomUUID();
}

/** The dash positions Node's uuid format pins (8/13/18/23). */
export function dashes(u: string): string {
  return u.charAt(8) + u.charAt(13) + u.charAt(18) + u.charAt(23);
}
