import { classMembershipIntervals } from "./classes.js";
import { borrowableInputs, emitBorrowedInput, emitBorrowedInputs } from "./borrowed-inputs.js";
import { preservesDynTest } from "./checked-value-lifetimes.js";
import { typedRefConstructor } from "./shapes.js";
import { bindLiveArrayOps } from "./expr-stream-bridges.js";
/* Focused LLVM expression emission extracted from emitter.ts. */
import { InternalCompilerError } from "../../errors.js";
import { emitNullableIsTag, emitNullablePresent } from "./union-repr.js";
import { isObjectArm } from "./nullable-unions.js";
import { streamTypedRefEligible } from "../../ir/analysis.js";
import {
  DYN,
  type IrExpr,
  isDynTypedRefType,
  isRefCounted,
  isUnitType,
  typeEquals,
  typeKey,
} from "../../ir/ir.js";
import { BYTES_ELEM_NUM, closureIdentityEqual } from "./common.js";
import { DYN_KIND } from "./dyn.js";
import { elemAccess, vAdapters } from "./shapes.js";
import { LlvmUnsupportedError } from "./unsupported.js";
import type { LlvmEmitterContext, ExprOf, LlValue } from "./expr-context.js";
import { emitUnionWiden } from "./expr-records.js";

export function emitDynamicExpr(
  host: LlvmEmitterContext,
  e: ExprOf<
    | "dynFrom"
    | "dynFromJsval"
    | "dynCall"
    | "dynInvoke"
    | "dynArrLit"
    | "dynObjLit"
    | "unionWrap"
    | "unionNarrow"
    | "unionDisc"
    | "unionKeyGet"
    | "unionIsTag"
    | "dynKeyGet"
    | "dynHasKey"
    | "dynScalarEq"
    | "dynTest"
    | "unionEq"
    | "unionFuncEq"
    | "caughtTest"
    | "caughtCheck"
    | "caughtNarrow"
    | "caughtToDyn"
  >,
): LlValue {
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
      const v = emitBorrowedInput(host, e.value);
      const identityRef =
        isDynTypedRefType(v.type) ||
        (v.type.kind === "union" &&
          (host.unionsById.get(v.type.unionId)?.arms.some(isDynTypedRefType) ?? false));
      // Bytes already box their shared mutable storage directly. A second
      // capsule would split identity between checked and native views.
      const errorRef = v.type.kind === "object" && host.shapeHost.isErrorClass(v.type.className);
      if (!errorRef && ((e.liveRef && v.type.kind !== "bytes") || identityRef)) {
        if (v.type.kind === "union") {
          const adapter = host.liveDynUnionRefAdapter(v.type);
          const boxed = B.tmp();
          B.line(`${boxed} = call ptr @${adapter}(ptr ${v.name})`);
          return host.own({ name: boxed, type: e.type });
        }
        if (!streamTypedRefEligible(v.type) && !isDynTypedRefType(v.type)) {
          throw new InternalCompilerError(`llvm emitter bug: live dyn ref of ${typeKey(v.type)}`);
        }
        const key = typeKey(v.type);
        const adapter = host.liveDynRefAdapter(v.type);
        const rc = vAdapters(host.shapeHost, v.type);

        const boxed = B.tmp();
        B.line(
          `${boxed} = call ptr ${typedRefConstructor(host.shapeHost, v.type)}(ptr ${v.name}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${host.cstr(key)}, ${host.sizeType} ${Buffer.byteLength(key, "utf8")}, ptr @${adapter.snapshot}, ptr ${adapter.commit})`,
        );
        for (const line of bindLiveArrayOps(host, adapter, boxed)) B.line(line);
        return host.own({ name: boxed, type: e.type });
      }
      if (v.type.kind === "func") {
        // A closure boxes as the checked-dynamic tree's function kind: retained closure +
        // the per-signature call thunk + the interned signature key. The
        // best-effort name rides along (null when the lowering had none).
        const name = e.fnName !== undefined && e.fnName !== "" ? host.cstr(e.fnName) : "null";
        const box = host.dyn.dynFuncBoxHelper(v.type);
        const t = B.tmp();
        B.line(`${t} = call ptr @${box}(ptr ${v.name}, ptr ${name})`);
        return host.own({ name: t, type: e.type });
      }
      const conv = host.dyn.toDynHelper(v.type);
      const valTy = host.llType(v.type);
      const t = B.tmp();
      B.line(`${t} = call ptr @${conv}(${valTy} ${v.name})`);
      return host.own({ name: t, type: e.type });
    }
    case "dynFromJsval": {
      // Island value → dyn: the by-reference wrap (scr_dyn_from_jsval
      // retains the cell in; engine scalars normalize to native dyn
      // kinds at wrap time). Operand borrowed, result +1, never throws.
      const v = emitBorrowedInput(host, e.value);
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
      const callee = emitBorrowedInput(host, e.callee);
      const receiver = e.receiver === undefined ? null : emitBorrowedInput(host, e.receiver);
      const calleeName = (): string => {
        if (e.calleeNameValue === undefined) return host.cstr(e.calleeName);
        const name = emitBorrowedInput(host, e.calleeNameValue);
        const data = B.tmp();
        B.line(`${data} = getelementptr inbounds %ScrStr, ptr ${name.name}, i32 1`);
        return data;
      };
      host.declare("declare void @scr_dyn_this_push_dyn(ptr)");
      host.declare("declare void @scr_dyn_this_pop()");
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
          const spreadWhat = spreadAt.get(i);
          const v = spreadWhat === undefined ? host.emitExpr(a) : emitBorrowedInput(host, a);
          if (spreadWhat !== undefined) {
            B.line(
              `call void @scr_dyn_arr_push_spread(ptr ${pack}, ptr ${v.name}, ptr ${host.cstr(spreadWhat)})`,
            );
            host.emitPendingCheck();
          } else {
            host.moveTemp(v);
            B.line(`call void @scr_dyn_arr_push(ptr ${pack}, ptr ${v.name})`);
          }
        });
        const t = B.tmp();
        const name = calleeName();
        B.line(`call void @scr_dyn_this_push_dyn(ptr ${receiver?.name ?? "null"})`);
        B.line(`${t} = call ptr @scr_dyn_apply(ptr ${callee.name}, ptr ${pack}, ptr ${name})`);
        B.line("call void @scr_dyn_this_pop()");
        const out = host.own({ name: t, type: e.type });
        host.emitPendingCheck();
        return out;
      }
      const args = e.args.map((a) => emitBorrowedInput(host, a));
      let argsPtr = "null";
      if (args.length > 0) {
        const arr = B.slot();
        B.entryAllocas.push(`${arr} = alloca [${args.length} x ptr]`);
        args.forEach((a, i) => {
          const p = B.tmp();
          B.line(
            `${p} = getelementptr inbounds [${args.length} x ptr], ptr ${arr}, i64 0, ${host.sizeType} ${i}`,
          );
          B.line(`store ptr ${a.name}, ptr ${p}`);
        });
        argsPtr = arr;
      }
      host.declare(`declare ptr @scr_dyn_call(ptr, ptr, ${host.sizeType}, ptr)`);
      const t = B.tmp();
      const name = calleeName();
      B.line(`call void @scr_dyn_this_push_dyn(ptr ${receiver?.name ?? "null"})`);
      B.line(
        `${t} = call ptr @scr_dyn_call(ptr ${callee.name}, ptr ${argsPtr}, ${host.sizeType} ${args.length}, ptr ${name})`,
      );
      B.line("call void @scr_dyn_this_pop()");
      const out = host.own({ name: t, type: e.type });
      host.emitPendingCheck();
      return out;
    }
    case "dynInvoke": {
      // Prototype-method dispatch on a dyn receiver: everything is
      // BORROWED by scr_dyn_invoke; the result is owned and may ride a
      // pending exception.
      const recv = emitBorrowedInput(host, e.recv);
      host.declare(`declare ptr @scr_dyn_prepare_method(ptr, ptr)`);
      const prepared = B.tmp();
      B.line(
        `${prepared} = call ptr @scr_dyn_prepare_method(ptr ${recv.name}, ptr ${host.cstr(e.method)})`,
      );
      host.own({ name: prepared, type: { kind: "dyn" } });
      host.emitPendingCheck();
      const args = e.args.map((a) => emitBorrowedInput(host, a));
      let argsPtr = "null";
      if (args.length > 0) {
        const arr = B.slot();
        B.entryAllocas.push(`${arr} = alloca [${args.length} x ptr]`);
        args.forEach((a, i) => {
          const p = B.tmp();
          B.line(
            `${p} = getelementptr inbounds [${args.length} x ptr], ptr ${arr}, i64 0, ${host.sizeType} ${i}`,
          );
          B.line(`store ptr ${a.name}, ptr ${p}`);
        });
        argsPtr = arr;
      }
      host.declare(
        `declare ptr @scr_dyn_invoke_prepared(ptr, ptr, ptr, ptr, ${host.sizeType}, ptr)`,
      );
      let name = host.cstr(e.calleeName);
      if (e.calleeNameValue !== undefined) {
        const value = emitBorrowedInput(host, e.calleeNameValue);
        name = B.tmp();
        B.line(`${name} = getelementptr inbounds %ScrStr, ptr ${value.name}, i32 1`);
      }
      const t = B.tmp();
      B.line(
        `${t} = call ptr @scr_dyn_invoke_prepared(ptr ${recv.name}, ptr ${prepared}, ptr ${host.cstr(e.method)}, ptr ${argsPtr}, ${host.sizeType} ${args.length}, ptr ${name})`,
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
      host.declare(`declare void @scr_dyn_key_set_computed(ptr, ptr, ptr)`);
      const obj = B.tmp();
      B.line(`${obj} = call ptr @scr_dyn_new_obj()`);
      const out = host.own({ name: obj, type: e.type });
      for (const f of e.fields ?? []) {
        const k = emitBorrowedInput(host, f.key);
        const v = emitBorrowedInput(host, f.value);
        B.line(
          `call void @${f.key.type.kind === "dyn" ? "scr_dyn_key_set_computed" : "scr_dyn_key_set"}(ptr ${obj}, ptr ${k.name}, ptr ${v.name})`,
        );
        host.emitPendingCheck();
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
      return host.own({ name: host.unionNewOwned(e.unionId, e.tag, v), type: e.type });
    }
    case "unionNarrow": {
      // Tag-UNCHECKED payload extraction: the frontend emits this only
      // where tsc's control-flow narrowing proved the tag. Ref payloads
      // come out +1. The receiver is consumed before any later expression.
      const u = host.emitUnionProjection(e.value);
      const arm = e.type;
      if (isUnitType(arm))
        throw new InternalCompilerError(`llvm emitter bug: unionNarrow to unit arm ${arm.kind}`);
      const v = host.unionExtract(u.name, e.unionId, arm);
      return host.own({ name: v, type: arm });
    }
    case "unionDisc": {
      // Shared-field read `r.kind`: switch on the runtime tag and read
      // the (same-typed) field from the concretely-typed payload.
      // Ref-counted results come out retained (+1), owned by this frame.
      const u = host.emitUnionProjection(e.value);
      const def = host.unionsById.get(e.unionId);
      if (!def)
        throw new InternalCompilerError(
          `llvm emitter bug: unionDisc of unknown union ${e.unionId}`,
        );
      const ty = host.llType(e.type);
      const slot = B.slot();
      B.entryAllocas.push(`${slot} = alloca ${ty}`);
      const join = B.newLabel("ud.j");
      host.unionTagSwitch(
        u.name,
        def,
        (arm) => {
          if (arm.kind !== "record" && arm.kind !== "object") {
            throw new LlvmUnsupportedError(`unionDisc:${arm.kind}`, e.loc);
          }
          const payload = host.unionPeek(u.name, def.id);
          const { ptr, type } =
            arm.kind === "object"
              ? host.classFieldPtr(payload, arm.className, e.field)
              : host.recordFieldPtr(payload, arm.shapeId, e.field);
          const nullable =
            arm.kind === "object" ? host.nullableFields.get(arm.className, e.field) : null;
          const v =
            arm.kind === "object"
              ? host.int32Slots.isField(arm.className, e.field)
                ? host.loadInt32Field(ptr, e.type).name
                : host.loadField(ptr, type)
              : host.loadRecordField(ptr, type);
          const value = nullable
            ? host.nullableToOwnedUnion(v, nullable)
            : isRefCounted(e.type)
              ? host.retainValue(v, e.type)
              : v;
          B.line(`store ${ty} ${value}, ptr ${slot}`);
          B.br(join);
        },
        host.unionFieldGroups(def, e.field),
      );
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
      const u = emitBorrowedInput(host, e.value);
      const k = emitBorrowedInput(host, e.key);
      const def = host.unionsById.get(e.unionId);
      if (!def)
        throw new InternalCompilerError(
          `llvm emitter bug: unionKeyGet of unknown union ${e.unionId}`,
        );
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
            throw new InternalCompilerError(
              "llvm emitter bug: unionKeyGet unit arm without an undefined result arm",
            );
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
          const payload = host.unionPeek(u.name, def.id);
          const acc = elemAccess(arm.elem);
          const accTy = acc === "f64" ? "double" : acc === "bool" ? "i1" : "ptr";
          host.declare(
            `declare ${acc === "bool" ? "zeroext i1" : accTy} @scr_arr_get_${acc}(ptr, double)`,
          );
          const v = B.tmp();
          B.line(`${v} = call ${accTy} @scr_arr_get_${acc}(ptr ${payload}, double ${k.name})`);
          if (typeEquals(arm.elem, e.type)) {
            B.line(`store ${ty} ${v}, ptr ${slot}`);
            B.br(join);
            return;
          }
          if (arm.elem.kind === "union" && e.type.kind === "union") {
            const widened = emitUnionWiden(host, v, arm.elem.unionId, e.type.unionId, true);
            B.line(`store ptr ${widened}, ptr ${slot}`);
            B.br(join);
            return;
          }
          const tag = resultDef?.arms.findIndex((a) => typeEquals(a, arm.elem)) ?? -1;
          if (tag < 0 || e.type.kind !== "union" || isUnitType(arm.elem)) {
            throw new InternalCompilerError(
              `llvm emitter bug: unionKeyGet element ${arm.elem.kind} outside the join`,
            );
          }
          // The element read is already owned (+1) — ownership MOVES
          // into the union box, no extra retain.
          B.line(
            `store ptr ${host.unionNewOwned(e.type.unionId, tag, { name: v, type: arm.elem })}, ptr ${slot}`,
          );
          B.br(join);
          return;
        }
        if (arm.kind !== "record") throw new LlvmUnsupportedError(`unionKeyGet:${arm.kind}`, e.loc);
        const shape = host.recordShape(arm.shapeId);
        const payload = host.unionPeek(u.name, def.id);
        const declared =
          literal !== null ? shape.fields.find((f) => f.name === literal) : undefined;
        if (declared) {
          const { ptr, type: ft } = host.recordFieldPtr(payload, arm.shapeId, declared.name);
          const v = host.loadRecordField(ptr, ft);
          if (typeEquals(ft, e.type)) {
            B.line(`store ${ty} ${isRefCounted(ft) ? host.retainValue(v, ft) : v}, ptr ${slot}`);
            B.br(join);
            return;
          }
          if (ft.kind === "union" && e.type.kind === "union") {
            const widened = emitUnionWiden(host, v, ft.unionId, e.type.unionId, false);
            B.line(`store ptr ${widened}, ptr ${slot}`);
            B.br(join);
            return;
          }
          const tag = resultDef?.arms.findIndex((a) => typeEquals(a, ft)) ?? -1;
          if (tag < 0 || e.type.kind !== "union" || isUnitType(ft)) {
            throw new InternalCompilerError(
              `llvm emitter bug: unionKeyGet arm answer ${ft.kind} outside the join`,
            );
          }
          const wrapped =
            ft.kind === "f64" || ft.kind === "bool"
              ? host.unionNewOwned(e.type.unionId, tag, { name: v, type: ft })
              : host.unionNewOwned(e.type.unionId, tag, {
                  name: host.retainValue(v, ft),
                  type: ft,
                });
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
      const u = host.emitUnionProjection(e.value);
      const nullable = host.nullableUnions.get(e.unionId);
      const t = B.tmp();
      if (nullable)
        return { name: emitNullableIsTag(B, nullable, u.name, e.tag, e.negated), type: e.type };
      const tag = host.unionTag(u.name, e.unionId);
      B.line(`${t} = icmp ${e.negated ? "ne" : "eq"} i32 ${tag}, ${e.tag}`);
      return { name: t, type: e.type };
    }
    case "dynKeyGet": {
      // Keyed read on the checked-dynamic tree through the one interned helper — the
      // non-optional form throws JS's TypeError on an undefined/null
      // receiver, and HANDLE receivers can throw the loud unmodeled-
      // property ladder on EITHER form; the result is owned (+1).
      const d = emitBorrowedInput(host, e.value);
      const k = emitBorrowedInput(host, e.key);
      const helper =
        e.key.type.kind === "dyn" ? host.dyn.dynComputedKeyGetHelper() : host.dyn.dynKeyGetHelper();
      const t = B.tmp();
      B.line(
        `${t} = call ptr @${helper}(ptr ${d.name}, ptr ${k.name}, i1 ${e.optional ? "true" : "false"})`,
      );
      const out = host.own({ name: t, type: e.type });
      host.emitPendingCheck();
      return out;
    }
    case "dynHasKey": {
      const value = emitBorrowedInput(host, e.value);
      const key = host.emitExpr({
        kind: "strLit",
        value: e.key,
        type: { kind: "string" },
        loc: e.loc,
      });
      host.declare(`declare zeroext i1 @scr_dyn_has_key(ptr, ptr)`);
      const raw = B.tmp();
      B.line(`${raw} = call zeroext i1 @scr_dyn_has_key(ptr ${value.name}, ptr ${key.name})`);
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
      const inputs = emitBorrowedInputs(host, [e.left, e.right]);
      const l = inputs[0]!,
        r = inputs[1]!;
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
        const wantKind =
          st.kind === "string" ? DYN_KIND.STR : st.kind === "f64" ? DYN_KIND.NUM : DYN_KIND.BOOL;
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
          B.line(`${eq} = call zeroext i1 @sc_str_eq(ptr ${sv}, ptr ${s.name})`);
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
      // Scalar tests preserve existing owners. Brand tests may materialize
      // a native view, so only independently owned locals borrow there.
      const d = preservesDynTest(e.test)
        ? host.emitReadReceiver(e.value)
        : emitBorrowedInput(host, e.value);
      let test: string;
      if (e.test === "bytes") {
        host.declare(`declare zeroext i1 @scr_dyn_typed_array_is(ptr, i32)`);
        test = B.tmp();
        B.line(
          `${test} = call zeroext i1 @scr_dyn_typed_array_is(ptr ${d.name}, i32 ${BYTES_ELEM_NUM[e.bytesElem ?? "u8"]})`,
        );
      } else if (e.test === "truthy") {
        host.declare(`declare zeroext i1 @scr_dyn_truthy(ptr)`);
        test = B.tmp();
        B.line(`${test} = call zeroext i1 @scr_dyn_truthy(ptr ${d.name})`);
      } else if (e.test === "error") {
        // `u instanceof Error`: the checked-dynamic tree's error encoding — an object
        // carrying the reserved "%error" marker key, a registered native
        // Error view, or a real engine Error held by reference.
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
        B.line(
          `${m} = call ptr @scr_dyn_obj_get(ptr ${d.name}, ptr ${host.cstr("%error")}, ${host.sizeType} 6)`,
        );
        B.line(`${has} = icmp ne ptr ${m}, null`);
        const branded = B.tmp();
        B.line(`${branded} = or i1 ${has}, ${isl}`);
        B.line(`store i1 ${branded}, ptr ${slot}`);
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
          B.line(
            `${c} = call zeroext i1 @${helper}(ptr ${d.name}${arg !== undefined ? `, ptr ${arg}` : ""})`,
          );
          const o = B.tmp();
          B.line(`${o} = or i1 ${acc}, ${c}`);
          return o;
        };
        if (e.test === "promise") {
          test = oneOf([DYN_KIND.PROMISE]);
        } else if (e.test === "nullish") {
          test = oneOf([DYN_KIND.UNDEF, DYN_KIND.NULL]);
        } else if (e.test === "buffer") {
          const bytes = oneOf([DYN_KIND.BYTES]);
          const flagPtr = B.tmp();
          const flag = B.tmp();
          const buffer = B.tmp();
          B.line(
            `${flagPtr} = getelementptr inbounds i8, ptr ${d.name}, i64 ${host.abiOffset(12, 8)} ; ->buffer`,
          );
          B.line(`${flag} = load i8, ptr ${flagPtr}`);
          B.line(`${buffer} = icmp ne i8 ${flag}, 0`);
          test = B.tmp();
          B.line(`${test} = and i1 ${bytes}, ${buffer}`);
        } else if (e.test === "object") {
          // `typeof v === "object"`: objects, arrays, bytes, native
          // handles, promises, AND null — engine-held objects by the
          // engine's own typeof.
          const object = orIsl(
            oneOf([
              DYN_KIND.OBJ,
              DYN_KIND.ARR,
              DYN_KIND.BYTES,
              DYN_KIND.HANDLE,
              DYN_KIND.PROMISE,
              DYN_KIND.PROXY,
              DYN_KIND.NULL,
            ]),
            "scr_dyn_isl_typeof_is",
            host.cstr("object"),
          );
          host.declare("declare zeroext i1 @scr_dyn_is_callable(ptr)");
          const callable = B.tmp();
          const nonCallable = B.tmp();
          test = B.tmp();
          B.line(`${callable} = call zeroext i1 @scr_dyn_is_callable(ptr ${d.name})`);
          B.line(`${nonCallable} = xor i1 ${callable}, true`);
          B.line(`${test} = and i1 ${object}, ${nonCallable}`);
        } else if (e.test === "array") {
          // Array.isArray: the checked-dynamic tree's array kind, or the engine's own
          // answer for an engine-held value.
          test = orIsl(oneOf([DYN_KIND.ARR]), "scr_dyn_isl_is_array");
        } else if (e.test === "function") {
          host.declare("declare zeroext i1 @scr_dyn_is_callable(ptr)");
          test = B.tmp();
          B.line(`${test} = call zeroext i1 @scr_dyn_is_callable(ptr ${d.name})`);
        } else {
          const kindOf: Record<string, number> = {
            bigint: DYN_KIND.BIGINT,
            symbol: DYN_KIND.SYMBOL,
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
      const direct = emitUnionEqWrappedScalar(host, e);
      if (direct) return direct;
      // Strict equality of the ARM values (tag compare + per-arm payload
      // compare — the C per-union helper, inlined). Both boxes borrowed.
      // Stack-representable operands (wrapped literals, optional array
      // reads, Map.get results) and stack-boxed locals never allocate: the
      // compare only reads tags and payloads, and each payload has its own
      // owner, so later operands cannot invalidate an earlier stack box.
      // A borrowed nullable-pointer field read projects its pointer the
      // same way; borrowableInputs already proved later operands cannot
      // replace the field.
      const operands = [e.left, e.right];
      const borrowed = borrowableInputs(host, operands);
      const inputs = operands.map((value, index) =>
        borrowed[index] ||
        host.isStackUnionSource(value) ||
        (value.kind === "varRef" && host.isStackUnionLocal(value.localId))
          ? host.emitUnionProjection(value)
          : host.emitExpr(value),
      );
      const l = inputs[0]!,
        r = inputs[1]!;
      const def = host.unionsById.get(e.unionId);
      if (!def)
        throw new InternalCompilerError(`llvm emitter bug: equality of unknown union ${e.unionId}`);
      const nullable = host.nullableUnions.get(def.id);
      if (nullable && isObjectArm(nullable)) {
        // Object identity, and NULL === NULL for the unit arm: one compare.
        const eq = B.tmp();
        B.line(`${eq} = icmp ${e.negated ? "ne" : "eq"} ptr ${l.name}, ${r.name}`);
        return { name: eq, type: e.type };
      }
      if (nullable) {
        // String arm: identical pointers are equal (the same string or the
        // same unit encoding); otherwise equal only when both hold strings
        // with the same bytes.
        const slot = B.slot();
        B.entryAllocas.push(`${slot} = alloca i1`);
        const same = B.tmp(),
          present = B.tmp();
        B.line(`${same} = icmp eq ptr ${l.name}, ${r.name}`);
        const lPresent = emitNullablePresent(B, nullable, l.name);
        const rPresent = emitNullablePresent(B, nullable, r.name);
        B.line(`${present} = and i1 ${lPresent}, ${rPresent}`);
        B.line(`store i1 ${same}, ptr ${slot}`);
        const bytes = B.newLabel("ues.b"),
          join = B.newLabel("ues.j");
        const notSame = B.tmp(),
          go = B.tmp();
        B.line(`${notSame} = xor i1 ${same}, true`);
        B.line(`${go} = and i1 ${notSame}, ${present}`);
        B.condBr(go, bytes, join);
        B.startBlock(bytes);
        host.declare(`declare zeroext i1 @scr_str_eq(ptr, ptr)`);
        const eqBytes = B.tmp();
        B.line(`${eqBytes} = call zeroext i1 @sc_str_eq(ptr ${l.name}, ptr ${r.name})`);
        B.line(`store i1 ${eqBytes}, ptr ${slot}`);
        B.br(join);
        B.startBlock(join);
        const eq = B.tmp();
        B.line(`${eq} = load i1, ptr ${slot}`);
        if (!e.negated) return { name: eq, type: e.type };
        const ne = B.tmp();
        B.line(`${ne} = xor i1 ${eq}, true`);
        return { name: ne, type: e.type };
      }
      const slot = B.slot();
      B.entryAllocas.push(`${slot} = alloca i1`);
      const join = B.newLabel("ue.j");
      const same = B.newLabel("ue.s");
      const ltag = host.unionTag(l.name, def.id);
      const rtag = host.unionTag(r.name, def.id);
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
            const a = host.unionGetF64(l.name);
            const b = host.unionGetF64(r.name);
            const t = B.tmp();
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
            const a = host.unionGetBool(l.name);
            const b = host.unionGetBool(r.name);
            const t = B.tmp();
            B.line(`${t} = icmp eq i1 ${a}, ${b}`);
            B.line(`store i1 ${t}, ptr ${slot}`);
            break;
          }
          case "string": {
            host.declare(`declare zeroext i1 @scr_str_eq(ptr, ptr)`);
            const a = host.unionPeek(l.name, def.id);
            const b = host.unionPeek(r.name, def.id);
            const t = B.tmp();
            B.line(`${t} = call zeroext i1 @sc_str_eq(ptr ${a}, ptr ${b})`);
            B.line(`store i1 ${t}, ptr ${slot}`);
            break;
          }
          case "bigint": {
            host.declare(`declare zeroext i1 @scr_bigint_eq(ptr, ptr)`);
            const a = host.unionPeek(l.name, def.id);
            const b = host.unionPeek(r.name, def.id);
            const t = B.tmp();
            B.line(`${t} = call zeroext i1 @scr_bigint_eq(ptr ${a}, ptr ${b})`);
            B.line(`store i1 ${t}, ptr ${slot}`);
            break;
          }
          default: {
            // Ref arms: pointer identity, exactly JS object equality.
            // Function arms compare identity roots (adapters included).
            const a = host.unionPeek(l.name, def.id);
            const b = host.unionPeek(r.name, def.id);
            const t = B.tmp();
            if (arm.kind === "func") B.line(`${t} = ${closureIdentityEqual(host, a, b)}`);
            else B.line(`${t} = icmp eq ptr ${a}, ${b} ; ${arm.kind}`);
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
      const inputs = emitBorrowedInputs(host, [e.union, e.func]);
      const u = inputs[0]!,
        f = inputs[1]!;
      const tag = host.unionTag(u.name, e.unionId);
      const tagMatch = B.tmp();
      B.line(`${tagMatch} = icmp eq i32 ${tag}, ${e.tag}`);
      // The payload is a closure only under the function tag; another
      // arm's payload must never be read as one.
      const slot = B.slot();
      B.entryAllocas.push(`${slot} = alloca i1`);
      B.line(`store i1 false, ptr ${slot}`);
      const check = B.newLabel("ufe.c");
      const join = B.newLabel("ufe.j");
      B.condBr(tagMatch, check, join);
      B.startBlock(check);
      const payload = host.unionPeek(u.name, e.unionId);
      const identical = B.tmp();
      B.line(`${identical} = ${closureIdentityEqual(host, payload, f.name)}`);
      B.line(`store i1 ${identical}, ptr ${slot}`);
      B.br(join);
      B.startBlock(join);
      const result = B.tmp();
      B.line(`${result} = load i1, ptr ${slot}`);
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
      const c = host.emitReadReceiver(e.value);
      if (e.test === "instanceof") {
        const target = host.classMetaOf(e.className!);
        if (!target.hierarchy) {
          // Standalone class payloads have no vtable word. Their retain
          // adapter identifies the exact native layout in the snapshot.
          const adapterSlot = B.tmp();
          const adapter = B.tmp();
          B.line(`${adapterSlot} = getelementptr inbounds %ScrCaught, ptr ${c.name}, i64 0, i32 5`);
          B.line(`${adapter} = load ptr, ptr ${adapterSlot}`);
          let result: string | undefined;
          const intervals = classMembershipIntervals(host.classMeta, target.def.name);
          for (const candidate of host.classMeta.values()) {
            if (
              candidate.hierarchy ||
              !intervals.some((range) => range.pre <= candidate.pre && candidate.pre <= range.post)
            )
              continue;
            const rc = vAdapters(host.shapeHost, { kind: "object", className: candidate.def.name });
            const matches = B.tmp();
            B.line(`${matches} = icmp eq ptr ${adapter}, ${rc.retain}`);
            if (result === undefined) result = matches;
            else {
              const joined = B.tmp();
              B.line(`${joined} = or i1 ${result}, ${matches}`);
              result = joined;
            }
          }
          if (result === undefined)
            throw new InternalCompilerError("empty standalone class membership");
          if (e.negated !== true) return { name: result, type: e.type };
          const negated = B.tmp();
          B.line(`${negated} = xor i1 ${result}, true`);
          return { name: negated, type: e.type };
        }
        host.declare(
          `declare zeroext i1 @scr_caught_instanceof(ptr, ${host.sizeType}, ${host.sizeType})`,
        );
        let t: string | undefined;
        for (const interval of classMembershipIntervals(host.classMeta, target.def.name)) {
          const test = B.tmp();
          B.line(
            `${test} = call zeroext i1 @scr_caught_instanceof(ptr ${c.name}, ${host.sizeType} ${interval.pre}, ${host.sizeType} ${interval.post})`,
          );
          if (t === undefined) t = test;
          else {
            const combined = B.tmp();
            B.line(`${combined} = or i1 ${t}, ${test}`);
            t = combined;
          }
        }
        if (t === undefined) throw new InternalCompilerError("empty class membership");
        if (e.negated !== true) return { name: t, type: e.type };
        const n = B.tmp();
        B.line(`${n} = xor i1 ${t}, true`);
        return { name: n, type: e.type };
      }
      if (e.test === "object") {
        host.declare(`declare zeroext i1 @scr_caught_is_object(ptr)`);
        const t = B.tmp();
        B.line(`${t} = call zeroext i1 @scr_caught_is_object(ptr ${c.name})`);
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
      B.line(
        `${t} = icmp ${e.negated === true ? "ne" : "eq"} i32 ${k}, ${tag} ; typeof e === "${e.test}"`,
      );
      return { name: t, type: e.type };
    }
    case "caughtCheck": {
      // Checked payload extraction (`e as C`): instanceof match extracts
      // +1, anything else throws the catchable TypeError — the result
      // joins the frame BEFORE the pending check so an unwind releases
      // the NULL dummy harmlessly. Box borrowed.
      const c = host.emitReadReceiver(e.value);
      const target = host.classMetaOf(e.className);
      const display = e.className.startsWith("%") ? e.className.slice(1) : e.className;
      host.declare(
        `declare ptr @scr_caught_check_obj(ptr, ${host.sizeType}, ${host.sizeType}, ptr)`,
      );
      let pre = String(target.pre);
      let post = String(target.post);
      const intervals = classMembershipIntervals(host.classMeta, target.def.name);
      if (intervals.length > 1) {
        // Select a matching interval rather than its bounding range: a
        // different specialization may live in the gaps between them.
        host.declare(
          `declare zeroext i1 @scr_caught_instanceof(ptr, ${host.sizeType}, ${host.sizeType})`,
        );
        pre = "-1";
        post = "-1";
        for (const interval of intervals) {
          const matched = B.tmp();
          const nextPre = B.tmp();
          const nextPost = B.tmp();
          B.line(
            `${matched} = call zeroext i1 @scr_caught_instanceof(ptr ${c.name}, ${host.sizeType} ${interval.pre}, ${host.sizeType} ${interval.post})`,
          );
          B.line(
            `${nextPre} = select i1 ${matched}, ${host.sizeType} ${interval.pre}, ${host.sizeType} ${pre}`,
          );
          B.line(
            `${nextPost} = select i1 ${matched}, ${host.sizeType} ${interval.post}, ${host.sizeType} ${post}`,
          );
          pre = nextPre;
          post = nextPost;
        }
      }
      const t = B.tmp();
      B.line(
        `${t} = call ptr @scr_caught_check_obj(ptr ${c.name}, ${host.sizeType} ${pre}, ${host.sizeType} ${post}, ptr ${host.cstr(display)})`,
      );
      const out = host.own({ name: t, type: e.type });
      host.emitPendingCheck();
      return out;
    }
    case "caughtNarrow": {
      // Checker-trusted extraction (the matching caughtTest was proven
      // by tsc's narrowing): scalars read the snapshot's slots,
      // refcounted payloads come out retained (+1). Box borrowed.
      const c = host.emitReadReceiver(e.value);
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
      const c = emitBorrowedInput(host, e.value);
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

/** `u === v` where one side wraps a unit, bool, or number arm value
 * (`o.flag === true`, `o.n === undefined`): compare the other union's tag
 * and payload directly instead of boxing the plain side. Operands keep
 * their left-to-right evaluation; the union stays borrowed. Null when
 * neither side is such a wrap. */
function emitUnionEqWrappedScalar(
  host: LlvmEmitterContext,
  e: IrExpr & { kind: "unionEq" },
): LlValue | null {
  const B = host.B;
  const def = host.unionsById.get(e.unionId);
  if (!def) return null;
  const scalarWrap = (x: IrExpr): (IrExpr & { kind: "unionWrap" }) | null => {
    if (x.kind !== "unionWrap" || x.unionId !== e.unionId) return null;
    const arm = def.arms[x.tag];
    if (!arm) return null;
    if (isUnitType(arm)) return x;
    // The plain value must not run code that could release the borrowed
    // union: literals and local reads only.
    const v = x.value;
    const pure = v.kind === "boolLit" || v.kind === "numLit" || v.kind === "varRef";
    return pure && (arm.kind === "f64" || arm.kind === "bool") ? x : null;
  };
  const rightWrap = scalarWrap(e.right);
  const leftWrap = rightWrap ? null : scalarWrap(e.left);
  const wrap = rightWrap ?? leftWrap;
  if (!wrap) return null;
  const arm = def.arms[wrap.tag]!;
  let union: LlValue;
  let plain: LlValue | null = null;
  const unionInput = (value: IrExpr): LlValue =>
    host.canStackReceiver(value) ? host.emitReadReceiver(value) : emitBorrowedInput(host, value);
  if (rightWrap) {
    union = unionInput(e.left);
    if (!isUnitType(arm)) plain = host.emitExpr(wrap.value);
  } else {
    if (!isUnitType(arm)) plain = host.emitExpr(wrap.value);
    union = unionInput(e.right);
  }
  const tag = host.unionTag(union.name, e.unionId);
  const tagMatch = B.tmp();
  B.line(`${tagMatch} = icmp eq i32 ${tag}, ${wrap.tag}`);
  let result = tagMatch;
  if (plain) {
    const slot = B.slot();
    B.entryAllocas.push(`${slot} = alloca i1`);
    B.line(`store i1 false, ptr ${slot}`);
    const same = B.newLabel("ueq.s");
    const join = B.newLabel("ueq.j");
    B.condBr(tagMatch, same, join);
    B.startBlock(same);
    const eq = B.tmp();
    if (arm.kind === "f64") {
      host.declare(`declare double @scr_union_get_f64(ptr)`);
      const v = B.tmp();
      B.line(`${v} = call double @scr_union_get_f64(ptr ${union.name})`);
      if (e.sameValue) {
        host.declare(`declare zeroext i1 @scr_num_same_value(double, double)`);
        B.line(`${eq} = call zeroext i1 @scr_num_same_value(double ${v}, double ${plain.name})`);
      } else {
        B.line(`${eq} = fcmp oeq double ${v}, ${plain.name}`);
      }
    } else {
      host.declare(`declare zeroext i1 @scr_union_get_bool(ptr)`);
      const v = B.tmp();
      B.line(`${v} = call zeroext i1 @scr_union_get_bool(ptr ${union.name})`);
      B.line(`${eq} = icmp eq i1 ${v}, ${plain.name}`);
    }
    B.line(`store i1 ${eq}, ptr ${slot}`);
    B.br(join);
    B.startBlock(join);
    result = B.tmp();
    B.line(`${result} = load i1, ptr ${slot}`);
  }
  if (!e.negated) return { name: result, type: e.type };
  const negated = B.tmp();
  B.line(`${negated} = xor i1 ${result}, true`);
  return { name: negated, type: e.type };
}
