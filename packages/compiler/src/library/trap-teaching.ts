import { InternalCompilerError } from "../errors.js";
/* The structured trap-teaching encoding (ratified 2026-07-23). A library-mode
 * sink message that carries a diagnostic code and/or the trapping symbol is
 * assembled as
 *
 *   0x01  text  0x1F code  0x1F symbol  [ 0x1F remediation ]
 *
 * The human teaching text LEADS the buffer so a plain-text host still shows
 * something useful; 0x01 (ASCII SOH) is the version marker — every baseline
 * (unstructured) message is UTF-8 whose first byte is printable, and no
 * emitter path may ever produce an unstructured message whose first byte is
 * below 0x20, so `msg_len > 0 && msg[0] == 0x01` identifies a structured
 * message unambiguously. Fields ride 0x1F (ASCII Unit Separator); the whole
 * remediation field, separator included, is absent when the profile supplies
 * none. Emitters MUST NOT append fields beyond these four under this marker;
 * parsers MUST ignore any field past the fourth.
 *
 * Division of labor (the spec's compatibility clause): the profile authors
 * teaching and remediation text, the COMPILER assembles the buffer here
 * (code, symbol, framing), and the runtime funnel and the host sink carry
 * the bytes opaque and unchanged — the sink signature (ctx, msg pointer,
 * len, address) is frozen; all structure lives in the message bytes.
 *
 * Code space: SC-prefixed codes belong exclusively to the compiler's
 * diagnostics registry; embedder-supplied codes are embedder-prefixed and
 * validated only as tokens free of the reserved bytes (profile.ts), never
 * for registry membership. */

/** The structured-message version marker (byte 0). A future encoding
 * revision bumps the marker byte — the marker IS the version. */
export const TRAP_TEACHING_MARKER = "\u0001";
/** The field separator between text, code, symbol, and remediation. */
export const TRAP_TEACHING_SEP = "\u001f";

/** Assemble one structured trap-teaching message. Every field must already
 * be free of the two reserved bytes — profile-supplied text is validated at
 * profile load (SC4001), and the compiler's own texts, codes, and symbols
 * never contain control bytes — so a violation here is an internal error,
 * never a user-reportable state. */
export function assembleTrapTeaching(
  text: string,
  code: string,
  symbol: string,
  remediation?: string,
): string {
  const fields: [string, string][] = [["text", text], ["code", code], ["symbol", symbol]];
  if (remediation !== undefined) fields.push(["remediation", remediation]);
  for (const [name, value] of fields) {
    if (value.includes(TRAP_TEACHING_MARKER) || value.includes(TRAP_TEACHING_SEP)) {
      throw new InternalCompilerError(`trap-teaching assembler: ${name} contains a reserved byte (0x01/0x1F)`);
    }
  }
  return (
    TRAP_TEACHING_MARKER + text + TRAP_TEACHING_SEP + code + TRAP_TEACHING_SEP + symbol +
    (remediation !== undefined ? TRAP_TEACHING_SEP + remediation : "")
  );
}
