import { BOOL, DYN, F64 } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The sqlite builtin call slots. */
export const sqliteSignatures = defineLibFnSignatures({
  "sqlite.dbNew": { argTypes: [DYN, DYN], result: DYN },
  "sqlite.is": { argTypes: [DYN, F64], result: BOOL },
  "sqlite.backup": { argTypes: [DYN, DYN, DYN], result: DYN },
});
