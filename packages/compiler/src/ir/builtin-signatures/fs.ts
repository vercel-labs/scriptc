import {
  arrayOf,
  BOOL,
  BYTES_U8,
  DIR_T,
  DYN,
  F64,
  FSWATCHER_T,
  MKDTEMPRESULT_T,
  STATWATCHER_T,
  STATS_T,
  STRING,
  VOID,
  funcOf,
} from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The fs builtin call slots. */
export const fsSignatures = defineLibFnSignatures({
  "fs.openAsBlob": { argTypes: [DYN, DYN], result: { kind: "promise", inner: DYN } },
  "fs.readFileSync": { argTypes: [STRING, STRING], result: STRING },
  "fs.readFileEncoded": { argTypes: [STRING, STRING], result: STRING },
  "fs.readFdEncoded": { argTypes: [F64, STRING], result: STRING },
  /** readFileSync(path) — the Buffer read (+1 bytes); throws catchably
   * like the utf8 form. */
  "fs.readFileSyncBuf": { argTypes: [STRING], result: BYTES_U8 },
  /** readFileSync(path, enc) with a RUNTIME encoding (an untyped JS
   * parameter): undefined/null answer Buffers, utf8 a string, other real
   * encodings throw the "not supported yet" Error, unknown names throw
   * ERR_UNKNOWN_ENCODING. */
  "fs.readFileSyncDyn": { argTypes: [STRING, DYN], result: DYN },
  /** readFileSync(path, { encoding, flag }) answering a string or a
   * Buffer: the options ladder (getOptions, stringToFlags, open(2)) runs
   * at run time; the call site's type selected the arm. */
  "fs.readFileSyncStrOpts": { argTypes: [STRING, DYN], result: STRING },
  "fs.readFileSyncBytesOpts": { argTypes: [STRING, DYN], result: BYTES_U8 },
  "fs.writeFileSync": { argTypes: [STRING, STRING], result: VOID },
  "fs.appendFileSync": { argTypes: [STRING, STRING], result: VOID },
  "fs.existsSync": { argTypes: [STRING], result: BOOL },
  /** existsSync over a path value that is not statically a string: the
   * string case is fs.existsSync, and any other value answers false with
   * Node's one DEP0187 report (scr_fs_exists_dyn.c). */
  "fs.existsSyncValue": { argTypes: [DYN], result: BOOL },
  /** existsSync over a statically typed byte path: the bytes decode to the
   * path and the probe runs (scr_lib.c), no boxing and no dynamic tier. */
  "fs.existsSyncBytes": { argTypes: [BYTES_U8], result: BOOL },
  "fs.mkdirSync": { argTypes: [STRING], result: VOID },
  "fs.rmSync": { argTypes: [STRING], result: VOID },
  "fs.rmdirSync": { argTypes: [STRING], result: VOID },
  "fs.readdirSync": { argTypes: [STRING], result: arrayOf(STRING) },
  /** `fs.readdirSync(path, { recursive: true })`: every entry below the
   * path, relative to it, in Node's queue order. */
  "fs.readdirRecursiveSync": { argTypes: [STRING], result: arrayOf(STRING) },
  "fs.readdirBytesSync": { argTypes: [STRING], result: arrayOf(BYTES_U8) },
  "fs.readdirEncodedSync": { argTypes: [STRING, STRING], result: arrayOf(STRING) },
  // Result is the call site's Dirent record array (VOID is the
  // structure-checked sentinel, the os.networkInterfaces pattern).
  /** `fs.readdirSync(path, { withFileTypes: true })` — Dirent rows over
   * one readdir pass (scr_lib.c's scandir snapshot; DT_UNKNOWN falls back
   * to lstat, Node's getDirents rule). The result type is the call site's
   * interned Dirent record array (name, parentPath, hidden %dtype in
   * libuv's UV_DIRENT encoding) — verified by the frontend; the emitter
   * assembles the rows from the snapshot. Byte order on POSIX (libuv
   * sorts), the directory's order on Windows; no "."/"..". Throws
   * Node's scandir errno error (may-throw seed set); fresh +1 array. */
  "fs.readdirTypesSync": { argTypes: [STRING], result: VOID },
  "fs.readdirTypesRecursiveSync": { argTypes: [STRING], result: VOID },
  /** fs.globSync / fs.glob / fs/promises glob (scr_glob.c, Node's
   * lib/internal/fs/glob.js walk): pattern and options are dyn values the
   * runtime validates in Node's order. The string forms answer string[];
   * the Dirent forms answer the call site's Dirent record array (validated
   * in validate.ts) assembled from the snapshot; fs.callbackGlob takes the
   * argument vector and calls back with string[]. */
  "fs.globSync": { argTypes: [DYN, DYN], result: arrayOf(STRING) },
  "fs.globTypesSync": { argTypes: [DYN, DYN], result: VOID },
  "fs.callbackGlob": { argTypes: [DYN], result: VOID },
  /** fs.Dir (scr_lib.c): opendirSync(path, bufferSize) throws Node's
   * opendir error (or the options.bufferSize RangeError); dir.readSync
   * answers the call site's `Dirent | null` (VOID here — the emitter builds
   * the row like readdirTypesSync) and dir.read is its promise twin;
   * readSync and closeSync throw ERR_DIR_CLOSED on a closed Dir, read and
   * close reject with it. */
  "fs.opendirSync": { argTypes: [STRING, F64], result: DIR_T },
  /** fs.constants: the target's cached null-prototype constants object. */
  "fs.constants": { argTypes: [], result: DYN },
  /** realpath(3) with Node's error shape (syscall "lstat" in the message,
   * Node's own spelling for realpathSync failures). +1 fresh string. */
  "fs.realpathSync": { argTypes: [STRING], result: STRING },
  /** fs.realpathSync (or its .native when the flag is true) as a function
   * value: path and options arrive unchecked; the result is a string or a
   * Buffer by the options' encoding. */
  "fs.realpathValue": { argTypes: [DYN, DYN, BOOL], result: DYN },
  /** Native realpath with syscall "realpath" on failure. +1 fresh string. */
  "fs.realpathNativeSync": { argTypes: [STRING], result: STRING },
  /** getValidatedPath's null-byte check on a string path, and
   * readFileSync's encoding check: what Node validates before it converts
   * a later URL path. (path, argument name) and (encoding). */
  "fs.checkPath": { argTypes: [STRING, STRING], result: VOID },
  "fs.checkReadEncoding": { argTypes: [STRING], result: VOID },
  /** fs.statSync → a Stats value (may throw, like the other sync fs
   * calls); the stats.* getters are pure reads on it. */
  "fs.statSync": { argTypes: [STRING], result: STATS_T },
  "fs.lstatSync": { argTypes: [STRING], result: STATS_T },
  // statSync / lstatSync(path, { throwIfNoEntry }): arg 1 is the flag.
  // Result is the interned `Stats | undefined` union (the runtime answers
  // +1-or-NULL; the backend builds the arms).
  "fs.statProbeSync": { argTypes: [STRING, BOOL], result: VOID },
  "fs.lstatProbeSync": { argTypes: [STRING, BOOL], result: VOID },
  // statSync/lstatSync(path, options) and fstatSync(fd, options) with an
  // options value only the runtime knows: Node's member ladder over the
  // value (bigint selects the member table, throwIfNoEntry the missing-
  // entry answer) answers Stats, BigIntStats or undefined as a checked-
  // dynamic object, so no static stats type can name it.
  "fs.statSyncDyn": { argTypes: [STRING, DYN], result: DYN },
  "fs.lstatSyncDyn": { argTypes: [STRING, DYN], result: DYN },
  "fs.fstatSyncDyn": { argTypes: [DYN, DYN], result: DYN },
  // A checked-dynamic Stats object back into the snapshot the typed
  // members read (the ladder's answer at a typed slot). `statsFromDynOpt`
  // answers NULL for the dynamic undefined, so its call site builds the
  // `Stats | undefined` union (the runtime's +1-or-NULL answer).
  "fs.statsFromDyn": { argTypes: [DYN], result: STATS_T },
  "fs.statsFromDynOpt": { argTypes: [DYN], result: VOID },
  "fs.fstatSync": { argTypes: [F64], result: STATS_T },
  "fs.fchmodSync": { argTypes: [F64, F64], result: VOID },
  "fs.fchmodSyncStr": { argTypes: [F64, STRING], result: VOID },
  "fs.fchmodSyncDyn": { argTypes: [DYN, DYN], result: VOID },
  "fs.fsyncSync": { argTypes: [F64], result: VOID },
  "fs.fdatasyncSync": { argTypes: [F64], result: VOID },
  "fs.ftruncateSync": { argTypes: [F64, F64], result: VOID },
  "fs.utimesSync": { argTypes: [DYN, DYN, DYN], result: VOID },
  "fs.futimesSync": { argTypes: [DYN, DYN, DYN], result: VOID },
  "fs.lutimesSync": { argTypes: [DYN, DYN, DYN], result: VOID },
  "fs.readvSync": { argTypes: [F64, arrayOf(BYTES_U8), F64], result: F64 },
  "fs.writevSync": { argTypes: [F64, arrayOf(BYTES_U8), F64], result: F64 },
  "fs.linkSync": { argTypes: [DYN, DYN], result: VOID },
  "fs.symlinkSync": { argTypes: [DYN, DYN, DYN], result: VOID },
  /** fs.cpSync / fs/promises cp (scr_fs_cp.c): src, dest and options are
   * dyn values the runtime validates in Node's order. */
  "fs.cpSync": { argTypes: [DYN, DYN, DYN], result: VOID },
  "fs.readlinkSync": { argTypes: [DYN, DYN], result: DYN },
  "fs.statfsSync": { argTypes: [DYN, DYN], result: DYN },
  "fs.readlinkSyncStr": { argTypes: [DYN, DYN], result: STRING },
  "fs.readlinkSyncBuffer": { argTypes: [DYN, DYN], result: BYTES_U8 },
  /** fs.openSync(path, flags, mode) → the raw fd as f64; fs.readSync/
   * fs.writeSync over Buffer windows perform sequential I/O when position
   * is -1 and offset-preserving positioned I/O otherwise; fs.writeStrSync
   * is the utf8 string twin; and fs.closeSync(fd) closes the descriptor.
   * This is the fd slice behind spawn/log-processing forms.
   * flags is Node's string
   * grammar ("r", "w", "a" and the +/x variants; unknown flags throw
   * Node's ERR_INVALID_ARG_VALUE TypeError text), and mode is open(2)'s
   * creation mode (Node's 0o666 default, ERR_OUT_OF_RANGE outside
   * 0..0xFFFFFFFF). All throw Node-shaped fs errors (openSync
   * ENOENT/EACCES..., readSync EBADF/range errors, closeSync EBADF). */
  "fs.openSync": { argTypes: [STRING, STRING, F64], result: F64 },
  "fs.openNumericSync": { argTypes: [STRING, F64, F64], result: F64 },
  "fs.openNumericStrSync": { argTypes: [STRING, F64, STRING], result: F64 },
  "fs.openNumericDynSync": { argTypes: [STRING, F64, DYN], result: F64 },
  "fs.openStrModeSync": { argTypes: [STRING, STRING, STRING], result: F64 },
  "fs.openNativeSync": { argTypes: [STRING, F64, F64], result: F64 },
  "fs.openDynSync": { argTypes: [STRING, DYN, DYN], result: F64 },
  "fs.openModeDynSync": { argTypes: [STRING, STRING, DYN], result: F64 },
  "fs.openNativeStrSync": { argTypes: [STRING, F64, STRING], result: F64 },
  "fs.openNativeDynSync": { argTypes: [STRING, F64, DYN], result: F64 },
  "fs.readSync": { argTypes: [F64, BYTES_U8, F64, F64, F64], result: F64 },
  "fs.writeSync": { argTypes: [F64, BYTES_U8, F64, F64, F64], result: F64 },
  "fs.writeStrSync": { argTypes: [F64, STRING, F64, STRING], result: F64 },
  /** The fd primitives' checked-dynamic lane: the argument kinds the call
   * site did not pin down take Node's own run-time ladder (readSync also
   * needs the call's argument count for its options form), then the typed
   * operation. */
  "fs.readSyncArgs": { argTypes: [DYN, DYN, DYN, DYN, DYN, F64], result: F64 },
  "fs.writeSyncArgs": { argTypes: [DYN, DYN, DYN, DYN, DYN], result: F64 },
  "fs.readvSyncDyn": { argTypes: [DYN, DYN, DYN], result: F64 },
  "fs.writevSyncDyn": { argTypes: [DYN, DYN, DYN], result: F64 },
  "fs.ftruncateSyncDyn": { argTypes: [DYN, DYN], result: VOID },
  "fs.closeSyncDyn": { argTypes: [DYN], result: VOID },
  "fs.fsyncSyncDyn": { argTypes: [DYN], result: VOID },
  "fs.fdatasyncSyncDyn": { argTypes: [DYN], result: VOID },
  "fs.fchownSyncDyn": { argTypes: [DYN, DYN, DYN], result: VOID },
  // fs.watch's callback func type is program-dependent (zero params, or
  // the eventType string) — the slot pins arity and the path/receiver.
  /** fs.watch(path, listener?) → an FSWatcher handle (scr_watch.c —
   * linked, and scr_watch_install() emitted, only when these appear on
   * the IR; moduleUsesFsWatch is the switch). The path opens NOW —
   * failure throws Node's fs error synchronously ("ENOENT: ..., watch
   * 'x'", the polling-fallback catch shape) — and the unit's kqueue
   * (EVFILT_VNODE) delivers "rename"/"change" through the loop's watch
   * hook. The callback (nullable) MOVES in with an adapter per listener
   * shape (zero-param, or the (eventType: string) form — runtime-
   * provided); an open watcher keeps the loop alive until watcher.close()
   * (idempotent, receiver borrowed, statement position only). */
  "fs.watch": { argTypes: [STRING, BOOL, BOOL], result: FSWATCHER_T },
  "fs.utf8StreamNew": { argTypes: [DYN], result: DYN },
  "fs.watchCb": { argTypes: [STRING, null, BOOL, BOOL], result: FSWATCHER_T },
  /** fs.watchFile(path, interval, persistent, listener) → void
   * (scr_watch_file.c — its own gated unit; moduleUsesFsWatchFile is the
   * switch, and scr_watch_file_install() is emitted with it). One
   * libuv-shaped stat poller per RESOLVED path, shared by every listener
   * on it; the listener's (current, previous) Stats func type is
   * program-dependent, so the slot pins the arity. Statement position
   * only (Node returns a StatWatcher). fs.unwatchFile(path[, listener])
   * takes a borrowed listener; the null slot is the absent one. */
  "fs.watchFile": { argTypes: [STRING, F64, BOOL, null], result: STATWATCHER_T },
  "fs.unwatchFile": { argTypes: [STRING, null], result: VOID },
  "fs.closeSync": { argTypes: [F64], result: VOID },
  // The wider sync fs slice (unlink/chmod/chown/copyfile and the
  // mode-carrying write/mkdir forms).
  /** The wider sync fs slice (scr_lib.c), all throwing catchably with
   * Node's errno message shapes and `.code` stamped like the rest of
   * sync fs. unlink/chmod/chown wrap the syscalls 1:1 (Node reports the
   * syscall's own name). copyFileSync copies contents into a fresh (or
   * truncated) destination carrying the SOURCE's mode (libuv's
   * uv_fs_copyfile behavior); its errors carry BOTH paths — Node's
   * "copyfile 'src' -> 'dest'". lstatSync is statSync without following
   * a trailing symlink (Node reports lstat); stats.isSymbolicLink /
   * stats.dev / ino / blocks / nlink / atimeMs / mtimeMs / ctimeMs are pure reads on the widened
   * snapshot (blocks is allocated 512-byte units; the times are milliseconds
   * with their sub-second fractions, Node's arithmetic).
   * writeFileModeSync is writeFileSync(path, data, { mode }): the mode
   * applies at CREATION only (open(2) with O_CREAT, umask applying),
   * exactly Node — an existing file keeps its permissions. mkdirModeSync
   * / mkdirRecursiveModeSync are the mkdirSync option forms with an
   * explicit mode (the recursive walk passes it to every directory it
   * creates, like Node's). */
  "fs.unlinkSync": { argTypes: [STRING], result: VOID },
  "fs.chmodSync": { argTypes: [STRING, F64], result: VOID },
  "fs.chmodSyncStr": { argTypes: [STRING, STRING], result: VOID },
  "fs.chmodSyncDyn": { argTypes: [STRING, DYN], result: VOID },
  "fs.chownSync": { argTypes: [STRING, F64, F64], result: VOID },
  "fs.lchownSync": { argTypes: [STRING, F64, F64], result: VOID },
  "fs.fchownSync": { argTypes: [F64, F64, F64], result: VOID },
  /** truncateSync opens the path with 'r+', then truncates (len checked and
   * clamped like ftruncateSync's) and closes it. */
  "fs.truncateSync": { argTypes: [STRING, F64], result: VOID },
  "fs.copyFileSync": { argTypes: [STRING, STRING], result: VOID },
  /** copyFileSync(src, dest, mode): libuv's uv_fs_copyfile flag bits —
   * COPYFILE_EXCL (1) fails on an existing destination, COPYFILE_FICLONE
   * (2) requests a reflink and falls back to a copy, COPYFILE_FICLONE_FORCE
   * (4) requires one. Out-of-range modes throw the RangeError Node throws
   * ("mode is out of range: >= 0 && <= 7"). */
  "fs.copyFileFlagsSync": { argTypes: [STRING, STRING, F64], result: VOID },
  /** renameSync is the direct two-path syscall wrapper. renameCb defers
   * the operation to the loop and fires a program-shaped Error | null
   * callback through a backend-emitted adapter. */
  "fs.renameSync": { argTypes: [STRING, STRING], result: VOID },
  // Callback type is program-dependent (zero params or Error | null).
  "fs.renameCb": { argTypes: [STRING, STRING, null], result: VOID },
  "fs.writeFileModeSync": { argTypes: [STRING, STRING, F64], result: VOID },
  /** writeFileSync(path, data, { mode, flag }): the same open(2) write
   * with the disposition flag — flag 1 is "wx" (O_EXCL: EEXIST when the
   * path exists), 0 is "w" (the default truncate-or-create). */
  "fs.writeFileFlagsSync": { argTypes: [STRING, STRING, F64, F64], result: VOID },
  /** writeFileSync(path, data, { encoding, mode, flag }): the same open(2)
   * write with the data encoded for `encoding` and the flag table Node
   * documents (scr_fs_flags.c). appendFileOptionsSync is appendFileSync's
   * three-argument form, whose default flag is "a"; the Bytes twins write
   * a Buffer/TypedArray argument with the mode and flag options. */
  "fs.writeFileOptionsSync": { argTypes: [STRING, STRING, STRING, F64, STRING], result: VOID },
  "fs.appendFileOptionsSync": { argTypes: [STRING, STRING, STRING, F64, STRING], result: VOID },
  "fs.writeFileBytesOptionsSync": {
    argTypes: [STRING, BYTES_U8, STRING, F64, STRING],
    result: VOID,
  },
  "fs.appendFileBytesOptionsSync": {
    argTypes: [STRING, BYTES_U8, STRING, F64, STRING],
    result: VOID,
  },
  /** The same two option writes over a data argument whose static type is
   * not a string or a u8 view (a typed array of another element, a
   * DataView alias, a checked-dynamic value): the runtime validates the
   * data (Node's "string or an instance of Buffer, TypedArray, or
   * DataView"), then encodes a string or writes a view's bytes. */
  "fs.writeFileDataOptionsSync": {
    argTypes: [STRING, DYN, STRING, F64, STRING],
    result: VOID,
  },
  "fs.appendFileDataOptionsSync": {
    argTypes: [STRING, DYN, STRING, F64, STRING],
    result: VOID,
  },
  /** The same option writes with a `mode` whose static type is not a
   * number (an octal string, or a value the call site did not pin down)
   * and/or a `flag` whose static type is not a string (open(2) bits, or a
   * value the call site did not pin down): the runtime runs parseFileMode's
   * mode ladder and stringToFlags on the dynamic slots, keeping Node's
   * encoding, flag, mode, path validation order. */
  "fs.writeFileOptionsDynModeSync": {
    argTypes: [STRING, STRING, STRING, DYN, DYN],
    result: VOID,
  },
  "fs.appendFileOptionsDynModeSync": {
    argTypes: [STRING, STRING, STRING, DYN, DYN],
    result: VOID,
  },
  "fs.writeFileBytesOptionsDynModeSync": {
    argTypes: [STRING, BYTES_U8, STRING, DYN, DYN],
    result: VOID,
  },
  "fs.appendFileBytesOptionsDynModeSync": {
    argTypes: [STRING, BYTES_U8, STRING, DYN, DYN],
    result: VOID,
  },
  "fs.writeFileDataOptionsDynModeSync": {
    argTypes: [STRING, DYN, STRING, DYN, DYN],
    result: VOID,
  },
  "fs.appendFileDataOptionsDynModeSync": {
    argTypes: [STRING, DYN, STRING, DYN, DYN],
    result: VOID,
  },
  "fs.mkdirModeSync": { argTypes: [STRING, F64], result: VOID },
  "fs.mkdirRecursiveModeSync": { argTypes: [STRING, F64], result: VOID },
  "fs.mkdirModeStrSync": { argTypes: [STRING, STRING], result: VOID },
  // Results are program-dependent unions (string | undefined); the
  // lowering fills the real type from the call site, like envGet.
  "fs.mkdirObjSync": { argTypes: [STRING, F64, BOOL], result: VOID },
  "fs.mkdirObjStrSync": { argTypes: [STRING, STRING, BOOL], result: VOID },
  "fs.mkdirDynSync": { argTypes: [STRING, DYN], result: VOID },
  "fs.mkdirDynVoidSync": { argTypes: [STRING, DYN], result: VOID },
  "fs.mkdirModeValueSync": { argTypes: [STRING, F64], result: VOID },
  "fs.mkdirModeStrValueSync": { argTypes: [STRING, STRING], result: VOID },
  "fs.mkdirObjVoidSync": { argTypes: [STRING, F64, BOOL], result: VOID },
  "fs.mkdirObjStrVoidSync": { argTypes: [STRING, STRING, BOOL], result: VOID },
  /** fs._toUnixTimestamp(time) over a dyn value: numeric strings and
   * finite numbers coerce (negatives answer now/1000, Node's shape);
   * everything else throws Node's ERR_INVALID_ARG_TYPE. May-throw. */
  "fs.toUnixTimestamp": { argTypes: [DYN], result: F64 },
  /** The fs argument-validation ladders (checked-dynamic lane): each Chk
   * replicates its API's Node-order validation over dyn values (Node's
   * exact typed errors — ERR_INVALID_ARG_TYPE/VALUE, ERR_OUT_OF_RANGE),
   * and a full pass meets the trailing compiler-rendered SC2020 fence
   * string — so the ALWAYS-THROW forms take the error.nodeThrow
   * polymorphic-result carve-out. mkdtempSyncChk and the lchmod sync/
   * promise pair run the REAL operation on a validated pass instead
   * (macOS lchmod(2); non-APPLE answers Node's not-a-function /
   * ERR_METHOD_NOT_IMPLEMENTED shapes). May-throw seeds, all of them. */
  "fs.existsChk": { argTypes: [DYN, DYN], result: DYN },
  "fs.mkdtempChk": { argTypes: [DYN, DYN, STRING], result: VOID },
  "fs.mkdtempSyncChk": { argTypes: [DYN, DYN, STRING], result: STRING },
  "fs.readFileChk": { argTypes: [DYN, DYN, DYN, STRING], result: VOID },
  "fs.opendirChk": { argTypes: [DYN, DYN, STRING], result: VOID },
  "fs.watchFileChk": { argTypes: [DYN, DYN, STRING], result: VOID },
  "fs.lchmodChk": { argTypes: [DYN, DYN, DYN, STRING], result: VOID },
  "fs.lchmodSyncChk": { argTypes: [DYN, DYN], result: DYN },
  "fs.readChk": { argTypes: [DYN, DYN, DYN, DYN, DYN, STRING], result: VOID },
  "fs.streamOptsChk": { argTypes: [DYN, DYN, STRING], result: VOID },
  /** fs.ReadStream / fs.WriteStream (scr_fs_stream.c): the constructors
   * take the path and options as dyn values and throw Node's option
   * errors; the members read bytesRead/bytesWritten, pending and the path
   * value, and close() / close(cb) (a `() => void` callback). */
  "fs.createReadStream": {
    argTypes: [DYN, DYN],
    result: { kind: "object", className: "%Readable" },
  },
  "fs.createWriteStream": {
    argTypes: [DYN, DYN],
    result: { kind: "object", className: "%Writable" },
  },
  /** The same four constructors where the options can hold a `signal`
   * (fsStreamOptionsMayHoldSignal): the same runtime entries, in the
   * SCR_FS_STREAM_SIGNAL build of the unit, which applies the signal. */
  "fs.createReadStreamSignal": {
    argTypes: [DYN, DYN],
    result: { kind: "object", className: "%Readable" },
  },
  "fs.createWriteStreamSignal": {
    argTypes: [DYN, DYN],
    result: { kind: "object", className: "%Writable" },
  },
  "fs.fsStreamBytes": { argTypes: [null], result: F64 },
  "fs.fsStreamPending": { argTypes: [null], result: BOOL },
  "fs.fsStreamPath": { argTypes: [null], result: DYN },
  "fs.fsStreamPropDyn": { argTypes: [null, STRING], result: DYN },
  "fs.fsStreamClose": { argTypes: [null], result: VOID },
  "fs.fsStreamCloseCb": { argTypes: [null, funcOf([], VOID)], result: VOID },
  /** The Buffer forms of fs: readFileSync(path) with NO
   * encoding → bytes<u8> (+1), writeFileSync/appendFileSync(path, bytes), and the
   * fs/promises readFile(path) no-encoding form (an already-settled
   * promise, rejecting on failure like the other fsp members). The sync
   * forms THROW catchably on failure exactly like the utf8 forms. */
  "fs.readFileSyncBytes": { argTypes: [STRING], result: BYTES_U8 },
  "fs.writeFileSyncBytes": { argTypes: [STRING, BYTES_U8], result: VOID },
  "fs.appendFileSyncBytes": { argTypes: [STRING, BYTES_U8], result: VOID },
  /** writeFileSync/appendFileSync(path, data) over a data argument whose
   * static type is a view of another element, a DataView alias, or a
   * checked-dynamic value. The runtime validates the argument and writes a
   * string as text and a view as the bytes it covers. */
  "fs.writeFileSyncData": { argTypes: [STRING, DYN], result: VOID },
  "fs.appendFileSyncData": { argTypes: [STRING, DYN], result: VOID },
  /** writeFileSync(path, bytes, { mode, flag }) and its fs/promises
   * twins: the byte-data spellings of the option write (scr_fs_flags.c's
   * open(2) with the disposition flag, creation mode at creation only). */
  "fs.writeFileSyncBytesFlags": { argTypes: [STRING, BYTES_U8, F64, F64], result: VOID },
  /** The { mode, flag } write over the checked data argument. */
  "fs.writeFileSyncDataFlags": { argTypes: [STRING, DYN, F64, F64], result: VOID },
  "fs.mkdtempDisposableSync": { argTypes: [STRING], result: MKDTEMPRESULT_T },
  "fs.callbackValue": { argTypes: [STRING, F64], result: DYN },
  "fs.callbackCall": { argTypes: [STRING, DYN], result: DYN },
  /** The fs option forms and friends (scr_lib.c), all throwing catchably
   * like the rest of sync fs. mkdirRecursiveSync is Node's recursive
   * algorithm (try mkdir, EEXIST-dir is fine, ENOENT creates the parent
   * first — errors report Node's errno at Node's path, EEXIST at a file
   * target, ENOTDIR at the full path past a file); the first-created-dir
   * return value has no lowering (statement position only, frontend-
   * fenced). rmOptsSync is rmSync with (recursive, force) bools: force
   * swallows ENOENT, recursive removes trees post-order, a directory
   * without recursive throws Node's ERR_FS_EISDIR SystemError. mkdtempSync appends the six X's and returns the
   * created path (+1). accessSync takes the F_OK/R_OK/W_OK/X_OK bits as
   * one f64 (the frontend bakes fs.constants.* as literals and completes
   * an omitted mode to 0). readFdSync/readFdSyncBytes are the
   * readFileSync(fd[, "utf8"]) forms — a read(2) loop to EOF on the fd
   * (the stdin path); errors carry Node's no-path message shape. */
  "fs.mkdirRecursiveSync": { argTypes: [STRING], result: VOID },
  "fs.rmOptsSync": { argTypes: [STRING, BOOL, BOOL], result: VOID },
  /** rmOptsSync's maxRetries/retryDelay form (path, recursive, force,
   * maxRetries, retryDelay): Node's linear-backoff retry on
   * EBUSY/EMFILE/ENFILE/ENOTEMPTY/EPERM — the tmpdir-harness shape
   * rmSync(p, { maxRetries: 3, recursive: true, force: true }). Throws
   * ERR_OUT_OF_RANGE for a retryDelay outside int32 >= 0 or a maxRetries
   * outside uint32, before checking the path. */
  "fs.rmRetrySync": { argTypes: [STRING, BOOL, BOOL, F64, F64], result: VOID },
  "fs.mkdtempSync": { argTypes: [STRING], result: STRING },
  "fs.accessSync": { argTypes: [STRING, F64], result: VOID },
  "fs.readFdSync": { argTypes: [F64, STRING], result: STRING },
  /** The writeFileSync(fd, data) form: a write(2) loop over the whole
   * string at the descriptor's current offset, leaving the descriptor
   * open (closeSync owns it). Errors carry the fd operation's errno
   * shape ("EBADF: bad file descriptor, write"). */
  "fs.writeFileSyncFd": { argTypes: [F64, STRING], result: VOID },
  /** writeFileSync(fd, data) over the checked data argument. */
  "fs.writeFileSyncFdData": { argTypes: [F64, DYN], result: VOID },
  "fs.readFdSyncBytes": { argTypes: [F64], result: BYTES_U8 },
});
