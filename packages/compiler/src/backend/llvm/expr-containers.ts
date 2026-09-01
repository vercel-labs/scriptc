/* Focused LLVM expression emission extracted from emitter.ts. */
import { InternalCompilerError } from "../../errors.js";
import { undefinedArmTag } from "../../ir/analysis.js";
import { IrExpr, IrType, isRefCounted, typeEquals, typeKey } from "../../ir/ir.js";
import { mangleResolveThunk } from "../mangle.js";
import { elemAccess, FN_ATTRS, mapKeyAccess, mapKeyKindNum, mapValKindNum, traceArg, vAdapters } from "./shapes.js";
import type { LlvmEmitterContext, LlValue } from "./expr-context.js";
import { F64_INF, f64Lit } from "./common.js";

export function resolveThunkFor(host: LlvmEmitterContext, inner: IrType): string {
    const key = typeKey(inner);
    let sym = host.resolveThunks.get(key);
    if (!sym) {
      sym = mangleResolveThunk(host.resolveThunks.size);
      host.resolveThunks.set(key, sym);
      const v = vAdapters(host, inner);
      host.declare(`declare void @scr_resolve_ref_impl(ptr, ptr, ptr, ptr, ptr)`);
      host.resolveThunkDefs.push(
        `define internal void @${sym}(ptr %self, ptr %v) ${FN_ATTRS} { ; resolve<${key}>`,
        `entry:`,
        `  call void @scr_resolve_ref_impl(ptr %self, ptr %v, ptr ${v.retain}, ptr ${v.release}, ptr ${traceArg(host, inner)})`,
        `  ret void`,
        `}`,
        ``,
      );
    }
    return sym;
  }

export function tagInSet(host: LlvmEmitterContext, uName: string, tags: number[]): string {
    const B = host.B;
    const tag = host.unionTag(uName);
    let acc = "";
    for (const t of tags) {
      const c = B.tmp();
      B.line(`${c} = icmp eq i32 ${tag}, ${t}`);
      if (acc === "") {
        acc = c;
      } else {
        const o = B.tmp();
        B.line(`${o} = or i1 ${acc}, ${c}`);
        acc = o;
      }
    }
    return acc;
  }

export function arrPush(host: LlvmEmitterContext, arr: string, acc: "f64" | "bool" | "ref", value: string): string {
    const argTy = acc === "f64" ? "double" : acc === "bool" ? "i1" : "ptr";
    host.declare(`declare double @scr_arr_push_${acc}(ptr, ${argTy === "i1" ? "i1 zeroext" : argTy})`);
    const t = host.B.tmp();
    host.B.line(`${t} = call double @scr_arr_push_${acc}(ptr ${arr}, ${argTy} ${value})`);
    return t;
  }

export function emitArrayCopyLoop(host: LlvmEmitterContext, dst: string, src: string, acc: "f64" | "bool" | "ref"): void {
    const B = host.B;
    host.declare(`declare double @scr_arr_len(ptr)`);
    const accTy = acc === "f64" ? "double" : acc === "bool" ? "i1" : "ptr";
    host.declare(`declare ${acc === "bool" ? "zeroext i1" : accTy} @scr_arr_get_${acc}(ptr, double)`);
    const len = B.tmp();
    B.line(`${len} = call double @scr_arr_len(ptr ${src})`);
    B.countedLoop(len, (i) => {
      const v = B.tmp();
      B.line(`${v} = call ${accTy} @scr_arr_get_${acc}(ptr ${src}, double ${i})`);
      host.arrPush(dst, acc, v);
    });
  }

export function emitStrIntrinsic(host: LlvmEmitterContext, e: IrExpr & { kind: "strIntrinsic" }): LlValue {
    // Receiver and string arguments are owned temps in the current frame;
    // every scr_str_* method BORROWS them. String/array-returning methods
    // hand back a +1 reference, which own() registers like any other.
    // Omitted optional args get the C-side defaults from docs/ir.md.
    const B = host.B;
    const r = host.emitExpr(e.receiver);
    const args = e.args.map((a) => host.emitExpr(a));
    const call = (sym: string, sig: string, argText: string, retTy: string, owned: boolean): LlValue => {
      // sig reads "<ret> (<params>)" — respelled to LLVM's declare form.
      const m = /^(.+?) \((.*)\)$/.exec(sig);
      if (!m) throw new InternalCompilerError(`llvm emitter bug: bad strIntrinsic sig ${sig}`);
      host.declare(`declare ${m[1]} @${sym}(${m[2]})`);
      const t = B.tmp();
      B.line(`${t} = call ${retTy} @${sym}(${argText})`);
      return owned ? host.own({ name: t, type: e.type }) : { name: t, type: e.type };
    };
    const method = e.method;
    switch (method) {
      case "length":
        return call("scr_str_utf16_len", "double (ptr)", `ptr ${r.name}`, "double", false);
      case "charCodeAt":
        return call("scr_str_char_code_at", "double (ptr, double)", `ptr ${r.name}, double ${args[0]!.name}`, "double", false);
      case "charAt":
        return call("scr_str_char_at", "ptr (ptr, double)", `ptr ${r.name}, double ${args[0]!.name}`, "ptr", true);
      case "indexOf":
        return call(
          "scr_str_index_of",
          "double (ptr, ptr, double)",
          `ptr ${r.name}, ptr ${args[0]!.name}, double ${args[1]?.name ?? f64Lit(0)}`,
          "double",
          false,
        );
      case "includes": {
        if (args[1]) {
          // The position form is indexOf's clamp exactly: found ⇔ != -1.
          const idx = call(
            "scr_str_index_of",
            "double (ptr, ptr, double)",
            `ptr ${r.name}, ptr ${args[0]!.name}, double ${args[1].name}`,
            "double",
            false,
          );
          const t = B.tmp();
          B.line(`${t} = fcmp une double ${idx.name}, ${f64Lit(-1)}`);
          return { name: t, type: e.type };
        }
        return call("scr_str_includes", "zeroext i1 (ptr, ptr)", `ptr ${r.name}, ptr ${args[0]!.name}`, "i1", false);
      }
      case "startsWith":
        return call("scr_str_starts_with", "zeroext i1 (ptr, ptr)", `ptr ${r.name}, ptr ${args[0]!.name}`, "i1", false);
      case "endsWith":
        return call("scr_str_ends_with", "zeroext i1 (ptr, ptr)", `ptr ${r.name}, ptr ${args[0]!.name}`, "i1", false);
      case "slice":
        return call(
          "scr_str_slice",
          "ptr (ptr, double, double)",
          `ptr ${r.name}, double ${args[0]?.name ?? f64Lit(0)}, double ${args[1]?.name ?? F64_INF}`,
          "ptr",
          true,
        );
      case "substring":
        return call(
          "scr_str_substring",
          "ptr (ptr, double, double)",
          `ptr ${r.name}, double ${args[0]!.name}, double ${args[1]?.name ?? F64_INF}`,
          "ptr",
          true,
        );
      case "repeat":
        return call("scr_str_repeat", "ptr (ptr, double)", `ptr ${r.name}, double ${args[0]!.name}`, "ptr", true);
      case "trim":
        return call("scr_str_trim", "ptr (ptr)", `ptr ${r.name}`, "ptr", true);
      case "trimStart":
        return call("scr_str_trim_start", "ptr (ptr)", `ptr ${r.name}`, "ptr", true);
      case "trimEnd":
        return call("scr_str_trim_end", "ptr (ptr)", `ptr ${r.name}`, "ptr", true);
      case "split":
        return call(
          "scr_str_split_limit",
          "ptr (ptr, ptr, double)",
          `ptr ${r.name}, ptr ${args[0]!.name}, double ${args[1]!.name}`,
          "ptr",
          true,
        );
      case "padStart":
        return call(
          "scr_str_pad_start",
          "ptr (ptr, double, ptr)",
          `ptr ${r.name}, double ${args[0]!.name}, ptr ${args[1]!.name}`,
          "ptr",
          true,
        );
      case "padEnd":
        return call(
          "scr_str_pad_end",
          "ptr (ptr, double, ptr)",
          `ptr ${r.name}, double ${args[0]!.name}, ptr ${args[1]!.name}`,
          "ptr",
          true,
        );
      case "toLowerCase":
        return call("scr_str_to_lower", "ptr (ptr)", `ptr ${r.name}`, "ptr", true);
      case "toUpperCase":
        return call("scr_str_to_upper", "ptr (ptr)", `ptr ${r.name}`, "ptr", true);
      // The well-formedness pair: no-ops over well-formed storage
      // (constant true / retained identity; scr_string.c).
      case "isWellFormed":
        return call("scr_str_is_well_formed", "zeroext i1 (ptr)", `ptr ${r.name}`, "i1", false);
      case "toWellFormed":
        return call("scr_str_to_well_formed", "ptr (ptr)", `ptr ${r.name}`, "ptr", true);
      case "cpAt":
        // The code point AT an index as a one-code-point string (+1) —
        // the string-for-of desugar's read.
        return call("scr_str_cp_at", "ptr (ptr, double)", `ptr ${r.name}, double ${args[0]!.name}`, "ptr", true);
      default: {
        const _exhaustive: never = method;
        void _exhaustive;
        throw new InternalCompilerError("unreachable");
      }
    }
  }

export function emitArrIntrinsic(host: LlvmEmitterContext, e: IrExpr & { kind: "arrIntrinsic" }): LlValue {
    const B = host.B;
    const r = host.emitExpr(e.receiver);
    if (e.receiver.type.kind !== "array") throw new InternalCompilerError("llvm emitter bug: arrIntrinsic on non-array");
    const elem = e.receiver.type.elem;
    const acc = elemAccess(elem);
    const accTy = acc === "f64" ? "double" : acc === "bool" ? "i1" : "ptr";
    const accArg = acc === "bool" ? "i1 zeroext" : accTy;
    const method = e.method;
    switch (method) {
      case "length": {
        host.declare(`declare double @scr_arr_len(ptr)`);
        const t = B.tmp();
        B.line(`${t} = call double @scr_arr_len(ptr ${r.name})`);
        return { name: t, type: e.type };
      }
      case "push": {
        // Variadic like JS: every argument evaluates first (left to
        // right), then each appends in order. Ownership of refcounted
        // arguments moves into the array; the result is the new length —
        // the last push's return, or the unchanged length for Node's
        // no-op zero-argument call.
        const vs = e.args.map((a) => host.emitExpr(a));
        if (acc === "ref") vs.forEach((v) => host.moveTemp(v));
        let last = "";
        for (const v of vs) last = host.arrPush(r.name, acc, v.name);
        if (last !== "") return { name: last, type: e.type };
        host.declare(`declare double @scr_arr_len(ptr)`);
        const t = B.tmp();
        B.line(`${t} = call double @scr_arr_len(ptr ${r.name})`);
        return { name: t, type: e.type };
      }
      case "pushSpread": {
        // `a.push(...src)`: append src's elements in order (borrowed src,
        // count snapshotted). Result: the new length.
        const src = host.emitExpr(e.args[0]!);
        host.emitArrayCopyLoop(r.name, src.name, acc);
        host.declare(`declare double @scr_arr_len(ptr)`);
        const t = B.tmp();
        B.line(`${t} = call double @scr_arr_len(ptr ${r.name})`);
        return { name: t, type: e.type };
      }
      case "unshift": {
        // Evaluate every argument before the first mutation, then insert
        // from right to left so the final front order is source order.
        const vs = e.args.map((a) => host.emitExpr(a));
        if (acc === "ref") vs.forEach((v) => host.moveTemp(v));
        host.declare(
          `declare double @scr_arr_unshift_${acc}(ptr, ${accArg})`,
        );
        let last = "";
        for (let i = vs.length - 1; i >= 0; i--) {
          last = B.tmp();
          B.line(
            `${last} = call double @scr_arr_unshift_${acc}(ptr ${r.name}, ${accTy} ${vs[i]!.name})`,
          );
        }
        if (last !== "") return { name: last, type: e.type };
        host.declare(`declare double @scr_arr_len(ptr)`);
        const t = B.tmp();
        B.line(`${t} = call double @scr_arr_len(ptr ${r.name})`);
        return { name: t, type: e.type };
      }
      case "unshiftSpread": {
        // The runtime snapshots the borrowed source and handles self-spread.
        const src = host.emitExpr(e.args[0]!);
        host.declare(`declare double @scr_arr_unshift_spread(ptr, ptr)`);
        const t = B.tmp();
        B.line(`${t} = call double @scr_arr_unshift_spread(ptr ${r.name}, ptr ${src.name})`);
        return { name: t, type: e.type };
      }
      case "pop": {
        // Ownership of a refcounted element moves OUT of the array to
        // this temp (+1 to us, the runtime does not release it).
        host.declare(`declare ${acc === "bool" ? "zeroext i1" : accTy} @scr_arr_pop_${acc}(ptr)`);
        const t = B.tmp();
        B.line(`${t} = call ${accTy} @scr_arr_pop_${acc}(ptr ${r.name})`);
        return host.own({ name: t, type: e.type });
      }
      case "indexOf": {
        // The needle is BORROWED (released with this statement's frame);
        // the ref variant dispatches on the array's element kind (strings
        // by content, everything else by pointer). Strict equality.
        const v = host.emitExpr(e.args[0]!);
        host.declare(`declare double @scr_arr_index_of_${acc}(ptr, ${accArg})`);
        const t = B.tmp();
        B.line(`${t} = call double @scr_arr_index_of_${acc}(ptr ${r.name}, ${accTy} ${v.name})`);
        return { name: t, type: e.type };
      }
      case "includes": {
        // Borrowed needle, SameValueZero (NaN matches NaN).
        const v = host.emitExpr(e.args[0]!);
        host.declare(`declare zeroext i1 @scr_arr_includes_${acc}(ptr, ${accArg})`);
        const t = B.tmp();
        B.line(`${t} = call zeroext i1 @scr_arr_includes_${acc}(ptr ${r.name}, ${accTy} ${v.name})`);
        return { name: t, type: e.type };
      }
      case "join": {
        // Separator borrowed; the result is an owned (+1) string. Union
        // elements ride the per-union join walker (nullish arms print
        // empty, everything else through the union ToString) — the C
        // emitter's sc_uj_*, ported in walkers.ts.
        const sep = host.emitExpr(e.args[0]!);
        if (elem.kind === "union") {
          const helper = host.walkers.unionJoinHelper(elem.unionId);
          const t = B.tmp();
          B.line(`${t} = call ptr @${helper}(ptr ${r.name}, ptr ${sep.name})`);
          return host.own({ name: t, type: e.type });
        }
        host.declare(`declare ptr @scr_arr_join(ptr, ptr)`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_arr_join(ptr ${r.name}, ptr ${sep.name})`);
        return host.own({ name: t, type: e.type });
      }
      case "slice": {
        // Receiver borrowed; the result a fresh +1 shallow copy (ref
        // elements retained). Omitted indices get the JS defaults.
        const start = e.args[0] ? host.emitExpr(e.args[0]).name : f64Lit(0);
        const end = e.args[1] ? host.emitExpr(e.args[1]).name : F64_INF;
        host.declare(`declare ptr @scr_arr_slice(ptr, double, double)`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_arr_slice(ptr ${r.name}, double ${start}, double ${end})`);
        return host.own({ name: t, type: e.type });
      }
      case "toReversed": {
        host.declare(`declare ptr @scr_arr_to_reversed(ptr)`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_arr_to_reversed(ptr ${r.name})`);
        return host.own({ name: t, type: e.type });
      }
      case "reverse": {
        // Mutates in place and returns the same receiver as a fresh +1.
        host.declare(`declare ptr @scr_arr_reverse(ptr)`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_arr_reverse(ptr ${r.name})`);
        return host.own({ name: t, type: e.type });
      }
      case "toSpliced": {
        const start = host.emitExpr(e.args[0]!);
        const count = host.emitExpr(e.args[1]!);
        const items = host.emitExpr(e.args[2]!);
        host.declare(`declare ptr @scr_arr_to_spliced(ptr, double, double, ptr)`);
        const t = B.tmp();
        B.line(
          `${t} = call ptr @scr_arr_to_spliced(ptr ${r.name}, double ${start.name}, ` +
            `double ${count.name}, ptr ${items.name})`,
        );
        return host.own({ name: t, type: e.type });
      }
      case "with": {
        const index = host.emitExpr(e.args[0]!);
        const value = host.emitExpr(e.args[1]!);
        host.declare(
          `declare ptr @scr_arr_with_${acc}(ptr, double, ${accArg})`,
        );
        const t = B.tmp();
        B.line(
          `${t} = call ptr @scr_arr_with_${acc}(ptr ${r.name}, double ${index.name}, ` +
            `${accTy} ${value.name})`,
        );
        const out = host.own({ name: t, type: e.type });
        host.emitPendingCheck();
        return out;
      }
      case "splice": {
        // Removed elements come back as a fresh +1 array, ownership MOVED
        // out of the receiver. Replacement arguments are evaluated into a
        // borrowed temporary array before the receiver is mutated. An
        // omitted count removes to the end (+Infinity, the slice convention).
        const start = host.emitExpr(e.args[0]!);
        const cnt = e.args[1] ? host.emitExpr(e.args[1]).name : F64_INF;
        if (e.args.length > 2) {
          const itemsExpr: IrExpr = {
            kind: "arrayLit",
            elems: e.args.slice(2),
            type: e.receiver.type,
            loc: e.loc,
          };
          const items = host.emitExpr(itemsExpr);
          host.declare(`declare ptr @scr_arr_splice_with_items(ptr, double, double, ptr)`);
          const t = B.tmp();
          B.line(
            `${t} = call ptr @scr_arr_splice_with_items(ptr ${r.name}, double ${start.name}, ` +
              `double ${cnt}, ptr ${items.name})`,
          );
          return host.own({ name: t, type: e.type });
        }
        host.declare(`declare ptr @scr_arr_splice(ptr, double, double)`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_arr_splice(ptr ${r.name}, double ${start.name}, double ${cnt})`);
        return host.own({ name: t, type: e.type });
      }
      case "shift": {
        // JS shift: undefined on an empty array, else the first element
        // out (ref ownership moves into the union box) with the tail
        // sliding down. Union construction is type-directed here.
        if (e.type.kind !== "union") throw new InternalCompilerError("llvm emitter bug: shift result is not a union");
        const def = host.unionsById.get(e.type.unionId);
        const tag = def ? def.arms.findIndex((a) => typeEquals(a, elem)) : -1;
        const undefTag = undefinedArmTag(e.type, host.unionsById);
        if (tag < 0 || undefTag < 0) throw new InternalCompilerError("llvm emitter bug: shift union lacks its arms");
        host.declare(`declare double @scr_arr_len(ptr)`);
        const slot = B.slot();
        B.entryAllocas.push(`${slot} = alloca ptr`);
        const len = B.tmp();
        const has = B.tmp();
        B.line(`${len} = call double @scr_arr_len(ptr ${r.name})`);
        B.line(`${has} = fcmp one double ${len}, ${f64Lit(0)}`);
        const lp = B.newLabel("shf.p");
        const la = B.newLabel("shf.a");
        const lj = B.newLabel("shf.j");
        B.condBr(has, lp, la);
        B.startBlock(lp);
        host.declare(`declare ${acc === "bool" ? "zeroext i1" : accTy} @scr_arr_shift_${acc}(ptr)`);
        const v = B.tmp();
        B.line(`${v} = call ${accTy} @scr_arr_shift_${acc}(ptr ${r.name})`);
        B.line(`store ptr ${host.unionNewOwned(tag, { name: v, type: elem })}, ptr ${slot}`);
        B.br(lj);
        B.startBlock(la);
        B.line(`store ptr ${host.unitInstanceRef(e.type.unionId, undefTag)}, ptr ${slot}`);
        B.br(lj);
        B.startBlock(lj);
        const t = B.tmp();
        B.line(`${t} = load ptr, ptr ${slot}`);
        return host.own({ name: t, type: e.type });
      }
      default: {
        const _exhaustive: never = method;
        void _exhaustive;
        throw new InternalCompilerError("unreachable");
      }
    }
  }

export function wrapNullable(host: LlvmEmitterContext, raw: string, present: string, valueType: IrType, valueTag: number, resultType: IrType & { kind: "union" }, absentTag: number): LlValue {
    const B = host.B;
    const slot = B.slot();
    B.entryAllocas.push(`${slot} = alloca ptr`);
    const isnull = B.tmp();
    B.line(`${isnull} = icmp eq ptr ${raw}, null`);
    const lp = B.newLabel("nw.p");
    const la = B.newLabel("nw.a");
    const lj = B.newLabel("nw.j");
    B.condBr(isnull, la, lp);
    B.startBlock(lp);
    B.line(`store ptr ${host.unionNewOwned(valueTag, { name: present, type: valueType })}, ptr ${slot}`);
    B.br(lj);
    B.startBlock(la);
    B.line(`store ptr ${host.unitInstanceRef(resultType.unionId, absentTag)}, ptr ${slot}`);
    B.br(lj);
    B.startBlock(lj);
    const t = B.tmp();
    B.line(`${t} = load ptr, ptr ${slot}`);
    return host.own({ name: t, type: resultType });
  }

export function emitMapNew(host: LlvmEmitterContext, e: IrExpr & { kind: "mapNew" }): LlValue {
    // Empty map: the runtime stores the value kind's RC entry points as
    // function pointers (scalar values pass nulls); the trace argument
    // doubles as the cycle-capability flag — exactly the C mapNew.
    if (e.type.kind !== "map") throw new InternalCompilerError("llvm emitter bug: mapNew of non-map type");
    const B = host.B;
    const value = e.type.value;
    const rc = isRefCounted(value) ? vAdapters(host, value) : { retain: "null", release: "null" };
    host.declare(`declare ptr @scr_map_new(i32, i32, ptr, ptr, ptr)`);
    const m = B.tmp();
    B.line(
      `${m} = call ptr @scr_map_new(i32 ${mapKeyKindNum(e.type.key)}, i32 ${mapValKindNum(value)}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${isRefCounted(value) ? traceArg(host, value) : "null"})`,
    );
    const out = host.own({ name: m, type: e.type });
    // Seeded construction: set() each pair in source order — a repeated
    // key overwrites (the runtime releases the old value).
    const kAcc = mapKeyAccess(e.type.key);
    const vAcc = elemAccess(value);
    for (const pair of e.seed ?? []) {
      const k = host.emitExpr(pair.key);
      const v = host.emitExpr(pair.value);
      if (vAcc === "ref") host.moveTemp(v); // the value MOVES in
      host.mapSet(m, kAcc, vAcc, k.name, v.name);
    }
    return out;
  }

export function mapSet(host: LlvmEmitterContext, m: string, kAcc: "f64" | "str" | "ref", vAcc: "f64" | "bool" | "ref", key: string, value: string): void {
    const kTy = kAcc === "f64" ? "double" : "ptr";
    const vTy = vAcc === "f64" ? "double" : vAcc === "bool" ? "i1" : "ptr";
    host.declare(`declare void @scr_map_set_${kAcc}_${vAcc}(ptr, ${kTy}, ${vTy === "i1" ? "i1 zeroext" : vTy})`);
    host.B.line(`call void @scr_map_set_${kAcc}_${vAcc}(ptr ${m}, ${kTy} ${key}, ${vTy} ${value})`);
  }

export function emitMapLikeIntrinsic(host: LlvmEmitterContext,
    e: Extract<IrExpr, { kind: "mapIntrinsic" | "setIntrinsic" }>,
  ): LlValue {
    const B = host.B;
    const r = host.emitExpr(e.receiver);
    const receiverType = e.receiver.type;
    if (e.kind === "mapIntrinsic" && receiverType.kind !== "map") {
      throw new InternalCompilerError("llvm emitter bug: mapIntrinsic on non-map");
    }
    if (e.kind === "setIntrinsic" && receiverType.kind !== "set") {
      throw new InternalCompilerError("llvm emitter bug: setIntrinsic on non-set");
    }
    if (receiverType.kind !== "map" && receiverType.kind !== "set") {
      throw new InternalCompilerError("unreachable");
    }
    const key = receiverType.kind === "map" ? receiverType.key : receiverType.elem;
    const kAcc = mapKeyAccess(key);
    const kTy = kAcc === "f64" ? "double" : "ptr";
    const method = e.method;
    switch (method) {
      case "get": {
        if (receiverType.kind !== "map") throw new InternalCompilerError("unreachable");
        const value = receiverType.value;
        // The union construction is type-directed HERE, like envGet — the
        // runtime knows no tags. Ref values come back +1 (ownership MOVES
        // into the fresh union box on a hit); scalars ride an out-param
        // behind a found flag; a miss is the interned undefined-arm
        // instance. When V is itself a union, the stored box IS the
        // result (`undefined` sorts last in canonical arm order).
        const k = host.emitExpr(e.args[0]!);
        if (e.type.kind !== "union") throw new InternalCompilerError("llvm emitter bug: map get result is not a union");
        const def = host.unionsById.get(e.type.unionId);
        const undefTag = undefinedArmTag(e.type, host.unionsById);
        if (!def || undefTag < 0) throw new InternalCompilerError("llvm emitter bug: map get union lacks its undefined arm");
        const absent = host.unitInstanceRef(e.type.unionId, undefTag);
        if (value.kind === "union") {
          host.declare(`declare ptr @scr_map_get_${kAcc}_ref(ptr, ${kTy})`);
          const raw = B.tmp();
          const isnull = B.tmp();
          const t = B.tmp();
          B.line(`${raw} = call ptr @scr_map_get_${kAcc}_ref(ptr ${r.name}, ${kTy} ${k.name})`);
          B.line(`${isnull} = icmp eq ptr ${raw}, null`);
          B.line(`${t} = select i1 ${isnull}, ptr ${absent}, ptr ${raw}`);
          return host.own({ name: t, type: e.type });
        }
        const valueTag = def.arms.findIndex((a) => typeEquals(a, value));
        if (valueTag < 0) throw new InternalCompilerError("llvm emitter bug: map get union lacks its value arm");
        if (value.kind === "f64" || value.kind === "bool") {
          const outTy = value.kind === "f64" ? "double" : "i8";
          const outSlot = B.slot();
          B.entryAllocas.push(`${outSlot} = alloca ${outTy}`);
          B.line(`store ${outTy} ${value.kind === "f64" ? f64Lit(0) : "0"}, ptr ${outSlot}`);
          host.declare(`declare zeroext i1 @scr_map_get_${kAcc}_${value.kind === "f64" ? "f64" : "bool"}(ptr, ${kTy}, ptr)`);
          const found = B.tmp();
          B.line(`${found} = call zeroext i1 @scr_map_get_${kAcc}_${value.kind === "f64" ? "f64" : "bool"}(ptr ${r.name}, ${kTy} ${k.name}, ptr ${outSlot})`);
          const slot = B.slot();
          B.entryAllocas.push(`${slot} = alloca ptr`);
          const lp = B.newLabel("mg.p");
          const la = B.newLabel("mg.a");
          const lj = B.newLabel("mg.j");
          B.condBr(found, lp, la);
          B.startBlock(lp);
          const rawOut = B.tmp();
          B.line(`${rawOut} = load ${outTy}, ptr ${outSlot}`);
          let hit = rawOut;
          if (value.kind === "bool") {
            hit = B.tmp();
            B.line(`${hit} = trunc i8 ${rawOut} to i1`);
          }
          B.line(`store ptr ${host.unionNewOwned(valueTag, { name: hit, type: value })}, ptr ${slot}`);
          B.br(lj);
          B.startBlock(la);
          B.line(`store ptr ${absent}, ptr ${slot}`);
          B.br(lj);
          B.startBlock(lj);
          const t = B.tmp();
          B.line(`${t} = load ptr, ptr ${slot}`);
          return host.own({ name: t, type: e.type });
        }
        host.declare(`declare ptr @scr_map_get_${kAcc}_ref(ptr, ${kTy})`);
        const raw = B.tmp();
        B.line(`${raw} = call ptr @scr_map_get_${kAcc}_ref(ptr ${r.name}, ${kTy} ${k.name})`);
        return host.wrapNullable(raw, raw, value, valueTag, e.type, undefTag);
      }
      case "set": {
        if (receiverType.kind !== "map") throw new InternalCompilerError("unreachable");
        // Key borrowed (the runtime retains stored string keys); the
        // value MOVES in (replacement releases the old value inside).
        const k = host.emitExpr(e.args[0]!);
        const v = host.emitExpr(e.args[1]!);
        const vAcc = elemAccess(receiverType.value);
        if (vAcc === "ref") host.moveTemp(v);
        host.mapSet(r.name, kAcc, vAcc, k.name, v.name);
        return { name: "", type: e.type };
      }
      case "add": {
        if (receiverType.kind !== "set") throw new InternalCompilerError("unreachable");
        // Element borrowed (the runtime retains stored strings); the unit
        // value is 0. Re-adding overwrites in place, preserving insertion.
        const k = host.emitExpr(e.args[0]!);
        host.mapSet(r.name, kAcc, "f64", k.name, f64Lit(0));
        return { name: "", type: e.type };
      }
      case "has": {
        const k = host.emitExpr(e.args[0]!);
        host.declare(`declare zeroext i1 @scr_map_has_${kAcc}(ptr, ${kTy})`);
        const t = B.tmp();
        B.line(`${t} = call zeroext i1 @scr_map_has_${kAcc}(ptr ${r.name}, ${kTy} ${k.name})`);
        return { name: t, type: e.type };
      }
      case "delete": {
        const k = host.emitExpr(e.args[0]!);
        host.declare(`declare zeroext i1 @scr_map_delete_${kAcc}(ptr, ${kTy})`);
        const t = B.tmp();
        B.line(`${t} = call zeroext i1 @scr_map_delete_${kAcc}(ptr ${r.name}, ${kTy} ${k.name})`);
        return { name: t, type: e.type };
      }
      case "size": {
        host.declare(`declare double @scr_map_size(ptr)`);
        const t = B.tmp();
        B.line(`${t} = call double @scr_map_size(ptr ${r.name})`);
        return { name: t, type: e.type };
      }
      case "clear":
        host.declare(`declare void @scr_map_clear(ptr)`);
        B.line(`call void @scr_map_clear(ptr ${r.name})`);
        return { name: "", type: e.type };
      case "iterCount": {
        host.declare(`declare double @scr_map_iter_count(ptr)`);
        const t = B.tmp();
        B.line(`${t} = call double @scr_map_iter_count(ptr ${r.name})`);
        return { name: t, type: e.type };
      }
      case "iterLive": {
        const i = host.emitExpr(e.args[0]!);
        host.declare(`declare zeroext i1 @scr_map_iter_live(ptr, double)`);
        const t = B.tmp();
        B.line(`${t} = call zeroext i1 @scr_map_iter_live(ptr ${r.name}, double ${i.name})`);
        return { name: t, type: e.type };
      }
      case "iterKey": {
        // String/ref keys come back +1 (own registers the owned temp).
        const i = host.emitExpr(e.args[0]!);
        const retTy = kAcc === "f64" ? "double" : "ptr";
        host.declare(`declare ${retTy} @scr_map_iter_key_${kAcc}(ptr, double)`);
        const t = B.tmp();
        B.line(`${t} = call ${retTy} @scr_map_iter_key_${kAcc}(ptr ${r.name}, double ${i.name})`);
        return host.own({ name: t, type: e.type });
      }
      case "iterValue": {
        if (receiverType.kind !== "map") throw new InternalCompilerError("unreachable");
        const vAcc = elemAccess(receiverType.value);
        const i = host.emitExpr(e.args[0]!);
        const retTy = vAcc === "f64" ? "double" : vAcc === "bool" ? "i1" : "ptr";
        host.declare(`declare ${vAcc === "bool" ? "zeroext i1" : retTy} @scr_map_iter_val_${vAcc}(ptr, double)`);
        const t = B.tmp();
        B.line(`${t} = call ${retTy} @scr_map_iter_val_${vAcc}(ptr ${r.name}, double ${i.name})`);
        return host.own({ name: t, type: e.type });
      }
      case "iterEnter":
        host.declare(`declare void @scr_map_iter_enter(ptr)`);
        B.line(`call void @scr_map_iter_enter(ptr ${r.name})`);
        return { name: "", type: e.type };
      case "iterExit":
        host.declare(`declare void @scr_map_iter_exit(ptr)`);
        B.line(`call void @scr_map_iter_exit(ptr ${r.name})`);
        return { name: "", type: e.type };
      case "toArray": {
        if (receiverType.kind !== "set") throw new InternalCompilerError("unreachable");
        // Fresh +1 elem[] of the live entries in insertion order.
        host.declare(`declare ptr @scr_set_to_arr_${kAcc}(ptr)`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_set_to_arr_${kAcc}(ptr ${r.name})`);
        return host.own({ name: t, type: e.type });
      }
      default: {
        const _exhaustive: never = method;
        void _exhaustive;
        throw new InternalCompilerError("unreachable");
      }
    }
  }

export function emitSetNew(host: LlvmEmitterContext, e: IrExpr & { kind: "setNew" }): LlValue {
    // Empty set: the map runtime with the element as the KEY and the
    // value slot pinned to the scalar kind. Handle-kind elements (symbol
    // identity hashing) carry their RC adapters at construction.
    if (e.type.kind !== "set") throw new InternalCompilerError("llvm emitter bug: setNew of non-set type");
    const B = host.B;
    const kAcc = mapKeyAccess(e.type.elem);
    const s = B.tmp();
    if (kAcc === "ref") {
      const rc = vAdapters(host, e.type.elem);
      host.declare(`declare ptr @scr_set_new_ref(ptr, ptr)`);
      B.line(`${s} = call ptr @scr_set_new_ref(ptr ${rc.retain}, ptr ${rc.release})`);
    } else {
      host.declare(`declare ptr @scr_map_new(i32, i32, ptr, ptr, ptr)`);
      B.line(`${s} = call ptr @scr_map_new(i32 ${mapKeyKindNum(e.type.elem)}, i32 0, ptr null, ptr null, ptr null)`);
    }
    const out = host.own({ name: s, type: e.type });
    if (e.seed) {
      // Seeded construction (`new Set(values)`): one borrowed T[] whose
      // elements add() in order (duplicates keep first insertion position).
      const arr = host.emitExpr(e.seed);
      host.declare(`declare void @scr_set_add_all(ptr, ptr)`);
      B.line(`call void @scr_set_add_all(ptr ${s}, ptr ${arr.name})`);
    }
    return out;
  }
