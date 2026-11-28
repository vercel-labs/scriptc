import { arrayOf, BOOL, BYTES_U8, DYN, F64, FILEHANDLE_T, STATS_T, STRING, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The fileHandle builtin call slots. */
export const fileHandleSignatures = defineLibFnSignatures({
  "fileHandle.createReadStreamSignal": {
    argTypes: [FILEHANDLE_T, DYN],
    result: { kind: "object", className: "%Readable" },
  },
  "fileHandle.createWriteStreamSignal": {
    argTypes: [FILEHANDLE_T, DYN],
    result: { kind: "object", className: "%Writable" },
  },
  "fileHandle.createReadStream": {
    argTypes: [FILEHANDLE_T, DYN],
    result: { kind: "object", className: "%Readable" },
  },
  "fileHandle.createWriteStream": {
    argTypes: [FILEHANDLE_T, DYN],
    result: { kind: "object", className: "%Writable" },
  },
  /** The handle's content as Node's type: "bytes" web stream (a checked-
   * dynamic stream: the stdlib ReadableStream interface has no static
   * representation). */
  "fileHandle.readableWebStream": { argTypes: [FILEHANDLE_T, DYN], result: DYN },
  "fileHandle.fd": { argTypes: [FILEHANDLE_T], result: F64 },
  "fileHandle.close": { argTypes: [FILEHANDLE_T], result: { kind: "promise", inner: VOID } },
  "fileHandle.sync": { argTypes: [FILEHANDLE_T], result: { kind: "promise", inner: VOID } },
  "fileHandle.datasync": { argTypes: [FILEHANDLE_T], result: { kind: "promise", inner: VOID } },
  "fileHandle.truncate": {
    argTypes: [FILEHANDLE_T, F64],
    result: { kind: "promise", inner: VOID },
  },
  "fileHandle.chmod": { argTypes: [FILEHANDLE_T, F64], result: { kind: "promise", inner: VOID } },
  "fileHandle.chown": {
    argTypes: [FILEHANDLE_T, F64, F64],
    result: { kind: "promise", inner: VOID },
  },
  "fileHandle.utimes": {
    argTypes: [FILEHANDLE_T, DYN, DYN],
    result: { kind: "promise", inner: VOID },
  },
  "fileHandle.readv": {
    argTypes: [FILEHANDLE_T, arrayOf(BYTES_U8), F64],
    result: { kind: "promise", inner: VOID },
  },
  "fileHandle.writev": {
    argTypes: [FILEHANDLE_T, arrayOf(BYTES_U8), F64],
    result: { kind: "promise", inner: VOID },
  },
  // read/write carry call-site result record shapes; the validator checks
  // those in validate.ts, so promise<void> is only a table sentinel.
  "fileHandle.read": {
    argTypes: [FILEHANDLE_T, BYTES_U8, F64, F64, F64, BOOL],
    result: { kind: "promise", inner: VOID },
  },
  "fileHandle.writeBytes": {
    argTypes: [FILEHANDLE_T, BYTES_U8, F64, F64, F64, BOOL],
    result: { kind: "promise", inner: VOID },
  },
  "fileHandle.writeStr": {
    argTypes: [FILEHANDLE_T, STRING, F64, STRING],
    result: { kind: "promise", inner: VOID },
  },
  "fileHandle.readFile": {
    argTypes: [FILEHANDLE_T, STRING],
    result: { kind: "promise", inner: STRING },
  },
  "fileHandle.readFileBytes": {
    argTypes: [FILEHANDLE_T, STRING],
    result: { kind: "promise", inner: BYTES_U8 },
  },
  "fileHandle.writeFile": {
    argTypes: [FILEHANDLE_T, STRING, STRING],
    result: { kind: "promise", inner: VOID },
  },
  "fileHandle.writeFileBytes": {
    argTypes: [FILEHANDLE_T, BYTES_U8, STRING],
    result: { kind: "promise", inner: VOID },
  },
  "fileHandle.writeFileData": {
    argTypes: [FILEHANDLE_T, DYN, STRING],
    result: { kind: "promise", inner: VOID },
  },
  "fileHandle.stat": { argTypes: [FILEHANDLE_T], result: { kind: "promise", inner: STATS_T } },
  /** FileHandle.stat(options): Node reads only bigint for a descriptor (a
   * descriptor cannot miss, so throwIfNoEntry is not in StatOptions); the
   * runtime reads the member for its effects and TypeErrors, and the call's
   * own type names the Stats or BigIntStats table. */
  "fileHandle.statOpts": { argTypes: [FILEHANDLE_T, DYN], result: DYN },
});
