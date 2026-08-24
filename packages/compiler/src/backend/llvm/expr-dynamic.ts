/* Focused LLVM expression emission extracted from emitter.ts. */
import { InternalCompilerError } from "../../errors.js";
import { streamTypedRefEligible } from "../../ir/analysis.js";
import { DYN, isRefCounted, isUnitType, typeEquals, typeKey } from "../../ir/ir.js";
import { DYN_KIND } from "./dyn.js";
import { elemAccess, vAdapters } from "./shapes.js";
import { LlvmUnsupportedError } from "./unsupported.js";
import type { LlvmEmitterContext, ExprOf, LlValue } from "./expr-context.js";

export function emitDynamicExpr(host: LlvmEmitterContext, e: ExprOf<"dynFrom" | "dynFromJsval" | "dynCall" | "dynInvoke" | "dynArrLit" | "dynObjLit" | "unionWrap" | "unionNarrow" | "unionDisc" | "unionKeyGet" | "unionIsTag" | "dynKeyGet" | "dynHasKey" | "dynScalarEq" | "dynTest" | "unionEq" | "unionFuncEq" | "caughtTest" | "caughtCheck" | "caughtNarrow" | "caughtToDyn">): LlValue {
    const B = host.B;
    switch (e.kind) {
      case "dynFrom": {
        // Static value → fresh dyn tree (+1) through the interned per-type
        // converter; the operand stays borrowed (frame-released as usual).
        // Bare unit literals (an `undefined`/`null` stored under an
        // `unknown` index signature) are the dyn unit values directly.
        if (e.value.kind === "unitLit") {
          const t = B.tmp();
          if (e.value.unit === "undefined") {
            host.declare(`declare ptr @scr_dyn_undefined()`);
            host.declare(`declare ptr @scr_dyn_retain_v(ptr)`);
            const u = B.tmp();
            B.line(`${u} = call ptr @scr_dyn_undefined()`);
            B.line(`${t} = call ptr @scr_dyn_retain_v(ptr ${u})`);
          } else {
            host.declare(`declare ptr @scr_dyn_new_null()`);
            B.line(`${t} = call ptr @scr_dyn_new_null()`);
          }
          return host.own({ name: t, type: e.type });
        }
        const v = host.emitExpr(e.value);
        if (e.liveRef) {
          if (v.type.kind === "union") {
            const adapter = host.liveDynUnionRefAdapter(v.type);
            const boxed = B.tmp();
            B.line(`${boxed} = call ptr @${adapter}(ptr ${v.name})`);
            return host.own({ name: boxed, type: e.type });
          }
          if (!streamTypedRefEligible(v.type)) {
            throw new InternalCompilerError(`llvm emitter bug: live dyn ref of ${typeKey(v.type)}`);
          }
          const key = typeKey(v.type);
          let adapter = host.liveDynRefAdapters.get(key);
          if (!adapter) {
            const prefix = `sc_ldr_${host.liveDynRefAdapters.size}`;
            adapter = host.streamTypedRefMaterializeAdapter(
              v.type,
              { prefix, adapters: new Map() },
              `${prefix}_materialize`,
            );
            host.liveDynRefAdapters.set(key, adapter);
          }
          const rc = vAdapters(host, v.type);
          host.declare(
            `declare ptr @scr_dyn_new_typed_ref(ptr, ptr, ptr, ptr, ${host.sizeType}, ptr, ptr)`,
          );
          const boxed = B.tmp();
          B.line(
            `${boxed} = call ptr @scr_dyn_new_typed_ref(ptr ${v.name}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${host.cstr(key)}, ${host.sizeType} ${Buffer.byteLength(key, "utf8")}, ptr @${adapter.snapshot}, ptr ${adapter.commit})`,
          );
          return host.own({ name: boxed, type: e.type });
        }
        if (v.type.kind === "func") {
          // A closure boxes as the checked-dynamic tree's function kind: retained closure +
          // the per-signature call thunk + the interned signature key. The
          // best-effort name rides along (null when the lowering had none).
          const name =
            e.fnName !== undefined && e.fnName !== "" ? host.cstr(e.fnName) : "null";
          const box = host.dyn.dynFuncBoxHelper(v.type);
          const t = B.tmp();
          B.line(`${t} = call ptr @${box}(ptr ${v.name}, ptr ${name})`);
          return host.own({ name: t, type: e.type });
        }
        const conv = host.dyn.toDynHelper(v.type);
        const valTy = v.type.kind === "f64" ? "double" : v.type.kind === "bool" ? "i1" : "ptr";
        const t = B.tmp();
        B.line(`${t} = call ptr @${conv}(${valTy} ${v.name})`);
        return host.own({ name: t, type: e.type });
      }
      case "dynFromJsval": {
        // Island value → dyn: the by-reference wrap (scr_dyn_from_jsval
        // retains the cell in; engine scalars normalize to native dyn
        // kinds at wrap time). Operand borrowed, result +1, never throws.
        const v = host.emitExpr(e.value);
        host.declare(`declare ptr @scr_dyn_from_jsval(ptr)`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_dyn_from_jsval(ptr ${v.name})`);
        return host.own({ name: t, type: e.type });
      }
      case "dynCall": {
        // Calling a dyn value: args are already dyn (the lowering boxed or
        // converted them); everything is BORROWED by scr_dyn_call — the
        // boxed thunk builds its own typed copies. The callee's source
        // spelling rides along for Node's "<name> is not a function".
        const callee = host.emitExpr(e.callee);
        if (e.spreads !== undefined && e.spreads.length > 0) {
          // The RUNTIME-ARITY form (`f(...args)`): one fresh dyn array
          // collects the arguments left-to-right — plain args move in
          // (push takes ownership), spread args FLATTEN (push_spread
          // retains elements in and throws V8's spread-call TypeError for
          // non-iterable dyn kinds, checked per spread — JS's
          // ArgumentListEvaluation order) — then apply calls through the
          // array's elements (borrowed, exactly scr_dyn_call).
          host.declare(`declare ptr @scr_dyn_new_arr()`);
          host.declare(`declare void @scr_dyn_arr_push(ptr, ptr)`);
          host.declare(`declare void @scr_dyn_arr_push_spread(ptr, ptr, ptr)`);
          host.declare(`declare ptr @scr_dyn_apply(ptr, ptr, ptr)`);
          const spreadAt = new Map(e.spreads.map((s) => [s.arg, s.what]));
          const pack = B.tmp();
          B.line(`${pack} = call ptr @scr_dyn_new_arr()`);
          host.own({ name: pack, type: DYN });
          e.args.forEach((a, i) => {
            const v = host.emitExpr(a);
            const spreadWhat = spreadAt.get(i);
            if (spreadWhat !== undefined) {
              B.line(`call void @scr_dyn_arr_push_spread(ptr ${pack}, ptr ${v.name}, ptr ${host.cstr(spreadWhat)})`);
              host.emitPendingCheck();
            } else {
              host.moveTemp(v);
              B.line(`call void @scr_dyn_arr_push(ptr ${pack}, ptr ${v.name})`);
            }
          });
          const t = B.tmp();
          B.line(`${t} = call ptr @scr_dyn_apply(ptr ${callee.name}, ptr ${pack}, ptr ${host.cstr(e.calleeName)})`);
          const out = host.own({ name: t, type: e.type });
          host.emitPendingCheck();
          return out;
        }
        const args = e.args.map((a) => host.emitExpr(a));
        let argsPtr = "null";
        if (args.length > 0) {
          const arr = B.slot();
          B.entryAllocas.push(`${arr} = alloca [${args.length} x ptr]`);
          args.forEach((a, i) => {
            const p = B.tmp();
            B.line(`${p} = getelementptr inbounds [${args.length} x ptr], ptr ${arr}, i64 0, ${host.sizeType} ${i}`);
            B.line(`store ptr ${a.name}, ptr ${p}`);
          });
          argsPtr = arr;
        }
        host.declare(`declare ptr @scr_dyn_call(ptr, ptr, ${host.sizeType}, ptr)`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_dyn_call(ptr ${callee.name}, ptr ${argsPtr}, ${host.sizeType} ${args.length}, ptr ${host.cstr(e.calleeName)})`);
        const out = host.own({ name: t, type: e.type });
        host.emitPendingCheck();
        return out;
      }
      case "dynInvoke": {
        // Prototype-method dispatch on a dyn receiver: everything is
        // BORROWED by scr_dyn_invoke; the result is owned and may ride a
        // pending exception.
        const recv = host.emitExpr(e.recv);
        const args = e.args.map((a) => host.emitExpr(a));
        let argsPtr = "null";
        if (args.length > 0) {
          const arr = B.slot();
          B.entryAllocas.push(`${arr} = alloca [${args.length} x ptr]`);
          args.forEach((a, i) => {
            const p = B.tmp();
            B.line(`${p} = getelementptr inbounds [${args.length} x ptr], ptr ${arr}, i64 0, ${host.sizeType} ${i}`);
            B.line(`store ptr ${a.name}, ptr ${p}`);
          });
          argsPtr = arr;
        }
        host.declare(`declare ptr @scr_dyn_invoke(ptr, ptr, ptr, ${host.sizeType}, ptr)`);
        const t = B.tmp();
        B.line(
          `${t} = call ptr @scr_dyn_invoke(ptr ${recv.name}, ptr ${host.cstr(e.method)}, ptr ${argsPtr}, ${host.sizeType} ${args.length}, ptr ${host.cstr(e.calleeName)})`,
        );
        const out = host.own({ name: t, type: e.type });
        host.emitPendingCheck();
        return out;
      }
      case "dynArrLit": {
        // A dyn array built element-by-element: ownership of each dyn
        // element MOVES into the array (scr_dyn_arr_push's contract).
        host.declare(`declare ptr @scr_dyn_new_arr()`);
        host.declare(`declare void @scr_dyn_arr_push(ptr, ptr)`);
        const arr = B.tmp();
        B.line(`${arr} = call ptr @scr_dyn_new_arr()`);
        const out = host.own({ name: arr, type: e.type });
        for (const el of e.elems) {
          const v = host.emitExpr(el);
          host.moveTemp(v);
          B.line(`call void @scr_dyn_arr_push(ptr ${arr}, ptr ${v.name})`);
        }
        return out;
      }
      case "dynObjLit": {
        // A dyn object built member-by-member: key then value, source
        // order. scr_dyn_key_set BORROWS all three (the member retains the
        // value in); the receiver is a fresh OBJ, so the non-object throw
        // paths are unreachable here.
        host.declare(`declare ptr @scr_dyn_new_obj()`);
        host.declare(`declare void @scr_dyn_key_set(ptr, ptr, ptr)`);
        const obj = B.tmp();
        B.line(`${obj} = call ptr @scr_dyn_new_obj()`);
        const out = host.own({ name: obj, type: e.type });
        for (const f of e.fields ?? []) {
          const k = host.emitExpr(f.key);
          const v = host.emitExpr(f.value);
          B.line(`call void @scr_dyn_key_set(ptr ${obj}, ptr ${k.name}, ptr ${v.name})`);
        }
        return out;
      }
      case "unionWrap": {
        // Construct a fresh immutable tagged box. Ownership of a refcounted
        // payload MOVES into the union; scalars ride the slot. Unit arms
        // carry NO payload: every wrap yields THE interned immortal
        // instance for this (union, tag) — no allocation, and the frame's
        // release is a no-op (rc == SIZE_MAX).
        const arm = e.value.type;
        if (isUnitType(arm)) {
          return host.own({ name: host.unitInstanceRef(e.unionId, e.tag), type: e.type });
        }
        // A VOID payload (a void call wrapping into an undefined arm):
        // evaluate for effects, produce the interned unit instance.
        if (arm.kind === "void") {
          host.emitExpr(e.value);
          return host.own({ name: host.unitInstanceRef(e.unionId, e.tag), type: e.type });
        }
        const v = host.emitExpr(e.value);
        if (isRefCounted(arm)) host.moveTemp(v);
        return host.own({ name: host.unionNewOwned(e.tag, v), type: e.type });
      }
      case "unionNarrow": {
        // Tag-UNCHECKED payload extraction: the frontend emits this only
        // where tsc's control-flow narrowing proved the tag. Ref payloads
        // come out +1; the union temp itself releases with this
        // statement's frame as usual.
        const u = host.emitExpr(e.value);
        const arm = e.type;
        if (isUnitType(arm)) throw new InternalCompilerError(`llvm emitter bug: unionNarrow to unit arm ${arm.kind}`);
        const v = host.unionExtract(u.name, arm);
        return host.own({ name: v, type: arm });
      }
      case "unionDisc": {
        // Shared-field read `r.kind`: switch on the runtime tag and read
        // the (same-typed) field from the concretely-typed payload.
        // Ref-counted results come out retained (+1), owned by this frame.
        const u = host.emitExpr(e.value);
        const def = host.unionsById.get(e.unionId);
        if (!def) throw new InternalCompilerError(`llvm emitter bug: unionDisc of unknown union ${e.unionId}`);
        const ty = host.llType(e.type);
        const slot = B.slot();
        B.entryAllocas.push(`${slot} = alloca ${ty}`);
        const join = B.newLabel("ud.j");
        host.unionTagSwitch(u.name, def, (arm) => {
          if (arm.kind !== "record" && arm.kind !== "object") {
            throw new LlvmUnsupportedError(`unionDisc:${arm.kind}`, e.loc);
          }
          const payload = host.unionPeek(u.name);
          const { ptr, type } =
            arm.kind === "object"
              ? host.classFieldPtr(payload, arm.className, e.field)
              : host.recordFieldPtr(payload, arm.shapeId, e.field);
          const v = host.loadField(ptr, type);
          const value = isRefCounted(e.type) ? host.retainValue(v, e.type) : v;
          B.line(`store ${ty} ${value}, ptr ${slot}`);
          B.br(join);
        });
        B.startBlock(join);
        const t = B.tmp();
        B.line(`${t} = load ${ty}, ptr ${slot}`);
        return host.own({ name: t, type: e.type });
      }
      case "unionKeyGet": {
        // The unionDisc generalization: switch on the runtime tag; each
        // arm answers at the JOIN type — a declared field reads its slot
        // (wrapping an arm-typed answer into the join), an index-signature
        // arm rides the shared keyed-read chain (owned result, missing-key
        // policy included), and a unit arm answers the interned undefined
        // arm (the optional-chain tail's short-circuit value).
        const u = host.emitExpr(e.value);
        const k = host.emitExpr(e.key);
        const def = host.unionsById.get(e.unionId);
        if (!def) throw new InternalCompilerError(`llvm emitter bug: unionKeyGet of unknown union ${e.unionId}`);
        const resultDef = e.type.kind === "union" ? host.unionsById.get(e.type.unionId) : undefined;
        const literal = e.key.kind === "strLit" ? e.key.value : null;
        const ty = host.llType(e.type);
        const slot = B.slot();
        B.entryAllocas.push(`${slot} = alloca ${ty}`);
        const join = B.newLabel("ukg.j");
        host.unionTagSwitch(u.name, def, (arm) => {
          if (isUnitType(arm)) {
            if (e.type.kind === "dyn") {
              // A dyn-typed chain: the unit path is the undefined dyn
              // value — dyn represents undefined directly.
              host.declare(`declare ptr @scr_dyn_undefined()`);
              host.declare(`declare ptr @scr_dyn_retain_v(ptr)`);
              const un = B.tmp();
              const r = B.tmp();
              B.line(`${un} = call ptr @scr_dyn_undefined()`);
              B.line(`${r} = call ptr @scr_dyn_retain_v(ptr ${un})`);
              B.line(`store ptr ${r}, ptr ${slot}`);
              B.br(join);
              return;
            }
            const tag = resultDef?.arms.findIndex((a) => a.kind === "undefinedT") ?? -1;
            if (tag < 0 || e.type.kind !== "union") {
              throw new InternalCompilerError("llvm emitter bug: unionKeyGet unit arm without an undefined result arm");
            }
            B.line(`store ptr ${host.unitInstanceRef(e.type.unionId, tag)}, ptr ${slot}`);
            B.br(join);
            return;
          }
          if (arm.kind === "array") {
            // A NUMBER-keyed element read (the chain-tail form): the
            // runtime getter answers owned (+1 for ref elements); invalid
            // indices trap. The result wraps into the join when unit arms
            // widened it.
            const payload = host.unionPeek(u.name);
            const acc = elemAccess(arm.elem);
            const accTy = acc === "f64" ? "double" : acc === "bool" ? "i1" : "ptr";
            host.declare(`declare ${acc === "bool" ? "zeroext i1" : accTy} @scr_arr_get_${acc}(ptr, double)`);
            const v = B.tmp();
            B.line(`${v} = call ${accTy} @scr_arr_get_${acc}(ptr ${payload}, double ${k.name})`);
            if (typeEquals(arm.elem, e.type)) {
              B.line(`store ${ty} ${v}, ptr ${slot}`);
              B.br(join);
              return;
            }
            const tag = resultDef?.arms.findIndex((a) => typeEquals(a, arm.elem)) ?? -1;
            if (tag < 0 || e.type.kind !== "union" || isUnitType(arm.elem)) {
              throw new InternalCompilerError(`llvm emitter bug: unionKeyGet element ${arm.elem.kind} outside the join`);
            }
            // The element read is already owned (+1) — ownership MOVES
            // into the union box, no extra retain.
            B.line(`store ptr ${host.unionNewOwned(tag, { name: v, type: arm.elem })}, ptr ${slot}`);
            B.br(join);
            return;
          }
          if (arm.kind !== "record") throw new LlvmUnsupportedError(`unionKeyGet:${arm.kind}`, e.loc);
          const shape = host.recordShape(arm.shapeId);
          const payload = host.unionPeek(u.name);
          const declared = literal !== null ? shape.fields.find((f) => f.name === literal) : undefined;
          if (declared) {
            const { ptr, type: ft } = host.recordFieldPtr(payload, arm.shapeId, declared.name);
            const v = host.loadField(ptr, ft);
            if (typeEquals(ft, e.type)) {
              B.line(`store ${ty} ${isRefCounted(ft) ? host.retainValue(v, ft) : v}, ptr ${slot}`);
              B.br(join);
              return;
            }
            const tag = resultDef?.arms.findIndex((a) => typeEquals(a, ft)) ?? -1;
            if (tag < 0 || e.type.kind !== "union" || isUnitType(ft)) {
              throw new InternalCompilerError(`llvm emitter bug: unionKeyGet arm answer ${ft.kind} outside the join`);
            }
            const wrapped =
              ft.kind === "f64" || ft.kind === "bool"
                ? host.unionNewOwned(tag, { name: v, type: ft })
                : host.unionNewOwned(tag, { name: host.retainValue(v, ft), type: ft });
            B.line(`store ptr ${wrapped}, ptr ${slot}`);
            B.br(join);
            return;
          }
          // Index-signature arm (or declared-only shape under a runtime
          // key): the shared keyed-read chain — a literal key naming no
          // declared field touches only the overflow map.
          host.keyedRecordReadInto(
            slot,
            join,
            payload,
            k.name,
            arm.shapeId,
            e.type,
            literal !== null && !!shape.indexValue,
            e.loc,
          );
        });
        B.startBlock(join);
        const t = B.tmp();
        B.line(`${t} = load ${ty}, ptr ${slot}`);
        return host.own({ name: t, type: e.type });
      }
      case "unionIsTag": {
        // A pure tag compare — the box is borrowed, no payload is touched.
        const u = host.emitExpr(e.value);
        const tag = host.unionTag(u.name);
        const t = B.tmp();
        B.line(`${t} = icmp ${e.negated ? "ne" : "eq"} i32 ${tag}, ${e.tag}`);
        return { name: t, type: e.type };
      }
      case "dynKeyGet": {
        // Keyed read on the checked-dynamic tree through the one interned helper — the
        // non-optional form throws JS's TypeError on an undefined/null
        // receiver, and HANDLE receivers can throw the loud unmodeled-
        // property ladder on EITHER form; the result is owned (+1).
        const d = host.emitExpr(e.value);
        const k = host.emitExpr(e.key);
        const helper = host.dyn.dynKeyGetHelper();
        const t = B.tmp();
        B.line(`${t} = call ptr @${helper}(ptr ${d.name}, ptr ${k.name}, i1 ${e.optional ? "true" : "false"})`);
        const out = host.own({ name: t, type: e.type });
        host.emitPendingCheck();
        return out;
      }
      case "dynHasKey": {
        // `"k" in pkg`: a kind-guarded presence answer, computed against
        // the literal key at compile time — no allocation, borrowed box.
        const d = host.emitExpr(e.value);
        const kd = host.dynKind(d.name);
        const slot = B.slot();
        B.entryAllocas.push(`${slot} = alloca i1`);
        B.line(`store i1 false, ptr ${slot}`);
        const lObj = B.newLabel("dhk.o");
        const lArr = B.newLabel("dhk.a");
        const lNotObj = B.newLabel("dhk.no");
        const lj = B.newLabel("dhk.j");
        const isObj = B.tmp();
        B.line(`${isObj} = icmp eq i32 ${kd}, ${DYN_KIND.OBJ}`);
        B.condBr(isObj, lObj, lNotObj);
        B.startBlock(lObj);
        host.declare(`declare ptr @scr_dyn_obj_get(ptr, ptr, ${host.sizeType})`);
        const keyBytes = Buffer.byteLength(e.key, "utf8");
        const m = B.tmp();
        const has = B.tmp();
        B.line(`${m} = call ptr @scr_dyn_obj_get(ptr ${d.name}, ptr ${host.cstr(e.key)}, ${host.sizeType} ${keyBytes})`);
        B.line(`${has} = icmp ne ptr ${m}, null`);
        B.line(`store i1 ${has}, ptr ${slot}`);
        B.br(lj);
        B.startBlock(lNotObj);
        const isArr = B.tmp();
        B.line(`${isArr} = icmp eq i32 ${kd}, ${DYN_KIND.ARR}`);
        const lNotArr = B.newLabel("dhk.na");
        B.condBr(isArr, lArr, lNotArr);
        B.startBlock(lArr);
        if (e.key === "length") {
          B.line(`store i1 true, ptr ${slot}`);
        } else if (/^(0|[1-9][0-9]*)$/.test(e.key) && Number(e.key) <= Number.MAX_SAFE_INTEGER) {
          const lenp = B.tmp();
          const len = B.tmp();
          const inR = B.tmp();
          B.line(`${lenp} = getelementptr inbounds i8, ptr ${d.name}, i64 16 ; ->v.arr.len`);
          B.line(`${len} = load ${host.sizeType}, ptr ${lenp}`);
          B.line(`${inR} = icmp ugt ${host.sizeType} ${len}, ${e.key}`);
          B.line(`store i1 ${inR}, ptr ${slot}`);
        }
        B.br(lj);
        // An ISLAND-held receiver fences loudly (Node asks the real
        // engine object — `false` would be a silent wrong answer); the
        // helper answers false for every other kind, so this arm is a
        // plain unconditional call.
        B.startBlock(lNotArr);
        host.declare(`declare zeroext i1 @scr_dyn_isl_fence(ptr, ptr)`);
        const fenced = B.tmp();
        B.line(`${fenced} = call zeroext i1 @scr_dyn_isl_fence(ptr ${d.name}, ptr ${host.cstr("'in'")})`);
        B.line(`store i1 ${fenced}, ptr ${slot}`);
        B.br(lj);
        B.startBlock(lj);
        const raw = B.tmp();
        B.line(`${raw} = load i1, ptr ${slot}`);
        host.emitPendingCheck();
        if (!e.negated) return { name: raw, type: e.type };
        const neg = B.tmp();
        B.line(`${neg} = xor i1 ${raw}, true`);
        return { name: neg, type: e.type };
      }
      case "dynScalarEq": {
        // dyn vs scalar strict equality: kind test + payload compare.
        // Operands emit in SOURCE order; the dyn side is found by type.
        // Both borrowed, no allocation.
        const l = host.emitExpr(e.left);
        const r = host.emitExpr(e.right);
        const [d, s, st] = e.left.type.kind === "dyn" ? [l, r, e.right.type] : [r, l, e.left.type];
        let test: string;
        if (st.kind === "dyn") {
          // dyn vs dyn: whole-dyn strict equality.
          host.declare(`declare zeroext i1 @scr_dyn_strict_eq(ptr, ptr)`);
          test = B.tmp();
          B.line(`${test} = call zeroext i1 @scr_dyn_strict_eq(ptr ${l.name}, ptr ${r.name})`);
        } else {
          const kd = host.dynKind(d.name);
          const kindOk = B.tmp();
          const wantKind = st.kind === "string" ? DYN_KIND.STR : st.kind === "f64" ? DYN_KIND.NUM : DYN_KIND.BOOL;
          B.line(`${kindOk} = icmp eq i32 ${kd}, ${wantKind}`);
          const slot = B.slot();
          B.entryAllocas.push(`${slot} = alloca i1`);
          B.line(`store i1 false, ptr ${slot}`);
          const lCmp = B.newLabel("dse.c");
          const lj = B.newLabel("dse.j");
          B.condBr(kindOk, lCmp, lj);
          B.startBlock(lCmp);
          const pv = B.tmp();
          const eq = B.tmp();
          if (st.kind === "string") {
            host.declare(`declare zeroext i1 @scr_str_eq(ptr, ptr)`);
            B.line(`${pv} = getelementptr inbounds i8, ptr ${d.name}, i64 16 ; ->v.str`);
            const sv = B.tmp();
            B.line(`${sv} = load ptr, ptr ${pv}`);
            B.line(`${eq} = call zeroext i1 @scr_str_eq(ptr ${sv}, ptr ${s.name})`);
          } else if (st.kind === "f64") {
            B.line(`${pv} = getelementptr inbounds i8, ptr ${d.name}, i64 16 ; ->v.num`);
            const nv = B.tmp();
            B.line(`${nv} = load double, ptr ${pv}`);
            B.line(`${eq} = fcmp oeq double ${nv}, ${s.name}`);
          } else {
            B.line(`${pv} = getelementptr inbounds i8, ptr ${d.name}, i64 16 ; ->v.b`);
            const raw = B.tmp();
            const bv = B.tmp();
            B.line(`${raw} = load i8, ptr ${pv}`);
            B.line(`${bv} = trunc i8 ${raw} to i1`);
            B.line(`${eq} = icmp eq i1 ${bv}, ${s.name}`);
          }
          B.line(`store i1 ${eq}, ptr ${slot}`);
          B.br(lj);
          B.startBlock(lj);
          test = B.tmp();
          B.line(`${test} = load i1, ptr ${slot}`);
        }
        if (!e.negated) return { name: test, type: e.type };
        const neg = B.tmp();
        B.line(`${neg} = xor i1 ${test}, true`);
        return { name: neg, type: e.type };
      }
      case "dynTest": {
        // A pure kind compare on the dyn node — borrowed; only the truthy
        // form also reads a scalar payload (the runtime's ToBoolean).
        const d = host.emitExpr(e.value);
        let test: string;
        if (e.test === "truthy") {
          host.declare(`declare zeroext i1 @scr_dyn_truthy(ptr)`);
          test = B.tmp();
          B.line(`${test} = call zeroext i1 @scr_dyn_truthy(ptr ${d.name})`);
        } else if (e.test === "error") {
          // `u instanceof Error`: the checked-dynamic tree's error encoding — an object
          // carrying the reserved "%error" marker key — or a real engine
          // Error held by reference (the isl helper answers false for
          // every non-JSVAL kind, so the call is unconditional).
          const kd = host.dynKind(d.name);
          const isObj = B.tmp();
          B.line(`${isObj} = icmp eq i32 ${kd}, ${DYN_KIND.OBJ}`);
          const slot = B.slot();
          B.entryAllocas.push(`${slot} = alloca i1`);
          host.declare(`declare zeroext i1 @scr_dyn_isl_is_error(ptr)`);
          const isl = B.tmp();
          B.line(`${isl} = call zeroext i1 @scr_dyn_isl_is_error(ptr ${d.name})`);
          B.line(`store i1 ${isl}, ptr ${slot}`);
          const lObj = B.newLabel("dts.o");
          const lj = B.newLabel("dts.j");
          B.condBr(isObj, lObj, lj);
          B.startBlock(lObj);
          host.declare(`declare ptr @scr_dyn_obj_get(ptr, ptr, ${host.sizeType})`);
          const m = B.tmp();
          const has = B.tmp();
          B.line(`${m} = call ptr @scr_dyn_obj_get(ptr ${d.name}, ptr ${host.cstr("%error")}, ${host.sizeType} 6)`);
          B.line(`${has} = icmp ne ptr ${m}, null`);
          B.line(`store i1 ${has}, ptr ${slot}`);
          B.br(lj);
          B.startBlock(lj);
          test = B.tmp();
          B.line(`${test} = load i1, ptr ${slot}`);
        } else {
          const kd = host.dynKind(d.name);
          const oneOf = (kinds: number[]): string => {
            let acc = "";
            for (const k of kinds) {
              const c = B.tmp();
              B.line(`${c} = icmp eq i32 ${kd}, ${k}`);
              if (acc === "") {
                acc = c;
              } else {
                const o = B.tmp();
                B.line(`${o} = or i1 ${acc}, ${c}`);
                acc = o;
              }
            }
            return acc;
          };
          // ISLAND-held nodes route the tests that depend on the engine's
          // answer through the scr_dyn_isl_* helpers (false on every
          // other kind — the calls stay unconditional and branch-free).
          const orIsl = (acc: string, helper: string, arg?: string): string => {
            host.declare(`declare zeroext i1 @${helper}(ptr${arg !== undefined ? ", ptr" : ""})`);
            const c = B.tmp();
            B.line(`${c} = call zeroext i1 @${helper}(ptr ${d.name}${arg !== undefined ? `, ptr ${arg}` : ""})`);
            const o = B.tmp();
            B.line(`${o} = or i1 ${acc}, ${c}`);
            return o;
          };
          if (e.test === "nullish") {
            test = oneOf([DYN_KIND.UNDEF, DYN_KIND.NULL]);
          } else if (e.test === "object") {
            // `typeof v === "object"`: objects, arrays, bytes, native
            // handles, promises, AND null — engine-held objects by the
            // engine's own typeof.
            test = orIsl(oneOf([DYN_KIND.OBJ, DYN_KIND.ARR, DYN_KIND.BYTES, DYN_KIND.HANDLE, DYN_KIND.PROMISE, DYN_KIND.NULL]), "scr_dyn_isl_typeof_is", host.cstr("object"));
          } else if (e.test === "array") {
            // Array.isArray: the checked-dynamic tree's array kind, or the engine's own
            // answer for an engine-held value.
            test = orIsl(oneOf([DYN_KIND.ARR]), "scr_dyn_isl_is_array");
          } else if (e.test === "function") {
            test = orIsl(oneOf([DYN_KIND.FUNC]), "scr_dyn_isl_typeof_is", host.cstr("function"));
          } else {
            const kindOf: Record<string, number> = {
              string: DYN_KIND.STR,
              number: DYN_KIND.NUM,
              boolean: DYN_KIND.BOOL,
              undefined: DYN_KIND.UNDEF,
              null: DYN_KIND.NULL,
              bytes: DYN_KIND.BYTES,
            };
            test = oneOf([kindOf[e.test]!]);
          }
        }
        if (!e.negated) return { name: test, type: e.type };
        const neg = B.tmp();
        B.line(`${neg} = xor i1 ${test}, true`);
        return { name: neg, type: e.type };
      }
      case "unionEq": {
        // Strict equality of the ARM values (tag compare + per-arm payload
        // compare — the C per-union helper, inlined). Both boxes borrowed.
        const l = host.emitExpr(e.left);
        const r = host.emitExpr(e.right);
        const def = host.unionsById.get(e.unionId);
        if (!def) throw new InternalCompilerError(`llvm emitter bug: equality of unknown union ${e.unionId}`);
        const slot = B.slot();
        B.entryAllocas.push(`${slot} = alloca i1`);
        const join = B.newLabel("ue.j");
        const same = B.newLabel("ue.s");
        const ltag = host.unionTag(l.name);
        const rtag = host.unionTag(r.name);
        const tagEq = B.tmp();
        B.line(`${tagEq} = icmp eq i32 ${ltag}, ${rtag}`);
        B.line(`store i1 false, ptr ${slot}`);
        B.condBr(tagEq, same, join);
        B.startBlock(same);
        host.unionTagSwitch(l.name, def, (arm) => {
          switch (arm.kind) {
            case "undefinedT":
            case "nullT":
              B.line(`store i1 true, ptr ${slot}`);
              break;
            case "f64": {
              host.declare(`declare double @scr_union_get_f64(ptr)`);
              const a = B.tmp();
              const b = B.tmp();
              const t = B.tmp();
              B.line(`${a} = call double @scr_union_get_f64(ptr ${l.name})`);
              B.line(`${b} = call double @scr_union_get_f64(ptr ${r.name})`);
              if (e.sameValue) {
                // Object.is's f64 compare: NaN equals NaN, +0 differs
                // from -0 — the runtime SameValue.
                host.declare(`declare zeroext i1 @scr_num_same_value(double, double)`);
                B.line(`${t} = call zeroext i1 @scr_num_same_value(double ${a}, double ${b})`);
              } else {
                B.line(`${t} = fcmp oeq double ${a}, ${b}`);
              }
              B.line(`store i1 ${t}, ptr ${slot}`);
              break;
            }
            case "bool": {
              host.declare(`declare zeroext i1 @scr_union_get_bool(ptr)`);
              const a = B.tmp();
              const b = B.tmp();
              const t = B.tmp();
              B.line(`${a} = call zeroext i1 @scr_union_get_bool(ptr ${l.name})`);
              B.line(`${b} = call zeroext i1 @scr_union_get_bool(ptr ${r.name})`);
              B.line(`${t} = icmp eq i1 ${a}, ${b}`);
              B.line(`store i1 ${t}, ptr ${slot}`);
              break;
            }
            case "string": {
              host.declare(`declare zeroext i1 @scr_str_eq(ptr, ptr)`);
              const a = host.unionPeek(l.name);
              const b = host.unionPeek(r.name);
              const t = B.tmp();
              B.line(`${t} = call zeroext i1 @scr_str_eq(ptr ${a}, ptr ${b})`);
              B.line(`store i1 ${t}, ptr ${slot}`);
              break;
            }
            default: {
              // Ref arms: pointer identity, exactly JS object equality.
              const a = host.unionPeek(l.name);
              const b = host.unionPeek(r.name);
              const t = B.tmp();
              B.line(`${t} = icmp eq ptr ${a}, ${b} ; ${arm.kind}`);
              B.line(`store i1 ${t}, ptr ${slot}`);
              break;
            }
          }
          B.br(join);
        });
        B.startBlock(join);
        const eq = B.tmp();
        B.line(`${eq} = load i1, ptr ${slot}`);
        if (!e.negated) return { name: eq, type: e.type };
        const t = B.tmp();
        B.line(`${t} = xor i1 ${eq}, true`);
        return { name: t, type: e.type };
      }
      case "unionFuncEq": {
        const u = host.emitExpr(e.union);
        const f = host.emitExpr(e.func);
        const tag = host.unionTag(u.name);
        const tagMatch = B.tmp();
        B.line(`${tagMatch} = icmp eq i32 ${tag}, ${e.tag}`);
        const payload = host.unionPeek(u.name);
        const ptrMatch = B.tmp();
        B.line(`${ptrMatch} = icmp eq ptr ${payload}, ${f.name}`);
        const result = B.tmp();
        B.line(`${result} = and i1 ${tagMatch}, ${ptrMatch}`);
        if (!e.negated) return host.own({ name: result, type: e.type });
        const negated = B.tmp();
        B.line(`${negated} = xor i1 ${result}, true`);
        return host.own({ name: negated, type: e.type });
      }
      case "caughtTest": {
        // Kind-tag tests read the snapshot directly; instanceof compares
        // an OBJ payload's vtable preorder against the class's compile-
        // time interval (false for every other payload kind). Box
        // borrowed. SCR_EXC_STR = 3, SCR_EXC_F64 = 1, SCR_EXC_BOOL = 2.
        const c = host.emitExpr(e.value);
        if (e.test === "instanceof") {
          const target = host.classMetaOf(e.className!);
          host.declare(`declare zeroext i1 @scr_caught_instanceof(ptr, ${host.sizeType}, ${host.sizeType})`);
          const t = B.tmp();
          B.line(`${t} = call zeroext i1 @scr_caught_instanceof(ptr ${c.name}, ${host.sizeType} ${target.pre}, ${host.sizeType} ${target.post})`);
          if (e.negated !== true) return { name: t, type: e.type };
          const n = B.tmp();
          B.line(`${n} = xor i1 ${t}, true`);
          return { name: n, type: e.type };
        }
        const tag = { string: 3, number: 1, boolean: 2 }[e.test];
        const kp = B.tmp();
        const k = B.tmp();
        const t = B.tmp();
        B.line(`${kp} = getelementptr inbounds %ScrCaught, ptr ${c.name}, i64 0, i32 1`);
        B.line(`${k} = load i32, ptr ${kp}`);
        B.line(`${t} = icmp ${e.negated === true ? "ne" : "eq"} i32 ${k}, ${tag} ; typeof e === "${e.test}"`);
        return { name: t, type: e.type };
      }
      case "caughtCheck": {
        // Checked payload extraction (`e as C`): instanceof match extracts
        // +1, anything else throws the catchable TypeError — the result
        // joins the frame BEFORE the pending check so an unwind releases
        // the NULL dummy harmlessly. Box borrowed.
        const c = host.emitExpr(e.value);
        const target = host.classMetaOf(e.className);
        const display = e.className.startsWith("%") ? e.className.slice(1) : e.className;
        host.declare(`declare ptr @scr_caught_check_obj(ptr, ${host.sizeType}, ${host.sizeType}, ptr)`);
        const t = B.tmp();
        B.line(
          `${t} = call ptr @scr_caught_check_obj(ptr ${c.name}, ${host.sizeType} ${target.pre}, ${host.sizeType} ${target.post}, ptr ${host.cstr(display)})`,
        );
        const out = host.own({ name: t, type: e.type });
        host.emitPendingCheck();
        return out;
      }
      case "caughtNarrow": {
        // Checker-trusted extraction (the matching caughtTest was proven
        // by tsc's narrowing): scalars read the snapshot's slots,
        // refcounted payloads come out retained (+1). Box borrowed.
        const c = host.emitExpr(e.value);
        if (e.type.kind === "f64") {
          const p = B.tmp();
          const v = B.tmp();
          B.line(`${p} = getelementptr inbounds %ScrCaught, ptr ${c.name}, i64 0, i32 2`);
          B.line(`${v} = load double, ptr ${p}`);
          return { name: v, type: e.type };
        }
        if (e.type.kind === "bool") {
          const p = B.tmp();
          const raw = B.tmp();
          const v = B.tmp();
          B.line(`${p} = getelementptr inbounds %ScrCaught, ptr ${c.name}, i64 0, i32 3`);
          B.line(`${raw} = load i8, ptr ${p}`);
          B.line(`${v} = trunc i8 ${raw} to i1`);
          return { name: v, type: e.type };
        }
        const pp = B.tmp();
        const payload = B.tmp();
        B.line(`${pp} = getelementptr inbounds %ScrCaught, ptr ${c.name}, i64 0, i32 4`);
        B.line(`${payload} = load ptr, ptr ${pp}`);
        if (e.type.kind === "string") {
          return host.own({ name: host.retainValue(payload, e.type), type: e.type });
        }
        if (e.type.kind === "object") {
          // Retain through the snapshot's own entry point (the payload's
          // dynamic class is opaque here — exactly the C's retain_fn call).
          const rp = B.tmp();
          const rf = B.tmp();
          const v = B.tmp();
          B.line(`${rp} = getelementptr inbounds %ScrCaught, ptr ${c.name}, i64 0, i32 5`);
          B.line(`${rf} = load ptr, ptr ${rp}`);
          B.line(`${v} = call ptr ${rf}(ptr ${payload})`);
          return host.own({ name: v, type: e.type });
        }
        throw new LlvmUnsupportedError(`caughtNarrow:${e.type.kind}`, e.loc);
      }
      case "caughtToDyn": {
        // A catch binding flowing into an `unknown` slot: the snapshot's
        // runtime kind converts through the interned helper (+1 fresh
        // tree; never throws). Box borrowed.
        const c = host.emitExpr(e.value);
        const helper = host.dyn.caughtToDynHelper();
        const t = B.tmp();
        B.line(`${t} = call ptr @${helper}(ptr ${c.name})`);
        return host.own({ name: t, type: e.type });
      }
      default: {
        const _exhaustive: never = e;
        void _exhaustive;
        throw new InternalCompilerError("unreachable");
      }
    }
  }
