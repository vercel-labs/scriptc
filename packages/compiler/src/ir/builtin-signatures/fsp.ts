import {
  arrayOf,
  BOOL,
  BYTES_U8,
  DIR_T,
  DYN,
  F64,
  FILEHANDLE_T,
  MKDTEMPRESULT_T,
  WATCHEVENTS_T,
  STATS_T,
  STRING,
  VOID,
} from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The fsp builtin call slots. */
export const fspSignatures = defineLibFnSignatures({
  "fsp.globStrings": { argTypes: [DYN, DYN], result: arrayOf(STRING) },
  "fsp.globTypes": { argTypes: [DYN, DYN], result: VOID },
  /** The error an fs/promises glob walk ended with (undefined when none),
   * read once right after fsp.globStrings / fsp.globTypes. */
  "fsp.globError": { argTypes: [], result: DYN },
  "fsp.opendir": { argTypes: [STRING, F64], result: { kind: "promise", inner: DIR_T } },
  /** fsPromises.watch(path, persistent) → the async iterator
   * (scr_watch_async.c — its own gated unit over scr_watch.c's watcher;
   * moduleUsesFsWatchEvents is the switch, and scr_watch_events_install()
   * is emitted with it). Consumed only as a `for await` source: the loop
   * awaits watchEvents.wait and pops one entry with watchEvents.take,
   * whose `{ eventType, filename } | null` result the lowering types.
   * close() is the loop's finally. */
  "fsp.watch": { argTypes: [STRING, BOOL, F64, BOOL], result: WATCHEVENTS_T },
  "fsp.lchmodChk": { argTypes: [DYN, DYN], result: { kind: "promise", inner: VOID } },
  "fsp.readFileBytes": { argTypes: [STRING], result: { kind: "promise", inner: BYTES_U8 } },
  "fsp.readFile": { argTypes: [STRING, STRING], result: { kind: "promise", inner: STRING } },
  "fsp.writeFile": { argTypes: [STRING, STRING], result: { kind: "promise", inner: VOID } },
  /** fs.promises.writeFile(path, data, { mode }): the settled-promise
   * twin of fs.writeFileModeSync. */
  "fsp.writeFileMode": {
    argTypes: [STRING, STRING, F64],
    result: { kind: "promise", inner: VOID },
  },
  /** fs.promises.writeFile(path, data, { mode, flag }) and
   * fs.promises.copyFile(src, dest, mode): the settled-promise twins of
   * fs.writeFileFlagsSync and fs.copyFileFlagsSync. */
  "fsp.writeFileFlags": {
    argTypes: [STRING, STRING, F64, F64],
    result: { kind: "promise", inner: VOID },
  },
  "fsp.copyFileFlags": {
    argTypes: [STRING, STRING, F64],
    result: { kind: "promise", inner: VOID },
  },
  "fsp.mkdir": { argTypes: [STRING], result: { kind: "promise", inner: VOID } },
  /** The fs/promises option/member tail the certs pipeline uses: mkdir's
   * literal { recursive?, mode? } options (the mkdirSync matrix behind
   * settled promises), unlink, chmod. Failures REJECT (catchable at the
   * await), like the rest of the fsp family. */
  "fsp.mkdirMode": { argTypes: [STRING, F64], result: { kind: "promise", inner: VOID } },
  "fsp.mkdirRecursive": { argTypes: [STRING], result: { kind: "promise", inner: VOID } },
  "fsp.mkdirRecursiveMode": { argTypes: [STRING, F64], result: { kind: "promise", inner: VOID } },
  "fsp.unlink": { argTypes: [STRING], result: { kind: "promise", inner: VOID } },
  "fsp.chmod": { argTypes: [STRING, F64], result: { kind: "promise", inner: VOID } },
  "fsp.chown": { argTypes: [STRING, F64, F64], result: { kind: "promise", inner: VOID } },
  "fsp.lchown": { argTypes: [STRING, F64, F64], result: { kind: "promise", inner: VOID } },
  "fsp.lchmod": { argTypes: [DYN, DYN], result: { kind: "promise", inner: VOID } },
  "fsp.access": { argTypes: [STRING, F64], result: { kind: "promise", inner: VOID } },
  "fsp.truncate": { argTypes: [STRING, F64], result: { kind: "promise", inner: VOID } },
  "fsp.appendFile": { argTypes: [STRING, STRING], result: { kind: "promise", inner: VOID } },
  "fsp.appendFileBytes": {
    argTypes: [STRING, BYTES_U8],
    result: { kind: "promise", inner: VOID },
  },
  /** fs.promises.writeFile(path, bytes): the truncating write, and its
   * { mode, flag } form — the settled-promise twins of
   * fs.writeFileSyncBytes and fs.writeFileSyncBytesFlags. */
  "fsp.writeFileBytes": {
    argTypes: [STRING, BYTES_U8],
    result: { kind: "promise", inner: VOID },
  },
  "fsp.writeFileBytesFlags": {
    argTypes: [STRING, BYTES_U8, F64, F64],
    result: { kind: "promise", inner: VOID },
  },
  /** fs.promises.writeFile/appendFile over the checked data argument. */
  "fsp.writeFileData": {
    argTypes: [STRING, DYN],
    result: { kind: "promise", inner: VOID },
  },
  "fsp.appendFileData": {
    argTypes: [STRING, DYN],
    result: { kind: "promise", inner: VOID },
  },
  "fsp.writeFileDataFlags": {
    argTypes: [STRING, DYN, F64, F64],
    result: { kind: "promise", inner: VOID },
  },
  "fsp.copyFile": { argTypes: [STRING, STRING], result: { kind: "promise", inner: VOID } },
  "fsp.mkdtemp": { argTypes: [STRING], result: { kind: "promise", inner: STRING } },
  /** fsPromises.mkdtempDisposable / fs.mkdtempDisposableSync: the temp
   * directory plus its removal and disposal hooks (scr_lib.c). The
   * options record crosses as one dyn value for the runtime's Node-order
   * encoding check. */
  "fsp.mkdtempDisposable": {
    argTypes: [STRING],
    result: { kind: "promise", inner: MKDTEMPRESULT_T },
  },
  /** readFile(path, encoding | { encoding }) for any runtime encoding name. */
  "fsp.readFileEncoded": {
    argTypes: [STRING, STRING],
    result: { kind: "promise", inner: STRING },
  },
  "fsp.rmdir": { argTypes: [STRING], result: { kind: "promise", inner: VOID } },
  "fsp.link": { argTypes: [DYN, DYN], result: { kind: "promise", inner: VOID } },
  "fsp.symlink": { argTypes: [DYN, DYN, DYN], result: { kind: "promise", inner: VOID } },
  "fsp.cp": { argTypes: [DYN, DYN, DYN], result: { kind: "promise", inner: VOID } },
  "fsp.readlink": { argTypes: [DYN, DYN], result: { kind: "promise", inner: DYN } },
  "fsp.statfs": { argTypes: [DYN, DYN], result: { kind: "promise", inner: DYN } },
  "fsp.readlinkStr": { argTypes: [DYN, DYN], result: { kind: "promise", inner: STRING } },
  "fsp.readlinkBuffer": { argTypes: [DYN, DYN], result: { kind: "promise", inner: BYTES_U8 } },
  "fsp.utimes": { argTypes: [DYN, DYN, DYN], result: { kind: "promise", inner: VOID } },
  "fsp.lutimes": { argTypes: [DYN, DYN, DYN], result: { kind: "promise", inner: VOID } },
  "fsp.rename": { argTypes: [STRING, STRING], result: { kind: "promise", inner: VOID } },
  "fsp.readdir": { argTypes: [STRING], result: { kind: "promise", inner: arrayOf(STRING) } },
  "fsp.readdirRecursive": {
    argTypes: [STRING],
    result: { kind: "promise", inner: arrayOf(STRING) },
  },
  "fsp.readdirBytes": {
    argTypes: [STRING],
    result: { kind: "promise", inner: arrayOf(BYTES_U8) },
  },
  "fsp.readdirEncoded": {
    argTypes: [STRING, STRING],
    result: { kind: "promise", inner: arrayOf(STRING) },
  },
  // Result is promise<call-site Dirent record array>; the libCall case
  // validates the program-dependent record shape in validate.ts.
  /** `fs.promises.readdir(path, { withFileTypes: true })` — the settled-
   * promise twin of fs.readdirTypesSync. The backends assemble the same
   * call-site-shaped Dirent rows, then move the array into a promise;
   * scandir failure becomes its rejection. */
  "fsp.readdirTypes": { argTypes: [STRING], result: { kind: "promise", inner: VOID } },
  "fsp.readdirTypesRecursive": {
    argTypes: [STRING],
    result: { kind: "promise", inner: VOID },
  },
  "fsp.rm": { argTypes: [STRING], result: { kind: "promise", inner: VOID } },
  /** `fs.promises.rm(path, options)`: fs.rmOptsSync and fs.rmRetrySync
   * behind a settled promise; their errors become its rejection. */
  "fsp.rmOpts": { argTypes: [STRING, BOOL, BOOL], result: { kind: "promise", inner: VOID } },
  "fsp.rmRetry": {
    argTypes: [STRING, BOOL, BOOL, F64, F64],
    result: { kind: "promise", inner: VOID },
  },
  "fsp.stat": { argTypes: [STRING], result: { kind: "promise", inner: STATS_T } },
  "fsp.realpath": { argTypes: [STRING], result: { kind: "promise", inner: STRING } },
  "fsp.lstat": { argTypes: [STRING], result: { kind: "promise", inner: STATS_T } },
  /** fs.promises.stat/lstat(path, options): bigint and throwIfNoEntry are
   * read at run time by the ladder the synchronous forms use; the call's
   * type names the member table and whether a suppressed miss answers
   * undefined. */
  "fsp.statOpts": { argTypes: [STRING, DYN], result: DYN },
  "fsp.lstatOpts": { argTypes: [STRING, DYN], result: DYN },
  /** fs/promises.open and the statically represented FileHandle surface.
   * Every operation returns an already-settled promise; syscall failures
   * become rejections rather than escaping synchronously. read/write
   * results are call-site record shapes ({ bytesRead/bytesWritten,
   * buffer }) assembled by the backends around the fixed runtime ABI. */
  "fsp.open": {
    argTypes: [STRING, STRING, F64],
    result: { kind: "promise", inner: FILEHANDLE_T },
  },
});
