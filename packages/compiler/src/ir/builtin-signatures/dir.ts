import { DIR_T, DYN, STRING, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The dir builtin call slots. */
export const dirSignatures = defineLibFnSignatures({
  "dir.path": { argTypes: [DIR_T], result: STRING },
  "dir.readSync": { argTypes: [DIR_T], result: VOID },
  "dir.read": { argTypes: [DIR_T], result: { kind: "promise", inner: VOID } },
  "dir.closeSync": { argTypes: [DIR_T], result: VOID },
  "dir.close": { argTypes: [DIR_T], result: { kind: "promise", inner: VOID } },
  "dir.readCb": { argTypes: [DIR_T, DYN], result: VOID },
  "dir.closeCb": { argTypes: [DIR_T, DYN], result: VOID },
  "dir.dispose": { argTypes: [DIR_T], result: VOID },
  "dir.asyncDispose": { argTypes: [DIR_T], result: { kind: "promise", inner: VOID } },
});
