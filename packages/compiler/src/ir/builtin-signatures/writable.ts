import { BOOL, BYTES_U8, DYN, F64, STRING, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The writable builtin call slots. */
export const writableSignatures = defineLibFnSignatures({
  "writable.new": { argTypes: [F64, BOOL, BOOL, F64], result: VOID },
  "writable.newDyn": { argTypes: [DYN], result: VOID },
  "writable.initDyn": { argTypes: [null, DYN, F64], result: VOID },
  "writable.init": { argTypes: [null, F64, BOOL, BOOL, F64], result: VOID },
  "writable.writeEncoding": { argTypes: [null, STRING], result: VOID },
  "writable.setDefaultEncoding": { argTypes: [null, DYN], result: VOID },
  "writable.write": { argTypes: [null, BYTES_U8], result: BOOL },
  "writable.writeStr": { argTypes: [null, STRING], result: BOOL },
  "writable.writeU": { argTypes: [null, null], result: BOOL },
  "writable.writeDyn": { argTypes: [null, DYN], result: BOOL },
  "writable.writeEnc": { argTypes: [null, F64, DYN], result: BOOL },
  /** The error-first write form: (recv, mode, chunk, encoding, cb) where
   * mode 0 is a bytes chunk, 1 a string, 2 a run-time chunk, and the
   * callback takes the completion's error (Node's null on success). */
  "writable.writeEcb": { argTypes: [null, F64, null, DYN, null], result: BOOL },
  "writable.end": { argTypes: [null, F64], result: VOID },
  /** writable.end with an error-first completion callback: the same
   * arguments; the callback takes (error: Error | null) and receives
   * ERR_STREAM_ALREADY_FINISHED when the stream already finished. */
  "writable.endEcb": { argTypes: [null, F64], result: VOID },
  "writable.cork": { argTypes: [null], result: VOID },
  "writable.uncork": { argTypes: [null], result: VOID },
});
