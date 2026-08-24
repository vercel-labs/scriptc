/* Focused LLVM expression emission extracted from emitter.ts. */
import { InternalCompilerError } from "../../errors.js";
import { undefinedArmTag } from "../../ir/analysis.js";
import { IrExpr, IrType, isRefCounted, SrcLoc, typeEquals } from "../../ir/ir.js";
import { LlvmUnsupportedError } from "./unsupported.js";
import type { LlvmEmitterContext, LlValue } from "./expr-context.js";
import { f64Lit } from "./common.js";

export function emitRegexIntrinsic(host: LlvmEmitterContext, e: IrExpr & { kind: "regexIntrinsic" }): LlValue {
    const B = host.B;
    const method = e.method;
    const r = host.emitExpr(e.receiver);
    const args = e.args.map((a) => host.emitExpr(a));
    const fallible = (sym: string, argText: string): LlValue => {
      host.declare(`declare ptr @${sym}(${argText.split(", ").map(() => "ptr").join(", ")})`);
      const t = B.tmp();
      B.line(`${t} = call ptr @${sym}(${argText})`);
      const out = host.own({ name: t, type: e.type });
      host.emitPendingCheck();
      return out;
    };
    switch (method) {
      case "matchAll":
        // Every match drained eagerly into a fresh +1 string[][]; throws
        // Node's TypeError on a non-global regex (catchable).
        return fallible("scr_regex_match_all", `ptr ${r.name}, ptr ${args[0]!.name}`);
      case "matchAllInto":
        // matchAll's companion-index form: args[1] (a number[]) also
        // receives each match's UTF-16 start index.
        return fallible("scr_regex_match_all_into", `ptr ${r.name}, ptr ${args[0]!.name}, ptr ${args[1]!.name}`);
      case "replaceAll":
        return fallible("scr_regex_replace_all", `ptr ${r.name}, ptr ${args[0]!.name}, ptr ${args[1]!.name}`);
      case "split":
        host.declare(`declare ptr @scr_regex_split_limit(ptr, ptr, double)`);
        {
          const t = B.tmp();
          B.line(
            `${t} = call ptr @scr_regex_split_limit(ptr ${r.name}, ptr ${args[0]!.name}, double ${args[1]!.name})`,
          );
          const out = host.own({ name: t, type: e.type });
          host.emitPendingCheck();
          return out;
        }
      case "test": {
        host.declare(`declare zeroext i1 @scr_regex_test(ptr, ptr)`);
        const t = B.tmp();
        B.line(`${t} = call zeroext i1 @scr_regex_test(ptr ${r.name}, ptr ${args[0]!.name})`);
        return { name: t, type: e.type };
      }
      case "match": {
        // +1 string[] or NULL from the runtime; the `string[] | null`
        // union wraps type-directedly, the envGet convention.
        if (e.type.kind !== "union") throw new InternalCompilerError("llvm emitter bug: match result not a union");
        const def = host.unionsById.get(e.type.unionId);
        const arrTag = def ? def.arms.findIndex((a) => a.kind === "array") : -1;
        const nullTag = def ? def.arms.findIndex((a) => a.kind === "nullT") : -1;
        if (arrTag < 0 || nullTag < 0 || !def) throw new InternalCompilerError("llvm emitter bug: match union lacks its arms");
        host.declare(`declare ptr @scr_regex_match(ptr, ptr)`);
        const raw = B.tmp();
        B.line(`${raw} = call ptr @scr_regex_match(ptr ${r.name}, ptr ${args[0]!.name})`);
        return host.wrapNullable(raw, raw, def.arms[arrTag]!, arrTag, e.type, nullTag);
      }
      case "search": {
        host.declare(`declare double @scr_regex_search(ptr, ptr)`);
        const t = B.tmp();
        B.line(`${t} = call double @scr_regex_search(ptr ${r.name}, ptr ${args[0]!.name})`);
        return { name: t, type: e.type };
      }
      case "source": {
        host.declare(`declare ptr @scr_regex_source(ptr)`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_regex_source(ptr ${r.name})`);
        return host.own({ name: t, type: e.type });
      }
      case "flags": {
        host.declare(`declare ptr @scr_regex_flags(ptr)`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_regex_flags(ptr ${r.name})`);
        return host.own({ name: t, type: e.type });
      }
      case "replace": {
        host.declare(`declare ptr @scr_regex_replace(ptr, ptr, ptr)`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_regex_replace(ptr ${r.name}, ptr ${args[0]!.name}, ptr ${args[1]!.name})`);
        return host.own({ name: t, type: e.type });
      }
      default: {
        const _exhaustive: never = method;
        void _exhaustive;
        throw new InternalCompilerError("unreachable");
      }
    }
  }

export function emitRecordKeyGet(host: LlvmEmitterContext, e: IrExpr & { kind: "recordKeyGet" }): LlValue {
    const B = host.B;
    const obj = host.emitExpr(e.obj);
    const k = host.emitExpr(e.key);
    const ty = host.llType(e.type);
    const slot = B.slot();
    B.entryAllocas.push(`${slot} = alloca ${ty}`);
    const join = B.newLabel("rkg.j");
    host.keyedRecordReadInto(slot, join, obj.name, k.name, e.shapeId, e.type, e.overflowOnly === true, e.loc);
    B.startBlock(join);
    const t = B.tmp();
    B.line(`${t} = load ${ty}, ptr ${slot}`);
    return host.own({ name: t, type: e.type });
  }

export function keyedRecordReadInto(host: LlvmEmitterContext,
    slot: string,
    join: string,
    objName: string,
    keyName: string,
    shapeId: string,
    resultType: IrType,
    overflowOnly: boolean,
    loc?: SrcLoc,
  ): void {
    const B = host.B;
    const shape = host.recordShape(shapeId);
    if (resultType.kind === "dyn") {
      // A dyn JOIN (the C helper's `surface` dyn arm): declared hits
      // convert through the per-type toDyn walker (borrowed read → fresh
      // +1 tree), a dyn-valued overflow hit passes through (+1 from the
      // map get), and a miss is JS's undefined — the dyn singleton.
      host.declare(`declare zeroext i1 @scr_str_eq(ptr, ptr)`);
      for (const f of overflowOnly ? [] : shape.fields) {
        const lit = host.internLiteral(f.name);
        const hit = B.tmp();
        B.line(`${hit} = call zeroext i1 @scr_str_eq(ptr ${keyName}, ptr ${lit}) ; ${f.name}`);
        const lh = B.newLabel("rkg.h");
        const ln = B.newLabel("rkg.n");
        B.condBr(hit, lh, ln);
        B.startBlock(lh);
        const { ptr, type } = host.recordFieldPtr(objName, shapeId, f.name);
        const v = host.loadField(ptr, type);
        if (type.kind === "dyn") {
          host.declare(`declare ptr @scr_dyn_retain_v(ptr)`);
          const r = B.tmp();
          B.line(`${r} = call ptr @scr_dyn_retain_v(ptr ${v})`);
          B.line(`store ptr ${r}, ptr ${slot}`);
        } else {
          const conv = host.dyn.toDynHelper(type);
          const vTy = type.kind === "f64" ? "double" : type.kind === "bool" ? "i1" : "ptr";
          const r = B.tmp();
          B.line(`${r} = call ptr @${conv}(${vTy} ${v})`);
          B.line(`store ptr ${r}, ptr ${slot}`);
        }
        B.br(join);
        B.startBlock(ln);
      }
      const iv = shape.indexValue;
      if (iv && (iv.kind === "f64" || iv.kind === "bool")) {
        // Scalar overflow under a dyn join: the hit converts through the
        // toDyn box (the C `surface(iv, hit, true)` with t dyn).
        const ovf = host.recordOvfPtr(objName, shapeId);
        const outTy = iv.kind === "f64" ? "double" : "i8";
        const outSlot = B.slot();
        B.entryAllocas.push(`${outSlot} = alloca ${outTy}`);
        B.line(`store ${outTy} ${iv.kind === "f64" ? f64Lit(0) : "0"}, ptr ${outSlot}`);
        host.declare(`declare zeroext i1 @scr_map_get_str_${iv.kind === "f64" ? "f64" : "bool"}(ptr, ptr, ptr)`);
        const found = B.tmp();
        B.line(`${found} = call zeroext i1 @scr_map_get_str_${iv.kind === "f64" ? "f64" : "bool"}(ptr ${ovf}, ptr ${keyName}, ptr ${outSlot})`);
        const lh = B.newLabel("rkg.h");
        const ln = B.newLabel("rkg.n");
        B.condBr(found, lh, ln);
        B.startBlock(lh);
        const rawOut = B.tmp();
        B.line(`${rawOut} = load ${outTy}, ptr ${outSlot}`);
        let hitVal = rawOut;
        if (iv.kind === "bool") {
          hitVal = B.tmp();
          B.line(`${hitVal} = trunc i8 ${rawOut} to i1`);
        }
        const conv = host.dyn.toDynHelper(iv);
        const r = B.tmp();
        B.line(`${r} = call ptr @${conv}(${iv.kind === "f64" ? "double" : "i1"} ${hitVal})`);
        B.line(`store ptr ${r}, ptr ${slot}`);
        B.br(join);
        B.startBlock(ln);
      } else if (iv) {
        if (iv.kind !== "dyn") {
          // The C helper's emitter-bug arm: a non-dyn REF overflow can
          // never join at dyn (the frontend fences it).
          throw new LlvmUnsupportedError(`recordKeyGet:narrow:${iv.kind}`, loc);
        }
        const ovf = host.recordOvfPtr(objName, shapeId);
        host.declare(`declare ptr @scr_map_get_str_ref(ptr, ptr)`);
        const raw = B.tmp();
        const isnull = B.tmp();
        B.line(`${raw} = call ptr @scr_map_get_str_ref(ptr ${ovf}, ptr ${keyName})`);
        B.line(`${isnull} = icmp eq ptr ${raw}, null`);
        const lh = B.newLabel("rkg.h");
        const ln = B.newLabel("rkg.n");
        B.condBr(isnull, ln, lh);
        B.startBlock(lh);
        B.line(`store ptr ${raw}, ptr ${slot} ; get returned +1`);
        B.br(join);
        B.startBlock(ln);
      }
      // The miss path: JS's undefined — the dyn singleton, retained.
      host.declare(`declare ptr @scr_dyn_undefined()`);
      host.declare(`declare ptr @scr_dyn_retain_v(ptr)`);
      const u = B.tmp();
      const r = B.tmp();
      B.line(`${u} = call ptr @scr_dyn_undefined()`);
      B.line(`${r} = call ptr @scr_dyn_retain_v(ptr ${u})`);
      B.line(`store ptr ${r}, ptr ${slot}`);
      B.br(join);
      return;
    }
    const undefTag = resultType.kind === "union"
      ? undefinedArmTag(resultType, host.unionsById)
      : -1;
    const def = resultType.kind === "union" && undefTag >= 0
      ? host.unionsById.get(resultType.unionId)!
      : null;
    const ty = host.llType(resultType);
    // How a hit of type `vt` surfaces at the requested result type (the C
    // helper's `surface`). Direct results require an exact type and retain
    // borrowed references; union results pass an identical union through
    // or wrap the matching arm. Owned map reads always move into the result.
    const surface = (vt: IrType, expr: string, owned: boolean): string => {
      if (def === null) {
        if (!typeEquals(vt, resultType)) {
          throw new LlvmUnsupportedError(`recordKeyGet:narrow:${vt.kind}`, loc);
        }
        return owned || !isRefCounted(vt) ? expr : host.retainValue(expr, vt);
      }
      if (typeEquals(vt, resultType)) {
        return owned ? expr : host.retainValue(expr, vt);
      }
      const tag = def.arms.findIndex((a) => typeEquals(a, vt));
      if (tag < 0) throw new InternalCompilerError(`llvm emitter bug: keyed read arm for ${vt.kind} missing`);
      if (vt.kind === "f64" || vt.kind === "bool") {
        return host.unionNewOwned(tag, { name: expr, type: vt });
      }
      const payload = owned ? expr : host.retainValue(expr, vt);
      return host.unionNewOwned(tag, { name: payload, type: vt });
    };
    host.declare(`declare zeroext i1 @scr_str_eq(ptr, ptr)`);
    for (const f of overflowOnly ? [] : shape.fields) {
      const lit = host.internLiteral(f.name);
      const hit = B.tmp();
      B.line(`${hit} = call zeroext i1 @scr_str_eq(ptr ${keyName}, ptr ${lit}) ; ${f.name}`);
      const lh = B.newLabel("rkg.h");
      const ln = B.newLabel("rkg.n");
      B.condBr(hit, lh, ln);
      B.startBlock(lh);
      const { ptr, type } = host.recordFieldPtr(objName, shapeId, f.name);
      B.line(`store ${ty} ${surface(type, host.loadField(ptr, type), false)}, ptr ${slot}`);
      B.br(join);
      B.startBlock(ln);
    }
    const iv = shape.indexValue;
    if (iv) {
      const ovf = host.recordOvfPtr(objName, shapeId);
      if (iv.kind === "f64" || iv.kind === "bool") {
        const outTy = iv.kind === "f64" ? "double" : "i8";
        const outSlot = B.slot();
        B.entryAllocas.push(`${outSlot} = alloca ${outTy}`);
        B.line(`store ${outTy} ${iv.kind === "f64" ? f64Lit(0) : "0"}, ptr ${outSlot}`);
        host.declare(`declare zeroext i1 @scr_map_get_str_${iv.kind === "f64" ? "f64" : "bool"}(ptr, ptr, ptr)`);
        const found = B.tmp();
        B.line(`${found} = call zeroext i1 @scr_map_get_str_${iv.kind === "f64" ? "f64" : "bool"}(ptr ${ovf}, ptr ${keyName}, ptr ${outSlot})`);
        const lh = B.newLabel("rkg.h");
        const ln = B.newLabel("rkg.n");
        B.condBr(found, lh, ln);
        B.startBlock(lh);
        const rawOut = B.tmp();
        B.line(`${rawOut} = load ${outTy}, ptr ${outSlot}`);
        let hitVal = rawOut;
        if (iv.kind === "bool") {
          hitVal = B.tmp();
          B.line(`${hitVal} = trunc i8 ${rawOut} to i1`);
        }
        B.line(`store ${ty} ${surface(iv, hitVal, true)}, ptr ${slot}`);
        B.br(join);
        B.startBlock(ln);
      } else {
        host.declare(`declare ptr @scr_map_get_str_ref(ptr, ptr)`);
        const raw = B.tmp();
        const isnull = B.tmp();
        B.line(`${raw} = call ptr @scr_map_get_str_ref(ptr ${ovf}, ptr ${keyName})`);
        B.line(`${isnull} = icmp eq ptr ${raw}, null`);
        const lh = B.newLabel("rkg.h");
        const ln = B.newLabel("rkg.n");
        B.condBr(isnull, ln, lh);
        B.startBlock(lh);
        B.line(`store ${ty} ${surface(iv, raw, true)}, ptr ${slot}`);
        B.br(join);
        B.startBlock(ln);
      }
    }
    if (def !== null && resultType.kind === "union") {
      // The miss path: the result union's undefined arm.
      B.line(`store ptr ${host.unitInstanceRef(resultType.unionId, undefTag)}, ptr ${slot}`);
      B.br(join);
      return;
    }
    // A direct result cannot represent a miss. This is unreachable for
    // programs whose behavior matches Node, but keep the C backend's trap.
    host.needsBadKey = true;
    B.line(`call void @sc_bad_key()`);
    B.terminate(`unreachable`);
  }
