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
  "process.finalization",
  // scr_process_abort settles stdout and raises SIGABRT: it raises no
  // error and runs no program code (the arguments were evaluated).
  "process.abort",
  // scr_global_binding_value looks the name up in the global object's own
  // properties and retains what it finds.
  "global.bindingValue",
  // scr_global_binding_has looks the name up in the same table.
  "global.bindingHas",
  // scr_dyn_native_search_params_is compares the value's kind and handle tag.
  "dyn.nativeSearchParamsIs",
  // scr_weak_ref_is compares the value's kind and handle tag.
  "weakRef.is",
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
  // Constants of the response's writable side (65536, false).
  "http.resWritableHighWaterMark",
  "http.resWritableObjectMode",
  // A listener is added to the request's or the session's list, or dropped
  // when the request or session is past the event; no listener runs.
  "http.clientOnConnect",
  "http.clientOnInformation",
  "http2.sessionOnPing",
  // Reads of the session's, the stream's or the request's state bits.
  "http2.sessionConnecting",
  "http2.streamHeadersSent",
  "http2.reqComplete",
  // The default settings packed: there is no record to validate.
  "http2.getPackedSettings0",
  // Copies the values a name has in a string pairs array.
  "http2.pairsValues",
  // The child stream's flowing state is set or read; held chunks go to the
  // listeners on a later tick, never inside the call.
  "stream.childPause",
  "stream.childResume",
  "stream.childIsPaused",
  "stream.childFlowing",
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
  // Stores the encoding's spelling beside the decoder setEncoding installed.
  "readable.encodingName",
  // scr_fs_exists_bytes turns the path bytes into a string and probes it; a
  // path that is not there is the answer false, and the probe reports no
  // error.
  "fs.existsSyncBytes",
  // scr_insp_numeric_separator stores one flag and answers its previous
  // value.
  "insp.numericSeparator",
  // scr_worker_share_env answers the thread's SHARE_ENV symbol and makes it
  // on first use; it takes no argument, and running out of memory ends the
  // process.
  "worker.shareEnv",
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
  // scr_module_compile_cache_dir answers the undefined value, and
  // scr_module_constants builds two objects of constants once per thread;
  // neither takes an argument, and running out of memory ends the process.
  "module.compileCacheDir",
  "module.compileCacheConstants",
  // scr_http_server_off drops the last entry of the event's listener list
  // that stands for the function; a function that is not in the list, or a
  // closed server, leaves the list as it is. No 'removeListener' event runs.
  "http.serverOff",
  // scr_net_server_listeners and scr_http_server_listeners copy the event's
  // listener list into a new array of the registered functions; running out
  // of memory ends the process.
  "net.serverListeners",
  "http.serverListeners",
  // scr_record_source_has_key asks the record's kept view whether it holds
  // an own key: no accessor runs, and a record without a view answers false.
  "record.sourceHasKey",
  // scr_record_reflects_static probes the kept-source table and the live
  // capsule table for the record's address: it reads no property.
  "record.reflectsStatic",
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
  // scr_zlib_codec_promise_info and its dyn twin answer a promise: a
  // refused option or input is moved into it as a rejection, and running
  // out of memory ends the process, so no error escapes the call.
  "zlib.infoPromise",
  "zlib.infoPromiseDyn",
  // scr_text_encode_into_str writes the two counts of the typed encodeInto
  // into the slots the compiler allocated: the walk runs no program code, a
  // destination that is not a u8 byte view ends the process at the entry's
  // own check, and running out of memory ends it too. The call reports no
  // error the emitter could deliver.
  "text.encodeIntoStr",
]);
