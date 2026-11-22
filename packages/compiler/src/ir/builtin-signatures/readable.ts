import { BOOL, BYTES_U8, DYN, F64, STRING, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The readable builtin call slots. */
export const readableSignatures = defineLibFnSignatures({
  // node:stream: receivers are stream-hierarchy objects and several
  // results are program-dependent (the receiver's class, unions) — the
  // libCall case owns those checks. The constructors and a few methods
  // are VARIADIC (trailing option callbacks / the optional chunk+cb tail):
  // argTypes here is the fixed prefix, VARIADIC_LIB_FNS admits the rest.
  /** node:stream (scr_stream.c, link-gated by moduleUsesStream — which
   * implies the emitter unit: stream events dispatch through the embedded
   * ScrEmitter registry). Receivers are borrowed stream-class objects
   * (`%Readable`/`%Writable`/`%Duplex`/`%Transform`/`%PassThrough` — one
   * runtime layout, reinterpreted by side).
   *
   * Constructors (`readable.new` et al): args are [hwmR, hwmW, flags]
   * followed by the PRESENT user callbacks in canonical order (read,
   * write, final, destroy, transform, flush — the flags f64 is a bitmask
   * naming which follow; absent ones emit NULL). Every callback closure
   * MOVES and carries a leading `this` param (the stream), invoked
   * through compiler-emitted adapters. Results are +1.
   *
   * readable.push / readable.pushStr / readable.pushNull: Node's push —
   * buffers or delivers (bytes chunk borrowed; string converted utf8);
   * returns the below-hwm answer. readable.read: (recv, size — -1 for
   * absent) → Buffer|null union. pause/resume return recv +1 (`this`);
   * isPaused answers the flag. readable.pipe: (recv, dst, end) → dst +1,
   * fires 'pipe' on dst; readable.pipeGeneral: the same, with `end` off
   * when dst is the converted process.stdout / process.stderr;
   * readable.unpipe (recv[, dst]) → recv +1.
   * writable.write/writeStr: (recv, chunk[, cb]) → below-hwm bool (cb
   * MOVES when present, called after the user write completes).
   * writable.writeEnc: (recv, flags, chunk[, encoding][, cb]) — flags 1
   * an encoding argument, 2 a callback (the encoding is then null, as
   * Node's write shifts it).
   * writable.end: (recv, flags[, chunk][, encoding][, cb]) → recv +1;
   * flags 16: an encoding argument follows the dyn chunk. cork/uncork are
   * void. stream.destroy/destroyErr: (recv[, err]) → recv +1.
   * stream.prop: (recv, name-literal) → the flag/number the name asks
   * for; stream.errored → Error|null union; readable.flowing →
   * bool|null union. All may leave a listener's exception pending
   * (dispatch runs user code synchronously, like emit). */
  "readable.new": { argTypes: [F64, BOOL, BOOL, F64], result: VOID },
  "readable.newDyn": { argTypes: [DYN], result: VOID },
  "readable.initDyn": { argTypes: [null, DYN, F64], result: VOID },
  /** Subclass initialization (`super(options?)` in a user `extends
   * Readable` constructor): same tail as the `.new` forms, prefixed with
   * the BORROWED receiver (the emitted subclass allocation — vtable and
   * display name stamped, state NULL until here). Overridden underscore
   * methods arrive as synthesized wrapper closures dispatching through
   * the vtable. Void result. */
  "readable.init": { argTypes: [null, F64, BOOL, BOOL, F64], result: VOID },
  "readable.push": { argTypes: [null, BYTES_U8], result: BOOL },
  "readable.pushStr": { argTypes: [null, STRING], result: BOOL },
  "readable.pushNull": { argTypes: [null], result: BOOL },
  "readable.pushU": { argTypes: [null, null], result: BOOL },
  "readable.pushDyn": { argTypes: [null, DYN], result: BOOL },
  "readable.unshift": { argTypes: [null, BYTES_U8], result: BOOL },
  "readable.unshiftDyn": { argTypes: [null, DYN], result: BOOL },
  "readable.unshiftStr": { argTypes: [null, STRING], result: BOOL },
  "readable.readDyn": { argTypes: [null, DYN], result: DYN },
  "readable.read": { argTypes: [null, F64], result: VOID },
  "readable.pause": { argTypes: [null], result: VOID },
  "readable.setEncoding": { argTypes: [null, STRING], result: VOID },
  /** push(chunk, enc) with a literal non-utf8 encoding, and the
   * defaultEncoding option's push side (how push(string) decodes —
   * Buffer.from(chunk, enc)); both carry the CANONICAL literal. */
  "readable.pushStrEnc": { argTypes: [null, STRING, STRING], result: BOOL },
  "readable.pushEncoding": { argTypes: [null, STRING], result: VOID },
  /** The `encoding` option as the program spelled it, when that is not
   * the canonical name: what readableEncoding answers. Answers the
   * receiver (+1, the chaining shape). */
  "readable.encodingName": { argTypes: [null, STRING], result: VOID },
  /** for-await over a readable (the desugared loop's per-pass promise):
   * +1 promise of the next chunk — buffered content, the EOF sentinel
   * (empty Buffer / dyn undefined), or a rejection with the stream's
   * error. The Dyn twin boxes chunks by runtime tag (the JS lane).
   * readable.fromArr is Readable.from over a typed array, string or
   * Buffer: [array, SCR_FROM_* flags, highWaterMark]. readable.fromDyn is
   * Readable.from over a checked-dynamic source: [source, options].
   * readable.fromIter is Readable.from over a class iterator, already
   * opened: [checked-dynamic { next } object, flags, highWaterMark];
   * readable.fromAsyncIter is the async class iterator's twin. */
  /** readable.iterator (scr_stream_iterator.c): the readable and the
   * destroyOnReturn flag; the async iterator object. */
  "readable.iterator": { argTypes: [null, BOOL], result: DYN },
  "readable.nextChunk": { argTypes: [null], result: VOID },
  "readable.nextChunkDyn": { argTypes: [null], result: VOID },
  "readable.fromArr": { argTypes: [null, F64, F64], result: VOID },
  "readable.fromDyn": { argTypes: [DYN, DYN], result: VOID },
  "readable.fromIter": { argTypes: [DYN, F64, F64], result: VOID },
  "readable.fromAsyncIter": { argTypes: [DYN, F64, F64], result: VOID },
  /** Readable.from over a compiled generator: [generator, next, return,
   * throw, flags, highWaterMark] (sync) or [generator, next, read,
   * return, throw, flags, highWaterMark] (async), the helpers being the
   * frontend's interned closures. readable.fromDone is the done marker
   * the helpers answer. */
  "readable.fromGen": { argTypes: [null, null, null, null, F64, F64], result: VOID },
  "readable.fromAsyncGen": { argTypes: [null, null, null, null, null, F64, F64], result: VOID },
  "readable.fromDone": { argTypes: [], result: DYN },
  /** The Readable operators (scr_stream_ops.c): [stream, ...] with every
   * other argument a checked-dynamic value (the callback, the count, the
   * options). map/filter/flatMap/drop/take answer the object-mode output
   * stream (validated as a stream class; THROW Node's validation errors);
   * toArray settles a dyn array, find a dyn value, some/every a boolean,
   * forEach nothing; reduce: [stream, fn, init, hasInit, options, kind]
   * with the payload kind (0 dyn, 1 number, 2 boolean, 3 string). The
   * promise-returning ones reject instead of throwing. */
  "readable.opMap": { argTypes: [null, DYN, DYN, DYN], result: VOID },
  "readable.opFilter": { argTypes: [null, DYN, DYN, DYN], result: VOID },
  "readable.opFlatMap": { argTypes: [null, DYN, DYN, DYN], result: VOID },
  /** flatMap whose callback returns a compiled generator: the helpers
   * over its type follow (async: next, read, return, throw; sync: next,
   * return, throw). */
  "readable.opFlatMapAsyncGen": {
    argTypes: [null, DYN, DYN, DYN, null, null, null, null],
    result: VOID,
  },
  "readable.opFlatMapSyncGen": {
    argTypes: [null, DYN, DYN, DYN, null, null, null],
    result: VOID,
  },
  "readable.opDrop": { argTypes: [null, DYN, DYN], result: VOID },
  "readable.opTake": { argTypes: [null, DYN, DYN], result: VOID },
  "readable.opToArray": { argTypes: [null, DYN], result: { kind: "promise", inner: DYN } },
  "readable.opForEach": {
    argTypes: [null, DYN, DYN, DYN],
    result: { kind: "promise", inner: VOID },
  },
  "readable.opSome": {
    argTypes: [null, DYN, DYN, DYN],
    result: { kind: "promise", inner: BOOL },
  },
  "readable.opEvery": {
    argTypes: [null, DYN, DYN, DYN],
    result: { kind: "promise", inner: BOOL },
  },
  "readable.opFind": { argTypes: [null, DYN, DYN, DYN], result: { kind: "promise", inner: DYN } },
  /** The map family's last argument is the callback's { signal } (or
   * undefined). reduceSignal adds ac.abort() (a closure) and
   * { signal: ac.signal } for a reducer that reads them. */
  "readable.opReduce": { argTypes: [null, DYN, DYN, BOOL, DYN, F64], result: VOID },
  "readable.opReduceSignal": {
    argTypes: [null, DYN, DYN, BOOL, DYN, F64, null, DYN],
    result: VOID,
  },
  "readable.opSignalList": { argTypes: [DYN], result: DYN },
  "readable.opSignalOpts": { argTypes: [DYN], result: DYN },
  "readable.opSignalOf": { argTypes: [DYN], result: DYN },
  "readable.opOnceOptions": { argTypes: [], result: DYN },
  "readable.resume": { argTypes: [null], result: VOID },
  "readable.isPaused": { argTypes: [null], result: BOOL },
  "readable.pipe": { argTypes: [null, null, BOOL], result: VOID },
  "readable.pipeGeneral": { argTypes: [null, null, BOOL], result: VOID },
  "readable.unpipe": { argTypes: [null], result: VOID },
  "readable.flowing": { argTypes: [null], result: VOID },
});
