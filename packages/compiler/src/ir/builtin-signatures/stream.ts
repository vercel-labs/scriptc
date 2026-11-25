import { BOOL, CHILDSTREAM_T, DYN, F64, PROCSTREAM_T, STRING, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The stream builtin call slots. */
export const streamSignatures = defineLibFnSignatures({
  /** stream.duplexPair (scr_stream_pair.c): the options value (borrowed;
   * NULL means none) and the two connected Duplexes. */
  "stream.duplexPair": {
    argTypes: [DYN],
    result: { kind: "array", elem: { kind: "object", className: "%Duplex" } },
  },
  /** readable.wrap(stream) (scr_stream_wrap.c): the readable and the
   * native source; answers the readable. */
  "stream.wrap": { argTypes: [null, null], result: VOID },
  /** The same over a checked-dynamic source: a boxed native readable
   * unwraps, anything else throws the not-supported Error. */
  "stream.wrapDyn": { argTypes: [null, DYN], result: VOID },
  /** before new Worker() with the stdout or stderr option: links the stream
   * unit that worker.stdout and worker.stderr read through (scr_stream.c). */
  "stream.workerStdio": { argTypes: [], result: VOID },
  // Listener registrations: callback func shapes are program-dependent
  // (zero-param / Buffer / string / unknown / Buffer-armed union) — the slots pin arity,
  // the stream receiver, and the once-flag.
  "stream.onData": { argTypes: [CHILDSTREAM_T, null, BOOL], result: VOID },
  "stream.onDataStr": { argTypes: [CHILDSTREAM_T, null, BOOL], result: VOID },
  "stream.onEnd": { argTypes: [CHILDSTREAM_T, null, BOOL], result: VOID },
  "stream.childSetEncoding": { argTypes: [CHILDSTREAM_T, STRING], result: CHILDSTREAM_T },
  /** Node's flowing state on the piped-output handle (the runtime's
   * scr_child_flow.h): pause() and resume() answer the receiver (+1),
   * isPaused() a boolean, and readableFlowing the `boolean | null` union
   * (the libCall case checks the arms). A paused stream holds its chunks
   * back up to the high-water mark and then stops reading the pipe. */
  "stream.childPause": { argTypes: [CHILDSTREAM_T], result: CHILDSTREAM_T },
  "stream.childResume": { argTypes: [CHILDSTREAM_T], result: CHILDSTREAM_T },
  "stream.childIsPaused": { argTypes: [CHILDSTREAM_T], result: BOOL },
  "stream.childFlowing": { argTypes: [CHILDSTREAM_T], result: VOID },
  /** process.stdout/stderr flowing into a runtime Writable slot under the
   * general stream representation: an fd-backed Writable (+1) whose
   * writes take process.stdout.write's synchronous path. */
  /** A pipeline() stage that is a checked-dynamic value: a boxed native
   * stream unwraps by identity (+1); anything else throws the given
   * not-supported message. Typed as a Duplex so every stage position
   * accepts it; the runtime pipeline checks the stream's real sides. */
  "stream.unboxDyn": {
    argTypes: [DYN, STRING],
    result: { kind: "object", className: "%Duplex" },
  },
  /** Whether pipeline() pumps a checked-dynamic first stage as an
   * iterable (a string, a value with an iterator method that is not a
   * stream with pipe() and on(), a { readable, writable } pair, or a
   * source function's result) instead of piping it as a stream. */
  "stream.dynIterableSource": { argTypes: [DYN], result: BOOL },
  /** The value pipeline() pumps for a checked-dynamic first stage: a
   * source function's result (the flag set), which must be iterable, else
   * a { readable, writable } pair's readable side or the value itself. */
  "stream.dynSourceValue": { argTypes: [DYN, BOOL], result: DYN },
  /** An untyped pipeline function stage's result before the last stage,
   * which must be async iterable: ERR_INVALID_RETURN_VALUE naming the
   * stage ("transform[i]") otherwise. Answers the value (+1). */
  "stream.dynTransformResult": { argTypes: [DYN, STRING], result: DYN },
  "stream.duplexBodyValue": { argTypes: [DYN], result: DYN },
  /** A checked-dynamic pipeline() stage taken as a stream: a native stream
   * (+1), or Duplex.from of a value that is not stream-like or a function
   * (an iterable), which the pipeline uses without piping into it. Other
   * values throw: Duplex.from's ERR_INVALID_ARG_TYPE, or the given
   * not-supported message. */
  "stream.unboxDynStage": {
    argTypes: [DYN, STRING],
    result: { kind: "object", className: "%Duplex" },
  },
  /** The Transform a Cipheriv or Decipheriv reads and writes as a stream
   * (+1, created on first use and owned by the cipher). */
  "stream.handleStream": {
    argTypes: [DYN],
    result: { kind: "object", className: "%Transform" },
  },
  /** stream.handleWritable for a value typed as a Writable handle class
   * (a Sign or Verify): the value's native Writable (+1). */
  "stream.handleWritable": {
    argTypes: [DYN],
    result: { kind: "object", className: "%Writable" },
  },
  /** Checked-dynamic stream slots (dyn-streams.ts): the native stream a
   * checked-dynamic value boxes (+1) — a runtime stream with the readable
   * (1) or writable (2) side — or null for any other value. Never throws;
   * the result union is `%Readable | null` or `%Writable | null`. */
  "stream.dynNative": { argTypes: [DYN, F64], result: VOID },
  /** stream.dynNative for a pipe or unpipe destination: also a
   * constructor-function stream's runtime stream, in programs that link
   * that unit, unless it overrides write() or end(). */
  "stream.dynNativePipe": { argTypes: [DYN, F64], result: VOID },
  /** readable.pipe(destination, end) into a checked-dynamic destination
   * that is not a native stream: [source, the source boxed, destination,
   * end]. Node's pipe listener protocol over the destination's members
   * (scr_stream_dyn.c); throws what those members throw. */
  "stream.pipeDyn": { argTypes: [null, DYN, DYN, BOOL], result: VOID },
  /** readable.unpipe(destination) for a checked-dynamic destination that
   * is not a native stream: [source, destination]. Unpipes the pipe
   * stream.pipeDyn registered into it, if any (scr_stream_dyn.c). */
  "stream.unpipeDyn": { argTypes: [null, DYN], result: VOID },
  "stream.stdioWritable": {
    argTypes: [PROCSTREAM_T],
    result: { kind: "object", className: "%Writable" },
  },
  // The subclass-initialization twins: the borrowed receiver leads, then
  // the .new tail (variadic callbacks likewise).
  // The dyn-options twins: newDyn takes the record, initDyn the borrowed
  // receiver + record + fallback flags (trailing wrapper closures ride
  // the variadic tail like the static forms).
  /** The underscore-method assignment surface (`r._read = fn` after
   * construction — Node's own-property shadow of the prototype method):
   * args [stream receiver (borrowed), callback closure (+1 moves)]. The
   * runtime slot the matching option callback fills swaps its closure
   * and invoke thunk; the next dispatch uses it (Node's timing). The
   * setters themselves never throw. */
  "stream.setRead": { argTypes: [null, null], result: VOID },
  "stream.setWrite": { argTypes: [null, null], result: VOID },
  "stream.setFinal": { argTypes: [null, null], result: VOID },
  "stream.setDestroy": { argTypes: [null, null], result: VOID },
  "stream.setTransform": { argTypes: [null, null], result: VOID },
  "stream.setFlush": { argTypes: [null, null], result: VOID },
  "stream.setConstruct": { argTypes: [null, null], result: VOID },
  "stream.replaceConstruct": { argTypes: [null, null], result: VOID },
  "stream.setWritev": { argTypes: [null, null], result: VOID },
  "stream.setWritevDefault": { argTypes: [null, null], result: VOID },
  /** The dyn-options twins (a checked-dynamic options record — the JS
   * lane's `super(options)` forwarding and `new Readable(dynVar)`): the
   * option walk runs at RUNTIME with Node's reading rules. newDyn:
   * (optsDyn) → the fresh stream; initDyn: (recv, optsDyn, flags,
   * ...fallback wrapper closures in canonical order — the flags literal
   * names which ride, exactly the .init callback ABI). MAY THROW (a
   * consumed-but-unlowered option is the compile fence's runtime twin). */
  /** stream.finished(s, cb) — the callback form: the watcher fires once
   * at the terminal point with the finish status; the result is the +1
   * cleanup closure. stream.pipeline(count, s1..sn, cb): chains pipes,
   * propagates the first error by destroying the rest, calls cb after the
   * last 'close'; answers the destination +1. The Dyn twins take the
   * callback as a checked-dynamic VALUE (mustCall wrappers). */
  /** stream.addAbortSignal: [stream, signal] — the constructors' signal
   * option, chained over the fresh stream (falsy signals are ignored);
   * stream.addAbortSignalFn: [signal, stream] — addAbortSignal(signal,
   * stream). Both answer the stream (+1) and throw ERR_INVALID_ARG_TYPE
   * for a value that is not an AbortSignal; they link the event-target
   * unit (addAbortListener). */
  /** stream.getDefaultHighWaterMark(objectMode) (scr_stream_get_default_hwm): the default new streams take. */
  "stream.getDefaultHwm": { argTypes: [BOOL], result: F64 },
  /** stream.setDefaultHighWaterMark(objectMode, value): ERR_OUT_OF_RANGE for a negative or fractional value. */
  "stream.setDefaultHwm": { argTypes: [BOOL, F64], result: VOID },
  "stream.addAbortSignal": { argTypes: [null, DYN], result: VOID },
  "stream.addAbortSignalFn": { argTypes: [DYN, null], result: VOID },
  "stream.finished": { argTypes: [null, null], result: VOID },
  "stream.finishedDyn": { argTypes: [null, DYN], result: VOID },
  "stream.pipeline": { argTypes: [F64], result: VOID },
  "stream.pipelineDyn": { argTypes: [F64], result: VOID },
  "stream.pipelineStages": { argTypes: [F64, F64, F64, F64, F64], result: VOID },
  "stream.composeStages": { argTypes: [F64, F64, F64, F64, F64], result: VOID },
  "stream.pipelineStagesDyn": { argTypes: [F64, F64, F64, F64, F64], result: VOID },
  /** stream.compose(count, s1..sn): the Duplex over a pipeline of the
   * streams (+1). MAY THROW (ERR_INVALID_ARG_VALUE for a stream that is
   * no longer readable or writable). */
  "stream.compose": { argTypes: [F64], result: VOID },
  "stream.finishedOpts": { argTypes: [null, F64, F64, BOOL, null], result: VOID },
  "stream.finishedOptsSignal": { argTypes: [null, F64, F64, BOOL, DYN, null], result: VOID },
  "stream.onDyn": { argTypes: [null, STRING, DYN, BOOL, BOOL], result: VOID },
  /** The objectMode option's sides (readable, writable), applied right
   * after construction; answers the receiver (+1, the chaining shape). */
  "stream.objectMode": { argTypes: [null, BOOL, BOOL], result: VOID },
  "stream.decodeStrings": { argTypes: [null, BOOL], result: VOID },
  /** Runtime decodeStrings and defaultEncoding option values, applied
   * after construction (answers the receiver +1); the encoding was
   * validated by stream.checkEncodingOption before construction. */
  "stream.optionValues": { argTypes: [null, DYN, DYN], result: VOID },
  "stream.checkEncodingOption": { argTypes: [DYN], result: VOID },
  "stream.duplexFromGen": { argTypes: [null, null, null, null, null, null], result: VOID },
  "stream.duplexFromDyn": { argTypes: [DYN], result: VOID },
  /** Duplex.from over a lone Readable or Writable, or a { readable,
   * writable } pair of streams (duplexify.js's _duplexify). */
  "stream.duplexifyReadable": { argTypes: [null], result: VOID },
  "stream.duplexifyWritable": { argTypes: [null], result: VOID },
  "stream.duplexifyPair": { argTypes: [null, null], result: VOID },
  "stream.duplexifyPairHalf": { argTypes: [null, null, BOOL], result: VOID },
  /** Duplex.from(promise): the promise and its box helper. */
  "stream.duplexFromPromise": { argTypes: [null, null], result: VOID },
  /** Duplex.from(asyncFunction): the stage, its source helper and the
   * promise's box helper. */
  "stream.duplexFromAsyncFn": { argTypes: [null, null, null], result: VOID },
  /** The same for a body that declares the options argument: then the
   * AbortController's abort() and its signal. */
  "stream.duplexFromGenSignal": {
    argTypes: [null, null, null, null, null, null, null, DYN],
    result: VOID,
  },
  "stream.duplexFromAsyncFnSignal": { argTypes: [null, null, null, null, DYN], result: VOID },
  /** Whether a readable.nextChunkDyn step answered the end (the done
   * marker; an object-mode stream can yield undefined). */
  "stream.chunkDone": { argTypes: [DYN], result: BOOL },
  "stream.destroy": { argTypes: [null], result: VOID },
  "stream.destroyErr": { argTypes: [null, null], result: VOID },
  /** AsyncIteratorClose for Readable[Symbol.asyncIterator](): destroy with
   * Node's AbortError/ABORT_ERR payload while the iterator's internal error
   * consumer prevents an unhandled-error crash. */
  "stream.iteratorClose": { argTypes: [null], result: VOID },
  "stream.prop": { argTypes: [null, STRING], result: VOID },
  "stream.errored": { argTypes: [null], result: VOID },
  /** stream.isDestroyed, isErrored, isDisturbed, isReadable, isWritable
   * (the selector, 0 to 4): a boolean, or null where Node answers null.
   * stream.is takes a stream; stream.isDyn any checked-dynamic value and
   * throws SC2020 for one that is neither a native stream nor a
   * primitive. */
  "stream.is": { argTypes: [null, F64], result: DYN },
  "stream.isDyn": { argTypes: [DYN, F64], result: DYN },
  /** readableAborted, readableDidRead, readableEncoding, writableAborted
   * (the selector, 0 to 3) by the stream's class: undefined where Node's
   * prototype does not define the getter. */
  "stream.stateDyn": { argTypes: [null, F64], result: DYN },
  /** stream[Symbol.asyncDispose](): a pending void promise the stream's
   * terminal watcher settles. */
  "stream.asyncDispose": { argTypes: [null], result: { kind: "promise", inner: VOID } },
});
