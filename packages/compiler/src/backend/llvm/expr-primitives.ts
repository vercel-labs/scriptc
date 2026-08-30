/* Focused LLVM expression emission extracted from emitter.ts. */
import { InternalCompilerError } from "../../errors.js";
import { matchStringSelfConcat, undefinedArmTag } from "../../ir/analysis.js";
import { isRefCounted } from "../../ir/ir.js";
import { mangleRecordClone, mangleRecordNew } from "../mangle.js";
import { arrNewCall, elemAccess } from "./shapes.js";
import { LlvmUnsupportedError } from "./unsupported.js";
import type { LlvmEmitterContext, ExprOf, LlValue } from "./expr-context.js";

/** ScrBytesElem (scr_runtime.h): U8, U32, F32, I32. */
const BYTES_ELEM_NUM: Record<"u8" | "u32" | "f32" | "i32", number> = {
  u8: 0,
  u32: 1,
  f32: 2,
  i32: 3,
};
import { f64Lit } from "./common.js";

export function emitLiteralExpr(host: LlvmEmitterContext, e: ExprOf<"numLit" | "boolLit" | "strLit" | "unitLit" | "varRef">): LlValue {
    const B = host.B;
    switch (e.kind) {
      case "numLit":
        return { name: f64Lit(e.value), type: e.type };
      case "boolLit":
        return { name: e.value ? "true" : "false", type: e.type };
      case "strLit": {
        const sym = host.internLiteral(e.value);
        return host.own({ name: host.retainValue(sym, e.type), type: e.type });
      }
      case "unitLit":
        // unitLits are consumed inline by the unionWrap case (a unit arm is
        // tag-only); one reaching the generic dispatch escaped its wrap.
        throw new InternalCompilerError(`llvm emitter bug: bare unitLit '${e.unit}'`);
      case "varRef": {
        const integerSlot = host.integerLoopBindings.get(e.localId);
        if (integerSlot !== undefined) {
          const integer = B.tmp();
          const number = B.tmp();
          B.line(`${integer} = load ${host.sizeType}, ptr ${integerSlot}`);
          B.line(`${number} = uitofp ${host.sizeType} ${integer} to double`);
          return { name: number, type: e.type };
        }
        const b = host.binding(e.localId);
        if (b.kind === "boxed") {
          // Reads go through the shared binding; ref kinds come out +1.
          // Forward-captured consts (tdz) test the box's payload slot
          // first: empty is the temporal dead zone (catchable
          // ReferenceError, Node's message).
          const box = host.loadBox(b.slot);
          if (b.local!.tdz === true) {
            const v = host.tdzBoxRead(box, e.type, b.local!.name);
            return host.own({ name: v, type: e.type });
          }
          const v = host.boxGet(box, e.type);
          return host.own({ name: v, type: e.type });
        }
        const t = B.tmp();
        B.line(`${t} = load ${host.llType(b.type)}, ptr ${b.slot}`);
        if (isRefCounted(e.type)) return host.own({ name: host.retainValue(t, e.type), type: e.type });
        return { name: t, type: e.type };
      }
      default: {
        const _exhaustive: never = e;
        void _exhaustive;
        throw new InternalCompilerError("unreachable");
      }
    }
  }

export function emitOperatorExpr(host: LlvmEmitterContext, e: ExprOf<"bin" | "unary" | "incDec" | "fieldIncDec" | "assignExpr" | "seqExpr">): LlValue {
    const B = host.B;
    switch (e.kind) {
      case "bin": {
        const l = host.emitExpr(e.left);
        const r = host.emitExpr(e.right);
        const t = B.tmp();
        const arith: Record<string, string> = { "+": "fadd", "-": "fsub", "*": "fmul", "/": "fdiv" };
        const cmp: Record<string, string> = { "<": "olt", "<=": "ole", ">": "ogt", ">=": "oge", "===": "oeq", "!==": "une" };
        const libm: Record<string, string> = { "%": "fmod", "**": "pow" };
        const bit: Record<string, string> = {
          "&": "scr_bit_and",
          "|": "scr_bit_or",
          "^": "scr_bit_xor",
          "<<": "scr_bit_shl",
          ">>": "scr_bit_shr",
          ">>>": "scr_bit_ushr",
        };
        if ((e.op === "===" || e.op === "!==") && e.left.type.kind === "bool") {
          B.line(`${t} = icmp ${e.op === "===" ? "eq" : "ne"} i1 ${l.name}, ${r.name}`);
        } else if ((e.op === "===" || e.op === "!==") && host.llType(e.left.type) === "ptr") {
          // Reference identity (JS object equality) — closures, arrays,
          // records compared as pointers, exactly the C `==`.
          B.line(`${t} = icmp ${e.op === "===" ? "eq" : "ne"} ptr ${l.name}, ${r.name}`);
        } else if (arith[e.op] !== undefined || cmp[e.op] !== undefined) {
          if (e.left.type.kind !== "f64") throw new LlvmUnsupportedError(`bin:${e.op}:${e.left.type.kind}`, e.loc);
          if (arith[e.op] !== undefined) B.line(`${t} = ${arith[e.op]} double ${l.name}, ${r.name}`);
          else B.line(`${t} = fcmp ${cmp[e.op]} double ${l.name}, ${r.name}`);
        } else {
          const fn = libm[e.op] ?? bit[e.op];
          if (fn === undefined) throw new LlvmUnsupportedError(`bin:${e.op}`, e.loc);
          host.declare(`declare double @${fn}(double, double)`);
          B.line(`${t} = call double @${fn}(double ${l.name}, double ${r.name})`);
        }
        return { name: t, type: e.type };
      }
      case "unary": {
        const v = host.emitExpr(e.operand);
        const t = B.tmp();
        if (e.op === "-") B.line(`${t} = fneg double ${v.name}`);
        else if (e.op === "!") B.line(`${t} = xor i1 ${v.name}, true`);
        else {
          host.declare(`declare double @scr_bit_not(double)`);
          B.line(`${t} = call double @scr_bit_not(double ${v.name})`);
        }
        return { name: t, type: e.type };
      }
      case "incDec": {
        // Expression-position ++/-- over an f64 binding (locals, module
        // globals, capture boxes): read, write ±1, yield old (postfix) or
        // new (prefix).
        const b = host.binding(e.localId);
        if (b.kind === "boxed") {
          const box = host.loadBox(b.slot);
          const old = host.boxGet(box, e.type);
          const next = B.tmp();
          B.line(`${next} = ${e.op === "+" ? "fadd" : "fsub"} double ${old}, ${f64Lit(1)}`);
          host.boxSet(box, e.type, next);
          return { name: e.prefix ? next : old, type: e.type };
        }
        const old = B.tmp();
        const next = B.tmp();
        B.line(`${old} = load double, ptr ${b.slot}`);
        B.line(`${next} = ${e.op === "+" ? "fadd" : "fsub"} double ${old}, ${f64Lit(1)}`);
        B.line(`store double ${next}, ptr ${b.slot}`);
        return { name: e.prefix ? next : old, type: e.type };
      }
      case "fieldIncDec": {
        // ++/-- over a class FIELD in expression position: one receiver
        // evaluation, read-modify-write, old/new snapshotted — the local
        // form over a field slot. CHECKED-DYNAMIC fields validate the
        // number OUT (dynCheck — the catchable TypeError on non-numbers),
        // compute, and box the result back into the slot; unlink-then-
        // release like fieldSet (exprs.ts's shape).
        const obj = host.emitExpr(e.obj);
        const { ptr } = host.classFieldPtr(obj.name, e.className, e.field);
        if (e.fieldDyn) {
          const box = B.tmp();
          B.line(`${box} = load ptr, ptr ${ptr}`);
          const helper = host.dyn.dynCheckHelper(e.type);
          const old = B.tmp();
          B.line(`${old} = call double @${helper}(ptr ${box}, ptr null)`);
          host.emitPendingCheck();
          const next = B.tmp();
          B.line(`${next} = ${e.op === "+" ? "fadd" : "fsub"} double ${old}, ${f64Lit(1)}`);
          host.declare(`declare ptr @scr_dyn_new_num(double)`);
          host.declare(`declare void @scr_dyn_release(ptr)`);
          const boxed = B.tmp();
          B.line(`${boxed} = call ptr @scr_dyn_new_num(double ${next})`);
          B.line(`store ptr ${boxed}, ptr ${ptr}`);
          B.line(`call void @scr_dyn_release(ptr ${box})`);
          return { name: e.prefix ? next : old, type: e.type };
        }
        const old = B.tmp();
        const next = B.tmp();
        B.line(`${old} = load double, ptr ${ptr}`);
        B.line(`${next} = ${e.op === "+" ? "fadd" : "fsub"} double ${old}, ${f64Lit(1)}`);
        B.line(`store double ${next}, ptr ${ptr}`);
        return { name: e.prefix ? next : old, type: e.type };
      }
      case "assignExpr": {
        // `x = e` in expression position: the binding takes its OWN
        // reference (retain for ref kinds), the temp stays the yielded
        // value — CEmitter's order exactly (release old, store retained).
        const concat = e.value;
        const suffix = matchStringSelfConcat(e.localId, concat);
        if (suffix && concat.kind === "strConcat") {
          return host.emitStringSelfConcatAssign(e.localId, concat.left, suffix, true);
        }
        const b = host.binding(e.localId);
        const v = host.emitExpr(e.value);
        if (b.kind === "boxed") {
          // box_set takes ownership of the passed reference, so hand it a
          // retained copy and keep the temp's own reference for the yield.
          const stored = isRefCounted(v.type) ? host.retainValue(v.name, v.type) : v.name;
          host.boxSet(host.loadBox(b.slot), b.type, stored);
          return v;
        }
        if (isRefCounted(b.type)) {
          const old = B.tmp();
          B.line(`${old} = load ptr, ptr ${b.slot}`);
          host.releaseValue(old, b.type);
          B.line(`store ptr ${host.retainValue(v.name, v.type)}, ptr ${b.slot}`);
        } else {
          B.line(`store ${host.llType(b.type)} ${v.name}, ptr ${b.slot}`);
        }
        return v;
      }
      case "seqExpr": {
        // Statements mid-expression: each emits in place (its own frame,
        // exactly statement position); the result is an ordinary temp of
        // the current frame. The validator restricted stmts to straight-
        // line writes — no jump can leave the region.
        for (const s of e.stmts) host.emitStmt(s);
        return host.emitExpr(e.result);
      }
      default: {
        const _exhaustive: never = e;
        void _exhaustive;
        throw new InternalCompilerError("unreachable");
      }
    }
  }

export function emitStringExpr(host: LlvmEmitterContext, e: ExprOf<"strConcat" | "strEq" | "strCmp" | "toString" | "strIntrinsic" | "regexLit" | "templateStrings" | "regexIntrinsic">): LlValue {
    const B = host.B;
    switch (e.kind) {
      case "strConcat": {
        const l = host.emitExpr(e.left);
        const r = host.emitExpr(e.right);
        host.declare(`declare ptr @scr_str_concat(ptr, ptr)`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_str_concat(ptr ${l.name}, ptr ${r.name})`);
        return host.own({ name: t, type: e.type });
      }
      case "strEq": {
        const l = host.emitExpr(e.left);
        const r = host.emitExpr(e.right);
        host.declare(`declare zeroext i1 @scr_str_eq(ptr, ptr)`);
        const eq = B.tmp();
        B.line(`${eq} = call zeroext i1 @scr_str_eq(ptr ${l.name}, ptr ${r.name})`);
        if (!e.negated) return { name: eq, type: e.type };
        const t = B.tmp();
        B.line(`${t} = xor i1 ${eq}, true`);
        return { name: t, type: e.type };
      }
      case "strCmp": {
        const l = host.emitExpr(e.left);
        const r = host.emitExpr(e.right);
        const fn = e.utf16 === true ? "scr_str_cmp_u16" : "scr_str_cmp";
        host.declare(`declare i32 @${fn}(ptr, ptr)`);
        const c = B.tmp();
        const t = B.tmp();
        const pred = { "<": "slt", "<=": "sle", ">": "sgt", ">=": "sge" }[e.op];
        B.line(`${c} = call i32 @${fn}(ptr ${l.name}, ptr ${r.name})`);
        B.line(`${t} = icmp ${pred} i32 ${c}, 0`);
        return { name: t, type: e.type };
      }
      case "toString": {
        const v = host.emitExpr(e.operand);
        if (v.type.kind === "union") {
          // The ARM value's ToString: an inline tag switch (unit arms are
          // interned literals, string arms retain the payload, f64/bool
          // arms format — the C per-union helper at the use site). Ref
          // arms never arrive (the frontend fences those).
          const def = host.unionsById.get(v.type.unionId);
          if (!def) throw new InternalCompilerError(`llvm emitter bug: ToString of unknown union ${v.type.unionId}`);
          const slot = B.slot();
          B.entryAllocas.push(`${slot} = alloca ptr`);
          const join = B.newLabel("us.j");
          host.unionTagSwitch(v.name, def, (arm) => {
            switch (arm.kind) {
              case "undefinedT":
              case "nullT": {
                const lit = host.internLiteral(arm.kind === "undefinedT" ? "undefined" : "null");
                B.line(`store ptr ${host.retainValue(lit, e.type)}, ptr ${slot}`);
                break;
              }
              case "string":
                B.line(`store ptr ${host.retainValue(host.unionPeek(v.name), e.type)}, ptr ${slot}`);
                break;
              case "f64": {
                const x = B.tmp();
                const r = B.tmp();
                host.declare(`declare double @scr_union_get_f64(ptr)`);
                host.declare(`declare ptr @scr_f64_to_scrstr(double)`);
                B.line(`${x} = call double @scr_union_get_f64(ptr ${v.name})`);
                B.line(`${r} = call ptr @scr_f64_to_scrstr(double ${x})`);
                B.line(`store ptr ${r}, ptr ${slot}`);
                break;
              }
              case "bool": {
                const x = B.tmp();
                const r = B.tmp();
                host.declare(`declare zeroext i1 @scr_union_get_bool(ptr)`);
                host.declare(`declare ptr @scr_bool_to_scrstr(i1 zeroext)`);
                B.line(`${x} = call zeroext i1 @scr_union_get_bool(ptr ${v.name})`);
                B.line(`${r} = call ptr @scr_bool_to_scrstr(i1 zeroext ${x})`);
                B.line(`store ptr ${r}, ptr ${slot}`);
                break;
              }
              case "bytes": {
                // Buffer.toString() IS the utf8 decode (Node's default
                // encoding) — the `Buffer | string` chunk idiom.
                const enc = host.internLiteral("utf8");
                const p = host.unionPeek(v.name);
                const r = B.tmp();
                host.declare(`declare ptr @scr_bytes_to_str(ptr, ptr)`);
                B.line(`${r} = call ptr @scr_bytes_to_str(ptr ${p}, ptr ${enc})`);
                B.line(`store ptr ${r}, ptr ${slot}`);
                break;
              }
              default:
                throw new LlvmUnsupportedError(`toString:union:${arm.kind}`, e.loc);
            }
            B.br(join);
          });
          B.startBlock(join);
          const t = B.tmp();
          B.line(`${t} = load ptr, ptr ${slot}`);
          return host.own({ name: t, type: e.type });
        }
        if (v.type.kind === "record") {
          // String(record) / `${record}`: Object.prototype.toString's
          // constant — the interned literal, retained like a strLit.
          const sym = host.internLiteral("[object Object]");
          return host.own({ name: host.retainValue(sym, e.type), type: e.type });
        }
        if (v.type.kind === "caught") {
          // String(e) / `${e}` on a catch binding: JS's String() over the
          // snapshot (scr_caught_to_string — borrows the box, +1 result).
          host.declare(`declare ptr @scr_caught_to_string(ptr)`);
          const t = B.tmp();
          B.line(`${t} = call ptr @scr_caught_to_string(ptr ${v.name})`);
          return host.own({ name: t, type: e.type });
        }
        if (v.type.kind === "dyn") {
          // String(unknown): dispatch over the dyn kind (dyn.ts's sc_ds —
          // Node's String() incl. arrays-join and "[object Object]").
          const helper = host.dyn.dynToStrHelper();
          const t = B.tmp();
          B.line(`${t} = call ptr @${helper}(ptr ${v.name})`);
          return host.own({ name: t, type: e.type });
        }
        const t = B.tmp();
        if (v.type.kind === "f64") {
          host.declare(`declare ptr @scr_f64_to_scrstr(double)`);
          B.line(`${t} = call ptr @scr_f64_to_scrstr(double ${v.name})`);
        } else if (v.type.kind === "bool") {
          host.declare(`declare ptr @scr_bool_to_scrstr(i1 zeroext)`);
          B.line(`${t} = call ptr @scr_bool_to_scrstr(i1 zeroext ${v.name})`);
        } else {
          throw new LlvmUnsupportedError(`toString:${v.type.kind}`, e.loc);
        }
        return host.own({ name: t, type: e.type });
      }
      case "strIntrinsic":
        return host.emitStrIntrinsic(e);
      case "regexLit": {
        // One immortal static per (pattern, flags) pair; the +1 retain is
        // a no-op on immortals but keeps the owned-temps discipline
        // uniform. Pattern/flags strings intern NOW (the literal table is
        // still open — the C emitter's regex-literal discipline).
        const key = `${e.flags}/${e.pattern}`;
        let re = host.regexInstances.get(key);
        if (!re) {
          re = {
            sym: `sc_re_${host.regexInstances.size}`,
            src: host.internLiteral(e.pattern),
            fl: host.internLiteral(e.flags),
          };
          host.regexInstances.set(key, re);
        }
        return host.own({ name: host.retainValue(`@${re.sym}`, e.type), type: e.type });
      }
      case "templateStrings": {
        // One immortal static string array per template SITE (the key);
        // the +1 retain is a no-op on immortals. Cooked strings intern
        // NOW (the literal table is still open).
        let inst = host.templateStringsInstances.get(e.key);
        if (!inst) {
          inst = {
            sym: `sc_tsa_${host.templateStringsInstances.size}`,
            slots: e.cooked.map((s) => host.internLiteral(s)),
          };
          host.templateStringsInstances.set(e.key, inst);
        }
        return host.own({ name: host.retainValue(`@${inst.sym}`, e.type), type: e.type });
      }
      case "regexIntrinsic":
        return host.emitRegexIntrinsic(e);
      default: {
        const _exhaustive: never = e;
        void _exhaustive;
        throw new InternalCompilerError("unreachable");
      }
    }
  }

export function emitContainerExpr(host: LlvmEmitterContext, e: ExprOf<"arrayLit" | "arrayNewLen" | "arrayGet" | "arrIntrinsic" | "bytesNew" | "bytesIntrinsic" | "mapNew" | "mapIntrinsic" | "setIntrinsic" | "setNew">): LlValue {
    const B = host.B;
    switch (e.kind) {
      case "arrayLit": {
        // Allocate, then push each element in order. Ownership of refcounted
        // plain elements moves into the array; SPREAD positions hold a
        // same-typed source array (borrowed): its elements copy in —
        // _get_ref returns +1 and _push_ref takes ownership, RC-balanced;
        // the length is snapshotted before the loop.
        if (e.type.kind !== "array") throw new InternalCompilerError("llvm emitter bug: arrayLit of non-array type");
        const elem = e.type.elem;
        const arr = B.tmp();
        B.line(`${arr} = ${arrNewCall(host, elem, String(e.elems.length))}`);
        const out = host.own({ name: arr, type: e.type });
        const acc = elemAccess(elem);
        const spreadSet = new Set(e.spreads ?? []);
        e.elems.forEach((el, i) => {
          const v = host.emitExpr(el);
          if (spreadSet.has(i)) {
            host.emitArrayCopyLoop(arr, v.name, acc);
            return;
          }
          if (acc === "ref") host.moveTemp(v);
          host.arrPush(arr, acc, v.name);
        });
        return out;
      }
      case "arrayNewLen": {
        // Mapper-less Array.from({ length: n }): a length-n array of
        // ABSENT slots — the interned undefined arm for unions carrying
        // one (immortal: pushing owes no retain), NULL for every other ref
        // element kind. The `i <= n - 1` bound is ToLength for the lengths
        // that terminate: fractions truncate, negative/NaN → empty.
        if (e.type.kind !== "array") throw new InternalCompilerError("llvm emitter bug: arrayNewLen of non-array type");
        const elem = e.type.elem;
        const n = host.emitExpr(e.length);
        const arr = B.tmp();
        B.line(`${arr} = ${arrNewCall(host, elem, "0")}`);
        const out = host.own({ name: arr, type: e.type });
        const acc = elemAccess(elem);
        let fill = acc === "f64" ? f64Lit(0) : acc === "bool" ? "false" : "null";
        if (elem.kind === "union") {
          const tag = undefinedArmTag(elem, host.unionsById);
          if (tag >= 0) fill = host.unitInstanceRef(elem.unionId, tag);
        }
        const bound = B.tmp();
        B.line(`${bound} = fsub double ${n.name}, ${f64Lit(1)}`);
        B.countedLoop(bound, () => host.arrPush(arr, acc, fill), "ole");
        return out;
      }
      case "arrayGet": {
        const arr = host.emitExpr(e.arr);
        const idx = host.emitExpr(e.index);
        if (e.arr.type.kind !== "array") throw new InternalCompilerError("llvm emitter bug: arrayGet on non-array");
        // Ref-element reads return +1 (the runtime retains); own registers
        // the owned temp in the frame like any other.
        const acc = elemAccess(e.arr.type.elem);
        const accTy = acc === "f64" ? "double" : acc === "bool" ? "i1" : "ptr";
        host.declare(`declare ${acc === "bool" ? "zeroext i1" : accTy} @scr_arr_get_${acc}(ptr, double)`);
        const t = B.tmp();
        B.line(`${t} = call ${accTy} @scr_arr_get_${acc}(ptr ${arr.name}, double ${idx.name})`);
        return host.own({ name: t, type: e.type });
      }
      case "arrIntrinsic":
        return host.emitArrIntrinsic(e);
      case "bytesNew": {
        // Typed-array/Buffer construction; the SOURCE's static type picks
        // the runtime entry. The source is borrowed; every form hands
        // back +1. Only the f64 (length) form can throw (Node's "Invalid
        // typed array length" RangeError) — pending check after the temp
        // joins its frame.
        if (e.type.kind !== "bytes") throw new InternalCompilerError("llvm emitter bug: bytesNew of non-bytes type");
        const kind = BYTES_ELEM_NUM[e.type.elem];
        if (!e.source) {
          host.declare(`declare ptr @scr_bytes_new(i32, double)`);
          const t = B.tmp();
          B.line(`${t} = call ptr @scr_bytes_new(i32 ${kind}, double ${f64Lit(0)})`);
          return host.own({ name: t, type: e.type });
        }
        const src = host.emitExpr(e.source);
        const t = B.tmp();
        if (e.source.type.kind === "f64") {
          host.declare(`declare ptr @scr_bytes_new(i32, double)`);
          B.line(`${t} = call ptr @scr_bytes_new(i32 ${kind}, double ${src.name})`);
          const out = host.own({ name: t, type: e.type });
          host.emitPendingCheck();
          return out;
        }
        if (e.source.type.kind === "bytes") {
          host.declare(`declare ptr @scr_bytes_copy(ptr)`);
          B.line(`${t} = call ptr @scr_bytes_copy(ptr ${src.name})`);
          return host.own({ name: t, type: e.type });
        }
        if (e.source.type.kind === "array") {
          host.declare(`declare ptr @scr_bytes_from_arr(i32, ptr)`);
          B.line(`${t} = call ptr @scr_bytes_from_arr(i32 ${kind}, ptr ${src.name})`);
          return host.own({ name: t, type: e.type });
        }
        throw new InternalCompilerError(`llvm emitter bug: bytesNew source of kind ${e.source.type.kind}`);
      }
      case "bytesIntrinsic":
        return host.emitBytesIntrinsic(e);
      case "mapNew":
        return host.emitMapNew(e);
      case "mapIntrinsic":
      case "setIntrinsic":
        return host.emitMapLikeIntrinsic(e);
      case "setNew":
        return host.emitSetNew(e);
      default: {
        const _exhaustive: never = e;
        void _exhaustive;
        throw new InternalCompilerError("unreachable");
      }
    }
  }

export function emitRecordExpr(host: LlvmEmitterContext, e: ExprOf<"fieldGet" | "recordGet" | "recordLit" | "recordClone" | "recordKeyGet" | "recordOvfKeys">): LlValue {
    const B = host.B;
    switch (e.kind) {
      case "fieldGet": {
        const obj = host.emitExpr(e.obj);
        const { ptr, type } = host.classFieldPtr(obj.name, e.className, e.field);
        const v = host.loadField(ptr, type);
        if (isRefCounted(e.type)) return host.own({ name: host.retainValue(v, e.type), type: e.type });
        return { name: v, type: e.type };
      }
      case "recordGet": {
        const obj = host.emitExpr(e.obj);
        const { ptr, type } = host.recordFieldPtr(obj.name, e.shapeId, e.field);
        const v = host.loadField(ptr, type);
        if (isRefCounted(e.type)) return host.own({ name: host.retainValue(v, e.type), type: e.type });
        return { name: v, type: e.type };
      }
      case "recordLit": {
        // Allocate (fields zeroed), then write each field IN SOURCE ORDER —
        // JS evaluates property values in source order. Ownership of
        // refcounted values moves in; the struct is fresh, so there is
        // never an old value to release. OVERFLOW entries insert into the
        // shape's overflow map in the same interleaved order.
        if (e.type.kind !== "record") throw new InternalCompilerError("llvm emitter bug: recordLit of non-record type");
        const shapeId = e.type.shapeId;
        const rec = B.tmp();
        B.line(`${rec} = call ptr @${mangleRecordNew(shapeId)}()`);
        const out = host.own({ name: rec, type: e.type });
        for (const f of e.fields) {
          if (f.drop) {
            // A mapping-dropped field: the initializer runs in its source-
            // order slot — effects included — and the result (if any)
            // releases with the statement frame instead of storing.
            host.emitExpr(f.value);
            continue;
          }
          const v = host.emitExpr(f.value);
          if (f.overflow) {
            const lit = host.internLiteral(f.name);
            const acc = v.type.kind === "f64" ? "f64" : v.type.kind === "bool" ? "bool" : "ref";
            if (acc === "ref") host.moveTemp(v);
            const ovf = host.recordOvfPtr(rec, shapeId);
            const argTy = acc === "f64" ? "double" : acc === "bool" ? "i1 zeroext" : "ptr";
            host.declare(`declare void @scr_map_set_str_${acc}(ptr, ptr, ${argTy})`);
            B.line(
              `call void @scr_map_set_str_${acc}(ptr ${ovf}, ptr ${lit}, ${argTy === "i1 zeroext" ? "i1" : argTy} ${v.name})`,
            );
            continue;
          }
          if (isRefCounted(v.type)) host.moveTemp(v);
          const { ptr, type } = host.recordFieldPtr(rec, shapeId, f.name);
          host.storeField(ptr, type, v.name);
        }
        return out;
      }
      case "recordClone": {
        if (e.type.kind !== "record") throw new InternalCompilerError("llvm emitter bug: recordClone of non-record type");
        host.recordCloneShapes.add(e.type.shapeId);
        const source = host.emitExpr(e.source);
        const rec = B.tmp();
        B.line(`${rec} = call ptr @${mangleRecordClone(e.type.shapeId)}(ptr ${source.name})`);
        const out = host.own({ name: rec, type: e.type });
        for (const f of e.overrides) {
          const v = host.emitExpr(f.value);
          const { ptr, type } = host.recordFieldPtr(rec, e.type.shapeId, f.name);
          if (isRefCounted(type)) {
            host.moveTemp(v);
            const old = B.tmp();
            B.line(`${old} = load ptr, ptr ${ptr}`);
            host.storeField(ptr, type, v.name);
            host.releaseValue(old, type);
          } else {
            host.storeField(ptr, type, v.name);
          }
        }
        return out;
      }
      case "recordKeyGet":
        return host.emitRecordKeyGet(e);
      case "recordOvfKeys": {
        // The overflow map's live keys in JS own-key order — a fresh
        // string[] snapshot (+1); the record is borrowed.
        const obj = host.emitExpr(e.obj);
        const ovf = host.recordOvfPtr(obj.name, e.shapeId);
        host.declare(`declare ptr @scr_map_keys_js_order(ptr)`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_map_keys_js_order(ptr ${ovf})`);
        return host.own({ name: t, type: e.type });
      }
      default: {
        const _exhaustive: never = e;
        void _exhaustive;
        throw new InternalCompilerError("unreachable");
      }
    }
  }
