import type { IrLibFn } from "./builtin-signatures.js";

const MAY_THROW_LIB_FNS_PART_1: readonly IrLibFn[] = [
  // The copied error of a synchronous call into Node (@scriptc/node).
  "nodeIsland.callSync",
  // Island module evaluation and member operations run JavaScript.
  "nodeIsland.require",
  // process.report loads the process builtin and reads the report object.
  "nodeIsland.processReport",
  "nodeIsland.defer",
  "nodeIsland.get",
  "nodeIsland.getKey",
  "nodeIsland.set",
  "nodeIsland.setKey",
  "nodeIsland.invoke",
  "nodeIsland.apply",
  "nodeIsland.applyTo",
  "nodeIsland.construct",
  "nodeIsland.instanceof",
  "nodeIsland.classMethods",
  "nodeIsland.subclass",
  "nodeIsland.superConstruct",
  "nodeIsland.superMethod",
  "nodeIsland.defineField",
  "nodeIsland.promisify",
  "nodeIsland.classMethodsOf",
  "nodeIsland.copyArrays",
  "nodeIsland.adoptThenable",
  "nodeIsland.promiseResolve",
  // A code that is not a safe integer throws, as process.setExitCode does.
  "nodeIsland.setExitCode",
  // A directory the process cannot enter throws, as process.chdir does.
  "nodeIsland.chdir",
  // Node's own clearTimeout, clearInterval or clearImmediate on an island
  // value, which is island JavaScript: a proxy's trap can throw there.
  "nodeIsland.clearTimer",
  // Both read Node's process.exitCode through an island helper once Node is
  // loaded, which is island JavaScript (the property can be redefined
  // there). The runtime drops what that read throws today and answers its
  // own value; the check keeps the call right if it ever delivers one.
  "nodeIsland.exitCode",
  "nodeIsland.hasExitCode",
  // Node's argument, cipher-name, IV, tag-length and key-length errors.
  "crypto.cipherNew",
  // Node's curve, key, point, encoding and format errors.
  "crypto.ecdhNew",
  "crypto.ecdhConvertKey",
  // Node's prime, generator, size, encoding and group-name errors.
  "crypto.dhNew",
  "crypto.dhGroupNew",
  // Node's nameOrNid and options errors.
  "crypto.getCipherInfo",
  // Reading the deprecated crypto.fips reports DEP0093 through
  // process.emitWarning, whose replacement may throw.
  "crypto.fipsGet",
  // Node's candidate, size, options, add and rem errors, and OpenSSL's
  // generation errors.
  "crypto.checkPrimeSync",
  "crypto.checkPrimeCb",
  "crypto.generatePrimeSync",
  "crypto.generatePrimeCb",
  // node:test's { timeout } and { concurrency } range checks, and the
  // mock { times } integer check.
  "test.register",
  // t.error builds Node's wrapper over the failure through the inspect
  // unit's rendering, which can raise.
  "test.ctxError",
  // The accessor descriptor walk can throw (a fenced class reflection, a
  // throwing getter trap), and the accessor requirement throws Node's
  // ERR_INVALID_ARG_VALUE for a missing method.
  "test.accessorDescriptor",
  "test.accessorRequire",
  // assert.register validates its function; a registered assertion and the
  // missing-name error throw from the call the runner makes.
  "test.assertRegister",
  "test.ctxCustomAssert",
  "test.mockTimes",
  "test.registerEmpty",
  "test.sub",
  "test.subEmpty",
  "test.suite",
  // t.plan's second-plan failure and { wait } range check.
  "test.ctxPlan",
  // mock.timers: Node's ERR_INVALID_STATE and ERR_INVALID_ARG_VALUE, and
  // the throws of the timer callbacks tick and runAll run.
  "test.ctxSnapshot",
  "test.fileSnapshot",
  // snapshot.setDefaultSnapshotSerializers validates its list (Node's
  // ERR_INVALID_ARG_TYPE).
  "test.snapshotSetDefaultSerializers",
  // The snapshot path resolver is program code and may throw.
  "test.snapshotPath",
  "test.snapshotSerialize",
  "test.mockTimersEnable",
  "test.mockTimersTick",
  "test.mockTimersRunAll",
  "test.mockTimersSetTime",
  "test.ctxMockTimersEnable",
  "test.ctxMockTimersTick",
  "test.ctxMockTimersRunAll",
  "test.ctxMockTimersSetTime",
  "tp.schedulerWait",
  "tp.schedulerWaitValue",
  "tp.schedulerWaitSignal",
  "console.write",
  "console.label",
  "console.countReset",
  "console.table",
  // Console construction validates its options in the runtime, and the
  // instance twins of the throwing members share their fences.
  "console.new",
  "console.instCount",
  "console.instCountReset",
  "console.instTable",
  "console.instTrace",
  "console.instWriteArgs",
  "console.instDirxmlArgs",
  "console.instDirArgs",
  "console.instTraceArgs",
  "console.instAssertArgs",
  "console.instGroupArgs",
  "console.dirDyn",
  "console.dirHidden",
  "worker.new",
  "worker.data",
  "worker.parentPort",
  "worker.resourceLimits",
  "worker.channel",
  "worker.portConstruct",
  "worker.receiveMessageOnPort",
  "worker.setEnvironmentData",
  "worker.getEnvironmentData",
  "worker.broadcastChannel",
  "process.exit",
  // process.exit(expr) and the exitCode writes convert the value with
  // Node's setter rules: the non-numeric-string TypeError, the Symbol and
  // BigInt conversion TypeErrors, and the integer ERR_OUT_OF_RANGE.
  "process.exitDyn",
  "text.encodeInto",
  "buffer.isAscii",
  "buffer.isUtf8",
  "buffer.transcode",
  "buffer.slowBuffer",
  "cp.spawnDynamic",
  "cp.checkArgs",
  "child.onDyn",
  "text.decoderEncoding",
  "strdec.encoding",
  "strdec.encodingValue",
  "strdec.writeDyn",
  "strdec.nextDyn",
  "dyn.construct",
  "dyn.reflectApply",
  "dyn.reflectConstruct",
  "dyn.reflectGet",
  "dyn.usingMethod",
  "dyn.usingDispose",
  "disposable.stackUseCallback",
  "dyn.reflectSet",
  "dyn.reflectDefine",
  "dyn.abstractEq",
  "text.decodeOptions",
  "text.decodeStream",
  "text.decodeLegacyOptions",
  "dyn.nativeSetNew",
  // new Set(iterable)/new Map(iterable) run the program's own add/set and
  // step the iterable
  "dyn.collectionConstruct",
  "dyn.setValues",
  "ffi.argument",
  "ffi.memoryModule",
  "process.stdoutWrite",
  "process.stdioWriteDyn",
  "process.stderrWrite",
  "process.stdoutWriteBytes",
  "process.stderrWriteBytes",
  "procStream.write",
  "child.stdioStream",
  "stream.unboxDyn",
  // The stream predicates and state getters refuse by name (SC2020): a
  // value that is neither a native stream nor a primitive, and a child or
  // process stdio stream asked about the side it does not have here.
  "stream.is",
  "stream.isDyn",
  "stream.stateDyn",
  "stream.dynIterableSource",
  "stream.dynSourceValue",
  "stream.unboxDynStage",
  "stream.dynTransformResult",
  "stream.handleStream",
  "stream.handleWritable",
  "stream.pipeDyn",
  "stream.unpipeDyn",
  "weakMap.new",
  "weakSet.new",
  // Node's "cleanup must be callable" TypeError.
  "finalizationRegistry.new",
  // Node's "WeakRef: invalid target" TypeError.
  "weakRef.new",
  "dyn.fromEntries",
  "bytes.constructor",
  "bytes.instanceOf",
  "buffer.byteLenDyn",
  "buffer.byteLenValue",
  "buffer.normalizeEncoding",
  "buffer.normalizeEncodingEmptyUtf8",
  "buffer.writeStrDyn",
  "buffer.writeStrDynLen",
  "buffer.allocValue",
  "fs.realpathValue",
  "dyn.validateString",
  "dyn.validateStrings",
  "dyn.validateFsPath",
  "path.resolveValue",
  "path.parseValue",
  "path.formatValue",
  // enableCompileCache and flushCompileCache validate their argument
  // (scr_module_cache.c), and reading the options object can run a getter.
  "module.compileCacheEnable",
  "module.compileCacheFlush",
  "bytes.construct",
  "arrayBuffer.new",
  "sharedArrayBuffer.new",
  "arrayBuffer.newResizable",
  "sharedArrayBuffer.newGrowable",
  "atomics.op",
  "atomics.wait",
  "atomics.notify",
  "atomics.opDyn",
  "atomics.waitDyn",
  "atomics.notifyDyn",
  // The typed-array builtins' detached-receiver guard (t262-dc2): Node's
  // TypeError, raised at the entry of sort/toSorted and the iterator
  // factories. Emitted only under the mutableBuffers fact, but the check
  // belongs to the call like every other runtime error.
  "bytes.requireLive",
  "arrayBuffer.byteLengthGetter",
  "arrayBuffer.viewU8C",
  "arrayBuffer.viewI8",
  "arrayBuffer.viewU16",
  "arrayBuffer.viewI16",
  "arrayBuffer.viewU8",
  "arrayBuffer.viewU32",
  "arrayBuffer.viewI32",
  "arrayBuffer.viewF16",
  "arrayBuffer.viewF32",
  "arrayBuffer.viewF64",
  "arrayBuffer.viewDV",
  "bytes.bufferSource",
  "text.decoderInput",
  "text.decoderFlag",
  "text.decodeStreamOption",
  "text.decoderEncodingOptions",
  "text.decodeBufferSource",

  "bigint.parse",
  "bigint.fromF64",
  "bigint.div",
  "bigint.mod",
  "bigint.pow",
  "bigint.shl",
  "bigint.shr",
  "bigint.toString",
  "bigint.asUintN",
  "bigint.asIntN",
  "bigint.bufferRead",
  "bigint.bufferWrite",
  "bigint.dataViewGet",
  "bigint.dataViewSet",
  "fetch.requestNew",
  "fetch.headersNew",
  "fetch.responseNew",
  "fetch.responseJsonStatic",
  "abort.timeout",
  "abort.any",
  "event.new",
  "event.customNew",
  "event.messageNew",
  "event.closeNew",
  "event.init",
  "event.targetCall",
  "event.targetDispatch",
  // events.getEventListeners and events.listenerCount over an EventTarget:
  // Node's receiver errors.
  "event.targetListeners",
  "event.targetListenersDyn",
  "event.targetListenerCount",
  "event.targetListenerCountDyn",
  "event.targetGetMax",
  "event.targetSetMax",
  // events.on validates its options, reads the receiver's protocol and
  // registers listeners (a throwing 'newListener' listener runs inside).
  "event.on",
  "event.onEmitter",
  "events.onTyped",
  "event.call",
  // events.once over an EventTarget or a NodeEventTarget: the receiver's own
  // once()/addEventListener() runs, and a bad receiver or signal throws
  // Node's ERR_INVALID_ARG_TYPE (the promise's rejection is a value).
  "event.onceTarget",
  "event.onceTargetSignal",
  "blob.new",
  "blob.fileNew",
  "blob.slice",
  "wasm.compile",
  "wasm.validate",
  "wasm.instantiate",
  "wasm.moduleNew",
  "wasm.instanceNew",
  "wasm.errorNew",
  "wasm.memoryNew",
  "wasm.tableNew",
  "wasm.globalNew",
  "wasm.withoutNew",
  "wasm.moduleImports",
  "wasm.moduleExports",
  "wasm.moduleCustomSections",
  "wasm.valueOf",
  "events.addAbortListener",
  "fetch.streamNew",
  "fetch.streamFrom",
  "num.toFixed",
  "num.toPrecision",
  "num.toExponentialDigits",
  "str.localeCase",
  // The default-locale ICU formatters throw an Error when the ICU data file
  // is missing (scr_intl.c).
  "icu.numFormatDefault",
  "icu.dateLocaleString",
  "icu.dateLocaleTimeString",
  // The formatter constructors read the options object (a getter or a
  // proxy trap may run) and raise ECMA-402's RangeError and TypeError;
  // format raises RangeError for a time value out of range.
  "icu.numberFormatNew",
  "icu.numberFormatFormat",
  "icu.numberFormatFormatDyn",
];

const MAY_THROW_LIB_FNS_PART_2: readonly IrLibFn[] = [
  // node:cluster validates its env argument and refuses setupPrimary in a
  // worker process (ERR_WORKER_INIT_FAILED).
  "cluster.fork",
  "cluster.setup",
  "cluster.on",
  "cluster.off",
  "cluster.disconnect",
  "icu.dateTimeFormatFormatDyn",
  "icu.numToLocaleString",
  "icu.dateTimeFormatNew",
  "icu.dateTimeFormatFormat",
  "icu.dateToLocale",
  "num.toStringRadix",
  "num.toStringRadixF64",
  "insp.jsonDyn",
  "insp.jsonDynValue",
  // The runtime formatter calls toString, valueOf and toJSON, and refuses
  // renderings it has no lowering for.
  "insp.format",
  "insp.formatSnapshot",
  "insp.formatList",
  "insp.formatWithOptions",
  "insp.inspect",
  "insp.inspectDir",
  // A getter the walk invokes renders its result, and that rendering can
  // refuse (SC2020) exactly like the walk's own.
  "insp.accessorValue",
  // The options object reads the caller's options (getters included), and
  // the checked-dynamic walk calls custom inspect functions.
  "insp.customOptions",
  "insp.customResult",
  // A checked-dynamic value the inspector does not render (a promise, a
  // URL, a RegExp) throws the 'not supported yet' Error.
  "insp.dyn",
  "insp.dynS",
  // %s converts its argument with String(value) or renders it, and both can
  // throw (a program conversion, an inspect refusal): the NULL answer with
  // the exception pending must not be read as text.
  "insp.dynFormatS",
  // %o's showHidden walk refuses the kinds whose hidden entries it cannot
  // render.
  "insp.dynHidden",
  // diagnostics_channel: publish runs subscribers synchronously (a throw
  // propagates — the documented divergence from triggerUncaughtException);
  // the subscribe/unsubscribe forms throw Node's ERR_INVALID_ARG_TYPE for
  // non-function subscribers.
  // async_hooks.createHook validates its callbacks (ERR_ASYNC_CALLBACK).
  "ah.createHook",
  "ah.createHookParts",
  // diagnostics_channel: the subscribe/unsubscribe forms validate the name
  // and the subscriber in the runtime (Node's ERR_INVALID_ARG_TYPE), and
  // the bind-store/run-stores calls run program code.
  // trace_events.createTracing validates its options object and its
  // categories array.
  "te.createTracing",
  "dc.subscribe",
  "dc.unsubscribe",
  // The name validators raise Node's ERR_INVALID_ARG_TYPE, and a symbol
  // name fences with SC2020.
  "dc.channel",
  "dc.tracingChannel",
  /** The collection form validates each event member (Node's
   * "must be an instance of Channel"), so a value asserted past the type
   * raises here rather than indexing the channel table with it. */
  "dc.tracingChannelOf",
  "dc.chanSubscribe",
  "dc.chanUnsubscribe",
  "dc.tcSubscribe",
  "dc.tcUnsubscribe",
  "dc.tcTraceSync",
  "dc.tcTraceCallback",
  "dc.tcTracePromise",
  "process.onUncaughtException",
  "process.offUncaughtException",
  "process.prependUncaughtException",
  "process.onSignal",
  "process.offSignal",
  "process.prependSignal",
  "process.onBeforeExit",
  "process.offBeforeExit",
  "process.prependBeforeExit",
  "process.onUnhandledRejection",
  "process.onRejectionHandled",
  "process.onMultipleResolves",
  "process.offMultipleResolves",
  "async.awaitDyn",
  "als.run",
  "als.exitRun",
  "als.newOptions",
  "als.bindCallbackDyn",
  // AsyncResource: the constructor's type/options checks, the traced call
  // itself, and the bound function's argument check all throw.
  "ar.new",
  "ar.runInScope",
  "ar.bind",
  "ar.bindStatic",
  "dc.chanBindStore",
  "dc.chanRunStores",
  "http.resWriteHeadDyn",
  "http.resWriteHeadObject",
  "http.resSetHeader",
  "http.resSetHeaderDyn",
  "http.resRemoveHeader",
  "http.clientSignal",
  "http.clientSignalCheck",
  "http.reqSignal",
  "http.clientProtocolCheck",
  "http.clientProtocolCheckAgent",
  "http.serverMaxHeaderSize",
  "http.clientMaxHeaderSize",
  "http.resAppendHeader",
  "http.resWriteContinue",
  "http.resWriteProcessing",
  "http.resWriteEarlyHints",
  // writeInformation validates the status (ERR_OUT_OF_RANGE, and
  // ERR_HTTP_INVALID_STATUS_CODE for 101), the state
  // (ERR_HTTP_HEADERS_SENT) and every header name and value.
  "http.resWriteInformation",
  "http.resWriteContinueCb",
  "http.resOnWriteFlush",
  "http.resWriteProcessingCb",
  "http.resWriteEarlyHintsCb",
  "http.validateHeaderName",
  "http.validateHeaderValue",
  "http.setMaxIdleParsers",
  "http.setGlobalProxyFromEnv",
  "http.agentCreateConnectionCheck",
  // 'prefinish' on the HTTP/2 compatibility response is refused by name.
  "http.resOnPrefinish",
  "http.serverTimeoutGet",
  "http.serverTimeoutOptionSet",
  "http.serverHeadersTimeoutDefault",
  "http.serverConnectionsCheckingInterval",
  "http.serverRejectNonStandardBodyWrites",
  "net.sockSetEncoding",
  "net.sockSetEncodingDyn",
  // setKeepAlive's positional coercions and its object form run ToNumber
  // (~~), which calls a value's valueOf/toString.
  "net.sockSetKeepAlive",
  "http.reqSetEncoding",
  // req.signal builds the message's AbortController on first read and aborts
  // it when the message is already gone; both go through the signal unit.
  "http.reqSignal",
  "fs.readFileSyncBuf",
  "fs.readFileSyncDyn",
  "fs.statSyncDyn",
  "fs.lstatSyncDyn",
  "fs.fstatSyncDyn",
  "fs.readFileSyncStrOpts",
  "fs.readFileSyncBytesOpts",
  "fs.readFileEncoded",
  "fs.readFdEncoded",
  // tls/https runtime options records: the walks throw the catchable
  // runtime fence for out-of-bounds members and non-PEM values (the
  // divergence-66 stance).
  "tls.pemDyn",
  "tls.createServerDyn",
  "tls.createSecureContextDyn",
  "tls.caCertsChk",
  // tls.checkServerIdentity can throw ERR_TLS_CERT_ALTNAME_FORMAT from its
  // alt-name parser.
  "tls.checkServerIdentity",
  "tls.createServerDynCb",
  "https.createServerDyn",
  "https.createServerDynCb",
  "http2.createSecureServerDyn",
  "http2.createSecureServerDynCb",
  "tls.connect",
  "tls.connectCb",
  // tls.connect(path...) dials and validates like the other forms.
  "tls.connectPath",
  "tls.wrapSocket",
  "tls.wrapSocketCtx",
  // addContext's ERR_TLS_REQUIRED_SERVER_NAME and the context's errors,
  // setSecureContext's validateObject.
  "tls.serverAddContext",
  "tls.serverAddContextCtx",
  "tls.serverSetSecureContext",
  // The CA-store surface: an unknown getCACertificates type throws
  // Node's ERR_INVALID_ARG_VALUE TypeError; setDefaultCACertificates
  // throws Node's ERR_CRYPTO_OPERATION_FAILED on a certificate-free
  // array.
  "tlsca.get",
  "tlsca.set",
  // EventEmitter dispatch runs user listeners synchronously (emit), and
  // the mutation forms fire the newListener/removeListener meta events —
  // any of them can throw. emitError additionally THROWS its payload when
  // 'error' has no listener, Node's unhandled-'error' contract.
  "emitter.emit",
  "emitter.emitFlex",
  "emitter.emitAny",
  "emitter.emitErrorValue",
  "emitter.emitMixed",
  "emitter.hasDyn",
  "emitter.listenersDyn",
  "emitter.emitError",
  "emitter.on",
  "emitter.onNamed",
  "emitter.off",
  "emitter.checkListener",
  "emitter.onDyn",
  "emitter.onFlex",
  "emitter.onAny",
  "emitter.offDyn",
  "emitter.onData",
  "emitter.onDataDyn",
  "emitter.emitData",
  // The event name's ToPropertyKey conversion runs an object name's own
  // toString/valueOf (user code, which may throw), and an object that
  // answers no primitive throws the spec's TypeError.
  "emitter.nameDyn",
  "readable.nextChunk",
  "readable.nextChunkDyn",
  // The checked-dynamic chunk forms throw Node's ERR_INVALID_ARG_TYPE
  // chunk TypeError on a non-string/Buffer dyn kind.
  // socket.setTimeout's msecs check (ERR_OUT_OF_RANGE).
  "net.sockSetTimeout",
  "net.sockSetTimeoutCb",
  // getCipher throws the "not supported yet" error for a suite without a
  // known OpenSSL name.
  "tls.sockGetCipher",
  // exportKeyingMaterial throws Node's validation ladder (ERR_OUT_OF_RANGE,
  // ERR_INVALID_ARG_TYPE) and the TLS state error.
  "tls.sockExportKeyingMaterial",
  "net.sockWriteDyn",
  "net.sockEndDyn",
  "http.resWriteDyn",
  "http.resEndDyn",
  // write/end with extra arguments throw Node's chunk TypeError, the
  // unknown-encoding error, and run the flush callback (user code).
  "http.resWriteArgs",
  "http.resEndArgs",
  "http.clientWriteArgs",
  "http.clientEndArgs",
  // setHeaders walks the argument (a Map's entries) and throws Node's
  // ERR_INVALID_ARG_TYPE for anything else, ERR_HTTP_HEADERS_SENT once the
  // head is out, and the header name/value checks. pipe() emits
  // ERR_STREAM_CANNOT_PIPE, whose unhandled 'error' is the throw at the
  // call.
  "http.resSetHeaders",
  "http.resPipe",
  "http.clientPipe",
  "http.resAddTrailers",
  "http.resFlushHeaders",
  "http.resUncork",
  "http.resWriteHead",
  "http.resWriteHeadN",
  "http.resWriteHeadPairs",
  "http.resWrite",
  "http.resWriteBytes",
  "http.resEnd",
  "http.resEndStr",
  "http.resEndBytes",
  "http.clientWriteDyn",
  "http.clientEndDyn",
  "http.clientAddTrailers",
  // setHeader and removeHeader throw ERR_HTTP_HEADERS_SENT once the head is
  // out (flushHeaders(), a first write, or an Expect header at
  // construction), and setHeader throws Node's name and value checks.
  "http.clientSetHeader",
  "http.clientSetHeaderDyn",
  "http.clientAppendHeaderDyn",
  "http.clientRemoveHeader",
  "http.clientFlushHeaders",
  "http.clientUncork",
  "http.clientWrite",
  "http.clientWriteBytes",
  "http.clientEnd",
  "http.clientEndStr",
  "http.clientEndBytes",
  // The URL-string client form throws catchably on an unparsable input
  // ("Invalid URL") or a non-http scheme (ERR_INVALID_PROTOCOL).
  "http.requestUrl",
  "http.requestUrlCb",
  // The runtime options walk throws Node's validation errors and the
  // fence for documented options it does not implement.
  "http.requestDyn",
  "http.requestDynCb",
  "https.requestDyn",
  "https.requestDynCb",
  "https.requestFnDyn",
  "https.requestFnDynCb",
  // The URL+options form adds the URL parse's throws to that walk's.
  "http.requestUrlDyn",
  "http.requestUrlDynCb",
  "https.requestUrlDyn",
  "https.requestUrlDynCb",
  // address() of a Unix-socket server read as the AddressInfo record.
  "net.serverAddressCheck",
  // The h2 client's throwing entries: connect on a bad/non-http
  // authority (ERR_INVALID_URL / ERR_INVALID_PROTOCOL), request on a
  // closed/destroyed session (ERR_HTTP2_INVALID_SESSION), setEncoding on
  // an unknown name (ERR_UNKNOWN_ENCODING). Event fires run user code
  // synchronously (the stream-operations stance below), so the data/
  // write paths that can fire inline join too.
  "http2.connect",
  "http2.connectCb",
  "http2.sessionRequest",
  "http2.streamSetEncoding",
  // Settings are validated (ERR_HTTP2_INVALID_SETTING_VALUE), a ping's
  // payload and a destroyed session are refused, and a dynamic listener
  // that is not a function is a TypeError.
  "http2.sessionSettings",
  "http2.sessionSettingsCb0",
  "http2.sessionSettingsDynCb",
  "http2.sessionOnSettingsDyn",
  "http2.sessionPing",
  "http2.sessionPingPayload",
  "http2.getPackedSettings",
  "http2.getUnpackedSettings",
  "http2.streamRespondWait",
  "http2.streamSendTrailers",
  "http2.streamRespondWithFile",
  "http2.streamRespondWithFD",
  "http2.streamAdditionalHeaders",
  "http2.responseWriteInformation",
  "http2.streamRespond",
  "http2.streamWrite",
  "http2.streamWriteBytes",
  "http2.streamEnd",
  "http2.streamEndStr",
  "http2.streamEndBytes",
  "emitter.removeAll",
  // Stream operations run user code synchronously (option callbacks and
  // 'data'/'drain'/... listeners on the caller's stack, like emit) — any
  // of them may leave a listener's throw pending. destroy with no 'error'
  // listener throws the payload itself (the emitter.emitError contract).
  // The dyn-options constructors walk the record at runtime: a consumed-
  // but-unlowered option (objectMode, construct, ...) throws the compile
  // fence's runtime twin; a bad encoding throws ERR_UNKNOWN_ENCODING.
  "stream.finished",
  "stream.finishedDyn",
  "stream.pipeline",
  "stream.pipelineDyn",
  "stream.compose",
  "sp.finished",
  // Destroys the stream, which runs a destroy hook of the program's; the
  // hook's error rejects the returned promise.
  "stream.asyncDispose",
  "sp.pipeline",
  "sp.pipelineStages",
  "sp.pipelineStagesOpts",
  "stream.pipelineStages",
  "stream.composeStages",
  "stream.pipelineStagesDyn",
  "sc.text",
  "sc.json",
  "sc.buffer",
  "sc.bytes",
  "sc.blob",
  "sc.arrayBuffer",
  "readable.newDyn",
  "writable.newDyn",
  "duplex.newDyn",
  "transform.newDyn",
  "passthrough.newDyn",
  "readable.initDyn",
  "stream.checkEncodingOption",
  "writable.initDyn",
  "duplex.initDyn",
  "transform.initDyn",
  "passthrough.initDyn",
  "readable.push",
  "readable.pushStr",
  "readable.pushStrEnc",
  "readable.pushNull",
  "readable.pushU",
  "readable.pushDyn",
  "readable.unshift",
  "readable.unshiftDyn",
  "readable.unshiftStr",
  "readable.read",
  "readable.readDyn",
  "stream.onDyn",
  "readable.resume",
  "readable.pipe",
  "readable.pipeGeneral",
  "readable.unpipe",
  "writable.write",
  "writable.writeStr",
  "writable.writeU",
  "writable.writeDyn",
  "writable.writeEnc",
  "writable.writeEcb",
  "writable.end",
  "writable.endEcb",
  "writable.uncork",
  "writable.setDefaultEncoding",
  "stream.duplexFromGen",
  "stream.duplexFromDyn",
  "stream.duplexFromPromise",
  "stream.duplexFromAsyncFn",
  "stream.duplexFromGenSignal",
  "stream.duplexFromAsyncFnSignal",
  "fetch.readableFromWeb",
];

const MAY_THROW_LIB_FNS_PART_3: readonly IrLibFn[] = [
  "stream.setDefaultHwm",
  "webstream.toWebReadableOpts",
  "webstream.toWebReadableDyn",
  "webstream.toWebReadableDynOpts",
  "webstream.toWebDuplexDyn",
  // The option walk behind duplexPair throws the not-supported Error for an
  // option it cannot apply; wrap refuses a stream that already carries native
  // state and wrapDyn a value that is not a native readable stream.
  "stream.duplexPair",
  "stream.wrap",
  "stream.wrapDyn",
  "webstream.writableFromWeb",
  "webstream.writableFromWebOpts",
  "webstream.duplexFromWeb",
  "webstream.duplexFromWebOpts",
  "stream.destroy",
  "stream.destroyErr",
  "stream.iteratorClose",
  // setMaxListeners(n) throws Node's ERR_OUT_OF_RANGE RangeError for
  // negative/NaN arguments; the static form's default-max write validates
  // identically (Node's validateNumber(n, "setMaxListeners", 0)).
  "emitter.setMax",
  "emitter.setDefaultMax",
  // The createConnection request forms run the caller's dialer closure
  // synchronously — a throw there propagates like Node's.
  "http.requestConn",
  "http.requestConnCb",
  "process.kill",
  "process.killNum",
  // The dynamic pid/signal forms: Node's loose pid guard, unknown-signal
  // TypeError, and the ToNumber/ToString conversion errors.
  "process.killSigDyn",
  "process.killDyn",
  // A replaced process.stdout/stderr.write runs JavaScript: what it throws
  // propagates from the call.
  "process.stdioWriteStr",
  "process.setExitCode",
  "process.setExitCodeTracked",
  "process.setExitCodeDyn",
  "process.setExitCodeDynTracked",
  // process.env's proxy ToStrings dynamic keys and values, so a Symbol or a
  // toString that throws throws from the read/write.
  "process.envGetDyn",
  "process.envSetDyn",
  "process.envSetKeyDyn",
  "process.envUnsetDyn",
  // process.title = expr ToStrings (a Symbol throws).
  "process.setTitleDyn",
  // Node's argument grammar throws ERR_INVALID_ARG_TYPE at the call.
  "process.emitWarning",
  // A listener the emit reaches may throw; the exception is the call's.
  "process.emit",
  "process.emitError",
  // cpuUsage(prev)'s field validation: negative/non-finite prev fields
  // throw Node's ERR_INVALID_ARG_VALUE RangeError, catchably.
  "process.cpuPrevValidate",
  // The dynamic prev path runs the same validation on any value.
  "process.cpuDynPrepare",
  // An unreadable resident set throws Node's uv_resident_set_memory
  // error; the Windows credential members throw the missing-member
  // TypeError.
  "process.memoryUsageTake",
  "process.rss",
  "process.geteuid",
  "process.getegid",
  "process.getgroups",
  "process.setuid",
  "process.seteuid",
  "process.setgid",
  "process.setegid",
  "process.setgroups",
  "process.initgroups",
  "process.setUncaughtCapture",
  "process.setDebugPort",
  "process.setSourceMapsEnabled",
  "process.ref",
  "process.unref",
  // perf_hooks user timing: Node's argument validation, the unset-mark
  // SyntaxError DOMException, and the detail's DataCloneError.
  "perf.mark",
  // markResourceTiming's argument reads and clearResourceTimings /
  // setResourceTimingBufferSize validation.
  "perf.resourceMark",
  "perf.timerify",
  // createSlidingWindowHistogram's options and record forms validate, and a
  // snapshot can fail to allocate.
  "perf.slidingNew",
  "perf.slidingRecord",
  "perf.slidingRecordBig",
  "perf.slidingSnapshot",
  "perf.resourceClear",
  "perf.resourceBufferSize",
  "perf.measure",
  "perf.entries",
  "perf.clearMarks",
  "perf.clearMeasures",
  // new PerformanceMark and the observer family: Node's argument,
  // receiver and observation-mode validation all throw catchably.
  "perf.markNew",
  "perf.observerNew",
  "perf.observerObserve",
  "perf.observerDisconnect",
  "perf.observerTake",
  "perf.listEntries",
  // monitorEventLoopDelay's resolution: Node's ERR_OUT_OF_RANGE.
  "perf.eldNew",
  // Histogram inference validates the confidence option and the other
  // histogram before the readings are computed.
  "perf.histoConfidence",
  "perf.histoPercentileArg",
  "perf.histoOther",
  // createHistogram's options and RecordableHistogram's record forms: Node's
  // ERR_OUT_OF_RANGE / ERR_INVALID_ARG_TYPE validation.
  "perf.histoNew",
  "perf.histoBucketArg",
  "perf.histoLinearBucketsCount",
  "perf.histoLogBucketsCount",
  "perf.histoRecord",
  "perf.histoRecordBig",
  "perf.histoRecordCorrected",
  // add/subtract reject a non-RecordableHistogram argument.
  "perf.histoAdd",
  "perf.histoSubtract",
  // The comparisons reject an `other` that is not a Histogram with Node's
  // ERR_INVALID_ARG_TYPE.
  "perf.histoKsTest",
  "perf.histoCohensD",
  "perf.histoCliffsD",
  "perf.histoMannWhitneyU",
  "perf.histoMannWhitneyZ",
  "perf.histoMannWhitneyP",
  // burnRate validates its SLO target (Node's ERR_INVALID_ARG_TYPE /
  // ERR_OUT_OF_RANGE).
  "perf.histoBurnRate",
  // The bucket views validate their arguments (stepSize, firstBucket, base
  // and percentilesAt's array) before iterating.
  "perf.histoLinearView",
  "perf.histoLogView",
  "perf.histoPercentilesAtView",
  // Non-TTY stdin: Node's stdin has no setRawMode member, so the call is
  // the exact catchable TypeError.
  "process.stdinSetRawMode",
  // read(size) above the 1 GiB high-water mark: Node's ERR_OUT_OF_RANGE.
  "stdin.read",
  // The unguarded h2-only stream call: always throws Node's TypeError.
  "http2.streamUndefCall",
  "http.reqH2StreamOrThrow",
  // A read of a declare-d const nothing defines: always throws Node's
  // catchable ReferenceError.
  "global.undefRead",
  // A read of an undeclared name the global object does not have: Node's
  // catchable ReferenceError.
  "global.bindingRead",
  // The compiler-resolved Node-parity throw: always throws, catchably.
  "error.nodeThrow",
  // An accessor over an error's own name or message runs user code.
  "error.accessorGet",
  "error.accessorSet",
  // USVString coercion runs user toString/valueOf — throws propagate.
  "dyn.toStringCoerce",
  "dyn.stringConstructor",
  "dyn.propertyKey",
  "dyn.toNumeric",
  "dyn.increment",
  "dyn.negate",
  // The dynamic-tier operators run the same coercions (scr_js_value.c), and
  // js.toF64 throws dynCheck's TypeError for a non-number.
  "js.toF64",
  "js.add",
  "js.arithmetic",
  "js.bitwise",
  "js.compare",
  "js.toNumeric",
  "js.increment",
  "js.negate",
  "js.toNumberCoerce",
  // Error messages use the same coercion protocol before installing cause.
  "error.newOptions",
  "error.captureStackTrace",
  "error.ctorOptions",
  "error.newAggregate",
  "error.newSuppressed",
  "error.toString",
  "error.stack",
  "error.cause",
  "error.setCause",
  "error.assign",
  "error.deleteCause",
  "dyn.objectTag",
  // Numeric coercion runs user valueOf/toString — throws propagate.
  "dyn.numberConstructor",
  "dyn.bigintConstructor",
  "dyn.toNumberCoerce",
  "dyn.add",
  "dyn.arithmetic",
  "dyn.compare",
  "dyn.bitwise",
  "dyn.proxyNew",
  "dyn.classBasePrototype",
  "dyn.classInherit",
  "dyn.classSuper",
  // Promise.<s>.call(C, …) validates its `this` and runs C's constructor and
  // resolve — every throw (a non-object this, a non-constructor, a throwing
  // executor or resolve) rejects the capability or propagates.
  "promise.genericStatic",
  "dyn.hasKey",
  "dyn.in",
  "child.kill",
  // child.dispose sends SIGTERM through the same kill path; a Node-island
  // child's kill may emit the synchronous 'error' that path can raise.
  "child.dispose",
  // The caller's lookup runs synchronously inside the connect call — a
  // throw there propagates like Node's.
  "net.connectLookup",
  "net.connectLookupDyn",
  "cp.execSync",
  // The unencoded form throws the same spawn, maxBuffer and command errors.
  "cp.execSyncBytes",
  "cp.execCapture",
  // validateMaxBuffer's ERR_OUT_OF_RANGE, before the capturing call.
  "cp.maxBuffer",
  // exec/execFile's option checks: validateTimeout's ERR_OUT_OF_RANGE and
  // sanitizeKillSignal's ERR_UNKNOWN_SIGNAL, before the child starts.
  "cp.execFileOpts",
  // spawn's own: the same validateTimeout and sanitizeKillSignal, plus
  // validateAbortSignal's ERR_INVALID_ARG_TYPE, before the child starts.
  "cp.spawnArmed",
  // The client request constructors validate the method token
  // synchronously (Node's ClientRequest ctor throw:
  // ERR_INVALID_HTTP_TOKEN).
  "http.request",
  "http.requestCb",
  "http.requestConn",
  "http.requestConnCb",
  // The agent rows add the runtime agent-value gates (a non-Agent value
  // is Node's ERR_INVALID_ARG_TYPE); agentNew's keepAlive: true throws
  // the named pooling fence.
  "http.agentNew",
  "http.requestAgent",
  "http.requestAgentCb",
  "https.requestAgent",
  "https.requestAgentCb",
  "https.request",
  "https.requestCb",
  // The URL-string form's parse, exactly http.requestUrl's (an
  // unparsable input, or a scheme that is not https).
  "https.requestUrl",
  "https.requestUrlCb",
  "https.requestFn",
  "https.requestFnCb",
  "rl.question",
  "rl.questionDyn",
  "rl.checkOptions",
  "rl.checkCompleter",
  "readable.fromArr",
  "readable.fromDyn",
  "readable.fromIter",
  "readable.fromAsyncIter",
  "readable.fromGen",
  "readable.fromAsyncGen",
  "readable.opMap",
  "readable.opFilter",
  "readable.opFlatMap",
  "readable.opFlatMapAsyncGen",
  "readable.opFlatMapSyncGen",
  "readable.opDrop",
  "readable.opTake",
  "rl.createSignal",
  "stream.finishedOpts",
  "stream.finishedOptsSignal",
  "stream.addAbortSignal",
  "stream.addAbortSignalFn",
  "rl.pause",
  "rl.resume",
  "rl.prompt",
  "rl.promptWith",
  "rl.setPromptDyn",
  "rl.getPrompt",
  "rl.getPromptDyn",
  "rl.cursorPos",
  "rl.inputFromDyn",
  "rl.outputFromDyn",
  "rl.write",
  "rl.writeKey",
  "rl.cursor",
  "rl.seq",
  "rl.uiOpenStream",
  "rl.uiCursorTo",
  "rl.uiMoveCursor",
  "rl.uiClearLine",

  "json.parse",
  "json.parseReviver",
  "json.stringifyReplacer",
  "json.stringifyValue",
  "date.nativeNew",
  "date.nativeNewFields",
  "date.nativeNewValue",
  "date.argumentsTime",
  "date.checkedValue",
  "util.parseArgs",
  "util.getCallSites",
  "util.parseEnv",
  "util.getSystemErrorName",
  "util.getSystemErrorMessage",
  "util.stripVTControlCharacters",
  "util.isDeepStrictEqual",
  "util.styleText",
  "util.toUSVString",
  "util.inherits",
  "util.inheritsPrototype",
  "util.deprecate",
  "util.extend",
  "util.signalExitCode",
  "util.diff",
  // Any non-promise argument throws ERR_INVALID_ARG_TYPE.
  "util.markPromiseAsHandled",
  // Any non-signal argument throws ERR_INVALID_ARG_TYPE.
  "util.transferableAbortSignal",
  "util.debounce",
  "util.throttle",
  "mime.typeNew",
  "mime.typeParse",
  // node:sqlite opens (or validates) a connection; every option it reads
  // can refuse the call, as can sqlite.backup's arguments.
  "sqlite.dbNew",
  "sqlite.backup",
  "util.callbackify",
  "util.promisifyDyn",
  // The typed promisify's custom protocol: a truthy non-function throws
  // ERR_INVALID_ARG_TYPE, and defining the key can throw on a non-extensible
  // function.
  "util.promisifyCustom",
  "util.promisifyMark",
  "util.debuglog",
  // The URI codecs throw the spec's URIError: decoding on bad hex/invalid
  // UTF-8 octets, encoding (and querystring.escape) on a lone surrogate.
  "str.decodeUriComponent",
  "str.decodeUri",
  "str.encodeUriComponent",
  "str.encodeUri",
  "qs.escape",
  "qs.escapeValue",
  "qs.parseCustom",
  "qs.stringifyCustom",
  "qs.separator",
  "qs.stringify",
  // node:punycode's RangeErrors (encode/toASCII only past 32-bit deltas)
  // and String.fromCodePoint's for ucs2.encode.
  "punycode.decode",
  "punycode.encode",
  "punycode.toASCII",
  "punycode.toUnicode",
  "punycode.ucs2Encode",
  // node:sea's asset readers always throw Node's coded error.
  "sea.getAsset",
  "sea.getRawAsset",
  "sea.getAssetAsBlob",
  "sea.getAssetKeys",
  // The base64 globals: atob/btoa throw the catchable DOMException
  // InvalidCharacterError on malformed input; the zero-argument form
  // always throws Node's TypeError [ERR_MISSING_ARGS].
  "str.atob",
  "str.btoa",
  "str.b64Missing",
  // queueMicrotask's checked-dynamic form throws ERR_INVALID_ARG_TYPE
  // synchronously on a non-function argument (the closure form never
  // throws — the callback's own throw surfaces at drain, uncaught).
  "timers.queueMicrotaskDyn",
  // the timer callback gate: a non-function throws ERR_INVALID_ARG_TYPE
  // synchronously (Node validates before anything schedules)
  "timers.checkCallback",
  // structuredClone: option validation throws Node's TypeErrors,
  // functions/handles the spec's DataCloneError, cycles the scriptc
  // fence; the zero-argument form always throws ERR_MISSING_ARGS. The
  // DOMException clone shares the option validation.
  "dyn.structuredClone",
  "dyn.declAdopt",
  "dyn.cloneMissing",
  "dyn.cloneTransferFail",
  "dyn.cloneTransferFailWith",
  // the dyn Object walks throw on null/undefined receivers
  "dyn.objKeys",
  "dyn.forInKeys",
  "dyn.forInKeyStrings",
  "dyn.objKeyStrings",
  "dyn.objEntryPairs",
  "dyn.hasOwn",
  "dyn.propertyIsEnumerable",
  // Object.prototype.isPrototypeOf: ToObject throws on a nullish receiver,
  // and reading the argument's prototype chain can throw.
  "dyn.isPrototypeOf",
  "dyn.assign",
  "dyn.copyDataProperties",
  "dyn.objectRest",
  // variadic Object.assign: spread flattening throws V8's spread-call
  // TypeErrors; the final copy throws ToObject on a nullish target
  "dyn.packPushSpread",
  "dyn.packPushSpreadIter",
  "dyn.assignAll",
  "dyn.objCreate",
  "dyn.objCreateWithProperties",
  "dyn.getPrototype",
  "dyn.classTestPrototype",
];

const MAY_THROW_LIB_FNS_PART_4: readonly IrLibFn[] = [
  "dyn.setPrototype",
  // ES2025 Set compositions run the set-like protocol: reading and calling
  // `size`/`has`/`keys` can throw, and so can a user `has` or iterator.
  "dyn.setCombine",
  // forEach with a callback that is not statically a function throws Node's
  // `<value> is not a function`.
  "dyn.collectionForEach",
  // a proxy in the prototype chain can throw
  "dyn.collectionGetPrototype",
  // a proxy in the prototype chain can throw
  "dyn.builtinInstanceOf",
  "dyn.functionInstanceOf",
  "dyn.getOwnPropertyNames",
  "dyn.ownKeys",
  "dyn.getOwnPropertySymbols",
  "dyn.getOwnPropertyDescriptors",
  "dyn.preventExtensions",
  "dyn.isExtensible",
  "dyn.seal",
  "dyn.isSealed",
  // an unmodeled integrity kind (a native handle, a promise) refuses
  "dyn.isExtensibleQuery",
  "dyn.isSealedQuery",
  "dyn.objValues",
  "dyn.objValueList",
  "dyn.objEntries",
  "error.domClone",
  // new RegExp compiles the pattern eagerly: an invalid pattern or flag
  // throws Node's catchable SyntaxError at construction.
  "regex.new",
  "regex.resetLastIndex",
  "regex.newChecked",
  "regex.callChecked",
  "regex.replaceCallback",
  "dyn.keySet",
  "dyn.fnOwnSet",
  "dyn.keySetComputed",
  "process.builtinId",
  "process.builtinModule",
  "process.builtinObject",
  "process.builtinUnsupported",
  "module.requireComputed",
  "module.resolveComputed",
  "fs.callbackValue",
  "fs.callbackCall",
  "dyn.keyDelete",
  "dyn.keyDeleteComputed",
  "dyn.primitiveDelete",
  "dyn.reflectDeleteProperty",
  "dyn.reflectHasTarget",
  "dyn.reflectGetPrototypeTarget",
  "dyn.hasKeyComputed",
  // `… in globalThis` over a name the runtime does not provide throws
  "dyn.globalHas",
  "dyn.hasOwnComputed",
  "dyn.propertyIsEnumerableComputed",
  // the destructuring pack throws V8's TypeError on non-iterable dyn kinds
  "dyn.iterPack",
  // ToNumber of each element can run valueOf
  "dyn.mathFold",
  "dyn.mathFoldMany",
  "dyn.destructureRest",
  "dyn.arrayFromIterator",
  "dyn.iterator",
  "dyn.asyncIteratorOpen",
  "dyn.iteratorResult",
  "dyn.iteratorStep",
  "dyn.mapSeedEntries",
  "dyn.mapSeedEntry",
  "dyn.freeze",
  "dyn.isFrozen",
  "class.defineField",
  "class.throwReadOnly",
  "class.throwNotExtensible",
  "record.throwFrozen",
  // The kept-source read runs the source view's accessor, which can throw
  // (record-sources.ts carries the read into a record width copy).
  "record.sourceGet",
  // `delete r.k` of a key the record's kept source holds throws Node's
  // TypeError on a frozen record in strict code.
  "record.sourceDelete",
  "dyn.toString",
  "dyn.valueOf",
  // Primitive wrapper objects (scr_js_wrapper.c): the conversions run
  // user hooks and the guard refuses.
  "wrapper.new",
  // %Iterator% (scr_js_iterator.c): construction always throws, and
  // Iterator.from runs the value's iterator method and next getter.
  "iterator.construct",
  "iterator.from",
  "iterator.instanceOf",
  "wrapper.toObject",
  "wrapper.objectTag",
  "wrapper.thisString",
  "wrapper.guard",
  "wrapper.guardList",
  "string.fromCodePoint",
  "dyn.defineProps",
  "dyn.definePrototypeProps",
  "dyn.bagGet",
  "dyn.bagSet",
  "dyn.defineProperty",
  // The same operations for a descriptor built by an expression; they throw
  // the same TypeErrors, and a getter on the descriptor can throw.
  "dyn.definePropsShapes",
  "dyn.definePropertyShapes",
  "dyn.objCreateWithPropertiesShapes",
  "dyn.getOwnPropertyDescriptor",
  "child.propsDefine",
  "child.propsDescriptor",
  "child.propsOnDyn",
  // Handle own-property tables: the graph-walker refusals, a handle used as
  // a descriptor, and Object.defineProperties throw.
  "handle.propsDefineProps",
  "handle.propsGuard",
  "handle.propsGuardList",
  "handle.propsCheck",
  "handle.propsGrant",
  "dyn.arrayProtoCall",
  "dyn.arrayLikeProtoCall",
  "process.chdir",
  "process.chdirDyn",
  // A worker's scr_process_abort raises Node's catchable
  // ERR_WORKER_UNSUPPORTED_OPERATION, which the program may catch; the main
  // thread settles stdout and raises SIGABRT, so the check after the call
  // never runs there.
  "process.abort",
  // The umask argument validators: parseFileMode's ERR_INVALID_ARG_VALUE for
  // a non-octal string and the ERR_INVALID_ARG_TYPE for other types, then
  // validateUint32's integer/range RangeErrors.
  "process.umaskDyn",
  "process.umaskChk",
  "os.getPriority",
  "os.setPriority",
  "os.getPriorityChk",
  "os.setPriorityChk",
  // Node's SystemError when the passwd entry of the effective uid answers
  // nothing: os.homedir() with HOME unset, and os.userInfo()'s fields, which
  // take their own lookup when the record's begin call did not run.
  "os.homedir",
  "os.userInfoBegin",
  "os.userName",
  "os.userShell",
  "os.userHomedir",
  "os.userNameBuf",
  "os.userShellBuf",
  "os.userHomedirBuf",
  "os.userUid",
  "os.userGid",
  // Pattern length TypeError, brace-sequence RangeError, and the
  // SyntaxError of a segment regex invalid under the u flag.
  "path.matchesGlob",
  "path.win32MatchesGlob",
  "process.umask",
  "process.loadEnvFile",
  "fs.realpathSync",
  "fs.realpathNativeSync",
  "fs.existsSyncValue",
  "fs.readFileSync",
  "fs.writeFileSync",
  "fs.appendFileSync",
  "fs.mkdirSync",
  "fs.rmSync",
  "fs.rmdirSync",
  "fs.readdirSync",
  "fs.readdirRecursiveSync",
  "fs.readdirTypesSync",
  "fs.readdirTypesRecursiveSync",
  "fsp.readdirTypesRecursive",
  "fs.readdirBytesSync",
  "fs.readdirEncodedSync",
  "fsp.readdirBytes",
  "fsp.readdirRecursive",
  "fsp.readdirEncoded",
  "fs.globSync",
  "fs.globTypesSync",
  "fs.callbackGlob",
  "fsp.globStrings",
  "fsp.globTypes",
  "url.new",
  "url.newBase",
  // ERR_INVALID_ARG_TYPE when the argument is not a Blob or File.
  "url.createObjectURL",
  "url.set",
  "url.setChecked",
  "url.fileURLToPathUrl",
  "fs.checkPath",
  "fs.checkReadEncoding",
  "url.fileURLToPathChecked",
  "url.fileURLToPathOptions",
  "url.fileURLToPathBuffer",
  "url.pathToFileURLChecked",
  "url.fileURLToPathStr",
  // The legacy API: validateString/urlObject ladders, ERR_INVALID_URL,
  // auth's URIError, and the domain pair's ERR_MISSING_ARGS.
  "url.legacyParse",
  "url.legacyFormat",
  "url.legacyResolve",
  "url.domainToASCII",
  "url.domainToUnicode",
  // ERR_INVALID_ARG_TYPE and the credentials' URIError.
  "url.toHttpOptions",
  // The win32-target flavor of pathToFileURL (same runtime entry point —
  // the bridge dispatches by the binary's platform): Node's win32 arm
  // raises ERR_INVALID_ARG_VALUE TypeErrors for malformed UNC inputs, so
  // only THIS flavor seeds may-throw — posix emission stays untouched.
  "url.pathToFileURLWin32",
  "url.pathToFileURLPlatform",
  // URLSearchParams from a string[][]: Node's ERR_INVALID_TUPLE TypeError
  // on a row that is not a [name, value] pair. The rest of the sp family
  // never throws.
  "sp.fromPairs",
  "sp.newChecked",
  "fs.statSync",
  "fs.statProbeSync",
  // The checked-dynamic Stats extraction: a value outside the Stats type
  // throws the checked conversion's TypeError.
  "fs.statsFromDyn",
  "fs.statsFromDynOpt",
  "crypto.randomBytesToString",
  "crypto.randomBytes",
  "crypto.hashDigestStr",
  "crypto.hashDigestBytes",
  "crypto.hashNew",
  "crypto.hashStream",
  "crypto.hashStreamPiped",
  "crypto.hmacNewStr",
  "crypto.hmacNewBytes",
  "crypto.hashUpdateStr",
  "crypto.hashUpdateBytes",
  "crypto.hmacUpdateStr",
  "crypto.hmacUpdateBytes",
  "crypto.hashCopy",
  "crypto.hashDigestString",
  "crypto.hashDigestBuffer",
  "crypto.hmacDigestString",
  "crypto.hmacDigestBuffer",
  "crypto.hashNewOpts",
  "crypto.hmacNewDyn",
  "crypto.macNewDyn",
  "crypto.secureHeapUsed",
  "crypto.hashCopyOpts",
  "crypto.hashUpdateEnc",
  "crypto.hmacUpdateEnc",
  "crypto.hashUpdateDyn",
  "crypto.hmacUpdateDyn",
  "crypto.hashDigestDyn",
  "crypto.hmacDigestDyn",
  "crypto.hashOneshot",
  // The checked-dynamic constructors and the callback pbkdf2 run Node's
  // argument validation and can raise catchable TypeErrors; the callback
  // form also runs program code.
  "crypto.hashNewAny",
  "crypto.hmacNewAny",
  "crypto.hashOneshotAny",
  "crypto.pbkdf2Any",
  "crypto.pbkdf2AnyCb",
  "crypto.hkdfAny",
  "crypto.hkdfAnyCb",
  "crypto.scryptAny",
  "crypto.scryptAnyCb",
  "crypto.timingSafeEqual",
  "crypto.timingSafeEqualDyn",
  "crypto.randomFill",
  "crypto.randomFillRest",
  "crypto.randomInt",
  "crypto.randomIntMax",
  "crypto.randomFillView",
  "crypto.randomFillViewRest",
  "crypto.getRandomValues",
  "crypto.getRandomValuesDyn",
  "crypto.randomFillSyncDyn",
  "crypto.randomFillCb",
  "crypto.randomFillCbDyn",
  "crypto.randomIntCb",
  "crypto.randomUUIDOpts",
  "crypto.createSecretKey",
  "crypto.generateKeySync",
  "crypto.generateKeyCb",
  "crypto.checkCallback",
  "crypto.keyObjectInput",
  "crypto.randomUUIDv7",
  "crypto.pbkdf2",
  "crypto.randomBytesCb",
  "crypto.randomBytesAny",
  "crypto.randomBytesAnyCb",
  "crypto.randomIntAny",
  "crypto.randomIntAnyCb",
  "crypto.pbkdf2Cb",
  "crypto.hkdf",
  "crypto.hkdfCb",
  "crypto.scrypt",
  "crypto.scryptCb",
  "buffer.resolveObjectURL",
  "buffer.concat",
  "buffer.concatLen",
  "buffer.concatDyn",
  "buffer.concatLenDyn",
  "buffer.concatLenDynOpt",
  "buffer.fromDyn",
  "buffer.fromStrChecked",
  "buffer.alloc",
  "buffer.allocUnsafe",
  "buffer.allocUnsafeSlow",
  "buffer.poolFromStr",
  "buffer.poolFromStrChecked",
  "buffer.poolFromBytes",
  "buffer.poolFromArray",
  "buffer.poolFromDyn",
  "buffer.poolFromDynRef",
  "buffer.poolFromDynOffset",
];

const MAY_THROW_LIB_FNS_PART_5: readonly IrLibFn[] = [
  "buffer.poolFromDynRange",
  "buffer.copyBytesFrom",
  // The checked-dynamic compare/equals validators: Node's argument
  // ladders throw ERR_INVALID_ARG_TYPE / ERR_OUT_OF_RANGE catchably.
  "buffer.compareChk",
  "bytes.equalsChk",
  "bytes.compareChk",
  "buffer.newStringFail",
  // Inherited and symbol-keyed Buffer.prototype members throw SC2020.
  "buffer.prototypeMember",
  "fs.toUnixTimestamp",
  "fs.existsChk",
  "fs.mkdtempChk",
  "fs.mkdtempSyncChk",
  "fs.readFileChk",
  "fs.opendirChk",
  "fs.watchFileChk",
  "fs.lchmodChk",
  "fs.lchmodSyncChk",
  "fsp.lchmodChk",
  "fsp.lchmod",
  "fs.readChk",
  "fs.streamOptsChk",
  "net.connectAttempt",
  "net.connectDyn",
  "net.connectDynCb",
  "net.socketNew",
  "net.sockConnect",
  "net.sockConnectCb",
  "net.setAutoSelTimeout",
  "net.setDefaultAutoSel",
  "error.argTypeThrow",
  "error.propTypeThrow",
  "array.foreignThrow",
  "emitter.setMaxChk",
  "emitter.setDefaultMaxChk",
  "fs.readFileSyncBytes",
  "fs.writeFileSyncBytes",
  "fs.writeFileSyncBytesFlags",
  "fs.writeFileSyncData",
  "fs.writeFileSyncDataFlags",
  "fs.writeFileSyncFd",
  "fs.writeFileSyncFdData",
  "fs.appendFileSyncBytes",
  "fs.appendFileSyncData",
  // The promise forms over the checked data run the synchronous write, which
  // raises for a data argument that is no string or view and for a failed
  // write, before the error is moved into the promise (as fsp.lchmodChk).
  "fsp.writeFileData",
  "fsp.appendFileData",
  "fsp.writeFileDataFlags",
  "fileHandle.writeFileData",
  // fchown(2) over the handle raises for a closed descriptor and for an id
  // outside Node's range.
  "fileHandle.chown",
  "zlib.inflateSync",
  "zlib.inflateRawSync",
  "zlib.gunzipSync",
  "zlib.unzipSync",
  "zlib.crc32",
  "zlib.streamNew",
  "zlib.syncOpts",
  "zlib.cbOpts",
  "zlib.syncOptsDyn",
  "zlib.cbOptsDyn",
  "zlib.infoSync",
  "zlib.infoCb",
  "zlib.infoSyncDyn",
  "zlib.infoCbDyn",
  "zlib.streamFlush",
  "zlib.streamFlushCb",
  "zlib.streamParams",
  "zlib.streamParamsCb",
  "zlib.streamReset",
  "date.toISOString",
  "date.toISOStringValue",
  "fs.mkdirRecursiveSync",
  "fs.rmOptsSync",
  "fs.rmRetrySync",
  "fs.mkdtempSync",
  "fs.accessSync",
  "fs.readFdSync",
  "fs.readFdSyncBytes",
  // dns.lookup and net.connect throw ERR_INVALID_ARG_VALUE for a host with
  // null bytes.
  "dns.lookup",
  // Node's argument checks (ERR_INVALID_ARG_TYPE/VALUE, ERR_SOCKET_BAD_PORT).
  "dns.lookupDyn",
  "dns.lookupService",
  "dns.promisesLookup",
  "dns.promisesLookupService",
  "dns.setDefaultResultOrder",
  // The stub resolver's checks (ERR_INVALID_ARG_TYPE/VALUE for a name,
  // callback, options or rrtype; ERR_INVALID_IP_ADDRESS and
  // ERR_SOCKET_BAD_PORT for setServers' entries; ERR_OUT_OF_RANGE for a
  // Resolver's options), and reverse's synchronous EINVAL for an address
  // c-ares cannot parse.
  "dns.resolveChk",
  "dns.resolvePromise",
  "dns.resolveRrChk",
  "dns.resolveRrPromise",
  "dns.resolverNew",
  "dns.setServers",
  "dns.promisesSetServers",
  "net.connect",
  "net.connectCb",
  "net.connectPath",
  "net.connectPathCb",
  // listen's port from a checked-dynamic first argument: ERR_SOCKET_BAD_PORT,
  // or the fence for forms without a lowering.
  "net.listenPortDyn",
  // Server event registrations fire the 'newListener' meta event before the
  // add, so a handler of it can throw out of the on/once/addListener call.
  "net.serverOnError",
  "net.serverOnClose",
  "net.serverOnListening",
  "net.serverOnConnection",
  "net.serverOnSecureConnection",
  "net.serverOnDrop",
  "net.serverOnNewListener",
  "http.serverOnTimeout",
  // setTimeout(ms, callback) adds the callback as a 'timeout' listener
  // the same way on() does, so a 'newListener' handler can throw out
  // of it.
  "http.serverSetTimeoutCb",
  // listen(..., callback) adds the callback with once('listening', ...)
  // before it binds, so a 'newListener' handler can throw out of the call
  // and the server does not listen.
  "net.listenCb",
  "net.listenDyn",
  "net.listenDynCb",
  "net.listenOptsCb",
  "net.listenOptsReusePortCb",
  "net.listenPathCb",
  // listen(port) and listen(path) on a server that is already listening
  // throw ERR_SERVER_ALREADY_LISTEN at the call (Node's throw is
  // catchable), so every listen entry point can leave an exception.
  "net.listen",
  "net.listenDyn",
  "net.listenPath",
  "net.listenOpts",
  "net.listenOptsReusePort",
  "http.serverOnRequest",
  "http.serverOnCheck",
  "http.serverOnConnect",
  "http.serverOnUpgrade",
  "http.serverOnClientError",
  "http.serverOnDropRequest",
  "http2.serverOnStream",
  "http2.serverOnSession",
  "http2.serverOnSessionError",
  "tls.serverOnClientError",
  // resetAndDestroy on a TLS socket throws ERR_INVALID_HANDLE_TYPE.
  "net.sockResetAndDestroy",
  // SocketAddress's option checks and parse()'s input check.
  "net.socketAddressNew",
  "net.socketAddressParse",
  // BoundSocket's option checks and bind errors, and listen(bound)'s
  // already-listening and already-adopted errors (Node throws both
  // synchronously).
  "net.boundSocketNew",
  "net.listenBound",
  "net.listenBoundCb",
  // node:dgram state errors (Node throws synchronously): bind on a bound
  // socket, connect on a connected one, send/close/address on a closed or
  // never-bound one.
  // createSocket's constructor ladder (ERR_SOCKET_BAD_TYPE, validateUint32,
  // the options' type checks, and the SC2020s for options with no native
  // behavior yet), the options-object bind forms, the synchronous pair,
  // the source-specific joins and remoteAddress()'s state errors.
  "dgram.createSocket",
  "dgram.createSocketCb",
  "dgram.bindOpts",
  "dgram.bindOptsCb",
  "dgram.bindSync",
  "dgram.connectSync",
  "dgram.addSourceMembership",
  "dgram.dropSourceMembership",
  "dgram.remoteAddress",
  "dgram.bind",
  "dgram.bindCb",
  "dgram.connect",
  "dgram.connectCb",
  "dgram.connectDyn",
  "dgram.sendStr",
  "dgram.sendBytes",
  "dgram.sendChk",
  "dgram.address",
  "dgram.close",
  "dgram.closeCb",
  // the socket options: errno errors, Node's value checks, and the
  // TypeError after close()
  "dgram.setBroadcast",
  "dgram.setTTL",
  "dgram.setMulticastTTL",
  "dgram.setMulticastLoopback",
  "dgram.setMulticastInterface",
  "dgram.addMembership",
  "dgram.dropMembership",
  "dgram.getRecvBufferSize",
  "dgram.getSendBufferSize",
  "dgram.setRecvBufferSize",
  "dgram.setSendBufferSize",
  "dgram.getSendQueueSize",
  "dgram.getSendQueueCount",
  "dgram.disconnect",
  // The assert surface: every entry point except sameValue, bytesDeepEq,
  // looseF64Eq, looseBytesEq, partialEqDyn,
  // and the shape accumulator's begin/slot/test calls throws the
  // catchable AssertionError on failure.
  "assert.ok",
  "assert.failDeprecated",
  // The warning runs process.emitWarning, which a program can replace.
  "assert.failDeprecation",
  "assert.errorNew",
  "assert.eqF64",
  "assert.eqBigInt",
  "assert.eqStr",
  "assert.eqBool",
  "assert.eqSym",
  "assert.eqDyn",
  "assert.looseResult",
  "assert.deepResult",
  "assert.looseDeepResult",
  "assert.looseDeepDyn",
  "assert.partialDeepDyn",
  "assert.partialDeepResult",
  "assert.match",
  "assert.refEqBytes",
  "assert.refEqFn",
  "assert.throwsNone",
  "assert.throwsMismatch",
  "assert.throwsRegex",
  "assert.throwsAmbiguous",
  "assert.shapeEnd",
  "assert.unwantedRejection",
  "assert.unwantedError",
  "assert.noErrorPredicate",
  "assert.regexDynTest",
  "assert.expectsErrDyn",
  "assert.throwsValidate",
  "assert.ifErrorErr",
  "assert.ifErrorF64",
  "assert.ifErrorStr",
  "assert.ifErrorBool",
  "assert.ifErrorDyn",

  // there is, so the honest answer is a catchable TypeError.

  // The wider sync fs slice: same catchable errno throws as the rest.
  "fs.unlinkSync",
  "fs.chmodSync",
  "fs.chmodSyncStr",
  "fs.chmodSyncDyn",
  "fs.fchmodSyncStr",
  "fs.fchmodSyncDyn",
  "fs.chownSync",
  "fs.lchownSync",
  "fs.fchownSync",
  "fs.truncateSync",
  "fs.opendirSync",
  "fs.createReadStream",
  "fs.createWriteStream",
  "fileHandle.createReadStream",
  "fileHandle.createWriteStream",
  "fs.createReadStreamSignal",
  "fs.createWriteStreamSignal",
  "fileHandle.createReadStreamSignal",
  "fileHandle.createWriteStreamSignal",
  "fs.fsStreamClose",
  "fs.fsStreamCloseCb",
  "dir.readSync",
  "dir.readCb",
  "dir.closeSync",
  // close(callback) validates the callback before the closed check, so a
  // non-function argument throws synchronously.
  "dir.closeCb",
  // Symbol.dispose is closeSync on an open Dir: ERR_DIR_CONCURRENT_OPERATION
  // while an operation is queued.
  "dir.dispose",
  "fs.copyFileSync",
  "fs.copyFileFlagsSync",
  "fs.renameSync",
  "fs.renameCb",
  "fs.lstatSync",
  "fs.lstatProbeSync",
  "fs.fstatSync",
  "fs.fchmodSync",
  "fs.fsyncSync",
  "fs.fdatasyncSync",
  "fs.ftruncateSync",
  "fs.utimesSync",
  "fs.futimesSync",
  "fs.lutimesSync",
  "fs.readvSync",
  "fs.writevSync",
  "fs.linkSync",
  "fs.symlinkSync",
  "fs.cpSync",
  "fs.readlinkSync",
  "fs.statfsSync",
  "fs.readlinkSyncStr",
  "fs.readlinkSyncBuffer",
  "fs.writeFileModeSync",
  "fs.writeFileFlagsSync",
  "fs.writeFileOptionsSync",
  "fs.appendFileOptionsSync",
  "fs.writeFileBytesOptionsSync",
  "fs.appendFileBytesOptionsSync",
  "fs.writeFileDataOptionsSync",
  "fs.appendFileDataOptionsSync",
  "fs.writeFileOptionsDynModeSync",
  "fs.appendFileOptionsDynModeSync",
  "fs.writeFileBytesOptionsDynModeSync",
  "fs.appendFileBytesOptionsDynModeSync",
  "fs.writeFileDataOptionsDynModeSync",
  "fs.appendFileDataOptionsDynModeSync",
  "fs.mkdirModeSync",
  "fs.mkdirRecursiveModeSync",
  "fs.mkdirModeStrSync",
  "fs.mkdirObjSync",
  "fs.mkdirObjStrSync",
  "fs.mkdirDynSync",
];

const MAY_THROW_LIB_FNS_PART_6: readonly IrLibFn[] = [
  "fs.mkdirDynVoidSync",
  "fs.mkdirModeValueSync",
  "fs.mkdirModeStrValueSync",
  "fs.mkdirObjVoidSync",
  "fs.mkdirObjStrVoidSync",
  "fs.openSync",
  "fs.openNumericSync",
  "fs.openNumericStrSync",
  "fs.openNumericDynSync",
  "fs.openStrModeSync",
  "fs.openNativeSync",
  "fs.openDynSync",
  "fs.openModeDynSync",
  "fs.openNativeStrSync",
  "fs.openNativeDynSync",
  "fs.readSync",
  "fs.readSyncArgs",
  "fs.writeSync",
  "fs.writeStrSync",
  "fs.writeSyncArgs",
  "fs.readvSyncDyn",
  "fs.writevSyncDyn",
  "fs.ftruncateSyncDyn",
  "fs.closeSyncDyn",
  "fs.fsyncSyncDyn",
  "fs.fdatasyncSyncDyn",
  "fs.fchownSyncDyn",
  "fs.closeSync",
  "fs.watch",
  "fs.watchCb",
  "watcher.on",
  "watcher.off",
  "fs.watchFile",
  "fs.unwatchFile",
  // fsPromises.watch opens the path now and throws Node's fs error
  // (ENOENT, EACCES, a null byte) from scr_watch_events_new.
  "fsp.watch",
  // watchEvents.take raises ERR_FS_WATCH_QUEUE_OVERFLOW when the queue
  // overflowed under overflow: "error".
  "watchEvents.take",
  // readableWebStream throws Node's ERR_INVALID_STATE for a closed handle.
  "fileHandle.readableWebStream",
  // The disposable temp directory: creating it validates the options and
  // can fail in mkdtemp, and its removal raises rm's errors (the promise
  // form turns them into a rejection, the sync form throws them).
  "fsp.mkdtempDisposable",
  "fs.mkdtempDisposableSync",
  "mkdtempResult.remove",
  "mkdtempResult.removeSync",
  "mkdtempResult.asyncDispose",
  "mkdtempResult.dispose",
  "crypto.x509Fingerprint",
  "crypto.x509FingerprintStr",
  "crypto.x509ValidFrom",
  "crypto.x509ValidFromStr",
  "crypto.x509ValidTo",
  "crypto.x509ValidToStr",
  "crypto.createPrivateKey",
  "crypto.createPublicKey",
  "crypto.generateKeyPairSync",
  "crypto.generateKeyPairCb",
  "crypto.encapsulate",
  "crypto.decapsulate",
  // Argon2 reads its parameters object (whose members convert strings and
  // BufferSources) and may run program code through those conversions.
  "crypto.argon2Sync",
  "crypto.argon2Cb",
  // getPublicKey converts its keyUsages sequence (whose strings' conversions
  // run program code) and reads the key's members through the handle.
  "webcrypto.getPublicKey",
  // The KeyObject conversions normalize their algorithm (reading its members)
  // and convert the keyUsages sequence.
  "webcrypto.keyObjectToCryptoKey",
  "webcrypto.keyObjectFrom",
  "crypto.signOneshot",
  "crypto.signOneshotCb",
  "crypto.signOneshotMaybe",
  "crypto.verifyOneshot",
  "crypto.verifyOneshotCb",
  "crypto.verifyOneshotMaybe",
  "crypto.publicEncrypt",
  "crypto.privateDecrypt",
  "crypto.privateEncrypt",
  "crypto.publicDecrypt",
  "crypto.setEngine",
  "crypto.diffieHellman",
  "crypto.createSign",
  "crypto.createVerify",
  "crypto.x509Raw",
  "crypto.x509RawDer",
  "crypto.x509RawStr",
  // Node's argument errors (name, options, pkey) and the key parse.
  "crypto.x509CheckHost",
  "crypto.x509CheckEmail",
  "crypto.x509CheckIP",
  "crypto.x509PublicKey",
  "crypto.x509Verify",
  "crypto.x509CheckPrivateKey",
  // Certificate's SPKAC argument errors, and the key parse behind
  // verifySpkac and exportPublicKey.
  "crypto.spkacVerify",
  "crypto.spkacChallenge",
  "crypto.spkacPublicKey",
  // ReadableStream.from's iterability and iterator-method errors, which
  // Node raises from the call itself.
  "webstream.from",
];

/** The may-throw seed: libCall members that can raise. Every fs.* member
 * except existsSync (which, like Node's, swallows path errors and returns
 * false) throws a catchable error on failure; fs.existsSyncValue is here
 * because reporting DEP0187 for an invalid argument type runs
 * process.emitWarning, whose replacement may throw. json.parse throws a
 * catchable SyntaxError-shaped string on malformed input. Backends' may-throw
 * analyses must treat a function containing one of these as throwing, exactly
 * like a `throw` statement (and must ALSO seed on `dynCheck` and `awaitExpr`
 * nodes, which throw on validation failure / promise rejection).
 *
 * The names come in parts so each part is checked against the closed set of
 * builtin names on its own. A list this long is compared member by member
 * against every name in a single check, which costs the checker its whole
 * comparison budget, and then each new builtin entry risks a spurious
 * "Excessive complexity comparing types" error. Every part is checked as
 * fully as the whole list was, and the set holds the same names in the same
 * order. */
export const MAY_THROW_LIB_FNS: ReadonlySet<IrLibFn> = new Set([
  ...MAY_THROW_LIB_FNS_PART_1,
  ...MAY_THROW_LIB_FNS_PART_2,
  ...MAY_THROW_LIB_FNS_PART_3,
  ...MAY_THROW_LIB_FNS_PART_4,
  ...MAY_THROW_LIB_FNS_PART_5,
  ...MAY_THROW_LIB_FNS_PART_6,
]);

/** libCall members that always throw. Their result type is the replaced
 * expression's own and is never materialized: global.undefRead's is the
 * declared type of the undefined global; the others stand in for a value
 * of the expression they replace. The fs Chk ladders qualify: every
 * validation failure throws Node's typed error, and a full pass throws the
 * trailing compiler-rendered fence. */
export const ALWAYS_THROW_LIB_FNS: ReadonlySet<IrLibFn> = new Set([
  "global.undefRead",
  "error.nodeThrow",
  "error.argTypeThrow",
  "error.propTypeThrow",
  "array.foreignThrow",
  "fs.mkdtempChk",
  "fs.readFileChk",
  "fs.opendirChk",
  "fs.watchFileChk",
  "fs.lchmodChk",
  "fs.readChk",
  "fs.streamOptsChk",
  "tls.caCertsChk",
  "sea.getAsset",
  "sea.getRawAsset",
  "sea.getAssetAsBlob",
  "sea.getAssetKeys",
]);
