/* LlEmitter's module-level output: module parts, helper definitions, library declarations and FFI callback definitions. */
import { relieveHeapPressure } from "../../heap-pressure.js";
import { emitWasmModules } from "./wasm-modules.js";
import { type LlEmitter, ffiCallbackDummyLl, llStrBytes } from "./emitter.js";
import { type ChunkResult, EmitJournal } from "./emit-journal.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JS_IC_WORDS } from "./js-ic.js";
import {
  mangleAsyncSpawn,
  mangleClassObj,
  mangleFnClosure,
  mangleFunction,
  mangleGlobal,
  mangleVtInstance,
} from "../mangle.js";
import {
  type IrGlobal,
  type IrNodeIslandModules,
  type IrType,
  RUNTIME_ERROR_CLASSES,
  RUNTIME_EVENT_CLASS,
  RUNTIME_EVENT_TARGET_CLASS,
  ffiCallbackType,
  isFfiContextParam,
  isRefCounted,
  typeKey,
} from "../../ir/ir.js";
import {
  FN_ATTRS,
  limitInlineReleases,
  releaseSym,
  typedRefConstructor,
  vAdapters,
} from "./shapes.js";
import { emitLlvmLayouts } from "./layouts.js";
import { emitArraySearchHelpers } from "./array-search.js";
import { emitClassMembershipHelper } from "./classes.js";
import { type RegexMatcherCode, compileRegexMatcher } from "./regex-matchers.js";
import {
  MAP_ITER_DECL,
  MAP_SIZE_DECL,
  MAP_ITER_NUM_DECL,
  SCR_MAP_NUM_DEAD,
  NUMBER_MAP_ENTRY_DECL,
  STRING_MAP_ENTRY_C_DECL,
  STRING_MAP_ENTRY_DECL,
} from "./map-number-lookup.js";
import { RUNTIME_ABI_MARKER } from "../runtime-abi.js";
import { threadSlotsBlockDefinitions } from "./thread-slots.js";
import {
  ABSENT_FIELD_PAYLOAD,
  exactIndexLines,
  f64Lit,
  ffiNativeParamLl,
  ffiNativeReturnLl,
  ffiNativeTypeLl,
} from "./common.js";
import { literalCapWord, literalCapWord32 } from "./string-key-hash.js";
import { hasLoneSurrogate, llvmBytes, wtf8Bytes } from "../literals.js";
import { nodeIslandManifest } from "../../node-islands/modules.js";
import { undefinedArmTag } from "../../ir/analysis.js";
import { NULLABLE_ABSENT, NULLABLE_NULL } from "./nullable-unions.js";
import { literalEqualityDefinition } from "./string-literal-equality.js";
import { STRING_READ_HELPERS, stringScanDecl } from "./string-reads.js";
import { emitLibraryIdentityLines } from "../library-identity-markers.js";
import { InternalCompilerError } from "../../errors.js";
import { targetCpuAttribute } from "../target-cpu.js";

/** The function bodies emitted in `chunks` contiguous ranges, each by its
 * own emitter (LlEmitter.chunkEmitter), then merged in function order: the
 * text one emitter gives. */
function emitFunctionsInChunks(emitter: LlEmitter, chunks: number): string[] {
  const functions = emitter.mod.functions;
  const size = Math.ceil(functions.length / chunks);
  const ranges: { chunk: LlEmitter; texts: string[] }[] = [];
  for (let start = 0; start < functions.length; start += size) {
    const chunk = emitter.chunkEmitter();
    const texts = functions.slice(start, start + size).map((fn) => {
      const text = chunk.emitFunction(fn);
      if (chunk.journal!.overclosed)
        throw new Error(`llvm emitter bug: journal definition closed twice in ${fn.name}`);
      if (chunk.journal!.unclosed.length > 0)
        throw new Error(
          `llvm emitter bug: unclosed journal definitions after ${fn.name}: ${chunk.journal!.unclosed.join(", ")}`,
        );
      return text;
    });
    ranges.push({ chunk, texts });
  }
  const fnDefs: string[] = [];
  for (const { chunk, texts } of ranges) {
    // The plain-data result a worker process would write, round-tripped.
    const result = JSON.parse(JSON.stringify(chunk.chunkResult())) as ChunkResult;
    const rename = emitter.mergeChunk(result);
    for (const text of texts) {
      const def = rename(text);
      emitter.fnDefText.set(functions[fnDefs.length]!.name, def);
      fnDefs.push(def);
    }
  }
  return fnDefs;
}

/** Modules with fewer functions emit in one process: forking and merging
 * would cost more than the workers save (SCRIPTC_EMIT_WORKER_FUNCTIONS
 * lowers it, for tests). */
function workerMinFunctions(): number {
  const value = Number(process.env["SCRIPTC_EMIT_WORKER_FUNCTIONS"] ?? "2000");
  return Number.isFinite(value) && value > 0 ? value : 2000;
}

/** The function bodies emitted on forked worker processes, `workers` at a
 * time: the function list splits into contiguous ranges, each emitted in
 * its own process, which inherits this emitter as it is at the fork and
 * records a journal (emit-journal.ts). Ranges merge in function order, so
 * the text is the serial text. A range whose worker fails is emitted here
 * when its turn comes. Null without fork primitives (Node, Windows, inside
 * a worker) or when the module is small. */
function emitFunctionsOnWorkers(emitter: LlEmitter, workers: number): string[] | null {
  const fork = emitter.targetOptions.forkPrimitives;
  const functions = emitter.mod.functions;
  if (fork === undefined || workers < 2) return null;
  if (functions.length < workerMinFunctions()) return null;
  // More ranges than workers: a range's merge overlaps the later ranges'
  // emission, and a slow range holds back less.
  const count = Math.min(functions.length, workers * 3);
  const size = Math.ceil(functions.length / count);
  const dir = mkdtempSync(join(tmpdir(), "scriptc-emit-"));
  const pids: number[] = [];
  const start = (range: number): void => {
    const pid = fork.fork();
    if (pid === 0) {
      let code = 1;
      try {
        emitter.journal = new EmitJournal();
        const texts: string[] = [];
        for (const fn of functions.slice(range * size, (range + 1) * size)) {
          texts.push(emitter.emitFunction(fn));
          relieveHeapPressure();
        }
        writeFileSync(join(dir, `${range}.json`), JSON.stringify(emitter.chunkResult()));
        // Function text never holds NUL, so it separates the functions.
        writeFileSync(join(dir, `${range}.ll`), texts.join("\0"));
        code = 0;
      } catch {
        // The parent emits the range itself.
      }
      fork.exit(code);
    }
    pids.push(pid);
  };
  const fnDefs: string[] = [];
  try {
    for (let range = 0; range < Math.min(workers, count); range++) start(range);
    for (let range = 0; range < count; range++) {
      const pid = pids[range]!;
      const status = pid > 0 ? fork.wait(pid) : -1;
      // The next worker starts from this emitter as merged so far, which
      // the journal allows: it records requests, not table contents.
      const merged = status === 0 ? readRange(dir, range) : null;
      const slice = functions.slice(range * size, (range + 1) * size);
      if (merged !== null && merged.texts.length === slice.length) {
        const rename = emitter.mergeChunk(merged.result);
        slice.forEach((fn, index) => {
          const def = rename(merged.texts[index]!);
          emitter.fnDefText.set(fn.name, def);
          fnDefs.push(def);
        });
      } else
        for (const fn of slice) {
          const def = emitter.emitFunction(fn);
          emitter.fnDefText.set(fn.name, def);
          fnDefs.push(def);
          relieveHeapPressure();
        }
      if (pids.length < count) start(pids.length);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return fnDefs;
}

/** A worker's range result, or null when its files are missing. */
function readRange(dir: string, range: number): { result: ChunkResult; texts: string[] } | null {
  try {
    const result = JSON.parse(readFileSync(join(dir, `${range}.json`), "utf8")) as ChunkResult;
    const texts = readFileSync(join(dir, `${range}.ll`), "utf8").split("\0");
    return { result, texts };
  } catch {
    return null;
  }
}

/** The attribute groups of the emitted functions: #0 for every function,
 * #1 for coroutine bodies and #2 for out-of-line record clones. Each carries
 * the build's `--target-cpu` level. */
function functionAttributes(emitter: LlEmitter, hasNoInlineRecordClone: boolean): string[] {
  const cpu = targetCpuAttribute(emitter.targetCpu);
  return [
    `attributes #0 = { sanitize_address${cpu} }`,
    ...(emitter.usesCoroutines
      ? [`attributes #1 = { sanitize_address presplitcoroutine${cpu} }`]
      : []),
    ...(hasNoInlineRecordClone ? [`attributes #2 = { noinline sanitize_address${cpu} }`] : []),
  ];
}

export function emitModuleParts(emitter: LlEmitter): string[] {
  // Function bodies first (the literal/unit/fn-value tables fill as they
  // emit), then the file assembles around them — the runtime ABI’s order.
  // Debug metadata is numbered per emitter and not journaled, so a debug
  // build emits every body here.
  const ranges = emitter.debug === null;
  const chunks = emitter.targetOptions.functionChunks ?? 1;
  const fnDefs =
    (ranges && chunks > 1 ? emitFunctionsInChunks(emitter, chunks) : null) ??
    (ranges ? emitFunctionsOnWorkers(emitter, emitter.targetOptions.functionWorkers ?? 1) : null) ??
    [];
  if (fnDefs.length === 0)
    for (const fn of emitter.mod.functions) {
      const def = emitter.emitFunction(fn);
      fnDefs.push(def);
      emitter.fnDefText.set(fn.name, def);
      relieveHeapPressure();
    }
  emitter.selectStacklessAsync(fnDefs);
  const errorViews: string[] = [];
  for (const property of ["name", "message"])
    if (emitter.mod.functions.some((fn) => fn.name === `%error.${property}.read`)) {
      emitter.declare(`declare void @scr_error_install_${property}_reader(ptr)`);
      errorViews.push(
        `  call void @scr_error_install_${property}_reader(ptr @${mangleFunction(`%error.${property}.read`)})`,
      );
    }
  for (const meta of emitter.classMeta.values()) {
    if (meta.def.runtime || meta.root.def.name !== "%Error") continue;
    const type: IrType = { kind: "object", className: meta.def.name };
    const adapter = emitter.liveDynRefAdapter(type);
    const rc = vAdapters(emitter.shapeHost, type);
    const key = typeKey(type);
    const name = `sc_error_view_${errorViews.length}`;
    emitter.resolveThunkDefs.push(
      `define internal ptr @${name}(ptr %v) ${FN_ATTRS} {`,
      `entry:`,
      `  %d = call ptr ${typedRefConstructor(emitter.shapeHost, type)}(ptr %v, ptr ${rc.retain}, ptr ${rc.release}, ptr ${emitter.cstr(key)}, ${emitter.sizeType} ${Buffer.byteLength(key, "utf8")}, ptr @${adapter.snapshot}, ptr ${adapter.commit})`,
      `  ret ptr %d`,
      `}`,
      ``,
    );
    emitter.declare(`declare void @scr_error_register_dyn(ptr, ptr)`);
    errorViews.push(
      `  call void @scr_error_register_dyn(ptr @${mangleVtInstance(meta.def.name)}, ptr @${name})`,
    );
  }
  const layouts = emitLlvmLayouts(
    emitter.shapeHost,
    emitter.mod,
    emitter.classMeta,
    emitter.classObjs,
    emitter.fnByName,
    (t) => emitter.llType(t),
    emitter.nullableFields,
    emitter.int32Slots,
  );
  const shapes = layouts.records;
  const classShapes = layouts.classes;
  const classObjDefs = layouts.classObjects;
  const wrappers = emitter.emitFnValueDefs();
  const asyncDefs = emitter.emitAsyncScaffolding();
  const ffiCallbacks = emitter.emitFfiCallbackDefs();
  const hasNoInlineRecordClone = [...emitter.recordCloneShapes].some(
    (shapeId) => (emitter.recordsById.get(shapeId)?.fields.length ?? 0) >= 16,
  );

  // Module globals, FIRST OCCURRENCE per id: a class-expression static
  // instantiated through several mixin applications registers one global
  // id several times (2041-mixin-values) — C's tentative definitions
  // accept the duplicates without an error, LLVM rejects redefinition, so the
  // storage AND the release emit once per id here.
  const seenGlobalIds = new Set<string>();
  const globals = (emitter.mod.globals ?? []).filter((g) => {
    if (seenGlobalIds.has(g.id)) return false;
    seenGlobalIds.add(g.id);
    return true;
  });
  // Refcounted globals release before main returns — the runtime ABI’s
  // sc_release_globals, keeping the RC audit's live count exact. Built
  // before the declaration table flushes (it adds the release symbols).
  // Two spellings with distinct temp names: the normal exit and the
  // uncaught-exception exit are separate blocks of the same function.
  // Interned function-value closures are IMMORTAL (rc == SIZE_MAX), so
  // an own-property table Object.defineProperties hung on one would
  // outlive the RC audit — release it with the globals (the runtime ABI’s
  // sc_release_globals tail). Only when the dispatch unit is even
  // linked (defineProps is the only writer).
  const runtimeFeatures = emitter.runtimeFeatures;
  const fnValueProps = [...emitter.fnValues];
  if (fnValueProps.length > 0) emitter.declare(`declare void @scr_box_release(ptr)`);
  if (emitter.classObjs.size > 0)
    emitter.declare(`declare void @scr_classobj_clear_properties(ptr)`);
  const globalReleaseLines = (prefix: string): string[] => {
    const lines: string[] = [];
    globals.forEach((g, i) => {
      if (!isRefCounted(g.type)) return;
      lines.push(
        `  %${prefix}${i} = load ptr, ptr @${mangleGlobal(g.id)}`,
        `  call void ${releaseSym(emitter.shapeHost, g.type)}(ptr %${prefix}${i}) ; ${g.name}`,
      );
    });
    fnValueProps.forEach((name, i) => {
      // props sits at %ScrClosure field 3; release is NULL-tolerant —
      // cleared so a second release path stays idempotent.
      lines.push(
        `  %${prefix}fp${i} = load ptr, ptr getelementptr inbounds (%ScrClosure, ptr @${mangleFnClosure(name)}, i64 0, i32 3)`,
        `  call void @scr_box_release(ptr %${prefix}fp${i}) ; ${name}.props`,
        `  store ptr null, ptr getelementptr inbounds (%ScrClosure, ptr @${mangleFnClosure(name)}, i64 0, i32 3)`,
      );
    });
    for (const name of emitter.classObjs.keys())
      lines.push(`  call void @scr_classobj_clear_properties(ptr @${mangleClassObj(name)})`);
    return lines;
  };
  // Exit listeners can read MODULE GLOBALS directly, so they must run
  // BEFORE the global releases (the runtime ABI’s runExitListeners
  // ordering — the atexit half becomes an idempotent no-op).
  const usesEvents = runtimeFeatures.processEvents;
  const usesChildProcess = runtimeFeatures.childProcess;
  const usesFsWatch = runtimeFeatures.fsWatch;
  // Programs that call into Node record the libnode pack and its Node
  // version before %main (scr_node_island.c).
  const usesNodeIsland = runtimeFeatures.nodeIsland;
  // Stream-surface programs fill the loop's stream hook (the deferred
  // next-tick emissions) and the emitter's post-registration flow kick
  // before %main — scr_stream.c links only when the line is emitted
  // (native/executable.ts gates on the same predicate).
  const usesStream = runtimeFeatures.stream;
  // Net-surface programs fill the loop's net hooks (and the netSocket
  // handle-dispatch ops for the checked-dynamic boundary); http-surface
  // programs additionally stamp the httpReq/httpRes ops — the C main's
  // install lines, gated on the same predicates native/executable.ts links by.
  const usesNet = runtimeFeatures.net;
  const usesNetLookup = runtimeFeatures.netLookup;
  const usesDgram = runtimeFeatures.dgram;
  const usesHttp2 = runtimeFeatures.http2;
  const usesHttp = runtimeFeatures.http;
  // Fetch-referencing programs register native fetch before main.
  // Runtime selection compiles scr_fetch.c on the same predicate.
  const usesFetch = runtimeFeatures.fetch;
  const snapshotsTlsCa = runtimeFeatures.tls || runtimeFeatures.tlsCa;
  // The process verdict has the same precedence as the C reference
  // emitter: node:test owns the final status when present; otherwise an
  // embedded process.exitCode owns it; ordinary programs return zero.
  const usesNodeTest = runtimeFeatures.nodeTest;
  // Declared NOW — the extern block flushes before main assembles.
  if (usesEvents) emitter.declare(`declare void @scr_events_install()`);
  if (usesChildProcess) emitter.declare(`declare void @scr_child_dyn_install()`);
  const childStreamBoxes =
    usesChildProcess &&
    usesStream &&
    emitter.classMeta.has("%Readable") &&
    emitter.classMeta.has("%Writable")
      ? [
          emitter.dyn.toDynHelper({ kind: "object", className: "%Readable" }),
          emitter.dyn.toDynHelper({ kind: "object", className: "%Writable" }),
        ]
      : null;
  // worker.stdout and worker.stderr box the stream unit's Readable the
  // same way, and worker.stdin its Writable when the program has one
  // (scr_worker_stdio_install, scr_worker_events.c).
  const workerStdioBox =
    emitter.mod.workers === true && usesStream && emitter.classMeta.has("%Readable")
      ? (childStreamBoxes?.[0] ??
        emitter.dyn.toDynHelper({ kind: "object", className: "%Readable" }))
      : null;
  const workerStdinBox =
    emitter.mod.workers === true && usesStream && emitter.classMeta.has("%Writable")
      ? (childStreamBoxes?.[1] ??
        emitter.dyn.toDynHelper({ kind: "object", className: "%Writable" }))
      : null;
  if (childStreamBoxes || workerStdioBox || workerStdinBox) {
    emitter.declare(
      `@scr_stream_child_ops = external constant { ptr, ptr, ptr, ptr, ptr, ptr, ptr, ptr, ptr }`,
    );
  }
  if (childStreamBoxes)
    emitter.declare(`declare void @scr_child_dyn_streams_install(ptr, ptr, ptr)`);
  if (workerStdioBox || workerStdinBox)
    emitter.declare(`declare void @scr_worker_stdio_install(ptr, ptr, ptr)`);
  if (usesFsWatch) emitter.declare(`declare void @scr_watch_install()`);
  if (usesNodeIsland) emitter.declare(`declare void @scr_node_island_install(ptr, ptr)`);
  // Interned now: the C-string constants flush before main assembles.
  const nodeIslandConfig = usesNodeIsland
    ? [
        emitter.cstr(emitter.mod.nodeIsland?.libnode ?? ""),
        emitter.cstr(emitter.mod.nodeIsland?.nodeVersion ?? ""),
      ]
    : null;
  // The island module tree: its manifest, and its files unless they ship
  // beside the executable (node-islands/modules.ts).
  const nodeIslandModules = usesNodeIsland ? emitter.mod.nodeIsland?.modules : undefined;
  const nodeIslandModulesCall =
    nodeIslandModules === undefined ? null : nodeIslandModulesInstall(emitter, nodeIslandModules);
  if (emitter.ffiHasForeignCallback) emitter.declare(`declare void @scr_ffi_install()`);
  if (usesStream) emitter.declare(`declare void @scr_stream_install()`);
  if (usesNetLookup) emitter.declare(`declare void @scr_net_lookup_install()`);
  if (usesNet) {
    emitter.declare(`declare void @scr_net_install()`);
    emitter.declare(`declare void @scr_net_dyn_install()`);
  }
  if (usesDgram) emitter.declare(`declare void @scr_dgram_install()`);
  if (usesHttp2) emitter.declare(`declare void @scr_http2_dyn_install()`);
  if (usesHttp) emitter.declare(`declare void @scr_http_dyn_install()`);
  if (usesFetch) emitter.declare(`declare void @scr_fetch_install()`);

  if (usesNodeTest) {
    emitter.declare(`declare i32 @scr_test_exit_code()`);
    emitter.declare(`declare void @scr_test_init()`);
  }
  if (snapshotsTlsCa) {
    emitter.declare(`declare void @scr_tls_ca_install()`);
  }
  // Inline exit listeners run when something they must beat exists:
  // the refcounted-global releases, or the retained-FFI atexit ledger
  // sweep (a listener may legitimately release or pump a registration,
  // and only the inline call orders ahead of every atexit handler —
  // the runtime ABI’s runExitListeners stance). Plain event programs
  // with neither keep the atexit path, so their listener timing is
  // unchanged.
  const hasRefGlobals = globals.some((g) => isRefCounted(g.type)) || fnValueProps.length > 0;
  const inlineExitListeners =
    usesEvents && (emitter.mod.workers || hasRefGlobals || emitter.ffiHasRetainedCallback);
  emitter.declare(`declare i32 @scr_exit_code_hint_get()`);
  if (inlineExitListeners) {
    emitter.declare(`declare void @scr_run_exit_listeners(double)`);
    emitter.declare(`declare i32 @scr_exit_code_hint_get()`);
  }
  const exitListenerLines = (prefix: string): string[] => {
    if (!inlineExitListeners) return [];
    return [
      `  %${prefix}h = call i32 @scr_exit_code_hint_get()`,
      `  %${prefix}hd = sitofp i32 %${prefix}h to double`,
      `  call void @scr_run_exit_listeners(double %${prefix}hd)`,
    ];
  };
  // The entry's exits release the module globals only where the thread
  // frees its heap when its script ends (scr_exit_frees: workers, and
  // builds that check for leaks); the main thread of other builds leaves
  // it to the operating system.
  const exitReleaseLines = (prefix: string): string[] => {
    const releases = globalReleaseLines(prefix);
    if (releases.length === 0) return releases;
    emitter.declare(`declare zeroext i1 @scr_exit_frees()`);
    return [
      `  %${prefix}.frees = call zeroext i1 @scr_exit_frees()`,
      `  br i1 %${prefix}.frees, label %${prefix}.release, label %${prefix}.kept`,
      `${prefix}.release:`,
      ...releases,
      `  br label %${prefix}.kept`,
      `${prefix}.kept:`,
    ];
  };
  const globalReleases = exitReleaseLines("g");
  const asyncEntry = emitter.fnByName.get(emitter.mod.entry)?.async === true;
  const entryMayThrow = emitter.mayThrow.has(emitter.mod.entry);
  // The event loop runs when timers appeared OR any async/generator
  // function exists (the C main's hasAsync || hasGenerators ||
  // usesTimers gate). Generator programs run
  // the loop too: its exit accounting notes still-suspended generator
  // fibers as abandoned, so the RC audit downgrades exactly like the
  // async loop-exhaustion story.
  const runsLoop =
    emitter.usesTimers ||
    emitter.ffiHasForeignCallback ||
    emitter.mod.functions.some((f) => f.async === true || f.generator !== undefined);
  const uncaughtReleases = entryMayThrow && !asyncEntry ? exitReleaseLines("gu") : [];
  const loopReleasesU = runsLoop ? exitReleaseLines("gl") : [];
  const loopReleasesR = runsLoop ? exitReleaseLines("gr") : [];
  const topRejectReleases = asyncEntry ? exitReleaseLines("gt") : [];
  const topPendingReleases = asyncEntry ? exitReleaseLines("gp") : [];
  const loopReportedReleases = runsLoop ? exitReleaseLines("gq") : [];
  // main's epilogues read the flag / the loop entry points — declared
  // HERE, before the extern block flushes. They run once, so they keep
  // the out-of-line scr_exc_pending call; per-call checks inline the
  // test (pendingTestLines).
  if (entryMayThrow || runsLoop) emitter.declare(`declare zeroext i1 @scr_exc_pending()`);
  if (runsLoop) {
    emitter.declare(`declare zeroext i1 @scr_loop_run(ptr)`);
    if (emitter.mod.commonJsEntry === true)
      emitter.declare(`declare void @scr_loop_commonjs_entry()`);
    if (emitter.readsLoopMetrics()) emitter.declare(`declare void @scr_perf_loop_mark()`);
    emitter.declare(`declare zeroext i1 @scr_report_unhandled_rejections()`);
    emitter.declare(`declare void @scr_discard_unhandled_rejections()`);
  }
  if (asyncEntry) {
    emitter.declare(`declare i32 @scr_promise_finish_top_level(ptr)`);
    emitter.declare(`declare void @scr_promise_rethrow_top_level(ptr)`);
    emitter.declare(`declare void @scr_promise_release(ptr)`);
    emitter.declare(`declare void @scr_exit_code_note(i32)`);
  }
  const topPendingExitLines = (): string[] => {
    if (!asyncEntry) return [];
    const lines: string[] = [];
    // finish_top_level noted 13 unless the program set process.exitCode.
    // A failed node:test run outranks either before exit listeners run.
    if (usesNodeTest) {
      lines.push(
        `  %tla_program_exit = call i32 @scr_test_exit_code()`,
        `  %tla_program_exit_zero = icmp eq i32 %tla_program_exit, 0`,
        `  %tla_hint = call i32 @scr_exit_code_hint_get()`,
        `  %tla_exit_status = select i1 %tla_program_exit_zero, i32 %tla_hint, i32 %tla_program_exit`,
        `  call void @scr_exit_code_note(i32 %tla_exit_status)`,
      );
    }
    for (const line of exitListenerLines("xp")) lines.push(line);
    for (const line of topPendingReleases) lines.push(line);
    // An exit listener may set process.exitCode again, as in Node.
    lines.push(`  %tla_exit_code = call i32 @scr_exit_code_hint_get()`, `  ret i32 %tla_exit_code`);
    return lines;
  };
  // LIBRARY mode: the runtime entry points the generated library
  // symbols delegate to — declared before the extern block flushes.
  if (emitter.mod.lib !== undefined) {
    if (emitter.wasi) {
      emitter.declare(`declare ptr @malloc(${emitter.sizeType})`);
      emitter.declare(`declare void @free(ptr)`);
    }
    emitter.declare(`declare void @scr_library_entry(i1 zeroext, ptr)`);
    emitter.declare(`declare void @scr_library_reset()`);
    emitter.declare(`declare void @scr_library_check_exc()`);
    emitter.declare(`declare void @scr_library_set_sink(ptr, ptr)`);
    emitter.declare(`declare void @scr_library_callback_entry_guard(ptr)`);
    emitter.declare(`declare void @scr_library_arena_reset()`);
    emitter.declare(`declare void @scr_library_collect()`);
    if ((emitter.mod.lib.callbacks?.length ?? 0) > 0) {
      // Host-callback channels: the registration define's dispatch
      // (strcmp over the declared names + the runtime slot store).
      // The call-site fetch pair (scr_library_cb_require/_ctx) is
      // declared at ffiCall emission like every body-driven runtime
      // symbol.
      emitter.declare(`declare void @scr_library_cb_set(${emitter.sizeType}, ptr, ptr)`);
      emitter.declare(`declare i32 @strcmp(ptr, ptr)`);
    }
    if (emitter.mod.lib.exports.some((e) => e.params.includes("string"))) {
      emitter.declare(`declare ptr @scr_library_str_in(ptr, ${emitter.sizeType})`);
    }
    if (emitter.mod.lib.exports.some((e) => e.params.includes("bytes"))) {
      emitter.declare(`declare ptr @scr_library_bytes_in(ptr, ${emitter.sizeType}, ptr)`);
    }
    if (emitter.mod.lib.exports.some((e) => e.params.includes("i64"))) {
      emitter.declare(`declare double @scr_library_i64_in(i64, ptr)`);
    }
    if (emitter.mod.lib.exports.some((e) => e.params.includes("u64"))) {
      emitter.declare(`declare double @scr_library_u64_in(i64, ptr)`);
    }
    if (emitter.mod.lib.exports.some((e) => e.returns === "string")) {
      emitter.declare(`declare void @scr_library_str_out(ptr, ptr, ptr)`);
    }
    if (emitter.mod.lib.exports.some((e) => e.returns === "bytes")) {
      emitter.declare(`declare void @scr_library_bytes_out(ptr, ptr, ptr)`);
    }
    if (emitter.mod.lib.exports.some((e) => e.params.includes("cstring"))) {
      emitter.declare(`declare ptr @scr_library_cstr_in(ptr, ptr)`);
    }
    if (emitter.mod.lib.exports.some((e) => e.returns === "cstring")) {
      emitter.declare(`declare ptr @scr_library_cstr_out(ptr)`);
    }
  }
  // Helpers assemble BEFORE the declaration table flushes (they add
  // write/abort declarations).
  const helpers = [
    ...emitter.helperDefs(),
    ...emitArraySearchHelpers(emitter.arraySearchKinds, emitter.sizeType, (line) =>
      emitter.declare(line),
    ),
    ...emitClassMembershipHelper(emitter.classMeta, emitter.sizeType),
    ...(emitter.publishWalkersCache?.defs() ?? []),
    ...emitter.publishedClassNamesDefs(),
    ...(emitter.regions?.moduleDefs() ?? []),
  ];
  if (emitter.constantNumericTables.size > 0)
    emitter.declare(`declare double @scr_arr_get_number(ptr, double)`);
  // Native matchers of the regex literals inside the compiled subset.
  const regexMatchers = new Map<string, RegexMatcherCode>();
  for (const [key, re] of emitter.regexInstances) {
    const code = compileRegexMatcher(
      `${re.sym}_match`,
      re.pattern,
      re.flags,
      emitter.sizeType,
      !emitter.wasi,
    );
    if (code === null) continue;
    regexMatchers.set(key, code);
    for (const decl of code.decls) emitter.declare(decl);
  }

  const out: string[] = [
    `; Generated by scriptc (LLVM backend) from ${emitter.mod.sourceFile}. Do not edit.`,
    ``,
    // Type shapes shared with the runtime's C ABI. ScrStr is the header
    // prefix only (the flexible-array tail is concrete per literal);
    // ScrLogArg is { i32 tag; 8-byte union } — i64 at offset 8 matches
    // the C layout (4 bytes padding after the tag). ScrUnion/ScrClosure
    // mirror scr_runtime.h field-for-field (tag reads, slot peeks, the
    // fn pointer, and the caps[] tail all address through them).
    `%ScrStr = type { ${emitter.sizeType}, ${emitter.sizeType}, ${emitter.sizeType} }`,
    `%ScrLogArg = type { i32, i64 }`,
    `%ScrVt = type { ${emitter.sizeType}, ${emitter.sizeType}, ptr }`,
    `%ScrUnion = type { ${emitter.sizeType}, i32, ptr, ptr, ptr, i64 }`,
    `%ScrClosure = type { ${emitter.sizeType}, ptr, ${emitter.sizeType}, ptr, i32, i32, ptr, ptr }`,
    `%ScrFfiTable = type { ptr, ${emitter.sizeType}, ${emitter.sizeType}, ptr, i8, ptr, ptr, ${emitter.sizeType}, ${emitter.sizeType}, ${emitter.sizeType}, ptr, ptr }`,
    `%ScrRegex = type { ${emitter.sizeType}, ptr, ptr, ptr, double, ptr, ptr, ptr }`,
    // ScrArr mirrors scr_runtime.h field-for-field: { rc, len (i32), cap
    // (i32), elem, cyc, spare, filled, data } (field numbers in
    // SCR_ARR_FIELD), where the dense states follow the cap value slots at
    // data, filled bounds the hole-free prefix, and spare holds the storage
    // flags and the registry id of the element type's RC descriptor
    // (%ScrArrOps, SCR_ELEM_REF only; the runtime assigns ids). An array
    // with out-of-line sparse, property or metadata storage keeps a pointer
    // to it in the word before its dense allocation. Live dynamic stream
    // commits swap its dense, presence and out-of-line storage while
    // preserving the target object's identity.
    `%ScrArr = type { ${emitter.sizeType}, i32, i32, i8, i8, i16, i32, ptr }`,
    `%ScrArrOps = type { ptr, ptr, ptr, i32 }`,
    // The ScrMap prefix { rc, key_kind, val_kind, traced } — the inline
    // RC fast paths test the traced byte (shapes.ts).
    ...(emitter.rcHelpers === null ? [] : [`%ScrMapRc = type { ${emitter.sizeType}, i8, i8, i8 }`]),
    // The complete ScrMap and its entries, read by the inline number-key
    // lookup (sc_map_entry_f64), the inline iteration steps
    // (sc_map_iter_entry, sc_map_iter_entry_num) and Map.size
    // (sc_map_size): field 8 is the i32 entry count, field 9 the i32 live
    // count, field 10 the i64 absent-key filter, entries is field 11,
    // nbuckets and buckets fields 13 and 14, the direct index and its i32
    // length fields 15 and 16.
    ...(emitter.decls.has(NUMBER_MAP_ENTRY_DECL) ||
    emitter.decls.has(STRING_MAP_ENTRY_DECL) ||
    emitter.decls.has(STRING_MAP_ENTRY_C_DECL) ||
    emitter.decls.has(MAP_ITER_DECL) ||
    emitter.decls.has(MAP_ITER_NUM_DECL) ||
    emitter.decls.has(MAP_SIZE_DECL)
      ? [
          `%ScrMapIx = type { ${emitter.sizeType}, i8, i8, i8, i8, i32, ptr, ptr, i32, i32, i64, ptr, i32, i32, ptr, ptr, i32, i32 }`,
        ]
      : []),
    // The { key, val, hash } entry of every map but a number-key one, whose
    // entry is { key, val } (scr_map.h ScrMapNumEntry). String-keyed
    // reference reads load the value slot of the entry scr_map_entry_str
    // returns (map-number-lookup.ts).
    ...(emitter.decls.has(NUMBER_MAP_ENTRY_DECL) ||
    emitter.decls.has(STRING_MAP_ENTRY_DECL) ||
    emitter.decls.has(MAP_ITER_DECL) ||
    emitter.decls.has(MAP_ITER_NUM_DECL)
      ? [`%ScrMapEntry = type { i64, i64, i64 }`, `%ScrMapNumEntry = type { i64, i64 }`]
      : []),
    // A compact-value map's { key, hash, val } entry (scr_map.h ScrMapCEntry):
    // a 32-bit hash and the value as an address over 8.
    ...(emitter.decls.has(STRING_MAP_ENTRY_C_DECL)
      ? [`%ScrMapCEntry = type { i64, i32, i32 }`]
      : []),
    // The runtime error prefix { rc, vt, name, message, code, cause } and the
    // class-object shape { rc, pre, post, ctor, name } — field reads on
    // builtin errors and classval loads GEP through these.
    `%ScrError = type { ${emitter.sizeType}, ptr, ptr, ptr, ptr, ptr, i8, i8, i8, i8, i8, ptr, ptr }`,
    `%ScrClassObj = type { ${emitter.sizeType}, ${emitter.sizeType}, ${emitter.sizeType}, ptr, ptr, ${emitter.sizeType}, ${emitter.sizeType}, ptr, ptr, ptr, ${emitter.sizeType} }`,
    // The runtime emitter prefix { rc, vt, reg, cls } — user subclasses
    // embed it (classes.ts), and bare-emitter GEPs address through it.
    `%ScrEmitter = type { ${emitter.sizeType}, ptr, ptr, ptr }`,
    // The runtime stream layout { rc, vt, reg, cls, st } — one struct
    // for all five stream classes; stream subclasses embed it.
    `%ScrStream = type { ${emitter.sizeType}, ptr, ptr, ptr, ptr }`,
    // The EventTarget and Event subclass prefixes { rc, vt, state, cls }.
    ...(emitter.classMeta.has(RUNTIME_EVENT_TARGET_CLASS)
      ? [`%ScrEventTargetObj = type { ${emitter.sizeType}, ptr, ptr, ptr }`]
      : []),
    ...(emitter.classMeta.has(RUNTIME_EVENT_CLASS)
      ? [`%ScrEventObj = type { ${emitter.sizeType}, ptr, ptr, ptr }`]
      : []),
    // The catch-binding snapshot box { rc, kind, f64, b, payload,
    // retain_fn, release_fn, trace_fn } — caughtTest kind reads and
    // caughtNarrow payload extraction GEP through it (offsets match
    // scr_runtime.h's natural alignment: kind at 8, f64 at 16, b at 24,
    // payload at 32).
    `%ScrCaught = type { ${emitter.sizeType}, i32, double, i8, ptr, ptr, ptr, ptr }`,
    // ScrBytes { rc, len, elem(i32+pad), data, backing, brands, shared }. Indexed
    // typed-array access GEPs through this directly: the IR type already
    // fixes elem, so the hot path needs neither a runtime kind load nor
    // the generic scr_bytes_get/set call.
    `%ScrBytes = type { ${emitter.sizeType}, ${emitter.sizeType}, i32, ptr, ptr, i8, i8, i8, i8, ptr }`,
    // The capture box { rc, kind, obj_retain, obj_release, obj_trace,
    // slot } — TDZ reads peek the payload slot (offset 40) directly.
    `%ScrBox = type { ${emitter.sizeType}, i32, ptr, ptr, ptr, i64 }`,
    // The stack buffer of the emitted JSON serializers { data, len, cap }.
    `%ScrJsonBuf = type { ptr, ${emitter.sizeType}, ${emitter.sizeType}, ptr, ${emitter.sizeType}, ${emitter.sizeType} }`,
    // The dynCheck error-path spine { parent, key, index } — the emitted
    // builders stack-allocate one per recursion level (dyn.ts).
    `%ScrDynPath = type { ptr, ptr, ${emitter.sizeType} }`,
    `%ScrIslandModule = type { ptr, ptr, ${emitter.sizeType}, ${emitter.sizeType}, i32, ptr, ${emitter.sizeType}, ${emitter.sizeType} }`,
    `%ScrIslandEdge = type { ptr, ptr, ptr, i32 }`,
    // A generator's prefix { rc, receiver, fiber, state, out } and its
    // value slot { kind, f64, b, payload, release_fn } (scr_async.c pins
    // both): number and boolean yields and drives address OUT directly.
    ...(emitter.usesGenSlots
      ? [
          `%ScrGenSlot = type { i32, double, i8, ptr, ptr }`,
          `%ScrGenHead = type { ${emitter.sizeType}, ptr, ptr, i32, %ScrGenSlot }`,
        ]
      : []),
  ];
  for (const line of shapes.typeDefs) out.push(line);
  for (const line of classShapes.typeDefs) out.push(line);
  // Thread-instanced library state (abi.instance_per_thread): the
  // program TU's mutable globals — module globals, run-once guards, the
  // lazily-compiled regex literal caches — and the runtime globals its
  // init stamps live in thread-local storage, matching the runtime
  // objects compiled with -DSCR_THREAD_INSTANCES. Immutable interned
  // data (string literals, unit arms, template arrays, vtables) stays
  // shared.
  const tl =
    emitter.mod.workers === true || emitter.mod.lib?.threadInstances === true
      ? "thread_local "
      : "";
  out.push(
    ``,
    `@scr_error_vts = external ${tl}global [${RUNTIME_ERROR_CLASSES.size} x %ScrVt]`,
    `declare void @scr_init()`,
    ...(emitter.compactRegion ? [`declare void @scr_plr_init()`] : []),
    `declare void @scr_lib_init(i32, ptr)`,
    ...(emitter.mod.workers ? [`declare void @scr_runtime_workers_v8()`] : []),
    ...(emitter.stackChecks?.size ? [`declare void @scr_stack_guard_init()`] : []),
    ...(emitter.runtimeAbiMarker && emitter.mod.lib === undefined
      ? [`declare void @${RUNTIME_ABI_MARKER}()`]
      : []),
    // Overrides the runtime's weak default (scr_lib.c).
    ...(emitter.detachedExit && emitter.mod.lib === undefined
      ? [`@scr_detached_exit = constant i8 1`]
      : []),
  );
  for (const d of emitter.decls) out.push(d);
  out.push(``);
  const flushedDecls = new Set(emitter.decls);
  {
    const tl =
      emitter.mod.workers === true || emitter.mod.lib?.threadInstances === true
        ? "thread_local "
        : "";
    out.push(...threadSlotsBlockDefinitions(emitter.threadSlotsBlocks, tl !== ""));
    for (let site = 0; site < emitter.dynReadIcSites; site++)
      out.push(
        `@sc_dyn_read_ic_${site} = internal ${tl}global { ptr, ${emitter.sizeType}, ${emitter.sizeType}, ptr } zeroinitializer`,
      );
    for (let site = 0; site < emitter.jsIcSiteCount; site++)
      out.push(`@sc_js_ic_${site} = internal ${tl}global [${JS_IC_WORDS} x i64] zeroinitializer`);
  }
  if (nodeIslandModulesCall !== null) out.push(...nodeIslandModulesCall.globals);
  for (const table of emitter.constantNumericTables.values()) {
    const n = table.values.length;
    let tableTmp = 0;
    const tableIndex = exactIndexLines("%i", String(n), "i64", () => `%ix${tableTmp++}`);
    out.push(
      `@${table.symbol} = private constant [${n} x double] [${table.values.map((v) => `double ${f64Lit(v)}`).join(", ")}]`,
      `define internal double @${table.symbol}_get(ptr %a, double %i) alwaysinline #0 {`,
      `entry:`,
      `  %initialized = icmp ne ptr %a, null`,
      ...tableIndex.lines.map((line) => `  ${line}`),
      `  %safe = and i1 %initialized, ${tableIndex.ok}`,
      `  br i1 %safe, label %read, label %fallback`,
      `read:`,
      `  %slot = getelementptr inbounds [${n} x double], ptr @${table.symbol}, i64 0, i64 ${tableIndex.wide}`,
      `  %value = load double, ptr %slot`,
      `  ret double %value`,
      `fallback:`,
      `  %generic = call double @scr_arr_get_number(ptr %a, double %i)`,
      `  ret double %generic`,
      `}`,
      ``,
    );
  }
  for (const [text, lit] of emitter.literals) {
    // Immortal interned ScrStr: { rc = SIZE_MAX, len, cap = len, bytes\0 } —
    // the runtime ABI’s static table, retain/release skip rc == SIZE_MAX.
    // 64-bit (little-endian) targets split the capacity word: the high
    // half carries the precomputed Map key hash (SCR_STR_HASH_CACHE).
    // Bit 31 marks all-ASCII literals (SCR_STR_ASCII_BIT) on every target.
    const capWord =
      emitter.sizeType === "i64"
        ? literalCapWord(wtf8Bytes(text))
        : literalCapWord32(wtf8Bytes(text));
    out.push(
      `@${lit.sym} = internal global { ${emitter.sizeType}, ${emitter.sizeType}, ${emitter.sizeType}, [${lit.len + 1} x i8] } ` +
        `{ ${emitter.sizeType} -1, ${emitter.sizeType} ${lit.len}, ${emitter.sizeType} ${capWord}, [${lit.len + 1} x i8] c"${llStrBytes(text)}" }`,
    );
  }
  if (emitter.literals.size > 0) out.push(``);
  for (const lit of emitter.bigintLiterals.values()) {
    // Immortal ScrBigInt: { rc = SIZE_MAX, len, sign, cap, limbs } with
    // pointer-sized little-endian limbs (scr_bigint.c); zero keeps one
    // zero limb so limb 0 is always readable.
    const size = emitter.sizeType;
    const limbBits = size === "i64" ? 64n : 32n;
    const mask = (1n << limbBits) - 1n;
    const limbs: string[] = [];
    for (let m = lit.value < 0n ? -lit.value : lit.value; m > 0n; m = m >> limbBits) {
      limbs.push(`${size} ${m & mask}`);
    }
    const len = limbs.length;
    if (len === 0) limbs.push(`${size} 0`);
    const sign = lit.value < 0n ? -1 : lit.value > 0n ? 1 : 0;
    out.push(
      `@${lit.sym} = internal global { ${size}, ${size}, i32, i32, [${limbs.length} x ${size}] } ` +
        `{ ${size} -1, ${size} ${len}, i32 ${sign}, i32 ${limbs.length}, [${limbs.length} x ${size}] [${limbs.join(", ")}] }`,
    );
  }
  if (emitter.bigintLiterals.size > 0) out.push(``);
  for (const [key, sym] of emitter.unitInstances) {
    // One immortal instance per unit-armed (union, tag): tag set, payload
    // slot and RC entry points zero — retain/release/collector all skip
    // rc == SIZE_MAX, so these never join the RC audit or a trace walk.
    const [unionId, tag] = key.split(":");
    out.push(
      `@${sym} = internal global %ScrUnion { ${emitter.sizeType} -1, i32 ${tag}, ptr null, ptr null, ptr null, i64 0 } ; ${unionId} unit arm`,
    );
  }
  if (emitter.unitInstances.size > 0) out.push(``);
  for (const [unionId, sym] of emitter.retypeGuards) {
    // Thread-local like module globals: a thread's cast caches hold only
    // its own boxes. Never written, the flag folds to false.
    out.push(`@${sym} = internal ${tl}global i8 0 ; ${unionId} boxes in a cast cache`);
  }
  if (emitter.retypeGuards.size > 0) out.push(``);
  for (const [unionId, sym] of emitter.absentInstances) {
    // One immortal ABSENT field-slot instance per undefined-armed union:
    // the undefined arm's tag with payload 1 (ordinary unit instances
    // carry 0). Every tag reader sees undefined; recordHas and the
    // field reads compare tag and payload, never the address, so the
    // per-object copies of separately compiled units agree.
    const tag = undefinedArmTag({ kind: "union", unionId }, emitter.unionsById);
    out.push(
      `@${sym} = internal global %ScrUnion { ${emitter.sizeType} -1, i32 ${tag}, ptr null, ptr null, ptr null, i64 ${ABSENT_FIELD_PAYLOAD} } ; ${unionId} absent field`,
    );
  }
  if (emitter.absentInstances.size > 0) out.push(``);
  if (emitter.needsUnionNone)
    out.push(
      `@sc_union_none = internal constant %ScrUnion zeroinitializer ; NULL union dummy read by inline stores`,
      ``,
    );
  if (emitter.nullableUnions.usesNullSentinel) {
    // `null` in every `C | null | undefined` union (NULL is undefined):
    // one module-scope immortal object like the ABSENT sentinel.
    const S = emitter.sizeType;
    out.push(
      `${NULLABLE_NULL} = internal global { ${S}, ${S}, ${S}, ${S} } { ${S} -1, ${S} 0, ${S} 0, ${S} 0 } ; nullable null arm`,
      ``,
    );
  }
  if (emitter.needsNullableAbsent) {
    // The ABSENT field-slot state of every nullable-pointer union: one
    // module-scope immortal object (rc == SIZE_MAX), distinct from NULL
    // (undefined) and from every instance. RC entry points and the
    // collector skip it like any immortal; field reads compare its address.
    const S = emitter.sizeType;
    out.push(
      `${NULLABLE_ABSENT} = internal global { ${S}, ${S}, ${S}, ${S} } { ${S} -1, ${S} 0, ${S} 0, ${S} 0 } ; nullable absent field`,
      ``,
    );
  }
  for (const [key, re] of emitter.regexInstances) {
    // One immortal ScrRegex per (pattern, flags) literal, pointing at
    // the interned source/flags strings. The bc and translated-program
    // slots start null (lazy compile, cached by the runtime) — a mutable
    // global, not constant. The last slot is the build-time matcher.
    const matcher = regexMatchers.has(key) ? `@${re.sym}_match` : "null";
    out.push(
      `@${re.sym} = internal ${tl}global %ScrRegex { ${emitter.sizeType} -1, ptr ${re.src}, ptr ${re.fl}, ptr null, double 0.0, ptr null, ptr null, ptr ${matcher} } ; ${key.replace(/\n/g, "\\n")}`,
    );
  }
  if (emitter.regexInstances.size > 0) out.push(``);
  for (const code of regexMatchers.values()) out.push(...code.lines, ``);
  for (const [, inst] of emitter.templateStringsInstances) {
    // One immortal ScrArr per tagged-template site: a data global of
    // interned cooked-string literals, and the ScrArr header over it
    // (rc == SIZE_MAX, len == cap == filled, SCR_ELEM_STR = 2, no REF entry
    // points, no state bytes: every dense slot is present). Reads retain
    // immortal strings — a no-op. Slots are 8 bytes on every target: on
    // 32-bit targets each holds the pointer in its low half and zero in its
    // high half.
    const n = inst.slots.length;
    const wide = emitter.sizeType === "i64";
    const slot = wide ? "ptr" : "<{ ptr, i32 }>";
    const slotValue = (s: string): string =>
      wide ? `ptr ${s}` : `<{ ptr, i32 }> <{ ptr ${s}, i32 0 }>`;
    out.push(
      `@${inst.sym}_data = internal constant [${n} x ${slot}] [ ${inst.slots.map(slotValue).join(", ")} ], align 8`,
      `@${inst.sym} = internal global %ScrArr { ${emitter.sizeType} -1, i32 ${n}, i32 ${n}, i8 2, i8 0, i16 0, i32 ${n}, ptr @${inst.sym}_data }`,
    );
  }
  if (emitter.templateStringsInstances.size > 0) out.push(``);
  for (const [text, c] of emitter.cstrs) {
    // NUL-terminated byte-array constants for scr_jb_puts and indentation.
    out.push(`@${c.sym} = internal constant [${c.len + 1} x i8] c"${llStrBytes(text)}"`);
  }
  if (emitter.cstrs.size > 0) out.push(``);
  for (const [body, sym] of emitter.mapOpsConsts) {
    out.push(`@${sym} = internal constant { ptr, ptr, ptr, ptr, ptr, ptr, ptr } { ${body} }`);
  }
  if (emitter.mapOpsConsts.size > 0) out.push(``);
  for (const sym of emitter.methodIdSlots.values()) out.push(`@${sym} = internal global i32 -1`);
  if (emitter.methodIdSlots.size > 0) out.push(``);

  for (const line of ffiCallbacks.globals) out.push(line);
  if (ffiCallbacks.globals.length > 0) out.push(``);
  for (const g of globals) {
    const ty = emitter.llType(g.type);
    const zero = ty === "double" ? f64Lit(0) : ty === "ptr" ? "null" : "false";
    const debug = emitter.debug?.global(g);
    out.push(
      `@${mangleGlobal(g.id)} = internal ${tl}global ${ty} ${zero}${debug ? `, !dbg ${debug}` : ""} ; ${g.name}`,
    );
  }
  if (globals.length > 0) out.push(``);
  for (const line of helpers) out.push(line);
  for (const line of ffiCallbacks.defs) out.push(line);
  for (const line of shapes.defs) out.push(line);
  for (const line of classShapes.defs) out.push(line);
  for (const line of classObjDefs) out.push(line);
  for (const line of emitter.walkers.defs) out.push(line);
  for (const line of emitter.dyn.defs) out.push(line);
  for (const line of wrappers) out.push(line);
  for (const line of asyncDefs) out.push(line);
  for (const line of emitter.resolveThunkDefs) out.push(line);
  out.push(fnDefs[0] ?? "");
  for (let i = 1; i < fnDefs.length; i++) out.push("", fnDefs[i]!);
  out.push("");
  // WebAssembly modules translated into this program, and the registry.
  for (const line of emitWasmModules(emitter.mod, flushedDecls, emitter.wasmBoundsChecks))
    out.push(line);

  // main(): scr_init, the program-dependent error-vt interval stamps,
  // scr_lib_init(argc, argv), then the entry function. An uncaught
  // exception escaping top-level code prints and exits 1 (Node).
  // The exception epilogue is emitted when the entry may throw.
  const stamps: string[] = [...errorViews];
  for (const iv of emitter.errorIntervals) {
    const fields: [number, number][] = [
      [0, iv.pre],
      [1, iv.post],
    ];
    for (const [field, value] of fields) {
      stamps.push(
        `  store ${emitter.sizeType} ${value}, ptr getelementptr inbounds ([${RUNTIME_ERROR_CLASSES.size} x %ScrVt], ptr @scr_error_vts, i64 0, i64 ${iv.kind}, i32 ${field})${field === 1 ? ` ; ${iv.lib}` : ""}`,
      );
    }
  }
  if (emitter.emitterInterval !== null) {
    // The runtime emitter vtable's interval (emitterVtStampLines): bare
    // EventEmitter instances answer instanceof and dispatch dynamic
    // teardown under THIS module's preorder numbering.
    out.push(`@scr_emitter_vt = external ${tl}global %ScrVt`, ``);
    stamps.push(
      `  store ${emitter.sizeType} ${emitter.emitterInterval.pre}, ptr getelementptr inbounds (%ScrVt, ptr @scr_emitter_vt, i64 0, i32 0)`,
      `  store ${emitter.sizeType} ${emitter.emitterInterval.post}, ptr getelementptr inbounds (%ScrVt, ptr @scr_emitter_vt, i64 0, i32 1) ; EventEmitter`,
    );
  }
  for (const iv of emitter.streamIntervals) {
    // The runtime stream vtables' intervals (streamVtStampLines) — the
    // emitter story: instanceof and dynamic teardown dispatch through
    // them.
    out.push(`@${iv.vt} = external ${tl}global %ScrVt`);
    stamps.push(
      `  store ${emitter.sizeType} ${iv.pre}, ptr getelementptr inbounds (%ScrVt, ptr @${iv.vt}, i64 0, i32 0)`,
      `  store ${emitter.sizeType} ${iv.post}, ptr getelementptr inbounds (%ScrVt, ptr @${iv.vt}, i64 0, i32 1) ; ${iv.lib}`,
    );
  }
  if (emitter.streamIntervals.length > 0) out.push(``);
  if ([...emitter.literals.keys(), ...emitter.cstrs.keys()].some(hasLoneSurrogate)) {
    // The runtime skips surrogate work until a lone surrogate may exist
    // (scr_wtf8_any); its own producers note one, and literals do here.
    out.push(`declare void @scr_wtf8_note()`, ``);
    stamps.push(`  call void @scr_wtf8_note()`);
  }
  if (emitter.errorIntervals.length > 0 && emitter.tracedShapes.has("object:%Error")) {
    // The cycle fixpoint marked the Error hierarchy (a user subclass
    // holds cycle-capable fields — capability is hierarchy-uniform), so
    // the runtime's own error allocations need collector headers too.
    // Declared inline: the extern block already flushed (LLVM is
    // order-free, the helper-defs precedent).
    out.push(`declare void @scr_error_set_traced()`, ``);
    stamps.push(`  call void @scr_error_set_traced()`);
  }
  if ((entryMayThrow || runsLoop) && emitter.mod.lib === undefined) {
    // Declared inline: the extern block already flushed (LLVM is
    // order-free — the scr_error_set_traced precedent). Only the
    // printer emits here (nothing else declares it); scr_exc_pending
    // and the loop entry points rode the Set before the flush.
    out.push(
      `declare void @scr_exc_print_uncaught()`,
      `declare zeroext i1 @scr_exc_handle_uncaught(i1 zeroext)`,
      ``,
    );
  }
  if (emitter.mod.lib !== undefined) {
    // LIBRARY mode: no @main — the profile-declared external
    // symbols specified by the library IR instead.
    for (const line of emitter.emitLibDefs(globals, globalReleaseLines, stamps)) out.push(line);
    out.push(...emitter.inlineRcTail(flushedDecls));
    out.push(...functionAttributes(emitter, hasNoInlineRecordClone));
    out.push(``);
    out.push(...emitter.fieldAliasMetadata());
    if (emitter.debug !== null) out.push(emitter.debug.render());
    return out;
  }
  out.push(
    `define i32 @${emitter.mod.workers ? "sc_context_entry" : emitter.wasi ? "__main_argc_argv" : "main"}(i32 %argc, ptr %argv) ${FN_ATTRS} {`,
    `entry:`,
    ...(emitter.runtimeAbiMarker ? [`  call void @${RUNTIME_ABI_MARKER}()`] : []),
    ...(emitter.mod.workers ? [`  call void @scr_runtime_workers_v8()`] : []),
    `  call void @scr_init()`,
    // Compressed fields hold addresses in the program-lifetime region, which
    // is reserved below 32 GiB before compiled code runs.
    ...(emitter.compactRegion ? [`  call void @scr_plr_init()`] : []),
    // Each context (the main thread, every worker) installs its stack
    // guard before running compiled code that checks it.
    ...(emitter.stackChecks?.size ? [`  call void @scr_stack_guard_init()`] : []),
    ...stamps,
    // Event-surface programs (signal/exit listeners) fill the loop's
    // nullable event hooks before %main — scr_events.c links only when
    // this line is emitted (native/executable.ts gates on the same predicate).
    ...(usesEvents ? [`  call void @scr_events_install()`] : []),
    ...(usesChildProcess ? [`  call void @scr_child_dyn_install()`] : []),
    ...(childStreamBoxes
      ? [
          `  call void @scr_child_dyn_streams_install(ptr @scr_stream_child_ops, ptr @${childStreamBoxes[0]}, ptr @${childStreamBoxes[1]})`,
        ]
      : []),
    ...(workerStdioBox || workerStdinBox
      ? [
          `  call void @scr_worker_stdio_install(ptr @scr_stream_child_ops, ptr ${workerStdioBox ? `@${workerStdioBox}` : "null"}, ptr ${workerStdinBox ? `@${workerStdinBox}` : "null"})`,
        ]
      : []),
    // fs.watch programs fill the loop's watch hooks the same way —
    // scr_watch.c links only when this line is emitted.
    ...(usesFsWatch ? [`  call void @scr_watch_install()`] : []),
    ...(nodeIslandConfig
      ? [
          `  call void @scr_node_island_install(ptr ${nodeIslandConfig[0]}, ptr ${nodeIslandConfig[1]})`,
        ]
      : []),
    ...(nodeIslandModulesCall === null ? [] : [nodeIslandModulesCall.call]),
    ...(emitter.ffiHasForeignCallback ? [`  call void @scr_ffi_install()`] : []),
    ...(snapshotsTlsCa ? [`  call void @scr_tls_ca_install()`] : []),
    ...(usesFetch ? [`  call void @scr_fetch_install()`] : []),
    ...(usesNet ? [`  call void @scr_net_install()`, `  call void @scr_net_dyn_install()`] : []),
    ...(usesNetLookup ? [`  call void @scr_net_lookup_install()`] : []),
    ...(usesHttp ? [`  call void @scr_http_dyn_install()`] : []),
    ...(usesDgram ? [`  call void @scr_dgram_install()`] : []),
    ...(usesHttp2 ? [`  call void @scr_http2_dyn_install()`] : []),
    ...(usesStream ? [`  call void @scr_stream_install()`] : []),
    `  call void @scr_lib_init(i32 %argc, ptr %argv)`,
    // node:test takes Node's --test-update-snapshots out of argv first.
    ...(usesNodeTest ? [`  call void @scr_test_init()`] : []),
    ...(asyncEntry
      ? [`  %top = call ptr @${mangleAsyncSpawn(emitter.mod.entry)}()`]
      : [`  call void @${mangleFunction(emitter.mod.entry)}()`]),
    // Uncaught exception from top-level code: Node exits 1.
    ...(entryMayThrow && !asyncEntry
      ? [
          `  %exc = call zeroext i1 @scr_exc_pending()`,
          `  br i1 %exc, label %uncaught, label %ok`,
          `uncaught:`,
          `  %handled = call zeroext i1 @scr_exc_handle_uncaught(i1 false)`,
          `  br i1 %handled, label %ok, label %fatal`,
          `fatal:`,
          `  call void @scr_exc_print_uncaught()`,
          ...exitListenerLines("xu"),
          ...uncaughtReleases,
          `  %failure_code_0 = call i32 @scr_exit_code_hint_get()`,
          `  ret i32 %failure_code_0`,
          `ok:`,
        ]
      : []),
    // The event loop runs to exhaustion (microtasks before timers). A
    // throw escaping a timer callback and unhandled promise rejections
    // both exit 1, like Node — the C main's loop block exactly.
    ...(runsLoop
      ? [
          ...(emitter.mod.commonJsEntry === true ? [`  call void @scr_loop_commonjs_entry()`] : []),
          // performance.eventLoopUtilization measures from here on.
          ...(emitter.readsLoopMetrics() ? [`  call void @scr_perf_loop_mark()`] : []),
          `  %loop_rejection = call zeroext i1 @scr_loop_run(ptr ${asyncEntry ? "%top" : "null"})`,
          `  %lexc = call zeroext i1 @scr_exc_pending()`,
          `  br i1 %lexc, label %luncaught, label %lok`,
          `luncaught:`,
          `  call void @scr_exc_print_uncaught()`,
          ...(asyncEntry ? [`  call void @scr_promise_release(ptr %top)`] : []),
          ...exitListenerLines("xl"),
          ...loopReleasesU,
          `  %failure_code_1 = call i32 @scr_exit_code_hint_get()`,
          `  ret i32 %failure_code_1`,
          `lok:`,
          `  br i1 %loop_rejection, label %lreported, label %lclean`,
          `lreported:`,
          `  call void @scr_discard_unhandled_rejections()`,
          ...(asyncEntry ? [`  call void @scr_promise_release(ptr %top)`] : []),
          ...exitListenerLines("xq"),
          ...loopReportedReleases,
          `  %failure_code_2 = call i32 @scr_exit_code_hint_get()`,
          `  ret i32 %failure_code_2`,
          `lclean:`,
          ...(asyncEntry
            ? [
                `  %tla_status = call i32 @scr_promise_finish_top_level(ptr %top)`,
                `  %tla_rejected = icmp eq i32 %tla_status, 1`,
                `  br i1 %tla_rejected, label %tla_fail, label %tla_not_rejected`,
                `tla_fail:`,
                // The loop already delivered every earlier-checkpoint
                // rejection. Drop same-checkpoint competitors before
                // surfacing the fatal module verdict.
                `  call void @scr_discard_unhandled_rejections()`,
                `  call void @scr_promise_rethrow_top_level(ptr %top)`,
                `  call void @scr_promise_release(ptr %top)`,
                `  call void @scr_exc_print_uncaught()`,
                ...exitListenerLines("xt"),
                ...topRejectReleases,
                `  %failure_code_3 = call i32 @scr_exit_code_hint_get()`,
                `  ret i32 %failure_code_3`,
                `tla_not_rejected:`,
                `  call void @scr_promise_release(ptr %top)`,
              ]
            : []),
          `  %rej = call zeroext i1 @scr_report_unhandled_rejections()`,
          `  br i1 %rej, label %lrej, label %lrok`,
          `lrej:`,
          ...exitListenerLines("xr"),
          ...loopReleasesR,
          `  %failure_code_4 = call i32 @scr_exit_code_hint_get()`,
          `  ret i32 %failure_code_4`,
          `lrok:`,
          ...(asyncEntry
            ? [
                `  %tla_pending = icmp eq i32 %tla_status, 13`,
                `  br i1 %tla_pending, label %tla_stuck, label %tla_ok`,
                `tla_stuck:`,
                ...topPendingExitLines(),
                `tla_ok:`,
              ]
            : []),
        ]
      : []),
    ...exitListenerLines("xn"),
    ...globalReleases,
    ...(usesNodeTest
      ? [`  %test_exit = call i32 @scr_test_exit_code()`, `  ret i32 %test_exit`]
      : [`  %native_exit = call i32 @scr_exit_code_hint_get()`, `  ret i32 %native_exit`]),
    `}`,
    ``,
    ...emitter.inlineRcTail(flushedDecls),
    // sanitize_address is inert under the plain pipeline; the sanitized
    // lane's -fsanitize=address link activates instrumentation over the
    // emitted functions too (the runtime TUs get theirs from clang).
    ...functionAttributes(emitter, hasNoInlineRecordClone),
    ``,
  );
  if (emitter.mod.workers) {
    out.push(
      `declare void @scr_context_cleanup()`,
      `declare i32 @scr_worker_argc()`,
      `declare ptr @scr_worker_argv()`,
      `define i32 @sc_worker_entry(i32 %root) ${FN_ATTRS} {`,
      `entry:`,
      `  %argc = call i32 @scr_worker_argc()`,
      `  %argv = call ptr @scr_worker_argv()`,
      `  %result = call i32 @sc_context_entry(i32 %argc, ptr %argv)`,
      `  ret i32 %result`,
      `}`,
      `define i32 @main(i32 %argc, ptr %argv) ${FN_ATTRS} {`,
      `entry:`,
      `  %result = call i32 @sc_context_entry(i32 %argc, ptr %argv)`,
      `  call void @scr_context_cleanup()`,
      `  ret i32 %result`,
      `}`,
    );
  }
  out.push(...emitter.fieldAliasMetadata());
  if (emitter.debug !== null) out.push(emitter.debug.render());
  return out;
}

/** The shared abort helpers (emitted only when referenced): the OOM
 * abort of untraced shape allocation and the invalid-union-tag abort —
 * both print the runtime ABI’s exact message on fd 2 and abort. */
/** The island module tree's install call before %main, and the constant
 * that carries its files when the executable ships them itself
 * (scr_node_island.c: scr_node_island_install_modules). */
function nodeIslandModulesInstall(
  emitter: LlEmitter,
  modules: IrNodeIslandModules,
): { call: string; globals: string[] } {
  emitter.declare(
    `declare void @scr_node_island_install_modules(ptr, ${emitter.sizeType}, ptr, ${emitter.sizeType}, ptr)`,
  );
  const manifest = nodeIslandManifest(modules);
  const manifestPtr = emitter.cstr(manifest);
  const location = emitter.cstr(modules.location ?? "");
  const data = modules.location === undefined ? emitter.nodeIslandModuleData : null;
  const globals =
    data === null || data.length === 0
      ? []
      : [
          `@sc_node_island_modules = private unnamed_addr constant [${data.length} x i8] c"${llvmBytes(data, false)}", align 16`,
        ];
  const st = emitter.sizeType;
  return {
    call: `  call void @scr_node_island_install_modules(ptr ${manifestPtr}, ${st} ${Buffer.byteLength(manifest, "utf8")}, ptr ${globals.length > 0 ? "@sc_node_island_modules" : "null"}, ${st} ${globals.length > 0 ? data!.length : 0}, ptr ${location})`,
    globals,
  };
}

export function helperDefs(emitter: LlEmitter): string[] {
  const defs: string[] = [];
  const msgHelper = (fnName: string, msgSym: string, msg: string): void => {
    // The message routes through the runtime's trap funnel: executable
    // builds expand to the historical bytes-on-stderr + abort; library
    // builds route to the registered panic sink (scr_runtime.h).
    const bytes = Buffer.byteLength(msg, "utf8");
    emitter.declare(`declare void @scr_trap(ptr)`);
    defs.push(
      `@${msgSym} = internal constant [${bytes + 1} x i8] c"${llStrBytes(msg)}"`,
      `define internal void @${fnName}() ${FN_ATTRS} {`,
      `entry:`,
      `  call void @scr_trap(ptr @${msgSym})`,
      `  unreachable`,
      `}`,
      ``,
    );
  };
  if (emitter.needsOom) msgHelper("sc_oom", "sc_oom_msg", "scriptc: out of memory\n");
  if (emitter.needsBadTag) {
    msgHelper("sc_bad_tag", "sc_bad_tag_msg", "scriptc: internal error: invalid union tag\n");
  }
  if (emitter.needsBadKey) {
    // The keyed-read miss on a result type that cannot say `undefined`:
    // trap like an array OOB read instead of corrupting a typed slot
    // (SEMANTICS.md; the C helper's message additionally interpolates
    // the runtime key — a trap-path debugging nicety, never reachable
    // by a program whose behavior matches Node).
    msgHelper(
      "sc_bad_key",
      "sc_bad_key_msg",
      "scriptc: TypeError: record has no key (typed slot — no undefined is representable)\n",
    );
  }
  if (emitter.needsRetainBox) {
    // scr_box_retain is a static inline (increment-unless-immortal);
    // emitted once with internal linkage, like the record retains.
    defs.push(
      `define internal ptr @sc_retain_box(ptr %b) ${FN_ATTRS} {`,
      `entry:`,
      `  %rc = load ${emitter.sizeType}, ptr %b`,
      `  %imm = icmp eq ${emitter.sizeType} %rc, -1`,
      `  br i1 %imm, label %done, label %inc`,
      `inc:`,
      `  %n = add ${emitter.sizeType} %rc, 1`,
      `  store ${emitter.sizeType} %n, ptr %b`,
      `  br label %done`,
      `done:`,
      `  ret ptr %b`,
      `}`,
      ``,
    );
  }
  // Number-key Map/Set lookups probe the runtime's direct index inline:
  // while ndense is nonzero every live key is an integer below it, so an
  // in-range integral key reads its slot (entry index + 1, 0 = absent) and
  // any other key is absent. Maps without the index (ndense 0) hash the
  // key in sc_map_entry_f64_hashed, which scans the entries of a small map
  // or probes a compact bucket table as scr_map_find_f64 does, and calls
  // the runtime lookup for a wide table. It stays out of line so that the
  // direct-index path stays small at every call site. Both only read
  // memory, so LLVM merges lookups of one key when nothing is stored in
  // between (a has() followed by get(), for example).
  if (emitter.decls.has(NUMBER_MAP_ENTRY_DECL)) {
    const sz = emitter.sizeType;
    let mapTmp = 0;
    const mapIndex = exactIndexLines("%k", "%nd", sz, () => `%ix${mapTmp++}`);
    defs.push(
      `define internal ptr @sc_map_entry_f64(ptr %m, double %k) ${FN_ATTRS} {`,
      `entry:`,
      `  %ndp = getelementptr inbounds %ScrMapIx, ptr %m, i32 0, i32 16`,
      ...(sz === "i64"
        ? [`  %nd32 = load i32, ptr %ndp`, `  %nd = zext i32 %nd32 to i64`]
        : [`  %nd = load i32, ptr %ndp`]),
      // A non-integral key inside the table is as absent as one outside it.
      ...mapIndex.lines.map((line) => `  ${line}`),
      `  br i1 ${mapIndex.ok}, label %slot, label %outside`,
      `slot:`,
      sz === "i64"
        ? `  %i = add i64 ${mapIndex.wide}, 0`
        : `  %i = trunc i64 ${mapIndex.wide} to ${sz}`,
      `  %dp = getelementptr inbounds %ScrMapIx, ptr %m, i32 0, i32 15`,
      `  %dense = load ptr, ptr %dp`,
      `  %sp = getelementptr inbounds i32, ptr %dense, ${sz} %i`,
      `  %s = load i32, ptr %sp`,
      `  %empty = icmp eq i32 %s, 0`,
      `  br i1 %empty, label %miss, label %hit`,
      `hit:`,
      `  %e32 = sub i32 %s, 1`,
      sz === "i32" ? `  %e = add i32 %e32, 0` : `  %e = zext i32 %e32 to ${sz}`,
      `  %ep = getelementptr inbounds %ScrMapIx, ptr %m, i32 0, i32 11`,
      `  %entries = load ptr, ptr %ep`,
      `  %found = getelementptr inbounds %ScrMapNumEntry, ptr %entries, ${sz} %e`,
      `  ret ptr %found`,
      `miss:`,
      `  ret ptr null`,
      `outside:`,
      `  %dense.any = icmp ne ${sz} %nd, 0`,
      `  br i1 %dense.any, label %miss, label %slow`,
      `slow:`,
      `  %hashed = call ptr @sc_map_entry_f64_hashed(ptr %m, double %k)`,
      `  ret ptr %hashed`,
      `}`,
      ``,
      // Hashing (scr_map_find_f64): the SameValueZero key word, its
      // scr_key_mix hash (zero remapped to one) and the absent-key filter.
      `define internal ptr @sc_map_entry_f64_hashed(ptr %m, double %k) noinline ${FN_ATTRS} {`,
      `entry:`,
      `  %nan = fcmp uno double %k, %k`,
      `  %zero = fcmp oeq double %k, 0.0`,
      `  %kz = select i1 %zero, double 0.0, double %k`,
      `  %kzb = bitcast double %kz to i64`,
      `  %kb = select i1 %nan, i64 9221120237041090560, i64 %kzb`,
      `  %x1s = lshr i64 %kb, 30`,
      `  %x1 = xor i64 %kb, %x1s`,
      `  %x2 = mul i64 %x1, -4658895280553007687`,
      `  %x3s = lshr i64 %x2, 27`,
      `  %x3 = xor i64 %x2, %x3s`,
      `  %x4 = mul i64 %x3, -7723592293110705685`,
      `  %x5s = lshr i64 %x4, 31`,
      `  %x5 = xor i64 %x4, %x5s`,
      `  %hz = icmp eq i64 %x5, 0`,
      `  %h = select i1 %hz, i64 1, i64 %x5`,
      `  %f1s = lshr i64 %h, 44`,
      `  %f1a = and i64 %f1s, 63`,
      `  %f1 = shl i64 1, %f1a`,
      `  %f2s = lshr i64 %h, 50`,
      `  %f2a = and i64 %f2s, 63`,
      `  %f2 = shl i64 1, %f2a`,
      `  %fb = or i64 %f1, %f2`,
      `  %fp = getelementptr inbounds %ScrMapIx, ptr %m, i32 0, i32 10`,
      `  %filter = load i64, ptr %fp`,
      `  %fm = and i64 %filter, %fb`,
      `  %fin = icmp eq i64 %fm, %fb`,
      `  br i1 %fin, label %table, label %miss`,
      `table:`,
      `  %nbp = getelementptr inbounds %ScrMapIx, ptr %m, i32 0, i32 13`,
      ...(sz === "i64"
        ? [`  %nb32 = load i32, ptr %nbp`, `  %nb = zext i32 %nb32 to i64`]
        : [`  %nb = load i32, ptr %nbp`]),
      `  %eps = getelementptr inbounds %ScrMapIx, ptr %m, i32 0, i32 11`,
      `  %ents = load ptr, ptr %eps`,
      `  %linear = icmp eq ${sz} %nb, 0`,
      `  br i1 %linear, label %scan, label %buckets`,
      // Small maps keep no bucket table: scan the entries' keys. A number-key
      // entry has no cached hash; a dead entry's key matches no key.
      `scan:`,
      `  %nep = getelementptr inbounds %ScrMapIx, ptr %m, i32 0, i32 8`,
      ...(sz === "i64"
        ? [`  %ne32 = load i32, ptr %nep`, `  %ne = zext i32 %ne32 to i64`]
        : [`  %ne = load i32, ptr %nep`]),
      `  br label %scan.loop`,
      `scan.loop:`,
      `  %si = phi ${sz} [ 0, %scan ], [ %si.next, %scan.next ]`,
      `  %sdone = icmp eq ${sz} %si, %ne`,
      `  br i1 %sdone, label %miss, label %scan.entry`,
      `scan.entry:`,
      `  %se = getelementptr inbounds %ScrMapNumEntry, ptr %ents, ${sz} %si`,
      `  %sk = load i64, ptr %se`,
      `  %skq = icmp eq i64 %sk, %kb`,
      `  br i1 %skq, label %scan.found, label %scan.next`,
      `scan.found:`,
      `  ret ptr %se`,
      `scan.next:`,
      `  %si.next = add ${sz} %si, 1`,
      `  br label %scan.loop`,
      // Compact tables tag each 24-bit entry index (+1) with the hash's
      // top byte; wider tables take the runtime lookup.
      `buckets:`,
      `  %wide = icmp ugt ${sz} %nb, 16777216`,
      `  br i1 %wide, label %runtime, label %probe`,
      `probe:`,
      `  %bp = getelementptr inbounds %ScrMapIx, ptr %m, i32 0, i32 14`,
      `  %bk = load ptr, ptr %bp`,
      `  %mask = sub ${sz} %nb, 1`,
      `  %ht = lshr i64 %h, 32`,
      `  %ht32 = trunc i64 %ht to i32`,
      `  %tag = and i32 %ht32, -16777216`,
      sz === "i64" ? `  %hi = add i64 %h, 0` : `  %hi = trunc i64 %h to ${sz}`,
      `  %i0 = and ${sz} %hi, %mask`,
      `  br label %probe.loop`,
      `probe.loop:`,
      `  %pi = phi ${sz} [ %i0, %probe ], [ %pi.next, %probe.next ]`,
      `  %bep = getelementptr inbounds i32, ptr %bk, ${sz} %pi`,
      `  %b = load i32, ptr %bep`,
      `  %bempty = icmp eq i32 %b, 0`,
      `  br i1 %bempty, label %miss, label %probe.tag`,
      `probe.tag:`,
      `  %bt = and i32 %b, -16777216`,
      `  %btq = icmp eq i32 %bt, %tag`,
      `  br i1 %btq, label %probe.entry, label %probe.next`,
      `probe.entry:`,
      `  %bix = and i32 %b, 16777215`,
      `  %bix1 = sub i32 %bix, 1`,
      sz === "i32" ? `  %bi = add i32 %bix1, 0` : `  %bi = zext i32 %bix1 to ${sz}`,
      `  %pe = getelementptr inbounds %ScrMapNumEntry, ptr %ents, ${sz} %bi`,
      `  %pk = load i64, ptr %pe`,
      `  %pkq = icmp eq i64 %pk, %kb`,
      `  br i1 %pkq, label %probe.found, label %probe.next`,
      `probe.found:`,
      `  ret ptr %pe`,
      `probe.next:`,
      `  %pi.inc = add ${sz} %pi, 1`,
      `  %pi.next = and ${sz} %pi.inc, %mask`,
      `  br label %probe.loop`,
      `miss:`,
      `  ret ptr null`,
      `runtime:`,
      `  %r = call ptr @scr_map_entry_f64(ptr %m, double %k) memory(read) nounwind willreturn`,
      `  ret ptr %r`,
      `}`,
      ``,
    );
  }
  // Map/Set iteration steps read the entries array inline: an index is
  // live when it is below the entry count and its entry's cached hash is
  // nonzero (a tombstone's is zero), as scr_map_iter_live decides, or for
  // a number-key map when its key is not SCR_MAP_NUM_DEAD. The entry count
  // is read again at every step, so entries appended during the iteration
  // are visited.
  if (emitter.decls.has(MAP_ITER_DECL) || emitter.decls.has(MAP_ITER_NUM_DECL)) {
    const sz = emitter.sizeType;
    if (emitter.decls.has(MAP_ITER_DECL))
      defs.push(
        `define internal ptr @sc_map_iter_entry(ptr %m, double %i) ${FN_ATTRS} {`,
        `entry:`,
        `  %np = getelementptr inbounds %ScrMapIx, ptr %m, i32 0, i32 8`,
        `  %n = load i32, ptr %np`,
        `  %nf = uitofp i32 %n to double`,
        `  %lo = fcmp oge double %i, 0.0`,
        `  %hi = fcmp olt double %i, %nf`,
        `  %in = and i1 %lo, %hi`,
        `  br i1 %in, label %load, label %none`,
        `load:`,
        `  %ix = fptoui double %i to ${sz}`,
        `  %ep = getelementptr inbounds %ScrMapIx, ptr %m, i32 0, i32 11`,
        `  %entries = load ptr, ptr %ep`,
        `  %e = getelementptr inbounds %ScrMapEntry, ptr %entries, ${sz} %ix`,
        `  %hp = getelementptr inbounds %ScrMapEntry, ptr %e, i32 0, i32 2`,
        `  %h = load i64, ptr %hp`,
        `  %live = icmp ne i64 %h, 0`,
        `  br i1 %live, label %yes, label %none`,
        `yes:`,
        `  ret ptr %e`,
        `none:`,
        `  ret ptr null`,
        `}`,
        ``,
      );
    if (emitter.decls.has(MAP_ITER_NUM_DECL))
      defs.push(
        `define internal ptr @sc_map_iter_entry_num(ptr %m, double %i) ${FN_ATTRS} {`,
        `entry:`,
        `  %np = getelementptr inbounds %ScrMapIx, ptr %m, i32 0, i32 8`,
        `  %n = load i32, ptr %np`,
        `  %nf = uitofp i32 %n to double`,
        `  %lo = fcmp oge double %i, 0.0`,
        `  %hi = fcmp olt double %i, %nf`,
        `  %in = and i1 %lo, %hi`,
        `  br i1 %in, label %load, label %none`,
        `load:`,
        `  %ix = fptoui double %i to ${sz}`,
        `  %ep = getelementptr inbounds %ScrMapIx, ptr %m, i32 0, i32 11`,
        `  %entries = load ptr, ptr %ep`,
        `  %e = getelementptr inbounds %ScrMapNumEntry, ptr %entries, ${sz} %ix`,
        `  %key = load i64, ptr %e`,
        `  %live = icmp ne i64 %key, ${SCR_MAP_NUM_DEAD}`,
        `  br i1 %live, label %yes, label %none`,
        `yes:`,
        `  ret ptr %e`,
        `none:`,
        `  ret ptr null`,
        `}`,
        ``,
      );
    defs.push(
      `define internal double @sc_map_iter_count(ptr %m) ${FN_ATTRS} {`,
      `entry:`,
      `  %np = getelementptr inbounds %ScrMapIx, ptr %m, i32 0, i32 8`,
      `  %n = load i32, ptr %np`,
      `  %nf = uitofp i32 %n to double`,
      `  ret double %nf`,
      `}`,
      ``,
    );
  }
  // Map.size and Set.size read the live entry count (scr_map_size).
  if (emitter.decls.has(MAP_SIZE_DECL))
    defs.push(
      `define internal double @sc_map_size(ptr %m) ${FN_ATTRS} {`,
      `entry:`,
      `  %np = getelementptr inbounds %ScrMapIx, ptr %m, i32 0, i32 9`,
      `  %n = load i32, ptr %np`,
      `  %nf = uitofp i32 %n to double`,
      `  ret double %nf`,
      `}`,
      ``,
    );
  // String-key Map/Set lookups test the map's absent-key filter inline
  // (scr_map.c scr_map_filter_bits): a key whose two filter bits are not
  // both set is absent, so most misses on small and medium maps return
  // without a call. On 64-bit targets the key's cached hash h is the high
  // half of its capacity word, the runtime's widened hash is (h << 32) | h,
  // and the filter reads its bits 44..55, which are the capacity word's
  // own. A key without a cached hash, and every possible hit, take the
  // runtime lookup.
  // A compact-value map's lookup (sc_map_entry_str_c) tests the same filter
  // and calls scr_map_entry_str_c; its iteration step (sc_map_iter_entry_c)
  // reads 16-byte entries and their 32-bit hash.
  const stringMapEntry = (helper: string, runtime: string): string[] => [
    `define internal ptr @${helper}(ptr %m, ptr %k) ${FN_ATTRS} {`,
    `entry:`,
    ...(emitter.sizeType === "i64"
      ? [
          `  %fp = getelementptr inbounds %ScrMapIx, ptr %m, i32 0, i32 10`,
          `  %filter = load i64, ptr %fp`,
          `  %capp = getelementptr inbounds %ScrStr, ptr %k, i32 0, i32 2`,
          `  %cap = load i64, ptr %capp`,
          `  %cached = icmp uge i64 %cap, 4294967296`,
          `  br i1 %cached, label %test, label %slow`,
          `test:`,
          `  %s1 = lshr i64 %cap, 44`,
          `  %i1 = and i64 %s1, 63`,
          `  %b1 = shl i64 1, %i1`,
          `  %s2 = lshr i64 %cap, 50`,
          `  %i2 = and i64 %s2, 63`,
          `  %b2 = shl i64 1, %i2`,
          `  %bits = or i64 %b1, %b2`,
          `  %have = and i64 %filter, %bits`,
          `  %maybe = icmp eq i64 %have, %bits`,
          `  br i1 %maybe, label %slow, label %absent`,
          `absent:`,
          `  ret ptr null`,
        ]
      : [`  br label %slow`]),
    `slow:`,
    `  %r = call ptr @${runtime}(ptr %m, ptr %k)`,
    `  ret ptr %r`,
    `}`,
    ``,
  ];
  if (emitter.decls.has(STRING_MAP_ENTRY_DECL))
    defs.push(...stringMapEntry("sc_map_entry_str", "scr_map_entry_str"));
  if (emitter.decls.has(STRING_MAP_ENTRY_C_DECL)) {
    const sz = emitter.sizeType;
    defs.push(
      ...stringMapEntry("sc_map_entry_str_c", "scr_map_entry_str_c"),
      `define internal ptr @sc_map_iter_entry_c(ptr %m, double %i) ${FN_ATTRS} {`,
      `entry:`,
      `  %np = getelementptr inbounds %ScrMapIx, ptr %m, i32 0, i32 8`,
      `  %n = load i32, ptr %np`,
      `  %nf = uitofp i32 %n to double`,
      `  %lo = fcmp oge double %i, 0.0`,
      `  %hi = fcmp olt double %i, %nf`,
      `  %in = and i1 %lo, %hi`,
      `  br i1 %in, label %load, label %none`,
      `load:`,
      `  %ix = fptoui double %i to ${sz}`,
      `  %ep = getelementptr inbounds %ScrMapIx, ptr %m, i32 0, i32 11`,
      `  %entries = load ptr, ptr %ep`,
      `  %e = getelementptr inbounds %ScrMapCEntry, ptr %entries, ${sz} %ix`,
      `  %hp = getelementptr inbounds %ScrMapCEntry, ptr %e, i32 0, i32 1`,
      `  %h = load i32, ptr %hp`,
      `  %live = icmp ne i32 %h, 0`,
      `  br i1 %live, label %yes, label %none`,
      `yes:`,
      `  ret ptr %e`,
      `none:`,
      `  ret ptr null`,
      `}`,
      ``,
    );
  }
  // String comparisons enter through small internal wrappers that LLVM
  // inlines at each site: interned literals and shared values compare by
  // identity, and equality rejects different byte lengths, before any
  // runtime call (scr_str_eq/scr_str_cmp keep the complete semantics).
  if (emitter.decls.has(`declare zeroext i1 @scr_str_eq(ptr, ptr)`)) {
    defs.push(
      `define internal zeroext i1 @sc_str_eq(ptr %a, ptr %b) ${FN_ATTRS} {`,
      `entry:`,
      `  %same = icmp eq ptr %a, %b`,
      `  br i1 %same, label %yes, label %lengths`,
      `lengths:`,
      `  %alen.p = getelementptr inbounds %ScrStr, ptr %a, i32 0, i32 1`,
      `  %blen.p = getelementptr inbounds %ScrStr, ptr %b, i32 0, i32 1`,
      `  %alen = load ${emitter.sizeType}, ptr %alen.p`,
      `  %blen = load ${emitter.sizeType}, ptr %blen.p`,
      `  %samelen = icmp eq ${emitter.sizeType} %alen, %blen`,
      `  br i1 %samelen, label %bytes, label %no`,
      `bytes:`,
      `  %eq = call zeroext i1 @scr_str_eq(ptr %a, ptr %b)`,
      `  ret i1 %eq`,
      `yes:`,
      `  ret i1 true`,
      `no:`,
      `  ret i1 false`,
      `}`,
      ``,
    );
  }
  for (const [text, name] of emitter.literalEqualities) {
    defs.push(
      ...literalEqualityDefinition(
        name,
        wtf8Bytes(text),
        emitter.internLiteral(text),
        emitter.sizeType,
        FN_ATTRS,
      ),
      ``,
    );
  }
  // String length and charCodeAt read proven-ASCII strings inline: bit 31
  // of the capacity word (SCR_STR_ASCII_BIT, the low half's sign bit on
  // little-endian targets) makes UTF-16 units bytes. Unproven strings and
  // anything but an in-range index take the runtime's UTF-16 mapping.
  // A scan's receiver reads inline too (ScrStrScan): from ordinary global
  // storage, or, in worker executables, from the thread's static TLS block,
  // one thread-pointer-relative load (see executableTls).
  const scanInline =
    emitter.executableTls ||
    (emitter.mod.workers !== true && emitter.mod.lib?.threadInstances !== true);
  let scanDeclared = false;
  for (const helper of STRING_READ_HELPERS) {
    if (!emitter.decls.has(helper.decl)) continue;
    if (scanInline && !scanDeclared) {
      defs.push(stringScanDecl(emitter.sizeType, emitter.executableTls), ``);
      scanDeclared = true;
    }
    defs.push(...helper.define(emitter.sizeType, FN_ATTRS, scanInline), ``);
  }
  // Ordering decides inline from the first differing bytes. The bytes
  // before them are equal, so both strings are at the same position of a
  // character: either both bytes continue characters with the same lead
  // byte, or both start a character. Byte order is the UTF-16 order for
  // two continuation bytes, and for two lead bytes when one starts a
  // character below U+D000, whose UTF-16 unit is below every unit of a
  // character with a lead byte of at least 0xED. Between lead bytes of at
  // least 0xED, a supplementary character (0xF0..0xF4, a high surrogate
  // unit) orders below U+E000..U+FFFF (0xEE, 0xEF), and a lead byte of
  // 0xED (U+D000..U+D7FF or a lone surrogate) takes the runtime.
  // Differing words without a byte of at least 0xED decide in byte
  // order; other differing words decide by their first differing byte,
  // and strings shorter than a word by their first byte. Otherwise a
  // proven-ASCII string on either side orders by bytes (scr_str_cmp), and
  // other pairs call scr_str_cmp_u16_bytes, which only reads the two
  // strings, so LLVM can merge repeated comparisons of one pair. Callers
  // only test the sign of the result.
  if (emitter.decls.has(`declare i32 @scr_str_cmp_u16(ptr, ptr)`)) {
    const fn = "scr_str_cmp_u16";
    emitter.declare("declare i64 @llvm.bswap.i64(i64)");
    emitter.declare("declare i64 @llvm.cttz.i64(i64, i1 immarg)");
    emitter.declare("declare i8 @llvm.umin.i8(i8, i8)");
    emitter.declare("declare i32 @scr_str_cmp(ptr, ptr)");
    emitter.declare("declare i32 @scr_str_cmp_u16_bytes(ptr, ptr)");
    defs.push(
      `define internal i32 @${fn.replace(/^scr_/, "sc_")}(ptr %a, ptr %b) ${FN_ATTRS} {`,
      `entry:`,
      `  %same = icmp eq ptr %a, %b`,
      `  br i1 %same, label %equal, label %lengths`,
      `lengths:`,
      `  %alen.p = getelementptr inbounds %ScrStr, ptr %a, i32 0, i32 1`,
      `  %blen.p = getelementptr inbounds %ScrStr, ptr %b, i32 0, i32 1`,
      `  %alen = load ${emitter.sizeType}, ptr %alen.p`,
      `  %blen = load ${emitter.sizeType}, ptr %blen.p`,
      `  %aempty = icmp eq ${emitter.sizeType} %alen, 0`,
      `  %bempty = icmp eq ${emitter.sizeType} %blen, 0`,
      `  %empty = or i1 %aempty, %bempty`,
      `  br i1 %empty, label %order, label %words`,
      // Both at least 8 bytes: the first word of each.
      `words:`,
      `  %along = icmp uge ${emitter.sizeType} %alen, 8`,
      `  %blong = icmp uge ${emitter.sizeType} %blen, 8`,
      `  %long = and i1 %along, %blong`,
      `  br i1 %long, label %word, label %first`,
      `word:`,
      `  %awp = getelementptr inbounds %ScrStr, ptr %a, i32 1`,
      `  %bwp = getelementptr inbounds %ScrStr, ptr %b, i32 1`,
      `  %aw = load i64, ptr %awp, align 1`,
      `  %bw = load i64, ptr %bwp, align 1`,
      `  %wdiffer = icmp ne i64 %aw, %bw`,
      `  br i1 %wdiffer, label %differ, label %wsame`,
      // Equal first words and one length of at most 16 bytes: the word
      // ending at that length covers the rest, and any difference lies
      // past the equal first word.
      `wsame:`,
      `  %samelen = icmp eq ${emitter.sizeType} %alen, %blen`,
      `  %short = icmp ule ${emitter.sizeType} %alen, 16`,
      `  %tailable = and i1 %samelen, %short`,
      `  br i1 %tailable, label %tail, label %order`,
      `tail:`,
      `  %toff = sub ${emitter.sizeType} %alen, 8`,
      `  %atp = getelementptr inbounds i8, ptr %awp, ${emitter.sizeType} %toff`,
      `  %btp = getelementptr inbounds i8, ptr %bwp, ${emitter.sizeType} %toff`,
      `  %at = load i64, ptr %atp, align 1`,
      `  %bt = load i64, ptr %btp, align 1`,
      `  %tdiffer = icmp ne i64 %at, %bt`,
      `  br i1 %tdiffer, label %differ, label %equal`,
      `first:`,
      `  %adata = getelementptr inbounds %ScrStr, ptr %a, i32 1`,
      `  %bdata = getelementptr inbounds %ScrStr, ptr %b, i32 1`,
      `  %x = load i8, ptr %adata`,
      `  %y = load i8, ptr %bdata`,
      `  %fdiffer = icmp ne i8 %x, %y`,
      `  br i1 %fdiffer, label %bytes, label %order`,
      // Two differing words. When neither has a byte of at least 0xED
      // (a byte b is when its high bit and bit 7 of (b & 0x7f) + 0x13 are
      // set), byte-swapped little-endian words compare in byte order.
      // Otherwise the lowest set byte of their xor is the first differing
      // byte.
      `differ:`,
      `  %dx = phi i64 [ %aw, %word ], [ %at, %tail ]`,
      `  %dy = phi i64 [ %bw, %word ], [ %bt, %tail ]`,
      `  %xl = and i64 %dx, 9187201950435737471`,
      `  %yl = and i64 %dy, 9187201950435737471`,
      `  %xa = add i64 %xl, 1374463283923456787`,
      `  %ya = add i64 %yl, 1374463283923456787`,
      `  %xh = and i64 %dx, %xa`,
      `  %yh = and i64 %dy, %ya`,
      `  %hh = or i64 %xh, %yh`,
      `  %whigh = and i64 %hh, -9187201950435737472`,
      `  %dlow = icmp eq i64 %whigh, 0`,
      `  br i1 %dlow, label %wordorder, label %locate`,
      `wordorder:`,
      `  %xsw = call i64 @llvm.bswap.i64(i64 %dx)`,
      `  %ysw = call i64 @llvm.bswap.i64(i64 %dy)`,
      `  %wbelow = icmp ult i64 %xsw, %ysw`,
      `  %wsign = select i1 %wbelow, i32 -1, i32 1`,
      `  ret i32 %wsign`,
      `locate:`,
      `  %dxor = xor i64 %dx, %dy`,
      `  %dtz = call i64 @llvm.cttz.i64(i64 %dxor, i1 true)`,
      `  %dshift = and i64 %dtz, 56`,
      `  %dxs = lshr i64 %dx, %dshift`,
      `  %dys = lshr i64 %dy, %dshift`,
      `  %dxb = trunc i64 %dxs to i8`,
      `  %dyb = trunc i64 %dys to i8`,
      `  br label %bytes`,
      // The first differing bytes.
      `bytes:`,
      `  %bx = phi i8 [ %x, %first ], [ %dxb, %locate ]`,
      `  %by = phi i8 [ %y, %first ], [ %dyb, %locate ]`,
      `  %bmin = call i8 @llvm.umin.i8(i8 %bx, i8 %by)`,
      `  %blow = icmp ult i8 %bmin, -19`,
      `  br i1 %blow, label %byte, label %high`,
      // Both at least 0xED. A lone surrogate (0xED) takes the runtime;
      // supplementary lead bytes (0xF0..0xF4) order below 0xEE and 0xEF
      // once 0x10 is subtracted from them.
      `high:`,
      `  %xed = icmp eq i8 %bx, -19`,
      `  %yed = icmp eq i8 %by, -19`,
      `  %ed = or i1 %xed, %yed`,
      `  br i1 %ed, label %order, label %planes`,
      `planes:`,
      `  %xsupp = icmp uge i8 %bx, -16`,
      `  %ysupp = icmp uge i8 %by, -16`,
      `  %xlow = add i8 %bx, -16`,
      `  %ylow = add i8 %by, -16`,
      `  %xk = select i1 %xsupp, i8 %xlow, i8 %bx`,
      `  %yk = select i1 %ysupp, i8 %ylow, i8 %by`,
      `  %kbelow = icmp ult i8 %xk, %yk`,
      `  %ksign = select i1 %kbelow, i32 -1, i32 1`,
      `  ret i32 %ksign`,
      `byte:`,
      `  %below = icmp ult i8 %bx, %by`,
      `  %sign = select i1 %below, i32 -1, i32 1`,
      `  ret i32 %sign`,
      `order:`,
      `  %acw.p = getelementptr inbounds %ScrStr, ptr %a, i32 0, i32 2`,
      `  %bcw.p = getelementptr inbounds %ScrStr, ptr %b, i32 0, i32 2`,
      `  %acw = load i32, ptr %acw.p`,
      `  %bcw = load i32, ptr %bcw.p`,
      `  %cws = or i32 %acw, %bcw`,
      `  %anyascii = icmp slt i32 %cws, 0`,
      `  br i1 %anyascii, label %memorder, label %units`,
      `memorder:`,
      `  %m = call i32 @scr_str_cmp(ptr %a, ptr %b)`,
      `  ret i32 %m`,
      `units:`,
      `  %c = call i32 @scr_str_cmp_u16_bytes(ptr %a, ptr %b) nounwind willreturn memory(argmem: read)`,
      `  ret i32 %c`,
      `equal:`,
      `  ret i32 0`,
      `}`,
      ``,
    );
  }
  // The declarations these helpers added must land in the extern block,
  // which already flushed — append here instead (LLVM is order-free).
  return defs.length > 0 ? [...defs] : defs;
}

/** LIBRARY mode: the profile-declared external definitions — the
 * export-map wrappers plus init / sink-registration / reset / collect.
 * Plain `define` (not `define internal`) — the exact linkage distinction
 * that separates the executable lane's @main from everything else. The
 * bodies delegate every runtime half to scr_library.c, mirroring the C
 * emission line for line, so the two lanes are identical by
 * construction. */
export function emitLibDefs(
  emitter: LlEmitter,
  globals: IrGlobal[],
  globalReleaseLines: (prefix: string) => string[],
  stamps: string[],
): string[] {
  const lib = emitter.mod.lib!;
  const autoReset = lib.resultResetSymbol === null;
  const out: string[] = [``, `; ── library-mode entries (profile: ${lib.profileName}) ──`, ``];
  // Every entry's prologue records its external symbol in the funnel's
  // current-entry slot (structured trap-teaching field 2); the symbols
  // live as internal constants, one per entry.
  const symConst = (sym: string): string => `@sc_lib_sym_${sym}`;
  const emitSymConst = (sym: string): void => {
    out.push(
      `${symConst(sym)} = internal constant [${Buffer.byteLength(sym, "utf8") + 1} x i8] c"${llStrBytes(sym)}"`,
    );
  };
  emitSymConst(lib.initSymbol);
  emitSymConst(lib.sinkRegisterSymbol);
  if (lib.callbackRegisterSymbol !== null && lib.callbackRegisterSymbol !== undefined)
    emitSymConst(lib.callbackRegisterSymbol);
  if (lib.resultResetSymbol !== null) emitSymConst(lib.resultResetSymbol);
  if (lib.collectSymbol !== null) emitSymConst(lib.collectSymbol);
  for (const e of lib.exports) emitSymConst(e.symbol);
  out.push(``);
  if (emitter.wasi) {
    for (const symbol of ["scriptc_alloc", "scriptc_free"]) emitSymConst(symbol);
    out.push(
      `define ptr @scriptc_alloc(i32 %size) ${FN_ATTRS} {`,
      `entry:`,
      `  call void @scr_library_entry(i1 zeroext false, ptr ${symConst("scriptc_alloc")})`,
      `  %p = call ptr @malloc(i32 %size)`,
      `  ret ptr %p`,
      `}`,
      ``,
      `define void @scriptc_free(ptr %p) ${FN_ATTRS} {`,
      `entry:`,
      `  call void @scr_library_entry(i1 zeroext false, ptr ${symConst("scriptc_free")})`,
      `  call void @free(ptr %p)`,
      `  ret void`,
      `}`,
      ``,
    );
  }
  // The runtime detected-trap overlay table (scr_runtime.h declares it,
  // the library trap funnel consults it): flat code/teaching/remediation
  // triples, one per runtime trap code (SC4013–SC4019) the profile
  // declares text for. The funnel assembles the structured sink message.
  // The empty table still defines the symbols the funnel links against.
  const ovlCells: string[] = [];
  lib.trapOverlays.forEach((o, i) => {
    const cell = (name: string, text: string | undefined): void => {
      if (text === undefined) {
        ovlCells.push("ptr null");
        return;
      }
      const sym = `@sc_lib_ovl_${i}_${name}`;
      out.push(
        `${sym} = internal constant [${Buffer.byteLength(text, "utf8") + 1} x i8] c"${llStrBytes(text)}"`,
      );
      ovlCells.push(`ptr ${sym}`);
    };
    cell("code", o.code);
    cell("teach", o.teaching);
    cell("rem", o.remediation);
  });
  out.push(
    ovlCells.length === 0
      ? `@scr_library_trap_overlays = constant [1 x ptr] zeroinitializer`
      : `@scr_library_trap_overlays = constant [${ovlCells.length} x ptr] [${ovlCells.join(", ")}]`,
    `@scr_library_trap_overlays_len = constant ${emitter.sizeType} ${lib.trapOverlays.length}`,
    ``,
  );
  // The init entry: full deterministic reset-and-reevaluate. Program
  // globals release and zero first (run-once guards included), then the
  // runtime session reset, the error-vt interval stamps verbatim from
  // the executable main, %main itself, and the escaped-exception check.
  const zeroStores = globals.map((g) => {
    const ty = emitter.llType(g.type);
    const zero = ty === "double" ? f64Lit(0) : ty === "ptr" ? "null" : "false";
    return `  store ${ty} ${zero}, ptr @${mangleGlobal(g.id)} ; ${g.name}`;
  });
  out.push(
    `define void @${lib.initSymbol}() ${FN_ATTRS} {`,
    `entry:`,
    `  call void @scr_library_entry(i1 zeroext true, ptr ${symConst(lib.initSymbol)}) ; init always resets the result arena`,
    ...globalReleaseLines("ci"),
    ...zeroStores,
    `  call void @scr_library_reset()`,
    ...stamps,
    `  call void @${mangleFunction(emitter.mod.entry)}()`,
    `  call void @scr_library_check_exc()`,
    `  ret void`,
    `}`,
    ``,
    `define void @${lib.sinkRegisterSymbol}(ptr %fn, ptr %ctx) ${FN_ATTRS} {`,
    `entry:`,
    `  call void @scr_library_callback_entry_guard(ptr ${symConst(lib.sinkRegisterSymbol)})`,
    `  call void @scr_library_set_sink(ptr %fn, ptr %ctx)`,
    `  ret void`,
    `}`,
    ``,
  );
  if (lib.callbacks !== undefined && lib.callbacks.length > 0) {
    // Host-callback channels: the per-channel name constants (the
    // registration dispatch's strcmp operands), the per-channel
    // unregistered-call trap constants (the ffiCall sites'
    // scr_library_cb_require operands), and the registration function:
    // a pure store dispatch
    // (the sink registration's rule — no entry prologue, no poison
    // guard) whose first operation rejects callback-time re-entry
    // (SC4026). An unknown or NULL name is a defined -1, never a store.
    for (const cb of lib.callbacks) {
      out.push(
        `@sc_lib_cb_name_${cb.slot} = internal constant [${Buffer.byteLength(cb.name, "utf8") + 1} x i8] c"${llStrBytes(cb.name)}"`,
        `@sc_lib_cb_trap_${cb.slot} = internal constant [${Buffer.byteLength(cb.unregisteredTrap, "utf8") + 1} x i8] c"${llStrBytes(cb.unregisteredTrap)}"`,
      );
    }
    out.push(
      ``,
      `define i32 @${lib.callbackRegisterSymbol}(ptr %name, ptr %fn, ptr %ctx) ${FN_ATTRS} {`,
      `entry:`,
      `  call void @scr_library_callback_entry_guard(ptr ${symConst(lib.callbackRegisterSymbol!)})`,
      `  %isnull = icmp eq ptr %name, null`,
      `  br i1 %isnull, label %miss, label %try0`,
    );
    lib.callbacks.forEach((cb, i) => {
      const next = i + 1 < lib.callbacks!.length ? `try${i + 1}` : "miss";
      out.push(
        `try${i}: ; channel '${cb.name}'`,
        `  %cmp${i} = call i32 @strcmp(ptr %name, ptr @sc_lib_cb_name_${cb.slot})`,
        `  %eq${i} = icmp eq i32 %cmp${i}, 0`,
        `  br i1 %eq${i}, label %set${i}, label %${next}`,
        `set${i}:`,
        `  call void @scr_library_cb_set(${emitter.sizeType} ${cb.slot}, ptr %fn, ptr %ctx)`,
        `  ret i32 0`,
      );
    });
    out.push(`miss:`, `  ret i32 -1`, `}`, ``);
  }
  if (lib.identity !== undefined && emitter.emitLibraryIdentity) {
    // Profile-declared identity getters (the ask-2 sidecar's boot-time
    // pairing fence): pure data returns with NO entry prologue — exempt
    // from the poisoned guard and every runtime touch (ratified), so a
    // host can read them before init and after a trap. The u64 rides
    // i64 two's-complement (LLVM integer constants are signed).
    for (const line of emitLibraryIdentityLines(lib.identity, FN_ATTRS)) out.push(line);
  }
  if (lib.resultResetSymbol !== null) {
    out.push(
      `define void @${lib.resultResetSymbol}() ${FN_ATTRS} {`,
      `entry:`,
      `  call void @scr_library_entry(i1 zeroext false, ptr ${symConst(lib.resultResetSymbol)})`,
      `  call void @scr_library_arena_reset()`,
      `  ret void`,
      `}`,
      ``,
    );
  }
  if (lib.collectSymbol !== null) {
    out.push(
      `define void @${lib.collectSymbol}() ${FN_ATTRS} {`,
      `entry:`,
      `  call void @scr_library_entry(i1 zeroext false, ptr ${symConst(lib.collectSymbol)})`,
      `  call void @scr_library_collect() ; arena reset + a full cycle collection`,
      `  ret void`,
      `}`,
      ``,
    );
  }
  for (const e of lib.exports) {
    const params: string[] = [];
    const body: string[] = [
      `  call void @scr_library_entry(i1 zeroext ${autoReset ? "true" : "false"}, ptr ${symConst(e.symbol)})`,
    ];
    const args: string[] = [];
    if (e.inboundBytesTrap !== undefined) {
      // The bytes-in helper's trap message: the compiler-assembled
      // structured trap-teaching form (0x01 text 0x1F SC4012 0x1F symbol
      // [0x1F remediation]) consumed by the runtime sink.
      const trapBytes = Buffer.byteLength(e.inboundBytesTrap, "utf8");
      out.push(
        `@sc_lib_bytes_trap_${e.symbol} = internal constant [${trapBytes + 1} x i8] c"${llStrBytes(e.inboundBytesTrap)}"`,
        ``,
      );
    }
    if (e.inboundIntTrap !== undefined) {
      // The i64/u64-in helpers' host-contract trap message (ask 4): an
      // inbound integer past ±(2^53−1) cannot ride f64 exactly. Same
      // assembled structured form, same SC4012 code, same
      // emission-invariance argument as the bytes trap.
      const trapBytes = Buffer.byteLength(e.inboundIntTrap, "utf8");
      out.push(
        `@sc_lib_int_trap_${e.symbol} = internal constant [${trapBytes + 1} x i8] c"${llStrBytes(e.inboundIntTrap)}"`,
        ``,
      );
    }
    if (e.inboundCstringTrap !== undefined) {
      // The cstring-in helper's host-contract trap message (a NULL
      // `const char *`): same assembled structured form and SC4012 code.
      const trapBytes = Buffer.byteLength(e.inboundCstringTrap, "utf8");
      out.push(
        `@sc_lib_cstr_trap_${e.symbol} = internal constant [${trapBytes + 1} x i8] c"${llStrBytes(e.inboundCstringTrap)}"`,
        ``,
      );
    }
    e.params.forEach((cls, i) => {
      switch (cls) {
        case "f64":
          params.push(`double %a${i}`);
          args.push(`double %a${i}`);
          break;
        case "bool":
          params.push(`i8 %a${i}`);
          body.push(`  %c${i} = icmp ne i8 %a${i}, 0`);
          args.push(`i1 %c${i}`);
          break;
        case "u8":
          params.push(`i8 %a${i}`);
          body.push(`  %c${i} = uitofp i8 %a${i} to double`);
          args.push(`double %c${i}`);
          break;
        case "u32":
          params.push(`i32 %a${i}`);
          body.push(`  %c${i} = uitofp i32 %a${i} to double`);
          args.push(`double %c${i}`);
          break;
        case "i32":
          params.push(`i32 %a${i}`);
          body.push(`  %c${i} = sitofp i32 %a${i} to double`);
          args.push(`double %c${i}`);
          break;
        case "i64":
          // Inbound declared-integer edge (ask 4): the helper converts
          // exactly or delivers the host-contract trap (past ±(2^53−1)
          // the value cannot ride f64 without rounding).
          params.push(`i64 %a${i}`);
          body.push(
            `  %c${i} = call double @scr_library_i64_in(i64 %a${i}, ptr @sc_lib_int_trap_${e.symbol})`,
          );
          args.push(`double %c${i}`);
          break;
        case "u64":
          params.push(`i64 %a${i}`);
          body.push(
            `  %c${i} = call double @scr_library_u64_in(i64 %a${i}, ptr @sc_lib_int_trap_${e.symbol})`,
          );
          args.push(`double %c${i}`);
          break;
        case "string":
          params.push(`ptr %a${i}_ptr`, `${emitter.sizeType} %a${i}_len`);
          body.push(
            `  %c${i} = call ptr @scr_library_str_in(ptr %a${i}_ptr, ${emitter.sizeType} %a${i}_len)`,
          );
          args.push(`ptr %c${i}`);
          break;
        case "bytes":
          params.push(`ptr %a${i}_ptr`, `${emitter.sizeType} %a${i}_len`);
          body.push(
            `  %c${i} = call ptr @scr_library_bytes_in(ptr %a${i}_ptr, ${emitter.sizeType} %a${i}_len, ptr @sc_lib_bytes_trap_${e.symbol})`,
          );
          args.push(`ptr %c${i}`);
          break;
        case "cstring":
          params.push(`ptr %a${i}`);
          body.push(
            `  %c${i} = call ptr @scr_library_cstr_in(ptr %a${i}, ptr @sc_lib_cstr_trap_${e.symbol})`,
          );
          args.push(`ptr %c${i}`);
          break;
      }
    });
    if (e.returns === "string" || e.returns === "bytes") {
      params.push(`ptr %out`, `ptr %out_len`);
    }
    const target = `@${mangleFunction(e.fnName)}`;
    const callArgs = args.join(", ");
    let retType = "void";
    switch (e.returns) {
      case "void":
        body.push(
          `  call void ${target}(${callArgs})`,
          `  call void @scr_library_check_exc()`,
          `  ret void`,
        );
        break;
      case "f64":
        retType = "double";
        body.push(
          `  %r = call double ${target}(${callArgs})`,
          `  call void @scr_library_check_exc()`,
          `  ret double %r`,
        );
        break;
      case "i64":
      case "u64":
        // The outbound declared-integer edge (ask 4): every value
        // reaching this return was PROVEN whole and inside the class's
        // range at compile time, so the fp-to-int conversion is exact
        // by construction — the crossing carries the mathematically
        // exact integer the f64 held.
        retType = "i64";
        body.push(
          `  %r = call double ${target}(${callArgs})`,
          `  call void @scr_library_check_exc()`,
          `  %z = ${e.returns === "i64" ? "fptosi" : "fptoui"} double %r to i64`,
          `  ret i64 %z`,
        );
        break;
      case "bool":
        retType = "i8";
        body.push(
          `  %r = call i1 ${target}(${callArgs})`,
          `  call void @scr_library_check_exc()`,
          `  %z = zext i1 %r to i8`,
          `  ret i8 %z`,
        );
        break;
      case "string":
        body.push(
          `  %r = call ptr ${target}(${callArgs})`,
          `  call void @scr_library_check_exc()`,
          `  call void @scr_library_str_out(ptr %r, ptr %out, ptr %out_len)`,
          `  ret void`,
        );
        break;
      case "bytes":
        body.push(
          `  %r = call ptr ${target}(${callArgs})`,
          `  call void @scr_library_check_exc()`,
          `  call void @scr_library_bytes_out(ptr %r, ptr %out, ptr %out_len)`,
          `  ret void`,
        );
        break;
      case "cstring":
        // The result's arena copy, returned as `const char *`.
        retType = "ptr";
        body.push(
          `  %r = call ptr ${target}(${callArgs})`,
          `  call void @scr_library_check_exc()`,
          `  %z = call ptr @scr_library_cstr_out(ptr %r)`,
          `  ret ptr %z`,
        );
        break;
    }
    out.push(
      `define ${retType} @${e.symbol}(${params.join(", ")}) ${FN_ATTRS} { ; library export ${e.fnName}`,
      `entry:`,
      ...body,
      `}`,
      ``,
    );
  }
  return out;
}

/** C-callable scalar callback trampolines. A callback with an explicit
 * context entry receives the closure at that exact ABI position. A raw
 * callback loads it from a call-scoped TLS slot installed around the
 * outer native call. */
export function emitFfiCallbackDefs(emitter: LlEmitter): { globals: string[]; defs: string[] } {
  const globals: string[] = [];
  const defs: string[] = [];
  if (emitter.ffiCallbackAdapters.size === 0) return { globals, defs };
  emitter.declare(`declare void @scr_trap(ptr)`);
  const expired = emitter.cstr(
    "scriptc: native callback invoked outside its call-scoped lifetime\n",
  );
  const released = emitter.cstr("scriptc: native callback invoked outside its retained lifetime\n");
  for (const adapter of emitter.ffiCallbackAdapters.values()) {
    const cb = adapter.callback;
    if (adapter.tls !== null)
      globals.push(`@${adapter.tls} = internal thread_local global ptr null`);
    if (adapter.global !== null)
      globals.push(`@${adapter.global} = internal thread_local global ptr null`);
    if (adapter.table !== null) {
      globals.push(
        `@${adapter.table} = internal ${emitter.mod.workers ? "thread_local " : ""}global %ScrFfiTable zeroinitializer`,
      );
    }
    const params = cb.params.flatMap((param, i): string[] => {
      if (isFfiContextParam(param)) return [`ptr %ctx`];
      if (param === "string" || param === "bytes") {
        return [`ptr %a${i}`, `${emitter.sizeType} %a${i}_len`];
      }
      return [`${ffiNativeParamLl(param, emitter.ffiExtendNarrowIntegers)} %a${i}`];
    });
    if (cb.invoke === "foreign") {
      if (
        adapter.table === null ||
        !cb.params.some(isFfiContextParam) ||
        cb.returns !== "void" ||
        cb.params.some((param) => param === "i64" || param === "u64" || param === "pointer")
      ) {
        throw new InternalCompilerError(
          "llvm emitter bug: invalid foreign FFI callback descriptor",
        );
      }
      const dispatch = `${adapter.symbol}_dispatch`;
      const scriptArgs: string[] = [];
      const dispatchBody: string[] = [
        `define internal void @${dispatch}(ptr %cb, ptr %call) ${FN_ATTRS} {`,
        `entry:`,
        `  %fnp = getelementptr inbounds %ScrClosure, ptr %cb, i64 0, i32 1`,
        `  %fn = load ptr, ptr %fnp`,
      ];
      for (let i = 0; i < cb.params.length; i++) {
        const param = cb.params[i]!;
        if (isFfiContextParam(param)) continue;
        switch (param) {
          case "f64":
          case "f32":
          case "i8":
          case "u16":
          case "i16":
            emitter.declare(`declare double @scr_ffi_call_get_f64(ptr, ${emitter.sizeType})`);
            dispatchBody.push(
              `  %s${i} = call double @scr_ffi_call_get_f64(ptr %call, ${emitter.sizeType} ${i})`,
            );
            scriptArgs.push(`double %s${i}`);
            break;
          case "bool":
            emitter.declare(`declare zeroext i1 @scr_ffi_call_get_bool(ptr, ${emitter.sizeType})`);
            dispatchBody.push(
              `  %s${i} = call zeroext i1 @scr_ffi_call_get_bool(ptr %call, ${emitter.sizeType} ${i})`,
            );
            scriptArgs.push(`i1 %s${i}`);
            break;
          case "u8":
          case "u32":
          case "i32":
            emitter.declare(`declare double @scr_ffi_call_get_${param}(ptr, ${emitter.sizeType})`);
            dispatchBody.push(
              `  %s${i} = call double @scr_ffi_call_get_${param}(ptr %call, ${emitter.sizeType} ${i})`,
            );
            scriptArgs.push(`double %s${i}`);
            break;
          case "cstring":
          case "string":
          case "bytes": {
            emitter.declare(`declare ptr @scr_ffi_call_get_data(ptr, ${emitter.sizeType})`);
            emitter.declare(
              `declare ${emitter.sizeType} @scr_ffi_call_get_len(ptr, ${emitter.sizeType})`,
            );
            dispatchBody.push(
              `  %data${i} = call ptr @scr_ffi_call_get_data(ptr %call, ${emitter.sizeType} ${i})`,
              `  %len${i} = call ${emitter.sizeType} @scr_ffi_call_get_len(ptr %call, ${emitter.sizeType} ${i})`,
            );
            if (param === "bytes") {
              emitter.declare(`declare ptr @scr_bytes_from_data(ptr, ${emitter.sizeType})`);
              dispatchBody.push(
                `  %s${i} = call ptr @scr_bytes_from_data(ptr %data${i}, ${emitter.sizeType} %len${i})`,
              );
            } else {
              emitter.declare(`declare ptr @scr_str_from_utf8_lossy(ptr, ${emitter.sizeType})`);
              dispatchBody.push(
                `  %s${i} = call ptr @scr_str_from_utf8_lossy(ptr %data${i}, ${emitter.sizeType} %len${i})`,
              );
            }
            scriptArgs.push(`ptr %s${i}`);
            break;
          }
        }
      }
      dispatchBody.push(
        `  call void %fn(${[`ptr %cb`, ...scriptArgs].join(", ")})`,
        `  ret void`,
        `}`,
        ``,
      );
      for (const line of dispatchBody) defs.push(line);

      emitter.declare(`declare ptr @scr_ffi_call_new(ptr, ptr, ptr, ${emitter.sizeType})`);
      emitter.declare(`declare void @scr_ffi_post(ptr)`);
      defs.push(
        `define internal void @${adapter.symbol}(${params.join(", ")}) ${FN_ATTRS} {`,
        `entry:`,
        `  %cb = getelementptr inbounds i8, ptr %ctx, i64 0`,
        `  %call = call ptr @scr_ffi_call_new(ptr @${adapter.table}, ptr %cb, ptr @${dispatch}, ${emitter.sizeType} ${cb.params.length})`,
      );
      for (let i = 0; i < cb.params.length; i++) {
        const param = cb.params[i]!;
        if (isFfiContextParam(param)) continue;
        if (param === "cstring") {
          emitter.declare(`declare void @scr_ffi_call_copy_cstring(ptr, ${emitter.sizeType}, ptr)`);
          defs.push(
            `  call void @scr_ffi_call_copy_cstring(ptr %call, ${emitter.sizeType} ${i}, ptr %a${i})`,
          );
        } else if (param === "string" || param === "bytes") {
          emitter.declare(
            `declare void @scr_ffi_call_copy_${param}(ptr, ${emitter.sizeType}, ptr, ${emitter.sizeType})`,
          );
          defs.push(
            `  call void @scr_ffi_call_copy_${param}(ptr %call, ${emitter.sizeType} ${i}, ptr %a${i}, ${emitter.sizeType} %a${i}_len)`,
          );
        } else if (param === "f32" || param === "i8" || param === "u16" || param === "i16") {
          const nativeTy = ffiNativeTypeLl(param);
          const op = param === "f32" ? "fpext" : param === "u16" ? "uitofp" : "sitofp";
          emitter.declare(`declare void @scr_ffi_call_set_f64(ptr, ${emitter.sizeType}, double)`);
          defs.push(
            `  %wide${i} = ${op} ${nativeTy} %a${i} to double`,
            `  call void @scr_ffi_call_set_f64(ptr %call, ${emitter.sizeType} ${i}, double %wide${i})`,
          );
        } else {
          const nativeTy = ffiNativeTypeLl(param);
          emitter.declare(
            `declare void @scr_ffi_call_set_${param}(ptr, ${emitter.sizeType}, ${nativeTy})`,
          );
          defs.push(
            `  call void @scr_ffi_call_set_${param}(ptr %call, ${emitter.sizeType} ${i}, ${nativeTy} %a${i})`,
          );
        }
      }
      defs.push(`  call void @scr_ffi_post(ptr %call)`, `  ret void`, `}`, ``);
      continue;
    }
    defs.push(
      `define internal ${ffiNativeReturnLl(cb.returns, emitter.ffiExtendNarrowIntegers)} @${adapter.symbol}(${params.join(", ")}) ${FN_ATTRS} {`,
      `entry:`,
      adapter.tls !== null
        ? `  %cb = load ptr, ptr @${adapter.tls}`
        : adapter.global !== null
          ? `  %cb = load ptr, ptr @${adapter.global}`
          : `  %cb = getelementptr inbounds i8, ptr %ctx, i64 0`,
      `  %missing = icmp eq ptr %cb, null`,
      `  br i1 %missing, label %expired, label %ready`,
      `expired:`,
      `  call void @scr_trap(ptr ${adapter.callback.lifetime === "call" ? expired : released})`,
      `  unreachable`,
      `ready:`,
      ...emitter.pendingTestLines("%pending"),
      `  br i1 %pending, label %skip, label %invoke`,
      `skip:`,
      `  ret ${ffiCallbackDummyLl(cb)}`,
      `invoke:`,
    );
    // Validate every native pointer before allocating any copy-in value.
    // A later bad slot therefore cannot leak an earlier materialization.
    for (let i = 0; i < cb.params.length; i++) {
      const param = cb.params[i]!;
      if (param !== "cstring" && param !== "string" && param !== "bytes") continue;
      const invalid = `%invalid${i}`;
      defs.push(`  %null${i} = icmp eq ptr %a${i}, null`);
      if (param === "cstring") {
        defs.push(`  ${invalid} = or i1 %null${i}, false`);
      } else {
        defs.push(
          `  %nonempty${i} = icmp ne ${emitter.sizeType} %a${i}_len, 0`,
          `  ${invalid} = and i1 %null${i}, %nonempty${i}`,
        );
      }
      const message =
        param === "cstring"
          ? "scriptc: native callback passed a NULL cstring\n"
          : `scriptc: native callback passed a NULL ${param} span with nonzero length\n`;
      defs.push(
        `  br i1 ${invalid}, label %invalid_param${i}, label %param_ok${i}`,
        `invalid_param${i}:`,
        `  call void @scr_trap(ptr ${emitter.cstr(message)})`,
        `  unreachable`,
        `param_ok${i}:`,
      );
    }
    defs.push(
      `  %fnp = getelementptr inbounds %ScrClosure, ptr %cb, i64 0, i32 1`,
      `  %fn = load ptr, ptr %fnp`,
    );
    const scriptArgs: string[] = [];
    for (let i = 0; i < cb.params.length; i++) {
      const param = cb.params[i]!;
      if (isFfiContextParam(param)) continue;
      switch (param) {
        case "i64":
        case "u64":
        case "pointer": {
          const ty = ffiNativeTypeLl(param);
          emitter.declare(`declare ptr @scr_bigint_from_${param}(${ty})`);
          defs.push(`  %s${i} = call ptr @scr_bigint_from_${param}(${ty} %a${i})`);
          scriptArgs.push(`ptr %s${i}`);
          break;
        }
        case "f64":
          scriptArgs.push(`double %a${i}`);
          break;
        case "f32":
        case "i8":
        case "u16":
        case "i16": {
          const nativeTy = ffiNativeTypeLl(param);
          const op = param === "f32" ? "fpext" : param === "u16" ? "uitofp" : "sitofp";
          defs.push(`  %s${i} = ${op} ${nativeTy} %a${i} to double`);
          scriptArgs.push(`double %s${i}`);
          break;
        }
        case "bool":
          defs.push(`  %s${i} = icmp ne i8 %a${i}, 0`);
          scriptArgs.push(`i1 %s${i}`);
          break;
        case "u8":
          defs.push(`  %s${i} = uitofp i8 %a${i} to double`);
          scriptArgs.push(`double %s${i}`);
          break;
        case "u32":
          defs.push(`  %s${i} = uitofp i32 %a${i} to double`);
          scriptArgs.push(`double %s${i}`);
          break;
        case "i32":
          defs.push(`  %s${i} = sitofp i32 %a${i} to double`);
          scriptArgs.push(`double %s${i}`);
          break;
        case "cstring":
          emitter.declare(`declare ${emitter.sizeType} @strlen(ptr)`);
          emitter.declare(`declare ptr @scr_str_from_utf8_lossy(ptr, ${emitter.sizeType})`);
          defs.push(
            `  %len${i} = call ${emitter.sizeType} @strlen(ptr %a${i})`,
            `  %s${i} = call ptr @scr_str_from_utf8_lossy(ptr %a${i}, ${emitter.sizeType} %len${i})`,
          );
          scriptArgs.push(`ptr %s${i}`);
          break;
        case "string":
          emitter.declare(`declare ptr @scr_str_from_utf8_lossy(ptr, ${emitter.sizeType})`);
          defs.push(
            `  %s${i} = call ptr @scr_str_from_utf8_lossy(ptr %a${i}, ${emitter.sizeType} %a${i}_len)`,
          );
          scriptArgs.push(`ptr %s${i}`);
          break;
        case "bytes":
          emitter.declare(`declare ptr @scr_bytes_from_data(ptr, ${emitter.sizeType})`);
          defs.push(
            `  %s${i} = call ptr @scr_bytes_from_data(ptr %a${i}, ${emitter.sizeType} %a${i}_len)`,
          );
          scriptArgs.push(`ptr %s${i}`);
          break;
      }
    }
    const ft = ffiCallbackType(cb);
    const internalRet = emitter.llType(ft.ret);
    const callArgs = [`ptr %cb`, ...scriptArgs].join(", ");
    if (cb.lifetime === "retained") {
      emitter.declare(`declare ptr @scr_closure_retain_v(ptr)`);
      emitter.declare(`declare void @scr_closure_release_v(ptr)`);
      defs.push(`  %invoke_pin = call ptr @scr_closure_retain_v(ptr %cb)`);
    }
    if (cb.returns === "void") {
      defs.push(
        `  call void %fn(${callArgs})`,
        ...(cb.lifetime === "retained"
          ? [`  call void @scr_closure_release_v(ptr %invoke_pin)`]
          : []),
        `  ret void`,
        `}`,
        ``,
      );
      continue;
    }
    defs.push(`  %result = call ${internalRet} %fn(${callArgs})`);
    if (cb.lifetime === "retained") {
      defs.push(`  call void @scr_closure_release_v(ptr %invoke_pin)`);
    }
    switch (cb.returns) {
      case "i64":
      case "u64":
      case "pointer": {
        const ty = ffiNativeTypeLl(cb.returns);
        emitter.declare(`declare ${ty} @scr_bigint_to_${cb.returns}(ptr)`);
        emitter.declare(`declare void @scr_bigint_release(ptr)`);
        defs.push(
          `  %out = call ${ty} @scr_bigint_to_${cb.returns}(ptr %result)`,
          `  call void @scr_bigint_release(ptr %result)`,
          `  ret ${ty} %out`,
        );
        break;
      }
      case "f64":
        defs.push(`  ret double %result`);
        break;
      case "f32":
        defs.push(`  %out = fptrunc double %result to float`, `  ret float %out`);
        break;
      case "bool":
        defs.push(`  %out = zext i1 %result to i8`, `  ret i8 %out`);
        break;
      case "u8":
      case "i8":
      case "u16":
      case "i16":
      case "u32":
        emitter.declare(`declare double @scr_bit_ushr(double, double)`);
        defs.push(
          `  %coerced = call double @scr_bit_ushr(double %result, double ${f64Lit(0)})`,
          `  %wide = fptoui double %coerced to i32`,
        );
        if (cb.returns !== "u32") {
          const nativeTy = ffiNativeTypeLl(cb.returns);
          defs.push(`  %out = trunc i32 %wide to ${nativeTy}`, `  ret ${nativeTy} %out`);
        } else {
          defs.push(`  ret i32 %wide`);
        }
        break;
      case "i32":
        emitter.declare(`declare double @scr_bit_or(double, double)`);
        defs.push(
          `  %coerced = call double @scr_bit_or(double %result, double ${f64Lit(0)})`,
          `  %out = fptosi double %coerced to i32`,
          `  ret i32 %out`,
        );
        break;
    }
    defs.push(`}`, ``);
  }
  return { globals, defs };
}

export function emitParts(emitter: LlEmitter): string[] {
  const parts = [
    ...limitInlineReleases(emitter.emitModuleParts(), emitter.shapeHost.rcMode),
    ...emitter.disposeObserverGates(),
  ];
  if (!emitter.executableTls) return parts;
  // A worker executable's thread-locals all live in the executable's own
  // TLS block: the program's internal ones, and the runtime's external
  // ones, because the runtime is always linked statically into the
  // executable. So on ELF they can all use the local-exec model: LLVM's
  // default general-dynamic sequence (relaxed by the linker to `mov %fs:0`
  // plus an add), and even initial-exec (relaxed to `mov $offset` plus an
  // indexed access), become one %fs-relative operand LLVM can fold into
  // loads and compares. Darwin's thread-local variables have one model.
  return parts.map((part) =>
    part
      .replace(
        /^(@[-$._A-Za-z0-9]+ = internal )thread_local global /gm,
        "$1thread_local(localexec) global ",
      )
      .replace(
        /^(@[-$._A-Za-z0-9]+ = external )thread_local global /gm,
        "$1thread_local(localexec) global ",
      ),
  );
}
