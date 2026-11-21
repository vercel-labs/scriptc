import type { IrLibFn } from "./builtin-signatures.js";

/** Builtins decided never to throw: the runtime function behind the call
 * cannot raise an error and cannot run program code (a getter, `toJSON`,
 * `valueOf`, `toString`, a proxy trap or a callback), under any argument.
 *
 * Every builtin states its answer once: a row in MAY_THROW_LIB_FNS
 * (builtin-effects.ts) or a row here. A builtin in neither is compiled
 * without the check that delivers its error, so the error is lost and the
 * caller reads a placeholder result. The compiler does not read this set;
 * packages/compiler/test/builtin-attributes.test.ts holds every builtin to
 * the rule, and builtin-throw-undecided.txt lists the builtins that
 * predate it. */
export const NEVER_THROW_LIB_FNS: ReadonlySet<IrLibFn> = new Set<IrLibFn>([
  // Error.prepareStackTrace's program state: the get retains the stored value
  // (or builds the default function once) and the set retains and releases;
  // neither runs program code or raises a catchable error.
  "error.prepareStackTraceGet",
  "error.prepareStackTraceSet",
  // perf_hooks histogram readings and state: the handle indexes the
  // thread's table, every selector is arithmetic over it, and none runs
  // program code. (Creating and recording validate their arguments, so
  // those are MAY_THROW.)
  "perf.histoStat",
  "perf.histoStatBig",
  "perf.histoEwma",
  "perf.histoPercentile",
  "perf.histoPercentileBig",
  "perf.histoMeanCI",
  "perf.histoWelch",
  "perf.histoPercentileCI",
  "perf.histoCountAt",
  "perf.histoCdf",
  "perf.histoCcdf",
  "perf.histoRecordDelta",
  "perf.histoReset",
  "perf.histoPercentilesCount",
  "perf.histoPercentilesKey",
  "perf.histoPercentilesValue",
  "perf.histoBucketsKey",
  "perf.histoBucketsValue",
  "dyn.moduleClassValue",
  "perf.histoPercentilesValueBig",
  "perf.histoDispose",
  "perf.slidingReset",
  // scr_test_ctx_signal reads the test's AbortSignal handle; creating the
  // controller runs no program code and raises no catchable error.
  "test.ctxSignal",
  // scr_test_ctx_log writes the ℹ line at once; printing cannot raise.
  "test.ctxLog",
  // scr_test_ctx_assert_touch copies the custom-assertion registry (plain
  // objects and functions) into the context's snapshot; it runs no program
  // code and raises no catchable error.
  "test.ctxAssertTouch",
  // scr_test_ctx_tags answers the cached frozen tag array; building it on the
  // first read copies the tag strings and allocates, running no program code.
  "test.ctxTags",
  // Console instance state that answers text: the timer labels are already
  // strings, the stores are the instance's own tables, and no program code
  // runs. (The counters and the table can throw, so they are not here.)
  "console.channelActive",
  "console.publishArgs",
  "console.instTime",
  "console.instTimeEnd",
  "console.instTimeLog",
  // scr_console_inst_group adjusts the instance's indentation count.
  "console.instGroup",
  // scr_console_inst_clear writes the terminal sequences to the instance's
  // descriptor; a non-terminal target writes nothing.
  "console.instClear",
  // The OutgoingMessage write-buffer readers compare and sum stored byte
  // counts (the corked buffer's length, the held head's, the socket's
  // pending bytes) and a boolean flag; registering a 'drain' listener
  // appends to a list. None of them runs program code.
  "http.resWritableLength",
  "http.resWritableNeedDrain",
  "http.clientWritableLength",
  "http.clientWritableNeedDrain",
  "http.resOnDrain",
  "http.clientOnDrain",
  // scr_test_snapshot_set_resolve_path stores the resolver closure.
  "test.snapshotSetResolvePath",
  "process.finalization",
  // scr_watcher_ref / scr_watcher_unref move one open watcher's loop-liveness
  // flag; a closed watcher ignores them, and nothing user-visible runs.
  "watcher.ref",
  "watcher.unref",
  // watchEvents.wait builds a promise or answers a settled one, and
  // scr_watch_events_close closes an already-open watcher (a closed one
  // returns at once). Neither runs program code. watchEvents.take and
  // fsp.watch are deliberately absent: a queue over its bound raises
  // ERR_FS_WATCH_QUEUE_OVERFLOW, and opening the path throws Node's fs
  // error.
  "watchEvents.wait",
  // DisposableTempDir.path hands the created path's reference on; nothing
  // runs.
  "mkdtempResult.path",
  "watchEvents.close",
  // scr_stat_watcher_ref / scr_stat_watcher_unref move one registration's
  // liveness flag; a registration fs.unwatchFile already removed is a no-op.
  "statWatcher.ref",
  "statWatcher.unref",
  // scr_global_binding_value looks the name up in the global object's own
  // properties and retains what it finds.
  // scr_sqlite_is compares a handle's tag.
  "sqlite.is",
  "global.bindingValue",
  // scr_global_binding_has looks the name up in the same table.
  "global.bindingHas",
  // scr_dyn_native_search_params_is compares the value's kind and handle tag.
  "dyn.nativeSearchParamsIs",
  // scr_dyn_register_class_to_string copies the type key and retains the
  // function in a thread-local table; no program code runs.
  "dyn.registerClassToString",
  // scr_weak_ref_is and scr_dyn_abort_signal_is compare the value's kind
  // and handle tag.
  "weakRef.is",
  "abort.signalIs",
  // scr_dyn_adoptable compares the value's kind.
  "dyn.adoptable",
  // scr_dyn_function_prototype builds the one anonymous function answering
  // undefined on first use and retains it; no user code runs.
  "dyn.functionPrototype",
  // Both instanceof predicates compare values: scr_dyn_perf_handle_is asks
  // the handle tag, and scr_dyn_perf_entry_is asks an object's prototype
  // chain (or, for a live record, the view its materializer builds, which
  // runs no program code).
  "perf.observerIs",
  "perf.entryIs",
  // The AsyncHook flips and the execution-id reads touch the core's own
  // thread-local state; no program code runs and nothing raises.
  "ah.disable",
  "ah.enable",
  "ah.providers",
  "ah.executionId",
  "ah.executionResource",
  "ah.triggerId",
  // scr_als_with_scope reads the effective store, enters the new one and
  // boxes the RunScope; no program code runs and nothing raises.
  "als.withScope",
  // The AsyncResource reads answer the registry's ids, and emitDestroy
  // marks the entry; none runs program code or raises.
  "ar.asyncId",
  "ar.emitDestroy",
  "ar.triggerAsyncId",
  // The resource-timing field accessors read a view entry's own numbers and
  // strings; no program code runs.
  "perf.entryResourceNum",
  "perf.entryResourceStr",
  // publish runs every subscriber and catches its throw: like Node's
  // process.nextTick(triggerUncaughtException), the exception is delivered
  // on a later tick instead of leaving the call, so publish itself raises
  // nothing.
  "dc.publish",
  // scr_dc_has_subscribers answers false for a name that is neither a string
  // nor a symbol and compares its registry by name identity; no program code
  // runs.
  "dc.hasSubscribers",
  // scr_dc_chan_name retains the interned name string.
  "dc.chanName",
  // The tracing handles' reads compare registry entries and dispatch the
  // hasSubscribers conjunction.
  "dc.tcChannel",
  "dc.tcHasSubscribers",
  "dc.chanHasSubscribers",
  // scr_te_get_enabled_categories reads the registry's own strings.
  "te.getEnabledCategories",
  // scr_perf_loop_exit and scr_perf_loop_count read the loop's clock and its
  // counter; neither runs program code.
  "perf.loopExit",
  "perf.loopCount",
  // scr_closure_adopt_identity writes two fields of the adapter.
  "closure.shareIdentity",
  // scr_events_once_any turns every failure into the result promise's
  // rejection: an invalid options object or signal, an aborted signal, a
  // name that cannot key the registry, a throwing 'newListener' listener
  // (which it takes off the cell) and the awaited event's own 'error'. It
  // throws nothing to its caller.
  "events.onceAny",
  // scr_ni_intrinsic_register stores the value in a table.
  "nodeIsland.intrinsic",
  // Emitted as the constant false; there is no runtime call.
  "sea.isSea",
  // scr_dyn_new_promise retains the promise and allocates its box.
  "weakMap.promiseKey",
  // scr_resolve_adopt queues a job; a promise resolved with itself is
  // rejected, not thrown.
  "promise.adopt",
  // scr_dns_resolver_is compares the value's kind and handle tag.
  "dns.resolverIs",
  // scr_dns_get_servers_default builds the server array from the default
  // resolver's list; the list was read when that resolver was created, and
  // turning it into strings cannot raise.
  "dns.promisesGetServers",
  // Constants of the response's writable side (65536, false).
  "http.resWritableHighWaterMark",
  "http.resWritableObjectMode",
  // A listener is added to the request's or the session's list, or dropped
  // when the request or session is past the event; no listener runs.
  "http.clientOnConnect",
  "http.clientOnInformation",
  "http2.sessionOnPing",
  // A header-record listener registration: no listener runs inside the
  // call, and a registered callback cannot raise.
  "http2.streamOnTrailers",
  "http2.streamOnHeaders",
  "http2.streamOnWantTrailers",
  "http2.streamOnContinue",
  // Reads of the session's, the stream's or the request's state bits.
  "http2.sessionConnecting",
  "http2.streamHeadersSent",
  "http2.reqComplete",
  // The default settings packed: there is no record to validate.
  "http2.getPackedSettings0",
  // Copies the values a name has in a string pairs array.
  "http2.pairsValues",
  // Readable.toWeb builds the web stream over the readable's chunks; the
  // read it starts runs later, on the promise's reaction.
  "webstream.toWebReadable",
  // Writable.toWeb builds the sink object and the web WritableStream over it;
  // the sink's functions run later, on the web stream's calls.
  "webstream.writableToWeb",
  // Duplex.fromWeb's pair constructs the Duplexify and stores the flag.
  "stream.duplexifyPairHalf",
  // Duplex.toWeb builds both adapters over the duplex; their functions run
  // later, on the web streams' calls.
  "webstream.toWebDuplex",
  // stream.getDefaultHighWaterMark reads the runtime's default for the mode:
  // no allocation, no coercion and no program code.
  "stream.getDefaultHwm",
  // The child stream's flowing state is set or read; held chunks go to the
  // listeners on a later tick, never inside the call.
  "stream.childPause",
  "stream.childResume",
  "stream.childIsPaused",
  "stream.childFlowing",
  // subprocess.channel answers the child's IPC state: undefined when it
  // never had a channel, null once it closed, else a handle over the
  // child. The island path reads the island ChildProcess's `channel`
  // data property, which Node assigns as a field; neither path runs an
  // accessor, a coercion or a callback.
  "child.channel",
  // child.stdio's length is the child's fixed stdio slot count: a plain
  // read of the handle's field, with no allocation and no program code.
  "child.stdioLen",
  // The child's cached stdio array: a flag read, a retain of the array the
  // first read built, and a store of that array (a retain); no program code.
  "child.stdioCached",
  "child.stdioArray",
  "child.stdioStore",
  // Builds the flags object once from constants and retains it.
  "process.features",
  // scr_cpu_usage_field reads the number cpuDynPrepare just stored; the
  // validation already ran, so the read cannot raise.
  "process.cpuDynField",
  // The capture-callback flag and the two process flags are plain reads
  // of thread-local state; no allocation and no program code runs.
  "process.hasUncaughtCapture",
  "process.debugPort",
  "process.sourceMapsEnabled",
  // Reads the fork channel registry and answers undefined, null or the
  // retained Control object; a plain process has no channel.
  "process.channel",
  // The Module view of a record: a cache lookup, a retain, and the object
  // built on first use from fields the registry already holds.
  "module.dynObject",
  "module.dynChildren",
  "module.dynParent",
  "module.dynObjectOrAbsent",
  "module.dynOf",
  "module.setExportsDyn",
  // The stream object a descriptor the program already holds names: a cache
  // lookup and a retain, with no allocation, coercion or program code. The
  // cursor methods use it to reach the same object process.stdio answers.
  "process.stdioOf",
  // Stores the encoding's spelling beside the decoder setEncoding installed.
  // readable.iterator builds the async iterator object; its members run later.
  "readable.iterator",
  "readable.encodingName",
  // scr_fs_exists_bytes turns the path bytes into a string and probes it; a
  // path that is not there is the answer false, and the probe reports no
  // error.
  "fs.existsSyncBytes",
  // scr_insp_numeric_separator stores one flag and answers its previous
  // value.
  "insp.numericSeparator",
  // scr_insp_prop_child stores one flag; scr_insp_property builds a string.
  "insp.propChild",
  "insp.property",
  // scr_worker_share_env answers the thread's SHARE_ENV symbol and makes it
  // on first use; it takes no argument, and running out of memory ends the
  // process.
  "worker.shareEnv",
  // scr_worker_performance answers the Worker's { eventLoopUtilization }
  // object, made once per Worker; a handle of another class reads undefined,
  // and running out of memory ends the process.
  "worker.performance",
  // scr_emitter_symbol_name allocates the registry key of the symbol it is
  // given (scr_str_symbol_key); running out of memory ends the process.
  "emitter.symName",
  // scr_promise_all_settled subscribes a countdown reaction to each entry
  // and queues one job for the entries already settled; the builder runs
  // later, inside the combinator's settlement, never in this call.
  "promise.allSettledTuple",
  // scr_promise_is_rejected reads the promise's state.
  "promise.entryRejected",
  // scr_promise_reason_dyn boxes the stored reason (a number, a boolean, a
  // string, an error object or the checked-dynamic value itself); running
  // out of memory ends the process.
  "promise.entryReason",
  // Emitted inline: the value's tag, its signature literal's length and
  // the literal's last four bytes. No runtime call but strlen.
  "dyn.classValueHash",
  // Emitted inline but for scr_dyn_typed_ref_brand_is_key, which compares a
  // capsule's type key with a string and allocates nothing.
  "dyn.typedRefBrandIs",
  // A count and a table lookup by the wrapped instance's address.
  "dyn.prototypesReplaced",
  "dyn.prototypeReplaced",
  // scr_module_compile_cache_dir answers the undefined value, and
  // scr_module_constants builds two objects of constants once per thread;
  // neither takes an argument, and running out of memory ends the process.
  "module.compileCacheDir",
  "module.compileCacheConstants",
  // scr_module_namespace_copy_value retains the module's namespace object,
  // marks it as one and records it: no program code runs, and allocation
  // failure ends the process.
  "module.namespaceCopy",
  // scr_http_server_off drops the last entry of the event's listener list
  // that stands for the function; a function that is not in the list, or a
  // closed server, leaves the list as it is. No 'removeListener' event runs.
  "http.serverOff",
  // scr_net_server_listeners and scr_http_server_listeners copy the event's
  // listener list into a new array of the registered functions; running out
  // of memory ends the process.
  "net.serverListeners",
  "http.serverListeners",
  // scr_net_is_bound_socket reads a dyn value's tag and handle pointer: a
  // value of another kind answers false. It runs no code.
  "net.isBoundSocket",
  // scr_record_source_has_key asks the record's kept view whether it holds
  // an own key: no accessor runs, and a record without a view answers false.
  "record.sourceHasKey",
  // scr_record_reflects_static probes the kept-source table and the live
  // capsule table for the record's address: it reads no property.
  "record.reflectsStatic",
  // scr_crypto_x509_key_usage reads the certificate's extended key usage
  // extension: a certificate without one answers undefined and a malformed
  // extension is skipped, so no program-visible error is raised.
  "crypto.x509KeyUsage",
  // Timeout.close() and Immediate.prototype[Symbol.dispose]() clear the
  // timer the handle names: the loop's clear, or the mock's own entry
  // removal when the program mocks timers. Neither throws nor runs a
  // callback.
  "timers.close",
  "timers.immediateClose",
  // The same clears in their disposal spelling, whose result is undefined
  // rather than the handle.
  "timers.dispose",
  "timers.immediateDispose",
  // The header-limit properties are plain storage: the getters retain the
  // stored value (or answer null / 0) and the setters retain the new value
  // and release the old one. No accessor, coercion or listener runs, and
  // the HTTP layer reads the stored value when it parses a message.
  "net.serverMaxHeadersCountGet",
  "net.serverMaxHeadersCountSet",
  "net.serverMaxRequestsPerSocketGet",
  "net.serverMaxRequestsPerSocketSet",
  "http.clientMaxHeadersCountGet",
  "http.clientMaxHeadersCountSet",
  // The autoSelectFamily default is plain storage in the core unit: the
  // getter answers the stored boolean and runs nothing else.
  "net.getDefaultAutoSel",
  // scr_net_sock_on_attempt adds the listener to the socket's attempt list
  // (or drops it past 'close'); no listener runs.
  "net.sockOnAttempt",
  // scr_net_sock_buffer_size and scr_net_sock_attempted_addresses read the
  // socket's write buffer and attempted-address list: no accessor runs.
  "net.sockBufferSize",
  "net.sockAttemptedAddresses",
  // scr_net_server_async_dispose allocates the promise, adds a close
  // listener and starts the close; a later close failure is a rejection.
  "net.serverAsyncDispose",
  // scr_tls_sock_dyn_member reads the name the client asked for (the SNI
  // name a server recorded) into a string, or false, and copies the
  // established session into a Buffer, or null before there is one. It
  // runs no program code.
  "tls.sockDynMember",
  // scr_tls_sock_disable_renegotiation does nothing: the provider keeps
  // renegotiation off, which is what the call asks for.
  "tls.sockDisableRenegotiation",
  // scr_net_server_is_tls and scr_tls_server_is_dyn read a handle's tag
  // for `instanceof tls.Server`; no program code runs.
  "tls.serverIs",
  "tls.serverIsDyn",
  // scr_dgram_async_dispose allocates the promise and registers the close
  // listener; the only failure is allocation, which aborts.
  "dgram.asyncDispose",
  // socket.type and `instanceof dgram.Socket`: pure reads, never throw.
  "dgram.type",
  "dgram.isSocket",
  // scr_util_transferable_abort_controller allocates a controller and its
  // signal state; running out of memory ends the process, and no argument
  // is read (surplus arguments are evaluated by the call site).
  "util.transferableAbortController",
  // scr_util_set_trace_sig_int reads no argument and answers undefined; it
  // has no observable effect in a compiled program (the hook it toggles
  // feeds Node's --trace-sigint diagnostics).
  "util.setTraceSigInt",
  // scr_zlib_codec_promise_info and its dyn twin answer a promise: a
  // refused option or input is moved into it as a rejection, and running
  // out of memory ends the process, so no error escapes the call.
  "zlib.infoPromise",
  "zlib.infoPromiseDyn",
  // scr_bytes_item_dyn reads a byte view's element as a checked-dynamic
  // value: an index that is not one of the view's elements answers undefined,
  // the element read runs no program code, and the box allocation cannot
  // raise (running out of memory ends the process).
  "bytes.itemDyn",
  // scr_text_encode_into_str writes the two counts of the typed encodeInto
  // into the slots the compiler allocated: the walk runs no program code, a
  // destination that is not a u8 byte view ends the process at the entry's
  // own check, and running out of memory ends it too. The call reports no
  // error the emitter could deliver.
  "text.encodeIntoStr",
  // Error.prepareStackTrace as program state (scr_exception.c): the getter
  // and setter read and write the program's own cell, running no program
  // code and raising no catchable error.
  "error.prepareStackTraceGet",
  "error.prepareStackTraceSet",
  // socket.timeout and socket.allowHalfOpen (scr_net.c): both getters read
  // the socket's own state — the stored timeout and the constructor's
  // half-open option — running no program code and raising nothing.
  "net.sockTimeoutGet",
  "net.sockAllowHalfOpen",
]);
