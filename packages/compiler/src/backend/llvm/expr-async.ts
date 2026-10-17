import { emitBorrowedInput } from "./borrowed-inputs.js";
/* Focused LLVM expression emission extracted from emitter.ts. */
import { InternalCompilerError } from "../../errors.js";
import {
  type IrExpr,
  type IrType,
  isDynTypedRefType,
  isRefCounted,
  isUnitType,
  typeEquals,
  typeKey,
} from "../../ir/ir.js";
import { DYN_KIND } from "./dyn.js";
import { stringParts } from "./string-construction.js";
import { emitStringInputs } from "./string-lifetimes.js";
import { mangleRecordNew } from "../mangle.js";
import { arrNewCall, traceArg, vAdapters } from "./shapes.js";
import { LlvmUnsupportedError } from "./unsupported.js";
import type { LlvmEmitterContext, ExprOf, LlValue } from "./expr-context.js";
import { settledStoreFor } from "./expr-callbacks.js";

export function emitIntrinsicExpr(host: LlvmEmitterContext, e: ExprOf<"intrinsic">): LlValue {
  const B = host.B;
  switch (e.kind) {
    case "intrinsic": {
      if (e.name === "module.tdzCheck") {
        // An import-cycle binding's initialization flag: false is the
        // temporal dead zone (Node's catchable ReferenceError).
        const flag = host.emitExpr(e.args[0]!);
        const name = e.args[1]!;
        if (name.kind !== "strLit")
          throw new InternalCompilerError("llvm emitter bug: module.tdzCheck name");
        host.checkInitializedFlag(flag.name, name.value);
        return { name: "", type: e.type };
      }
      if (e.name === "module.await") {
        // Internal ESM dependency wait: pending promises park the module
        // fiber, while settled ones continue synchronously.
        const p = host.emitExpr(e.args[0]!);
        if (host.wasi) {
          const coro = host.currentCoro;
          if (coro === null)
            throw new InternalCompilerError(
              "llvm emitter bug: module await outside wasm coroutine",
            );
          host.declare(`declare zeroext i1 @scr_wasi_module_await_prepare(ptr, ptr)`);
          const needsSuspend = B.tmp();
          const suspend = B.newLabel("ma.suspend");
          const ready = B.newLabel("ma.ready");
          B.line(
            `${needsSuspend} = call zeroext i1 @scr_wasi_module_await_prepare(ptr ${coro.self}, ptr ${p.name})`,
          );
          B.condBr(needsSuspend, suspend, ready);
          B.startBlock(suspend);
          host.emitCoroSuspendPrepared();
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
        if (e.type.kind !== "promise")
          throw new InternalCompilerError("llvm emitter bug: promise.all type");
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
        if (e.type.inner.kind !== "array")
          throw new InternalCompilerError("llvm emitter bug: promise.all result");
        const elem = e.type.inner.elem;
        const store =
          elem.kind === "f64"
            ? "scr_promise_all_store_f64"
            : elem.kind === "bool"
              ? "scr_promise_all_store_bool"
              : elem.kind === "string"
                ? "scr_promise_all_store_str"
                : "scr_promise_all_store_ref";
        host.declare(`declare void @${store}(ptr, double, ptr)`);
        host.declare(`declare double @scr_arr_len(ptr)`);
        const len = B.tmp();
        const cap = B.tmp();
        B.line(`${len} = call double @scr_arr_len(ptr ${ps.name})`);
        B.line(`${cap} = fptoui double ${len} to ${host.sizeType}`);
        const vals = B.tmp();
        B.line(`${vals} = ${arrNewCall(host.shapeHost, elem, cap)}`);
        host.own({ name: vals, type: e.type.inner });
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_promise_all(ptr ${ps.name}, ptr ${vals}, ptr @${store})`);
        return host.own({ name: t, type: e.type });
      }
      if (e.name === "promise.allSettled" || e.name === "promise.any") {
        // Promise.all's countdown combinator in its other modes. Both
        // BORROW the frame-owned entries (and allSettled's values array).
        const entries = e.args[0]!;
        if (
          e.type.kind !== "promise" ||
          entries.type.kind !== "array" ||
          entries.type.elem.kind !== "promise"
        )
          throw new InternalCompilerError(`llvm emitter bug: ${e.name} shape`);
        const ps = host.emitExpr(entries);
        if (e.name === "promise.any") {
          host.declare(`declare ptr @scr_promise_any_typed(ptr)`);
          const t = B.tmp();
          B.line(`${t} = call ptr @scr_promise_any_typed(ptr ${ps.name})`);
          return host.own({ name: t, type: e.type });
        }
        if (e.type.inner.kind !== "array" || e.type.inner.elem.kind !== "union")
          throw new InternalCompilerError("llvm emitter bug: promise.allSettled result");
        const elem = e.type.inner.elem;
        const store = settledStoreFor(host, entries.type.elem.inner, elem);
        host.declare(`declare ptr @scr_promise_all_settled(ptr, ptr, ptr)`);
        host.declare(`declare double @scr_arr_len(ptr)`);
        const len = B.tmp();
        const cap = B.tmp();
        B.line(`${len} = call double @scr_arr_len(ptr ${ps.name})`);
        B.line(`${cap} = fptoui double ${len} to ${host.sizeType}`);
        const vals = B.tmp();
        B.line(`${vals} = ${arrNewCall(host.shapeHost, elem, cap)}`);
        host.own({ name: vals, type: e.type.inner });
        const t = B.tmp();
        B.line(
          `${t} = call ptr @scr_promise_all_settled(ptr ${ps.name}, ptr ${vals}, ptr @${store})`,
        );
        return host.own({ name: t, type: e.type });
      }
      if (e.name === "promise.reject") {
        // A fresh promise rejected through the exception cell: the
        // %Error-rooted reason moves in as the cell's OBJ payload (a
        // checked-dynamic reason rides the thrown-dyn REF representation
        // instead — identity flows to catch/unhandledRejection observers,
        // emitThrowValue's dyn arm), and reject_pending moves the cell
        // into the promise (consumed immediately — no pending check runs
        // in between).
        if (e.type.kind !== "promise")
          throw new InternalCompilerError("llvm emitter bug: promise.reject type");
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
        if (e.type.kind !== "promise")
          throw new InternalCompilerError("llvm emitter bug: promise.resolve type");
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
          const rc = vAdapters(host.shapeHost, t);
          host.moveTemp(v);
          host.declare(`declare void @scr_promise_fulfill_ref(ptr, ptr, ptr, ptr, ptr)`);
          B.line(
            `call void @scr_promise_fulfill_ref(ptr ${p}, ptr ${v.name}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${traceArg(host.shapeHost, t)})`,
          );
        }
        return out;
      }
      if (e.name === "promise.race") {
        // A fresh result promise + one race_join per entry: each entry
        // settles it from a reaction job (first job wins), queued when the
        // entry settles or at the join for a settled entry. Entry temps
        // stay frame-owned (race_join retains what it keeps).
        if (e.type.kind !== "promise")
          throw new InternalCompilerError("llvm emitter bug: promise.race type");
        host.declare(`declare ptr @scr_promise_new()`);
        host.declare(`declare void @scr_promise_race_join(ptr, ptr, ptr)`);
        const result = B.tmp();
        B.line(`${result} = call ptr @scr_promise_new()`);
        const out = host.own({ name: result, type: e.type });
        for (const entry of e.args) {
          if (entry.type.kind !== "promise")
            throw new InternalCompilerError("llvm emitter bug: promise.race entry");
          const p = host.emitExpr(entry);
          const adapter = host.raceAdapterFor(entry.type.inner, e.type.inner);
          B.line(`call void @scr_promise_race_join(ptr ${result}, ptr ${p.name}, ptr @${adapter})`);
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
      //
      // A string-concatenation argument (template literal, `"a" + n`)
      // passes its parts instead of the joined string: later parts carry
      // the GLUE flag (no separating space), and number/boolean conversions
      // pass the raw value (SCR_ARG_NUM keeps String()'s "-0" -> "0"). The
      // runtime renders straight into the line it writes, so the parts'
      // strings and the joined copy are never allocated. Parts evaluate in
      // source order with concatenation's borrowing rules.
      const plan: { expr: IrExpr; glue: boolean; num: boolean }[] = [];
      for (const a of e.args) {
        if (a.kind !== "strConcat") {
          plan.push({ expr: a, glue: false, num: false });
          continue;
        }
        stringParts(a).forEach((part, j) => {
          const operand = part.kind === "toString" ? part.operand : undefined;
          if (
            operand !== undefined &&
            (operand.type.kind === "f64" || operand.type.kind === "bool")
          )
            plan.push({ expr: operand, glue: j > 0, num: operand.type.kind === "f64" });
          else plan.push({ expr: part, glue: j > 0, num: false });
        });
      }
      const usesParts = plan.length !== e.args.length;
      const args = usesParts
        ? emitStringInputs(
            host,
            plan.map((p) => p.expr),
          )
        : e.args.map((a) => host.emitExpr(a));
      host.logArgSlots = Math.max(host.logArgSlots, Math.max(args.length, 1));
      args.forEach((a, i) => {
        const tagOf: Record<string, number> = { f64: 0, string: 1, bool: 2 };
        const kind = usesParts && plan[i]!.num ? 3 : tagOf[a.type.kind];
        if (kind === undefined) throw new LlvmUnsupportedError(`logArg:${a.type.kind}`, e.loc);
        const tag = usesParts && plan[i]!.glue ? kind | 0x100 : kind;
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
      const fn =
        (e.name === "console.error" ? "scr_console_error" : "scr_console_log") +
        (usesParts ? "_parts" : "");
      host.declare(`declare void @${fn}(${host.sizeType}, ptr)`);
      B.line(`call void @${fn}(${host.sizeType} ${args.length}, ptr %logargs)`);
      return { name: "", type: e.type };
    }
    default: {
      throw new InternalCompilerError("unreachable");
    }
  }
}

export function emitSerializationExpr(
  host: LlvmEmitterContext,
  e: ExprOf<"jsonStringify" | "dynCheck">,
): LlValue {
  const B = host.B;
  switch (e.kind) {
    case "jsonStringify": {
      // Type-directed serialization: the STATIC type picks an emitted
      // serializer (interned per typeKey) — no dyn, no runtime dispatch.
      // The value temp is BORROWED (released with this statement's
      // frame); the result string is owned (+1). Never throws — except
      // the dyn root below.
      const v = emitBorrowedInput(host, e.value);
      let compact: { name: string; type: IrType };
      if (e.value.type.kind === "dyn") {
        // A dyn root: the runtime's dyn walker (scr_dyn_format_j): number/string/bool/null/array/
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
        // TypeError mid-walk, and a record serialized through its kept
        // checked source can throw from the dyn walker: finish still runs
        // (frees the buffer, the partial string joins the frame and
        // releases on unwind), then the pending check unwinds — the
        // runtime ABI’s contract exactly.
        if (host.walkers.jsonWriteMayThrow(e.value.type)) host.emitPendingCheck();
      }
      // A pretty-print form (`stringify(v, null, 2)`): the frontend
      // resolved the space to a compile-time indent string (Node's
      // clamp/truncate rules); the interned re-indenter rewrites the
      // compact text with Node's gap algorithm. Compact temp stays
      // frame-owned; the pretty string is a fresh +1.
      const indent = e.indent;
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
      // `JSON.parse(text) as T` fuses into one schema-directed parse that
      // falls back to exactly this route whenever the fast path declines.
      const parsed = e.value;
      if (!e.preserveRefs && parsed.kind === "libCall" && parsed.fn === "json.parse") {
        const fused = host.dyn.jsonParseHelper(e.type);
        if (fused) {
          const text = emitBorrowedInput(host, parsed.args[0]!);
          const r = B.tmp();
          B.line(`${r} = call ptr @${fused}(ptr ${text.name})`);
          const fusedOut = host.own({ name: r, type: e.type });
          host.emitPendingCheck();
          return fusedOut;
        }
      }
      if (e.exact && isDynTypedRefType(e.type)) {
        const object = host.emitExactCapsuleObject(e.value, e.type);
        const retained = B.tmp();
        B.line(
          `${retained} = call ptr ${vAdapters(host.shapeHost, e.type).retain}(ptr ${object.name})`,
        );
        return host.own({ name: retained, type: e.type });
      }
      const dynV = emitBorrowedInput(host, e.value);
      const helper = host.dyn.dynCheckHelper(e.type, e.preserveRefs);
      if (isDynTypedRefType(e.type)) return emitClassCheck(host, e.type, dynV.name, helper);
      const ty = host.llType(e.type);
      const t = B.tmp();
      B.line(
        `${t} = call ${ty === "i1" ? "zeroext i1" : ty} @${helper}(ptr ${dynV.name}, ptr null)`,
      );
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

/** A checked class value: a capsule this program boxed from exactly the
 * class yields its instance (+1) inline; any other value takes the
 * checking helper, which may throw. */
function emitClassCheck(
  host: LlvmEmitterContext,
  type: IrType & { kind: "object" },
  value: string,
  helper: string,
): LlValue {
  const B = host.B;
  const slot = B.slot();
  B.entryAllocas.push(`${slot} = alloca ptr`);
  const present = B.tmp(),
    typed = B.tmp(),
    keySlot = B.tmp(),
    keyPtr = B.tmp(),
    same = B.tmp();
  const inspect = B.newLabel("dc.inspect");
  const capsule = B.newLabel("dc.capsule");
  const exact = B.newLabel("dc.exact");
  const checked = B.newLabel("dc.checked");
  const done = B.newLabel("dc.done");
  B.line(`${present} = icmp ne ptr ${value}, null`);
  B.condBr(present, inspect, checked);
  B.startBlock(inspect);
  B.line(`${typed} = icmp eq i32 ${host.dynKind(value)}, ${DYN_KIND.TYPED_REF}`);
  B.condBr(typed, capsule, checked);
  B.startBlock(capsule);
  B.line(
    `${keySlot} = getelementptr inbounds i8, ptr ${value}, i64 ${host.abiOffset(40, 28)} ; ->v.typed_ref.type_key`,
  );
  B.line(`${keyPtr} = load ptr, ptr ${keySlot}`);
  B.line(`${same} = icmp eq ptr ${keyPtr}, ${host.cstr(typeKey(type))}`);
  B.condBr(same, exact, checked);
  B.startBlock(exact);
  const objectSlot = B.tmp(),
    object = B.tmp(),
    retained = B.tmp();
  B.line(`${objectSlot} = getelementptr inbounds i8, ptr ${value}, i64 16 ; ->v.typed_ref.ptr`);
  B.line(`${object} = load ptr, ptr ${objectSlot}`);
  B.line(`${retained} = call ptr ${vAdapters(host.shapeHost, type).retain}(ptr ${object})`);
  B.line(`store ptr ${retained}, ptr ${slot}`);
  B.br(done);
  B.startBlock(checked);
  const result = B.tmp();
  B.line(`${result} = call ptr @${helper}(ptr ${value}, ptr null)`);
  B.line(`store ptr ${result}, ptr ${slot}`);
  // A throwing check returns null, so the unwind has nothing to release.
  host.emitPendingCheck();
  B.br(done);
  B.startBlock(done);
  const out = B.tmp();
  B.line(`${out} = load ptr, ptr ${slot}`);
  return host.own({ name: out, type });
}

export function emitAsyncExpr(
  host: LlvmEmitterContext,
  e: ExprOf<
    | "yieldExpr"
    | "genResume"
    | "awaitExpr"
    | "awaitUnionExpr"
    | "newPromise"
    | "promiseWithResolvers"
  >,
): LlValue {
  const B = host.B;
  switch (e.kind) {
    case "yieldExpr": {
      // Park the operand in the generator's OUT slot (moved in, typed by
      // the function's yield channel) and switch back to the resumer.
      // Control returns at the next resume — possibly with an injected
      // .throw payload or the GENRET sentinel pending, hence the check.
      // The result is the .next(v) argument, moved out of the IN slot.
      const gen = host.currentGenerator;
      if (!gen)
        throw new InternalCompilerError("llvm emitter bug: yieldExpr outside a generator body");
      if (e.value === null)
        throw new InternalCompilerError(
          "llvm emitter bug: yieldExpr with no operand (frontend fills undefined)",
        );
      const v = host.emitExpr(e.value);
      const yt = e.value.type;
      if (e.awaited) {
        host.declare(`declare void @scr_async_gen_hop_done()`);
        B.line(`call void @scr_async_gen_hop_done()`);
      }
      if (yt.kind === "f64" || yt.kind === "date") {
        if (host.currentCoro !== null) {
          const coro = host.currentCoro;
          if (coro.out !== null) host.emitGenSlotStore(coro.out, "f64", v.name);
          else if (host.wasi) {
            host.declare(`declare ptr @scr_gen_of_fiber(ptr)`);
            host.declare(`declare void @scr_gen_out_f64(ptr, double)`);
            const g = B.tmp();
            B.line(`${g} = call ptr @scr_gen_of_fiber(ptr ${coro.self})`);
            B.line(`call void @scr_gen_out_f64(ptr ${g}, double ${v.name})`);
          } else {
            host.declare(`declare void @scr_coro_yield_f64(ptr, double)`);
            B.line(`call void @scr_coro_yield_f64(ptr ${coro.self}, double ${v.name})`);
          }
        } else {
          host.declare(`declare void @scr_gen_yield_f64(double)`);
          B.line(`call void @scr_gen_yield_f64(double ${v.name})`);
        }
      } else if (yt.kind === "bool") {
        if (host.currentCoro !== null) {
          const coro = host.currentCoro;
          if (coro.out !== null) host.emitGenSlotStore(coro.out, "bool", v.name);
          else if (host.wasi) {
            host.declare(`declare ptr @scr_gen_of_fiber(ptr)`);
            host.declare(`declare void @scr_gen_out_bool(ptr, i1 zeroext)`);
            const g = B.tmp();
            B.line(`${g} = call ptr @scr_gen_of_fiber(ptr ${coro.self})`);
            B.line(`call void @scr_gen_out_bool(ptr ${g}, i1 ${v.name})`);
          } else {
            host.declare(`declare void @scr_coro_yield_bool(ptr, i1 zeroext)`);
            B.line(`call void @scr_coro_yield_bool(ptr ${coro.self}, i1 ${v.name})`);
          }
        } else {
          host.declare(`declare void @scr_gen_yield_bool(i1 zeroext)`);
          B.line(`call void @scr_gen_yield_bool(i1 ${v.name})`);
        }
      } else {
        host.moveTemp(v); // the OUT slot takes ownership
        if (host.currentCoro !== null) {
          const coro = host.currentCoro;
          const release = vAdapters(host.shapeHost, yt).release;
          if (host.wasi) {
            host.declare(`declare ptr @scr_gen_of_fiber(ptr)`);
            host.declare(`declare void @scr_gen_out_ref(ptr, ptr, ptr)`);
            const g = B.tmp();
            B.line(`${g} = call ptr @scr_gen_of_fiber(ptr ${coro.self})`);
            B.line(`call void @scr_gen_out_ref(ptr ${g}, ptr ${v.name}, ptr ${release})`);
          } else {
            host.declare(`declare void @scr_coro_yield_ref(ptr, ptr, ptr)`);
            B.line(
              `call void @scr_coro_yield_ref(ptr ${coro.self}, ptr ${v.name}, ptr ${release})`,
            );
          }
        } else {
          host.declare(`declare void @scr_gen_yield_ref(ptr, ptr)`);
          B.line(
            `call void @scr_gen_yield_ref(ptr ${v.name}, ptr ${vAdapters(host.shapeHost, yt).release})`,
          );
        }
      }
      if (host.currentCoro !== null) host.emitCoroSuspendPrepared();
      if (e.captureCompletion) {
        const converter = (type: IrType): string =>
          isRefCounted(type) ? `@${host.dyn.toDynHelper(type)}` : "null";
        host.declare(`declare ptr @scr_gen_delegate_resume(ptr, ptr, ptr)`);
        const resumed = B.tmp();
        B.line(
          `${resumed} = call ptr @scr_gen_delegate_resume(ptr ${converter(gen.nextT)}, ptr ${converter(e.captureCompletion.returnType)}, ptr @${host.dyn.caughtToDynHelper()})`,
        );
        const out = host.own({ name: resumed, type: e.type });
        host.emitPendingCheck();
        return out;
      }
      // The delegate resume that follows reads the resumption.
      if (e.delegated) return { name: "", type: e.type };
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
      if (e.type.kind === "dyn") {
        // A valueless resume leaves IN empty: JS's undefined.
        host.declare(`declare ptr @scr_gen_take_in_dyn()`);
        B.line(`${t} = call ptr @scr_gen_take_in_dyn()`);
        return host.own({ name: t, type: e.type });
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
      if (genT.kind !== "generator")
        throw new InternalCompilerError("llvm emitter bug: genResume on a non-generator");
      if (e.mode === "delegate") {
        // yield*'s drive of a sync generator: the first valueless next(),
        // or the delegated yield and then the consumer's next/return/throw
        // passed on to the delegate. Both answer the delegate's done.
        const outer = host.currentGenerator;
        if (genT.async || outer === null)
          throw new InternalCompilerError(
            "llvm emitter bug: genResume delegate outside a generator",
          );
        if (e.arg !== null) host.emitExpr(e.arg);
        const gb = emitBorrowedInput(host, e.gen);
        const done = B.tmp();
        // A record-free drive reads a valued completion out of OUT, typed
        // as the return channel: an empty one (undefined) throws instead.
        const typedRet = e.type.kind === "bool" && genT.retT.kind !== "void";
        if (e.arg === null) {
          // A suspended delegate reads the empty IN slot as undefined only
          // on an undefined or dyn next channel.
          const typedNext = genT.nextT.kind !== "undefinedT" && genT.nextT.kind !== "dyn";
          host.declare(`declare zeroext i1 @scr_gen_delegate_start(ptr, i32)`);
          B.line(
            `${done} = call zeroext i1 @scr_gen_delegate_start(ptr ${gb.name}, i32 ${(typedNext ? 1 : 0) | (typedRet ? 2 : 0)})`,
          );
        } else {
          // One slot transfer between channels (scr_async.c): 0 moves, 1
          // boxes into dyn, 2 admits only an empty slot (a return value
          // stays parked in this body), 3 drops.
          const transfer = (from: IrType, to: IrType, next: boolean): [number, string] => {
            if (next && to.kind === "undefinedT") return [3, "null"];
            if (typeEquals(from, to) || from.kind === "undefinedT" || from.kind === "void")
              return [0, "null"];
            if (to.kind === "dyn" && (from.kind === "f64" || from.kind === "bool"))
              return [1, "null"];
            if (to.kind === "dyn" && isRefCounted(from))
              return [1, `@${host.dyn.toDynHelper(from)}`];
            return [2, "null"];
          };
          const [nm, nc] = transfer(outer.nextT, genT.nextT, true);
          const [rm, rc] = transfer(host.currentReturnType, genT.retT, false);
          const [dm, dc] = transfer(genT.retT, host.currentReturnType, false);
          // A resume with nothing pending passes next(v) on inline; a
          // pending throw or return takes the forwarding call.
          const pending = B.tmp();
          for (const line of host.pendingTestLines(pending)) B.line(line);
          const ln = B.newLabel("dg.next");
          const lf = B.newLabel("dg.fwd");
          const lj = B.newLabel("dg.join");
          B.condBr(pending, lf, ln);
          B.startBlock(ln);
          const nextDone = B.tmp();
          if (!typedRet && (nm === 3 || outer.nextT.kind === "undefinedT")) {
            host.declare(`declare zeroext i1 @scr_gen_step(ptr)`);
            B.line(`${nextDone} = call zeroext i1 @scr_gen_step(ptr ${gb.name})`);
          } else {
            host.declare(`declare zeroext i1 @scr_gen_delegate_next(ptr, i32, ptr)`);
            B.line(
              `${nextDone} = call zeroext i1 @scr_gen_delegate_next(ptr ${gb.name}, i32 ${nm | (typedRet ? 4 : 0)}, ptr ${nc})`,
            );
          }
          B.br(lj);
          B.startBlock(lf);
          const forwardDone = B.tmp();
          host.declare(`declare zeroext i1 @scr_gen_delegate_forward(ptr, i32, ptr, ptr, ptr)`);
          B.line(
            `${forwardDone} = call zeroext i1 @scr_gen_delegate_forward(ptr ${gb.name}, i32 ${nm | (rm << 2) | (dm << 4) | (typedRet ? 64 : 0)}, ptr ${nc}, ptr ${rc}, ptr ${dc})`,
          );
          B.br(lj);
          B.startBlock(lj);
          B.line(`${done} = phi i1 [ ${nextDone}, %${ln} ], [ ${forwardDone}, %${lf} ]`);
        }
        if (e.type.kind === "bool") {
          host.emitPendingCheck();
          return { name: done, type: e.type };
        }
        if (e.type.kind !== "record")
          throw new InternalCompilerError("llvm emitter bug: genResume delegate result");
        const helper = host.genResultThunkFor(genT, e.type);
        const t = B.tmp();
        B.line(`${t} = call ptr @${helper}(ptr ${gb.name})`);
        const out = host.own({ name: t, type: e.type });
        host.emitPendingCheck();
        return out;
      }
      if (e.mode === "close") {
        if (genT.async)
          throw new InternalCompilerError("llvm emitter bug: genResume close on async");
        const gb = emitBorrowedInput(host, e.gen);
        host.declare(`declare void @scr_gen_close(ptr)`);
        B.line(`call void @scr_gen_close(ptr ${gb.name})`);
        host.emitPendingCheck();
        return { name: "", type: e.type };
      }
      if (e.mode === "step" || e.mode === "value") {
        // The compiler's own drives: no IteratorResult record. `step`
        // resumes and answers done; `value` moves the typed yield out of
        // OUT (a yield-channel value, since the step answered false).
        if (genT.async)
          throw new InternalCompilerError(`llvm emitter bug: genResume ${e.mode} on async`);
        const gb = emitBorrowedInput(host, e.gen);
        if (e.mode === "value") {
          if (!host.wasi && (e.type.kind === "f64" || e.type.kind === "date"))
            return { name: host.emitGenSlotTake(host.genOutSlot(gb.name), "f64"), type: e.type };
          if (!host.wasi && e.type.kind === "bool")
            return { name: host.emitGenSlotTake(host.genOutSlot(gb.name), "bool"), type: e.type };
          const t = B.tmp();
          if (e.type.kind === "f64" || e.type.kind === "date") {
            host.declare(`declare double @scr_gen_take_out_f64(ptr)`);
            B.line(`${t} = call double @scr_gen_take_out_f64(ptr ${gb.name})`);
            return { name: t, type: e.type };
          }
          if (e.type.kind === "bool") {
            host.declare(`declare zeroext i1 @scr_gen_take_out_bool(ptr)`);
            B.line(`${t} = call zeroext i1 @scr_gen_take_out_bool(ptr ${gb.name})`);
            return { name: t, type: e.type };
          }
          if (!isRefCounted(e.type))
            throw new InternalCompilerError(
              `llvm emitter bug: genResume value of ${e.type.kind} (no OUT form)`,
            );
          host.declare(`declare ptr @scr_gen_take_out_ref(ptr)`);
          B.line(`${t} = call ptr @scr_gen_take_out_ref(ptr ${gb.name})`);
          return host.own({ name: t, type: e.type });
        }
        // Valueless: an empty IN slot reads as undefined on any channel.
        host.declare(`declare zeroext i1 @scr_gen_step(ptr)`);
        const d = B.tmp();
        B.line(`${d} = call zeroext i1 @scr_gen_step(ptr ${gb.name})`);
        host.emitPendingCheck();
        return { name: d, type: e.type };
      }
      const resultT = genT.async ? (e.type.kind === "promise" ? e.type.inner : null) : e.type;
      if (resultT?.kind !== "record")
        throw new InternalCompilerError(
          "llvm emitter bug: genResume result is not an IteratorResult record",
        );
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
          B.line(
            `call void @scr_gen_in_ref(ptr ${g.name}, ptr ${name}, ptr ${vAdapters(host.shapeHost, t).release})`,
          );
        }
      };
      if (genT.async) {
        let call: string;
        if (e.mode === "next") {
          if (e.arg === null) {
            if (genT.nextT.kind === "dyn") {
              host.declare(`declare ptr @scr_dyn_undefined()`);
              host.declare(`declare ptr @scr_dyn_retain_v(ptr)`);
              host.declare(`declare void @scr_dyn_release_v(ptr)`);
              host.declare(`declare ptr @scr_async_gen_next_ref(ptr, ptr, ptr)`);
              const u = B.tmp();
              const owned = B.tmp();
              B.line(`${u} = call ptr @scr_dyn_undefined()`);
              B.line(`${owned} = call ptr @scr_dyn_retain_v(ptr ${u})`);
              call = `call ptr @scr_async_gen_next_ref(ptr ${g.name}, ptr ${owned}, ptr @scr_dyn_release_v)`;
            } else {
              host.declare(`declare ptr @scr_async_gen_next_none(ptr)`);
              call = `call ptr @scr_async_gen_next_none(ptr ${g.name})`;
            }
          } else {
            const a = host.emitExpr(e.arg);
            const t = e.arg.type;
            if (isRefCounted(t)) host.moveTemp(a);
            if (t.kind === "f64" || t.kind === "date") {
              host.declare(`declare ptr @scr_async_gen_next_f64(ptr, double)`);
              call = `call ptr @scr_async_gen_next_f64(ptr ${g.name}, double ${a.name})`;
            } else if (t.kind === "bool") {
              host.declare(`declare ptr @scr_async_gen_next_bool(ptr, i1 zeroext)`);
              call = `call ptr @scr_async_gen_next_bool(ptr ${g.name}, i1 ${a.name})`;
            } else {
              host.declare(`declare ptr @scr_async_gen_next_ref(ptr, ptr, ptr)`);
              call = `call ptr @scr_async_gen_next_ref(ptr ${g.name}, ptr ${a.name}, ptr ${vAdapters(host.shapeHost, t).release})`;
            }
          }
        } else if (e.mode === "return") {
          if (e.arg === null) {
            host.declare(`declare ptr @scr_async_gen_return_none(ptr)`);
            call = `call ptr @scr_async_gen_return_none(ptr ${g.name})`;
          } else {
            const a = host.emitExpr(e.arg);
            const t = e.arg.type;
            if (isRefCounted(t)) host.moveTemp(a);
            if (t.kind === "f64" || t.kind === "date") {
              host.declare(`declare ptr @scr_async_gen_return_f64(ptr, double)`);
              call = `call ptr @scr_async_gen_return_f64(ptr ${g.name}, double ${a.name})`;
            } else if (t.kind === "bool") {
              host.declare(`declare ptr @scr_async_gen_return_bool(ptr, i1 zeroext)`);
              call = `call ptr @scr_async_gen_return_bool(ptr ${g.name}, i1 ${a.name})`;
            } else {
              host.declare(`declare ptr @scr_async_gen_return_ref(ptr, ptr, ptr)`);
              call = `call ptr @scr_async_gen_return_ref(ptr ${g.name}, ptr ${a.name}, ptr ${vAdapters(host.shapeHost, t).release})`;
            }
          }
        } else {
          if (e.arg === null)
            throw new InternalCompilerError(
              "llvm emitter bug: async genResume throw with no payload",
            );
          const a = host.emitExpr(e.arg);
          if (isRefCounted(e.arg.type)) host.moveTemp(a);
          host.emitThrowValue({ name: a.name, type: e.arg.type });
          host.declare(`declare ptr @scr_async_gen_throw(ptr)`);
          call = `call ptr @scr_async_gen_throw(ptr ${g.name})`;
        }
        const p = B.tmp();
        B.line(`${p} = ${call}`);
        return host.own({ name: p, type: e.type });
      }
      if (e.mode === "next") {
        if (e.arg === null) {
          // Valueless resume: an empty IN slot, which the body's yield
          // reads as JS's undefined on a dyn channel.
          host.declare(`declare void @scr_gen_in_none(ptr)`);
          B.line(`call void @scr_gen_in_none(ptr ${g.name})`);
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
              B.line(
                `call void @scr_gen_ret_ref(ptr ${g.name}, ptr ${name}, ptr ${vAdapters(host.shapeHost, t).release})`,
              );
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
        if (e.arg === null)
          throw new InternalCompilerError("llvm emitter bug: genResume throw with no payload");
        const a = host.emitExpr(e.arg);
        if (isRefCounted(e.arg.type)) host.moveTemp(a); // the cell takes ownership
        host.emitThrowValue({ name: a.name, type: e.arg.type });
        host.declare(`declare void @scr_gen_resume_throw(ptr)`);
        B.line(`call void @scr_gen_resume_throw(ptr ${g.name})`);
      }
      const helper = host.genResultThunkFor(genT, resultT);
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
      // `await f(...)` of a direct async call: the call and the await go
      // through f's await-call entry, which returns the awaited value
      // (owned, with the pending check done by the call emission).
      // An adopting await (the operand of an async function's `return`)
      // first takes the turn of the then job that JS's promise resolution
      // queues for a returned promise; a direct call folds that turn into
      // the callee's adopting entry. Past finally regions, the return has
      // already produced the promise (adoptedOperand).
      const adopted = e.adopt === true ? host.takeAdoptedOperand() : null;
      // A stackless coroutine body runs a never-suspending callee in place
      // and takes the await's turn itself.
      if (adopted === null && e.value.kind === "call" && host.inlineAwaitEligible(e.value.callee)) {
        const callee = host.fnByName.get(e.value.callee)!;
        if (
          typeEquals(callee.returnType, e.type) &&
          !host.callLifetimes.borrowed.has(e.value.callee)
        ) {
          return host.emitCoroInlineAwait(e.value, e.adopt === true);
        }
      }
      if (adopted === null && e.value.kind === "call" && host.awaitCallEligible(e.value.callee)) {
        const callee = host.fnByName.get(e.value.callee)!;
        if (
          typeEquals(callee.returnType, e.type) &&
          !host.callLifetimes.borrowed.has(e.value.callee)
        ) {
          return host.emitAwaitedCall(e.value, e.adopt === true);
        }
      }
      const pr = adopted ?? host.emitExpr(e.value);
      if (e.adopt === true) {
        if (host.coroAwait) host.emitCoroAwait(null);
        else {
          host.declare(`declare void @scr_await_hop()`);
          B.line(`call void @scr_await_hop()`);
        }
      }
      if (host.coroAwait) host.emitCoroAwait(pr.name);
      if (e.type.kind === "void") {
        const voidAwait = host.awaitResultFn("void");
        host.declare(`declare void @${voidAwait}(ptr)`);
        B.line(`call void @${voidAwait}(ptr ${pr.name})`);
        host.emitPendingCheck();
        return { name: "", type: e.type };
      }
      const t = B.tmp();
      if (e.type.kind === "f64" || e.type.kind === "date") {
        const f64Await = host.awaitResultFn("f64");
        host.declare(`declare double @${f64Await}(ptr)`);
        B.line(`${t} = call double @${f64Await}(ptr ${pr.name})`);
      } else if (e.type.kind === "bool") {
        const boolAwait = host.awaitResultFn("bool");
        host.declare(`declare zeroext i1 @${boolAwait}(ptr)`);
        B.line(`${t} = call zeroext i1 @${boolAwait}(ptr ${pr.name})`);
      } else if (e.type.kind === "string") {
        const strAwait = host.awaitResultFn("str");
        host.declare(`declare ptr @${strAwait}(ptr)`);
        B.line(`${t} = call ptr @${strAwait}(ptr ${pr.name})`);
      } else {
        const refAwait = host.awaitResultFn("ref");
        host.declare(`declare ptr @${refAwait}(ptr)`);
        B.line(`${t} = call ptr @${refAwait}(ptr ${pr.name})`);
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
      if (e.value.type.kind !== "union")
        throw new InternalCompilerError("llvm emitter bug: awaitUnion of a non-union");
      const def = host.unionsById.get(e.value.type.unionId);
      const promiseArm = def?.arms[e.promiseTag];
      if (!def || promiseArm?.kind !== "promise") {
        throw new InternalCompilerError("llvm emitter bug: awaitUnion arm is not a promise");
      }
      const inner = promiseArm.inner;
      const u = host.emitExpr(e.value);
      const tag = host.unionTag(u.name, def.id);
      const isP = B.tmp();
      B.line(`${isP} = icmp eq i32 ${tag}, ${e.promiseTag}`);
      host.declare(`declare void @scr_await_hop()`);
      if (e.type.kind === "void") {
        const lp = B.newLabel("au.p");
        const lh = B.newLabel("au.h");
        const lj = B.newLabel("au.j");
        B.condBr(isP, lp, lh);
        B.startBlock(lp);
        const voidAwait = host.awaitResultFn("void");
        host.declare(`declare void @${voidAwait}(ptr)`);
        {
          const promise = host.unionPeek(u.name, def.id);
          if (host.coroAwait) host.emitCoroAwait(promise);
          B.line(`call void @${voidAwait}(ptr ${promise})`);
        }
        B.br(lj);
        B.startBlock(lh);
        if (host.coroAwait) host.emitCoroAwait(null);
        else B.line(`call void @scr_await_hop()`);
        B.br(lj);
        B.startBlock(lj);
        host.emitPendingCheck();
        return { name: "", type: e.type };
      }
      if (e.type.kind !== "union") {
        throw new InternalCompilerError(
          "llvm emitter bug: awaitUnion result is neither void nor a union",
        );
      }
      const resUnionId = e.type.unionId;
      const resDef = host.unionsById.get(resUnionId);
      if (!resDef)
        throw new InternalCompilerError("llvm emitter bug: awaitUnion result union unknown");
      const resTagOf = (arm: IrType): number => {
        const t = resDef.arms.findIndex((a) => typeEquals(a, arm));
        if (t < 0)
          throw new InternalCompilerError("llvm emitter bug: awaitUnion result arm missing");
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
      const peek = host.unionPeek(u.name, def.id);
      if (host.coroAwait) host.emitCoroAwait(peek);
      let awaited: LlValue;
      if (inner.kind === "f64" || inner.kind === "date") {
        const f64Await = host.awaitResultFn("f64");
        host.declare(`declare double @${f64Await}(ptr)`);
        const x = B.tmp();
        B.line(`${x} = call double @${f64Await}(ptr ${peek})`);
        awaited = { name: x, type: inner };
      } else if (inner.kind === "bool") {
        const boolAwait = host.awaitResultFn("bool");
        host.declare(`declare zeroext i1 @${boolAwait}(ptr)`);
        const x = B.tmp();
        B.line(`${x} = call zeroext i1 @${boolAwait}(ptr ${peek})`);
        awaited = { name: x, type: inner };
      } else if (inner.kind === "string") {
        const strAwait = host.awaitResultFn("str");
        host.declare(`declare ptr @${strAwait}(ptr)`);
        const x = B.tmp();
        B.line(`${x} = call ptr @${strAwait}(ptr ${peek})`);
        awaited = { name: x, type: inner };
      } else {
        const refAwait = host.awaitResultFn("ref");
        host.declare(`declare ptr @${refAwait}(ptr)`);
        const x = B.tmp();
        B.line(`${x} = call ptr @${refAwait}(ptr ${peek})`);
        awaited = { name: x, type: inner };
      }
      B.line(`store ptr ${host.unionNewOwned(resUnionId, innerTag, awaited)}, ptr ${slot}`);
      B.br(lj);
      B.startBlock(lh);
      if (host.coroAwait) host.emitCoroAwait(null);
      else B.line(`call void @scr_await_hop()`);
      const unitTags = def.arms.flatMap((a, i) => (isUnitType(a) ? [i] : []));
      if (unitTags.length === 1) {
        B.line(
          `store ptr ${host.unitInstanceRef(resUnionId, resTagOf(def.arms[unitTags[0]!]!))}, ptr ${slot}`,
        );
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
          B.line(
            `store ptr ${host.unitInstanceRef(resUnionId, resTagOf(def.arms[t2]!))}, ptr ${slot}`,
          );
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
      if (e.type.kind !== "promise")
        throw new InternalCompilerError("llvm emitter bug: newPromise type");
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
      const kindNums: Partial<Record<IrType["kind"], number>> = {
        f64: 0,
        date: 0,
        bool: 1,
        string: 2,
        void: 3,
      };
      const kindNum = kindNums[inner.kind];
      if (kindNum !== undefined) {
        host.declare(`declare ptr @scr_make_resolve(ptr, i32)`);
        resolve = B.tmp();
        B.line(`${resolve} = call ptr @scr_make_resolve(ptr ${p}, i32 ${kindNum})`);
      } else {
        host.declare(`declare ptr @scr_make_resolve_fn(ptr, ptr)`);
        resolve = B.tmp();
        B.line(
          `${resolve} = call ptr @scr_make_resolve_fn(ptr ${p}, ptr @${host.resolveThunkFor(inner)})`,
        );
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
        B.line(
          `call void @scr_promise_run_executor2(ptr ${p}, ptr ${exec2.name}, ptr ${resolve}, ptr ${reject})`,
        );
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
      if (e.type.kind !== "record")
        throw new InternalCompilerError("llvm emitter bug: promiseWithResolvers type");
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
      const kindNums: Partial<Record<IrType["kind"], number>> = {
        f64: 0,
        date: 0,
        bool: 1,
        string: 2,
        void: 3,
      };
      const kindNum = kindNums[inner.kind];
      const resolve = B.tmp();
      if (kindNum !== undefined) {
        host.declare(`declare ptr @scr_make_resolve(ptr, i32)`);
        B.line(`${resolve} = call ptr @scr_make_resolve(ptr ${p}, i32 ${kindNum})`);
      } else {
        host.declare(`declare ptr @scr_make_resolve_fn(ptr, ptr)`);
        B.line(
          `${resolve} = call ptr @scr_make_resolve_fn(ptr ${p}, ptr @${host.resolveThunkFor(inner)})`,
        );
      }
      const reject = B.tmp();
      B.line(`${reject} = call ptr @scr_make_reject(ptr ${p})`);
      const rec = B.tmp();
      B.line(`${rec} = call ptr @${mangleRecordNew(e.type.shapeId)}()`);
      const out = host.own({ name: rec, type: e.type });
      // The three +1s move straight into the fresh record's fields.
      const fields: [string, string][] = [
        ["promise", p],
        ["resolve", resolve],
        ["reject", reject],
      ];
      for (const [field, value] of fields) {
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
