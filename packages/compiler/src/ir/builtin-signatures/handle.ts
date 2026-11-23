import { arrayOf, DYN, F64, STRING, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The handle builtin call slots. */
export const handleSignatures = defineLibFnSignatures({
  // Own properties JavaScript adds to runtime handles: the child's, and
  // Date/RegExp/Map/Set/weak collections/buffers (handle-properties.ts).
  // The install call's argument is 1 when the program adds properties to
  // children (the child unit's wrapped ops), 0 otherwise.
  "handle.propsInstall": { argTypes: [F64], result: VOID },
  "handle.propsGrant": { argTypes: [STRING], result: VOID },
  "handle.propsDefineProps": { argTypes: [DYN, DYN], result: DYN },
  "handle.propsGuard": { argTypes: [DYN, STRING], result: DYN },
  "handle.propsGuardList": { argTypes: [arrayOf(DYN), STRING], result: arrayOf(DYN) },
  "handle.propsCheck": { argTypes: [DYN, STRING], result: VOID },
});
