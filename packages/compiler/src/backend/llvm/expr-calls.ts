/* Focused LLVM expression emission extracted from emitter.ts. */
import { InternalCompilerError } from "../../errors.js";
import { callbackIgnoresReceiver } from "./constant-callbacks.js";
import { newValueMayThrow } from "../../ir/analysis.js";
import {
  isFfiCallbackParam,
  isFfiContextParam,
  isFfiReleaseParam,
  isRefCounted,
} from "../../ir/ir.js";
import { collectFfiRetainedOps, parseFfiCallbackKey } from "../ffi-callbacks.js";
import {
  mangleBorrowedFunction,
  mangleClassNew,
  mangleClassRetain,
  mangleClassStruct,
  mangleFnClosure,
  mangleFunction,
  mangleLocal,
  mangleWrapper,
  mangleVtStruct,
} from "../mangle.js";
import { classMembershipIntervals, classEnvironmentIndex, classStructSym } from "./classes.js";
import { LlvmUnsupportedError } from "./unsupported.js";
import type { LlvmEmitterContext, ExprOf, LlValue } from "./expr-context.js";
import { f64Lit, ffiNativeTypeLl, ffiNativeParamLl, ffiNativeReturnLl } from "./common.js";
import { canStackUnion, emitStackUnion } from "./stack-unions.js";
import { emitCallArrayRead } from "./local-array-reads.js";
import { emitStackMapRead } from "./map-read-lifetimes.js";
import { borrowableInputs, emitBorrowedInput } from "./borrowed-inputs.js";

export function emitCallExpr(
  host: LlvmEmitterContext,
  e: ExprOf<
    | "call"
    | "ffiCall"
    | "closure"
    | "callValue"
    | "selfRef"
    | "new"
    | "classRef"
    | "newValue"
    | "instanceOfValue"
    | "promiseVoidWiden"
    | "upcast"
    | "downcast"
    | "instanceOf"
    | "virtualCall"
  >,
): LlValue {
  const B = host.B;
  switch (e.kind) {
    case "call": {
      const callee = host.fnByName.get(e.callee);
      if (!callee) throw new InternalCompilerError(`llvm emitter bug: unknown callee ${e.callee}`);
      if (callee.captures !== undefined)
        throw new InternalCompilerError(
          `llvm emitter bug: direct call to lifted function ${e.callee}`,
        );
      const borrowed = host.callLifetimes.borrowed.get(e.callee);
      const projected = host.callLifetimes.parameters.get(e.callee);
      const inputs = borrowed
        ? borrowableInputs(host, e.args, host.referenceEffects.functions.has(e.callee))
        : [];
      // Borrowed snapshots live through this call, not through the whole
      // enclosing expression. Otherwise a large initializer accumulates
      // owners and repeats their cleanup at every later throwing call.
      if (borrowed) host.frames.push([]);
      const args = e.args.map((a, index) => {
        if (borrowed?.has(index)) {
          // A heap-borrowing helper may retain or return its argument.
          // Only projection-only parameters may see an unowned stack box,
          // including when one IR expression is shared by two positions.
          if (projected?.has(index)) {
            const callback = host.stackCallbacks.emit(host, a);
            if (callback) return callback;
            const read = host.callArrayReads.get(a);
            if (read) return emitCallArrayRead(host, read);
            const mapRead = host.mapReadLifetimes.arguments.get(a);
            if (mapRead) {
              const result = emitStackMapRead(host, mapRead);
              if (result.owner) host.ownSlot(result.owner.slot, result.owner.type);
              return result.value;
            }
            if (canStackUnion(a, host.unionsById)) return emitStackUnion(host, a).value;
          }
          if (inputs[index]) return host.emitReadReceiver(a);
        }
        return host.emitExpr(a);
      });
      // A borrowed parameter's owned argument stays in the caller frame.
      // This also preserves snapshots when a later argument mutates its
      // source, and releases earlier arguments if evaluation throws.
      args.forEach((a, index) => {
        if (!borrowed?.has(index)) host.moveTemp(a);
      });
      const argList = args
        .map((a, i) => `${host.llType(callee.params[i]!.type)} ${a.name}`)
        .join(", ");
      // Async callee: the spawn wrapper runs the body eagerly to its
      // first suspension and returns the promise (+1). The call itself
      // never unwinds — rejections surface at await (computeMayThrow's
      // async exclusion).
      const target = `@${borrowed ? mangleBorrowedFunction(e.callee) : host.callTarget(e.callee)}`;
      if (e.type.kind === "void") {
        B.line(`call void ${target}(${argList})`);
        if (host.mayThrow.has(e.callee)) host.emitPendingCheck();
        if (borrowed) host.releaseFrame(host.frames.pop()!);
        return { name: "", type: e.type };
      }
      const t = B.tmp();
      B.line(`${t} = call ${host.llType(e.type)} ${target}(${argList})`);
      const out = host.own({ name: t, type: e.type });
      if (host.mayThrow.has(e.callee)) host.emitPendingCheck();
      if (borrowed) {
        host.moveTemp(out);
        host.releaseFrame(host.frames.pop()!);
        return host.own(out);
      }
      return out;
    }
    case "ffiCall": {
      // LIBRARY mode: every ffiCall is a profile-declared host-callback
      // channel (the library lane loads no native-FFI manifest). Wasm
      // calls named imports; native libraries fetch
      // the slot's registered pointer — scr_library_cb_require delivers
      // the channel's trap constant through the funnel (SC4025) when the
      // host never registered — then brackets the typed indirect call,
      // opaque context first. The bracket makes callback-time ABI re-entry
      // a deterministic SC4026 trap. Marshalling matches the native ffiCall's value
      // classes exactly; the host cannot raise a scriptc exception, so
      // no pending check follows.
      const libCb = host.mod.lib?.callbacks?.find((c) => c.name === e.import);
      if (libCb !== undefined) {
        const cbArgs = e.args.map((arg) => host.emitExpr(arg));
        const natTypes: string[] = [];
        const natArgs: string[] = [];
        libCb.params.forEach((cls, i) => {
          const arg = cbArgs[i]!;
          switch (cls) {
            case "f64":
              natTypes.push("double");
              natArgs.push(`double ${arg.name}`);
              break;
            case "bool": {
              const widened = B.tmp();
              B.line(`${widened} = zext i1 ${arg.name} to i8`);
              natTypes.push("i8");
              natArgs.push(`i8 ${widened}`);
              break;
            }
            case "u8":
            case "u32": {
              host.declare(`declare double @scr_bit_ushr(double, double)`);
              const asDouble = B.tmp();
              const asU32 = B.tmp();
              B.line(
                `${asDouble} = call double @scr_bit_ushr(double ${arg.name}, double ${f64Lit(0)})`,
              );
              B.line(`${asU32} = fptoui double ${asDouble} to i32`);
              if (cls === "u8") {
                const asU8 = B.tmp();
                B.line(`${asU8} = trunc i32 ${asU32} to i8`);
                natTypes.push("i8");
                natArgs.push(`i8 ${asU8}`);
              } else {
                natTypes.push("i32");
                natArgs.push(`i32 ${asU32}`);
              }
              break;
            }
            case "i32": {
              host.declare(`declare double @scr_bit_or(double, double)`);
              const asDouble = B.tmp();
              const asI32 = B.tmp();
              B.line(
                `${asDouble} = call double @scr_bit_or(double ${arg.name}, double ${f64Lit(0)})`,
              );
              B.line(`${asI32} = fptosi double ${asDouble} to i32`);
              natTypes.push("i32");
              natArgs.push(`i32 ${asI32}`);
              break;
            }
            case "string": {
              const lenPtr = B.tmp();
              const len = B.tmp();
              const data = B.tmp();
              B.line(`${lenPtr} = getelementptr inbounds %ScrStr, ptr ${arg.name}, i64 0, i32 1`);
              B.line(`${len} = load ${host.sizeType}, ptr ${lenPtr}`);
              B.line(
                `${data} = getelementptr inbounds i8, ptr ${arg.name}, i64 ${host.abiOffset(24, 12)}`,
              );
              natTypes.push("ptr", host.sizeType);
              natArgs.push(`ptr ${data}`, `${host.sizeType} ${len}`);
              break;
            }
            case "bytes": {
              const lenPtr = B.tmp();
              const len = B.tmp();
              const dataPtr = B.tmp();
              const data = B.tmp();
              B.line(
                `${lenPtr} = getelementptr inbounds i8, ptr ${arg.name}, i64 ${host.abiOffset(8, 4)}`,
              );
              B.line(`${len} = load ${host.sizeType}, ptr ${lenPtr}`);
              B.line(
                `${dataPtr} = getelementptr inbounds i8, ptr ${arg.name}, i64 ${host.abiOffset(24, 12)}`,
              );
              B.line(`${data} = load ptr, ptr ${dataPtr}`);
              natTypes.push("ptr", host.sizeType);
              natArgs.push(`ptr ${data}`, `${host.sizeType} ${len}`);
              break;
            }
          }
        });
        host.declare(`declare void @scr_library_callback_begin()`);
        host.declare(`declare void @scr_library_callback_end()`);
        const retTy = ffiNativeTypeLl(libCb.returns);
        let fn: string;
        if (host.wasi) {
          fn = `@sc_wasm_import_${libCb.slot}`;
          host.declare(
            `declare ${retTy} ${fn}(${natTypes.join(", ")}) "wasm-import-module"="scriptc" "wasm-import-name"="${libCb.name}"`,
          );
        } else {
          host.declare(`declare ptr @scr_library_cb_require(${host.sizeType}, ptr)`);
          host.declare(`declare ptr @scr_library_cb_ctx(${host.sizeType})`);
          fn = B.tmp();
          B.line(
            `${fn} = call ptr @scr_library_cb_require(${host.sizeType} ${libCb.slot}, ptr @sc_lib_cb_trap_${libCb.slot})`,
          );
          const ctx = B.tmp();
          B.line(`${ctx} = call ptr @scr_library_cb_ctx(${host.sizeType} ${libCb.slot})`);
          natArgs.unshift(`ptr ${ctx}`);
        }
        const call = `call ${retTy} ${fn}(${natArgs.join(", ")})`;
        if (libCb.returns === "void") {
          B.line(`call void @scr_library_callback_begin()`);
          B.line(call);
          B.line(`call void @scr_library_callback_end()`);
          return { name: "", type: e.type };
        }
        const raw = B.tmp();
        B.line(`call void @scr_library_callback_begin()`);
        B.line(`${raw} = ${call}`);
        B.line(`call void @scr_library_callback_end()`);
        if (libCb.returns === "f64") return { name: raw, type: e.type };
        if (libCb.returns === "bool") {
          const value = B.tmp();
          B.line(`${value} = icmp ne i8 ${raw}, 0`);
          return { name: value, type: e.type };
        }
        const value = B.tmp();
        const op = libCb.returns === "i32" ? "sitofp" : "uitofp";
        B.line(`${value} = ${op} ${retTy} ${raw} to double`);
        return { name: value, type: e.type };
      }
      const entry = host.ffiByName.get(e.import);
      if (!entry)
        throw new InternalCompilerError(`llvm emitter bug: unknown FFI import ${e.import}`);
      if (entry.callbackOperation) {
        const adapter = host.ffiCallbackAdapter(entry.callbackTarget ?? entry.name, "callback");
        if (entry.callbackOperation === "release") {
          host.declare(`declare void @scr_ffi_release_optional(ptr, ptr)`);
          const callback = B.tmp();
          B.line(`${callback} = load ptr, ptr @${adapter.global}`);
          B.line(`call void @scr_ffi_release_optional(ptr @${adapter.table}, ptr ${callback})`);
          return { name: "", type: e.type };
        }
        const callback = host.emitExpr(e.args[0]!);
        host.declare(`declare void @scr_ffi_retain_slot(ptr, ptr, ptr)`);
        host.declare(`declare void @scr_ffi_commit_slot(ptr, ptr)`);
        host.declare(`declare ptr @scr_bigint_from_pointer(ptr)`);
        B.line(
          `call void @scr_ffi_retain_slot(ptr @${adapter.table}, ptr @${adapter.global}, ptr ${callback.name})`,
        );
        B.line(`call void @scr_ffi_commit_slot(ptr @${adapter.table}, ptr ${callback.name})`);
        const result = B.tmp();
        B.line(`${result} = call ptr @scr_bigint_from_pointer(ptr @${adapter.symbol})`);
        return host.own({ name: result, type: e.type });
      }
      const args = e.args.map((arg) => host.emitExpr(arg));
      const sourceArgs = new Map<number, LlValue>();
      const callbackArgs = new Map<string, LlValue>();
      let sourceIndex = 0;
      entry.params.forEach((param, abiIndex) => {
        if (isFfiContextParam(param)) return;
        const arg = args[sourceIndex++]!;
        sourceArgs.set(abiIndex, arg);
        if (isFfiCallbackParam(param)) callbackArgs.set(param.callback.id, arg);
        if (isFfiReleaseParam(param)) callbackArgs.set(param.callback.release, arg);
      });

      const { registrations: retainedRegistrations, releases: retainedReleases } =
        collectFfiRetainedOps<LlValue>(entry, callbackArgs, (binding, id) =>
          host.ffiCallbackAdapter(binding, id),
        );
      if (retainedRegistrations.length > 0) {
        host.declare(`declare void @scr_ffi_retain(ptr, ptr)`);
        if (retainedRegistrations.some((registration) => registration.global !== null)) {
          host.declare(`declare void @scr_ffi_retain_slot(ptr, ptr, ptr)`);
          host.declare(`declare void @scr_ffi_commit_slot(ptr, ptr)`);
        }
      }
      if (retainedReleases.length > 0) {
        host.declare(`declare void @scr_ffi_require(ptr, ptr)`);
        if (retainedReleases.some((release) => release.foreign)) {
          host.declare(`declare void @scr_ffi_require_foreign(ptr, ptr)`);
        }
      }
      // Pin before registration. Raw retained descriptors are native
      // singletons: the incoming closure is pinned (and an EMPTY slot
      // armed) before the native set call, but a replaced registration
      // stays live and dispatching until the call returns — a native
      // setter may flush the outgoing callback one last time mid-replace.
      // scr_ffi_commit_slot below repoints the slot and retires the
      // superseded pins after the call.
      for (const registration of retainedRegistrations) {
        if (registration.global !== null) {
          B.line(
            `call void @scr_ffi_retain_slot(ptr @${registration.table}, ptr @${registration.global}, ptr ${registration.callback.name})`,
          );
        } else if (registration.foreign) {
          host.declare(`declare void @scr_ffi_retain_foreign(ptr, ptr)`);
          B.line(
            `call void @scr_ffi_retain_foreign(ptr @${registration.table}, ptr ${registration.callback.name})`,
          );
        } else {
          B.line(
            `call void @scr_ffi_retain(ptr @${registration.table}, ptr ${registration.callback.name})`,
          );
        }
      }
      // Validate releases BEFORE the native removal call runs: a bogus
      // release traps without native code observing any side effect. The
      // registration itself is unpinned only after the call returns.
      for (const release of retainedReleases) {
        B.line(
          `call void @scr_ffi_require${release.foreign ? "_foreign" : ""}(ptr @${release.table}, ptr ${release.callback.name})`,
        );
      }

      const rawContexts: { tls: string; previous: string }[] = [];
      for (const param of entry.params) {
        if (!isFfiCallbackParam(param)) continue;
        const adapter = host.ffiCallbackAdapter(entry.name, param.callback.id);
        if (adapter.tls === null) continue;
        const callback = callbackArgs.get(param.callback.id)!;
        const previous = B.tmp();
        B.line(`${previous} = load ptr, ptr @${adapter.tls}`);
        B.line(`store ptr ${callback.name}, ptr @${adapter.tls}`);
        rawContexts.push({ tls: adapter.tls, previous });
      }
      const nativeArgs: string[] = [];
      const nativeParamTypes: string[] = [];
      entry.params.forEach((param, i) => {
        if (isFfiCallbackParam(param)) {
          const adapter = host.ffiCallbackAdapter(entry.name, param.callback.id);
          nativeParamTypes.push("ptr");
          nativeArgs.push(`ptr @${adapter.symbol}`);
          return;
        }
        if (isFfiReleaseParam(param)) {
          const { binding, id } = parseFfiCallbackKey(param.callback.release);
          const adapter = host.ffiCallbackAdapter(binding, id);
          nativeParamTypes.push("ptr");
          nativeArgs.push(`ptr @${adapter.symbol}`);
          return;
        }
        if (isFfiContextParam(param)) {
          const callback = callbackArgs.get(param.context);
          if (!callback)
            throw new InternalCompilerError(
              `llvm emitter bug: FFI context '${param.context}' has no callback arg`,
            );
          nativeParamTypes.push("ptr");
          nativeArgs.push(`ptr ${callback.name}`);
          return;
        }
        const arg = sourceArgs.get(i)!;
        switch (param) {
          case "i64":
          case "u64":
          case "pointer": {
            const ty = ffiNativeTypeLl(param);
            host.declare(`declare ${ty} @scr_bigint_to_${param}(ptr)`);
            const raw = B.tmp();
            B.line(`${raw} = call ${ty} @scr_bigint_to_${param}(ptr ${arg.name})`);
            nativeParamTypes.push(ty);
            nativeArgs.push(`${ty} ${raw}`);
            break;
          }
          case "f64":
            nativeParamTypes.push("double");
            nativeArgs.push(`double ${arg.name}`);
            break;
          case "f32": {
            const value = B.tmp();
            B.line(`${value} = fptrunc double ${arg.name} to float`);
            nativeParamTypes.push("float");
            nativeArgs.push(`float ${value}`);
            break;
          }
          case "bool": {
            const widened = B.tmp();
            B.line(`${widened} = zext i1 ${arg.name} to i8`);
            const nativeParam = ffiNativeParamLl(param, host.ffiExtendNarrowIntegers);
            nativeParamTypes.push(nativeParam);
            nativeArgs.push(`${nativeParam} ${widened}`);
            break;
          }
          case "u8":
          case "i8":
          case "u16":
          case "i16":
          case "u32": {
            host.declare(`declare double @scr_bit_ushr(double, double)`);
            const asDouble = B.tmp();
            const asU32 = B.tmp();
            B.line(
              `${asDouble} = call double @scr_bit_ushr(double ${arg.name}, double ${f64Lit(0)})`,
            );
            B.line(`${asU32} = fptoui double ${asDouble} to i32`);
            if (param !== "u32") {
              const narrow = B.tmp();
              const nativeType = ffiNativeTypeLl(param);
              B.line(`${narrow} = trunc i32 ${asU32} to ${nativeType}`);
              const nativeParam = ffiNativeParamLl(param, host.ffiExtendNarrowIntegers);
              nativeParamTypes.push(nativeParam);
              nativeArgs.push(`${nativeParam} ${narrow}`);
            } else {
              nativeParamTypes.push("i32");
              nativeArgs.push(`i32 ${asU32}`);
            }
            break;
          }
          case "i32": {
            host.declare(`declare double @scr_bit_or(double, double)`);
            const asDouble = B.tmp();
            const asI32 = B.tmp();
            B.line(
              `${asDouble} = call double @scr_bit_or(double ${arg.name}, double ${f64Lit(0)})`,
            );
            B.line(`${asI32} = fptosi double ${asDouble} to i32`);
            nativeParamTypes.push("i32");
            nativeArgs.push(`i32 ${asI32}`);
            break;
          }
          case "string": {
            const lenPtr = B.tmp();
            const len = B.tmp();
            const data = B.tmp();
            B.line(`${lenPtr} = getelementptr inbounds %ScrStr, ptr ${arg.name}, i64 0, i32 1`);
            B.line(`${len} = load i64, ptr ${lenPtr}`);
            B.line(`${data} = getelementptr inbounds i8, ptr ${arg.name}, i64 24`);
            nativeParamTypes.push("ptr", "i64");
            nativeArgs.push(`ptr ${data}`, `i64 ${len}`);
            break;
          }
          case "bytes":
          case "mutable-bytes": {
            if (host.mod.workers) {
              host.declare(`declare void @scr_bytes_require_unshared(ptr)`);
              B.line(`call void @scr_bytes_require_unshared(ptr ${arg.name})`);
              host.emitPendingCheck();
            }
            const lenPtr = B.tmp();
            const len = B.tmp();
            const dataPtr = B.tmp();
            const data = B.tmp();
            B.line(`${lenPtr} = getelementptr inbounds i8, ptr ${arg.name}, i64 8`);
            B.line(`${len} = load i64, ptr ${lenPtr}`);
            B.line(`${dataPtr} = getelementptr inbounds i8, ptr ${arg.name}, i64 24`);
            B.line(`${data} = load ptr, ptr ${dataPtr}`);
            nativeParamTypes.push("ptr", "i64");
            nativeArgs.push(`ptr ${data}`, `i64 ${len}`);
            break;
          }
        }
      });
      const retTy = ffiNativeTypeLl(entry.returns);
      const retAbi = ffiNativeReturnLl(entry.returns, host.ffiExtendNarrowIntegers);
      host.declare(`declare ${retAbi} @${entry.symbol}(${nativeParamTypes.join(", ")})`);
      const call = `call ${retAbi} @${entry.symbol}(${nativeArgs.join(", ")})`;
      const restoreRawContexts = (): void => {
        for (let i = rawContexts.length - 1; i >= 0; i--) {
          const saved = rawContexts[i]!;
          B.line(`store ptr ${saved.previous}, ptr @${saved.tls}`);
        }
      };
      const finishRetainedReleases = (): void => {
        // Commit raw replacements first (repoint the slot, retire the
        // superseded pins), then unpin explicit releases — the runtime
        // disarms the slot itself when the released closure holds it.
        for (const registration of retainedRegistrations) {
          if (registration.global !== null) {
            B.line(
              `call void @scr_ffi_commit_slot(ptr @${registration.table}, ptr ${registration.callback.name})`,
            );
          }
        }
        if (retainedReleases.some((release) => !release.foreign)) {
          host.declare(`declare void @scr_ffi_release(ptr, ptr)`);
        }
        if (retainedReleases.some((release) => release.foreign)) {
          host.declare(`declare void @scr_ffi_release_foreign(ptr, ptr)`);
        }
        for (const release of retainedReleases) {
          B.line(
            `call void @scr_ffi_release${release.foreign ? "_foreign" : ""}(ptr @${release.table}, ptr ${release.callback.name})`,
          );
        }
      };
      const callbacksMayThrow = callbackArgs.size > 0 || host.ffiHasRetainedCallback;
      if (entry.returns === "void") {
        B.line(call);
        restoreRawContexts();
        finishRetainedReleases();
        if (callbacksMayThrow) host.emitPendingCheck();
        return { name: "", type: e.type };
      }
      const raw = B.tmp();
      B.line(`${raw} = ${call}`);
      restoreRawContexts();
      finishRetainedReleases();
      if (entry.returns === "i64" || entry.returns === "u64" || entry.returns === "pointer") {
        host.declare(`declare ptr @scr_bigint_from_${entry.returns}(${retTy})`);
        const value = B.tmp();
        B.line(`${value} = call ptr @scr_bigint_from_${entry.returns}(${retTy} ${raw})`);
        const result = host.own({ name: value, type: e.type });
        if (callbacksMayThrow) host.emitPendingCheck();
        return result;
      }
      if (entry.returns === "f64") {
        const result = { name: raw, type: e.type };
        if (callbacksMayThrow) host.emitPendingCheck();
        return result;
      }
      if (entry.returns === "bool") {
        const value = B.tmp();
        B.line(`${value} = icmp ne i8 ${raw}, 0`);
        const result = { name: value, type: e.type };
        if (callbacksMayThrow) host.emitPendingCheck();
        return result;
      }
      const value = B.tmp();
      const op =
        entry.returns === "f32"
          ? "fpext"
          : entry.returns === "i8" || entry.returns === "i16" || entry.returns === "i32"
            ? "sitofp"
            : "uitofp";
      B.line(`${value} = ${op} ${retTy} ${raw} to double`);
      const result = { name: value, type: e.type };
      if (callbacksMayThrow) host.emitPendingCheck();
      return result;
    }
    case "closure": {
      const target = host.fnByName.get(e.fnName);
      if (!target)
        throw new InternalCompilerError(
          `llvm emitter bug: closure over unknown function ${e.fnName}`,
        );
      if (target.captures === undefined) {
        // Declared function as a value: the interned immortal closure —
        // every mention yields the same pointer, so `f === f` is true.
        host.fnValues.add(e.fnName);
        return host.own({
          name: host.retainValue(`@${mangleFnClosure(e.fnName)}`, e.type),
          type: e.type,
        });
      }
      // Lifted async lambdas enter through their spawn wrapper (which
      // takes sc_env first, like every lifted function).
      host.declare(`declare ptr @scr_closure_new(ptr, ${host.sizeType})`);
      const c = B.tmp();
      B.line(
        `${c} = call ptr @scr_closure_new(ptr @${host.callTarget(e.fnName)}, ${host.sizeType} ${e.captures.length})`,
      );
      const out = host.own({ name: c, type: e.type });
      const functionKind =
        (target.generator ? 1 : 0) + (target.async ? 2 : 0) + (target.ownsPrototype ? 4 : 0);
      if (functionKind) {
        const kindPtr = B.tmp();
        B.line(`${kindPtr} = getelementptr inbounds %ScrClosure, ptr ${c}, i64 0, i32 4`);
        B.line(`store i32 ${functionKind}, ptr ${kindPtr}`);
      }
      e.captures.forEach((localId, i) => {
        const box = host.loadBox(`%${mangleLocal(localId)}`);
        const retained = host.retainBox(box);
        const caps = B.tmp();
        const capp = B.tmp();
        B.line(`${caps} = getelementptr inbounds %ScrClosure, ptr ${c}, i64 1 ; caps`);
        B.line(
          `${capp} = getelementptr inbounds ptr, ptr ${caps}, ${host.sizeType} ${i} ; caps[${i}]`,
        );
        B.line(`store ptr ${retained}, ptr ${capp}`);
        if (i === 0 && e.adapts === true) {
          // A signature adapter stands for the function it forwards to.
          const slot = B.tmp();
          const original = B.tmp();
          B.line(`${slot} = getelementptr inbounds %ScrBox, ptr ${box}, i64 0, i32 5`);
          B.line(`${original} = load ptr, ptr ${slot}`);
          // Boxed adapters report the original's length (its static
          // arity, as the original's own boxes do).
          const source = target.captures?.[0]?.type;
          const length =
            source?.kind === "func"
              ? source.params.length - (source.restAbi === "typed" ? 1 : 0)
              : 0;
          host.declare(`declare void @scr_closure_adopt_identity(ptr, ptr, i32)`);
          B.line(`call void @scr_closure_adopt_identity(ptr ${c}, ptr ${original}, i32 ${length})`);
        }
      });
      return out;
    }
    case "callValue": {
      // Calling through a closure value: load the fn pointer, pass the
      // closure itself first (the callValue ABI), then the declared
      // params — callees own their refcounted params.
      if (e.callee.type.kind !== "func")
        throw new InternalCompilerError("llvm emitter bug: callValue on non-func");
      const ft = e.callee.type;
      if (e.args.length !== ft.params.length)
        throw new LlvmUnsupportedError("callValue:arity", e.loc);
      const callee = host.stackCallbacks.emit(host, e.callee) ?? emitBorrowedInput(host, e.callee);
      const receiver = e.receiver === undefined ? null : host.emitExpr(e.receiver);
      const args = e.args.map((a) => host.emitExpr(a));
      for (const a of args) host.moveTemp(a);
      const knownName =
        e.callee.kind === "closure"
          ? e.callee.fnName
          : e.callee.kind === "varRef"
            ? host.currentConstantCallbacks.get(e.callee.localId)
            : undefined;
      const candidate = knownName ? host.fnByName.get(knownName) : undefined;
      const known = candidate && !candidate.async && !candidate.generator ? candidate : undefined;
      let direct: string | undefined;
      if (known) {
        if (known.captures === undefined) {
          host.fnValues.add(known.name);
          direct = `@${mangleWrapper(known.name)}`;
        } else direct = `@${host.callTarget(known.name)}`;
      }
      const argList = [
        `ptr ${callee.name}`,
        ...args.map((a, i) => `${host.llType(ft.params[i]!)} ${a.name}`),
      ].join(", ");
      const invoke = (target: string, needsReceiver: boolean): string => {
        if (needsReceiver) {
          host.declare("declare void @scr_dyn_this_push_dyn(ptr)");
          host.declare("declare void @scr_dyn_this_pop()");
          B.line(`call void @scr_dyn_this_push_dyn(ptr ${receiver?.name ?? "null"})`);
        }
        const result = e.type.kind === "void" ? "" : B.tmp();
        B.line(`${result ? `${result} = ` : ""}call ${host.llType(e.type)} ${target}(${argList})`);
        if (needsReceiver) B.line("call void @scr_dyn_this_pop()");
        return result;
      };
      let t: string;
      if (direct && e.callee.kind === "closure") {
        t = invoke(direct, !callbackIgnoresReceiver(known!));
      } else {
        const fnp = B.tmp(),
          fn = B.tmp();
        B.line(`${fnp} = getelementptr inbounds %ScrClosure, ptr ${callee.name}, i64 0, i32 1`);
        B.line(`${fn} = load ptr, ptr ${fnp}`);
        if (!direct) t = invoke(fn, true);
        else {
          // A global initializer may not have run, or a callback may enter
          // through a boundary the census cannot prove. Validate the actual
          // snapshotted pointer before choosing the direct entry. The fallback
          // keeps the ordinary receiver ABI and its initialization behavior.
          const matches = B.tmp(),
            fast = B.newLabel("callback.direct"),
            fallback = B.newLabel("callback.indirect"),
            done = B.newLabel("callback.done");
          B.line(`${matches} = icmp eq ptr ${fn}, ${direct}`);
          B.condBr(matches, fast, fallback);
          B.startBlock(fast);
          const specialized = invoke(direct, !callbackIgnoresReceiver(known!));
          B.br(done);
          B.startBlock(fallback);
          const indirect = invoke(fn, true);
          B.br(done);
          B.startBlock(done);
          t = e.type.kind === "void" ? "" : B.tmp();
          if (t)
            B.line(
              `${t} = phi ${host.llType(e.type)} [ ${specialized}, %${fast} ], [ ${indirect}, %${fallback} ]`,
            );
        }
      }
      if (e.type.kind === "void") {
        if (host.indirectMayThrow) host.emitPendingCheck();
        return { name: "", type: e.type };
      }
      // The check runs AFTER the result temp joins the frame: an unwind
      // releases it (the dummy is NULL for refcounted returns).
      const out = host.own({ name: t, type: e.type });
      if (host.indirectMayThrow) host.emitPendingCheck();
      return out;
    }
    case "selfRef":
      // The running closure itself (env is borrowed; the result owned).
      return host.own({ name: host.retainValue("%sc_env", e.type), type: e.type });
    case "new": {
      // Allocate (fields zeroed, vt stamped), then run the ctor. The
      // ctor owns and releases its `this` param like any callee, so it
      // receives a +1 distinct from the one this expression returns.
      // A throwing constructor unwinds like any call; the half-built
      // object is in this frame and releases with it.
      const ctor = host.fnByName.get(`%${e.className}.constructor`);
      if (!ctor)
        throw new InternalCompilerError(
          `llvm emitter bug: new ${e.className} without a constructor`,
        );
      const o = B.tmp();
      B.line(`${o} = call ptr @${mangleClassNew(e.className)}()`);
      const out = host.own({ name: o, type: e.type });
      const args = e.args.map((a) => host.emitExpr(a));
      for (const a of args) host.moveTemp(a);
      const r = B.tmp();
      B.line(`${r} = call ptr @${mangleClassRetain(e.className)}(ptr ${o})`);
      const argList = [
        `ptr ${r}`,
        ...args.map((a, i) => `${host.llType(ctor.params[i + 1]!.type)} ${a.name}`),
      ].join(", ");
      B.line(`call void @${mangleFunction(`%${e.className}.constructor`)}(${argList})`);
      if (host.mayThrow.has(`%${e.className}.constructor`)) host.emitPendingCheck();
      return out;
    }
    case "classRef": {
      // The class itself as a value: the immortal class object's
      // address. The +1 retain is a no-op on immortals but keeps the
      // owned-temps discipline uniform (the regexLit pattern).
      const sym = host.classObjSym(e.className);
      if (e.captures !== undefined) {
        host.declare(`declare ptr @scr_classobj_new(ptr, ${host.sizeType})`);
        const value = B.tmp();
        B.line(
          `${value} = call ptr @scr_classobj_new(ptr @${sym}, ${host.sizeType} ${e.captures.length})`,
        );
        e.captures.forEach((id, index) => {
          const box = host.loadBox(`%${mangleLocal(id)}`);
          const owned = host.retainBox(box);
          const caps = B.tmp();
          const slot = B.tmp();
          B.line(`${caps} = getelementptr inbounds %ScrClassObj, ptr ${value}, i64 1`);
          B.line(`${slot} = getelementptr inbounds ptr, ptr ${caps}, ${host.sizeType} ${index}`);
          B.line(`store ptr ${owned}, ptr ${slot}`);
        });
        return host.own({ name: value, type: e.type });
      }
      return host.own({ name: host.retainValue(`@${sym}`, e.type), type: e.type });
    }
    case "newValue": {
      // Construction through a class VALUE: call the class object's
      // construct thunk. Every value legally in the slot shares the
      // static class's constructor ABI (the frontend's flow rule).
      if (e.callee.type.kind !== "classval")
        throw new InternalCompilerError("llvm emitter bug: newValue on non-classval callee");
      const cls = e.callee.type.className;
      const ctor = host.fnByName.get(`%${cls}.constructor`);
      if (!ctor)
        throw new InternalCompilerError(
          `llvm emitter bug: newValue on ${cls} without a constructor`,
        );
      const callee = host.emitExpr(e.callee);
      const args = e.args.map((a) => host.emitExpr(a));
      for (const a of args) host.moveTemp(a); // the constructor owns its params
      const ctorp = B.tmp();
      const thunk = B.tmp();
      B.line(`${ctorp} = getelementptr inbounds %ScrClassObj, ptr ${callee.name}, i64 0, i32 3`);
      B.line(`${thunk} = load ptr, ptr ${ctorp}`);
      const argList = args
        .map((a, i) => `${host.llType(ctor.params[i + 1]!.type)} ${a.name}`)
        .join(", ");
      const t = B.tmp();
      B.line(`${t} = call ptr ${thunk}(ptr ${callee.name}${argList ? ", " + argList : ""})`);
      const out = host.own({ name: t, type: e.type });
      if (newValueMayThrow(cls, host.classMeta.get(cls), host.mayThrow)) host.emitPendingCheck();
      return out;
    }
    case "instanceOfValue": {
      // The interval check with the target loaded from the class object
      // (same numbering the vtables carry). Frontend guarantees both
      // sides are hierarchy members, so the operand has a vt word.
      if (e.value.type.kind !== "object")
        throw new InternalCompilerError("llvm emitter bug: instanceOfValue on a non-object");
      const v = host.emitExpr(e.value);
      const target = host.emitExpr(e.classValue);
      if (
        e.classValue.type.kind === "classval" &&
        host.classMeta.get(e.classValue.type.className)?.def.localCaptures !== undefined &&
        host.classMeta
          .get(e.value.type.className)
          ?.def.fields.some(
            (field) =>
              field.name ===
              `%classEnvironment:${e.classValue.type.kind === "classval" ? e.classValue.type.className : ""}`,
          )
      ) {
        const slot = B.tmp();
        const actual = B.tmp();
        const result = B.tmp();
        B.line(
          `${slot} = getelementptr inbounds %${mangleClassStruct(e.classValue.type.className)}, ptr ${v.name}, i64 0, i32 ${classEnvironmentIndex(host.classMeta.get(e.classValue.type.className)!)}`,
        );
        B.line(`${actual} = load ptr, ptr ${slot}`);
        B.line(`${result} = icmp eq ptr ${actual}, ${target.name}`);
        return { name: result, type: e.type };
      }
      const pre = host.loadVtPre(v.name, e.value.type.className);
      const tprep = B.tmp();
      const tpre = B.tmp();
      const tpostp = B.tmp();
      const tpost = B.tmp();
      B.line(`${tprep} = getelementptr inbounds %ScrClassObj, ptr ${target.name}, i64 0, i32 1`);
      B.line(`${tpre} = load ${host.sizeType}, ptr ${tprep}`);
      B.line(`${tpostp} = getelementptr inbounds %ScrClassObj, ptr ${target.name}, i64 0, i32 2`);
      B.line(`${tpost} = load ${host.sizeType}, ptr ${tpostp}`);
      if ([...host.classMeta.values()].some((meta) => meta.membership.length > 1)) {
        const test = B.tmp();
        B.line(
          `${test} = call i1 @sc_class_membership(${host.sizeType} ${pre}, ${host.sizeType} ${tpre}, ${host.sizeType} ${tpost})`,
        );
        return { name: test, type: e.type };
      }
      const ge = B.tmp();
      const le = B.tmp();
      const t = B.tmp();
      B.line(`${ge} = icmp sge ${host.sizeType} ${pre}, ${tpre}`);
      B.line(`${le} = icmp sle ${host.sizeType} ${pre}, ${tpost}`);
      B.line(`${t} = and i1 ${ge}, ${le}`);
      return { name: t, type: e.type };
    }
    case "promiseVoidWiden": {
      // One ScrPromise* either way — ownership transfers, type-only
      //.
      const v = host.emitExpr(e.value);
      host.moveTemp(v);
      return host.own({ name: v.name, type: e.type });
    }
    case "upcast":
    case "downcast": {
      // Prefix layout: both directions are reinterprets of the SAME
      // pointer — no RC traffic, ownership transfers from the operand
      // temp to the result temp (struck so the one +1 releases exactly
      // once, under the RESULT type's release).
      const v = host.emitExpr(e.value);
      if (isRefCounted(v.type)) host.moveTemp(v);
      return host.own({ name: v.name, type: e.type });
    }
    case "instanceOf": {
      // O(1) preorder-interval test against the vtable the object
      // carries; the target's interval is a compile-time constant.
      if (e.value.type.kind !== "object")
        throw new InternalCompilerError("llvm emitter bug: instanceOf on a non-object");
      const v = host.emitExpr(e.value);
      const target = host.classMetaOf(e.className);
      const pre = host.loadVtPre(v.name, e.value.type.className);
      let result: string | undefined;
      for (const interval of classMembershipIntervals(host.classMeta, target.def.name)) {
        const ge = B.tmp(),
          le = B.tmp(),
          test = B.tmp();
        B.line(`${ge} = icmp uge ${host.sizeType} ${pre}, ${interval.pre}`);
        B.line(`${le} = icmp ule ${host.sizeType} ${pre}, ${interval.post}`);
        B.line(`${test} = and i1 ${ge}, ${le} ; instanceof ${e.className}`);
        if (result === undefined) result = test;
        else {
          const combined = B.tmp();
          B.line(`${combined} = or i1 ${result}, ${test}`);
          result = combined;
        }
      }
      return { name: result!, type: e.type };
    }
    case "virtualCall": {
      // Dispatch through the receiver's vtable: the slot lives on the
      // method's root-most declaring class; every implementation shares
      // the slot's LLVM signature (override exactness), so the stored
      // pointer is the method function itself — no adapters (see
      // classes.ts).
      const meta = host.classMetaOf(e.className);
      const slotIdx = meta.root.slots.findIndex(
        (sl) =>
          sl.method === e.method && sl.declarer.pre <= meta.pre && meta.pre <= sl.declarer.post,
      );
      if (slotIdx < 0)
        throw new InternalCompilerError(
          `llvm emitter bug: no vtable slot for ${e.className}.${e.method}`,
        );
      const slot = meta.root.slots[slotIdx]!;
      const args = e.args.map((a) => host.emitExpr(a));
      for (const a of args) host.moveTemp(a); // callees own their params
      const recv = args[0]!.name;
      const vtp = B.tmp();
      const vt = B.tmp();
      const fnp = B.tmp();
      const fn = B.tmp();
      B.line(
        `${vtp} = getelementptr inbounds %${classStructSym(e.className)}, ptr ${recv}, i64 0, i32 1`,
      );
      B.line(`${vt} = load ptr, ptr ${vtp}`);
      B.line(
        `${fnp} = getelementptr inbounds %${mangleVtStruct(meta.root.def.name)}, ptr ${vt}, i64 0, i32 ${slotIdx + 1}`,
      );
      B.line(`${fn} = load ptr, ptr ${fnp} ; ${e.method}`);
      const argList = args
        .map((a, i) => `${host.llType(slot.fn.params[i]!.type)} ${a.name}`)
        .join(", ");
      if (e.type.kind === "void") {
        B.line(`call void ${fn}(${argList})`);
        if (host.mayThrowMethods.has(e.method)) host.emitPendingCheck();
        return { name: "", type: e.type };
      }
      const t = B.tmp();
      B.line(`${t} = call ${host.llType(e.type)} ${fn}(${argList})`);
      const out = host.own({ name: t, type: e.type });
      if (host.mayThrowMethods.has(e.method)) host.emitPendingCheck();
      return out;
    }
    default: {
      const _exhaustive: never = e;
      void _exhaustive;
      throw new InternalCompilerError("unreachable");
    }
  }
}
