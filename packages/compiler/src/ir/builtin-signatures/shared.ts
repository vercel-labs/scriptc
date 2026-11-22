import type { IrType } from "../ir.js";

/** Runtime call slots. A null argument accepts a program-dependent type;
 * VOID can mark a program-dependent result. The validator checks those
 * cases against the call and module rather than treating them as wildcards.
 * One file per builtin module lives beside this one; each imports the slot
 * types it uses from ../ir.js. */
export interface LibFnSignature {
  argTypes: (IrType | null)[];
  result: IrType;
}

/** Preserve the closed names while giving every entry the same slot type. */
export function defineLibFnSignatures<Name extends string>(
  signatures: Record<Name, LibFnSignature>,
): Record<Name, LibFnSignature> {
  return signatures;
}
