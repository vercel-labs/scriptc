/* Focused LLVM expression emission extracted from emitter.ts. */
import { InternalCompilerError } from "../../errors.js";
import { undefinedArmTag } from "../../ir/analysis.js";
import { canMarshalFuncIntoIsland, IrExpr, IrType, islandCallbackRet, islandPromisePayloadTag, isRefCounted, isUnitType, STRING, typeKey } from "../../ir/ir.js";
import { FN_ATTRS, releaseSym } from "./shapes.js";
import type { LlvmEmitterContext, LlValue } from "./expr-context.js";
import { f64Lit } from "./common.js";

export function emitJsMarshal(host: LlvmEmitterContext, e: IrExpr & { kind: "jsMarshal" }): LlValue {
    const B = host.B;
    const v = host.emitExpr(e.value);
    const simple = (sym: string, argTy: string, fallible: boolean): LlValue => {
      host.declare(`declare ptr @${sym}(${argTy === "i1" ? "i1 zeroext" : argTy})`);
      const t = B.tmp();
      B.line(`${t} = call ptr @${sym}(${argTy} ${v.name})`);
      const out = host.own({ name: t, type: e.type });
      if (fallible) host.emitPendingCheck();
      return out;
    };
    switch (e.value.type.kind) {
      case "f64":
        return simple("scr_jsval_from_f64", "double", false);
      case "bool":
        return simple("scr_jsval_from_bool", "i1", false);
      case "string":
        return simple("scr_jsval_from_str", "ptr", false);
      case "dyn":
        // A CHECKED-DYNAMIC (dyn) value entering the island: deep copy,
        // data kinds only — boxed functions/handles/promises throw the
        // catchable TypeError in the runtime, and a wrapped island value
        // unwraps to the SAME engine value (the identity round trip).
        // The C emitter's rule, mirrored.
        return simple("scr_jsval_from_dyn", "ptr", true);
      case "bytes":
        // A typed array crossing IN: a COPY (the boundary's copy stance).
        return simple("scr_jsval_from_bytes", "ptr", true);
      case "url":
        // A URL crossing IN: an engine URL instance built from href.
        return simple("scr_jsval_from_url", "ptr", true);
      case "promise": {
        // A STATIC promise crossing IN: a real engine thenable settled
        // when the scriptc promise settles (the async-callback return
        // bridge). from_promise takes ownership of a +1 — retain past
        // the borrowed frame temp. The C emitter's rule, mirrored.
        const tag = islandPromisePayloadTag(e.value.type.inner);
        if (!tag) throw new InternalCompilerError("llvm emitter bug: jsMarshal of a promise outside the bridge payload domain");
        const tagN = { void: 0, f64: 1, bool: 2, string: 3, jsval: 4, jsvalArr: 5 }[tag];
        host.declare(`declare ptr @scr_promise_retain(ptr)`);
        host.declare(`declare ptr @scr_jsval_from_promise(ptr, i32)`);
        const pr = B.tmp();
        B.line(`${pr} = call ptr @scr_promise_retain(ptr ${v.name})`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_jsval_from_promise(ptr ${pr}, i32 ${tagN})`);
        const out = host.own({ name: t, type: e.type });
        host.emitPendingCheck();
        return out;
      }
      case "func": {
        // A closure entering the island as a host function: from_closure
        // retains it; the engine's finalizer releases it at teardown. The
        // per-signature adapter gives the runtime one uniform call shape.
        const fn = e.value.type;
        const adapter = canMarshalFuncIntoIsland(fn)
          ? host.islandAdapter(fn.params.length, fn.ret.kind as "void" | "jsval" | "f64" | "bool" | "string")
          : host.islandTypedAdapter(fn);
        host.declare(`declare ptr @scr_jsval_from_closure(ptr, i32, ptr)`);
        // ISLAND-REST closures encode a NEGATIVE arity (the C emitter's
        // rule): the wrapper hands the trailing slot the engine array of
        // the surplus arguments.
        const arity = fn.rest === true && fn.restAbi === "jsval" ? -fn.params.length : fn.params.length;
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_jsval_from_closure(ptr ${v.name}, i32 ${arity}, ptr @${adapter})`);
        return host.own({ name: t, type: e.type });
      }
      default: {
        // JSON-safe composite: deep copy through the emitted serializer
        // and the engine's JSON parser (documented aliasing divergence).
        const helper = host.walkers.jsonWriteHelper(e.value.type);
        host.declare(`declare void @scr_jb_init(ptr)`);
        host.declare(`declare ptr @scr_jb_finish(ptr)`);
        host.declare(`declare ptr @scr_jsval_from_json(ptr)`);
        const buf = B.slot();
        B.entryAllocas.push(`${buf} = alloca %ScrJsonBuf`);
        B.line(`call void @scr_jb_init(ptr ${buf})`);
        B.line(`call void @${helper}(ptr ${buf}, ${host.llType(e.value.type)} ${v.name})`);
        const js = B.tmp();
        B.line(`${js} = call ptr @scr_jb_finish(ptr ${buf})`);
        host.own({ name: js, type: STRING });
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_jsval_from_json(ptr ${js})`);
        const out = host.own({ name: t, type: e.type });
        host.emitPendingCheck();
        return out;
      }
    }
  }

export function emitJsOp(host: LlvmEmitterContext, e: IrExpr & { kind: "jsOp" }): LlValue {
    const B = host.B;
    const args = e.args.map((a) => host.emitExpr(a));
    const a = (i: number): string => args[i]!.name;
    const nameSym = (): string => host.internLiteral(e.name!);
    const fallible = (call: () => string): LlValue => {
      const t = call();
      const out = host.own({ name: t, type: e.type });
      host.emitPendingCheck();
      return out;
    };
    const argPack = (list: string[]): string => {
      if (list.length === 0) return "null";
      const arr = B.slot();
      B.entryAllocas.push(`${arr} = alloca [${list.length} x ptr]`);
      list.forEach((x, i) => {
        const p = B.tmp();
        B.line(`${p} = getelementptr inbounds [${list.length} x ptr], ptr ${arr}, i64 0, i64 ${i}`);
        B.line(`store ptr ${x}, ptr ${p}`);
      });
      return arr;
    };
    const JSOP: Record<string, number> = {
      add: 0, sub: 1, mul: 2, div: 3, mod: 4, pow: 5,
      lt: 6, le: 7, gt: 8, ge: 9, eq: 10, neq: 11,
    };
    switch (e.op) {
      case "add": case "sub": case "mul": case "div": case "mod": case "pow":
        host.declare(`declare ptr @scr_jsval_binop(i32, ptr, ptr)`);
        return fallible(() => {
          const t = B.tmp();
          B.line(`${t} = call ptr @scr_jsval_binop(i32 ${JSOP[e.op]}, ptr ${a(0)}, ptr ${a(1)})`);
          return t;
        });
      case "lt": case "le": case "gt": case "ge": case "eq": case "neq": {
        host.declare(`declare i32 @scr_jsval_cmp(i32, ptr, ptr)`);
        const r = B.tmp();
        B.line(`${r} = call i32 @scr_jsval_cmp(i32 ${JSOP[e.op]}, ptr ${a(0)}, ptr ${a(1)})`);
        const t = B.tmp();
        B.line(`${t} = icmp eq i32 ${r}, 1`);
        const out = { name: t, type: e.type };
        host.emitPendingCheck();
        return out;
      }
      case "neg":
      case "plus": {
        const sym = e.op === "neg" ? "scr_jsval_neg" : "scr_jsval_plus";
        host.declare(`declare ptr @${sym}(ptr)`);
        return fallible(() => {
          const t = B.tmp();
          B.line(`${t} = call ptr @${sym}(ptr ${a(0)})`);
          return t;
        });
      }
      case "truthy":
      case "not": {
        host.declare(`declare i32 @scr_jsval_truthy(ptr)`);
        const r = B.tmp();
        B.line(`${r} = call i32 @scr_jsval_truthy(ptr ${a(0)})`);
        const t = B.tmp();
        B.line(`${t} = icmp ${e.op === "truthy" ? "ne" : "eq"} i32 ${r}, 0`);
        return { name: t, type: e.type };
      }
      case "typeof": {
        host.declare(`declare ptr @scr_jsval_typeof(ptr)`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_jsval_typeof(ptr ${a(0)})`);
        return host.own({ name: t, type: e.type });
      }
      case "toStr":
        host.declare(`declare ptr @scr_jsval_to_str(ptr)`);
        return fallible(() => {
          const t = B.tmp();
          B.line(`${t} = call ptr @scr_jsval_to_str(ptr ${a(0)})`);
          return t;
        });
      case "getProp":
        host.declare(`declare ptr @scr_jsval_get_prop(ptr, ptr)`);
        return fallible(() => {
          const t = B.tmp();
          B.line(`${t} = call ptr @scr_jsval_get_prop(ptr ${a(0)}, ptr ${nameSym()})`);
          return t;
        });
      case "globalGet":
        host.declare(`declare ptr @scr_jsval_global_get(ptr)`);
        return fallible(() => {
          const t = B.tmp();
          B.line(`${t} = call ptr @scr_jsval_global_get(ptr ${nameSym()})`);
          return t;
        });
      case "setProp": {
        host.declare(`declare i32 @scr_jsval_set_prop(ptr, ptr, ptr)`);
        B.line(`${B.tmp()} = call i32 @scr_jsval_set_prop(ptr ${a(0)}, ptr ${nameSym()}, ptr ${a(1)})`);
        host.emitPendingCheck();
        return { name: "", type: e.type };
      }
      case "getIdx":
        host.declare(`declare ptr @scr_jsval_get_idx(ptr, ptr)`);
        return fallible(() => {
          const t = B.tmp();
          B.line(`${t} = call ptr @scr_jsval_get_idx(ptr ${a(0)}, ptr ${a(1)})`);
          return t;
        });
      case "iterNew":
        host.declare(`declare ptr @scr_jsval_iter_new(ptr)`);
        return fallible(() => {
          const t = B.tmp();
          B.line(`${t} = call ptr @scr_jsval_iter_new(ptr ${a(0)})`);
          return t;
        });
      case "setIdx": {
        host.declare(`declare i32 @scr_jsval_set_idx(ptr, ptr, ptr)`);
        B.line(`${B.tmp()} = call i32 @scr_jsval_set_idx(ptr ${a(0)}, ptr ${a(1)}, ptr ${a(2)})`);
        host.emitPendingCheck();
        return { name: "", type: e.type };
      }
      case "callMethod": {
        const pack = argPack(args.slice(1).map((x) => x.name));
        host.declare(`declare ptr @scr_jsval_call_method(ptr, ptr, i32, ptr)`);
        return fallible(() => {
          const t = B.tmp();
          B.line(`${t} = call ptr @scr_jsval_call_method(ptr ${a(0)}, ptr ${nameSym()}, i32 ${args.length - 1}, ptr ${pack})`);
          return t;
        });
      }
      case "optCallMethod": {
        const pack = argPack(args.slice(1).map((x) => x.name));
        host.declare(`declare ptr @scr_jsval_opt_call_method(ptr, ptr, i32, ptr)`);
        return fallible(() => {
          const t = B.tmp();
          B.line(`${t} = call ptr @scr_jsval_opt_call_method(ptr ${a(0)}, ptr ${nameSym()}, i32 ${args.length - 1}, ptr ${pack})`);
          return t;
        });
      }
      case "callFn": {
        const pack = argPack(args.slice(1).map((x) => x.name));
        host.declare(`declare ptr @scr_jsval_call(ptr, i32, ptr)`);
        return fallible(() => {
          const t = B.tmp();
          B.line(`${t} = call ptr @scr_jsval_call(ptr ${a(0)}, i32 ${args.length - 1}, ptr ${pack})`);
          return t;
        });
      }
      case "callFnThis": {
        const pack = argPack(args.slice(2).map((x) => x.name));
        host.declare(`declare ptr @scr_jsval_call_this(ptr, ptr, i32, ptr)`);
        return fallible(() => {
          const t = B.tmp();
          B.line(`${t} = call ptr @scr_jsval_call_this(ptr ${a(0)}, ptr ${a(1)}, i32 ${args.length - 2}, ptr ${pack})`);
          return t;
        });
      }
      case "callSpread": {
        // Spread application (`f(...pre, ...s)`): the prelude helper's
        // real spread syntax — iterator protocols are the engine's own,
        // the guards front-run V8's spread-call TypeError texts (the name
        // literal is the spread expression's spelling).
        host.declare(`declare ptr @scr_jsval_call_spread(ptr, ptr, ptr, ptr)`);
        return fallible(() => {
          const t = B.tmp();
          B.line(`${t} = call ptr @scr_jsval_call_spread(ptr ${a(0)}, ptr ${a(1)}, ptr ${a(2)}, ptr ${nameSym()})`);
          return t;
        });
      }
      case "construct": {
        const pack = argPack(args.slice(1).map((x) => x.name));
        host.declare(`declare ptr @scr_jsval_construct(ptr, i32, ptr)`);
        return fallible(() => {
          const t = B.tmp();
          B.line(`${t} = call ptr @scr_jsval_construct(ptr ${a(0)}, i32 ${args.length - 1}, ptr ${pack})`);
          return t;
        });
      }
      case "objLit": {
        const pack = argPack(args.map((x) => x.name));
        host.declare(`declare ptr @scr_jsval_obj_lit(i32, ptr)`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_jsval_obj_lit(i32 ${args.length / 2}, ptr ${pack})`);
        return host.own({ name: t, type: e.type });
      }
      case "tplStrings": {
        const pack = argPack(args.map((x) => x.name));
        host.declare(`declare ptr @scr_jsval_tpl_strings(i32, ptr)`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_jsval_tpl_strings(i32 ${args.length / 2}, ptr ${pack})`);
        return host.own({ name: t, type: e.type });
      }
      case "objSpread": {
        host.declare(`declare ptr @scr_jsval_obj_spread(ptr, ptr)`);
        return fallible(() => {
          const t = B.tmp();
          B.line(`${t} = call ptr @scr_jsval_obj_spread(ptr ${a(0)}, ptr ${a(1)})`);
          return t;
        });
      }
      case "defineGetter": {
        // Getter completion for an island literal (the C emitter's
        // scr_jsval_define_getter shape): defines key a(1) on obj a(0)
        // as an engine getter invoking a(2); answers the object (+1).
        host.declare(`declare ptr @scr_jsval_define_getter(ptr, ptr, ptr)`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_jsval_define_getter(ptr ${a(0)}, ptr ${a(1)}, ptr ${a(2)})`);
        return host.own({ name: t, type: e.type });
      }
      case "arrLit": {
        const pack = argPack(args.map((x) => x.name));
        host.declare(`declare ptr @scr_jsval_arr_lit(i32, ptr)`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_jsval_arr_lit(i32 ${args.length}, ptr ${pack})`);
        return host.own({ name: t, type: e.type });
      }
      case "instanceOf": {
        // JS_IsInstanceOf through the engine: 1 true, 0 false, -1 threw
        // (Symbol.hasInstance can raise) — the fallible pattern, result
        // narrowed to bool by comparing against 1 (the C emitter's shape).
        host.declare(`declare i32 @scr_jsval_instance_of(ptr, ptr)`);
        return fallible(() => {
          const r = B.tmp();
          B.line(`${r} = call i32 @scr_jsval_instance_of(ptr ${a(0)}, ptr ${a(1)})`);
          const t = B.tmp();
          B.line(`${t} = icmp eq i32 ${r}, 1`);
          return t;
        });
      }
      case "undefLit": {
        host.declare(`declare ptr @scr_jsval_undefined()`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_jsval_undefined()`);
        return host.own({ name: t, type: e.type });
      }
      case "nullLit": {
        host.declare(`declare ptr @scr_jsval_null()`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_jsval_null()`);
        return host.own({ name: t, type: e.type });
      }
      default:
        throw new InternalCompilerError(`llvm emitter bug: jsOp ${e.op satisfies never}`);
    }
  }

export function emitJsExit(host: LlvmEmitterContext, e: IrExpr & { kind: "jsExit" }): LlValue {
    const B = host.B;
    const v = host.emitExpr(e.value);
    switch (e.type.kind) {
      case "f64":
      case "bool": {
        const isF64 = e.type.kind === "f64";
        const sym = isF64 ? "scr_jsval_exit_f64" : "scr_jsval_exit_bool";
        host.declare(`declare i32 @${sym}(ptr, ptr)`);
        const slot = B.slot();
        B.entryAllocas.push(`${slot} = alloca ${isF64 ? "double" : "i8"}`);
        B.line(`store ${isF64 ? `double ${f64Lit(0)}` : "i8 0"}, ptr ${slot}`);
        B.line(`${B.tmp()} = call i32 @${sym}(ptr ${v.name}, ptr ${slot})`);
        host.emitPendingCheck();
        const t = B.tmp();
        if (isF64) {
          B.line(`${t} = load double, ptr ${slot}`);
          return { name: t, type: e.type };
        }
        B.line(`${t} = load i8, ptr ${slot}`);
        const b = B.tmp();
        B.line(`${b} = trunc i8 ${t} to i1`);
        return { name: b, type: e.type };
      }
      case "string": {
        host.declare(`declare ptr @scr_jsval_exit_str(ptr)`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_jsval_exit_str(ptr ${v.name})`);
        const out = host.own({ name: t, type: e.type });
        host.emitPendingCheck();
        return out;
      }
      case "bytes": {
        // Uint8Array exit: kind-checked, copied out (+1).
        host.declare(`declare ptr @scr_jsval_exit_bytes(ptr)`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_jsval_exit_bytes(ptr ${v.name})`);
        const out = host.own({ name: t, type: e.type });
        host.emitPendingCheck();
        return out;
      }
      default: {
        // `any[]`-declared slot: Array.isArray-gated, elements BY
        // REFERENCE (identity crosses; the spine is a snapshot copy).
        // JSON-safe element types keep the round trip below.
        if (e.type.kind === "array" && e.type.elem.kind === "jsval") {
          host.declare(`declare ptr @scr_jsval_exit_jsval_arr(ptr)`);
          const t = B.tmp();
          B.line(`${t} = call ptr @scr_jsval_exit_jsval_arr(ptr ${v.name})`);
          const out = host.own({ name: t, type: e.type });
          host.emitPendingCheck();
          return out;
        }
        // An undefined-armed union target: the engine's undefined takes
        // the undefined arm FIRST (JSON cannot spell it); then null and
        // data ride the round trip into the union's dynCheck like any
        // composite.
        const roundTrip = (): string => {
          host.declare(`declare ptr @scr_jsval_to_json(ptr)`);
          host.declare(`declare ptr @scr_json_parse(ptr)`);
          const js = B.tmp();
          B.line(`${js} = call ptr @scr_jsval_to_json(ptr ${v.name})`);
          host.own({ name: js, type: STRING });
          host.emitPendingCheck();
          const dom = B.tmp();
          B.line(`${dom} = call ptr @scr_json_parse(ptr ${js})`);
          host.own({ name: dom, type: { kind: "dyn" } });
          host.emitPendingCheck();
          const helper = host.dyn.dynCheckHelper(e.type);
          const t = B.tmp();
          B.line(`${t} = call ${host.llType(e.type)} @${helper}(ptr ${dom}, ptr null)`);
          return t;
        };
        const undefTag = e.type.kind === "union" ? undefinedArmTag(e.type, host.unionsById) : -1;
        if (e.type.kind === "union" && undefTag >= 0) {
          host.declare(`declare zeroext i1 @scr_jsval_is_undefined(ptr)`);
          const isU = B.tmp();
          B.line(`${isU} = call zeroext i1 @scr_jsval_is_undefined(ptr ${v.name})`);
          const slot = B.slot();
          B.entryAllocas.push(`${slot} = alloca ptr`);
          const lu = B.newLabel("jx.u");
          const ld = B.newLabel("jx.d");
          const lj = B.newLabel("jx.j");
          B.condBr(isU, lu, ld);
          B.startBlock(lu);
          B.line(`store ptr ${host.unitInstanceRef(e.type.unionId, undefTag)}, ptr ${slot}`);
          B.br(lj);
          B.startBlock(ld);
          host.frames.push([]);
          const unionDef = host.unionsById.get(e.type.unionId);
          const dataArms = unionDef ? unionDef.arms.flatMap((a, i) => (isUnitType(a) ? [] : [{ a, i }])) : [];
          const jsvalArr = dataArms.length === 1 && dataArms[0]!.a.kind === "array" && dataArms[0]!.a.elem.kind === "jsval" ? dataArms[0]! : null;
          let t: string;
          if (jsvalArr) {
            // The `any[] | undefined` defaulted-parameter spelling: the
            // engine array exits BY REFERENCE into the data arm.
            host.declare(`declare ptr @scr_jsval_exit_jsval_arr(ptr)`);
            host.declare(`declare ptr @scr_union_new_ref(i32, ptr, ptr, ptr, ptr)`);
            host.declare(`declare ptr @scr_arr_retain_v(ptr)`);
            host.declare(`declare void @scr_arr_release_v(ptr)`);
            const arr = B.tmp();
            B.line(`${arr} = call ptr @scr_jsval_exit_jsval_arr(ptr ${v.name})`);
            host.emitPendingCheck();
            t = B.tmp();
            B.line(`${t} = call ptr @scr_union_new_ref(i32 ${jsvalArr.i}, ptr ${arr}, ptr @scr_arr_retain_v, ptr @scr_arr_release_v, ptr null)`);
            B.line(`store ptr ${t}, ptr ${slot}`);
          } else {
            t = roundTrip();
            host.own({ name: t, type: e.type });
            host.emitPendingCheck();
            host.moveTemp({ name: t, type: e.type });
            B.line(`store ptr ${t}, ptr ${slot}`);
          }
          host.releaseFrame(host.frames.pop()!);
          B.br(lj);
          B.startBlock(lj);
          const out = B.tmp();
          B.line(`${out} = load ptr, ptr ${slot}`);
          return host.own({ name: out, type: e.type });
        }
        const t = roundTrip();
        const out = host.own({ name: t, type: e.type });
        host.emitPendingCheck();
        return out;
      }
    }
  }

export function islandAdapter(host: LlvmEmitterContext, arity: number, retKind: "void" | "jsval" | "f64" | "bool" | "string"): string {
    const tag = { void: "v", jsval: "j", f64: "f", bool: "b", string: "s" }[retKind];
    const key = `ia:${arity}:${tag}`;
    let sym = host.resolveThunks.get(key);
    if (sym) return sym;
    sym = `sc_ia_${arity}${tag}`;
    host.resolveThunks.set(key, sym);
    host.declare(`declare ptr @scr_jsval_retain_v(ptr)`);
    const d: string[] = [
      `define internal ptr @${sym}(ptr %c, ptr %argv) ${FN_ATTRS} { ; island host-call adapter (${arity} arg${arity === 1 ? "" : "s"}, ${retKind})`,
      `entry:`,
    ];
    const passed: string[] = ["ptr %c"];
    for (let i = 0; i < arity; i++) {
      d.push(
        `  %ap${i} = getelementptr inbounds ptr, ptr %argv, i64 ${i}`,
        `  %av${i} = load ptr, ptr %ap${i}`,
        `  %ar${i} = call ptr @scr_jsval_retain_v(ptr %av${i})`,
      );
      passed.push(`ptr %ar${i}`);
    }
    d.push(
      `  %fnp = getelementptr inbounds %ScrClosure, ptr %c, i64 0, i32 1`,
      `  %fn = load ptr, ptr %fnp`,
    );
    switch (retKind) {
      case "void":
        d.push(`  call void %fn(${passed.join(", ")})`, `  ret ptr null`);
        break;
      case "jsval":
        d.push(`  %r = call ptr %fn(${passed.join(", ")})`, `  ret ptr %r`);
        break;
      case "f64":
        host.declare(`declare ptr @scr_jsval_from_f64(double)`);
        d.push(
          `  %r = call double %fn(${passed.join(", ")})`,
          `  %j = call ptr @scr_jsval_from_f64(double %r)`,
          `  ret ptr %j`,
        );
        break;
      case "bool":
        host.declare(`declare ptr @scr_jsval_from_bool(i1 zeroext)`);
        d.push(
          `  %r = call i1 %fn(${passed.join(", ")})`,
          `  %j = call ptr @scr_jsval_from_bool(i1 %r)`,
          `  ret ptr %j`,
        );
        break;
      case "string":
        // The closure's +1 string marshals in, then releases. NULL is the
        // throw-path dummy — the wrapper reverse-bridges the pending
        // exception.
        host.declare(`declare ptr @scr_jsval_from_str(ptr)`);
        host.declare(`declare void @scr_str_release(ptr)`);
        d.push(
          `  %r = call ptr %fn(${passed.join(", ")})`,
          `  %isnull = icmp eq ptr %r, null`,
          `  br i1 %isnull, label %bad, label %ok`,
          `bad:`,
          `  ret ptr null`,
          `ok:`,
          `  %j = call ptr @scr_jsval_from_str(ptr %r)`,
          `  call void @scr_str_release(ptr %r)`,
          `  ret ptr %j`,
        );
        break;
    }
    d.push(`}`, ``);
    host.resolveThunkDefs.push(...d);
    return sym;
  }

export function islandTypedAdapter(host: LlvmEmitterContext, fn: IrType & { kind: "func" }): string {
    const ret = islandCallbackRet(fn.ret, (id) => host.recordsById.get(id), (id) => host.unionsById.get(id));
    if (!ret) throw new InternalCompilerError("llvm emitter bug: typed island adapter with unsupported return");
    const key = `ita:${fn.params.map((p) => typeKey(p)).join(",")}=>${ret.async ? "P:" : ""}${ret.tag}`;
    let sym = host.resolveThunks.get(key);
    if (sym) return sym;
    sym = `sc_ita_${host.resolveThunks.size}`;
    host.resolveThunks.set(key, sym);
    const d: string[] = [
      `define internal ptr @${sym}(ptr %c, ptr %argv) ${FN_ATTRS} { ; typed island host-call adapter: ${key}`,
      `entry:`,
    ];
    // One slot per param: scalars hold the converted value; refs start
    // NULL so the convfail path can release NULL-tolerantly. Unit-arm
    // instances are immortal — their release is a no-op.
    const slotTy: string[] = [];
    fn.params.forEach((p, i) => {
      const ty = host.llType(p);
      const st = ty === "double" ? "double" : ty === "i1" ? "i8" : "ptr";
      slotTy.push(st);
      d.push(`  %sl${i} = alloca ${st}`);
      d.push(`  store ${st} ${st === "double" ? f64Lit(0) : st === "i8" ? "0" : "null"}, ptr %sl${i}`);
    });
    let canFail = false;
    const cleanup: string[] = [];
    fn.params.forEach((p, i) => {
      if (isRefCounted(p)) {
        cleanup.push(
          `  %cf${i} = load ptr, ptr %sl${i}`,
          `  call void ${releaseSym(host, p)}(ptr %cf${i})`,
        );
      }
    });
    let blk = 0;
    const failCheckPtr = (val: string): void => {
      // NULL result → convfail.
      canFail = true;
      const b = blk++;
      d.push(
        `  %cn${b} = icmp eq ptr ${val}, null`,
        `  br i1 %cn${b}, label %convfail, label %cont${b}`,
        `cont${b}:`,
      );
    };
    host.declare(`declare zeroext i1 @scr_exc_pending()`);
    fn.params.forEach((p, i) => {
      d.push(`  %ap${i} = getelementptr inbounds ptr, ptr %argv, i64 ${i}`, `  %av${i} = load ptr, ptr %ap${i}`);
      switch (p.kind) {
        case "jsval":
          host.declare(`declare ptr @scr_jsval_retain_v(ptr)`);
          d.push(`  %jr${i} = call ptr @scr_jsval_retain_v(ptr %av${i})`, `  store ptr %jr${i}, ptr %sl${i}`);
          break;
        case "f64": {
          canFail = true;
          host.declare(`declare i32 @scr_jsval_exit_f64(ptr, ptr)`);
          const b = blk++;
          d.push(
            `  %fx${i} = call i32 @scr_jsval_exit_f64(ptr %av${i}, ptr %sl${i})`,
            `  %fk${i} = icmp eq i32 %fx${i}, 0`,
            `  br i1 %fk${i}, label %convfail, label %cont${b}`,
            `cont${b}:`,
          );
          break;
        }
        case "bool": {
          canFail = true;
          host.declare(`declare i32 @scr_jsval_exit_bool(ptr, ptr)`);
          const b = blk++;
          d.push(
            `  %bx${i} = call i32 @scr_jsval_exit_bool(ptr %av${i}, ptr %sl${i})`,
            `  %bk${i} = icmp eq i32 %bx${i}, 0`,
            `  br i1 %bk${i}, label %convfail, label %cont${b}`,
            `cont${b}:`,
          );
          break;
        }
        case "string": {
          host.declare(`declare ptr @scr_jsval_exit_str(ptr)`);
          d.push(`  %sx${i} = call ptr @scr_jsval_exit_str(ptr %av${i})`);
          failCheckPtr(`%sx${i}`);
          d.push(`  store ptr %sx${i}, ptr %sl${i}`);
          break;
        }
        case "object": {
          // The %Error callback param (the EventEmitter-style boundary):
          // the boundary-thunk extraction rebuilds the native error from
          // the engine argument — a real engine Error or the %error-
          // encoded data object. NULL = the catchable TypeError pending.
          if (p.className !== "%Error") {
            throw new InternalCompilerError(`llvm emitter bug: typed island adapter param of class ${p.className}`);
          }
          host.declare(`declare ptr @scr_error_from_jsval(ptr)`);
          d.push(`  ${`%ev${i}`} = call ptr @scr_error_from_jsval(ptr %av${i})`);
          failCheckPtr(`%ev${i}`);
          d.push(`  store ptr %ev${i}, ptr %sl${i}`);
          break;
        }
        default: {
          canFail = true;
          host.declare(`declare ptr @scr_jsval_to_json(ptr)`);
          host.declare(`declare ptr @scr_json_parse(ptr)`);
          host.declare(`declare void @scr_str_release(ptr)`);
          host.declare(`declare void @scr_dyn_release(ptr)`);
          const utag = p.kind === "union" ? undefinedArmTag(p, host.unionsById) : -1;
          const b = blk++;
          if (p.kind === "union" && utag >= 0) {
            host.declare(`declare zeroext i1 @scr_jsval_is_undefined(ptr)`);
            d.push(
              `  %iu${i} = call zeroext i1 @scr_jsval_is_undefined(ptr %av${i})`,
              `  br i1 %iu${i}, label %undef${b}, label %conv${b}`,
              `undef${b}:`,
              `  store ptr ${host.unitInstanceRef(p.unionId, utag)}, ptr %sl${i} ; absent/undefined argument -> the undefined arm`,
              `  br label %cont${b}`,
              `conv${b}:`,
            );
          }
          d.push(`  %tj${i} = call ptr @scr_jsval_to_json(ptr %av${i})`);
          const b2 = blk++;
          d.push(
            `  %tjn${i} = icmp eq ptr %tj${i}, null`,
            `  br i1 %tjn${i}, label %convfail, label %cont${b2}`,
            `cont${b2}:`,
            `  %dp${i} = call ptr @scr_json_parse(ptr %tj${i})`,
            `  call void @scr_str_release(ptr %tj${i})`,
          );
          const b3 = blk++;
          d.push(
            `  %dpn${i} = icmp eq ptr %dp${i}, null`,
            `  br i1 %dpn${i}, label %convfail, label %cont${b3}`,
            `cont${b3}:`,
            `  %cv${i} = call ${host.llType(p)} @${host.dyn.dynCheckHelper(p)}(ptr %dp${i}, ptr null)`,
            `  call void @scr_dyn_release(ptr %dp${i})`,
            `  %pe${i} = call zeroext i1 @scr_exc_pending()`,
          );
          const b4 = blk++;
          d.push(
            `  br i1 %pe${i}, label %convfail, label %cont${b4}`,
            `cont${b4}:`,
            `  store ${host.llType(p)} %cv${i}, ptr %sl${i}`,
          );
          if (p.kind === "union" && utag >= 0) d.push(`  br label %cont${b}`, `cont${b}:`);
        }
      }
    });
    // The call over the converted slots (each moves into the callee).
    const passed = ["ptr %c"];
    fn.params.forEach((p, i) => {
      const ty = host.llType(p);
      if (ty === "i1") {
        d.push(`  %ld${i} = load i8, ptr %sl${i}`, `  %lb${i} = trunc i8 %ld${i} to i1`);
        passed.push(`i1 %lb${i}`);
      } else {
        d.push(`  %ld${i} = load ${ty}, ptr %sl${i}`);
        passed.push(`${ty} %ld${i}`);
      }
    });
    d.push(
      `  %fnp = getelementptr inbounds %ScrClosure, ptr %c, i64 0, i32 1`,
      `  %fn = load ptr, ptr %fnp`,
    );
    if (ret.async) {
      // The closure returns a +1 ScrPromise; from_promise takes ownership.
      const tagN = { void: 0, f64: 1, bool: 2, string: 3, jsval: 4, json: 0, dyn: 0 }[ret.tag];
      host.declare(`declare ptr @scr_jsval_from_promise(ptr, i32)`);
      d.push(
        `  %pr = call ptr %fn(${passed.join(", ")})`,
        `  %prn = icmp eq ptr %pr, null`,
        `  br i1 %prn, label %pnull, label %pok`,
        `pnull:`,
        `  ret ptr null`,
        `pok:`,
        `  %pj = call ptr @scr_jsval_from_promise(ptr %pr, i32 ${tagN})`,
        `  ret ptr %pj`,
      );
    } else {
      switch (ret.tag) {
        case "void":
          d.push(`  call void %fn(${passed.join(", ")})`, `  ret ptr null`);
          break;
        case "jsval":
          d.push(`  %r = call ptr %fn(${passed.join(", ")})`, `  ret ptr %r`);
          break;
        case "f64":
          host.declare(`declare ptr @scr_jsval_from_f64(double)`);
          d.push(
            `  %r = call double %fn(${passed.join(", ")})`,
            `  %j = call ptr @scr_jsval_from_f64(double %r)`,
            `  ret ptr %j`,
          );
          break;
        case "bool":
          host.declare(`declare ptr @scr_jsval_from_bool(i1 zeroext)`);
          d.push(
            `  %r = call i1 %fn(${passed.join(", ")})`,
            `  %j = call ptr @scr_jsval_from_bool(i1 %r)`,
            `  ret ptr %j`,
          );
          break;
        case "string":
          host.declare(`declare ptr @scr_jsval_from_str(ptr)`);
          host.declare(`declare void @scr_str_release(ptr)`);
          d.push(
            `  %r = call ptr %fn(${passed.join(", ")})`,
            `  %rn = icmp eq ptr %r, null`,
            `  br i1 %rn, label %snull, label %sok`,
            `snull:`,
            `  ret ptr null`,
            `sok:`,
            `  %j = call ptr @scr_jsval_from_str(ptr %r)`,
            `  call void @scr_str_release(ptr %r)`,
            `  ret ptr %j`,
          );
          break;
        case "dyn":
          // A checked-dynamic (+1 dyn) result: deep copy into the engine
          // (the jsMarshal dyn rule); NULL is the throw-path dummy.
          host.declare(`declare ptr @scr_jsval_from_dyn(ptr)`);
          host.declare(`declare void @scr_dyn_release(ptr)`);
          d.push(
            `  %r = call ptr %fn(${passed.join(", ")})`,
            `  %rn = icmp eq ptr %r, null`,
            `  br i1 %rn, label %dnull, label %dok`,
            `dnull:`,
            `  ret ptr null`,
            `dok:`,
            `  %j = call ptr @scr_jsval_from_dyn(ptr %r)`,
            `  call void @scr_dyn_release(ptr %r)`,
            `  ret ptr %j`,
          );
          break;
        case "json": {
          // A JSON-safe composite return: the jsMarshal path — the type-
          // directed serializer, then the engine's JSON parser (deep
          // copy). NULL result is the throw-path dummy.
          const helper = host.walkers.jsonWriteHelper(fn.ret);
          host.declare(`declare void @scr_jb_init(ptr)`);
          host.declare(`declare ptr @scr_jb_finish(ptr)`);
          host.declare(`declare ptr @scr_jsval_from_json(ptr)`);
          host.declare(`declare void @scr_str_release(ptr)`);
          d.push(
            `  %jbuf = alloca %ScrJsonBuf`,
            `  %rv = call ${host.llType(fn.ret)} %fn(${passed.join(", ")})`,
            `  %rpend = call zeroext i1 @scr_exc_pending()`,
            `  br i1 %rpend, label %jfail, label %jok`,
            `jfail:`,
            ...(isRefCounted(fn.ret) ? [`  call void ${releaseSym(host, fn.ret)}(${host.llType(fn.ret)} %rv)`] : []),
            `  ret ptr null`,
            `jok:`,
            `  call void @scr_jb_init(ptr %jbuf)`,
            `  call void @${helper}(ptr %jbuf, ${host.llType(fn.ret)} %rv)`,
            ...(isRefCounted(fn.ret) ? [`  call void ${releaseSym(host, fn.ret)}(${host.llType(fn.ret)} %rv)`] : []),
            `  %rj = call ptr @scr_jb_finish(ptr %jbuf)`,
            `  %j = call ptr @scr_jsval_from_json(ptr %rj)`,
            `  call void @scr_str_release(ptr %rj)`,
            `  ret ptr %j`,
          );
          break;
        }
      }
    }
    if (canFail) {
      d.push(
        `convfail:`,
        // Params already converted release here (NULL-tolerant; unit-arm
        // instances are immortal — their release is a no-op). The pending
        // TypeError reverse-bridges in the wrapper.
        ...cleanup,
        `  ret ptr null`,
      );
    }
    d.push(`}`, ``);
    host.resolveThunkDefs.push(...d);
    return sym;
  }
