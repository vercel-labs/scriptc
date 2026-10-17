import { emitBigIntWrap } from "./bigint-wrap.js";
import { emitBorrowedInput, emitBorrowedInputs } from "./borrowed-inputs.js";
import { borrowsIteratorInputs, borrowsJsonInputs } from "./checked-value-lifetimes.js";
import { emitTlsLibCall } from "./lib-tls.js";
import { emitHttp2LibCall } from "./lib-http2.js";
import { emitDatagramLibCall } from "./lib-datagram.js";
import { emitTestLibCall } from "./lib-test.js";
/* Focused LLVM library-call emission extracted from emitter.ts. */
import { InternalCompilerError } from "../../errors.js";

import { MAY_THROW_LIB_FNS } from "../../ir/builtin-effects.js";
import { LlvmUnsupportedError } from "./unsupported.js";
import type { LlvmEmitterContext, LibCallExpr, LibCallPrefix, LlValue } from "./expr-context.js";
import { ASSERT_VERDICT_LIB_FNS, LIB_FN_SYMS, USES_TIMERS_LIB_FNS } from "./lib-shared.js";
import { isDynUndefined } from "../../ir/runtime-features.js";
import { DYN_KIND } from "./dyn.js";
import { rawBytes } from "./lib-abi.js";
import { emitInlineAtomicsOp } from "./expr-bytes.js";

export function emitAssertInspectLibCall(host: LlvmEmitterContext, e: LibCallExpr): LlValue {
  const B = host.B;
  if (e.fn === "assert.shapeStr" || e.fn === "assert.shapeRe") {
    // The throws(fn, {shape}) accumulator's slot writers: the key is a
    // C int (the generic path would pass a double through the ABI —
    // fptosi here, exactly the C prototype's implicit conversion).
    // Never throw.
    const key = host.emitExpr(e.args[0]!);
    const v = host.emitExpr(e.args[1]!);
    const sym = e.fn === "assert.shapeStr" ? "scr_assert_shape_str" : "scr_assert_shape_re";
    host.declare(`declare void @${sym}(i32, ptr)`);
    const k32 = B.tmp();
    B.line(`${k32} = fptosi double ${key.name} to i32`);
    B.line(`call void @${sym}(i32 ${k32}, ptr ${v.name})`);
    return { name: "", type: e.type };
  }
  return host.emitGenericLibCall(e);
}

export function emitIoLibCall(host: LlvmEmitterContext, e: LibCallExpr): LlValue {
  const B = host.B;
  if (e.fn === "rl.create" || e.fn === "rl.createSignal") {
    // readline interface handles are runtime IDs (doubles); an open
    // interface on stdin holds the loop. The mode literal says which
    // optional arguments follow (lowerReadlineCreateCall): a stream input
    // or output goes through scr_stream.c's bridge.
    host.usesTimers = true;
    const modeArg = e.args[0]!;
    if (modeArg.kind !== "numLit") {
      throw new InternalCompilerError("llvm emitter bug: rl.create mode is not a literal");
    }
    const mode = modeArg.value;
    let i = 1;
    const input = mode & 1 ? host.emitExpr(e.args[i++]!).name : "null";
    const output = mode & 2 ? host.emitExpr(e.args[i++]!).name : "null";
    const crlf = host.emitExpr(e.args[i++]!).name;
    const prompt = mode & 16 ? host.emitExpr(e.args[i++]!).name : "null";
    const signal = mode & 8 ? host.emitExpr(e.args[i++]!).name : "null";
    let add = "null";
    if (mode & 8) {
      host.declare(`declare ptr @scr_events_add_abort_listener(ptr, ptr)`);
      add = "@scr_events_add_abort_listener";
    }
    const stdout = mode & 4 ? "true" : "false";
    const t = B.tmp();
    if (mode & 3) {
      host.declare(`declare double @scr_stream_rl_open(ptr, ptr, i1, double, ptr, ptr, ptr)`);
      B.line(
        `${t} = call double @scr_stream_rl_open(ptr ${input}, ptr ${output}, i1 ${stdout}, double ${crlf}, ptr ${prompt}, ptr ${signal}, ptr ${add})`,
      );
    } else {
      host.declare(`declare double @scr_rl_open(ptr, ptr, ptr, i1, double, ptr, ptr, ptr)`);
      B.line(
        `${t} = call double @scr_rl_open(ptr null, ptr null, ptr null, i1 ${stdout}, double ${crlf}, ptr ${prompt}, ptr ${signal}, ptr ${add})`,
      );
    }
    // A signal that is not an AbortSignal throws ERR_INVALID_ARG_TYPE.
    if (mode & 8) host.emitPendingCheck();
    return { name: t, type: e.type };
  }
  if (e.fn === "rl.question") {
    // The answer callback MOVES into the interface's registry; throws
    // Node's use-after-close error (the may-throw seed).
    host.usesTimers = true;
    const cbT = e.args[2]!.type;
    if (cbT.kind !== "func")
      throw new InternalCompilerError("llvm emitter bug: rl.question callback not a func");
    const args = e.args.map((a) => host.emitExpr(a));
    host.moveTemp(args[2]!);
    const adapter =
      cbT.params.length === 0
        ? "scr_rl_answer_thunk0"
        : cbT.params[0]!.kind === "dyn"
          ? "scr_rl_answer_thunk_dyn"
          : "scr_rl_answer_thunk_str";
    host.declare(`declare void @${adapter}(ptr, ptr)`);
    host.declare(`declare void @scr_rl_question(double, ptr, ptr, ptr)`);
    B.line(
      `call void @scr_rl_question(double ${args[0]!.name}, ptr ${args[1]!.name}, ptr ${args[2]!.name}, ptr @${adapter})`,
    );
    host.emitPendingCheck();
    return { name: "", type: e.type };
  }
  if (e.fn === "rl.questionAsync" || e.fn === "rl.questionAsyncSignal") {
    // The promise question never throws: closed interfaces and aborted
    // signals reject the answered promise (+1).
    host.usesTimers = true;
    const args = e.args.map((a) => host.emitExpr(a));
    let signal = "null";
    let add = "null";
    if (e.fn === "rl.questionAsyncSignal") {
      signal = args[2]!.name;
      host.declare(`declare ptr @scr_events_add_abort_listener(ptr, ptr)`);
      add = "@scr_events_add_abort_listener";
    }
    host.declare(`declare ptr @scr_rl_question_promise(double, ptr, ptr, ptr)`);
    const t = B.tmp();
    B.line(
      `${t} = call ptr @scr_rl_question_promise(double ${args[0]!.name}, ptr ${args[1]!.name}, ptr ${signal}, ptr ${add})`,
    );
    return host.own({ name: t, type: e.type });
  }
  if (e.fn === "rl.keypressStdin") {
    // emitKeypressEvents(process.stdin): no stream side
    host.usesTimers = true;
    const args = e.args.map((a) => host.emitExpr(a));
    host.declare(`declare void @scr_rl_keypress_events(ptr, ptr, double, double)`);
    B.line(
      `call void @scr_rl_keypress_events(ptr null, ptr null, double ${args[0]!.name}, double ${args[1]!.name})`,
    );
    return { name: "", type: e.type };
  }
  if (e.fn === "rl.terminal") {
    // A completer's errors print through the inspect unit, which links
    // only when there is a completer: its inspect function rides along.
    const args = e.args.map((a) => host.emitExpr(a));
    let inspect = "null";
    if (!isDynUndefined(e.args[3]!)) {
      host.declare(`declare ptr @scr_insp_dyn(ptr, double, double)`);
      inspect = "@scr_insp_dyn";
    }
    host.declare(`declare void @scr_rl_terminal(double, double, i1 zeroext, ptr, i1 zeroext, ptr)`);
    B.line(
      `call void @scr_rl_terminal(double ${args[0]!.name}, double ${args[1]!.name}, i1 zeroext ${args[2]!.name}, ptr ${args[3]!.name}, i1 zeroext ${args[4]!.name}, ptr ${inspect})`,
    );
    return { name: "", type: e.type };
  }
  if (e.fn === "rl.on") {
    // The listener MOVES into the interface's registry; the adapter is
    // picked by event and parameter count ('line': the text, 'error': the
    // error, 'history': the history array, the rest none).
    host.usesTimers = true;
    const cbT = e.args[2]!.type;
    const evArg = e.args[1]!;
    if (cbT.kind !== "func" || evArg.kind !== "numLit") {
      throw new InternalCompilerError("llvm emitter bug: rl.on operands");
    }
    const id = host.emitExpr(e.args[0]!);
    const ev = host.emitExpr(evArg);
    const cb = host.emitExpr(e.args[2]!);
    const once = host.emitExpr(e.args[3]!);
    host.moveTemp(cb);
    let adapter = "null";
    if (evArg.value === 0 || evArg.value === 4) {
      const param = cbT.params[0];
      const kind =
        param === undefined ? "0" : param.kind === "dyn" ? "_dyn" : evArg.value === 0 ? "_str" : "";
      const name = evArg.value === 0 ? `scr_rl_answer_thunk${kind}` : `scr_rl_error_thunk${kind}`;
      host.declare(`declare void @${name}(ptr, ptr)`);
      adapter = `@${name}`;
    } else if (evArg.value === 5 && cbT.params.length === 1) {
      const name =
        cbT.params[0]!.kind === "dyn" ? "scr_rl_history_thunk_dyn" : "scr_rl_history_thunk_arr";
      host.declare(`declare void @${name}(ptr, ptr)`);
      adapter = `@${name}`;
    }
    host.declare(`declare void @scr_rl_on(double, double, ptr, ptr, i1)`);
    B.line(
      `call void @scr_rl_on(double ${id.name}, double ${ev.name}, ptr ${cb.name}, ptr ${adapter}, i1 ${once.name})`,
    );
    return { name: "", type: e.type };
  }
  return host.emitGenericLibCall(e);
}

export function emitGenericLibCall(host: LlvmEmitterContext, e: LibCallExpr): LlValue {
  const B = host.B;
  if (host.coroAwait && e.fn === "async.hop") {
    host.emitCoroAwait(null);
    return { name: "", type: e.type };
  }
  if (host.wasi && e.fn === "async.awaitDyn") {
    const value = host.emitExpr(e.args[0]!);
    host.declare(`declare ptr @scr_dyn_promise_of(ptr)`);
    const promise = B.tmp();
    const isPromise = B.tmp();
    const wait = B.newLabel("await.dyn.promise");
    const hop = B.newLabel("await.dyn.value");
    const ready = B.newLabel("await.dyn.ready");
    B.line(`${promise} = call ptr @scr_dyn_promise_of(ptr ${value.name})`);
    B.line(`${isPromise} = icmp ne ptr ${promise}, null`);
    B.condBr(isPromise, wait, hop);
    B.startBlock(wait);
    host.emitWasiSuspend(promise);
    B.br(ready);
    B.startBlock(hop);
    host.emitWasiSuspend(null);
    B.br(ready);
    B.startBlock(ready);
    host.declare(`declare ptr @scr_await_dyn_value_settled(ptr)`);
    const result = B.tmp();
    B.line(`${result} = call ptr @scr_await_dyn_value_settled(ptr ${value.name})`);
    const output = host.own({ name: result, type: e.type });
    host.emitPendingCheck();
    return output;
  }
  if (e.fn === "dyn.typedRefIs" || e.fn === "dyn.typedRefKeyIs") {
    const literal = e.args[1]!.kind === "strLit" ? e.args[1]!.value : null;
    if (e.fn === "dyn.typedRefKeyIs" && literal === null)
      throw new InternalCompilerError("llvm emitter bug: dyn.typedRefKeyIs needs a literal key");
    // A literal brand cannot replace the receiver while being evaluated.
    // Generated class dispatch uses these probes repeatedly on one local.
    const value = literal !== null ? host.emitReadReceiver(e.args[0]!) : host.emitExpr(e.args[0]!);
    const key = e.fn === "dyn.typedRefIs" ? host.emitExpr(e.args[1]!) : null;
    // Expose the capsule tag to LLVM so class dispatch can skip the whole
    // chain of brand comparisons for ordinary checked-dynamic values.
    // Keep the runtime's null handling and evaluate both operands once.
    const slot = B.slot();
    B.entryAllocas.push(`${slot} = alloca i1`);
    B.line(`store i1 false, ptr ${slot}`);
    const present = B.tmp();
    const inspect = B.newLabel("brand.inspect");
    const capsule = B.newLabel("brand.capsule");
    const done = B.newLabel("brand.done");
    B.line(`${present} = icmp ne ptr ${value.name}, null`);
    B.condBr(present, inspect, done);
    B.startBlock(inspect);
    const kind = host.dynKind(value.name);
    const typed = B.tmp();
    B.line(`${typed} = icmp eq i32 ${kind}, ${DYN_KIND.TYPED_REF}`);
    B.condBr(typed, capsule, done);
    B.startBlock(capsule);
    // Capsules boxed by this program share its key constant, so a pointer
    // match answers without comparing names.
    if (literal !== null) {
      const keySlot = B.tmp(),
        keyPtr = B.tmp(),
        same = B.tmp();
      B.line(
        `${keySlot} = getelementptr inbounds i8, ptr ${value.name}, i64 ${host.abiOffset(40, 28)} ; ->v.typed_ref.type_key`,
      );
      B.line(`${keyPtr} = load ptr, ptr ${keySlot}`);
      B.line(`${same} = icmp eq ptr ${keyPtr}, ${host.cstr(literal)}`);
      if (e.fn === "dyn.typedRefKeyIs") {
        B.line(`store i1 ${same}, ptr ${slot}`);
        B.br(done);
      } else {
        const compare = B.newLabel("brand.compare");
        B.line(`store i1 true, ptr ${slot}`);
        B.condBr(same, done, compare);
        B.startBlock(compare);
      }
    }
    if (e.fn === "dyn.typedRefIs") {
      host.declare("declare zeroext i1 @scr_dyn_typed_ref_is_key(ptr, ptr) memory(read)");
      const matches = B.tmp();
      B.line(
        `${matches} = call zeroext i1 @scr_dyn_typed_ref_is_key(ptr ${value.name}, ptr ${key!.name})`,
      );
      B.line(`store i1 ${matches}, ptr ${slot}`);
      B.br(done);
    }
    B.startBlock(done);
    const result = B.tmp();
    B.line(`${result} = load i1, ptr ${slot}`);
    return { name: result, type: e.type };
  }
  if (e.fn === "crypto.randomFillCb" || e.fn === "crypto.randomFillCbDyn") {
    host.usesTimers = true;
    const args = e.args.map((arg) => host.emitExpr(arg));
    const cbT = e.args[4]!.type;
    if (cbT.kind !== "func")
      throw new InternalCompilerError("llvm emitter bug: randomFill callback not a func");
    host.moveTemp(args[4]!);
    const dyn = e.fn === "crypto.randomFillCbDyn";
    const adapter = host.cryptoBytesThunkFor(cbT, false, dyn ? "dyn" : "view");
    const symbol = dyn ? "scr_crypto_random_fill_async_dyn" : "scr_crypto_random_fill_async";
    const position = dyn ? "ptr" : "double";
    host.declare(`declare void @${symbol}(ptr, ${position}, ${position}, double, ptr, ptr)`);
    B.line(
      `call void @${symbol}(ptr ${args[0]!.name}, ${position} ${args[1]!.name}, ${position} ${args[2]!.name}, double ${args[3]!.name}, ptr ${args[4]!.name}, ptr @${adapter})`,
    );
    host.emitPendingCheck();
    return { name: "", type: e.type };
  }
  if (e.fn === "crypto.generateKeyCb") {
    host.usesTimers = true;
    const args = e.args.map((arg) => host.emitExpr(arg));
    const cbT = e.args[2]!.type;
    if (cbT.kind !== "func")
      throw new InternalCompilerError("llvm emitter bug: generateKey callback not a func");
    host.moveTemp(args[2]!);
    const adapter = host.cryptoBytesThunkFor(cbT, false, "dyn");
    host.declare(`declare void @scr_crypto_generate_key_async(ptr, ptr, ptr, ptr)`);
    B.line(
      `call void @scr_crypto_generate_key_async(ptr ${args[0]!.name}, ptr ${args[1]!.name}, ptr ${args[2]!.name}, ptr @${adapter})`,
    );
    host.emitPendingCheck();
    return { name: "", type: e.type };
  }
  if (e.fn === "crypto.randomIntCb") {
    host.usesTimers = true;
    const args = e.args.map((arg) => host.emitExpr(arg));
    const cbT = e.args[3]!.type;
    if (cbT.kind !== "func")
      throw new InternalCompilerError("llvm emitter bug: randomInt callback not a func");
    host.moveTemp(args[3]!);
    const adapter = host.cryptoIntThunkFor(cbT);
    host.declare(`declare void @scr_crypto_random_int_async(double, double, double, ptr, ptr)`);
    B.line(
      `call void @scr_crypto_random_int_async(double ${args[0]!.name}, double ${args[1]!.name}, double ${args[2]!.name}, ptr ${args[3]!.name}, ptr @${adapter})`,
    );
    host.emitPendingCheck();
    return { name: "", type: e.type };
  }
  if (
    e.fn === "crypto.randomBytesCb" ||
    e.fn === "crypto.pbkdf2Cb" ||
    e.fn === "crypto.hkdfCb" ||
    e.fn === "crypto.scryptCb"
  ) {
    host.usesTimers = true;
    const args = e.args.map((arg) => host.emitExpr(arg));
    const cbIndex = e.fn === "crypto.randomBytesCb" ? 1 : e.fn === "crypto.scryptCb" ? 4 : 5;
    const cbT = e.args[cbIndex]!.type;
    if (cbT.kind !== "func")
      throw new InternalCompilerError("llvm emitter bug: crypto callback not a func");
    host.moveTemp(args[cbIndex]!);
    const adapter = host.cryptoBytesThunkFor(cbT, e.fn === "crypto.hkdfCb");
    if (e.fn === "crypto.randomBytesCb") {
      host.declare(`declare void @scr_crypto_random_bytes_async(double, ptr, ptr)`);
      B.line(
        `call void @scr_crypto_random_bytes_async(double ${args[0]!.name}, ptr ${args[1]!.name}, ptr @${adapter})`,
      );
    } else if (e.fn === "crypto.hkdfCb") {
      host.declare(`declare void @scr_crypto_hkdf_async(ptr, ptr, ptr, ptr, double, ptr, ptr)`);
      B.line(
        `call void @scr_crypto_hkdf_async(ptr ${args[0]!.name}, ptr ${args[1]!.name}, ptr ${args[2]!.name}, ptr ${args[3]!.name}, double ${args[4]!.name}, ptr ${args[5]!.name}, ptr @${adapter})`,
      );
    } else if (e.fn === "crypto.scryptCb") {
      host.declare(`declare void @scr_crypto_scrypt_async(ptr, ptr, double, ptr, ptr, ptr)`);
      B.line(
        `call void @scr_crypto_scrypt_async(ptr ${args[0]!.name}, ptr ${args[1]!.name}, double ${args[2]!.name}, ptr ${args[3]!.name}, ptr ${args[4]!.name}, ptr @${adapter})`,
      );
    } else {
      host.declare(
        `declare void @scr_crypto_pbkdf2_async(ptr, ptr, double, double, ptr, ptr, ptr)`,
      );
      B.line(
        `call void @scr_crypto_pbkdf2_async(ptr ${args[0]!.name}, ptr ${args[1]!.name}, double ${args[2]!.name}, double ${args[3]!.name}, ptr ${args[4]!.name}, ptr ${args[5]!.name}, ptr @${adapter})`,
      );
    }
    host.emitPendingCheck();
    return { name: "", type: e.type };
  }
  if (
    e.fn === "http.request" ||
    e.fn === "http.requestCb" ||
    e.fn === "http.requestUrl" ||
    e.fn === "http.requestUrlCb" ||
    e.fn === "http.requestAgent" ||
    e.fn === "http.requestAgentCb" ||
    e.fn === "https.request" ||
    e.fn === "https.requestCb" ||
    e.fn === "https.requestUrl" ||
    e.fn === "https.requestUrlCb"
  ) {
    // The https URL row is the http one with the TLS entry point — same
    // three arguments, same response-callback adapter. The https options
    // row is wider: rejectUnauthorized stays an i1, while its ScrStr or
    // ScrBytes CA value expands to the runtime's raw pointer + length.
    const isTls = e.fn.startsWith("https.");
    const isUrl = e.fn.includes("requestUrl");
    const isTlsOptions = isTls && !isUrl;
    const isAgent = e.fn.startsWith("http.requestAgent");
    const cbIdx = isUrl ? 3 : isTlsOptions ? 9 : isAgent ? 8 : 7;
    const hasCb = e.fn.endsWith("Cb");
    const args = e.args.map((a) => host.emitExpr(a));
    let cb = "null";
    let adapter = "null";
    if (hasCb) {
      const cbT = e.args[cbIdx]!.type;
      if (cbT.kind !== "func")
        throw new InternalCompilerError(`llvm emitter bug: ${e.fn} callback not a func`);
      host.moveTemp(args[cbIdx]!);
      cb = args[cbIdx]!.name;
      const sym = cbT.params.length === 0 ? "scr_http_resp_thunk0" : "scr_http_resp_thunk_res";
      host.declare(`declare void @${sym}(ptr, ptr)`);
      adapter = `@${sym}`;
    }
    const head = args.slice(0, cbIdx);
    const entry = isTlsOptions
      ? "scr_https_request"
      : isTls
        ? "scr_https_request_url"
        : isUrl
          ? "scr_http_request_url"
          : isAgent
            ? "scr_http_request_agent"
            : "scr_http_request";
    let callArgs = head.map((a) => `${host.llType(a.type)} ${a.name}`);
    if (isTlsOptions) {
      callArgs = [
        ...callArgs.slice(0, 8),
        ...rawBytes(host, args[8]!).map((arg) => `${arg.type} ${arg.name}`),
      ];
      host.declare(
        `declare ptr @scr_https_request(ptr, double, ptr, ptr, double, ptr, i1 zeroext, i1 zeroext, ptr, ${host.sizeType}, ptr, ptr)`,
      );
    } else {
      const decls = head.map((a) =>
        host.llType(a.type) === "i1" ? "i1 zeroext" : host.llType(a.type),
      );
      host.declare(`declare ptr @${entry}(${[...decls, "ptr", "ptr"].join(", ")})`);
    }
    const t = B.tmp();
    B.line(`${t} = call ptr @${entry}(${[...callArgs, `ptr ${cb}`, `ptr ${adapter}`].join(", ")})`);
    const out = host.own({ name: t, type: e.type });
    if (MAY_THROW_LIB_FNS.has(e.fn)) host.emitPendingCheck();
    return out;
  }
  if (MAY_THROW_LIB_FNS.has(e.fn) && LIB_FN_SYMS[e.fn] === undefined) {
    throw new LlvmUnsupportedError(`libCall:${e.fn}`, e.loc);
  }
  const sym = LIB_FN_SYMS[e.fn];
  if (sym === undefined) throw new LlvmUnsupportedError(`libCall:${e.fn}`, e.loc);
  const args = READ_ONLY_STRING_LIB_FNS.has(e.fn)
    ? emitBorrowedInputs(host, e.args)
    : e.args.map((a) =>
        borrowsJsonInputs(e.fn) || borrowsIteratorInputs(e.fn)
          ? emitBorrowedInput(host, a)
          : host.emitExpr(a),
      );
  // The deep comparisons' number test: computed here, with no runtime call.
  if (e.fn === "assert.sameValue")
    return { name: emitSameValueF64(host, args[0]!.name, args[1]!.name), type: e.type };
  const argDecls = args.map((a) => {
    const ty = host.llType(a.type);
    return ty === "i1" ? "i1 zeroext" : ty;
  });
  const retTy = host.llType(e.type);
  const retDecl = retTy === "i1" ? "zeroext i1" : retTy;
  host.declare(`declare ${retDecl} @${sym}(${argDecls.join(", ")})`);
  const argList = args.map((a, index) => `${argDecls[index]} ${a.name}`).join(", ");
  if (retTy === "void") {
    const failing = emitAssertFailing(host, e.fn, args);
    let passed: string | null = null;
    if (failing !== null) {
      const fail = B.newLabel("assert.fail");
      passed = B.newLabel("assert.pass");
      B.condBr(failing, fail, passed);
      B.startBlock(fail);
    }
    // An Assert instance's options apply to this call only: set after the
    // arguments are evaluated, consumed by a failure, cleared by a pass.
    const options =
      e.assertOptions === undefined
        ? 0
        : (e.assertOptions.diff === "full" ? 1 : 0) | (e.assertOptions.skipPrototype ? 2 : 0);
    if (options !== 0) {
      host.declare("declare void @scr_assert_set_options(i32)");
      B.line(`call void @scr_assert_set_options(i32 ${options})`);
    }
    B.line(`call void @${sym}(${argList})`);
    if (options !== 0 && failing === null) {
      host.declare("declare void @scr_assert_clear_options()");
      B.line("call void @scr_assert_clear_options()");
    }
    if (MAY_THROW_LIB_FNS.has(e.fn)) host.emitPendingCheck();
    if (passed !== null) {
      B.br(passed);
      B.startBlock(passed);
    }
    return { name: "", type: e.type };
  }
  const t = B.tmp();
  B.line(`${t} = call ${retDecl} @${sym}(${argList})`);
  // The result joins its frame BEFORE the pending check so an unwind
  // releases the dummy (NULL for refcounted returns) harmlessly.
  const out = host.own({ name: t, type: e.type });
  if (MAY_THROW_LIB_FNS.has(e.fn)) host.emitPendingCheck();
  return out;
}

/** SameValue over doubles, as scr_assert_same_value_f64 computes it: equal
 * bits, or both NaN. +0 and -0 differ. */
function emitSameValueF64(host: LlvmEmitterContext, a: string, b: string): string {
  const B = host.B;
  const bitsA = B.tmp();
  const bitsB = B.tmp();
  const equalBits = B.tmp();
  const nanA = B.tmp();
  const nanB = B.tmp();
  const bothNan = B.tmp();
  const same = B.tmp();
  B.line(`${bitsA} = bitcast double ${a} to i64`);
  B.line(`${bitsB} = bitcast double ${b} to i64`);
  B.line(`${equalBits} = icmp eq i64 ${bitsA}, ${bitsB}`);
  B.line(`${nanA} = fcmp uno double ${a}, ${a}`);
  B.line(`${nanB} = fcmp uno double ${b}, ${b}`);
  B.line(`${bothNan} = and i1 ${nanA}, ${nanB}`);
  B.line(`${same} = or i1 ${equalBits}, ${bothNan}`);
  return same;
}

/** The failure test of an assertion call that returns at once when the
 * assertion passes, or null for other calls. Result calls carry their
 * verdict; strictEqual over numbers and booleans compares here with the
 * runtime's test: SameValue (equal bits, or both NaN) and `==`. */
function emitAssertFailing(
  host: LlvmEmitterContext,
  fn: string,
  args: readonly LlValue[],
): string | null {
  const B = host.B;
  const negatedIndex = ASSERT_VERDICT_LIB_FNS.get(fn);
  if (negatedIndex !== undefined) {
    const failing = B.tmp();
    const verdict = args[0]!.name;
    if (negatedIndex === null) B.line(`${failing} = xor i1 ${verdict}, true`);
    else B.line(`${failing} = icmp eq i1 ${verdict}, ${args[negatedIndex]!.name}`);
    return failing;
  }
  if (fn !== "assert.eqF64" && fn !== "assert.eqBool") return null;
  const [a, b, negated] = [args[0]!.name, args[1]!.name, args[2]!.name];
  let same: string;
  if (fn === "assert.eqBool") {
    same = B.tmp();
    B.line(`${same} = icmp eq i1 ${a}, ${b}`);
  } else {
    same = emitSameValueF64(host, a, b);
  }
  const failing = B.tmp();
  B.line(`${failing} = icmp eq i1 ${same}, ${negated}`);
  return failing;
}

/** Runtime string functions that only read their string arguments and keep
 * no reference to them: their operands are lent (a comparator's
 * `a.name.localeCompare(b.name)` reads both fields without retaining). */
const READ_ONLY_STRING_LIB_FNS: ReadonlySet<string> = new Set(["str.localeCompare"]);

export function emitLibCall(host: LlvmEmitterContext, e: LibCallExpr): LlValue {
  if (USES_TIMERS_LIB_FNS.has(e.fn)) host.usesTimers = true;
  if (e.fn === "process.nextTick") return host.emitAsyncContextLibCall(e);
  if (
    e.fn === "sp.pipeline" ||
    e.fn === "sp.pipelineStages" ||
    e.fn.startsWith("sp.pipelineOpts") ||
    e.fn.startsWith("sp.finishedOpts")
  )
    return host.emitStreamLibCall(e);
  if (e.fn === "bigint.parse" && e.args[0]?.kind === "strLit") {
    // Literals (`123n`) and constant BigInt("...") texts are immortal
    // statics instead of a parse at every evaluation.
    const sym = host.internBigIntLiteral(e.args[0].value);
    if (sym) return host.own({ name: host.retainValue(sym, e.type), type: e.type });
  }
  if (e.fn.startsWith("bigint.")) {
    // Small-value operator trees run in 64-bit registers (bigint-wrap.ts).
    const fused = emitBigIntWrap(host, e);
    if (fused) return fused;
  }
  // timers/promises arms the timer heap or the immediate queue, so the
  // loop runs even when nothing awaits the promise: a pending ref'd timer
  // keeps the process alive, as in Node.
  if (e.fn.startsWith("tp.")) host.usesTimers = true;
  if (e.fn === "atomics.op") {
    const inline = emitInlineAtomicsOp(host, e);
    if (inline) return inline;
  }
  const prefix = e.fn.slice(0, e.fn.indexOf(".")) as LibCallPrefix;
  // events.once builds typed listener adapters beside the emitter calls.
  if (e.fn === "events.once") return host.emitErrorsEventsLibCall(e);
  switch (prefix) {
    case "fetch":
    case "abort":
    case "json":
      return host.emitWebLibCall(e);
    case "dyn":
    case "global":
      return host.emitDynamicLibCall(e);
    case "fs":
    case "fsp":
    case "fileHandle":
    case "dir":
    case "watcher":
    case "stats":
    case "zlib":
    case "atomics":
      return host.emitFilesystemLibCall(e);
    case "path":
    case "os":
    case "url":
    case "sp":
    case "qs":
      return host.emitPathUrlLibCall(e);
    case "math":
    case "num":
    case "str":
    case "regexp":
    case "intl":
    case "sym":
    case "perf":
    case "number":
    case "date":
    case "text":
    case "string":
    case "class":
      return host.emitPrimitiveLibCall(e);
    case "cp":
    case "spawnRes":
    case "child":
    case "writer":
    case "procStream":
      return host.emitChildProcessLibCall(e);
    case "tp":
    case "dc":
    case "timers":
    case "async":
    case "als":
      return host.emitAsyncContextLibCall(e);
    case "process":
    case "stdin":
      return host.emitProcessLibCall(e);
    case "module":
    case "worker":
      return host.emitGenericLibCall(e);
    case "error":
    case "regex":
    case "emitter":
      return host.emitErrorsEventsLibCall(e);
    case "stream":
    case "readable":
    case "writable":
    case "duplex":
    case "transform":
    case "passthrough":
    case "sc":
      return host.emitStreamLibCall(e);
    case "dgram":
    case "dns":
      return emitDatagramLibCall(host, e);
    case "net":
    case "http":
    case "https":
      return host.emitNetworkHttpLibCall(e);
    case "assert":
    case "insp":
      return host.emitAssertInspectLibCall(e);
    case "rl":
    case "strdec":
      return host.emitIoLibCall(e);
    case "console":
      // The tail of a console lowering whose effects sit in its
      // statements: nothing runs.
      if (e.fn === "console.noop") return { name: "", type: e.type };
      return host.emitGenericLibCall(e);
    case "weakMap":
    case "weakSet":
    case "ffi":
    case "sharedArrayBuffer":
    case "arrayBuffer":
    case "util":
    case "bigint":
    case "crypto":
    case "buffer":
    case "bytes":
    case "tlsca":
    case "event":
    case "events":
    case "blob":
    case "record":
      return host.emitGenericLibCall(e);
    case "test":
      return emitTestLibCall(host, e);
    case "tls":
      return emitTlsLibCall(host, e);
    case "http2":
      return emitHttp2LibCall(host, e);
    default: {
      const _exhaustive: never = prefix;
      void _exhaustive;
      throw new InternalCompilerError("unreachable");
    }
  }
}
