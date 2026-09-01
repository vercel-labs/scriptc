/* Focused LLVM expression emission extracted from emitter.ts. */
import { InternalCompilerError } from "../../errors.js";
import { IrType, isRefCounted, isUnitType, typeEquals } from "../../ir/ir.js";
import { mangleRecordNew } from "../mangle.js";
import { arrNewCall, traceAdapter, traceArg, vAdapters } from "./shapes.js";
import { LlvmUnsupportedError } from "./unsupported.js";
import type { LlvmEmitterContext, ExprOf, LlValue } from "./expr-context.js";

export function emitIntrinsicExpr(host: LlvmEmitterContext, e: ExprOf<"intrinsic">): LlValue {
    const B = host.B;
    switch (e.kind) {
      case "intrinsic": {
        if (e.name === "module.await") {
          // Internal ESM dependency wait: pending promises park the module
          // fiber, while settled ones continue synchronously.
          const p = host.emitExpr(e.args[0]!);
          if (host.wasi) {
            const coro = host.currentWasiCoro;
            if (coro === null) throw new InternalCompilerError("llvm emitter bug: module await outside wasm coroutine");
            host.declare(`declare zeroext i1 @scr_wasi_module_await_prepare(ptr, ptr)`);
            const needsSuspend = B.tmp();
            const suspend = B.newLabel("ma.suspend");
            const ready = B.newLabel("ma.ready");
            B.line(`${needsSuspend} = call zeroext i1 @scr_wasi_module_await_prepare(ptr ${coro.self}, ptr ${p.name})`);
            B.condBr(needsSuspend, suspend, ready);
            B.startBlock(suspend);
            host.emitWasiSuspendPrepared();
            B.br(ready);
            B.startBlock(ready);
            host.declare(`declare void @scr_module_await(ptr)`);
            B.line(`call void @scr_module_await(ptr ${p.name})`);
          } else {
            host.declare(`declare void @scr_module_await(ptr)`);
            B.line(`call void @scr_module_await(ptr ${p.name})`);
          }
          host.emitPendingCheck();
          return { name: "", type: e.type };
        }
        if (e.name === "promise.all") {
          // The runtime countdown combinator (exprs.ts): a pre-sized
          // values array filled per INPUT index as entries fulfill, plus
          // one subscription per entry. Entry and values arrays both stay
          // frame-owned; the combinator BORROWS them.
          if (e.type.kind !== "promise") throw new InternalCompilerError("llvm emitter bug: promise.all type");
          const entries = e.args[0]!;
          if (entries.type.kind !== "array" || entries.type.elem.kind !== "promise") {
            throw new InternalCompilerError("llvm emitter bug: promise.all argument");
          }
          const ps = host.emitExpr(entries);
          host.declare(`declare ptr @scr_promise_all(ptr, ptr, ptr)`);
          if (e.type.inner.kind === "void") {
            const t = B.tmp();
            B.line(`${t} = call ptr @scr_promise_all(ptr ${ps.name}, ptr null, ptr null)`);
            return host.own({ name: t, type: e.type });
          }
          if (e.type.inner.kind !== "array") throw new InternalCompilerError("llvm emitter bug: promise.all result");
          const elem = e.type.inner.elem;
          const store =
            elem.kind === "f64" ? "scr_promise_all_store_f64"
            : elem.kind === "bool" ? "scr_promise_all_store_bool"
            : elem.kind === "string" ? "scr_promise_all_store_str"
            : "scr_promise_all_store_ref";
          host.declare(`declare void @${store}(ptr, double, ptr)`);
          host.declare(`declare double @scr_arr_len(ptr)`);
          const len = B.tmp();
          const cap = B.tmp();
          B.line(`${len} = call double @scr_arr_len(ptr ${ps.name})`);
          B.line(`${cap} = fptoui double ${len} to ${host.sizeType}`);
          const vals = B.tmp();
          B.line(`${vals} = ${arrNewCall(host, elem, cap)}`);
          host.own({ name: vals, type: e.type.inner });
          const t = B.tmp();
          B.line(`${t} = call ptr @scr_promise_all(ptr ${ps.name}, ptr ${vals}, ptr @${store})`);
          return host.own({ name: t, type: e.type });
        }
        if (e.name === "promise.all.tuple") {
          if (e.type.kind !== "promise" || e.type.inner.kind !== "record") {
            throw new InternalCompilerError("llvm emitter bug: promise.all.tuple type");
          }
          const tupleT = e.type.inner;
          const thunks = host.promiseAllTupleFor(tupleT);
          const ps = B.slot();
          B.entryAllocas.push(`${ps} = alloca [${e.args.length} x ptr]`);
          for (const [i, entry] of e.args.entries()) {
            if (entry.type.kind !== "promise") throw new InternalCompilerError("llvm emitter bug: promise.all.tuple entry");
            const p = host.emitExpr(entry);
            const slot = B.tmp();
            B.line(`${slot} = getelementptr inbounds [${e.args.length} x ptr], ptr ${ps}, i64 0, ${host.sizeType} ${i}`);
            B.line(`store ptr ${p.name}, ptr ${slot}`);
          }
          const tuple = B.tmp();
          B.line(`${tuple} = call ptr @${mangleRecordNew(tupleT.shapeId)}()`);
          const tupleValue = host.own({ name: tuple, type: tupleT });
          host.moveTemp(tupleValue); // the combinator owns the tuple context
          host.declare(`declare ptr @scr_promise_all_tuple(ptr, ${host.sizeType}, ptr, ptr, ptr, ptr)`);
          const result = B.tmp();
          B.line(
            `${result} = call ptr @scr_promise_all_tuple(ptr ${ps}, ${host.sizeType} ${e.args.length}, ptr ${tuple}, ptr @${thunks.store}, ptr @${thunks.finish}, ptr @${thunks.drop})`,
          );
          return host.own({ name: result, type: e.type });
        }
        if (e.name === "promise.reject") {
          // A fresh promise rejected through the exception cell: the
          // %Error-rooted reason moves in as the cell's OBJ payload (a
          // checked-dynamic reason rides the thrown-dyn REF representation
          // instead — identity flows to catch/unhandledRejection observers,
          // emitThrowValue's dyn arm), and reject_pending moves the cell
          // into the promise (consumed immediately — no pending check runs
          // in between).
          if (e.type.kind !== "promise") throw new InternalCompilerError("llvm emitter bug: promise.reject type");
          const reasonT = e.args[0]!.type;
          if (reasonT.kind !== "object" && reasonT.kind !== "dyn") {
            throw new InternalCompilerError("llvm emitter bug: promise.reject reason");
          }
          host.declare(`declare ptr @scr_promise_new()`);
          host.declare(`declare void @scr_promise_reject_pending(ptr)`);
          const reason = host.emitExpr(e.args[0]!);
          const p = B.tmp();
          B.line(`${p} = call ptr @scr_promise_new()`);
          const out = host.own({ name: p, type: e.type });
          host.moveTemp(reason); // the cell takes ownership
          host.emitThrowValue({ name: reason.name, type: reasonT });
          B.line(`call void @scr_promise_reject_pending(ptr ${p})`);
          return out;
        }
        if (e.name === "promise.resolve") {
          // A fresh promise fulfilled immediately: void/f64/bool by
          // value, strings and refs MOVE in — the async-return
          // trampoline's fulfill exactly. No waiters exist yet.
          if (e.type.kind !== "promise") throw new InternalCompilerError("llvm emitter bug: promise.resolve type");
          host.declare(`declare ptr @scr_promise_new()`);
          const p = B.tmp();
          B.line(`${p} = call ptr @scr_promise_new()`);
          const out = host.own({ name: p, type: e.type });
          if (e.args.length === 0) {
            host.declare(`declare void @scr_promise_fulfill_void(ptr)`);
            B.line(`call void @scr_promise_fulfill_void(ptr ${p})`);
            return out;
          }
          const v = host.emitExpr(e.args[0]!);
          const t = e.args[0]!.type;
          if (t.kind === "f64" || t.kind === "date") {
            host.declare(`declare void @scr_promise_fulfill_f64(ptr, double)`);
            B.line(`call void @scr_promise_fulfill_f64(ptr ${p}, double ${v.name})`);
          } else if (t.kind === "bool") {
            host.declare(`declare void @scr_promise_fulfill_bool(ptr, i1 zeroext)`);
            B.line(`call void @scr_promise_fulfill_bool(ptr ${p}, i1 ${v.name})`);
          } else if (t.kind === "string") {
            host.moveTemp(v);
            host.declare(`declare void @scr_promise_fulfill_str(ptr, ptr)`);
            B.line(`call void @scr_promise_fulfill_str(ptr ${p}, ptr ${v.name})`);
          } else {
            const rc = vAdapters(host, t);
            host.moveTemp(v);
            host.declare(`declare void @scr_promise_fulfill_ref(ptr, ptr, ptr, ptr, ptr)`);
            B.line(
              `call void @scr_promise_fulfill_ref(ptr ${p}, ptr ${v.name}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${traceArg(host, t)})`,
            );
          }
          return out;
        }
        if (e.name === "promise.race") {
          // A fresh result promise + one race_add per entry: settled
          // entries settle it immediately (first add wins), pending ones
          // park a callback waiter. Entry temps stay frame-owned
          // (race_add retains what it keeps).
          if (e.type.kind !== "promise") throw new InternalCompilerError("llvm emitter bug: promise.race type");
          host.declare(`declare ptr @scr_promise_new()`);
          host.declare(`declare void @scr_promise_race_add(ptr, ptr, ptr)`);
          const result = B.tmp();
          B.line(`${result} = call ptr @scr_promise_new()`);
          const out = host.own({ name: result, type: e.type });
          for (const entry of e.args) {
            if (entry.type.kind !== "promise") throw new InternalCompilerError("llvm emitter bug: promise.race entry");
            const p = host.emitExpr(entry);
            const adapter = host.raceAdapterFor(entry.type.inner, e.type.inner);
            B.line(`call void @scr_promise_race_add(ptr ${result}, ptr ${p.name}, ptr @${adapter})`);
          }
          return out;
        }
        if (e.name !== "console.log" && e.name !== "console.error") {
          throw new LlvmUnsupportedError(`intrinsic:${e.name}`, e.loc);
        }
        // The ScrLogArg protocol: one entry-block array (sized to the
        // function's max arity), tag + 8-byte union slot per argument.
        // String args are BORROWED — their temps stay frame-owned and
        // release at statement end, after the call.
        const args = e.args.map((a) => host.emitExpr(a));
        host.logArgSlots = Math.max(host.logArgSlots, Math.max(args.length, 1));
        args.forEach((a, i) => {
          const tagOf: Record<string, number> = { f64: 0, string: 1, bool: 2 };
          const tag = tagOf[a.type.kind];
          if (tag === undefined) throw new LlvmUnsupportedError(`logArg:${a.type.kind}`, e.loc);
          const tp = B.tmp();
          const vp = B.tmp();
          B.line(`${tp} = getelementptr inbounds %ScrLogArg, ptr %logargs, i64 ${i}, i32 0`);
          B.line(`store i32 ${tag}, ptr ${tp}`);
          B.line(`${vp} = getelementptr inbounds %ScrLogArg, ptr %logargs, i64 ${i}, i32 1`);
          if (a.type.kind === "f64") B.line(`store double ${a.name}, ptr ${vp}`);
          else if (a.type.kind === "string") B.line(`store ptr ${a.name}, ptr ${vp}`);
          else {
            const z = B.tmp();
            B.line(`${z} = zext i1 ${a.name} to i8`);
            B.line(`store i8 ${z}, ptr ${vp}`);
          }
        });
        const fn = e.name === "console.error" ? "scr_console_error" : "scr_console_log";
        host.declare(`declare void @${fn}(${host.sizeType}, ptr)`);
        B.line(`call void @${fn}(${host.sizeType} ${args.length}, ptr %logargs)`);
        return { name: "", type: e.type };
      }
      default: {
        throw new InternalCompilerError("unreachable");
      }
    }
  }

export function emitSerializationExpr(host: LlvmEmitterContext, e: ExprOf<"jsonStringify" | "dynCheck">): LlValue {
    const B = host.B;
    switch (e.kind) {
      case "jsonStringify": {
        // Type-directed serialization: the STATIC type picks an emitted
        // serializer (interned per typeKey) — no dyn, no runtime dispatch.
        // The value temp is BORROWED (released with this statement's
        // frame); the result string is owned (+1). Never throws — except
        // the dyn root below.
        const v = host.emitExpr(e.value);
        let compact: { name: string; type: IrType };
        if (e.value.type.kind === "dyn") {
          // A dyn root: the runtime's dyn walker (scr_dyn_format_j — the
          // C backend's dispatch exactly): number/string/bool/null/array/
          // object exact, dropped members omitted, and a dropped ROOT
          // becomes the TEXT "undefined" (JSON.stringify(undefined) is
          // the undefined value; printing it spells the word — Node's
          // answer, where the nested-position writer would spell null).
          // Fallible (a runtime handle inside the tree throws) — the
          // pending check runs.
          host.declare(`declare ptr @scr_dyn_format_j(ptr)`);
          const t = B.tmp();
          B.line(`${t} = call ptr @scr_dyn_format_j(ptr ${v.name})`);
          compact = host.own({ name: t, type: e.type });
          host.emitPendingCheck();
        } else {
          const helper = host.walkers.jsonWriteHelper(e.value.type);
          host.declare(`declare void @scr_jb_init(ptr)`);
          host.declare(`declare ptr @scr_jb_finish(ptr)`);
          const buf = B.slot();
          B.entryAllocas.push(`${buf} = alloca %ScrJsonBuf`);
          B.line(`call void @scr_jb_init(ptr ${buf})`);
          B.line(`call void @${helper}(ptr ${buf}, ${host.llType(e.value.type)} ${v.name})`);
          const t = B.tmp();
          B.line(`${t} = call ptr @scr_jb_finish(ptr ${buf})`);
          compact = host.own({ name: t, type: e.type });
          // A cycle-capable root can throw the circular-structure
          // TypeError mid-walk: finish still runs (frees the buffer, the
          // partial string joins the frame and releases on unwind), then
          // the pending check unwinds — the C emitter's contract exactly.
          if (traceAdapter(host, e.value.type) !== null) host.emitPendingCheck();
        }
        // A pretty-print form (`stringify(v, null, 2)`): the frontend
        // resolved the space to a compile-time indent string (Node's
        // clamp/truncate rules); the interned re-indenter rewrites the
        // compact text with Node's gap algorithm. Compact temp stays
        // frame-owned; the pretty string is a fresh +1.
        const indent = (e as { indent?: string }).indent;
        if (indent === undefined || indent === "") return compact;
        const rewriter = host.walkers.jsonIndentHelper();
        const t2 = B.tmp();
        B.line(
          `${t2} = call ptr @${rewriter}(ptr ${compact.name}, ptr ${host.cstr(indent)}, ${host.sizeType} ${Buffer.byteLength(indent, "utf8")})`,
        );
        return host.own({ name: t2, type: e.type });
      }
      case "dynCheck": {
        // The dynamic boundary: validate the checked-dynamic tree against the target type
        // and BUILD the typed value (+1) — or throw the catchable
        // path-annotated TypeError. The dyn temp is BORROWED; the result
        // joins the frame BEFORE the pending check so an unwind releases
        // the dummy harmlessly.
        const dynV = host.emitExpr(e.value);
        const helper = host.dyn.dynCheckHelper(e.type);
        const ty = host.llType(e.type);
        const t = B.tmp();
        B.line(`${t} = call ${ty === "i1" ? "zeroext i1" : ty} @${helper}(ptr ${dynV.name}, ptr null)`);
        const out = host.own({ name: t, type: e.type });
        host.emitPendingCheck();
        return out;
      }
      default: {
        const _exhaustive: never = e;
        void _exhaustive;
        throw new InternalCompilerError("unreachable");
      }
    }
  }

export function emitAsyncExpr(host: LlvmEmitterContext, e: ExprOf<"yieldExpr" | "genResume" | "awaitExpr" | "awaitUnionExpr" | "newPromise" | "promiseWithResolvers">): LlValue {
    const B = host.B;
    switch (e.kind) {
      case "yieldExpr": {
        // Park the operand in the generator's OUT slot (moved in, typed by
        // the function's yield channel) and switch back to the resumer.
        // Control returns at the next resume — possibly with an injected
        // .throw payload or the GENRET sentinel pending, hence the check.
        // The result is the .next(v) argument, moved out of the IN slot.
        const gen = host.currentGenerator;
        if (!gen) throw new InternalCompilerError("llvm emitter bug: yieldExpr outside a generator body");
        if (e.value === null) throw new InternalCompilerError("llvm emitter bug: yieldExpr with no operand (frontend fills undefined)");
        const v = host.emitExpr(e.value);
        const yt = e.value.type;
        if (yt.kind === "f64" || yt.kind === "date") {
          if (host.wasi) {
            const coro = host.currentWasiCoro!;
            host.declare(`declare ptr @scr_gen_of_fiber(ptr)`);
            host.declare(`declare void @scr_gen_out_f64(ptr, double)`);
            const g = B.tmp();
            B.line(`${g} = call ptr @scr_gen_of_fiber(ptr ${coro.self})`);
            B.line(`call void @scr_gen_out_f64(ptr ${g}, double ${v.name})`);
          } else {
            host.declare(`declare void @scr_gen_yield_f64(double)`);
            B.line(`call void @scr_gen_yield_f64(double ${v.name})`);
          }
        } else if (yt.kind === "bool") {
          if (host.wasi) {
            const coro = host.currentWasiCoro!;
            host.declare(`declare ptr @scr_gen_of_fiber(ptr)`);
            host.declare(`declare void @scr_gen_out_bool(ptr, i1 zeroext)`);
            const g = B.tmp();
            B.line(`${g} = call ptr @scr_gen_of_fiber(ptr ${coro.self})`);
            B.line(`call void @scr_gen_out_bool(ptr ${g}, i1 ${v.name})`);
          } else {
            host.declare(`declare void @scr_gen_yield_bool(i1 zeroext)`);
            B.line(`call void @scr_gen_yield_bool(i1 ${v.name})`);
          }
        } else {
          host.moveTemp(v); // the OUT slot takes ownership
          if (host.wasi) {
            const coro = host.currentWasiCoro!;
            host.declare(`declare ptr @scr_gen_of_fiber(ptr)`);
            host.declare(`declare void @scr_gen_out_ref(ptr, ptr, ptr)`);
            const g = B.tmp();
            B.line(`${g} = call ptr @scr_gen_of_fiber(ptr ${coro.self})`);
            B.line(`call void @scr_gen_out_ref(ptr ${g}, ptr ${v.name}, ptr ${vAdapters(host, yt).release})`);
          } else {
            host.declare(`declare void @scr_gen_yield_ref(ptr, ptr)`);
            B.line(`call void @scr_gen_yield_ref(ptr ${v.name}, ptr ${vAdapters(host, yt).release})`);
          }
        }
        if (host.wasi) host.emitWasiSuspendPrepared();
        host.emitPendingCheck();
        if (e.type.kind === "void") {
          // An undefined next-channel: nothing to read (the frontend
          // fences value-position yields on this channel).
          return { name: "", type: e.type };
        }
        const t = B.tmp();
        if (e.type.kind === "f64" || e.type.kind === "date") {
          host.declare(`declare double @scr_gen_take_in_f64()`);
          B.line(`${t} = call double @scr_gen_take_in_f64()`);
          return { name: t, type: e.type };
        }
        if (e.type.kind === "bool") {
          host.declare(`declare zeroext i1 @scr_gen_take_in_bool()`);
          B.line(`${t} = call zeroext i1 @scr_gen_take_in_bool()`);
          return { name: t, type: e.type };
        }
        // Refcounted channels: the slot's +1 moves out.
        host.declare(`declare ptr @scr_gen_take_in_ref()`);
        B.line(`${t} = call ptr @scr_gen_take_in_ref()`);
        return host.own({ name: t, type: e.type });
      }
      case "genResume": {
        // One consumer resume: park the sent value (typed per mode), hop
        // into the fiber, propagate a body exception (pending check), and
        // build the IteratorResult record through the interned helper.
        const genT = e.gen.type;
        if (genT.kind !== "generator") throw new InternalCompilerError("llvm emitter bug: genResume on a non-generator");
        if (e.type.kind !== "record") throw new InternalCompilerError("llvm emitter bug: genResume result is not a record");
        const g = host.emitExpr(e.gen); // borrowed for the calls below
        const sendArg = (store: (aName: string, t: IrType) => void): void => {
          const a = host.emitExpr(e.arg!);
          if (isRefCounted(e.arg!.type)) host.moveTemp(a); // the slot takes ownership
          store(a.name, e.arg!.type);
        };
        const parkIn = (name: string, t: IrType): void => {
          if (t.kind === "f64" || t.kind === "date") {
            host.declare(`declare void @scr_gen_in_f64(ptr, double)`);
            B.line(`call void @scr_gen_in_f64(ptr ${g.name}, double ${name})`);
          } else if (t.kind === "bool") {
            host.declare(`declare void @scr_gen_in_bool(ptr, i1 zeroext)`);
            B.line(`call void @scr_gen_in_bool(ptr ${g.name}, i1 ${name})`);
          } else {
            host.declare(`declare void @scr_gen_in_ref(ptr, ptr, ptr)`);
            B.line(`call void @scr_gen_in_ref(ptr ${g.name}, ptr ${name}, ptr ${vAdapters(host, t).release})`);
          }
        };
        if (e.mode === "next") {
          if (e.arg === null) {
            if (genT.nextT.kind === "dyn") {
              // Valueless resume on a dyn channel: JS's undefined — the
              // dyn singleton rides the IN slot (+1 moves in).
              host.declare(`declare ptr @scr_dyn_undefined()`);
              host.declare(`declare ptr @scr_dyn_retain_v(ptr)`);
              host.declare(`declare void @scr_dyn_release_v(ptr)`);
              host.declare(`declare void @scr_gen_in_ref(ptr, ptr, ptr)`);
              const u = B.tmp();
              const r = B.tmp();
              B.line(`${u} = call ptr @scr_dyn_undefined()`);
              B.line(`${r} = call ptr @scr_dyn_retain_v(ptr ${u})`);
              B.line(`call void @scr_gen_in_ref(ptr ${g.name}, ptr ${r}, ptr @scr_dyn_release_v)`);
            } else {
              host.declare(`declare void @scr_gen_in_none(ptr)`);
              B.line(`call void @scr_gen_in_none(ptr ${g.name})`);
            }
          } else {
            sendArg(parkIn);
          }
          host.declare(`declare void @scr_gen_resume(ptr)`);
          B.line(`call void @scr_gen_resume(ptr ${g.name})`);
        } else if (e.mode === "return") {
          if (e.arg === null) {
            host.declare(`declare void @scr_gen_ret_none(ptr)`);
            B.line(`call void @scr_gen_ret_none(ptr ${g.name})`);
          } else {
            sendArg((name, t) => {
              if (t.kind === "f64" || t.kind === "date") {
                host.declare(`declare void @scr_gen_ret_f64(ptr, double)`);
                B.line(`call void @scr_gen_ret_f64(ptr ${g.name}, double ${name})`);
              } else if (t.kind === "bool") {
                host.declare(`declare void @scr_gen_ret_bool(ptr, i1 zeroext)`);
                B.line(`call void @scr_gen_ret_bool(ptr ${g.name}, i1 ${name})`);
              } else {
                host.declare(`declare void @scr_gen_ret_ref(ptr, ptr, ptr)`);
                B.line(`call void @scr_gen_ret_ref(ptr ${g.name}, ptr ${name}, ptr ${vAdapters(host, t).release})`);
              }
            });
          }
          host.declare(`declare void @scr_gen_resume_return(ptr)`);
          B.line(`call void @scr_gen_resume_return(ptr ${g.name})`);
        } else {
          // .throw(e): park the payload in the CALLER's cell (the throw
          // statement's exact kind dispatch), then resume — the runtime
          // moves it into the fiber, or leaves it pending (non-suspended
          // generators: the .throw call itself throws at the check below).
          if (e.arg === null) throw new InternalCompilerError("llvm emitter bug: genResume throw with no payload");
          const a = host.emitExpr(e.arg);
          if (isRefCounted(e.arg.type)) host.moveTemp(a); // the cell takes ownership
          host.emitThrowValue({ name: a.name, type: e.arg.type });
          host.declare(`declare void @scr_gen_resume_throw(ptr)`);
          B.line(`call void @scr_gen_resume_throw(ptr ${g.name})`);
        }
        const helper = host.genResultThunkFor(genT, e.type);
        // The record builds before the check so an unwind (a propagated
        // body exception) releases it as the frame's never-read dummy.
        const t = B.tmp();
        B.line(`${t} = call ptr @${helper}(ptr ${g.name})`);
        const out = host.own({ name: t, type: e.type });
        host.emitPendingCheck();
        return out;
      }
      case "awaitExpr": {
        // Parks the fiber until the promise settles; rejected promises
        // re-throw here (hence the pending check). Promise temp borrowed;
        // refcounted results arrive +1 and join the frame pre-check so an
        // unwind releases the dummy (NULL) harmlessly.
        const pr = host.emitExpr(e.value);
        if (host.wasi) host.emitWasiSuspend(pr.name);
        if (e.type.kind === "void") {
          host.declare(`declare void @scr_await_void(ptr)`);
          B.line(`call void @scr_await_void(ptr ${pr.name})`);
          host.emitPendingCheck();
          return { name: "", type: e.type };
        }
        const t = B.tmp();
        if (e.type.kind === "f64" || e.type.kind === "date") {
          host.declare(`declare double @scr_await_f64(ptr)`);
          B.line(`${t} = call double @scr_await_f64(ptr ${pr.name})`);
        } else if (e.type.kind === "bool") {
          host.declare(`declare zeroext i1 @scr_await_bool(ptr)`);
          B.line(`${t} = call zeroext i1 @scr_await_bool(ptr ${pr.name})`);
        } else if (e.type.kind === "string") {
          host.declare(`declare ptr @scr_await_str(ptr)`);
          B.line(`${t} = call ptr @scr_await_str(ptr ${pr.name})`);
        } else {
          host.declare(`declare ptr @scr_await_ref(ptr)`);
          B.line(`${t} = call ptr @scr_await_ref(ptr ${pr.name})`);
        }
        const out = host.own({ name: t, type: e.type });
        host.emitPendingCheck();
        return out;
      }
      case "awaitUnionExpr": {
        // Await of a promise-or-absent union: the promise arm awaits like
        // awaitExpr (parks, re-throws rejections); a unit arm takes
        // exactly one microtask hop (JS: await of a non-thenable) and
        // yields itself. The union temp is borrowed; the value-carrying
        // result parks in a slot, joins the frame at the load, and the
        // pending check runs after the join (exprs.ts's shape).
        if (e.value.type.kind !== "union") throw new InternalCompilerError("llvm emitter bug: awaitUnion of a non-union");
        const def = host.unionsById.get(e.value.type.unionId);
        const promiseArm = def?.arms[e.promiseTag];
        if (!def || promiseArm?.kind !== "promise") {
          throw new InternalCompilerError("llvm emitter bug: awaitUnion arm is not a promise");
        }
        const inner = promiseArm.inner;
        const u = host.emitExpr(e.value);
        const tag = host.unionTag(u.name);
        const isP = B.tmp();
        B.line(`${isP} = icmp eq i32 ${tag}, ${e.promiseTag}`);
        host.declare(`declare void @scr_await_hop()`);
        if (e.type.kind === "void") {
          const lp = B.newLabel("au.p");
          const lh = B.newLabel("au.h");
          const lj = B.newLabel("au.j");
          B.condBr(isP, lp, lh);
          B.startBlock(lp);
          host.declare(`declare void @scr_await_void(ptr)`);
          {
            const promise = host.unionPeek(u.name);
            if (host.wasi) host.emitWasiSuspend(promise);
            B.line(`call void @scr_await_void(ptr ${promise})`);
          }
          B.br(lj);
          B.startBlock(lh);
          if (host.wasi) host.emitWasiSuspend(null);
          else B.line(`call void @scr_await_hop()`);
          B.br(lj);
          B.startBlock(lj);
          host.emitPendingCheck();
          return { name: "", type: e.type };
        }
        if (e.type.kind !== "union") {
          throw new InternalCompilerError("llvm emitter bug: awaitUnion result is neither void nor a union");
        }
        const resUnionId = e.type.unionId;
        const resDef = host.unionsById.get(resUnionId);
        if (!resDef) throw new InternalCompilerError("llvm emitter bug: awaitUnion result union unknown");
        const resTagOf = (arm: IrType): number => {
          const t = resDef.arms.findIndex((a) => typeEquals(a, arm));
          if (t < 0) throw new InternalCompilerError("llvm emitter bug: awaitUnion result arm missing");
          return t;
        };
        const innerTag = resTagOf(inner);
        const slot = B.slot();
        B.entryAllocas.push(`${slot} = alloca ptr`);
        B.line(`store ptr null, ptr ${slot}`);
        const lp = B.newLabel("au.p");
        const lh = B.newLabel("au.h");
        const lj = B.newLabel("au.j");
        B.condBr(isP, lp, lh);
        B.startBlock(lp);
        const peek = host.unionPeek(u.name);
        if (host.wasi) host.emitWasiSuspend(peek);
        let awaited: LlValue;
        if (inner.kind === "f64" || inner.kind === "date") {
          host.declare(`declare double @scr_await_f64(ptr)`);
          const x = B.tmp();
          B.line(`${x} = call double @scr_await_f64(ptr ${peek})`);
          awaited = { name: x, type: inner };
        } else if (inner.kind === "bool") {
          host.declare(`declare zeroext i1 @scr_await_bool(ptr)`);
          const x = B.tmp();
          B.line(`${x} = call zeroext i1 @scr_await_bool(ptr ${peek})`);
          awaited = { name: x, type: inner };
        } else if (inner.kind === "string") {
          host.declare(`declare ptr @scr_await_str(ptr)`);
          const x = B.tmp();
          B.line(`${x} = call ptr @scr_await_str(ptr ${peek})`);
          awaited = { name: x, type: inner };
        } else {
          host.declare(`declare ptr @scr_await_ref(ptr)`);
          const x = B.tmp();
          B.line(`${x} = call ptr @scr_await_ref(ptr ${peek})`);
          awaited = { name: x, type: inner };
        }
        B.line(`store ptr ${host.unionNewOwned(innerTag, awaited)}, ptr ${slot}`);
        B.br(lj);
        B.startBlock(lh);
        if (host.wasi) host.emitWasiSuspend(null);
        else B.line(`call void @scr_await_hop()`);
        const unitTags = def.arms.flatMap((a, i) => (isUnitType(a) ? [i] : []));
        if (unitTags.length === 1) {
          B.line(`store ptr ${host.unitInstanceRef(resUnionId, resTagOf(def.arms[unitTags[0]!]!))}, ptr ${slot}`);
          B.br(lj);
        } else {
          // Several unit arms: dispatch on the source tag (each maps to
          // its own interned instance in the result union).
          const bad = B.newLabel("au.b");
          const labels = unitTags.map(() => B.newLabel("au.u"));
          B.terminate(
            `switch i32 ${tag}, label %${bad} [ ${unitTags.map((t2, i) => `i32 ${t2}, label %${labels[i]}`).join(" ")} ]`,
          );
          unitTags.forEach((t2, i) => {
            B.startBlock(labels[i]!);
            B.line(`store ptr ${host.unitInstanceRef(resUnionId, resTagOf(def.arms[t2]!))}, ptr ${slot}`);
            B.br(lj);
          });
          B.startBlock(bad);
          host.needsBadTag = true;
          B.line(`call void @sc_bad_tag()`);
          B.terminate(`unreachable`);
        }
        B.startBlock(lj);
        const t = B.tmp();
        B.line(`${t} = load ptr, ptr ${slot}`);
        const out = host.own({ name: t, type: e.type });
        host.emitPendingCheck();
        return out;
      }
      case "newPromise": {
        // Pending promise + resolve closure, executor run synchronously
        // (its throw rejects — handled inside the runtime helper, so no
        // pending check here). Executor/resolve temps are frame-owned;
        // the run call takes ownership of the resolve/reject closures.
        if (e.type.kind !== "promise") throw new InternalCompilerError("llvm emitter bug: newPromise type");
        const inner = e.type.inner;
        host.declare(`declare ptr @scr_promise_new()`);
        const p = B.tmp();
        B.line(`${p} = call ptr @scr_promise_new()`);
        const out = host.own({ name: p, type: e.type });
        // Zero-param executor: no resolve exists — a forever-pending
        // promise unless the executor throws (which rejects it).
        if (e.executor.type.kind === "func" && e.executor.type.params.length === 0) {
          const exec0 = host.emitExpr(e.executor);
          host.declare(`declare void @scr_promise_run_executor0(ptr, ptr)`);
          B.line(`call void @scr_promise_run_executor0(ptr ${p}, ptr ${exec0.name})`);
          return out;
        }
        let resolve: string;
        const kindNums: Partial<Record<IrType["kind"], number>> = { f64: 0, date: 0, bool: 1, string: 2, void: 3 };
        const kindNum = kindNums[inner.kind];
        if (kindNum !== undefined) {
          host.declare(`declare ptr @scr_make_resolve(ptr, i32)`);
          resolve = B.tmp();
          B.line(`${resolve} = call ptr @scr_make_resolve(ptr ${p}, i32 ${kindNum})`);
        } else {
          host.declare(`declare ptr @scr_make_resolve_fn(ptr, ptr)`);
          resolve = B.tmp();
          B.line(`${resolve} = call ptr @scr_make_resolve_fn(ptr ${p}, ptr @${host.resolveThunkFor(inner)})`);
        }
        if (e.executor.type.kind === "func" && e.executor.type.params.length === 2) {
          // Two-param executor: reject is a runtime-provided closure
          // rejecting the promise with its Error reason. First settle
          // wins in the runtime; both closures' +1 move into the call.
          host.declare(`declare ptr @scr_make_reject(ptr)`);
          const reject = B.tmp();
          B.line(`${reject} = call ptr @scr_make_reject(ptr ${p})`);
          const exec2 = host.emitExpr(e.executor);
          host.declare(`declare void @scr_promise_run_executor2(ptr, ptr, ptr, ptr)`);
          B.line(`call void @scr_promise_run_executor2(ptr ${p}, ptr ${exec2.name}, ptr ${resolve}, ptr ${reject})`);
          return out;
        }
        const exec = host.emitExpr(e.executor);
        host.declare(`declare void @scr_promise_run_executor(ptr, ptr, ptr)`);
        B.line(`call void @scr_promise_run_executor(ptr ${p}, ptr ${exec.name}, ptr ${resolve})`);
        return out;
      }
      case "promiseWithResolvers": {
        // The newPromise pieces without an executor: a pending promise,
        // its runtime resolve closure (typed per the inner kind), and the
        // reject closure, written into the fresh record. Closure +1s move
        // into the record's fields; never throws.
        if (e.type.kind !== "record") throw new InternalCompilerError("llvm emitter bug: promiseWithResolvers type");
        const shape = host.recordsById.get(e.type.shapeId);
        const promT = shape?.fields.find((f) => f.name === "promise")?.type;
        if (!shape || promT?.kind !== "promise") {
          throw new InternalCompilerError("llvm emitter bug: promiseWithResolvers record shape");
        }
        const inner = promT.inner;
        host.declare(`declare ptr @scr_promise_new()`);
        host.declare(`declare ptr @scr_make_reject(ptr)`);
        const p = B.tmp();
        B.line(`${p} = call ptr @scr_promise_new()`);
        const kindNums: Partial<Record<IrType["kind"], number>> = { f64: 0, date: 0, bool: 1, string: 2, void: 3 };
        const kindNum = kindNums[inner.kind];
        const resolve = B.tmp();
        if (kindNum !== undefined) {
          host.declare(`declare ptr @scr_make_resolve(ptr, i32)`);
          B.line(`${resolve} = call ptr @scr_make_resolve(ptr ${p}, i32 ${kindNum})`);
        } else {
          host.declare(`declare ptr @scr_make_resolve_fn(ptr, ptr)`);
          B.line(`${resolve} = call ptr @scr_make_resolve_fn(ptr ${p}, ptr @${host.resolveThunkFor(inner)})`);
        }
        const reject = B.tmp();
        B.line(`${reject} = call ptr @scr_make_reject(ptr ${p})`);
        const rec = B.tmp();
        B.line(`${rec} = call ptr @${mangleRecordNew(e.type.shapeId)}()`);
        const out = host.own({ name: rec, type: e.type });
        // The three +1s move straight into the fresh record's fields.
        for (const [field, value] of [["promise", p], ["resolve", resolve], ["reject", reject]] as const) {
          const { ptr } = host.recordFieldPtr(rec, e.type.shapeId, field);
          B.line(`store ptr ${value}, ptr ${ptr}`);
        }
        return out;
      }
      default: {
        const _exhaustive: never = e;
        void _exhaustive;
        throw new InternalCompilerError("unreachable");
      }
    }
  }
