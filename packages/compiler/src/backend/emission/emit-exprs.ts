/* Expression C emission: the whole IrExpr dispatch (emitExpr) — every IR
 * expression lands in a fresh C temp, with RC ownership tracked on the
 * emitter's frames (see the discipline comment in emitter core). */
import type { CEmitter, Temp } from "./emitter.js";
import { arrayOf, BOOL, BYTES_U8, bytesOf, canMarshalFuncIntoIsland, CHILDSTREAM_T, DYN, F64, IrExpr, IrRecordShape, IrType, islandPromisePayloadTag, isRefCounted, isUnitType, MAY_THROW_LIB_FNS, RUNTIME_ERROR_CLASSES, STRING, typeEquals } from "../../ir/nodes.js";
import { boxAccess, BYTES_NUM_KIND_C, BYTES_NUM_VAR_C, bytesElemKindC, cDecl, cFnPtrCast, cNumberLiteral, cStringLiteral, cType, DV_GET_KIND_C, DV_SET_KIND_C, elemAccess, mapKeyAccess, mapKeyKindC, mapValKindC, retainCallC, vAdapters } from "./emit-types.js";
import { mangleClassNew, mangleClassRetain, mangleClassStruct, mangleField, mangleFnClosure, mangleFunction, mangleGlobal, mangleLocal, mangleRecordNew, mangleRecordStruct, mangleVtStruct } from "../mangle.js";
import { OVERFLOW_MEMBER } from "./emit-shapes.js";
import { dynDestrCheckHelper, dynIterNHelper, dynKeyGetHelper } from "./emit-walkers.js";
import { genResultThunkFor } from "./emit-async.js";






export function emitExpr(E: CEmitter, e: IrExpr): Temp {
    switch (e.kind) {
      case "numLit":
        return E.newTemp(e.type, cNumberLiteral(e.value));
      case "boolLit":
        return E.newTemp(e.type, e.value ? "true" : "false");
      case "strLit": {
        const sym = E.internLiteral(e.value);
        return E.newTemp(e.type, retainCallC(e.type, `(ScrStr *)&${sym}`));
      }
      case "unitLit":
        // unitLits are consumed inline by the unionWrap case (a unit arm is
        // tag-only); one reaching the generic dispatch escaped its wrap.
        throw new Error(`emitter bug: bare unitLit '${e.unit}'`);
      case "varRef": {
        const local = E.currentLocals.get(e.localId);
        if (!local && E.globalsById.has(e.localId)) {
          const gname = mangleGlobal(e.localId);
          return E.newTemp(e.type, isRefCounted(e.type) ? retainCallC(e.type, gname) : gname);
        }
        const name = mangleLocal(e.localId);
        if (local?.boxed) {
          // Reads go through the shared binding; ref kinds come out +1.
          const acc = boxAccess(e.type);
          // A scalar TDZ box stores its value in a one-element ARRAY cell
          // (the raw scalar slot has no spare sentinel state): reads peek
          // the cell through the slot — the box keeps the array alive, so
          // no retain/release pair is needed for the copied-out scalar.
          const read =
            acc === "ref"
              ? `(${cType(e.type).trim()})scr_box_get_ref(${name})`
              : local?.tdz
                ? `scr_arr_get_${acc}((ScrArr *)(uintptr_t)${name}->slot, 0)`
                : `scr_box_get_${acc}(${name})`;
          if (local.tdz) {
            // Forward-captured const: an empty box is the temporal dead
            // zone — throw Node's exact catchable ReferenceError. The test
            // peeks the payload slot BEFORE the retaining read (get_ref on
            // an empty box would dereference NULL; the scalar cell peek
            // would too). Interned literals are immortal (rc SIZE_MAX), so
            // handing them to the ownership-taking thrower is safe.
            const errName = E.internLiteral("ReferenceError");
            const msg = E.internLiteral(`Cannot access '${local.name}' before initialization`);
            E.line(`if (${name}->slot == 0) { /* TDZ: read before initialization */`);
            E.indent++;
            E.line(`scr_throw_error_named((ScrStr *)&${errName}, (ScrStr *)&${msg});`);
            E.emitUnwind();
            E.indent--;
            E.line(`}`);
          }
          return E.newTemp(e.type, read);
        }
        return E.newTemp(e.type, isRefCounted(e.type) ? retainCallC(e.type, name) : name);
      }
      case "bin": {
        const l = E.emitExpr(e.left);
        const r = E.emitExpr(e.right);
        switch (e.op) {
          case "%":
            return E.newTemp(e.type, `fmod(${l.name}, ${r.name})`);
          case "**":
            return E.newTemp(e.type, `pow(${l.name}, ${r.name})`);
          case "===":
            return E.newTemp(e.type, `${l.name} == ${r.name}`);
          case "!==":
            return E.newTemp(e.type, `${l.name} != ${r.name}`);
          // The bitwise six ride runtime helpers (ToInt32/ToUint32 wrap,
          // 5-bit shift masks, exact C-portable arithmetic shifts).
          case "&":
            return E.newTemp(e.type, `scr_bit_and(${l.name}, ${r.name})`);
          case "|":
            return E.newTemp(e.type, `scr_bit_or(${l.name}, ${r.name})`);
          case "^":
            return E.newTemp(e.type, `scr_bit_xor(${l.name}, ${r.name})`);
          case "<<":
            return E.newTemp(e.type, `scr_bit_shl(${l.name}, ${r.name})`);
          case ">>":
            return E.newTemp(e.type, `scr_bit_shr(${l.name}, ${r.name})`);
          case ">>>":
            return E.newTemp(e.type, `scr_bit_ushr(${l.name}, ${r.name})`);
          default:
            return E.newTemp(e.type, `${l.name} ${e.op} ${r.name}`);
        }
      }
      case "unary": {
        const v = E.emitExpr(e.operand);
        if (e.op === "~") return E.newTemp(e.type, `scr_bit_not(${v.name})`);
        return E.newTemp(e.type, `${e.op}${v.name}`);
      }
      case "incDec": {
        // Expression-position ++/--: read, write ±1, yield old (postfix)
        // or new (prefix) — the yielded value is snapshotted into its own
        // temp, so later writes to the binding can't disturb it. Receivers
        // are always f64 (frontend fence), so no RC bookkeeping.
        const local = E.currentLocals.get(e.localId);
        const one = e.op === "+" ? "+ 1" : "- 1";
        if (local?.boxed) {
          const box = mangleLocal(e.localId);
          const old = E.newTemp(e.type, `scr_box_get_${boxAccess(e.type)}(${box})`);
          if (e.prefix) {
            const t = E.newTemp(e.type, `${old.name} ${one}`);
            E.line(`scr_box_set_${boxAccess(e.type)}(${box}, ${t.name});`);
            return t;
          }
          E.line(`scr_box_set_${boxAccess(e.type)}(${box}, ${old.name} ${one});`);
          return old;
        }
        if (!local && !E.globalsById.has(e.localId)) {
          throw new Error(`emitter bug: incDec of unknown binding ${e.localId}`);
        }
        const target = local ? mangleLocal(e.localId) : mangleGlobal(e.localId);
        const t = E.newTemp(e.type, e.prefix ? `${target} ${one}` : target);
        E.line(`${target} = ${e.prefix ? t.name : `${t.name} ${one}`};`);
        return t;
      }
      case "fieldIncDec": {
        // ++/-- over a class FIELD in expression position: one receiver
        // evaluation, read-modify-write, old/new snapshotted into temps
        // like the local form. f64 fields compute in place; CHECKED-
        // DYNAMIC fields validate the number OUT (dynCheck — the catchable
        // TypeError on non-numbers), compute, and box the result back into
        // the slot. Unlink-then-release like fieldSet: the old box leaves
        // the heap edge before its count is given up (scr_cycle.c).
        const obj = E.emitExpr(e.obj);
        const field = `${obj.name}->${mangleField(e.field)}`;
        const one = e.op === "+" ? "+ 1" : "- 1";
        if (!e.fieldDyn) {
          const old = E.newTemp(e.type, field);
          if (e.prefix) {
            const t = E.newTemp(e.type, `${old.name} ${one}`);
            E.line(`${field} = ${t.name};${E.srcComment(e.loc)}`);
            return t;
          }
          E.line(`${field} = ${old.name} ${one};${E.srcComment(e.loc)}`);
          return old;
        }
        const helper = E.dynCheckHelper(e.type);
        const old = E.fallibleTemp(e.type, `${helper}(${field}, NULL)`);
        const next = E.newTemp(e.type, `${old.name} ${one}`);
        const oldBox = `sc_t${E.tempCounter++}`;
        E.line(`ScrDyn *${oldBox} = ${field};`);
        E.line(`${field} = scr_dyn_new_num(${next.name});${E.srcComment(e.loc)}`);
        E.releaseValue(oldBox, DYN);
        return e.prefix ? next : old;
      }
      case "assignExpr": {
        // `x = e` in expression position: e evaluates once, the binding takes
        // its OWN reference (retain for ref kinds — the frame keeps the temp's
        // reference for the yielded value, released at statement end as usual),
        // and the temp is the expression's value. Mirrors the `assign`
        // statement's old-value release / boxed-set behavior exactly.
        const local = E.currentLocals.get(e.localId);
        const v = E.emitExpr(e.value);
        if (local?.boxed) {
          // box_set takes ownership of the passed reference, so hand it a
          // retained copy and keep the temp's own reference for the yield.
          const stored = isRefCounted(v.type) ? retainCallC(v.type, v.name) : v.name;
          E.line(`scr_box_set_${boxAccess(local.type)}(${mangleLocal(e.localId)}, ${stored});`);
          return v;
        }
        if (!local && !E.globalsById.has(e.localId)) {
          throw new Error(`emitter bug: assignExpr to unknown binding ${e.localId}`);
        }
        const target = local ? mangleLocal(e.localId) : mangleGlobal(e.localId);
        if (isRefCounted(v.type)) {
          // Old-value release is NULL-tolerant for globals (statics start
          // NULL); locals always hold a live value by definite assignment.
          E.releaseValue(target, v.type);
          E.line(`${target} = ${retainCallC(v.type, v.name)};`);
        } else {
          E.line(`${target} = ${v.name};`);
        }
        return v;
      }
      case "seqExpr": {
        // Statements mid-expression: C emission is linear, so each
        // statement emits in place (its own frame, exactly statement
        // position) and the result is an ordinary temp of the current
        // frame. The validator restricted stmts to straight-line writes —
        // no jump can leave the region.
        for (const s of e.stmts) E.emitStmt(s);
        return E.emitExpr(e.result);
      }
      case "dynDestrCheck": {
        // RequireObjectCoercible with V8's destructuring TypeError. dyn
        // values check in the runtime helper and pass through unchanged
        // (same temp, same ownership); island values check in the engine
        // (a fresh +1 cell for the same value comes back).
        const v = E.emitExpr(e.value);
        const first = e.firstProp !== undefined ? cStringLiteral(Buffer.from(e.firstProp, "utf8")) : "NULL";
        const spell = cStringLiteral(Buffer.from(e.spelling, "utf8"));
        if (e.value.type.kind === "jsval") {
          return E.fallibleTemp(e.type, `scr_jsval_destr_check(${v.name}, ${spell}, ${first})`);
        }
        const helper = dynDestrCheckHelper(E);
        E.line(`${helper}(${v.name}, ${spell}, ${first});${E.srcComment(e.loc)}`);
        E.emitPendingCheck();
        return v;
      }
      case "dynIterN": {
        // GetIterator + first-N steps as a fresh array (V8's exact
        // not-iterable TypeError on non-iterables): the dyn helper for
        // dyn operands, the engine's real iterator protocol for island
        // ones.
        const v = E.emitExpr(e.value);
        if (e.value.type.kind === "jsval") {
          return E.fallibleTemp(e.type, `scr_jsval_iter_n(${v.name}, ${e.count})`);
        }
        const helper = dynIterNHelper(E);
        return E.fallibleTemp(e.type, `${helper}(${v.name}, ${e.count})`);
      }
      case "toBool": {
        // JS ToBoolean. The operand temp (for strings: owned by the current
        // frame) is only read here and released at statement end as usual.
        const v = E.emitExpr(e.operand);
        return E.newTemp(e.type, E.truthyC(v));
      }
      case "logical": {
        // JS value semantics: `a && b` ≡ `toBool(a) ? b : a`, `a || b` ≡
        // `toBool(a) ? a : b` — the result is an operand value, not a bool.
        // The left operand evaluates exactly once and its ownership moves
        // into the result temp; when the branch takes the right operand
        // instead, the stale left value is released first and the right
        // operand runs in its own frame (its leftover temps release inside
        // the branch). Same move/release dance as `ternary`.
        const l = E.emitExpr(e.left);
        E.moveTemp(l);
        const name = `sc_t${E.tempCounter++}`;
        E.line(`${cDecl(e.type, name)} = ${l.name};`);
        const truthy = E.truthyC({ name, type: e.type });
        E.line(`if (${e.op === "&&" ? truthy : `!(${truthy})`}) {`);
        E.indent++;
        if (isRefCounted(e.type)) E.releaseValue(name, e.type);
        E.emitBranchInto(name, e.right);
        E.indent--;
        E.line(`}`);
        if (isRefCounted(e.type)) E.currentFrame().push({ name, type: e.type });
        return { name, type: e.type };
      }
      case "ternary": {
        // Exactly one arm evaluates. Each arm runs in its own frame: the
        // chosen value's ownership moves to the result temp, everything
        // else the arm allocated is released inside its branch.
        const c = E.emitExpr(e.cond);
        const name = `sc_t${E.tempCounter++}`;
        E.line(`${cDecl(e.type, name)};`);
        const emitArm = (arm: IrExpr) => {
          E.indent++;
          E.emitBranchInto(name, arm);
          E.indent--;
        };
        E.line(`if (${c.name}) {`);
        emitArm(e.then);
        E.line(`} else {`);
        emitArm(e.else_);
        E.line(`}`);
        if (isRefCounted(e.type)) E.currentFrame().push({ name, type: e.type });
        return { name, type: e.type };
      }
      case "optChain": {
        // `a?.b` / `f?.()`: the nullish test inverted. The receiver
        // evaluates once into an ordinary frame temp (borrowed — the frame
        // releases it at statement end). On a unit tag the result is the
        // interned undefined arm and the body never runs (argument side
        // effects included); otherwise the narrowed payload fills the bind
        // temp (+1, frame-owned, NULL-initialized so the unit path's frame
        // release is a no-op) and the body reads it through chainRecv.
        // Island-handle chain: the nullish test asks the engine value; the
        // unit path result is the engine's undefined (+1 cell), the body
        // runs lazily over the bound handle otherwise.
        if (e.receiver.type.kind === "jsval") {
          const r = E.emitExpr(e.receiver);
          const bind = `sc_t${E.tempCounter++}`;
          E.line(`${cDecl(e.type, bind)} = NULL;`);
          E.currentFrame().push({ name: bind, type: e.type });
          const name = `sc_t${E.tempCounter++}`;
          E.line(`${cDecl(e.type, name)};`);
          E.line(`if (scr_jsval_is_nullish(${r.name})) {`);
          E.indent++;
          E.line(`${name} = scr_jsval_undefined();`);
          E.indent--;
          E.line(`} else {`);
          E.indent++;
          E.line(`${bind} = scr_jsval_retain(${r.name});`);
          E.chainTemps.set(e.id, { name: bind, type: e.type });
          E.emitBranchInto(name, e.body);
          E.chainTemps.delete(e.id);
          E.indent--;
          E.line(`}`);
          E.currentFrame().push({ name, type: e.type });
          return { name, type: e.type };
        }
        // A dyn (dyn) receiver — the `rawName?.match(re)` step: the nullish
        // test reads the node's kind tag; the unit path is the undefined
        // dyn singleton (dyn results) or nothing (void bodies), the body
        // runs over the bound receiver otherwise (the validated dynamic
        // dispatch, its result converted back into the checked-dynamic tree by the
        // frontend's dynFrom wrap).
        if (e.receiver.type.kind === "dyn") {
          const r = E.emitExpr(e.receiver);
          const test = `(${r.name}->kind == SCR_DYN_UNDEF || ${r.name}->kind == SCR_DYN_NULL)`;
          const bind = `sc_t${E.tempCounter++}`;
          E.line(`${cDecl(e.receiver.type, bind)} = NULL;`);
          E.currentFrame().push({ name: bind, type: e.receiver.type });
          if (e.type.kind === "void") {
            E.line(`if (!${test}) {`);
            E.indent++;
            E.line(`${bind} = scr_dyn_retain(${r.name});`);
            E.chainTemps.set(e.id, { name: bind, type: e.receiver.type });
            E.frames.push([]);
            E.emitExpr(e.body);
            E.releaseFrame(E.frames.pop()!);
            E.chainTemps.delete(e.id);
            E.indent--;
            E.line(`}`);
            return { name: "", type: e.type };
          }
          if (e.type.kind !== "dyn") throw new Error("emitter bug: dyn optChain result kind");
          const name = `sc_t${E.tempCounter++}`;
          E.line(`${cDecl(e.type, name)};`);
          E.line(`if (${test}) {`);
          E.indent++;
          E.line(`${name} = scr_dyn_retain(scr_dyn_undefined());`);
          E.indent--;
          E.line(`} else {`);
          E.indent++;
          E.line(`${bind} = scr_dyn_retain(${r.name});`);
          E.chainTemps.set(e.id, { name: bind, type: e.receiver.type });
          E.emitBranchInto(name, e.body);
          E.chainTemps.delete(e.id);
          E.indent--;
          E.line(`}`);
          E.currentFrame().push({ name, type: e.type });
          return { name, type: e.type };
        }
        if (e.receiver.type.kind !== "union") throw new Error("emitter bug: optChain receiver is not a union");
        const def = E.unionsById.get(e.receiver.type.unionId);
        if (!def) throw new Error(`emitter bug: optChain of unknown union ${e.receiver.type.unionId}`);
        const unitTags = def.arms.flatMap((a, i) => (isUnitType(a) ? [i] : []));
        const narrowIdx = def.arms.findIndex((a) => !isUnitType(a));
        if (unitTags.length === 0 || narrowIdx < 0) throw new Error("emitter bug: optChain union arms");
        const narrowed = def.arms[narrowIdx]!;
        const r = E.emitExpr(e.receiver);
        const bind = `sc_t${E.tempCounter++}`;
        E.line(`${cDecl(narrowed, bind)} = ${isRefCounted(narrowed) ? "NULL" : "0"};`);
        if (isRefCounted(narrowed)) E.currentFrame().push({ name: bind, type: narrowed });
        const test = unitTags.map((t) => `${r.name}->tag == ${t}`).join(" || ");
        const extract =
          narrowed.kind === "f64"
            ? `scr_union_get_f64(${r.name})`
            : narrowed.kind === "bool"
              ? `scr_union_get_bool(${r.name})`
              : retainCallC(narrowed, `(${cType(narrowed).trim()})scr_union_peek(${r.name})`);
        if (e.type.kind === "void") {
          // Statement form (cb?.()): no result value at all.
          E.line(`if (!(${test})) {`);
          E.indent++;
          E.line(`${bind} = ${extract};`);
          E.chainTemps.set(e.id, { name: bind, type: narrowed });
          E.frames.push([]);
          E.emitExpr(e.body);
          E.releaseFrame(E.frames.pop()!);
          E.chainTemps.delete(e.id);
          E.indent--;
          E.line(`}`);
          return { name: "", type: e.type };
        }
        // A dyn-typed chain (`pricing?.[key]` over an unknown-valued index
        // signature): the unit path is the undefined dyn value — dyn
        // represents undefined directly, no union wrapper exists.
        if (e.type.kind === "dyn") {
          const name = `sc_t${E.tempCounter++}`;
          E.line(`${cDecl(e.type, name)};`);
          E.line(`if (${test}) {`);
          E.indent++;
          E.line(`${name} = scr_dyn_retain(scr_dyn_undefined());`);
          E.indent--;
          E.line(`} else {`);
          E.indent++;
          E.line(`${bind} = ${extract};`);
          E.chainTemps.set(e.id, { name: bind, type: narrowed });
          E.emitBranchInto(name, e.body);
          E.chainTemps.delete(e.id);
          E.indent--;
          E.line(`}`);
          E.currentFrame().push({ name, type: e.type });
          return { name, type: e.type };
        }
        if (e.type.kind !== "union") throw new Error("emitter bug: optChain result is not a union");
        const undefTag = E.undefinedArmTag(e.type);
        if (undefTag < 0) throw new Error("emitter bug: optChain result lacks its undefined arm");
        const name = `sc_t${E.tempCounter++}`;
        E.line(`${cDecl(e.type, name)};`);
        E.line(`if (${test}) {`);
        E.indent++;
        E.line(`${name} = ${E.unitInstanceRef(e.type.unionId, undefTag)};`);
        E.indent--;
        E.line(`} else {`);
        E.indent++;
        E.line(`${bind} = ${extract};`);
        E.chainTemps.set(e.id, { name: bind, type: narrowed });
        E.emitBranchInto(name, e.body);
        E.chainTemps.delete(e.id);
        E.indent--;
        E.line(`}`);
        E.currentFrame().push({ name, type: e.type });
        return { name, type: e.type };
      }
      case "chainRecv": {
        const bound = E.chainTemps.get(e.id);
        if (!bound) throw new Error(`emitter bug: chainRecv "${e.id}" outside its chain`);
        return E.newTemp(
          e.type,
          isRefCounted(e.type) ? retainCallC(e.type, bound.name) : bound.name,
        );
      }
      case "orDefault": {
        // `u || d` narrowed to the single non-unit arm: nullish's dance
        // with the per-union TRUTHY helper as the test — truthy extracts
        // the arm (+1 for ref kinds), falsy releases and runs the default.
        if (e.left.type.kind !== "union") throw new Error("emitter bug: orDefault left is not a union");
        const l = E.emitExpr(e.left);
        E.moveTemp(l);
        const name = `sc_t${E.tempCounter++}`;
        E.line(`${cDecl(e.type, name)};`);
        E.line(`if (${E.unionTruthyHelper(e.left.type.unionId)}(${l.name})) {`);
        E.indent++;
        if (e.retag !== undefined) {
          // The helper CONSUMES the left box (callees own their params), so
          // no release on this side — the falsy side still owns and frees it.
          // An unwind here produces the NULL dummy and never reaches the
          // frame push below, so the slot needs no early registration.
          E.line(`${name} = ${E.callTargetC(e.retag)}(${l.name});`);
          if (E.mayThrow.has(e.retag)) E.emitPendingCheck();
        } else {
          const arm = e.type;
          const read =
            arm.kind === "f64"
              ? `scr_union_get_f64(${l.name})`
              : arm.kind === "bool"
                ? `scr_union_get_bool(${l.name})`
                : retainCallC(arm, `(${cType(arm).trim()})scr_union_peek(${l.name})`);
          E.line(`${name} = ${read};`);
          E.releaseValue(l.name, e.left.type);
        }
        E.indent--;
        E.line(`} else {`);
        E.indent++;
        E.releaseValue(l.name, e.left.type);
        E.emitBranchInto(name, e.right);
        E.indent--;
        E.line(`}`);
        if (isRefCounted(e.type)) E.currentFrame().push({ name, type: e.type });
        return { name, type: e.type };
      }
      case "nullish": {
        // `a ?? b`: logical's move/release dance with the left's runtime
        // TAG against its unit arms as the test. The left evaluates exactly
        // once (ownership moves out of the frame, manually managed below);
        // the right runs lazily in its own branch. Pass-through shape: the
        // result IS the left box. Narrowed shape: the single non-unit arm's
        // payload is extracted unionNarrow-style (+1 for ref kinds, the
        // checker proved the tag) and the left box is released.
        if (e.left.type.kind === "jsval") {
          // `a ?? b` on an island value: the engine's nullish test; the
          // right runs lazily in its branch (already jsval-typed).
          const l = E.emitExpr(e.left);
          E.moveTemp(l);
          const name = `sc_t${E.tempCounter++}`;
          E.line(`${cDecl(e.type, name)};`);
          E.line(`if (scr_jsval_is_nullish(${l.name})) {`);
          E.indent++;
          E.releaseValue(l.name, e.left.type);
          E.emitBranchInto(name, e.right);
          E.indent--;
          E.line(`} else {`);
          E.indent++;
          E.line(`${name} = ${l.name};`);
          E.indent--;
          E.line(`}`);
          if (isRefCounted(e.type)) E.currentFrame().push({ name, type: e.type });
          return { name, type: e.type };
        }
        if (e.left.type.kind === "dyn") {
          // `a ?? b` on a checked-dynamic left: the runtime kind decides
          // (UNDEF/NULL take the default; a wrapped island value asks the
          // engine); the right runs lazily in its branch (already dyn).
          const l = E.emitExpr(e.left);
          E.moveTemp(l);
          const name = `sc_t${E.tempCounter++}`;
          E.line(`${cDecl(e.type, name)};`);
          E.line(`if (scr_dyn_is_nullish(${l.name})) {`);
          E.indent++;
          E.releaseValue(l.name, e.left.type);
          E.emitBranchInto(name, e.right);
          E.indent--;
          E.line(`} else {`);
          E.indent++;
          E.line(`${name} = ${l.name};`);
          E.indent--;
          E.line(`}`);
          if (isRefCounted(e.type)) E.currentFrame().push({ name, type: e.type });
          return { name, type: e.type };
        }
        if (e.left.type.kind !== "union") throw new Error("emitter bug: nullish left is not a union");
        const def = E.unionsById.get(e.left.type.unionId);
        if (!def) throw new Error(`emitter bug: nullish of unknown union ${e.left.type.unionId}`);
        const unitTags = def.arms.flatMap((a, i) => (isUnitType(a) ? [i] : []));
        if (unitTags.length === 0) throw new Error("emitter bug: nullish union lacks unit arms");
        const l = E.emitExpr(e.left);
        E.moveTemp(l);
        const name = `sc_t${E.tempCounter++}`;
        E.line(`${cDecl(e.type, name)};`);
        const test = unitTags.map((t) => `${l.name}->tag == ${t}`).join(" || ");
        E.line(`if (${test}) {`);
        E.indent++;
        E.releaseValue(l.name, e.left.type);
        E.emitBranchInto(name, e.right);
        E.indent--;
        E.line(`} else {`);
        E.indent++;
        if (typeEquals(e.type, e.left.type)) {
          E.line(`${name} = ${l.name};`);
        } else {
          const arm = e.type;
          const read =
            arm.kind === "f64"
              ? `scr_union_get_f64(${l.name})`
              : arm.kind === "bool"
                ? `scr_union_get_bool(${l.name})`
                : retainCallC(arm, `(${cType(arm).trim()})scr_union_peek(${l.name})`);
          E.line(`${name} = ${read};`);
          E.releaseValue(l.name, e.left.type);
        }
        E.indent--;
        E.line(`}`);
        if (isRefCounted(e.type)) E.currentFrame().push({ name, type: e.type });
        return { name, type: e.type };
      }
      case "strConcat": {
        const l = E.emitExpr(e.left);
        const r = E.emitExpr(e.right);
        return E.newTemp(e.type, `scr_str_concat(${l.name}, ${r.name})`);
      }
      case "strEq": {
        const l = E.emitExpr(e.left);
        const r = E.emitExpr(e.right);
        return E.newTemp(e.type, `${e.negated ? "!" : ""}scr_str_eq(${l.name}, ${r.name})`);
      }
      case "strCmp": {
        const l = E.emitExpr(e.left);
        const r = E.emitExpr(e.right);
        return E.newTemp(e.type, `scr_str_cmp(${l.name}, ${r.name}) ${e.op} 0`);
      }
      case "toString": {
        const v = E.emitExpr(e.operand);
        if (v.type.kind === "union") {
          // The ARM value's ToString via the per-union interned helper
          // (unit arms are interned literals, string arms retain the
          // payload, f64/bool arms format). Box borrowed; result +1.
          return E.newTemp(e.type, `${E.unionToStrHelper(v.type.unionId)}(${v.name})`);
        }
        if (v.type.kind === "caught") {
          // String(e) over the exception snapshot. Box borrowed; result +1.
          return E.newTemp(e.type, `scr_caught_to_string(${v.name})`);
        }
        if (v.type.kind === "dyn") {
          // String(unknown): dispatch over the dyn kind (dynToStrHelper —
          // Node's String() incl. arrays-join and "[object Object]").
          return E.newTemp(e.type, `${E.dynToStrHelper()}(${v.name})`);
        }
        if (v.type.kind === "record") {
          // String(record) / `${record}`: Object.prototype.toString's
          // constant. The operand temp was emitted above (effects and RC
          // ride the frame like any other statement temp); the result is
          // the interned literal, retained like a strLit.
          const sym = E.internLiteral("[object Object]");
          return E.newTemp(e.type, retainCallC(e.type, `(ScrStr *)&${sym}`));
        }
        const fn = v.type.kind === "bool" ? "scr_bool_to_scrstr" : "scr_f64_to_scrstr";
        return E.newTemp(e.type, `${fn}(${v.name})`);
      }
      case "strIntrinsic": {
        // Receiver and string arguments are owned temps in the current
        // frame; every scr_str_* method BORROWS them (frame release at
        // statement end still applies). String-returning methods hand back
        // a +1 reference, which newTemp registers in the frame like any
        // other owned string temp. Omitted optional args get the C-side
        // defaults from docs/ir.md: indexOf position 0, slice start 0,
        // slice end INFINITY (math.h is always included).
        const r = E.emitExpr(e.receiver);
        const args = e.args.map((a) => E.emitExpr(a));
        const method = e.method;
        switch (method) {
          case "length":
            return E.newTemp(e.type, `scr_str_utf16_len(${r.name})`);
          case "charCodeAt":
            return E.newTemp(e.type, `scr_str_char_code_at(${r.name}, ${args[0]!.name})`);
          case "charAt":
            return E.newTemp(e.type, `scr_str_char_at(${r.name}, ${args[0]!.name})`);
          case "indexOf":
            return E.newTemp(
              e.type,
              `scr_str_index_of(${r.name}, ${args[0]!.name}, ${args[1]?.name ?? "0"})`,
            );
          case "includes":
            // The position form is indexOf's clamp exactly (the spec
            // routes both through StringIndexOf): found ⇔ index != -1.
            if (args[1]) {
              return E.newTemp(
                e.type,
                `scr_str_index_of(${r.name}, ${args[0]!.name}, ${args[1].name}) != -1`,
              );
            }
            return E.newTemp(e.type, `scr_str_includes(${r.name}, ${args[0]!.name})`);
          case "startsWith":
            return E.newTemp(e.type, `scr_str_starts_with(${r.name}, ${args[0]!.name})`);
          case "endsWith":
            return E.newTemp(e.type, `scr_str_ends_with(${r.name}, ${args[0]!.name})`);
          case "slice":
            return E.newTemp(
              e.type,
              `scr_str_slice(${r.name}, ${args[0]?.name ?? "0"}, ${args[1]?.name ?? "INFINITY"})`,
            );
          case "substring":
            return E.newTemp(
              e.type,
              `scr_str_substring(${r.name}, ${args[0]!.name}, ${args[1]?.name ?? "INFINITY"})`,
            );
          case "repeat":
            return E.newTemp(e.type, `scr_str_repeat(${r.name}, ${args[0]!.name})`);
          case "trim":
            return E.newTemp(e.type, `scr_str_trim(${r.name})`);
          case "trimStart":
            return E.newTemp(e.type, `scr_str_trim_start(${r.name})`);
          case "trimEnd":
            return E.newTemp(e.type, `scr_str_trim_end(${r.name})`);
          case "split":
            return E.newTemp(e.type, `scr_str_split(${r.name}, ${args[0]!.name})`);
          case "padStart":
            return E.newTemp(
              e.type,
              `scr_str_pad_start(${r.name}, ${args[0]!.name}, ${args[1]!.name})`,
            );
          case "padEnd":
            return E.newTemp(
              e.type,
              `scr_str_pad_end(${r.name}, ${args[0]!.name}, ${args[1]!.name})`,
            );
          // The lre-backed pair (scr_regex.c): the IR's presence flips the
          // regex link switch, so the symbols always resolve.
          case "toLowerCase":
            return E.newTemp(e.type, `scr_str_to_lower(${r.name})`);
          case "toUpperCase":
            return E.newTemp(e.type, `scr_str_to_upper(${r.name})`);
          // The well-formedness pair: no-ops over well-formed storage
          // (constant true / retained identity; scr_string.c).
          case "isWellFormed":
            return E.newTemp(e.type, `scr_str_is_well_formed(${r.name})`);
          case "toWellFormed":
            return E.newTemp(e.type, `scr_str_to_well_formed(${r.name})`);
          case "cpAt":
            return E.newTemp(e.type, `scr_str_cp_at(${r.name}, ${args[0]!.name})`);
          default: {
            const _exhaustive: never = method;
            void _exhaustive;
            throw new Error("unreachable");
          }
        }
      }
      case "regexLit": {
        // One immortal static per (pattern, flags) pair; the +1 retain is a
        // no-op on immortals but keeps the owned-temps discipline uniform.
        // Pattern/flags strings are interned NOW so the literal table is
        // complete when emit() assembles the file.
        const key = `${e.flags}/${e.pattern}`;
        let sym = E.regexInstances.get(key);
        if (!sym) {
          sym = `sc_re_${E.regexInstances.size}`;
          E.regexInstances.set(key, sym);
          E.internLiteral(e.pattern);
          E.internLiteral(e.flags);
        }
        return E.newTemp(e.type, `scr_regex_retain(&${sym})`);
      }
      case "templateStrings": {
        // One immortal static string array per template SITE (the key);
        // the +1 retain is a no-op on immortals but keeps the owned-temps
        // discipline uniform. Cooked strings intern NOW so the literal
        // table is complete when emit() assembles the file.
        let inst = E.templateStringsInstances.get(e.key);
        if (!inst) {
          inst = { sym: `sc_tsa_${E.templateStringsInstances.size}`, cooked: e.cooked };
          E.templateStringsInstances.set(e.key, inst);
          for (const s of e.cooked) E.internLiteral(s);
        }
        return E.newTemp(e.type, `scr_arr_retain(&${inst.sym})`);
      }
      case "regexIntrinsic": {
        // Receiver and args are borrowed frame temps; string/array results
        // come back +1 and join the frame via newTemp. replaceAll and split
        // may THROW (catchable) — fallibleTemp emits the pending check.
        const r = E.emitExpr(e.receiver);
        const args = e.args.map((a) => E.emitExpr(a));
        const method = e.method;
        switch (method) {
          case "test":
            return E.newTemp(e.type, `scr_regex_test(${r.name}, ${args[0]!.name})`);
          case "match": {
            // +1 string[] or NULL from the runtime; the `string[] | null`
            // union wraps type-directedly, the process.envGet convention.
            if (e.type.kind !== "union") throw new Error("emitter bug: match result not a union");
            const def = E.unionsById.get(e.type.unionId);
            const arrTag = def ? def.arms.findIndex((a) => a.kind === "array") : -1;
            const nullTag = def ? def.arms.findIndex((a) => a.kind === "nullT") : -1;
            if (arrTag < 0 || nullTag < 0) {
              throw new Error("emitter bug: match union lacks its arms");
            }
            const m = E.newTemp(arrayOf(STRING), `scr_regex_match(${r.name}, ${args[0]!.name})`);
            E.moveTemp(m); // moves into the union box when present; NULL otherwise
            const present = `scr_union_new_ref(${arrTag}, ${m.name}, &scr_arr_retain_v, &scr_arr_release_v, NULL)`;
            const absent = E.unitInstanceRef(e.type.unionId, nullTag);
            return E.newTemp(e.type, `${m.name} ? ${present} : ${absent}`);
          }
          case "matchAll":
            // Every match drained eagerly into a fresh +1 string[][];
            // throws Node's TypeError on a non-global regex (catchable —
            // fallibleTemp's pending check).
            return E.fallibleTemp(e.type, `scr_regex_match_all(${r.name}, ${args[0]!.name})`);
          case "matchAllInto":
            // matchAll's companion-index form: args[1] (a number[]) also
            // receives each match's UTF-16 start index.
            return E.fallibleTemp(
              e.type,
              `scr_regex_match_all_into(${r.name}, ${args[0]!.name}, ${args[1]!.name})`,
            );
          case "search":
            // First-match index or -1 — a plain double; never throws.
            return E.newTemp(e.type, `scr_regex_search(${r.name}, ${args[0]!.name})`);
          case "source":
            return E.newTemp(e.type, `scr_regex_source(${r.name})`);
          case "flags":
            return E.newTemp(e.type, `scr_regex_flags(${r.name})`);
          case "replace":
            return E.newTemp(
              e.type,
              `scr_regex_replace(${r.name}, ${args[0]!.name}, ${args[1]!.name})`,
            );
          case "replaceAll":
            return E.fallibleTemp(
              e.type,
              `scr_regex_replace_all(${r.name}, ${args[0]!.name}, ${args[1]!.name})`,
            );
          case "split":
            return E.fallibleTemp(e.type, `scr_regex_split(${r.name}, ${args[0]!.name})`);
          default: {
            const _exhaustive: never = method;
            void _exhaustive;
            throw new Error("unreachable");
          }
        }
      }
      case "arrayLit": {
        // Allocate, then push each element in order. Ownership of refcounted
        // plain elements moves into the array (interned literals are
        // immortal, so the array's eventual release of them is a no-op).
        // SPREAD positions hold a same-typed source array (borrowed): its
        // elements copy in — _get_ref returns +1 and _push_ref takes
        // ownership, so the copy loop is RC-balanced; the length is
        // snapshotted before the loop.
        if (e.type.kind !== "array") throw new Error("emitter bug: arrayLit of non-array type");
        const elem = e.type.elem;
        const arr = E.newTemp(e.type, E.arrNewC(elem, e.elems.length));
        const acc = elemAccess(elem);
        const spreadSet = new Set(e.spreads ?? []);
        e.elems.forEach((el, i) => {
          const v = E.emitExpr(el);
          if (spreadSet.has(i)) {
            const n = `sc_i${E.tempCounter++}`;
            E.line(`for (size_t ${n} = 0, ${n}_len = (size_t)scr_arr_len(${v.name}); ${n} < ${n}_len; ${n}++) {`);
            E.indent++;
            E.line(`scr_arr_push_${acc}(${arr.name}, scr_arr_get_${acc}(${v.name}, (double)${n}));`);
            E.indent--;
            E.line(`}`);
            return;
          }
          if (acc === "ref") E.moveTemp(v);
          E.line(`scr_arr_push_${acc}(${arr.name}, ${v.name});`);
        });
        return arr;
      }
      case "arrayNewLen": {
        // Mapper-less Array.from({ length: n }): a length-n array of
        // ABSENT slots — the interned undefined arm for unions carrying
        // one (immortal: pushing owes no retain), NULL for every other
        // ref element kind (assign before reading — SEMANTICS.md 46). The
        // `i <= n - 1` bound is ToLength for the lengths that terminate:
        // fractions truncate, negative/NaN produce an empty array.
        if (e.type.kind !== "array") throw new Error("emitter bug: arrayNewLen of non-array type");
        const elem = e.type.elem;
        const n = E.emitExpr(e.length);
        const arr = E.newTemp(e.type, E.arrNewC(elem, 0));
        let fill = "NULL";
        if (elem.kind === "union") {
          const def = E.unionsById.get(elem.unionId);
          const tag = def ? def.arms.findIndex((a) => a.kind === "undefinedT") : -1;
          if (tag >= 0) fill = E.unitInstanceRef(elem.unionId, tag);
        }
        const i = `sc_i${E.tempCounter++}`;
        E.line(`for (double ${i} = 0; ${i} <= ${n.name} - 1; ${i} += 1) {`);
        E.indent++;
        E.line(`scr_arr_push_${elemAccess(elem)}(${arr.name}, ${fill});`);
        E.indent--;
        E.line(`}`);
        return arr;
      }
      case "arrayGet": {
        const arr = E.emitExpr(e.arr);
        const idx = E.emitExpr(e.index);
        if (e.arr.type.kind !== "array") throw new Error("emitter bug: arrayGet on non-array");
        // Ref-element reads return +1 (the runtime retains); newTemp
        // registers the owned temp in the frame like any other.
        const acc = elemAccess(e.arr.type.elem);
        return E.newTemp(e.type, `scr_arr_get_${acc}(${arr.name}, ${idx.name})`);
      }
      case "arrIntrinsic": {
        const r = E.emitExpr(e.receiver);
        if (e.receiver.type.kind !== "array") throw new Error("emitter bug: arrIntrinsic on non-array");
        const acc = elemAccess(e.receiver.type.elem);
        const method = e.method;
        switch (method) {
          case "length":
            return E.newTemp(e.type, `scr_arr_len(${r.name})`);
          case "push": {
            // Variadic like JS: every argument evaluates first (left to
            // right — an argument reading the array sees the pre-push
            // state), then each appends in order. Ownership of refcounted
            // arguments moves into the array; the result is the new length
            // (f64) — the last push's return, or the unchanged length for
            // Node's no-op zero-argument call.
            const vs = e.args.map((a) => E.emitExpr(a));
            if (acc === "ref") vs.forEach((v) => E.moveTemp(v));
            for (let i = 0; i < vs.length - 1; i++) {
              E.line(`scr_arr_push_${acc}(${r.name}, ${vs[i]!.name});`);
            }
            const last = vs[vs.length - 1];
            return last
              ? E.newTemp(e.type, `scr_arr_push_${acc}(${r.name}, ${last.name})`)
              : E.newTemp(e.type, `scr_arr_len(${r.name})`);
          }
          case "pushSpread": {
            // `a.push(...src)`: append src's elements in order. The source
            // is BORROWED; the count snapshots before the loop so
            // `a.push(...a)` duplicates exactly like JS. _get_ref's +1
            // moves into _push_ref — RC-balanced. Result: the new length.
            const src = E.emitExpr(e.args[0]!);
            const n = `sc_i${E.tempCounter++}`;
            E.line(`for (size_t ${n} = 0, ${n}_len = (size_t)scr_arr_len(${src.name}); ${n} < ${n}_len; ${n}++) {`);
            E.indent++;
            E.line(`scr_arr_push_${acc}(${r.name}, scr_arr_get_${acc}(${src.name}, (double)${n}));`);
            E.indent--;
            E.line(`}`);
            return E.newTemp(e.type, `scr_arr_len(${r.name})`);
          }
          case "pop":
            // Ownership of a refcounted element moves OUT of the array to
            // this temp (+1 to us, the runtime does not release it).
            return E.newTemp(e.type, `scr_arr_pop_${acc}(${r.name})`);
          case "indexOf": {
            // The needle is BORROWED (released with this statement's frame);
            // the ref variant dispatches on the array's element kind
            // (strings by content, arrays by pointer). Strict equality.
            const v = E.emitExpr(e.args[0]!);
            return E.newTemp(e.type, `scr_arr_index_of_${acc}(${r.name}, ${v.name})`);
          }
          case "includes": {
            // Borrowed needle, SameValueZero (NaN matches NaN).
            const v = E.emitExpr(e.args[0]!);
            return E.newTemp(e.type, `scr_arr_includes_${acc}(${r.name}, ${v.name})`);
          }
          case "join": {
            // Separator borrowed; the result is an owned (+1) string.
            // Union elements route through the per-union join walker
            // (nullish arms print empty, exactly Array.prototype.join).
            const sep = E.emitExpr(e.args[0]!);
            if (e.receiver.type.kind === "array" && e.receiver.type.elem.kind === "union") {
              return E.newTemp(
                e.type,
                `${E.unionJoinHelper(e.receiver.type.elem.unionId)}(${r.name}, ${sep.name})`,
              );
            }
            return E.newTemp(e.type, `scr_arr_join(${r.name}, ${sep.name})`);
          }
          case "slice": {
            // Receiver borrowed; the result is a fresh +1 shallow copy
            // (ref elements retained). Omitted indices get the JS
            // defaults, the string-slice convention.
            const start = e.args[0] ? E.emitExpr(e.args[0]).name : "0";
            const end = e.args[1] ? E.emitExpr(e.args[1]).name : "INFINITY";
            return E.newTemp(e.type, `scr_arr_slice(${r.name}, ${start}, ${end})`);
          }
          case "splice": {
            // The removal splice: the removed elements come back as a
            // fresh +1 array, their ownership MOVED out of the receiver
            // (no retain/release churn). An omitted count removes to the
            // end (+Infinity, the slice convention).
            const start = E.emitExpr(e.args[0]!);
            const cnt = e.args[1] ? E.emitExpr(e.args[1]).name : "INFINITY";
            return E.newTemp(e.type, `scr_arr_splice(${r.name}, ${start.name}, ${cnt})`);
          }
          case "shift": {
            // JS shift: undefined on an empty array, else the first
            // element out (ref ownership moves into the union box) with
            // the tail sliding down. Union construction is type-directed
            // here, the envGet convention.
            if (e.type.kind !== "union") throw new Error("emitter bug: shift result is not a union");
            const elemT = e.receiver.type.elem;
            const def = E.unionsById.get(e.type.unionId);
            const tag = def ? def.arms.findIndex((a) => typeEquals(a, elemT)) : -1;
            const undefTag = E.undefinedArmTag(e.type);
            if (tag < 0 || undefTag < 0) throw new Error("emitter bug: shift union lacks its arms");
            const absent = E.unitInstanceRef(e.type.unionId, undefTag);
            const present =
              elemT.kind === "f64"
                ? `scr_union_new_f64(${tag}, scr_arr_shift_f64(${r.name}))`
                : elemT.kind === "bool"
                  ? `scr_union_new_bool(${tag}, scr_arr_shift_bool(${r.name}))`
                  : (() => {
                      const rc = vAdapters(elemT);
                      return `scr_union_new_ref(${tag}, scr_arr_shift_ref(${r.name}), &${rc.retain}, &${rc.release}, ${E.traceArgC(elemT)})`;
                    })();
            return E.newTemp(e.type, `scr_arr_len(${r.name}) ? ${present} : ${absent}`);
          }
          default: {
            const _exhaustive: never = method;
            void _exhaustive;
            throw new Error("unreachable");
          }
        }
      }
      case "bytesNew": {
        // Typed-array/Buffer construction; the SOURCE's static type picks
        // the runtime entry (see the node doc). The source is borrowed;
        // every form hands back +1. Only the f64 (length) form can throw
        // (Node's "Invalid typed array length" RangeError) — pending check
        // after the temp joins its frame.
        if (e.type.kind !== "bytes") throw new Error("emitter bug: bytesNew of non-bytes type");
        const kind = bytesElemKindC(e.type.elem);
        if (!e.source) return E.newTemp(e.type, `scr_bytes_new(${kind}, 0)`);
        const src = E.emitExpr(e.source);
        if (e.source.type.kind === "f64") {
          const t = E.newTemp(e.type, `scr_bytes_new(${kind}, ${src.name})`);
          E.emitPendingCheck();
          return t;
        }
        if (e.source.type.kind === "bytes") {
          return E.newTemp(e.type, `scr_bytes_copy(${src.name})`);
        }
        if (e.source.type.kind === "array") {
          return E.newTemp(e.type, `scr_bytes_from_arr(${kind}, ${src.name})`);
        }
        throw new Error(`emitter bug: bytesNew source of kind ${e.source.type.kind}`);
      }
      case "bytesIntrinsic": {
        // Receiver and args are borrowed frame temps; string/bytes results
        // come back +1. The MAY_THROW methods get the standard pending
        // check after their temp joins its frame.
        //
        // The numeric families first: their kind token (args[0], always a
        // strLit — validated) maps to the runtime tag at COMPILE time and
        // never emits as a value; the remaining args are plain f64s.
        if (e.method === "readNum" || e.method === "writeNum" || e.method === "readNumVar" || e.method === "writeNumVar") {
          const tok = e.args[0]!;
          if (tok.kind !== "strLit") throw new Error(`emitter bug: bytesIntrinsic ${e.method} kind must be a strLit`);
          const r0 = E.emitExpr(e.receiver);
          const rest = e.args.slice(1).map((a) => E.emitExpr(a));
          let call: string;
          if (e.method === "readNum" || e.method === "writeNum") {
            const spec = BYTES_NUM_KIND_C[tok.value];
            if (!spec) throw new Error(`emitter bug: bytes numeric kind '${tok.value}'`);
            call =
              e.method === "readNum"
                ? `scr_bytes_read_num(${r0.name}, ${rest[0]!.name}, ${spec.kind}, ${spec.le})`
                : `scr_bytes_write_num(${r0.name}, ${rest[0]!.name}, ${rest[1]!.name}, ${spec.kind}, ${spec.le})`;
          } else {
            const spec = BYTES_NUM_VAR_C[tok.value];
            if (!spec) throw new Error(`emitter bug: bytes variable-width kind '${tok.value}'`);
            call =
              e.method === "readNumVar"
                ? `scr_bytes_read_var(${r0.name}, ${rest[0]!.name}, ${rest[1]!.name}, ${spec.sign}, ${spec.le})`
                : `scr_bytes_write_var(${r0.name}, ${rest[0]!.name}, ${rest[1]!.name}, ${rest[2]!.name}, ${spec.sign}, ${spec.le})`;
          }
          const t = E.newTemp(e.type, call);
          E.emitPendingCheck();
          return t;
        }
        const r = E.emitExpr(e.receiver);
        const args = e.args.map((a) => E.emitExpr(a));
        const method = e.method;
        switch (method) {
          case "length":
            return E.newTemp(e.type, `scr_bytes_len(${r.name})`);
          case "byteLength":
            return E.newTemp(e.type, `scr_bytes_byte_len(${r.name})`);
          case "get":
            // Any invalid index traps (the array runtime's discipline).
            return E.newTemp(e.type, `scr_bytes_get(${r.name}, ${args[0]!.name})`);
          case "slice":
            // Omitted relative indices default like string slice: start 0,
            // end +Infinity (math.h is always included). Fresh copy, +1.
            return E.newTemp(
              e.type,
              `scr_bytes_slice(${r.name}, ${args[0]?.name ?? "0"}, ${args[1]?.name ?? "INFINITY"})`,
            );
          case "subarray":
            // Same defaults; the result is a +1 VIEW aliasing the
            // receiver's storage (subarray / Buffer's slice).
            return E.newTemp(
              e.type,
              `scr_bytes_subarray(${r.name}, ${args[0]?.name ?? "0"}, ${args[1]?.name ?? "INFINITY"})`,
            );
          case "setFrom": {
            // dst.set(src, offset?) — void; throws Node's RangeError on
            // overflow (may-throw seed).
            E.line(
              `scr_bytes_set_from(${r.name}, ${args[0]!.name}, ${args[1]?.name ?? "0"});${E.srcComment(e.loc)}`,
            );
            E.emitPendingCheck();
            return { name: "", type: e.type };
          }
          case "toString":
            // The encoding arg is always present (the frontend completes
            // an omitted one to "utf8"). Never throws; +1 string. Range
            // forms: [enc, start] decodes to the buffer's end; [enc,
            // start, end] clamps the explicit end (negatives empty,
            // Node's slice-then-decode).
            if (args.length === 3) {
              return E.newTemp(e.type, `scr_bytes_to_str_range(${r.name}, ${args[0]!.name}, ${args[1]!.name}, ${args[2]!.name})`);
            }
            if (args.length === 2) {
              return E.newTemp(e.type, `scr_bytes_to_str_range(${r.name}, ${args[0]!.name}, ${args[1]!.name}, (double)${r.name}->len)`);
            }
            return E.newTemp(e.type, `scr_bytes_to_str(${r.name}, ${args[0]!.name})`);
          case "equals":
            return E.newTemp(e.type, `scr_bytes_equals(${r.name}, ${args[0]!.name})`);
          case "compareBuf": {
            // nargs = the PRESENT index args (omitted ones skip Node's
            // validation); the 0 placeholders are never read past nargs.
            const n = e.args.length - 1;
            const idx = [1, 2, 3, 4].map((i) => args[i]?.name ?? "0");
            const t = E.newTemp(
              e.type,
              `scr_bytes_compare(${r.name}, ${args[0]!.name}, ${n}, ${idx.join(", ")})`,
            );
            E.emitPendingCheck();
            return t;
          }
          case "indexOf":
          case "lastIndexOf":
          case "includes": {
            // args = [needle, align, byteOffset?]; an omitted byteOffset
            // is NaN — the runtime's search-everything default.
            const fwd = method !== "lastIndexOf";
            const call = `scr_bytes_index_of(${r.name}, ${args[0]!.name}, ${args[2]?.name ?? "NAN"}, ${args[1]!.name}, ${fwd})`;
            return E.newTemp(e.type, method === "includes" ? `(${call} != -1)` : call);
          }
          case "indexOfNum":
          case "lastIndexOfNum":
          case "includesNum": {
            const fwd = method !== "lastIndexOfNum";
            const call = `scr_bytes_index_of_num(${r.name}, ${args[0]!.name}, ${args[1]?.name ?? "NAN"}, ${fwd})`;
            return E.newTemp(e.type, method === "includesNum" ? `(${call} != -1)` : call);
          }
          case "fill":
          case "fillNum": {
            const fn = method === "fill" ? "scr_bytes_fill" : "scr_bytes_fill_num";
            const n = e.args.length - 1;
            const t = E.newTemp(
              e.type,
              `${fn}(${r.name}, ${args[0]!.name}, ${n}, ${args[1]?.name ?? "0"}, ${args[2]?.name ?? "0"})`,
            );
            E.emitPendingCheck();
            return t;
          }
          case "fillElem":
            // Per-element TypedArray fill (non-u8): slice-style index
            // defaults, never throws; the receiver comes back +1.
            return E.newTemp(
              e.type,
              `scr_bytes_fill_elem(${r.name}, ${args[0]!.name}, ${args[1]?.name ?? "0"}, ${args[2]?.name ?? "INFINITY"})`,
            );
          case "fillStr": {
            const n = e.args.length - 2;
            const t = E.newTemp(
              e.type,
              `scr_bytes_fill_str(${r.name}, ${args[0]!.name}, ${args[1]!.name}, ${n}, ` +
                `${args[2]?.name ?? "0"}, ${args[3]?.name ?? "0"})`,
            );
            E.emitPendingCheck();
            return t;
          }
          case "copy": {
            const n = e.args.length - 1;
            const t = E.newTemp(
              e.type,
              `scr_bytes_copy_into(${r.name}, ${args[0]!.name}, ${n}, ` +
                `${args[1]?.name ?? "0"}, ${args[2]?.name ?? "0"}, ${args[3]?.name ?? "0"})`,
            );
            E.emitPendingCheck();
            return t;
          }
          case "swap16":
          case "swap32":
          case "swap64": {
            const w = method === "swap16" ? 2 : method === "swap32" ? 4 : 8;
            const t = E.newTemp(e.type, `scr_bytes_swap(${r.name}, ${w})`);
            E.emitPendingCheck();
            return t;
          }
          case "writeStr": {
            const t = E.newTemp(
              e.type,
              `scr_bytes_write_str(${r.name}, ${args[0]!.name}, ${args[1]!.name}, ${args[2]!.name}, ` +
                `${args[3]?.name ?? "0"}, ${args[3] ? "true" : "false"})`,
            );
            E.emitPendingCheck();
            return t;
          }
          case "byteOffset":
            // 0 for owners, the view's offset into its owner for a
            // DataView. Never throws.
            return E.newTemp(e.type, `scr_bytes_byte_offset(${r.name})`);
          case "dataViewNew": {
            // new DataView(x.buffer, byteOffset?, byteLength?) — receiver
            // is x itself (the frontend peeled `.buffer`). Omitted offset
            // defaults to 0; the has_len flag keeps an omitted length
            // distinct from every numeric value (the default is "to the
            // end of the buffer"). Throws Node's RangeErrors; +1 view.
            const t = E.newTemp(
              e.type,
              `scr_dataview_new(${r.name}, ${args[0]?.name ?? "0"}, ` +
                `${args[1] ? "true" : "false"}, ${args[1]?.name ?? "0"})`,
            );
            E.emitPendingCheck();
            return t;
          }
          case "dvGetUint8":
          case "dvGetInt8":
          case "dvGetUint16":
          case "dvGetInt16":
          case "dvGetUint32":
          case "dvGetInt32":
          case "dvGetFloat32":
          case "dvGetFloat64":
          case "dvGetBigUint64Number":
          case "dvGetBigInt64Number": {
            // DataView getters: an omitted littleEndian is big-endian
            // (the JS default). Throw Node's constant RangeError on a bad
            // offset.
            const kind = DV_GET_KIND_C[method];
            const t = E.newTemp(
              e.type,
              `scr_dataview_get(${r.name}, ${args[0]!.name}, ${kind}, ${args[1]?.name ?? "false"})`,
            );
            E.emitPendingCheck();
            return t;
          }
          case "dvSetUint8":
          case "dvSetInt8":
          case "dvSetUint16":
          case "dvSetInt16":
          case "dvSetUint32":
          case "dvSetInt32":
          case "dvSetFloat32":
          case "dvSetFloat64": {
            // DataView setters: [offset, value, littleEndian?] — void;
            // throw the getters' constant RangeError on a bad offset.
            const kind = DV_SET_KIND_C[method];
            E.line(
              `scr_dataview_set(${r.name}, ${args[0]!.name}, ${args[1]!.name}, ${kind}, ` +
                `${args[2]?.name ?? "false"});${E.srcComment(e.loc)}`,
            );
            E.emitPendingCheck();
            return { name: "", type: e.type };
          }
          default: {
            const _exhaustive: never = method;
            void _exhaustive;
            throw new Error("unreachable");
          }
        }
      }
      case "mapNew": {
        // Empty map: the runtime stores the value kind's RC entry points as
        // function pointers (scalar values pass NULLs). The trace argument
        // doubles as the cycle-capability flag: non-NULL exactly when the
        // value type carries a collector header (record/object/union values
        // can point back at the map) — such maps allocate with the header,
        // scalar/string/array-valued maps stay lean (docs/memory.md).
        if (e.type.kind !== "map") throw new Error("emitter bug: mapNew of non-map type");
        const value = e.type.value;
        const rc = isRefCounted(value) ? vAdapters(value) : null;
        const m = E.newTemp(
          e.type,
          `scr_map_new(${mapKeyKindC(e.type.key)}, ${mapValKindC(value)}, ` +
            `${rc ? `&${rc.retain}` : "NULL"}, ${rc ? `&${rc.release}` : "NULL"}, ${E.traceArgC(value)})`,
        );
        // Seeded construction: set() each pair in source order — exactly
        // the statements the user would write on an empty map, so a
        // repeated key overwrites (the runtime releases the old value).
        for (const pair of e.seed ?? []) {
          const k = E.emitExpr(pair.key);
          const v = E.emitExpr(pair.value);
          if (elemAccess(value) === "ref") E.moveTemp(v); // value MOVES in, like mapIntrinsic set
          E.line(
            `scr_map_set_${mapKeyAccess(e.type.key)}_${elemAccess(value)}(${m.name}, ${k.name}, ${v.name});${E.srcComment(e.loc)}`,
          );
        }
        return m;
      }
      case "mapIntrinsic": {
        const r = E.emitExpr(e.receiver);
        if (e.receiver.type.kind !== "map") throw new Error("emitter bug: mapIntrinsic on non-map");
        const { key, value } = e.receiver.type;
        const kAcc = mapKeyAccess(key);
        const vAcc = elemAccess(value);
        const method = e.method;
        switch (method) {
          case "get": {
            // The union construction is type-directed HERE, like
            // process.envGet — the runtime knows no tags. Ref values come
            // back +1 (ownership MOVES into the fresh union box on a hit);
            // scalars ride an out-param behind a found flag; a miss is the
            // interned immortal undefined-arm instance. When V is itself a
            // union, the stored box IS the result: `undefined` sorts last
            // in canonical arm order, so V's tags coincide with the result
            // union's and no re-tag exists (validated).
            const k = E.emitExpr(e.args[0]!);
            if (e.type.kind !== "union") throw new Error("emitter bug: map get result is not a union");
            const def = E.unionsById.get(e.type.unionId);
            const undefTag = E.undefinedArmTag(e.type);
            if (!def || undefTag < 0) throw new Error("emitter bug: map get union lacks its undefined arm");
            const absent = E.unitInstanceRef(e.type.unionId, undefTag);
            if (value.kind === "union") {
              const t = E.newTemp(
                e.type,
                `(ScrUnion *)scr_map_get_${kAcc}_ref(${r.name}, ${k.name})`,
              );
              E.line(`if (!${t.name}) ${t.name} = ${absent};`);
              return t;
            }
            const valueTag = def.arms.findIndex((a) => typeEquals(a, value));
            if (valueTag < 0) throw new Error("emitter bug: map get union lacks its value arm");
            if (value.kind === "f64" || value.kind === "bool") {
              const out = `sc_t${E.tempCounter++}`;
              const found = `sc_t${E.tempCounter++}`;
              E.line(`${cDecl(value, out)} = 0;`);
              E.line(`bool ${found} = scr_map_get_${kAcc}_${vAcc}(${r.name}, ${k.name}, &${out});`);
              const make = `scr_union_new_${value.kind}(${valueTag}, ${out})`;
              return E.newTemp(e.type, `${found} ? ${make} : ${absent}`);
            }
            const rc = vAdapters(value);
            const v = E.newTemp(value, `(${cType(value).trim()})scr_map_get_${kAcc}_ref(${r.name}, ${k.name})`);
            E.moveTemp(v); // moves into the box when present; NULL otherwise
            const present = `scr_union_new_ref(${valueTag}, ${v.name}, &${rc.retain}, &${rc.release}, ${E.traceArgC(value)})`;
            return E.newTemp(e.type, `${v.name} ? ${present} : ${absent}`);
          }
          case "set": {
            // Key borrowed (the runtime retains stored string keys); the
            // value MOVES in (replacement releases the old value inside).
            const k = E.emitExpr(e.args[0]!);
            const v = E.emitExpr(e.args[1]!);
            if (vAcc === "ref") E.moveTemp(v);
            E.line(`scr_map_set_${kAcc}_${vAcc}(${r.name}, ${k.name}, ${v.name});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "has": {
            const k = E.emitExpr(e.args[0]!);
            return E.newTemp(e.type, `scr_map_has_${kAcc}(${r.name}, ${k.name})`);
          }
          case "delete": {
            const k = E.emitExpr(e.args[0]!);
            return E.newTemp(e.type, `scr_map_delete_${kAcc}(${r.name}, ${k.name})`);
          }
          case "size":
            return E.newTemp(e.type, `scr_map_size(${r.name})`);
          case "clear":
            E.line(`scr_map_clear(${r.name});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "iterCount":
            return E.newTemp(e.type, `scr_map_iter_count(${r.name})`);
          case "iterLive": {
            const i = E.emitExpr(e.args[0]!);
            return E.newTemp(e.type, `scr_map_iter_live(${r.name}, ${i.name})`);
          }
          case "iterKey": {
            // String keys come back +1 (newTemp registers the owned temp).
            const i = E.emitExpr(e.args[0]!);
            return E.newTemp(e.type, `scr_map_iter_key_${kAcc}(${r.name}, ${i.name})`);
          }
          case "iterValue": {
            const i = E.emitExpr(e.args[0]!);
            const read =
              vAcc === "ref"
                ? `(${cType(value).trim()})scr_map_iter_val_ref(${r.name}, ${i.name})`
                : `scr_map_iter_val_${vAcc}(${r.name}, ${i.name})`;
            return E.newTemp(e.type, read);
          }
          case "iterEnter":
            E.line(`scr_map_iter_enter(${r.name});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "iterExit":
            E.line(`scr_map_iter_exit(${r.name});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          default: {
            const _exhaustive: never = method;
            void _exhaustive;
            throw new Error("unreachable");
          }
        }
      }
      case "setNew": {
        // Empty set: the map runtime with the element as the KEY and the
        // value slot pinned to the scalar kind (every stored value is 0.0,
        // never read back). No RC entry points, no trace: f64/string
        // elements cannot point back, so sets are never cycle-capable and
        // always allocate lean.
        if (e.type.kind !== "set") throw new Error("emitter bug: setNew of non-set type");
        // Handle-kind elements (identity hashing) carry their RC adapters
        // at construction — the scr_arr_new_ref technique.
        const elemAcc = mapKeyAccess(e.type.elem);
        const rcAdapters = elemAcc === "ref" ? vAdapters(e.type.elem) : null;
        const s = E.newTemp(
          e.type,
          rcAdapters
            ? `scr_set_new_ref(&${rcAdapters.retain}, &${rcAdapters.release})`
            : `scr_map_new(${mapKeyKindC(e.type.elem)}, SCR_MAP_VAL_F64, NULL, NULL, NULL)`,
        );
        // Seeded construction (`new Set(values)`): one borrowed T[] whose
        // elements add() in order — the runtime helper walks the array
        // (duplicates overwrite in place, insertion position preserved).
        if (e.seed) {
          const arr = E.emitExpr(e.seed);
          E.line(`scr_set_add_all(${s.name}, ${arr.name});${E.srcComment(e.loc)}`);
        }
        return s;
      }
      case "setIntrinsic": {
        const r = E.emitExpr(e.receiver);
        if (e.receiver.type.kind !== "set") throw new Error("emitter bug: setIntrinsic on non-set");
        const kAcc = mapKeyAccess(e.receiver.type.elem);
        const method = e.method;
        switch (method) {
          case "add": {
            // Element borrowed (the runtime retains stored strings); the
            // unit value is the constant 0. Re-adding overwrites the unit
            // in place — insertion position preserved, like Map set.
            const k = E.emitExpr(e.args[0]!);
            E.line(`scr_map_set_${kAcc}_f64(${r.name}, ${k.name}, 0);${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "has": {
            const k = E.emitExpr(e.args[0]!);
            return E.newTemp(e.type, `scr_map_has_${kAcc}(${r.name}, ${k.name})`);
          }
          case "delete": {
            const k = E.emitExpr(e.args[0]!);
            return E.newTemp(e.type, `scr_map_delete_${kAcc}(${r.name}, ${k.name})`);
          }
          case "size":
            return E.newTemp(e.type, `scr_map_size(${r.name})`);
          case "clear":
            E.line(`scr_map_clear(${r.name});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "iterCount":
            return E.newTemp(e.type, `scr_map_iter_count(${r.name})`);
          case "iterLive": {
            const i = E.emitExpr(e.args[0]!);
            return E.newTemp(e.type, `scr_map_iter_live(${r.name}, ${i.name})`);
          }
          case "iterKey": {
            // The ELEMENT read; string elements come back +1.
            const i = E.emitExpr(e.args[0]!);
            return E.newTemp(e.type, `scr_map_iter_key_${kAcc}(${r.name}, ${i.name})`);
          }
          case "iterEnter":
            E.line(`scr_map_iter_enter(${r.name});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "iterExit":
            E.line(`scr_map_iter_exit(${r.name});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "toArray":
            // Fresh +1 elem[] of the live entries in insertion order.
            return E.newTemp(e.type, `scr_set_to_arr_${kAcc}(${r.name})`);
          default: {
            const _exhaustive: never = method;
            void _exhaustive;
            throw new Error("unreachable");
          }
        }
      }
      case "call": {
        const args = e.args.map((a) => E.emitExpr(a));
        // Callees own their params: ownership of refcounted args moves.
        for (const a of args) E.moveTemp(a);
        // Async callee: the spawn wrapper runs the body eagerly to its
        // first suspension and returns the promise (+1). The call itself
        // never unwinds — rejections surface at await.
        const call = `${E.callTargetC(e.callee)}(${args.map((a) => a.name).join(", ")})`;
        if (e.type.kind === "void") {
          E.line(`${call};${E.srcComment(e.loc)}`);
          if (E.mayThrow.has(e.callee)) E.emitPendingCheck();
          return { name: "", type: e.type };
        }
        const t = E.newTemp(e.type, call);
        // The check runs AFTER the result temp joins the frame: an unwind
        // releases it (the dummy is NULL for refcounted returns).
        if (E.mayThrow.has(e.callee)) E.emitPendingCheck();
        return t;
      }
      case "ffiCall": {
        const entry = E.ffiByName.get(e.import);
        if (!entry) throw new Error(`emitter bug: unknown FFI import ${e.import}`);
        const args = e.args.map((arg) => E.emitExpr(arg));
        const nativeArgs: string[] = [];
        entry.params.forEach((cls, i) => {
          const arg = args[i]!;
          switch (cls) {
            case "f64":
              nativeArgs.push(arg.name);
              break;
            case "bool":
              nativeArgs.push(`(uint8_t)(${arg.name} ? 1 : 0)`);
              break;
            case "u8":
              nativeArgs.push(`(uint8_t)(uint32_t)scr_bit_ushr(${arg.name}, 0.0)`);
              break;
            case "u32":
              nativeArgs.push(`(uint32_t)scr_bit_ushr(${arg.name}, 0.0)`);
              break;
            case "i32":
              nativeArgs.push(`(int32_t)scr_bit_or(${arg.name}, 0.0)`);
              break;
            case "string":
              nativeArgs.push(`(const uint8_t *)${arg.name}->data`, `${arg.name}->len`);
              break;
            case "bytes":
              nativeArgs.push(`(const uint8_t *)${arg.name}->data`, `${arg.name}->len`);
              break;
          }
        });
        const call = `${entry.symbol}(${nativeArgs.join(", ")})`;
        switch (entry.returns) {
          case "void":
            E.line(`${call};${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "f64":
            return E.newTemp(e.type, call);
          case "bool":
            return E.newTemp(e.type, `(${call} != 0)`);
          case "u8":
          case "u32":
          case "i32":
            return E.newTemp(e.type, `(double)${call}`);
        }
      }
      case "closure": {
        const target = E.fnByName.get(e.fnName);
        if (!target) throw new Error(`emitter bug: closure over unknown function ${e.fnName}`);
        if (target.captures === undefined) {
          // Declared function as a value: the interned immortal closure —
          // every mention yields the same pointer, so `f === f` is true.
          E.fnValues.add(e.fnName);
          return E.newTemp(
            e.type,
            retainCallC(e.type, `(ScrClosure *)&${mangleFnClosure(e.fnName)}`),
          );
        }
        const t = E.newTemp(
          e.type,
          `scr_closure_new((void *)&${E.callTargetC(e.fnName)}, ${e.captures.length})`,
        );
        e.captures.forEach((localId, i) => {
          E.line(`${t.name}->caps[${i}] = scr_box_retain(${mangleLocal(localId)});`);
        });
        return t;
      }
      case "callValue": {
        const callee = E.emitExpr(e.callee);
        const args = e.args.map((a) => E.emitExpr(a));
        for (const a of args) E.moveTemp(a); // callee owns its params
        if (e.callee.type.kind !== "func") throw new Error("emitter bug: callValue on non-func");
        const cast = cFnPtrCast(e.callee.type);
        const argList = [callee.name, ...args.map((a) => a.name)].join(", ");
        const call = `(${cast}${callee.name}->fn)(${argList})`;
        if (e.type.kind === "void") {
          E.line(`${call};${E.srcComment(e.loc)}`);
          if (E.indirectMayThrow) E.emitPendingCheck();
          return { name: "", type: e.type };
        }
        const t = E.newTemp(e.type, call);
        if (E.indirectMayThrow) E.emitPendingCheck();
        return t;
      }
      case "selfRef":
        // The running closure itself (env is borrowed; the result is owned).
        return E.newTemp(e.type, retainCallC(e.type, "sc_env"));
      case "new": {
        // Allocate (fields zeroed), then run the ctor. The ctor owns and
        // releases its `this` param like any callee, so it receives a +1
        // distinct from the one this expression returns.
        const t = E.newTemp(e.type, `${mangleClassNew(e.className)}()`);
        const args = e.args.map((a) => E.emitExpr(a));
        for (const a of args) E.moveTemp(a);
        const ctorArgs = [`${mangleClassRetain(e.className)}(${t.name})`, ...args.map((a) => a.name)];
        E.line(`${mangleFunction(`%${e.className}.constructor`)}(${ctorArgs.join(", ")});${E.srcComment(e.loc)}`);
        // A throwing constructor unwinds like any call; the half-built
        // object is in this frame and releases with it.
        if (E.mayThrow.has(`%${e.className}.constructor`)) E.emitPendingCheck();
        return t;
      }
      case "classRef": {
        // The class itself as a value: the immortal class object's
        // address. The +1 retain is a no-op on immortals but keeps the
        // owned-temps discipline uniform (the regexLit pattern).
        const sym = E.classObjSym(e.className);
        return E.newTemp(e.type, `scr_classobj_retain(&${sym})`);
      }
      case "newValue": {
        // Construction through a class VALUE: call the class object's
        // construct thunk. Every value legally in the slot shares the
        // static class's constructor ABI (the frontend's flow rule), so
        // the cast spells exactly that signature; the thunk returns the
        // +1 object as void * and the site reinterprets to the static
        // class (a runtime descendant is the ordinary upcast story).
        if (e.callee.type.kind !== "classval") {
          throw new Error("emitter bug: newValue on non-classval callee");
        }
        const cls = e.callee.type.className;
        const ctor = E.fnByName.get(`%${cls}.constructor`);
        if (!ctor) throw new Error(`emitter bug: newValue on ${cls} without a constructor`);
        const callee = E.emitExpr(e.callee);
        const args = e.args.map((a) => E.emitExpr(a));
        for (const a of args) E.moveTemp(a); // the constructor owns its params
        const paramTypes = ctor.params.slice(1).map((p) => cType(p.type).trim());
        const cast = `(void *(*)(${paramTypes.join(", ") || "void"}))`;
        const call = `(${cast}${callee.name}->ctor)(${args.map((a) => a.name).join(", ")})`;
        const t = E.newTemp(e.type, `(${cType(e.type).trim()})${call}`);
        if (E.newValueMayThrow(cls)) E.emitPendingCheck();
        return t;
      }
      case "instanceOfValue": {
        // The interval check with the target loaded from the class object
        // (same numbering the vtables carry). Frontend guarantees both
        // sides are hierarchy members, so the operand has a vt word.
        const v = E.emitExpr(e.value);
        const target = E.emitExpr(e.classValue);
        return E.newTemp(
          e.type,
          `${v.name}->vt->pre >= ${target.name}->pre && ${v.name}->vt->pre <= ${target.name}->post`,
        );
      }
      case "promiseVoidWiden": {
        // One ScrPromise* either way — ownership transfers, type-only.
        const v = E.emitExpr(e.value);
        E.moveTemp(v);
        return E.newTemp(e.type, v.name);
      }
      case "upcast":
      case "downcast": {
        // Prefix layout: both directions are pointer reinterprets of the
        // SAME object — no RC traffic, ownership transfers from the
        // operand temp to the result temp (the operand is struck so the
        // one +1 releases exactly once). Classval upcasts are the same
        // pointer with only the static type changing (one ScrClassObj
        // struct covers every class), so the cast is a no-op spelling.
        const v = E.emitExpr(e.value);
        E.moveTemp(v);
        return E.newTemp(e.type, `(${cType(e.type).trim()})${v.name}`);
      }
      case "instanceOf": {
        // O(1) preorder-interval test against the vtable the object
        // carries; the target's interval is a compile-time constant.
        const v = E.emitExpr(e.value);
        const target = E.classMeta.get(e.className);
        if (!target) throw new Error(`emitter bug: instanceOf against unknown class ${e.className}`);
        return E.newTemp(
          e.type,
          `${v.name}->vt->pre >= ${target.pre} && ${v.name}->vt->pre <= ${target.post}`,
        );
      }
      case "virtualCall": {
        // Dispatch through the receiver's vtable: the slot lives on the
        // method's root-most declaring class (an ancestor of the static
        // class), whose signature the slot pointer carries — the receiver
        // upcasts to it, another prefix-layout reinterpret.
        const meta = E.classMeta.get(e.className);
        if (!meta) throw new Error(`emitter bug: virtualCall on unknown class ${e.className}`);
        const slot = meta.root.slots.find(
          (sl) =>
            sl.method === e.method && sl.declarer.pre <= meta.pre && meta.pre <= sl.declarer.post,
        );
        if (!slot) throw new Error(`emitter bug: no vtable slot for ${e.className}.${e.method}`);
        const args = e.args.map((a) => E.emitExpr(a));
        for (const a of args) E.moveTemp(a); // callees own their params
        const recv = args[0]!.name;
        const recvArg =
          slot.declarer === meta ? recv : `(${mangleClassStruct(slot.declarer.def.name)} *)${recv}`;
        const vtt = mangleVtStruct(meta.root.def.name);
        const argList = [recvArg, ...args.slice(1).map((a) => a.name)].join(", ");
        const call = `((const ${vtt} *)${recv}->vt)->${slot.member}(${argList})`;
        if (e.type.kind === "void") {
          E.line(`${call};${E.srcComment(e.loc)}`);
          if (E.mayThrowMethods.has(e.method)) E.emitPendingCheck();
          return { name: "", type: e.type };
        }
        const t = E.newTemp(e.type, call);
        if (E.mayThrowMethods.has(e.method)) E.emitPendingCheck();
        return t;
      }
      case "fieldGet":
      case "recordGet": {
        const obj = E.emitExpr(e.obj);
        // Runtime error classes use ScrError's own member names.
        const member =
          e.kind === "fieldGet" && RUNTIME_ERROR_CLASSES.has(e.className)
            ? e.field
            : mangleField(e.field);
        const field = `${obj.name}->${member}`;
        return E.newTemp(e.type, isRefCounted(e.type) ? retainCallC(e.type, field) : field);
      }
      case "recordLit": {
        // Allocate (fields zeroed), then write each field IN SOURCE ORDER —
        // JS evaluates property values in source order. Ownership of
        // refcounted values moves in; the struct is fresh, so there is
        // never an old value to release. OVERFLOW entries (undeclared keys
        // of an index-signature shape) insert into the shape's overflow
        // map in the same interleaved order — the map takes ownership.
        if (e.type.kind !== "record") throw new Error("emitter bug: recordLit of non-record type");
        const rec = E.newTemp(e.type, `${mangleRecordNew(e.type.shapeId)}()`);
        for (const f of e.fields) {
          if (f.drop) {
            // A mapping-dropped field (the PromiseSettledResult subset):
            // the initializer runs in its source-order slot — effects and
            // throws included — and the result (if any) releases with the
            // statement frame instead of storing.
            E.emitExpr(f.value);
            continue;
          }
          const v = E.emitExpr(f.value);
          if (f.overflow) {
            const lit = E.internLiteral(f.name);
            const acc =
              v.type.kind === "f64" ? "f64" : v.type.kind === "bool" ? "bool" : "ref";
            if (acc === "ref") E.moveTemp(v);
            E.line(
              `scr_map_set_str_${acc}(${rec.name}->${OVERFLOW_MEMBER}, (ScrStr *)&${lit}, ${v.name});`,
            );
            continue;
          }
          if (isRefCounted(v.type)) E.moveTemp(v);
          E.line(`${rec.name}->${mangleField(f.name)} = ${v.name};`);
        }
        return rec;
      }
      case "recordKeyGet": {
        // Dynamic-keyed record read through the per-(shape, result type)
        // helper — declared-field string switch, then the overflow map.
        // Never throws (a smuggled miss traps in the helper).
        const obj = E.emitExpr(e.obj);
        const key = E.emitExpr(e.key);
        const helper = E.recordKeyGetHelper(e.shapeId, e.type, e.overflowOnly === true);
        return E.newTemp(e.type, `${helper}(${obj.name}, ${key.name})`);
      }
      case "recordOvfKeys": {
        // The overflow map's live keys in JS own-key order — a fresh
        // string[] snapshot (+1); the record is borrowed.
        const obj = E.emitExpr(e.obj);
        return E.newTemp(e.type, `scr_map_keys_js_order(${obj.name}->${OVERFLOW_MEMBER})`);
      }
      case "dynFrom": {
        // Static value → fresh dyn tree (+1) through the interned per-type
        // converter; the operand stays borrowed (frame-released as usual).
        // Bare unit literals (an `undefined`/`null` stored under an
        // `unknown` index signature) are the dyn unit values directly.
        if (e.value.kind === "unitLit") {
          return E.newTemp(
            e.type,
            e.value.unit === "undefined"
              ? "scr_dyn_retain(scr_dyn_undefined())"
              : "scr_dyn_new_null()",
          );
        }
        const v = E.emitExpr(e.value);
        if (v.type.kind === "func") {
          // A closure boxes as the checked-dynamic tree's function kind: retained closure +
          // the per-signature call thunk + the interned signature key. The
          // best-effort name rides along for inspect/error rendering (NULL
          // when the lowering had none).
          const name =
            e.fnName !== undefined && e.fnName !== ""
              ? cStringLiteral(Buffer.from(e.fnName, "utf8"))
              : "NULL";
          return E.newTemp(e.type, `${E.dynFuncBoxHelper(v.type)}(${v.name}, ${name})`);
        }
        return E.newTemp(e.type, `${E.toDynHelper(v.type)}(${v.name})`);
      }
      case "dynFromJsval": {
        // Island value → dyn: the by-reference wrap (scr_dyn_from_jsval
        // retains the cell in; engine scalars normalize to native dyn
        // kinds at wrap time). Operand borrowed, result +1, never throws.
        const v = E.emitExpr(e.value);
        return E.newTemp(e.type, `scr_dyn_from_jsval(${v.name})`);
      }
      case "dynCall": {
        // Calling a dyn value: args are already dyn (the lowering boxed or
        // converted them); everything is BORROWED by scr_dyn_call — the
        // boxed thunk builds its own typed copies — so the temps release
        // with the frame as usual. The callee's source spelling rides
        // along for Node's "<name> is not a function" TypeError.
        const callee = E.emitExpr(e.callee);
        const what = cStringLiteral(Buffer.from(e.calleeName, "utf8"));
        if (e.spreads !== undefined && e.spreads.length > 0) {
          // The RUNTIME-ARITY form (`f(...args)`): one fresh dyn array
          // collects the arguments left-to-right — plain args move in
          // (push takes ownership), spread args FLATTEN (push_spread
          // retains elements in and throws V8's spread-call TypeError for
          // non-iterable dyn kinds, checked per spread — JS's
          // ArgumentListEvaluation order) — then apply calls through the
          // array's elements (borrowed, exactly scr_dyn_call).
          const spreadAt = new Map(e.spreads.map((s) => [s.arg, s.what]));
          const pack = E.newTemp(DYN, "scr_dyn_new_arr()");
          e.args.forEach((a, i) => {
            const v = E.emitExpr(a);
            const spreadWhat = spreadAt.get(i);
            if (spreadWhat !== undefined) {
              const w = cStringLiteral(Buffer.from(spreadWhat, "utf8"));
              E.line(`scr_dyn_arr_push_spread(${pack.name}, ${v.name}, ${w});`);
              E.emitPendingCheck();
            } else {
              E.moveTemp(v);
              E.line(`scr_dyn_arr_push(${pack.name}, ${v.name});`);
            }
          });
          return E.fallibleTemp(e.type, `scr_dyn_apply(${callee.name}, ${pack.name}, ${what})`);
        }
        const args = e.args.map((a) => E.emitExpr(a));
        let argsExpr = "NULL";
        if (args.length > 0) {
          const arr = `sc_t${E.tempCounter++}`;
          E.line(`ScrDyn *${arr}[${args.length}] = { ${args.map((a) => a.name).join(", ")} };`);
          argsExpr = arr;
        }
        return E.fallibleTemp(
          e.type,
          `scr_dyn_call(${callee.name}, ${argsExpr}, ${args.length}, ${what})`,
        );
      }
      case "dynInvoke": {
        // Prototype-method dispatch on a dyn receiver: everything is
        // BORROWED by scr_dyn_invoke (temps release with the frame); the
        // result is owned and may ride a pending exception.
        const recv = E.emitExpr(e.recv);
        const args = e.args.map((a) => E.emitExpr(a));
        let argsExpr = "NULL";
        if (args.length > 0) {
          const arr = `sc_t${E.tempCounter++}`;
          E.line(`ScrDyn *${arr}[${args.length}] = { ${args.map((a) => a.name).join(", ")} };`);
          argsExpr = arr;
        }
        const method = cStringLiteral(Buffer.from(e.method, "utf8"));
        const what = cStringLiteral(Buffer.from(e.calleeName, "utf8"));
        return E.fallibleTemp(
          e.type,
          `scr_dyn_invoke(${recv.name}, ${method}, ${argsExpr}, ${args.length}, ${what})`,
        );
      }
      case "dynArrLit": {
        // A dyn array built element-by-element: ownership of each dyn
        // element MOVES into the array (scr_dyn_arr_push's contract).
        const arr = E.newTemp(e.type, "scr_dyn_new_arr()");
        for (const el of e.elems) {
          const v = E.emitExpr(el);
          E.moveTemp(v);
          E.line(`scr_dyn_arr_push(${arr.name}, ${v.name});`);
        }
        return arr;
      }
      case "dynObjLit": {
        // A dyn object built member-by-member: key then value, source
        // order (JS's literal evaluation). scr_dyn_key_set BORROWS all
        // three (the member retains the value in), so key/value temps
        // release with the frame as usual; the receiver is a fresh OBJ,
        // so the non-object throw paths are unreachable here.
        const obj = E.newTemp(e.type, "scr_dyn_new_obj()");
        for (const f of e.fields ?? []) {
          const k = E.emitExpr(f.key);
          const v = E.emitExpr(f.value);
          E.line(`scr_dyn_key_set(${obj.name}, ${k.name}, ${v.name});`);
        }
        return obj;
      }
      case "unionWrap": {
        // Construct a fresh immutable tagged box. Ownership of a refcounted
        // payload MOVES into the union (which stores the arm's _v RC entry
        // points so a generic release can free it); scalars ride the slot.
        // Unit arms (undefined/null) carry NO payload: every wrap yields
        // THE interned immortal instance for this (union, tag) — no
        // allocation, and the frame's release is a no-op (rc == SIZE_MAX,
        // which the RC entry points and the cycle collector both skip).
        const arm = e.value.type;
        if (isUnitType(arm)) {
          return E.newTemp(e.type, E.unitInstanceRef(e.unionId, e.tag));
        }
        // A VOID payload (a void call wrapping into an undefined arm):
        // evaluate for effects, produce the interned unit instance.
        if (arm.kind === "void") {
          E.emitExpr(e.value);
          return E.newTemp(e.type, E.unitInstanceRef(e.unionId, e.tag));
        }
        const v = E.emitExpr(e.value);
        if (isRefCounted(arm)) {
          E.moveTemp(v);
          const rc = vAdapters(arm);
          return E.newTemp(
            e.type,
            `scr_union_new_ref(${e.tag}, ${v.name}, &${rc.retain}, &${rc.release}, ${E.traceArgC(arm)})`,
          );
        }
        if (arm.kind === "f64") return E.newTemp(e.type, `scr_union_new_f64(${e.tag}, ${v.name})`);
        if (arm.kind === "bool") return E.newTemp(e.type, `scr_union_new_bool(${e.tag}, ${v.name})`);
        throw new Error(`emitter bug: unionWrap of ${arm.kind}`);
      }
      case "unionNarrow": {
        // Tag-UNCHECKED payload extraction: the frontend emits this only
        // where tsc's control-flow narrowing proved the tag (docs/ir.md).
        // Ref payloads come out +1 via the arm's CONCRETE retain (statically
        // known here — no need for the stored fn ptr); the union temp itself
        // releases with this statement's frame as usual.
        const u = E.emitExpr(e.value);
        const arm = e.type;
        if (isUnitType(arm)) throw new Error(`emitter bug: unionNarrow to unit arm ${arm.kind}`);
        if (arm.kind === "f64") return E.newTemp(arm, `scr_union_get_f64(${u.name})`);
        if (arm.kind === "bool") return E.newTemp(arm, `scr_union_get_bool(${u.name})`);
        const payload = `(${cType(arm).trim()})scr_union_peek(${u.name})`;
        return E.newTemp(arm, retainCallC(arm, payload));
      }
      case "unionDisc": {
        // Shared-field read `r.kind` / `spec.config`: switch on the runtime
        // tag and read the (same-typed) field from the concretely-cast
        // payload. Ref-counted results come out retained (+1), owned by
        // this frame.
        const u = E.emitExpr(e.value);
        const def = E.unionsById.get(e.unionId);
        if (!def) throw new Error(`emitter bug: unionDisc of unknown union ${e.unionId}`);
        const name = `sc_t${E.tempCounter++}`;
        E.line(`${cDecl(e.type, name)};`);
        E.line(`switch (${u.name}->tag) {`);
        E.indent++;
        def.arms.forEach((arm, i) => {
          if (arm.kind !== "record" && arm.kind !== "object") {
            throw new Error(`emitter bug: unionDisc arm of kind ${arm.kind}`);
          }
          // cType names the arm's struct (incl. the runtime ScrError for
          // builtin error arms, whose members are unmangled).
          const member =
            arm.kind === "object" && RUNTIME_ERROR_CLASSES.has(arm.className)
              ? e.field
              : mangleField(e.field);
          const read = `((${cType(arm).trim()})scr_union_peek(${u.name}))->${member}`;
          const value = isRefCounted(e.type) ? retainCallC(e.type, read) : read;
          E.line(`case ${i}: ${name} = ${value}; break;`);
        });
        E.line(`default: scr_trap("scriptc: internal error: invalid union tag\\n");`);
        E.indent--;
        E.line(`}`);
        if (isRefCounted(e.type)) E.currentFrame().push({ name, type: e.type });
        return { name, type: e.type };
      }
      case "unionKeyGet": {
        // The unionDisc generalization: switch on the runtime tag; each arm
        // answers at the JOIN type — a declared field reads its slot
        // (wrapping an arm-typed answer into the join), an index-signature
        // arm goes through the shared keyed-read helper (owned result,
        // missing-key policy included), and a unit arm answers the interned
        // undefined arm (the optional-chain tail's short-circuit value).
        const u = E.emitExpr(e.value);
        const k = E.emitExpr(e.key);
        const def = E.unionsById.get(e.unionId);
        if (!def) throw new Error(`emitter bug: unionKeyGet of unknown union ${e.unionId}`);
        const resultDef = e.type.kind === "union" ? E.unionsById.get(e.type.unionId) : undefined;
        const literal = e.key.kind === "strLit" ? e.key.value : null;
        const name = `sc_t${E.tempCounter++}`;
        E.line(`${cDecl(e.type, name)};`);
        E.line(`switch (${u.name}->tag) {`);
        E.indent++;
        def.arms.forEach((arm, i) => {
          if (isUnitType(arm)) {
            const tag = resultDef?.arms.findIndex((a) => a.kind === "undefinedT") ?? -1;
            if (tag < 0 || e.type.kind !== "union") {
              throw new Error("emitter bug: unionKeyGet unit arm without an undefined result arm");
            }
            E.line(`case ${i}: ${name} = ${E.unitInstanceRef(e.type.unionId, tag)}; break;`);
            return;
          }
          if (arm.kind === "array") {
            // A NUMBER-keyed element read (the chain-tail `u?.split(":")[0]`
            // form): the runtime getter answers owned (+1 for ref
            // elements); invalid indices trap (divergence 4). The result
            // wraps into the join when unit arms widened it.
            const read = `scr_arr_get_${elemAccess(arm.elem)}((${cType(arm).trim()})scr_union_peek(${u.name}), ${k.name})`;
            if (typeEquals(arm.elem, e.type)) {
              E.line(`case ${i}: ${name} = ${read}; break;`);
              return;
            }
            const tag = resultDef?.arms.findIndex((a) => typeEquals(a, arm.elem)) ?? -1;
            if (tag < 0 || e.type.kind !== "union" || isUnitType(arm.elem)) {
              throw new Error(`emitter bug: unionKeyGet element ${arm.elem.kind} outside the join`);
            }
            const wrapped =
              arm.elem.kind === "f64"
                ? `scr_union_new_f64(${tag}, ${read})`
                : arm.elem.kind === "bool"
                  ? `scr_union_new_bool(${tag}, ${read})`
                  : (() => {
                      const rc = vAdapters(arm.elem);
                      // The element read is already owned (+1) — ownership
                      // MOVES into the union box, no extra retain.
                      return `scr_union_new_ref(${tag}, ${read}, &${rc.retain}, &${rc.release}, ${E.traceArgC(arm.elem)})`;
                    })();
            E.line(`case ${i}: ${name} = ${wrapped}; break;`);
            return;
          }
          if (arm.kind !== "record") throw new Error(`emitter bug: unionKeyGet arm of kind ${arm.kind}`);
          const shape = E.recordsById.get(arm.shapeId);
          if (!shape) throw new Error(`emitter bug: unionKeyGet arm of unknown shape ${arm.shapeId}`);
          const declared = literal !== null ? shape.fields.find((f) => f.name === literal) : undefined;
          if (declared) {
            const ft = declared.type;
            const read = `((${cType(arm).trim()})scr_union_peek(${u.name}))->${mangleField(declared.name)}`;
            if (typeEquals(ft, e.type)) {
              E.line(`case ${i}: ${name} = ${isRefCounted(ft) ? retainCallC(ft, read) : read}; break;`);
              return;
            }
            const tag = resultDef?.arms.findIndex((a) => typeEquals(a, ft)) ?? -1;
            if (tag < 0 || e.type.kind !== "union" || isUnitType(ft)) {
              throw new Error(`emitter bug: unionKeyGet arm answer ${ft.kind} outside the join`);
            }
            const wrapped =
              ft.kind === "f64"
                ? `scr_union_new_f64(${tag}, ${read})`
                : ft.kind === "bool"
                  ? `scr_union_new_bool(${tag}, ${read})`
                  : (() => {
                      const rc = vAdapters(ft);
                      return `scr_union_new_ref(${tag}, ${retainCallC(ft, read)}, &${rc.retain}, &${rc.release}, ${E.traceArgC(ft)})`;
                    })();
            E.line(`case ${i}: ${name} = ${wrapped}; break;`);
            return;
          }
          // Index-signature arm (or declared-only shape under a runtime
          // key): the per-(shape, join type) keyed-read helper — a literal
          // key naming no declared field touches only the overflow map.
          const helper = E.recordKeyGetHelper(arm.shapeId, e.type, literal !== null && !!shape.indexValue);
          E.line(`case ${i}: ${name} = ${helper}((${cType(arm).trim()})scr_union_peek(${u.name}), ${k.name}); break;`);
        });
        E.line(`default: scr_trap("scriptc: internal error: invalid union tag\\n");`);
        E.indent--;
        E.line(`}`);
        if (isRefCounted(e.type)) E.currentFrame().push({ name, type: e.type });
        return { name, type: e.type };
      }
      case "unionIsTag": {
        // A pure tag compare — the box is borrowed, no payload is touched.
        const u = E.emitExpr(e.value);
        return E.newTemp(e.type, `${u.name}->tag ${e.negated ? "!=" : "=="} ${e.tag}`);
      }
      case "dynKeyGet": {
        // Keyed read on the checked-dynamic tree through the one interned helper — the
        // non-optional form throws JS's TypeError on an undefined/null
        // receiver, and HANDLE receivers can throw the loud unmodeled-
        // property ladder on EITHER form, so both ride a fallible temp;
        // the result is owned (+1).
        const d = E.emitExpr(e.value);
        const k = E.emitExpr(e.key);
        const helper = dynKeyGetHelper(E);
        const call = `${helper}(${d.name}, ${k.name}, ${e.optional ? "true" : "false"})`;
        return E.fallibleTemp(e.type, call);
      }
      case "dynHasKey": {
        // `"k" in pkg`: a kind-guarded presence answer, computed against
        // the literal key at compile time — no allocation, borrowed box.
        // An ISLAND-held receiver fences loudly (Node asks the real
        // engine object — `false` would be a silent wrong answer), so
        // the temp rides the fallible path.
        const d = E.emitExpr(e.value);
        const keyBytes = Buffer.from(e.key, "utf8");
        const keyLit = cStringLiteral(keyBytes);
        const objTest = `scr_dyn_obj_get(${d.name}, ${keyLit}, ${keyBytes.length}) != NULL`;
        const arrTest =
          e.key === "length"
            ? "true"
            : /^(0|[1-9][0-9]*)$/.test(e.key) && Number(e.key) <= Number.MAX_SAFE_INTEGER
              ? `${d.name}->v.arr.len > ${e.key}`
              : "false";
        const test = `(${d.name}->kind == SCR_DYN_OBJ ? (${objTest}) : ${d.name}->kind == SCR_DYN_ARR ? (${arrTest}) : scr_dyn_isl_fence(${d.name}, "'in'"))`;
        return E.fallibleTemp(e.type, e.negated ? `!${test}` : test);
      }
      case "dynScalarEq": {
        // dyn vs scalar strict equality: kind test + payload compare.
        // Operands emit in SOURCE order (JS evaluation order); the dyn
        // side is found by type. Both borrowed, no allocation.
        const l = E.emitExpr(e.left);
        const r = E.emitExpr(e.right);
        const [d, s, st] = e.left.type.kind === "dyn" ? [l, r, e.right.type] : [r, l, e.left.type];
        const test =
          st.kind === "dyn"
            ? // dyn vs dyn: whole-dyn strict equality (scalars by value,
              // units by kind, reference kinds by node identity).
              `scr_dyn_strict_eq(${l.name}, ${r.name})`
            : st.kind === "string"
            ? `(${d.name}->kind == SCR_DYN_STR && scr_str_eq(${d.name}->v.str, ${s.name}))`
            : st.kind === "f64"
              ? `(${d.name}->kind == SCR_DYN_NUM && ${d.name}->v.num == ${s.name})`
              : `(${d.name}->kind == SCR_DYN_BOOL && ${d.name}->v.b == ${s.name})`;
        return E.newTemp(e.type, e.negated ? `!${test}` : test);
      }
      case "dynTest": {
        // A pure kind compare on the dyn node — borrowed; only the truthy
        // form also reads a scalar payload. ISLAND-held nodes (the jsval
        // kind — engine objects/arrays/functions only, scalars normalize
        // at wrap time) route the tests that depend on the engine's
        // answer through the scr_dyn_isl_* helpers (false on every other
        // kind, so the calls stay unconditional); narrowing never changes
        // representation (SEMANTICS.md).
        const d = E.emitExpr(e.value);
        const test =
          e.test === "nullish"
            ? `(${d.name}->kind == SCR_DYN_UNDEF || ${d.name}->kind == SCR_DYN_NULL)`
            : e.test === "object"
              ? // `typeof v === "object"`: objects, arrays, bytes, native
                // handles, promises, AND null — engine-held objects by the
                // engine's own typeof.
                `(${d.name}->kind == SCR_DYN_OBJ || ${d.name}->kind == SCR_DYN_ARR || ${d.name}->kind == SCR_DYN_BYTES || ${d.name}->kind == SCR_DYN_HANDLE || ${d.name}->kind == SCR_DYN_PROMISE || ${d.name}->kind == SCR_DYN_NULL || scr_dyn_isl_typeof_is(${d.name}, "object"))`
              : e.test === "truthy"
                ? // ToBoolean over the checked-dynamic tree: bool by value; number falsy for
                  // 0, -0 (== 0 in C), and NaN (self-inequality); string
                  // falsy when empty; obj/arr/bytes/func/handle always true;
                  // JSVAL through the runtime's routed arm (the bigint 0n
                  // edge); the remaining kinds (undefined, null) always false.
                  `(${d.name}->kind == SCR_DYN_BOOL ? ${d.name}->v.b : ${d.name}->kind == SCR_DYN_NUM ? (${d.name}->v.num == ${d.name}->v.num && ${d.name}->v.num != 0) : ${d.name}->kind == SCR_DYN_STR ? ${d.name}->v.str->len != 0 : ${d.name}->kind == SCR_DYN_JSVAL ? scr_dyn_truthy(${d.name}) : (${d.name}->kind == SCR_DYN_OBJ || ${d.name}->kind == SCR_DYN_ARR || ${d.name}->kind == SCR_DYN_BYTES || ${d.name}->kind == SCR_DYN_FUNC || ${d.name}->kind == SCR_DYN_HANDLE || ${d.name}->kind == SCR_DYN_PROMISE))`
                : e.test === "error"
                  ? // `u instanceof Error`: the checked-dynamic tree's error encoding — an
                    // object carrying the reserved "%error" marker key
                    // (built by caughtToDyn for Error payloads) — or a real
                    // engine Error held by reference.
                    `((${d.name}->kind == SCR_DYN_OBJ && scr_dyn_obj_get(${d.name}, "%error", 6) != NULL) || scr_dyn_isl_is_error(${d.name}))`
                  : e.test === "array"
                    ? // Array.isArray: the checked-dynamic tree's array kind, or the engine's
                      // own answer for an engine-held value.
                      `(${d.name}->kind == SCR_DYN_ARR || scr_dyn_isl_is_array(${d.name}))`
                    : e.test === "function"
                      ? `(${d.name}->kind == SCR_DYN_FUNC || scr_dyn_isl_typeof_is(${d.name}, "function"))`
                      : `${d.name}->kind == ${
                          { string: "SCR_DYN_STR", number: "SCR_DYN_NUM", boolean: "SCR_DYN_BOOL", undefined: "SCR_DYN_UNDEF", null: "SCR_DYN_NULL", bytes: "SCR_DYN_BYTES" }[e.test]
                        }`;
        return E.newTemp(e.type, e.negated ? `!(${test})` : test);
      }
      case "unionEq": {
        // Strict equality (or Object.is's SameValue — the f64 arm's
        // compare is the one difference) of the ARM values via the
        // per-union helper (tag compare + per-arm payload compare). Both
        // boxes are borrowed.
        const l = E.emitExpr(e.left);
        const r = E.emitExpr(e.right);
        const call = `${E.unionEqHelper(e.unionId, e.sameValue)}(${l.name}, ${r.name})`;
        return E.newTemp(e.type, e.negated ? `!${call}` : call);
      }
      case "caughtTest": {
        // Kind-tag tests read the snapshot directly; instanceof compares an
        // OBJ payload's vtable preorder against the class's compile-time
        // interval (false for every other payload kind). Box borrowed.
        const c = E.emitExpr(e.value);
        if (e.test === "instanceof") {
          const target = E.classMeta.get(e.className!);
          if (!target) throw new Error(`emitter bug: caughtTest against unknown class ${e.className}`);
          const test = `scr_caught_instanceof(${c.name}, ${target.pre}, ${target.post})`;
          return E.newTemp(e.type, e.negated ? `!${test}` : test);
        }
        const tag = { string: "SCR_EXC_STR", number: "SCR_EXC_F64", boolean: "SCR_EXC_BOOL" }[e.test];
        return E.newTemp(e.type, `${c.name}->kind ${e.negated ? "!=" : "=="} ${tag}`);
      }
      case "caughtCheck": {
        // Checked payload extraction (`e as C`): instanceof match extracts
        // +1, anything else throws the catchable TypeError — the result
        // joins the frame BEFORE the pending check so an unwind releases
        // the NULL dummy harmlessly. Box borrowed.
        const c = E.emitExpr(e.value);
        const target = E.classMeta.get(e.className);
        if (!target) throw new Error(`emitter bug: caughtCheck against unknown class ${e.className}`);
        const display = e.className.startsWith("%") ? e.className.slice(1) : e.className;
        return E.fallibleTemp(
          e.type,
          `(${cType(e.type).trim()})scr_caught_check_obj(${c.name}, ${target.pre}, ${target.post}, ${cStringLiteral(Buffer.from(display, "utf8"))})`,
        );
      }
      case "caughtNarrow": {
        // Checker-trusted extraction (the matching caughtTest was proven by
        // tsc's narrowing): scalars read the snapshot's slots, refcounted
        // payloads come out retained (+1). Box borrowed.
        const c = E.emitExpr(e.value);
        if (e.type.kind === "f64") return E.newTemp(e.type, `${c.name}->f64`);
        if (e.type.kind === "bool") return E.newTemp(e.type, `${c.name}->b`);
        if (e.type.kind === "string") {
          return E.newTemp(e.type, `scr_str_retain((ScrStr *)${c.name}->payload)`);
        }
        if (e.type.kind === "object") {
          return E.newTemp(e.type, `(${cType(e.type).trim()})${c.name}->retain_fn(${c.name}->payload)`);
        }
        throw new Error(`emitter bug: caughtNarrow to ${e.type.kind}`);
      }
      case "caughtToDyn": {
        // The caught snapshot converting to a dyn value (an unknown
        // slot) — the interned runtime-kind dispatch. Box borrowed; the
        // result is a fresh tree (+1). Never throws.
        const c = E.emitExpr(e.value);
        return E.newTemp(e.type, `${E.caughtToDynHelper()}(${c.name})`);
      }
      case "intrinsic": {
        if (e.name === "promise.all") {
          // The runtime countdown combinator: a pre-sized values array
          // (filled per INPUT index by the per-kind store helper as
          // entries fulfill) plus one subscription per entry — settled
          // entries settle inline, the first rejection wins, later
          // rejections count as handled. A void inner type passes no
          // values array and the result fulfills void.
          if (e.type.kind !== "promise") throw new Error("emitter bug: promise.all type");
          const entries = e.args[0]!;
          if (entries.type.kind !== "array" || entries.type.elem.kind !== "promise") {
            throw new Error("emitter bug: promise.all argument");
          }
          const ps = E.emitExpr(entries);
          if (e.type.inner.kind === "void") {
            return E.newTemp(e.type, `scr_promise_all(${ps.name}, NULL, NULL)`);
          }
          if (e.type.inner.kind !== "array") throw new Error("emitter bug: promise.all result");
          const elem = e.type.inner.elem;
          const store =
            elem.kind === "f64"
              ? "scr_promise_all_store_f64"
              : elem.kind === "bool"
                ? "scr_promise_all_store_bool"
                : elem.kind === "string"
                  ? "scr_promise_all_store_str"
                  : "scr_promise_all_store_ref";
          // Entry array and values array both stay frame-owned; the
          // combinator BORROWS them and retains what it keeps (the race
          // convention).
          const vals = E.newTemp(e.type.inner, E.arrNewC(elem, `(size_t)scr_arr_len(${ps.name})`));
          return E.newTemp(e.type, `scr_promise_all(${ps.name}, ${vals.name}, &${store})`);
        }
        if (e.name === "promise.reject") {
          // A fresh promise rejected through the exception cell: the
          // %Error-rooted reason moves in as the cell's OBJ payload
          // (exactly the thrown-Error representation — catch instanceof
          // and the uncaught printer see a thrown Error), and
          // reject_pending moves the cell into the promise, wakes
          // nothing (no waiters can exist yet), and enters the unhandled
          // ledger until an await/then observes it. The cell is consumed
          // immediately, so no pending check runs in between.
          if (e.type.kind !== "promise") throw new Error("emitter bug: promise.reject type");
          const reason = E.emitExpr(e.args[0]!);
          const t = e.args[0]!.type;
          if (t.kind !== "object" && t.kind !== "dyn") {
            throw new Error("emitter bug: promise.reject reason");
          }
          const p = E.newTemp(e.type, `scr_promise_new()`);
          E.moveTemp(reason); // the cell takes ownership
          const rc = vAdapters(t);
          if (t.kind === "dyn") {
            // The thrown-dyn representation (REF + dyn adapters): catch
            // bindings and the unhandled dispatch see the dyn value
            // itself — identity preserved.
            E.line(
              `scr_throw_ref(${reason.name}, &${rc.retain}, &${rc.release}, NULL);${E.srcComment(e.loc)}`,
            );
          } else {
            E.line(
              `scr_throw_obj(${reason.name}, &${rc.retain}, &${rc.release}, ${E.traceArgC(t)});${E.srcComment(e.loc)}`,
            );
          }
          E.line(`scr_promise_reject_pending(${p.name});`);
          return p;
        }
        if (e.name === "promise.resolve") {
          // A fresh promise fulfilled immediately: void/f64/bool by
          // value, strings and refs MOVE in (fulfill takes the +1 — the
          // moveTemp keeps the frame from double-releasing), matching the
          // async-return trampoline's fulfill exactly. No waiters exist
          // yet, so the wake is a no-op.
          if (e.type.kind !== "promise") throw new Error("emitter bug: promise.resolve type");
          const p = E.newTemp(e.type, `scr_promise_new()`);
          if (e.args.length === 0) {
            E.line(`scr_promise_fulfill_void(${p.name});${E.srcComment(e.loc)}`);
            return p;
          }
          const v = E.emitExpr(e.args[0]!);
          const t = e.args[0]!.type;
          switch (t.kind) {
            case "f64":
              E.line(`scr_promise_fulfill_f64(${p.name}, ${v.name});${E.srcComment(e.loc)}`);
              break;
            case "bool":
              E.line(`scr_promise_fulfill_bool(${p.name}, ${v.name});${E.srcComment(e.loc)}`);
              break;
            case "string":
              E.moveTemp(v);
              E.line(`scr_promise_fulfill_str(${p.name}, ${v.name});${E.srcComment(e.loc)}`);
              break;
            default: {
              const rc = vAdapters(t);
              E.moveTemp(v);
              E.line(
                `scr_promise_fulfill_ref(${p.name}, ${v.name}, ${rc.retain}, ${rc.release}, ${E.traceArgC(t)});${E.srcComment(e.loc)}`,
              );
            }
          }
          return p;
        }
        if (e.name === "promise.race") {
          // A fresh result promise + one race_add per entry: settled
          // entries settle it immediately (first add wins), pending ones
          // park a callback waiter. The interned adapter converts each
          // entry's payload to the result's inner type; entry temps stay
          // frame-owned (race_add retains what it keeps).
          if (e.type.kind !== "promise") throw new Error("emitter bug: promise.race type");
          const result = E.newTemp(e.type, `scr_promise_new()`);
          for (const entry of e.args) {
            if (entry.type.kind !== "promise") throw new Error("emitter bug: promise.race entry");
            const p = E.emitExpr(entry);
            const adapter = E.raceAdapterFor(entry.type.inner, e.type.inner);
            E.line(`scr_promise_race_add(${result.name}, ${p.name}, &${adapter});${E.srcComment(e.loc)}`);
          }
          return result;
        }
        // console.log and its stderr twin console.error share the ScrLogArg
        // packing; only the runtime entry point (stream) differs.
        const args = e.args.map((a) => E.emitExpr(a));
        const arr = `sc_t${E.tempCounter++}`;
        E.line(`ScrLogArg ${arr}[${Math.max(args.length, 1)}];`);
        args.forEach((a, i) => {
          switch (a.type.kind) {
            case "f64":
              E.line(`${arr}[${i}].tag = SCR_ARG_F64; ${arr}[${i}].v.f = ${a.name};`);
              break;
            case "string":
              E.line(`${arr}[${i}].tag = SCR_ARG_STR; ${arr}[${i}].v.s = ${a.name};`);
              break;
            case "bool":
              E.line(`${arr}[${i}].tag = SCR_ARG_BOOL; ${arr}[${i}].v.b = ${a.name};`);
              break;
            default:
              throw new Error(`${e.name} arg of type ${a.type.kind}`);
          }
        });
        const consoleFn = e.name === "console.error" ? "scr_console_error" : "scr_console_log";
        E.line(`${consoleFn}(${args.length}, ${arr});${E.srcComment(e.loc)}`);
        return { name: "", type: e.type };
      }
      case "libCall": {
        // Standard-library call. Args are BORROWED (owned temps of the
        // current frame, released at statement end); refcounted results come
        // back +1 (process.argv: +1 on the runtime's ONE interned array —
        // JS identity — everything else fresh). Throwing members (the
        // may-throw seed set) get the standard pending check, emitted after
        // a result temp joins its frame so an unwind releases it.
        const args = e.args.map((a) => E.emitExpr(a));
        const arg = (i: number) => args[i]!.name;
        const finish = (call: string): Temp => {
          if (e.type.kind === "void") {
            E.line(`${call};${E.srcComment(e.loc)}`);
            if (MAY_THROW_LIB_FNS.has(e.fn)) E.emitPendingCheck();
            return { name: "", type: e.type };
          }
          const t = E.newTemp(e.type, call);
          if (MAY_THROW_LIB_FNS.has(e.fn)) E.emitPendingCheck();
          return t;
        };
        const fn = e.fn;
        switch (fn) {
          case "island.eval":
            // --dynamic builds only (the frontend fences the intrinsic, so
            // scr_island_eval is always linked when this emits). Borrows
            // the source; returns +1 String(result), or bridges the island
            // exception into the cell (may-throw seed set).
            return finish(`scr_island_eval(${arg(0)})`);
          case "island.import":
            // --dynamic builds only. Loads an EMBEDDED npm module (main
            // registered the table before %main ran) through the island's
            // module loader — cached by the engine, so one evaluation per
            // module — and takes one export as an owned jsval. A package's
            // top-level throw bridges catchably (may-throw seed set), and a
            // MISSING named export throws Node's link-time SyntaxError
            // naming the written specifier (arg 2). Arg 3 distinguishes
            // import (typeless warning enabled) from require(esm)
            // (syntax detection remains silent).
            return finish(`scr_jsval_import(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)})`);
          case "island.importDyn":
            // --dynamic builds only. Dynamic import(): the island's module
            // system answers an ENGINE promise of the namespace — load and
            // evaluation failures REJECT it (Node's shape), so the call
            // itself never throws; the frontend's jsBridgePromise carries
            // the settlement across. +1 jsval holding the engine promise.
            return finish(`scr_jsval_import_dyn(${arg(0)})`);
          case "island.castFail":
            // The deferred boundary failure: the island value was
            // evaluated (arg 0 — its side effects are real), the throw is
            // unconditional (catchable TypeError naming the target type),
            // and the typed dummy is a NULL promise the pending check
            // abandons (releases are NULL-tolerant).
            return finish(`(scr_jsval_cast_fail(${arg(0)}, ${arg(1)}), NULL)`);
          case "json.parse":
            // Borrows the text; returns +1 on a fresh dyn, or throws a
            // catchable SyntaxError-shaped string (may-throw seed set).
            return finish(`scr_json_parse(${arg(0)})`);
          case "dyn.defineProps":
            // Object.defineProperties over dyn values: both borrowed,
            // result the target (+1); throws catchably (may-throw seed).
            return finish(`scr_dyn_define_props(${arg(0)}, ${arg(1)})`);
          case "dyn.hasKey":
            // `k in v` with a runtime key: the dyn presence answer (both
            // borrowed, no allocation, never throws).
            return finish(`scr_dyn_has_key(${arg(0)}, ${arg(1)})`);
          case "dyn.keySet":
            // Keyed write on a dyn receiver: all three borrowed (the
            // member retains the value in); throws Node's TypeErrors on
            // non-object receivers (may-throw seed set).
            return finish(`scr_dyn_key_set(${arg(0)}, ${arg(1)}, ${arg(2)})`);
          case "dyn.iterPack":
            // Destructuring/for-of pack over a dyn source: both borrowed,
            // fresh array +1; throws V8's not-iterable TypeError on
            // non-iterable dyn kinds and drains wrapped engine values
            // through the engine's protocol (may-throw seed set).
            return finish(`scr_dyn_iter_pack(${arg(0)}, ${arg(1)})`);
          case "dyn.arrLen":
            // The for-of pack's length (borrowed; never throws).
            return finish(`scr_dyn_arr_len(${arg(0)})`);
          case "dyn.arrAt":
            // The for-of pack's element at index (+1; never throws — the
            // undefined singleton past the end).
            return finish(`scr_dyn_arr_at(${arg(0)}, ${arg(1)})`);
          case "dyn.typeof":
            // Bare typeof on a dyn value: the dyn kind's JS answer (+1).
            return finish(`scr_dyn_typeof(${arg(0)})`);
          case "dyn.toString":
            // Receiver-kind-dispatched toString (+1); throws Node's
            // TypeError on undefined/null and the "is not a function"
            // TypeError on null-prototype dictionaries (may-throw seed
            // set) — args[2] carries the call's source spelling.
            return finish(`scr_dyn_to_string_method(${arg(0)}, ${arg(1)}, ${arg(2)})`);
          case "fs.readFileSync":
            // args[1] is the (always-"utf8") encoding: evaluated for
            // JS-exact side-effect order, ignored by the runtime.
            return finish(`scr_fs_read_file(${arg(0)})`);
          case "fs.readFileSyncBuf":
            return finish(`scr_fs_read_file_bytes(${arg(0)})`);
          case "fs.readFileSyncDyn":
            return finish(`scr_fs_read_file_sync_dyn(${arg(0)}, ${arg(1)})`);
          case "fs.writeFileSync":
            return finish(`scr_fs_write_file(${arg(0)}, ${arg(1)})`);
          case "fs.appendFileSync":
            return finish(`scr_fs_append_file(${arg(0)}, ${arg(1)})`);
          case "fs.existsSync":
            return finish(`scr_fs_exists(${arg(0)})`);
          case "fs.mkdirSync":
            return finish(`scr_fs_mkdir(${arg(0)})`);
          case "fs.rmSync":
            return finish(`scr_fs_rm(${arg(0)})`);
          case "fs.rmdirSync":
            return finish(`scr_fs_rmdir(${arg(0)})`);
          case "fs.readdirSync":
            return finish(`scr_fs_readdir(${arg(0)})`);
          case "fs.readdirTypesSync": {
            // Dirent rows assembled inline from one scandir snapshot
            // (scr_lib.c) — the os.networkInterfaces pattern, flat. The
            // frontend/validator pinned the shape ({%dtype, name,
            // parentPath}); lookups here only guard emitter bugs. The
            // snapshot call throws Node's scandir error (may-throw seed
            // set) and answers NULL then, so the pending check runs
            // before any allocation.
            if (e.type.kind !== "array" || e.type.elem.kind !== "record") {
              throw new Error("emitter bug: readdirTypesSync result is not a record array");
            }
            const recT = e.type.elem;
            const snap = `sc_t${E.tempCounter++}`;
            E.line(`ScrScandir *${snap} = scr_fs_scandir(${arg(0)});${E.srcComment(e.loc)}`);
            E.emitPendingCheck();
            const out = E.newTemp(e.type, E.arrNewC(recT, `scr_fs_scandir_count(${snap})`));
            const i = `sc_t${E.tempCounter++}`;
            const n = `sc_t${E.tempCounter++}`;
            E.line(`for (size_t ${i} = 0, ${n} = scr_fs_scandir_count(${snap}); ${i} < ${n}; ${i}++) {`);
            E.indent++;
            const row = `sc_t${E.tempCounter++}`;
            E.line(`${mangleRecordStruct(recT.shapeId)} *${row} = ${mangleRecordNew(recT.shapeId)}();`);
            E.line(`${row}->${mangleField("%dtype")} = scr_fs_scandir_type(${snap}, ${i});`);
            E.line(`${row}->${mangleField("name")} = scr_fs_scandir_name(${snap}, ${i});`);
            E.line(`${row}->${mangleField("parentPath")} = ${retainCallC({ kind: "string" }, arg(0))};`);
            E.line(`scr_arr_push_ref(${out.name}, ${row});`); // push takes ownership of the row
            E.indent--;
            E.line(`}`);
            E.line(`scr_fs_scandir_free(${snap});`);
            return out;
          }
          // node:path (scr_path.c): pure string algorithms, POSIX rules.
          // join/resolve borrow ONE packed string[] (the frontend built it);
          // results are always +1 fresh strings. None of these throw.
          case "path.join":
            return finish(`scr_path_join(${arg(0)})`);
          case "path.resolve":
            return finish(`scr_path_resolve(${arg(0)})`);
          case "path.normalize":
            return finish(`scr_path_normalize(${arg(0)})`);
          case "path.dirname":
            return finish(`scr_path_dirname(${arg(0)})`);
          case "path.basename":
            return finish(`scr_path_basename(${arg(0)}, ${arg(1)})`);
          case "path.extname":
            return finish(`scr_path_extname(${arg(0)})`);
          case "path.isAbsolute":
            return finish(`scr_path_is_absolute(${arg(0)})`);
          case "path.relative":
            return finish(`scr_path_relative(${arg(0)}, ${arg(1)})`);
          case "path.toNamespacedPath":
            return finish(`scr_path_to_namespaced_path(${arg(0)})`);
          // The win32 family (Node v24's path.win32 in scr_path.c): the
          // path.win32 namespace anywhere, and the bare module's binding
          // under a win32 target.
          case "path.win32Join":
            return finish(`scr_path_win32_join(${arg(0)})`);
          case "path.win32Resolve":
            return finish(`scr_path_win32_resolve(${arg(0)})`);
          case "path.win32Normalize":
            return finish(`scr_path_win32_normalize(${arg(0)})`);
          case "path.win32Dirname":
            return finish(`scr_path_win32_dirname(${arg(0)})`);
          case "path.win32Basename":
            return finish(`scr_path_win32_basename(${arg(0)}, ${arg(1)})`);
          case "path.win32Extname":
            return finish(`scr_path_win32_extname(${arg(0)})`);
          case "path.win32IsAbsolute":
            return finish(`scr_path_win32_is_absolute(${arg(0)})`);
          case "path.win32Relative":
            return finish(`scr_path_win32_relative(${arg(0)}, ${arg(1)})`);
          case "path.win32ToNamespacedPath":
            return finish(`scr_path_win32_to_namespaced_path(${arg(0)})`);
          case "os.homedir":
            return finish(`scr_os_homedir()`);
          case "os.type":
            return finish(`scr_os_type()`);
          case "os.totalmem":
            return finish(`scr_os_totalmem()`);
          case "os.release":
            return finish(`scr_os_release()`);
          case "os.userName":
            return finish(`scr_os_user_name()`);
          case "os.userShell":
            return finish(`scr_os_user_shell()`);
          case "os.userHomedir":
            return finish(`scr_os_user_homedir()`);
          case "os.tmpdir":
            return finish(`scr_os_tmpdir()`);
          case "os.networkInterfaces": {
            // The Dict<NetworkInterfaceInfo[]> record, built inline from a
            // getifaddrs(3) snapshot (scr_lib.c) — the dgram.address
            // pattern scaled up. Every shape/union/tag below comes from
            // the call's own type; the frontend verified the structure
            // (lowerOsNetworkInterfacesCall), so lookups here only guard
            // against emitter bugs. Rows append to their interface's
            // bucket in snapshot order; a first row makes the bucket (a
            // fresh Info[] wrapped into the `Info[] | undefined` union arm
            // the overflow map stores).
            if (e.type.kind !== "record") throw new Error("emitter bug: networkInterfaces result is not a record");
            const dictShape = E.recordsById.get(e.type.shapeId);
            const iv = dictShape?.indexValue;
            if (!dictShape || iv?.kind !== "union") throw new Error("emitter bug: networkInterfaces dict shape");
            const ivDef = E.unionsById.get(iv.unionId);
            const arrTag = ivDef?.arms.findIndex((a) => a.kind === "array") ?? -1;
            const arrT = ivDef?.arms[arrTag];
            if (arrT?.kind !== "array" || arrT.elem.kind !== "union") throw new Error("emitter bug: networkInterfaces bucket type");
            const infoT = arrT.elem;
            const infoDef = E.unionsById.get(infoT.unionId);
            if (!infoDef || infoDef.arms.length !== 2) throw new Error("emitter bug: networkInterfaces Info union");
            const tag6 = infoDef.arms.findIndex(
              (a) => a.kind === "record" && E.recordsById.get(a.shapeId)?.fields.find((f) => f.name === "scopeid")?.type.kind === "f64",
            );
            const tag4 = 1 - tag6;
            const armShape = (tag: number): { t: IrType & { kind: "record" }; shape: IrRecordShape } => {
              const t = infoDef.arms[tag];
              if (t?.kind !== "record") throw new Error("emitter bug: networkInterfaces Info arm");
              const shape = E.recordsById.get(t.shapeId);
              if (!shape) throw new Error("emitter bug: networkInterfaces Info shape");
              return { t, shape };
            };
            const dict = E.newTemp(e.type, `${mangleRecordNew(e.type.shapeId)}()`);
            const snap = `sc_t${E.tempCounter++}`;
            const i = `sc_t${E.tempCounter++}`;
            const n = `sc_t${E.tempCounter++}`;
            E.line(`ScrIfaddrs *${snap} = scr_os_ifaddrs();${E.srcComment(e.loc)}`);
            E.line(`for (size_t ${i} = 0, ${n} = scr_os_ifaddrs_count(${snap}); ${i} < ${n}; ${i}++) {`);
            E.indent++;
            const row = `sc_t${E.tempCounter++}`;
            E.line(`ScrUnion *${row};`);
            const emitRow = (tag: number, v6: boolean): void => {
              const { t, shape } = armShape(tag);
              const cidrT = shape.fields.find((f) => f.name === "cidr")?.type;
              const cidrDef = cidrT?.kind === "union" ? E.unionsById.get(cidrT.unionId) : undefined;
              if (cidrT?.kind !== "union" || !cidrDef) throw new Error("emitter bug: networkInterfaces cidr type");
              const cidrStrTag = cidrDef.arms.findIndex((a) => a.kind === "string");
              const cidrNullTag = cidrDef.arms.findIndex((a) => a.kind === "nullT");
              const r = `sc_t${E.tempCounter++}`;
              const struct = mangleRecordStruct(t.shapeId);
              E.line(`${struct} *${r} = ${mangleRecordNew(t.shapeId)}();`);
              E.line(`${r}->${mangleField("address")} = scr_os_ifaddrs_address(${snap}, ${i});`);
              E.line(`${r}->${mangleField("netmask")} = scr_os_ifaddrs_netmask(${snap}, ${i});`);
              E.line(`${r}->${mangleField("family")} = scr_os_ifaddrs_family(${snap}, ${i});`);
              E.line(`${r}->${mangleField("mac")} = scr_os_ifaddrs_mac(${snap}, ${i});`);
              E.line(`${r}->${mangleField("internal")} = scr_os_ifaddrs_internal(${snap}, ${i});`);
              const cs = `sc_t${E.tempCounter++}`;
              E.line(`ScrStr *${cs} = scr_os_ifaddrs_cidr(${snap}, ${i});`);
              E.line(
                `${r}->${mangleField("cidr")} = ${cs} ? scr_union_new_ref(${cidrStrTag}, ${cs}, &scr_str_retain_v, &scr_str_release_v, NULL) : scr_union_retain(${E.unitInstanceRef(cidrT.unionId, cidrNullTag)});`,
              );
              if (v6) {
                E.line(`${r}->${mangleField("scopeid")} = scr_os_ifaddrs_scopeid(${snap}, ${i});`);
              } else {
                const st = shape.fields.find((f) => f.name === "scopeid")?.type;
                if (st?.kind !== "union") throw new Error("emitter bug: networkInterfaces IPv4 scopeid type");
                const undefTag = E.undefinedArmTag(st);
                E.line(`${r}->${mangleField("scopeid")} = scr_union_retain(${E.unitInstanceRef(st.unionId, undefTag)});`);
              }
              const rc = vAdapters(t);
              E.line(`${row} = scr_union_new_ref(${tag}, ${r}, &${rc.retain}, &${rc.release}, ${E.traceArgC(t)});`);
            };
            E.line(`if (scr_os_ifaddrs_ipv6(${snap}, ${i})) {`);
            E.indent++;
            emitRow(tag6, true);
            E.indent--;
            E.line(`} else {`);
            E.indent++;
            emitRow(tag4, false);
            E.indent--;
            E.line(`}`);
            const name = `sc_t${E.tempCounter++}`;
            const cell = `sc_t${E.tempCounter++}`;
            const rows = `sc_t${E.tempCounter++}`;
            E.line(`ScrStr *${name} = scr_os_ifaddrs_name(${snap}, ${i});`);
            E.line(`ScrUnion *${cell} = scr_map_get_str_ref(${dict.name}->${OVERFLOW_MEMBER}, ${name});`);
            E.line(`ScrArr *${rows};`);
            E.line(`if (${cell}) {`);
            E.indent++;
            E.line(`${rows} = scr_arr_retain((ScrArr *)scr_union_peek(${cell}));`);
            E.line(`scr_union_release(${cell});`);
            E.indent--;
            E.line(`} else {`);
            E.indent++;
            E.line(`${rows} = ${E.arrNewC(infoT, 1)};`);
            const arrRc = vAdapters(arrT);
            E.line(
              `scr_map_set_str_ref(${dict.name}->${OVERFLOW_MEMBER}, ${name}, scr_union_new_ref(${arrTag}, scr_arr_retain(${rows}), &${arrRc.retain}, &${arrRc.release}, ${E.traceArgC(arrT)}));`,
            );
            E.indent--;
            E.line(`}`);
            E.line(`scr_arr_push_ref(${rows}, ${row});`); // push takes ownership of the row
            E.line(`scr_arr_release(${rows});`);
            E.line(`scr_str_release(${name});`);
            E.indent--;
            E.line(`}`);
            E.line(`scr_os_ifaddrs_free(${snap});`);
            return dict;
          }
          // Math.max/min over one spread number[] — the JS fold in C
          // (NaN poisons, ±0 order, empty → ∓Infinity). Borrows; no throw.
          case "math.maxArr":
            return finish(`scr_math_max_arr(${arg(0)})`);
          case "math.minArr":
            return finish(`scr_math_min_arr(${arg(0)})`);
          // Math.floor/trunc/ceil — the C functions ARE the JS operations
          // (math.h is always included). Borrow nothing; no throw.
          case "math.floor":
            return finish(`floor(${arg(0)})`);
          case "math.trunc":
            return finish(`trunc(${arg(0)})`);
          case "math.ceil":
            return finish(`ceil(${arg(0)})`);
          // Math.abs — C fabs IS the JS operation. Math.round — the JS
          // half-toward-+Infinity rule (scr_lib.c; C round() differs on
          // halves and naive floor(x+0.5) drifts at the epsilon boundary).
          case "math.abs":
            return finish(`fabs(${arg(0)})`);
          case "math.round":
            return finish(`scr_math_round(${arg(0)})`);
          // The scalar Math.min/max (scr_lib.c — fmin/fmax drop NaN, so
          // these are the JS folds) and Math.random (arc4random-backed
          // uniform [0,1), SEMANTICS.md 62). Borrow nothing; no throw.
          case "math.min":
            return finish(`scr_math_min(${arg(0)}, ${arg(1)})`);
          case "math.max":
            return finish(`scr_math_max(${arg(0)}, ${arg(1)})`);
          case "math.random":
            return finish(`scr_math_random()`);
          // The static global parsers/tests (scr_string.c). Borrow; no throw.
          case "num.parseInt":
            return finish(`scr_parse_int(${arg(0)}, ${arg(1)})`);
          case "num.parseFloat":
            return finish(`scr_parse_float(${arg(0)})`);
          case "num.fromString":
            return finish(`scr_string_to_number(${arg(0)})`);
          case "num.isNaN":
            return finish(`(bool)isnan(${arg(0)})`);
          // The URI codecs (scr_string.c). Borrow; results +1. decode
          // throws the spec's catchable URIError on bad hex or invalid
          // UTF-8 octets (may-throw seed set); the encoders never throw.
          case "str.encodeUriComponent":
            return finish(`scr_str_encode_uri_component(${arg(0)})`);
          case "str.decodeUriComponent":
            return finish(`scr_str_decode_uri_component(${arg(0)})`);
          case "str.encodeUri":
            return finish(`scr_encode_uri(${arg(0)})`);
          // RegExp.escape (scr_string.c): total per-code-point escape —
          // borrows, +1 result, never throws.
          case "regexp.escape":
            return finish(`scr_regexp_escape(${arg(0)})`);
          // The WHATWG base64 globals (scr_string.c): dyn arg borrowed
          // (WebIDL ToString in the runtime), +1 string result; malformed
          // input throws the catchable DOMException InvalidCharacterError
          // (may-throw seed set). The zero-argument form always throws
          // Node's TypeError [ERR_MISSING_ARGS].
          case "str.atob":
            return finish(`scr_atob(${arg(0)})`);
          case "str.btoa":
            return finish(`scr_btoa(${arg(0)})`);
          case "str.b64Missing":
            return finish(`scr_b64_missing_arg()`);
          // Number.prototype formatters (scr_lib.c). Borrow nothing;
          // successful results +1; explicit toFixed may throw RangeError.
          case "num.toExponential":
            return finish(`scr_num_to_exponential(${arg(0)})`);
          case "num.toFixed0":
            return finish(`scr_num_to_fixed0(${arg(0)})`);
          case "num.toFixed":
            return finish(`scr_num_to_fixed(${arg(0)}, ${arg(1)})`);
          // Object.is over two numbers — SameValue on doubles. No throw.
          case "num.sameValue":
            return finish(`scr_num_same_value(${arg(0)}, ${arg(1)})`);
          // Intl.NumberFormat("en-US").format / toLocaleString("en-US")
          // with default options (scr_lib.c). +1 string; no throw.
          case "intl.numFormatEnUs":
            return finish(`scr_intl_num_format_en_us(${arg(0)})`);
          // The URL surface (scr_url.c): construction and the two
          // fileURLToPath receiver forms throw catchable TypeErrors
          // (may-throw seed set); the getters are pure reads. Receivers
          // and string args are borrowed; every result is +1.
          // ES symbols (scr_symbol.c — linked exactly when these appear,
          // moduleUsesSymbol). Fresh identities (+1); Symbol.for answers
          // +1 on the registry's interned per-key symbol. None throw.
          case "sym.new":
            return finish(`scr_sym_new(${arg(0)})`);
          case "sym.newAnon":
            return finish(`scr_sym_new(NULL)`);
          case "sym.for":
            return finish(`scr_sym_for(${arg(0)})`);
          case "sym.toString":
            return finish(`scr_sym_to_string(${arg(0)})`);
          case "sym.desc":
          case "sym.keyFor": {
            // `string | undefined` — the child.stdout pattern with a
            // string arm: the runtime answers a +1 string or NULL.
            if (e.type.kind !== "union") {
              throw new Error(`emitter bug: ${e.fn} result is not a union`);
            }
            const def = E.unionsById.get(e.type.unionId);
            const strTag = def ? def.arms.findIndex((a) => a.kind === "string") : -1;
            const undefTag = def ? def.arms.findIndex((a) => a.kind === "undefinedT") : -1;
            if (strTag < 0 || undefTag < 0) {
              throw new Error(`emitter bug: ${e.fn} union lacks its arms`);
            }
            const get = e.fn === "sym.desc" ? "scr_sym_desc" : "scr_sym_key_for";
            const raw = E.newTemp(STRING, `${get}(${arg(0)})`);
            E.moveTemp(raw); // ownership passes into the union arm below
            const present = `scr_union_new_ref(${strTag}, ${raw.name}, &scr_str_retain_v, &scr_str_release_v, NULL)`;
            const absent = E.unitInstanceRef(e.type.unionId, undefTag);
            return E.newTemp(e.type, `${raw.name} != NULL ? ${present} : ${absent}`);
          }
          case "url.new":
            return finish(`scr_url_new(${arg(0)})`);
          case "url.protocol":
            return finish(`scr_url_protocol(${arg(0)})`);
          case "url.host":
            return finish(`scr_url_host(${arg(0)})`);
          case "url.hostname":
            return finish(`scr_url_hostname(${arg(0)})`);
          case "url.pathname":
            return finish(`scr_url_pathname(${arg(0)})`);
          case "url.href":
            return finish(`scr_url_href(${arg(0)})`);
          case "url.fileURLToPathUrl":
            return finish(`scr_url_to_path(${arg(0)})`);
          case "url.fileURLToPathStr":
            return finish(`scr_url_str_to_path(${arg(0)})`);
          case "url.pathToFileURL":
          // The win32-target flavor is the SAME entry point (the bridge
          // dispatches by _WIN32) — the distinct name exists for the
          // may-throw seed (the win32 arm's UNC TypeErrors).
          case "url.pathToFileURLWin32":
            return finish(`scr_url_from_path(${arg(0)})`);
          // URLSearchParams (scr_url.c — always linked with the url unit).
          // Constructions come back +1; sp.fromPairs throws Node's
          // ERR_INVALID_TUPLE catchably (may-throw seed set). Mutators are
          // void borrowed-receiver calls; a live view's URL query updates
          // inside the runtime.
          case "sp.new":
            return finish(`scr_sp_new()`);
          case "sp.parse":
            return finish(`scr_sp_parse(${arg(0)})`);
          case "sp.copy":
            return finish(`scr_sp_copy(${arg(0)})`);
          case "sp.fromPairs":
            return finish(`scr_sp_from_pairs(${arg(0)})`);
          case "sp.with":
            return finish(`scr_sp_with(${arg(0)}, ${arg(1)}, ${arg(2)})`);
          case "url.searchParams":
            return finish(`scr_url_search_params(${arg(0)})`);
          case "url.search":
            return finish(`scr_url_search(${arg(0)})`);
          case "sp.get": {
            // `string | null` — the sym.desc pattern with a null arm: the
            // runtime answers a +1 string or NULL.
            if (e.type.kind !== "union") {
              throw new Error("emitter bug: sp.get result is not a union");
            }
            const def = E.unionsById.get(e.type.unionId);
            const strTag = def ? def.arms.findIndex((a) => a.kind === "string") : -1;
            const nullTag = def ? def.arms.findIndex((a) => a.kind === "nullT") : -1;
            if (strTag < 0 || nullTag < 0) {
              throw new Error("emitter bug: sp.get union lacks its arms");
            }
            const raw = E.newTemp(STRING, `scr_sp_get(${arg(0)}, ${arg(1)})`);
            E.moveTemp(raw); // ownership passes into the union arm below
            const present = `scr_union_new_ref(${strTag}, ${raw.name}, &scr_str_retain_v, &scr_str_release_v, NULL)`;
            const absent = E.unitInstanceRef(e.type.unionId, nullTag);
            return E.newTemp(e.type, `${raw.name} != NULL ? ${present} : ${absent}`);
          }
          case "sp.getAll":
            return finish(`scr_sp_get_all(${arg(0)}, ${arg(1)})`);
          case "sp.append":
            return finish(`scr_sp_append(${arg(0)}, ${arg(1)}, ${arg(2)})`);
          case "sp.set":
            return finish(`scr_sp_set(${arg(0)}, ${arg(1)}, ${arg(2)})`);
          case "sp.delete":
            return finish(`scr_sp_delete(${arg(0)}, ${arg(1)})`);
          case "sp.deleteValue":
            return finish(`scr_sp_delete_value(${arg(0)}, ${arg(1)}, ${arg(2)})`);
          case "sp.has":
            return finish(`scr_sp_has(${arg(0)}, ${arg(1)})`);
          case "sp.hasValue":
            return finish(`scr_sp_has_value(${arg(0)}, ${arg(1)}, ${arg(2)})`);
          case "sp.sort":
            return finish(`scr_sp_sort(${arg(0)})`);
          case "sp.size":
            return finish(`scr_sp_size(${arg(0)})`);
          case "sp.toString":
            return finish(`scr_sp_to_string(${arg(0)})`);
          case "sp.keyAt":
            return finish(`scr_sp_key_at(${arg(0)}, ${arg(1)})`);
          case "sp.valAt":
            return finish(`scr_sp_val_at(${arg(0)}, ${arg(1)})`);
          // node:querystring (scr_qs.c — linked exactly when parse/
          // stringify/unescape appear, moduleUsesQs). escape IS the
          // component encoder (Node's qsEscape set equals
          // encodeURIComponent's), so it emits the always-linked codec
          // and never pulls the unit. Borrow; string results +1; no throw.
          case "qs.escape":
            return finish(`scr_str_encode_uri_component(${arg(0)})`);
          case "qs.unescape":
            return finish(`scr_qs_unescape(${arg(0)})`);
          case "qs.stringify":
            return finish(`scr_qs_stringify(${arg(0)}, ${arg(1)}, ${arg(2)})`);
          case "qs.parse": {
            // The ParsedUrlQuery dictionary: a fresh pure-index-signature
            // record whose overflow map the runtime scan fills
            // (scr_qs_parse_into groups repeats into string[] buckets).
            // The frontend verified the shape (lowerQuerystringParseCall);
            // lookups here only guard emitter bugs. Args: qs, sep, eq,
            // maxKeys.
            if (e.type.kind !== "record") throw new Error("emitter bug: qs.parse result is not a record");
            const dictShape = E.recordsById.get(e.type.shapeId);
            const iv = dictShape?.indexValue;
            if (!dictShape || iv?.kind !== "union") throw new Error("emitter bug: qs.parse dict shape");
            const ivDef = E.unionsById.get(iv.unionId);
            const strTag = ivDef?.arms.findIndex((a) => a.kind === "string") ?? -1;
            const arrTag = ivDef?.arms.findIndex((a) => a.kind === "array") ?? -1;
            if (strTag < 0 || arrTag < 0) throw new Error("emitter bug: qs.parse index union lacks its arms");
            const dict = E.newTemp(e.type, `${mangleRecordNew(e.type.shapeId)}()`);
            E.line(
              `scr_qs_parse_into(${dict.name}->${OVERFLOW_MEMBER}, ${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)}, ${strTag}, ${arrTag});${E.srcComment(e.loc)}`,
            );
            return dict;
          }
          // Stats (scr_lib.c): statSync throws like the other sync fs
          // calls; the getters are pure reads.
          case "fs.openSync":
            // Throws Node-shaped fs errors (may-throw seed set); the fd
            // comes back as f64.
            return finish(`scr_fs_open(${arg(0)}, ${arg(1)})`);
          case "fs.readSync":
            return finish(`scr_fs_read_sync(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)})`);
          case "fs.closeSync":
            return finish(`scr_fs_close(${arg(0)})`);
          case "fs.watch":
            // Throws Node-shaped fs errors when the path won't open
            // (may-throw seed set). An open watcher holds the loop:
            // usesTimers.
            E.usesTimers = true;
            return finish(`scr_fs_watch(${arg(0)}, NULL, NULL)`);
          case "fs.watchCb": {
            // The callback MOVES into the watcher's registry; the adapter
            // is runtime-provided per listener shape (zero-param, or the
            // eventType string).
            E.usesTimers = true;
            const cbT = e.args[1]!.type;
            if (cbT.kind !== "func") throw new Error("emitter bug: fs.watchCb callback not a func");
            const cb = args[1]!;
            E.moveTemp(cb);
            const adapter = cbT.params.length === 0 ? "scr_watch_thunk0" : "scr_watch_thunk_event";
            return finish(`scr_fs_watch(${arg(0)}, ${cb.name}, &${adapter})`);
          }
          case "crypto.x509Fingerprint":
            // Throws Node's PEM error on unparseable input (may-throw).
            return finish(`scr_crypto_x509_fingerprint(${arg(0)})`);
          case "crypto.x509FingerprintStr":
            return finish(`scr_crypto_x509_fingerprint_str(${arg(0)})`);
          case "crypto.x509ValidFrom":
            // The Validity walk shares the fingerprint's PEM contract
            // (may-throw); the string is Node's ASN1_TIME_print shape.
            return finish(`scr_crypto_x509_valid_from(${arg(0)})`);
          case "crypto.x509ValidFromStr":
            return finish(`scr_crypto_x509_valid_from_str(${arg(0)})`);
          case "crypto.x509ValidTo":
            return finish(`scr_crypto_x509_valid_to(${arg(0)})`);
          case "crypto.x509ValidToStr":
            return finish(`scr_crypto_x509_valid_to_str(${arg(0)})`);
          case "watcher.close":
            E.line(`scr_watcher_close(${arg(0)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "fs.statSync":
            return finish(`scr_fs_stat(${arg(0)})`);
          case "stats.isSymbolicLink":
            return finish(`scr_stats_is_symlink(${arg(0)})`);
          case "stats.mtimeMs":
            return finish(`scr_stats_mtime_ms(${arg(0)})`);
          case "stats.isFile":
            return finish(`scr_stats_is_file(${arg(0)})`);
          case "stats.isDirectory":
            return finish(`scr_stats_is_dir(${arg(0)})`);
          case "stats.size":
            return finish(`scr_stats_size(${arg(0)})`);
          // child_process.spawnSync (scr_child.c): blocks until the child
          // is reaped — NEVER throws (spawn failure is data: status null,
          // empty outputs). cmd and args are borrowed; the result is +1.
          case "cp.spawnSync":
            return finish(`scr_spawn_sync(${arg(0)}, ${arg(1)})`);
          case "cp.spawnSyncOpts":
            // The options form: timeout/killSignal/stdio modes. Same
            // never-throws contract — timeout and spawn failure are data
            // on the result (error/signal), exactly Node's spawnSync.
            return finish(
              `scr_spawn_sync_opts(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)}, ${arg(4)}, ${arg(5)}, ${arg(6)})`,
            );
          case "cp.spawnSyncStdioStr":
            // The runtime maps the type-proven "pipe"/"ignore"/"inherit"
            // string to the three modes; same never-throws contract.
            return finish(
              `scr_spawn_sync_stdio_str(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)}, ${arg(4)})`,
            );
          case "cp.execSync":
            // Throws Node's exec errors; the +1 stdout result must join
            // the frame BEFORE the pending check (fallibleTemp) so an
            // unwind releases the NULL dummy harmlessly.
            return E.fallibleTemp(
              e.type,
              `scr_exec_sync(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)}, ${arg(4)}, ${arg(5)}, ${arg(6)}, ${arg(7)}, ${arg(8)}, ${arg(9)}, ${arg(10)})`,
            );
          case "cp.execCapture":
            // The promisified-execFile core: throws Node's ASYNC exec
            // errors (the interned async helper's fiber makes them the
            // rejection); +1 spawnRes result, same fallible discipline.
            return E.fallibleTemp(
              e.type,
              `scr_exec_capture(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)}, ${arg(4)}, ${arg(5)})`,
            );
          case "spawnRes.status": {
            // The `number | null` union, constructed type-directedly like
            // process.envGet: the exit code wraps the f64 arm; signal
            // death and spawn failure yield the interned null-arm
            // instance (the runtime exposes a has_status flag + code).
            if (e.type.kind !== "union") {
              throw new Error("emitter bug: spawnRes.status result is not a union");
            }
            const def = E.unionsById.get(e.type.unionId);
            const f64Tag = def ? def.arms.findIndex((a) => a.kind === "f64") : -1;
            const nullTag = def ? def.arms.findIndex((a) => a.kind === "nullT") : -1;
            if (f64Tag < 0 || nullTag < 0) {
              throw new Error("emitter bug: spawnRes.status union lacks its arms");
            }
            const present = `scr_union_new_f64(${f64Tag}, scr_spawn_res_status(${arg(0)}))`;
            const absent = E.unitInstanceRef(e.type.unionId, nullTag);
            return E.newTemp(
              e.type,
              `scr_spawn_res_has_status(${arg(0)}) ? ${present} : ${absent}`,
            );
          }
          case "spawnRes.stdout":
            return finish(`scr_spawn_res_stdout(${arg(0)})`);
          case "spawnRes.stderr":
            return finish(`scr_spawn_res_stderr(${arg(0)})`);
          case "spawnRes.signal": {
            // The `string | null` union (the termination signal's name,
            // null for a normal exit or spawn failure) — the has/get pair
            // wrapped type-directedly like spawnRes.status.
            if (e.type.kind !== "union") {
              throw new Error("emitter bug: spawnRes.signal result is not a union");
            }
            const def = E.unionsById.get(e.type.unionId);
            const strTag = def ? def.arms.findIndex((a) => a.kind === "string") : -1;
            const nullTag = def ? def.arms.findIndex((a) => a.kind === "nullT") : -1;
            if (strTag < 0 || nullTag < 0) {
              throw new Error("emitter bug: spawnRes.signal union lacks its arms");
            }
            const sv = E.newTemp(
              STRING,
              `scr_spawn_res_has_signal(${arg(0)}) ? scr_spawn_res_signal(${arg(0)}) : NULL`,
            );
            E.moveTemp(sv); // moves into the box when present; NULL otherwise
            const present = `scr_union_new_ref(${strTag}, ${sv.name}, &scr_str_retain_v, &scr_str_release_v, NULL)`;
            const absent = E.unitInstanceRef(e.type.unionId, nullTag);
            return E.newTemp(e.type, `${sv.name} ? ${present} : ${absent}`);
          }
          case "spawnRes.error": {
            // The `Error | undefined` union, the envGet convention: a
            // spawn failure hands back a fresh +1 %Error (ownership moves
            // into the union box); otherwise the interned undefined arm.
            if (e.type.kind !== "union") {
              throw new Error("emitter bug: spawnRes.error result is not a union");
            }
            const def = E.unionsById.get(e.type.unionId);
            const errTag = def ? def.arms.findIndex((a) => a.kind === "object" && a.className === "%Error") : -1;
            const undefTag = E.undefinedArmTag(e.type);
            if (errTag < 0 || undefTag < 0) {
              throw new Error("emitter bug: spawnRes.error union lacks its arms");
            }
            const errT: IrType = { kind: "object", className: "%Error" };
            const ev = E.newTemp(errT, `scr_spawn_res_error(${arg(0)})`);
            E.moveTemp(ev); // moves into the box when present; NULL otherwise
            const present = `scr_union_new_ref(${errTag}, ${ev.name}, &scr_error_retain_v, &scr_error_release_v, ${E.traceArgC(errT)})`;
            const absent = E.unitInstanceRef(e.type.unionId, undefTag);
            return E.newTemp(e.type, `${ev.name} ? ${present} : ${absent}`);
          }
          case "child.pid":
          case "child.exitCode": {
            // pid: `number | undefined` (undefined = spawn failure);
            // exitCode: `number | null` (null while running / signal
            // death) — the spawnRes.status construction over the has/get
            // runtime pairs.
            if (e.type.kind !== "union") {
              throw new Error(`emitter bug: ${e.fn} result is not a union`);
            }
            const def = E.unionsById.get(e.type.unionId);
            const wantUnit = e.fn === "child.pid" ? "undefinedT" : "nullT";
            const f64Tag = def ? def.arms.findIndex((a) => a.kind === "f64") : -1;
            const unitTag = def ? def.arms.findIndex((a) => a.kind === wantUnit) : -1;
            if (f64Tag < 0 || unitTag < 0) {
              throw new Error(`emitter bug: ${e.fn} union lacks its arms`);
            }
            const has = e.fn === "child.pid" ? "scr_child_has_pid" : "scr_child_has_exit_code";
            const get = e.fn === "child.pid" ? "scr_child_pid" : "scr_child_exit_code";
            const present = `scr_union_new_f64(${f64Tag}, ${get}(${arg(0)}))`;
            const absent = E.unitInstanceRef(e.type.unionId, unitTag);
            return E.newTemp(e.type, `${has}(${arg(0)}) ? ${present} : ${absent}`);
          }
          case "child.stdout":
          case "child.stderr": {
            // `Readable | null` — the child.pid pattern with a REF arm:
            // the runtime answers a +1 stream handle or NULL (not piped).
            if (e.type.kind !== "union") {
              throw new Error(`emitter bug: ${e.fn} result is not a union`);
            }
            const def = E.unionsById.get(e.type.unionId);
            const streamTag = def ? def.arms.findIndex((a) => a.kind === "childStream") : -1;
            const nullTag = def ? def.arms.findIndex((a) => a.kind === "nullT") : -1;
            if (streamTag < 0 || nullTag < 0) {
              throw new Error(`emitter bug: ${e.fn} union lacks its arms`);
            }
            const get = e.fn === "child.stdout" ? "scr_child_stdout" : "scr_child_stderr";
            const raw = E.newTemp(CHILDSTREAM_T, `${get}(${arg(0)})`);
            E.moveTemp(raw); // ownership passes into the union arm below
            const present = `scr_union_new_ref(${streamTag}, ${raw.name}, &scr_child_stream_retain_v, &scr_child_stream_release_v, NULL)`;
            const absent = E.unitInstanceRef(e.type.unionId, nullTag);
            return E.newTemp(e.type, `${raw.name} != NULL ? ${present} : ${absent}`);
          }
          case "stream.onData": {
            // The callback MOVES into the stream's listener registry; the
            // adapter is per callback shape — runtime-provided for the
            // zero-param and Buffer forms, emitted per union for the
            // `Buffer | string` chunk (the chunk wraps at its Buffer arm).
            E.usesTimers = true; // a flowing stream holds the loop
            const cbT = e.args[1]!.type;
            if (cbT.kind !== "func") throw new Error("emitter bug: stream.onData callback not a func");
            const cb = args[1]!;
            E.moveTemp(cb);
            const param = cbT.params[0];
            const adapter =
              param === undefined
                ? "scr_child_stream_thunk0"
                : param.kind === "union"
                  ? E.childDataThunkFor(param)
                  : "scr_child_stream_thunk_bytes";
            E.line(
              `scr_child_stream_on_data(${arg(0)}, ${cb.name}, &${adapter}, ${arg(2)});${E.srcComment(e.loc)}`,
            );
            return { name: "", type: e.type };
          }
          case "stream.onEnd": {
            const cb = args[1]!;
            E.moveTemp(cb);
            E.line(`scr_child_stream_on_end(${arg(0)}, ${cb.name}, ${arg(2)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "procStream.write":
            // The receiver IS the fd scalar; dispatches onto the exact
            // promptly-submitted stdout/stderr paths (ordering identical).
            return finish(`scr_proc_stream_write(${arg(0)}, ${arg(1)})`);
          case "child.killed":
            return finish(`scr_child_killed(${arg(0)})`);
          case "child.kill":
            // Throws the Unknown-signal TypeError on bad names (may-throw).
            return finish(`scr_child_kill(${arg(0)}, ${arg(1)})`);
          case "child.killNum":
            return finish(`scr_child_kill_num(${arg(0)}, ${arg(1)})`);
          case "child.unref":
            return finish(`scr_child_unref(${arg(0)})`);
          // child_process.spawn (scr_child.c + the event loop): the child
          // starts NOW (posix_spawnp); the loop reaps it and fires its
          // listeners. Never throws — spawn failure defers to "error".
          case "cp.spawn":
            E.usesTimers = true; // the loop must run to reap the child
            return finish(`scr_spawn(${arg(0)}, ${arg(1)})`);
          case "cp.spawnOpts":
            // The options form: per-slot stdio (ignore/inherit/fd — the
            // fds dup2 into the child), detached (setsid), env
            // replacement, cwd. Same loop/reap story as cp.spawn.
            E.usesTimers = true;
            return finish(
              `scr_spawn_opts(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)}, ${arg(4)}, ${arg(5)}, ${arg(6)}, ${arg(7)}, ${arg(8)}, ${arg(9)}, ${arg(10)})`,
            );
          case "child.onExit": {
            // The callback MOVES into the child's registry; the third
            // ingredient is the ADAPTER — emitted per callback shape,
            // because the `number | null` union's tags are program data
            // (a zero-param listener gets the runtime's ignoring thunk).
            const cbT = e.args[1]!.type;
            if (cbT.kind !== "func") throw new Error("emitter bug: child.onExit callback not a func");
            const cb = args[1]!;
            E.moveTemp(cb);
            const adapter =
              cbT.params.length === 0
                ? "scr_child_exit_thunk0"
                : cbT.params.length === 1
                  ? E.childExitThunkFor(cbT.params[0]!)
                  : E.childExitThunkFor2(cbT.params[0]!, cbT.params[1]!);
            E.line(
              `scr_child_on_exit(${arg(0)}, ${cb.name}, &${adapter});${E.srcComment(e.loc)}`,
            );
            return { name: "", type: e.type };
          }
          // node:net (scr_net.c + the loop's net hook — linked only when
          // these appear on the IR). Receivers and data are borrowed;
          // CALLBACKS MOVE into the handle's registry (released at
          // settlement). listen/connect make the loop live: usesTimers.
          case "net.createServer":
            return finish(`scr_net_create_server(NULL, NULL)`);
          case "net.createServerCb": {
            const cbT = e.args[0]!.type;
            if (cbT.kind !== "func") throw new Error("emitter bug: net.createServerCb handler not a func");
            const cb = args[0]!;
            E.moveTemp(cb);
            const adapter = cbT.params.length === 0 ? "scr_net_conn_thunk0" : "scr_net_conn_thunk_sock";
            return finish(`scr_net_create_server(${cb.name}, &${adapter})`);
          }
          case "net.listen":
            E.usesTimers = true; // a listening server holds the loop open
            E.line(`scr_net_listen(${arg(0)}, ${arg(1)}, NULL);${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "net.listenCb": {
            E.usesTimers = true;
            const cb = args[2]!;
            E.moveTemp(cb);
            E.line(`scr_net_listen(${arg(0)}, ${arg(1)}, ${cb.name});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "net.listenOpts":
            E.usesTimers = true;
            E.line(`scr_net_listen_opts(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)}, NULL);${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "net.listenOptsCb": {
            E.usesTimers = true;
            // The callback slot may be the `(() => void) | undefined`
            // optional-binding union: unwrap to a nullable closure (the
            // createSecureServerSni pattern).
            const cbT = e.args[4]!.type;
            let cbExpr: string;
            if (cbT.kind === "func") {
              const cb = args[4]!;
              E.moveTemp(cb);
              cbExpr = cb.name;
            } else {
              if (cbT.kind !== "union") throw new Error("emitter bug: net.listenOptsCb callback shape");
              const def = E.unionsById.get(cbT.unionId);
              const funcTag = def ? def.arms.findIndex((a) => a.kind === "func") : -1;
              if (funcTag < 0) throw new Error("emitter bug: net.listenOptsCb union lacks its func arm");
              const u = args[4]!;
              const t = E.newTemp(
                def!.arms[funcTag]!,
                `${u.name}->tag == ${funcTag} ? scr_closure_retain((ScrClosure *)scr_union_peek(${u.name})) : NULL`,
              );
              E.moveTemp(t);
              cbExpr = t.name;
            }
            E.line(`scr_net_listen_opts(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)}, ${cbExpr});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "net.serverPort":
            return finish(`scr_net_server_port(${arg(0)})`);
          case "net.serverAddress": {
            // The AddressInfo record from the three runtime reads (the
            // dgram.address materialization; none of these throw).
            if (e.type.kind !== "record") throw new Error("emitter bug: net.serverAddress result is not a record");
            const ip = E.newTemp(STRING, `scr_net_server_addr_ip(${arg(0)})`);
            const rec = E.newTemp(e.type, `${mangleRecordNew(e.type.shapeId)}()`);
            E.moveTemp(ip);
            E.line(`${rec.name}->${mangleField("address")} = ${ip.name};`);
            E.line(`${rec.name}->${mangleField("family")} = scr_net_server_addr_family(${arg(0)});`);
            E.line(`${rec.name}->${mangleField("port")} = scr_net_server_port(${arg(0)});`);
            return rec;
          }
          case "net.serverClose":
            E.line(`scr_net_server_close(${arg(0)}, NULL);${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "net.serverCloseCb": {
            const cb = args[1]!;
            E.moveTemp(cb);
            E.line(`scr_net_server_close(${arg(0)}, ${cb.name});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "net.serverCloseBind": {
            // The bound REAL close as a value: an emitted adapter behind
            // a fresh closure whose one env slot holds the +1 server.
            if (e.type.kind !== "func") throw new Error("emitter bug: net.serverCloseBind result not a func");
            const fnSym = E.closeBindThunkFor(e.type.params[0]!, e.type.ret.kind === "netServer");
            const bound = E.newTemp(e.type, `scr_closure_new((void *)&${fnSym}, 1)`);
            E.line(`${bound.name}->caps[0] = scr_box_new_obj(&scr_net_server_retain_v, &scr_net_server_release_v, NULL);`);
            E.line(`scr_box_set_ref(${bound.name}->caps[0], scr_net_server_retain(${arg(0)}));`);
            return bound;
          }
          case "net.serverSetCloseOverride": {
            // The override MOVES into the server's slot behind the
            // emitted zero-arg wrapper (the runtime can't build the
            // callback union — tags are program data).
            const cbT = e.args[1]!.type;
            if (cbT.kind !== "func") throw new Error("emitter bug: close override not a func");
            const wrapSym = E.closeOverrideWrapFor(cbT.params[0]!, cbT.ret.kind === "netServer");
            const cb = args[1]!;
            E.moveTemp(cb); // ownership moves into the wrapper's env box
            const wrap = E.newTemp(e.args[1]!.type, `scr_closure_new((void *)&${wrapSym}, 1)`);
            E.line(`${wrap.name}->caps[0] = scr_box_new(SCR_BOX_FUNC);`);
            E.line(`scr_box_set_ref(${wrap.name}->caps[0], ${cb.name});`);
            E.moveTemp(wrap); // and the wrapper moves into the server's slot
            E.line(`scr_net_server_set_close_override(${arg(0)}, ${wrap.name});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "net.serverOnError":
          case "net.sockOnError": {
            // The child %Error adapters fit exactly (message → %Error).
            const cbT = e.args[1]!.type;
            if (cbT.kind !== "func") throw new Error(`emitter bug: ${e.fn} callback not a func`);
            const cb = args[1]!;
            E.moveTemp(cb);
            const adapter = cbT.params.length === 0 ? "scr_child_err_thunk0" : "scr_child_err_thunk_error";
            const fn = e.fn === "net.serverOnError" ? "scr_net_server_on_error" : "scr_net_sock_on_error";
            E.line(`${fn}(${arg(0)}, ${cb.name}, &${adapter}, ${arg(2)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "net.serverOnClose": {
            const cb = args[1]!;
            E.moveTemp(cb);
            E.line(`scr_net_server_on_close(${arg(0)}, ${cb.name}, ${arg(2)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "net.serverOnConnection":
          case "net.serverOnSecureConnection": {
            const cbT = e.args[1]!.type;
            if (cbT.kind !== "func") throw new Error(`emitter bug: ${e.fn} callback not a func`);
            const cb = args[1]!;
            E.moveTemp(cb);
            const adapter = cbT.params.length === 0 ? "scr_net_conn_thunk0" : "scr_net_conn_thunk_sock";
            const entry = e.fn === "net.serverOnConnection"
              ? "scr_net_server_on_connection"
              : "scr_net_server_on_secure_connection";
            E.line(`${entry}(${arg(0)}, ${cb.name}, &${adapter}, ${arg(2)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "net.connect":
            E.usesTimers = true; // a connecting/open socket holds the loop open
            return finish(`scr_net_connect(${arg(0)}, ${arg(1)}, NULL)`);
          case "net.connectAttempt":
            // The validated autoSelectFamilyAttemptTimeout form: Node's
            // range ladder runs first, the dial follows.
            E.usesTimers = true;
            return finish(`scr_net_connect_attempt(${arg(0)}, ${arg(1)}, ${arg(2)})`);
          case "net.connectOptsChk":
            // The runtime option-bag ladder (always throws — a validation
            // error or the trailing fence; the error.nodeThrow dummy).
            return finish(
              `(scr_net_connect_opts_chk(${arg(0)}, ${arg(1)}), ${isRefCounted(e.type) ? `(${cType(e.type).trim()})NULL` : "0"})`,
            );
          case "net.connectCb": {
            E.usesTimers = true;
            const cb = args[2]!;
            E.moveTemp(cb);
            return finish(`scr_net_connect(${arg(0)}, ${arg(1)}, ${cb.name})`);
          }
          case "net.connectLookup": {
            // The caller-resolver dial: the runtime invokes the lookup
            // closure with (hostname, dyn undefined, answer-closure); the
            // answer closure's fn is the emitted per-shape thunk (its
            // union tag and record field are program data — the SNI
            // pattern). The lookup moves in.
            E.usesTimers = true;
            const lookupT = e.args[2]!.type;
            if (lookupT.kind !== "func" || lookupT.params[2]?.kind !== "func") {
              throw new Error("emitter bug: net.connectLookup resolver shape (frontend must fence)");
            }
            const thunk = E.netLookupAnswerThunkFor(lookupT.params[2]);
            const lookup = args[2]!;
            E.moveTemp(lookup);
            return finish(`scr_net_connect_lookup(${arg(0)}, ${arg(1)}, ${lookup.name}, (void *)&${thunk})`);
          }
          case "net.sockWrite":
            E.line(`scr_net_sock_write_str(${arg(0)}, ${arg(1)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "net.sockWriteBytes":
            E.line(`scr_net_sock_write_bytes(${arg(0)}, ${arg(1)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "net.sockEnd":
            E.line(`scr_net_sock_end(${arg(0)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "net.sockEndStr":
            E.line(`scr_net_sock_end_str(${arg(0)}, ${arg(1)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "net.sockEndBytes":
            E.line(`scr_net_sock_end_bytes(${arg(0)}, ${arg(1)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "net.sockWriteDyn":
            E.line(`scr_net_sock_write_dynv(${arg(0)}, ${arg(1)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "net.sockEndDyn":
            E.line(`scr_net_sock_end_dynv(${arg(0)}, ${arg(1)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "net.sockDestroy":
            E.line(`scr_net_sock_destroy(${arg(0)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "net.sockPause":
            return finish(`scr_net_sock_pause(${arg(0)})`);
          case "net.sockResume":
            return finish(`scr_net_sock_resume(${arg(0)})`);
          case "net.sockSetNoDelay":
            return finish(`scr_net_sock_set_nodelay(${arg(0)}, ${arg(1)})`);
          case "net.sockDestroySoon":
            E.line(`scr_net_sock_destroy_soon(${arg(0)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "net.sockBytesWritten":
            return finish(`scr_net_sock_bytes_written(${arg(0)})`);
          case "net.sockReadable":
            return finish(`scr_net_sock_readable(${arg(0)})`);
          case "net.sockOnFinish": {
            const cb = args[1]!;
            E.moveTemp(cb);
            E.line(`scr_net_sock_on_finish(${arg(0)}, ${cb.name});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "net.sockPipe":
            E.line(`scr_net_sock_pipe(${arg(0)}, ${arg(1)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "net.sockOnData": {
            const cbT = e.args[1]!.type;
            if (cbT.kind !== "func") throw new Error("emitter bug: net.sockOnData callback not a func");
            const cb = args[1]!;
            E.moveTemp(cb);
            const adapter =
              cbT.params.length === 0 ? "scr_net_data_thunk0"
              : cbT.params[0]!.kind === "dyn" ? "scr_net_data_thunk_dyn"
              : cbT.params[0]!.kind === "string" ? "scr_net_data_thunk_str"
              : "scr_net_data_thunk_bytes";
            E.line(`scr_net_sock_on_data(${arg(0)}, ${cb.name}, &${adapter}, ${arg(2)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "net.sockOnEnd":
          case "net.sockOnClose":
          case "net.sockOnConnect": {
            const cb = args[1]!;
            E.moveTemp(cb);
            const fn = e.fn === "net.sockOnEnd" ? "scr_net_sock_on_end"
              : e.fn === "net.sockOnClose" ? "scr_net_sock_on_close"
              : "scr_net_sock_on_connect";
            E.line(`${fn}(${arg(0)}, ${cb.name}, ${arg(2)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          // node:dgram + node:dns (scr_dgram.c + the loop's dgram hook —
          // linked only when these appear on the IR). The net discipline:
          // receivers/data borrowed, CALLBACKS MOVE into the handle's
          // registry; bind/connect/send make the loop live (usesTimers).
          case "dgram.createSocket":
            return finish(`scr_dgram_create(${arg(0)})`);
          case "dgram.bind":
            E.usesTimers = true; // a bound socket holds the loop open
            return finish(`scr_dgram_bind(${arg(0)}, ${arg(1)}, ${arg(2)}, NULL)`);
          case "dgram.bindCb": {
            E.usesTimers = true;
            const cb = args[3]!;
            E.moveTemp(cb);
            return finish(`scr_dgram_bind(${arg(0)}, ${arg(1)}, ${arg(2)}, ${cb.name})`);
          }
          case "dgram.connect":
            E.usesTimers = true; // a connected socket holds the loop open
            return finish(`scr_dgram_connect(${arg(0)}, ${arg(1)}, ${arg(2)}, NULL)`);
          case "dgram.connectCb": {
            E.usesTimers = true;
            const cb = args[3]!;
            E.moveTemp(cb);
            return finish(`scr_dgram_connect(${arg(0)}, ${arg(1)}, ${arg(2)}, ${cb.name})`);
          }
          case "dgram.sendStr":
            E.usesTimers = true; // send implicit-binds; the socket stays open
            return finish(`scr_dgram_send_str(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)})`);
          case "dgram.sendBytes":
            E.usesTimers = true;
            return finish(`scr_dgram_send_bytes(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)})`);
          case "dgram.sendChk":
            E.usesTimers = true; // a validated send implicit-binds
            return finish(
              `scr_dgram_send_chk(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)}, ${arg(4)}, ${arg(5)}, ${arg(6)})`,
            );
          case "dgram.address": {
            // The AddressInfo record, built here from runtime parts (the
            // frontend pinned the {address, family, port} shape). The
            // address read is the fallible one — Node's "Not running"
            // throw for a never-bound socket; family/port never throw
            // once it passed.
            if (e.type.kind !== "record") throw new Error("emitter bug: dgram.address result is not a record");
            const ip = E.fallibleTemp(STRING, `scr_dgram_addr_ip(${arg(0)})`);
            const rec = E.newTemp(e.type, `${mangleRecordNew(e.type.shapeId)}()`);
            E.moveTemp(ip);
            E.line(`${rec.name}->${mangleField("address")} = ${ip.name};`);
            E.line(`${rec.name}->${mangleField("family")} = scr_dgram_addr_family(${arg(0)});`);
            E.line(`${rec.name}->${mangleField("port")} = scr_dgram_addr_port(${arg(0)});`);
            return rec;
          }
          case "dgram.close":
            return finish(`scr_dgram_close(${arg(0)}, NULL)`);
          case "dgram.closeCb": {
            const cb = args[1]!;
            E.moveTemp(cb);
            return finish(`scr_dgram_close(${arg(0)}, ${cb.name})`);
          }
          case "dgram.unref":
            E.line(`scr_dgram_unref(${arg(0)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "dgram.ref":
            E.line(`scr_dgram_ref(${arg(0)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "dgram.onMessage": {
            const cbT = e.args[1]!.type;
            if (cbT.kind !== "func") throw new Error("emitter bug: dgram.onMessage callback not a func");
            const cb = args[1]!;
            E.moveTemp(cb);
            const adapter =
              cbT.params.length === 0 ? "scr_dgram_msg_thunk0"
              : cbT.params.length === 1 ? "scr_dgram_msg_thunk1"
              : E.dgramMsgThunkFor(cbT.params[1]!);
            E.line(`scr_dgram_on_message(${arg(0)}, ${cb.name}, &${adapter}, ${arg(2)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "dgram.onError": {
            // The child %Error adapters fit exactly (message → %Error).
            const cbT = e.args[1]!.type;
            if (cbT.kind !== "func") throw new Error("emitter bug: dgram.onError callback not a func");
            const cb = args[1]!;
            E.moveTemp(cb);
            const adapter = cbT.params.length === 0 ? "scr_child_err_thunk0" : "scr_child_err_thunk_error";
            E.line(`scr_dgram_on_error(${arg(0)}, ${cb.name}, &${adapter}, ${arg(2)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "dgram.onListening":
          case "dgram.onClose":
          case "dgram.onConnect": {
            const cb = args[1]!;
            E.moveTemp(cb);
            const fn = e.fn === "dgram.onListening" ? "scr_dgram_on_listening"
              : e.fn === "dgram.onClose" ? "scr_dgram_on_close"
              : "scr_dgram_on_connect";
            E.line(`${fn}(${arg(0)}, ${cb.name}, ${arg(2)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "dns.lookup": {
            // getaddrinfo runs NOW; the callback (moved in) fires at the
            // next loop turn through its per-shape adapter.
            E.usesTimers = true; // the pending callback holds the loop open
            const cbT = e.args[2]!.type;
            const cb = args[2]!;
            E.moveTemp(cb);
            const adapter = E.dnsLookupThunkFor(cbT);
            E.line(`scr_dns_lookup(${arg(0)}, ${arg(1)}, ${cb.name}, &${adapter});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          // node:test (scr_test.c — linked only when these appear on the
          // IR; moduleUsesNodeTest is the switch). Strings borrowed,
          // callbacks MOVE. Registrations keep the loop-run emitted
          // (usesTimers): the runner fiber drains after main returns.
          case "test.register": {
            E.usesTimers = true;
            const cb = args[3]!;
            E.moveTemp(cb);
            E.line(`scr_test_register(${arg(0)}, ${arg(1)}, ${arg(2)}, ${cb.name}, ${arg(4)}, ${arg(5)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "test.registerEmpty":
            E.usesTimers = true;
            E.line(`scr_test_register(${arg(0)}, ${arg(1)}, ${arg(2)}, NULL, ${arg(3)}, ${arg(4)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "test.suite": {
            E.usesTimers = true;
            const cb = args[3]!;
            E.moveTemp(cb);
            E.line(`scr_test_suite(${arg(0)}, ${arg(1)}, ${arg(2)}, ${cb.name}, ${arg(4)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "test.hook": {
            E.usesTimers = true;
            const cb = args[1]!;
            E.moveTemp(cb);
            E.line(`scr_test_hook(${arg(0)}, ${cb.name}, ${arg(2)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "test.sub": {
            // Runs the subtest INLINE on the runner fiber; the settled
            // promise (+1) is the await's operand.
            const cb = args[4]!;
            E.moveTemp(cb);
            return finish(`scr_test_sub(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)}, ${cb.name}, ${arg(5)}, ${arg(6)})`);
          }
          case "test.subEmpty":
            // Fn-less subtest: the settled promise is discarded here (the
            // lowering types it void — nothing consumes it).
            E.line(`scr_promise_release(scr_test_sub(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)}, NULL, 0, ${arg(4)}));${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "test.ctxSkip":
            E.line(`scr_test_ctx_skip(${arg(0)}, ${arg(1)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "test.ctxTodo":
            E.line(`scr_test_ctx_todo(${arg(0)}, ${arg(1)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "test.ctxDiagnostic":
            E.line(`scr_test_ctx_diagnostic(${arg(0)}, ${arg(1)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "test.ctxName":
            return finish(`scr_test_ctx_name(${arg(0)})`);
          // node:http, the server slice (scr_http.c over scr_net.c).
          case "http.createServer": {
            E.usesTimers = true;
            const cbT = e.args[0]!.type;
            if (cbT.kind !== "func") throw new Error("emitter bug: http.createServer handler not a func");
            const cb = args[0]!;
            E.moveTemp(cb);
            const adapter =
              cbT.params.length === 2 ? "scr_http_handler_thunk2"
              : cbT.params.length === 1 ? "scr_http_handler_thunk1"
              : "scr_http_handler_thunk0";
            return finish(`scr_http_create_server(${cb.name}, &${adapter})`);
          }
          case "http.reqUrl":
            return finish(`scr_http_req_url(${arg(0)})`);
          case "http.reqMethod":
            return finish(`scr_http_req_method(${arg(0)})`);
          case "http.reqHttpVersion":
            return finish(`scr_http_req_http_version(${arg(0)})`);
          case "http.reqHttpVersionMajor":
            return finish(`scr_http_req_http_version_major(${arg(0)})`);
          case "http.reqHttpVersionMinor":
            return finish(`scr_http_req_http_version_minor(${arg(0)})`);
          case "http.reqAborted":
            return finish(`scr_http_req_aborted_flag(${arg(0)})`);
          case "http.reqComplete":
            return finish(`scr_http_req_complete(${arg(0)})`);
          case "http.reqHeader": {
            // string|undefined, type-directed exactly like process.envGet:
            // the runtime answers +1 or NULL; NULL takes the undefined arm.
            if (e.type.kind !== "union") throw new Error("emitter bug: http.reqHeader result is not a union");
            const def = E.unionsById.get(e.type.unionId);
            const strTag = def ? def.arms.findIndex((a) => a.kind === "string") : -1;
            const undefTag = E.undefinedArmTag(e.type);
            if (strTag < 0 || undefTag < 0) {
              throw new Error("emitter bug: http.reqHeader union lacks its arms");
            }
            const s = E.newTemp(STRING, `scr_http_req_header(${arg(0)}, ${arg(1)})`);
            E.moveTemp(s); // moves into the box when present; NULL otherwise
            const present = `scr_union_new_ref(${strTag}, ${s.name}, &scr_str_retain_v, &scr_str_release_v, NULL)`;
            const absent = E.unitInstanceRef(e.type.unionId, undefTag);
            return E.newTemp(e.type, `${s.name} ? ${present} : ${absent}`);
          }
          case "http.reqOnData": {
            const cbT = e.args[1]!.type;
            if (cbT.kind !== "func") throw new Error("emitter bug: http.reqOnData callback not a func");
            const cb = args[1]!;
            E.moveTemp(cb);
            const adapter =
              cbT.params.length === 0 ? "scr_net_data_thunk0"
              : cbT.params[0]!.kind === "dyn" ? "scr_net_data_thunk_dyn"
              : cbT.params[0]!.kind === "string" ? "scr_net_data_thunk_str"
              : "scr_net_data_thunk_bytes";
            E.line(`scr_http_req_on_data(${arg(0)}, ${cb.name}, &${adapter}, ${arg(2)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "http.reqOnEnd": {
            const cb = args[1]!;
            E.moveTemp(cb);
            E.line(`scr_http_req_on_end(${arg(0)}, ${cb.name}, ${arg(2)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "http.resSetHeader":
            E.line(`scr_http_res_set_header(${arg(0)}, ${arg(1)}, ${arg(2)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.resWriteHead":
            E.line(`scr_http_res_write_head(${arg(0)}, ${arg(1)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.resWriteHeadN":
            E.line(`scr_http_res_write_head_n(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.resWrite":
            E.line(`scr_http_res_write_str(${arg(0)}, ${arg(1)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.resWriteBytes":
            E.line(`scr_http_res_write_bytes(${arg(0)}, ${arg(1)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.resEnd":
            E.line(`scr_http_res_end(${arg(0)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.resEndStr":
            E.line(`scr_http_res_end_str(${arg(0)}, ${arg(1)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.resEndBytes":
            E.line(`scr_http_res_end_bytes(${arg(0)}, ${arg(1)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.resWriteDyn":
            E.line(`scr_http_res_write_dynv(${arg(0)}, ${arg(1)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.resEndDyn":
            E.line(`scr_http_res_end_dynv(${arg(0)}, ${arg(1)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.resHeadersSent":
            return finish(`scr_http_res_headers_sent(${arg(0)})`);
          // The server-surface member follow-ups.
          case "http.reqStatusCode": {
            // number | undefined, type-directed like process.columns: the
            // runtime answers a negative status for server requests.
            if (e.type.kind !== "union") throw new Error("emitter bug: http.reqStatusCode result is not a union");
            const def = E.unionsById.get(e.type.unionId);
            const f64Tag = def ? def.arms.findIndex((a) => a.kind === "f64") : -1;
            const undefTag = E.undefinedArmTag(e.type);
            if (f64Tag < 0 || undefTag < 0) {
              throw new Error("emitter bug: http.reqStatusCode union lacks its arms");
            }
            const w = E.newTemp(F64, `scr_http_req_status(${arg(0)})`);
            const present = `scr_union_new_f64(${f64Tag}, ${w.name})`;
            const absent = E.unitInstanceRef(e.type.unionId, undefTag);
            return E.newTemp(e.type, `${w.name} >= 0 ? ${present} : ${absent}`);
          }
          case "net.sockEncrypted": {
            // boolean | undefined: the true arm iff the socket carries a
            // TLS transport; plain sockets answer the undefined arm (Node
            // types `encrypted` on TLSSocket only).
            if (e.type.kind !== "union") throw new Error("emitter bug: net.sockEncrypted result is not a union");
            const def = E.unionsById.get(e.type.unionId);
            const boolTag = def ? def.arms.findIndex((a) => a.kind === "bool") : -1;
            const undefTag = E.undefinedArmTag(e.type);
            if (boolTag < 0 || undefTag < 0) {
              throw new Error("emitter bug: net.sockEncrypted union lacks its arms");
            }
            const w = E.newTemp(BOOL, `scr_net_sock_encrypted(${arg(0)})`);
            const present = `scr_union_new_bool(${boolTag}, true)`;
            const absent = E.unitInstanceRef(e.type.unionId, undefTag);
            return E.newTemp(e.type, `${w.name} ? ${present} : ${absent}`);
          }
          case "http.reqSocket":
            return finish(`scr_http_req_socket(${arg(0)})`);
          case "http.reqRawHeaders":
            return finish(`scr_http_req_raw_headers(${arg(0)})`);
          case "http.reqHeaderPairs":
            return finish(`scr_http_req_header_pairs(${arg(0)})`);
          case "http.reqStatusMessage": {
            // string | undefined: a reason phrase on client responses,
            // NULL (the undefined arm) on server requests — the
            // sockRemoteAddress shape.
            if (e.type.kind !== "union") throw new Error("emitter bug: http.reqStatusMessage result is not a union");
            const def = E.unionsById.get(e.type.unionId);
            const strTag = def ? def.arms.findIndex((a) => a.kind === "string") : -1;
            const undefTag = E.undefinedArmTag(e.type);
            if (strTag < 0 || undefTag < 0) {
              throw new Error("emitter bug: http.reqStatusMessage union lacks its arms");
            }
            const m = E.newTemp(STRING, `scr_http_req_status_message(${arg(0)})`);
            E.moveTemp(m);
            const present = `scr_union_new_ref(${strTag}, ${m.name}, &scr_str_retain_v, &scr_str_release_v, NULL)`;
            const absent = E.unitInstanceRef(e.type.unionId, undefTag);
            return E.newTemp(e.type, `${m.name} ? ${present} : ${absent}`);
          }
          case "net.sockDestroyed":
            return finish(`scr_net_sock_destroyed(${arg(0)})`);
          case "net.sockWritable":
            return finish(`scr_net_sock_writable(${arg(0)})`);
          case "http.serverOnUpgrade":
          case "http.clientOnUpgrade": {
            const cbT = e.args[1]!.type;
            if (cbT.kind !== "func") throw new Error(`emitter bug: ${e.fn} listener not a func`);
            const cb = args[1]!;
            E.moveTemp(cb);
            const adapter =
              cbT.params.length === 3 ? "scr_http_upgrade_thunk3"
              : cbT.params.length === 2 ? "scr_http_upgrade_thunk2"
              : cbT.params.length === 1 ? "scr_http_upgrade_thunk1"
              : "scr_http_upgrade_thunk0";
            const entry = e.fn === "http.serverOnUpgrade"
              ? "scr_http_server_on_upgrade"
              : "scr_http_client_on_upgrade";
            E.line(`${entry}(${arg(0)}, ${cb.name}, &${adapter}, ${arg(2)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "http.serverOnConnect": {
            // The CONNECT handover: the upgrade adapters fit the plain
            // socket-param shapes; a UNION socket slot (the h2 compat
            // listener) takes the emitted per-shape wrapper — the arm's
            // tag is program data.
            const cbT = e.args[1]!.type;
            if (cbT.kind !== "func") throw new Error("emitter bug: http.serverOnConnect listener not a func");
            const cb = args[1]!;
            E.moveTemp(cb);
            const p1 = cbT.params[1];
            const adapter =
              p1 !== undefined && p1.kind === "union"
                ? E.connectSockThunkFor(cbT)
                : cbT.params.length === 3 ? "scr_http_upgrade_thunk3"
                : cbT.params.length === 2 ? "scr_http_upgrade_thunk2"
                : cbT.params.length === 1 ? "scr_http_upgrade_thunk1"
                : "scr_http_upgrade_thunk0";
            E.line(`scr_http_server_on_connect(${arg(0)}, ${cb.name}, &${adapter}, ${arg(2)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "net.sockPipeRes":
            E.line(`scr_http_sock_pipe_res(${arg(0)}, ${arg(1)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.reqPipeRes":
            E.line(`scr_http_req_pipe_res(${arg(0)}, ${arg(1)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.reqPipeClient":
            E.line(`scr_http_req_pipe_client(${arg(0)}, ${arg(1)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.reqPipeSock":
            E.line(`scr_http_req_pipe_sock(${arg(0)}, ${arg(1)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.reqResume":
            E.line(`scr_http_req_resume(${arg(0)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.reqDestroy":
            E.line(`scr_http_req_destroy(${arg(0)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.reqOnError": {
            const cbT = e.args[1]!.type;
            if (cbT.kind !== "func") throw new Error("emitter bug: http.reqOnError callback not a func");
            const cb = args[1]!;
            E.moveTemp(cb);
            const adapter = cbT.params.length === 0 ? "scr_child_err_thunk0" : "scr_child_err_thunk_error";
            E.line(`scr_http_req_on_error(${arg(0)}, ${cb.name}, &${adapter}, ${arg(2)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "http.reqOnClose": {
            const cb = args[1]!;
            E.moveTemp(cb);
            E.line(`scr_http_req_on_close(${arg(0)}, ${cb.name}, ${arg(2)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "http.reqOnAborted": {
            const cb = args[1]!;
            E.moveTemp(cb);
            E.line(`scr_http_req_on_aborted(${arg(0)}, ${cb.name}, ${arg(2)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "http.resDestroy":
            E.line(`scr_http_res_destroy(${arg(0)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.resOnClose": {
            const cb = args[1]!;
            E.moveTemp(cb);
            E.line(`scr_http_res_on_close(${arg(0)}, ${cb.name}, ${arg(2)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "http.createServerEmpty":
            E.usesTimers = true;
            return finish(`scr_http_create_server(NULL, NULL)`);
          case "http.serverJoinDupHeaders":
            E.line(`scr_http_server_join_duplicate_headers(${arg(0)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "net.serverOnListening": {
            const cb = args[1]!;
            E.moveTemp(cb);
            E.line(`scr_net_server_on_listening(${arg(0)}, ${cb.name}, ${arg(2)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "http.resStatusGet":
            return finish(`scr_http_res_status_get(${arg(0)})`);
          case "http.resStatusSet":
            E.line(`scr_http_res_status_set(${arg(0)}, ${arg(1)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.resStatusMsgGet":
            return finish(`scr_http_res_status_msg_get(${arg(0)})`);
          case "http.resStatusMsgSet":
            E.line(`scr_http_res_status_msg_set(${arg(0)}, ${arg(1)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.resGetHeader": {
            // string|undefined, exactly the http.reqHeader emission.
            if (e.type.kind !== "union") throw new Error("emitter bug: http.resGetHeader result is not a union");
            const def = E.unionsById.get(e.type.unionId);
            const strTag = def ? def.arms.findIndex((a) => a.kind === "string") : -1;
            const undefTag = E.undefinedArmTag(e.type);
            if (strTag < 0 || undefTag < 0) {
              throw new Error("emitter bug: http.resGetHeader union lacks its arms");
            }
            const s = E.newTemp(STRING, `scr_http_res_get_header(${arg(0)}, ${arg(1)})`);
            E.moveTemp(s); // moves into the box when present; NULL otherwise
            const present = `scr_union_new_ref(${strTag}, ${s.name}, &scr_str_retain_v, &scr_str_release_v, NULL)`;
            const absent = E.unitInstanceRef(e.type.unionId, undefTag);
            return E.newTemp(e.type, `${s.name} ? ${present} : ${absent}`);
          }
          case "http.resHasHeader":
            return finish(`scr_http_res_has_header_named(${arg(0)}, ${arg(1)})`);
          case "http.resRemoveHeader":
            E.line(`scr_http_res_remove_header(${arg(0)}, ${arg(1)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.resOnFinish": {
            const cb = args[1]!;
            E.moveTemp(cb);
            E.line(`scr_http_res_on_finish(${arg(0)}, ${cb.name});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "http.resWriteHeadPairs":
            E.line(`scr_http_res_write_head_pairs(${arg(0)}, ${arg(1)}, ${arg(2)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.resWriteHeadDyn":
            return finish(`scr_http_res_write_head_dyn(${arg(0)}, ${arg(1)}, ${arg(2)})`);
          case "net.sockSetEncoding":
            return finish(`scr_net_sock_set_encoding(${arg(0)}, ${arg(1)})`);
          case "http.reqSetEncoding":
            return finish(`scr_http_req_set_encoding(${arg(0)}, ${arg(1)})`);
          case "net.sockSetTimeout":
            E.line(`scr_net_sock_set_timeout(${arg(0)}, ${arg(1)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "net.sockOnTimeout": {
            const cb = args[1]!;
            E.moveTemp(cb);
            E.line(`scr_net_sock_on_timeout(${arg(0)}, ${cb.name}, ${arg(2)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "net.sockOnReadable": {
            const cb = args[1]!;
            E.moveTemp(cb);
            E.line(`scr_net_sock_on_readable(${arg(0)}, ${cb.name}, ${arg(2)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "net.sockRead": {
            // Buffer | null, type-directed like http.reqHeader: NULL (not
            // enough buffered) takes the null arm.
            if (e.type.kind !== "union") throw new Error("emitter bug: net.sockRead result is not a union");
            const def = E.unionsById.get(e.type.unionId);
            const bytesTag = def ? def.arms.findIndex((a) => a.kind === "bytes" && a.elem === "u8") : -1;
            const nullTag = def ? def.arms.findIndex((a) => a.kind === "nullT") : -1;
            if (bytesTag < 0 || nullTag < 0) {
              throw new Error("emitter bug: net.sockRead union lacks its arms");
            }
            const b = E.newTemp(BYTES_U8, `scr_net_sock_read_bytes(${arg(0)}, ${arg(1)})`);
            E.moveTemp(b); // moves into the box when present; NULL otherwise
            const present = `scr_union_new_ref(${bytesTag}, ${b.name}, &scr_bytes_retain_v, &scr_bytes_release_v, NULL)`;
            const absent = E.unitInstanceRef(e.type.unionId, nullTag);
            return E.newTemp(e.type, `${b.name} ? ${present} : ${absent}`);
          }
          case "net.sockUnshift":
            E.line(`scr_net_sock_unshift_bytes(${arg(0)}, ${arg(1)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "net.serverEmitConnection":
            E.line(`scr_net_server_emit_connection(${arg(0)}, ${arg(1)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "net.sockRemoteAddress": {
            // string | undefined, type-directed like http.reqHeader: NULL
            // (closed socket) takes the undefined arm.
            if (e.type.kind !== "union") throw new Error("emitter bug: net.sockRemoteAddress result is not a union");
            const def = E.unionsById.get(e.type.unionId);
            const strTag = def ? def.arms.findIndex((a) => a.kind === "string") : -1;
            const undefTag = E.undefinedArmTag(e.type);
            if (strTag < 0 || undefTag < 0) {
              throw new Error("emitter bug: net.sockRemoteAddress union lacks its arms");
            }
            const s = E.newTemp(STRING, `scr_net_sock_remote_address(${arg(0)})`);
            E.moveTemp(s);
            const present = `scr_union_new_ref(${strTag}, ${s.name}, &scr_str_retain_v, &scr_str_release_v, NULL)`;
            const absent = E.unitInstanceRef(e.type.unionId, undefTag);
            return E.newTemp(e.type, `${s.name} ? ${present} : ${absent}`);
          }
          // node:http, the client slice (scr_http.c over the net client).
          case "http.request":
          case "http.requestCb": {
            E.usesTimers = true; // an in-flight request holds the loop open
            let cbExpr = "NULL";
            let adapter = "NULL";
            if (e.fn === "http.requestCb") {
              const cbT = e.args[7]!.type;
              if (cbT.kind !== "func") throw new Error("emitter bug: http.requestCb callback not a func");
              const cb = args[7]!;
              E.moveTemp(cb);
              cbExpr = cb.name;
              adapter = cbT.params.length === 0 ? "&scr_http_resp_thunk0" : "&scr_http_resp_thunk_res";
            }
            return finish(
              `scr_http_request(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)}, ${arg(4)}, ${arg(5)}, ${arg(6)}, ${cbExpr}, ${adapter})`,
            );
          }
          case "http.agentNew":
            E.usesTimers = true; // queued dials hold the loop open
            return finish(
              `scr_http_agent_new(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)}, ${arg(4)}, ${arg(5)}, ${arg(6)})`,
            );
          case "http.requestAgent":
          case "http.requestAgentCb": {
            E.usesTimers = true;
            let cbExpr = "NULL";
            let adapter = "NULL";
            if (e.fn === "http.requestAgentCb") {
              const cbT = e.args[8]!.type;
              if (cbT.kind !== "func") throw new Error("emitter bug: http.requestAgentCb callback not a func");
              const cb = args[8]!;
              E.moveTemp(cb);
              cbExpr = cb.name;
              adapter = cbT.params.length === 0 ? "&scr_http_resp_thunk0" : "&scr_http_resp_thunk_res";
            }
            return finish(
              `scr_http_request_agent(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)}, ${arg(4)}, ${arg(5)}, ${arg(6)}, ${arg(7)}, ${cbExpr}, ${adapter})`,
            );
          }
          case "http.requestUrl":
          case "http.requestUrlCb":
          case "https.requestUrl":
          case "https.requestUrlCb": {
            E.usesTimers = true; // an in-flight request holds the loop open
            const tls = e.fn.startsWith("https.");
            let cbExpr = "NULL";
            let adapter = "NULL";
            if (e.fn.endsWith("Cb")) {
              const cbT = e.args[3]!.type;
              if (cbT.kind !== "func") throw new Error(`emitter bug: ${e.fn} callback not a func`);
              const cb = args[3]!;
              E.moveTemp(cb);
              cbExpr = cb.name;
              adapter = cbT.params.length === 0 ? "&scr_http_resp_thunk0" : "&scr_http_resp_thunk_res";
            }
            const entry = tls ? "scr_https_request_url" : "scr_http_request_url";
            return finish(
              `${entry}(${arg(0)}, ${arg(1)}, ${arg(2)}, ${cbExpr}, ${adapter})`,
            );
          }
          case "http.requestConn":
          case "http.requestConnCb": {
            E.usesTimers = true;
            let cbExpr = "NULL";
            let adapter = "NULL";
            if (e.fn === "http.requestConnCb") {
              const cbT = e.args[6]!.type;
              if (cbT.kind !== "func") throw new Error("emitter bug: http.requestConnCb callback not a func");
              const cb = args[6]!;
              E.moveTemp(cb);
              cbExpr = cb.name;
              adapter = cbT.params.length === 0 ? "&scr_http_resp_thunk0" : "&scr_http_resp_thunk_res";
            }
            const dial = args[0]!;
            E.moveTemp(dial);
            return finish(
              `scr_http_request_conn(${dial.name}, ${arg(1)}, ${arg(2)}, ${arg(3)}, ${arg(4)}, ${arg(5)}, ${cbExpr}, ${adapter})`,
            );
          }
          // node:tls + node:https (scr_tls.c over scr_net.c/scr_http.c).
          // cert/key/ca PEM arguments are strings OR Buffers — both carry
          // data+len, so one emission shape serves both (the cast covers
          // ScrBytes' uint8_t*).
          case "tls.createServer":
          case "tls.createServerCb": {
            E.usesTimers = true;
            let cbExpr = "NULL";
            let adapter = "NULL";
            if (e.fn === "tls.createServerCb") {
              const cbT = e.args[2]!.type;
              if (cbT.kind !== "func") throw new Error("emitter bug: tls.createServerCb handler not a func");
              const cb = args[2]!;
              E.moveTemp(cb);
              cbExpr = cb.name;
              adapter = cbT.params.length === 0 ? "&scr_net_conn_thunk0" : "&scr_net_conn_thunk_sock";
            }
            return finish(
              `scr_tls_create_server((const char *)${arg(0)}->data, ${arg(0)}->len, (const char *)${arg(1)}->data, ${arg(1)}->len, ${cbExpr}, ${adapter})`,
            );
          }
          case "https.createServer": {
            E.usesTimers = true;
            const cbT = e.args[2]!.type;
            if (cbT.kind !== "func") throw new Error("emitter bug: https.createServer handler not a func");
            const cb = args[2]!;
            E.moveTemp(cb);
            const adapter =
              cbT.params.length === 2 ? "scr_http_handler_thunk2"
              : cbT.params.length === 1 ? "scr_http_handler_thunk1"
              : "scr_http_handler_thunk0";
            return finish(
              `scr_https_create_server((const char *)${arg(0)}->data, ${arg(0)}->len, (const char *)${arg(1)}->data, ${arg(1)}->len, ${cb.name}, &${adapter})`,
            );
          }
          // The RUNTIME options records (divergence 66's stance): the dyn
          // walks throw the catchable fence for out-of-bounds members.
          case "tls.pemDyn":
            return finish(`scr_tls_pem_from_dyn(${arg(0)}, ${arg(1)}->data)`);
          case "tls.createServerDyn":
          case "tls.createServerDynCb": {
            E.usesTimers = true;
            let cbExpr = "NULL";
            let adapter = "NULL";
            if (e.fn === "tls.createServerDynCb") {
              const cbT = e.args[1]!.type;
              if (cbT.kind !== "func") throw new Error("emitter bug: tls.createServerDynCb handler not a func");
              const cb = args[1]!;
              E.moveTemp(cb);
              cbExpr = cb.name;
              adapter = cbT.params.length === 0 ? "&scr_net_conn_thunk0" : "&scr_net_conn_thunk_sock";
            }
            return finish(`scr_tls_create_server_dyn(${arg(0)}, ${cbExpr}, ${adapter})`);
          }
          case "https.createServerDyn":
            E.usesTimers = true;
            return finish(`scr_https_create_server_dyn(${arg(0)}, NULL, NULL)`);
          case "https.createServerDynCb": {
            E.usesTimers = true;
            const cbT = e.args[1]!.type;
            if (cbT.kind !== "func") throw new Error("emitter bug: https.createServerDynCb handler not a func");
            const cb = args[1]!;
            E.moveTemp(cb);
            const adapter =
              cbT.params.length === 2 ? "scr_http_handler_thunk2"
              : cbT.params.length === 1 ? "scr_http_handler_thunk1"
              : "scr_http_handler_thunk0";
            return finish(`scr_https_create_server_dyn(${arg(0)}, ${cb.name}, &${adapter})`);
          }
          // The TLSSocket member surface on the socket kind.
          case "tls.sockAuthorized":
            return finish(`scr_tls_sock_authorized(${arg(0)})`);
          case "tls.sockAuthError": {
            // string | null: the verify-failure code string, or the null
            // arm when authorized / never verified (Node's value shape).
            if (e.type.kind !== "union") throw new Error("emitter bug: tls.sockAuthError result is not a union");
            const def = E.unionsById.get(e.type.unionId);
            const strTag = def ? def.arms.findIndex((a) => a.kind === "string") : -1;
            const nullTag = def ? def.arms.findIndex((a) => a.kind === "nullT") : -1;
            if (strTag < 0 || nullTag < 0) {
              throw new Error("emitter bug: tls.sockAuthError union lacks its arms");
            }
            const s = E.newTemp(STRING, `scr_tls_sock_auth_error(${arg(0)})`);
            E.moveTemp(s);
            const present = `scr_union_new_ref(${strTag}, ${s.name}, &scr_str_retain_v, &scr_str_release_v, NULL)`;
            const absent = E.unitInstanceRef(e.type.unionId, nullTag);
            return E.newTemp(e.type, `${s.name} ? ${present} : ${absent}`);
          }
          case "tls.sockOnSecureConnect": {
            const cb = args[1]!;
            E.moveTemp(cb);
            E.line(`scr_tls_sock_on_secure_connect(${arg(0)}, ${cb.name}, ${arg(2)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "tls.sockOnSession": {
            const cbT = e.args[1]!.type;
            if (cbT.kind !== "func") throw new Error("emitter bug: tls.sockOnSession callback not a func");
            const cb = args[1]!;
            E.moveTemp(cb);
            const adapter =
              cbT.params.length === 0 ? "scr_net_data_thunk0"
              : cbT.params[0]!.kind === "dyn" ? "scr_net_data_thunk_dyn"
              : "scr_net_data_thunk_bytes";
            E.line(`scr_tls_sock_on_session(${arg(0)}, ${cb.name}, (void *)&${adapter}, ${arg(2)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          // tls.connect (the TLS client socket): the callback moves in and
          // fires post-handshake — the conn list's secureConnect timing.
          case "tls.connect":
          case "tls.connectCb": {
            E.usesTimers = true;
            let cbExpr = "NULL";
            if (e.fn === "tls.connectCb") {
              const cb = args[3]!;
              E.moveTemp(cb);
              cbExpr = cb.name;
            }
            return finish(
              `scr_tls_connect_dyn(${arg(0)}, ${arg(1)}, ${arg(2)}, ${cbExpr})`,
            );
          }
          case "http2.createSecureServer":
            // The allowHTTP1 compatibility server (SEMANTICS.md divergence
            // 56): the https server with NO eager handler — 'request'
            // listeners arrive via http.serverOnRequest. ALPN advertises
            // http/1.1 only (scr_tls.c), so h2-capable clients negotiate
            // down and every connection serves HTTP/1.1.
            E.usesTimers = true;
            return finish(
              `scr_https_create_server((const char *)${arg(0)}->data, ${arg(0)}->len, (const char *)${arg(1)}->data, ${arg(1)}->len, NULL, NULL)`,
            );
          case "http2.createSecureServerH2":
            // The REAL h2-over-TLS server (no allowHTTP1): ALPN advertises
            // h2 alone and the h2 session attaches at establishment —
            // 'stream'/'session' listeners, exactly the h2c surface.
            E.usesTimers = true;
            return finish(
              `scr_http2_create_secure_server((const char *)${arg(0)}->data, ${arg(0)}->len, (const char *)${arg(1)}->data, ${arg(1)}->len)`,
            );
          case "http2.createSecureServerReq":
          case "http2.createSecureServerH2Req": {
            // createSecureServer(options, handler): the eager COMPAT
            // handler is the first 'request' listener on either flavor
            // (the createServerReq adapter family).
            E.usesTimers = true;
            const cbT = e.args[2]!.type;
            if (cbT.kind !== "func") throw new Error(`emitter bug: ${e.fn} handler not a func`);
            const cb = args[2]!;
            E.moveTemp(cb);
            const adapter =
              cbT.params.length === 2 ? "scr_http_handler_thunk2"
              : cbT.params.length === 1 ? "scr_http_handler_thunk1"
              : "scr_http_handler_thunk0";
            const certKey = `(const char *)${arg(0)}->data, ${arg(0)}->len, (const char *)${arg(1)}->data, ${arg(1)}->len`;
            return finish(
              fn === "http2.createSecureServerReq"
                ? `scr_https_create_server(${certKey}, ${cb.name}, &${adapter})`
                : `scr_http2_create_secure_server_req(${certKey}, ${cb.name}, &${adapter})`,
            );
          }
          case "http2.createSecureServerDyn":
            // The runtime options record: allowHTTP1/cert/key read at
            // runtime (may-throw — the divergence-66 walk).
            E.usesTimers = true;
            return finish(`scr_http2_create_secure_server_dyn(${arg(0)}, NULL, NULL)`);
          case "http2.createSecureServerDynCb": {
            E.usesTimers = true;
            const cbT = e.args[1]!.type;
            if (cbT.kind !== "func") throw new Error("emitter bug: createSecureServerDynCb handler not a func");
            const cb = args[1]!;
            E.moveTemp(cb);
            const adapter =
              cbT.params.length === 2 ? "scr_http_handler_thunk2"
              : cbT.params.length === 1 ? "scr_http_handler_thunk1"
              : "scr_http_handler_thunk0";
            return finish(`scr_http2_create_secure_server_dyn(${arg(0)}, ${cb.name}, &${adapter})`);
          }
          case "http2.createSecureServerSni": {
            // The SNI form: the runtime parses each connection's
            // ClientHello for server_name BEFORE the handshake, calls the
            // JS SNICallback with (servername, answer-closure), and
            // resumes when the answer arrives. The answer closure's fn is
            // the emitted per-shape thunk (its unions' tags are program
            // data). A union-typed arg is the conditional-spread spelling
            // — the undefined arm passes NULL, exactly the no-SNI server.
            E.usesTimers = true;
            const sniT = e.args[2]!.type;
            let cbFuncT: IrType;
            let cbExpr: string;
            if (sniT.kind === "func") {
              cbFuncT = sniT;
              const cb = args[2]!;
              E.moveTemp(cb);
              cbExpr = cb.name;
            } else {
              if (sniT.kind !== "union") throw new Error("emitter bug: createSecureServerSni callback shape");
              const def = E.unionsById.get(sniT.unionId);
              const funcTag = def ? def.arms.findIndex((a) => a.kind === "func") : -1;
              const funcArm = def?.arms[funcTag];
              if (funcTag < 0 || !funcArm) throw new Error("emitter bug: createSecureServerSni union lacks its func arm");
              cbFuncT = funcArm;
              const u = args[2]!;
              const t = E.newTemp(
                funcArm,
                `${u.name}->tag == ${funcTag} ? scr_closure_retain((ScrClosure *)scr_union_peek(${u.name})) : NULL`,
              );
              E.moveTemp(t);
              cbExpr = t.name;
            }
            if (cbFuncT.kind !== "func" || cbFuncT.params[1]?.kind !== "func") {
              throw new Error("emitter bug: createSecureServerSni callback shape (frontend must fence)");
            }
            const answer = E.sniAnswerThunkFor(cbFuncT.params[1]);
            return finish(
              `scr_https_create_server_sni((const char *)${arg(0)}->data, ${arg(0)}->len, (const char *)${arg(1)}->data, ${arg(1)}->len, ${cbExpr}, (void *)&${answer})`,
            );
          }
          case "tls.createSecureContext":
            // Parses the PEM pair into the opaque SecureContext handle the
            // SNI answer serves; bad material is the construction-time
            // print-and-die trap, like createServer's.
            return finish(
              `scr_tls_create_secure_context((const char *)${arg(0)}->data, ${arg(0)}->len, (const char *)${arg(1)}->data, ${arg(1)}->len)`,
            );
          case "tls.createSecureContextDyn":
            // The runtime option-bag form: Node's typed validations, then
            // the pem walk (throws catchably on both ladders).
            return finish(`scr_tls_create_secure_context_dyn(${arg(0)})`);
          case "tls.caCertsChk":
            // Always throws (validation error or the trailing fence).
            return finish(
              `(scr_tls_ca_certs_chk(${arg(0)}, ${arg(1)}), ${isRefCounted(e.type) ? `(${cType(e.type).trim()})NULL` : "0"})`,
            );
          // The CA-store introspection unit (scr_tls_ca.c): cached
          // per-type PEM string arrays (+1 retained answers), and the
          // default-set replacement. get/set are may-throw seeds.
          case "tlsca.get":
            return finish(`scr_tls_ca_get(${arg(0)})`);
          case "tlsca.root":
            return finish(`scr_tls_ca_root()`);
          case "tlsca.set":
            return finish(`scr_tls_ca_set_default(${arg(0)})`);
          case "http.serverOnRequest": {
            const cbT = e.args[1]!.type;
            if (cbT.kind !== "func") throw new Error("emitter bug: http.serverOnRequest handler not a func");
            const cb = args[1]!;
            E.moveTemp(cb);
            const adapter =
              cbT.params.length === 2 ? "scr_http_handler_thunk2"
              : cbT.params.length === 1 ? "scr_http_handler_thunk1"
              : "scr_http_handler_thunk0";
            E.line(`scr_http_server_on_request(${arg(0)}, ${cb.name}, &${adapter}, ${arg(2)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "http2.serverOnSessionError":
            // 'sessionError' is an h2 SESSION event and the compatibility
            // server never creates a session: the registration is honest
            // dead weight. Receiver and callback temps evaluate (JS
            // evaluates them) and release through the ordinary temp
            // lifecycle — the closure is built, never installed, never
            // called; no runtime call is emitted at all.
            return { name: "", type: e.type };
          case "http2.streamNoop":
            // `req.stream?.on(...)`: stream is undefined on every
            // connection the allowHTTP1 lowering accepts — the optional
            // chain short-circuits and nothing runs.
            return { name: "", type: e.type };
          case "http2.streamUndefCall":
            // The unguarded form: Node's member read on undefined — the
            // exact catchable TypeError (pending check via the may-throw
            // seed set). Borrows the member-name string.
            return finish(`scr_http2_stream_undef_call(${arg(0)})`);
          // ── the REAL h2c surface (scr_http2.c) ─────────────────────
          // Event registrations take the EMITTED adapter closure (built
          // by the frontend — it owns arity and headers-record building),
          // so the runtime thunk is a fixed passthrough per payload shape.
          case "http2.createServer":
            E.usesTimers = true; // a listening server holds the loop open
            return finish(`scr_http2_create_server()`);
          case "http2.createServerReq": {
            // createServer(handler): the eager COMPAT handler — the first
            // 'request' listener, the http.createServer adapter family.
            E.usesTimers = true;
            const cbT = e.args[0]!.type;
            if (cbT.kind !== "func") throw new Error("emitter bug: http2.createServerReq handler not a func");
            const cb = args[0]!;
            E.moveTemp(cb);
            const adapter =
              cbT.params.length === 2 ? "scr_http_handler_thunk2"
              : cbT.params.length === 1 ? "scr_http_handler_thunk1"
              : "scr_http_handler_thunk0";
            return finish(`scr_http2_create_server_req(${cb.name}, &${adapter})`);
          }
          case "http2.serverOnStream":
          case "http2.sessionOnStream": {
            const cb = args[1]!;
            E.moveTemp(cb);
            const fn = e.fn === "http2.serverOnStream" ? "scr_http2_server_on_stream" : "scr_http2_session_on_stream";
            E.line(`${fn}(${arg(0)}, ${cb.name}, &scr_http2_stream_thunk, ${arg(2)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "http2.serverOnSession": {
            const cbT = e.args[1]!.type;
            if (cbT.kind !== "func") throw new Error("emitter bug: serverOnSession listener not a func");
            const cb = args[1]!;
            E.moveTemp(cb);
            const adapter = cbT.params.length === 0 ? "scr_http2_session_thunk0" : "scr_http2_session_thunk";
            E.line(`scr_http2_server_on_session(${arg(0)}, ${cb.name}, &${adapter}, ${arg(2)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "http2.sessionOnConnect": {
            const cbT = e.args[1]!.type;
            if (cbT.kind !== "func") throw new Error("emitter bug: sessionOnConnect listener not a func");
            const cb = args[1]!;
            E.moveTemp(cb);
            const adapter =
              cbT.params.length >= 2 ? "scr_http2_connect_thunk2"
              : cbT.params.length === 1 ? "scr_http2_connect_thunk1"
              : "scr_http2_connect_thunk0";
            E.line(`scr_http2_session_on_connect(${arg(0)}, ${cb.name}, &${adapter}, ${arg(2)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "http2.connect":
            E.usesTimers = true; // an open session holds the loop open
            return finish(
              `scr_http2_connect(${arg(0)}, ${arg(1)}, (const char *)${arg(2)}->data, ${arg(2)}->len, NULL, NULL)`,
            );
          case "http2.connectCb": {
            E.usesTimers = true;
            const cbT = e.args[3]!.type;
            if (cbT.kind !== "func") throw new Error("emitter bug: http2.connectCb listener not a func");
            const cb = args[3]!;
            E.moveTemp(cb);
            const adapter =
              cbT.params.length >= 2 ? "scr_http2_connect_thunk2"
              : cbT.params.length === 1 ? "scr_http2_connect_thunk1"
              : "scr_http2_connect_thunk0";
            return finish(
              `scr_http2_connect(${arg(0)}, ${arg(1)}, (const char *)${arg(2)}->data, ${arg(2)}->len, ${cb.name}, &${adapter})`,
            );
          }
          case "http2.sessionRequest":
            return finish(`scr_http2_session_request(${arg(0)}, ${arg(1)}, ${arg(2)})`);
          case "http2.sessionClose":
            E.line(`scr_http2_session_close(${arg(0)}, NULL);${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http2.sessionCloseCb": {
            const cb = args[1]!;
            E.moveTemp(cb);
            E.line(`scr_http2_session_close(${arg(0)}, ${cb.name});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "http2.sessionDestroy":
            E.line(`scr_http2_session_destroy(${arg(0)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http2.sessionOnClose": {
            const cb = args[1]!;
            E.moveTemp(cb);
            E.line(`scr_http2_session_on_close(${arg(0)}, ${cb.name}, ${arg(2)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "http2.sessionOnError":
          case "http2.streamOnError": {
            const cbT = e.args[1]!.type;
            if (cbT.kind !== "func") throw new Error(`emitter bug: ${e.fn} listener not a func`);
            const cb = args[1]!;
            E.moveTemp(cb);
            const adapter = cbT.params.length === 0 ? "scr_child_err_thunk0" : "scr_child_err_thunk_error";
            const fn = e.fn === "http2.sessionOnError" ? "scr_http2_session_on_error" : "scr_http2_stream_on_error";
            E.line(`${fn}(${arg(0)}, ${cb.name}, &${adapter}, ${arg(2)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "http2.sessionOnGoaway": {
            const cbT = e.args[1]!.type;
            if (cbT.kind !== "func") throw new Error("emitter bug: sessionOnGoaway listener not a func");
            const cb = args[1]!;
            E.moveTemp(cb);
            const adapter =
              cbT.params.length >= 2 ? "scr_http2_goaway_thunk2"
              : cbT.params.length === 1 ? "scr_http2_goaway_thunk1"
              : "scr_http2_goaway_thunk0";
            E.line(`scr_http2_session_on_goaway(${arg(0)}, ${cb.name}, &${adapter}, ${arg(2)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "http2.sessionClosed":
            return finish(`scr_http2_session_closed(${arg(0)})`);
          case "http2.sessionDestroyed":
            return finish(`scr_http2_session_destroyed(${arg(0)})`);
          case "http2.sessionEncrypted":
            return finish(`scr_http2_session_encrypted(${arg(0)})`);
          case "http2.sessionType":
            return finish(`scr_http2_session_type(${arg(0)})`);
          case "http2.sessionAlpn":
            return finish(`scr_http2_session_alpn(${arg(0)})`);
          case "http2.sessionSocket":
            return finish(`scr_http2_session_socket(${arg(0)})`);
          case "http2.streamRespond":
            E.line(`scr_http2_stream_respond(${arg(0)}, ${arg(1)}, ${arg(2)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http2.streamWrite":
            E.line(`scr_http2_stream_write_str(${arg(0)}, ${arg(1)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http2.streamWriteBytes":
            E.line(`scr_http2_stream_write_bytes(${arg(0)}, ${arg(1)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http2.streamEnd":
            E.line(`scr_http2_stream_end(${arg(0)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http2.streamEndStr":
            E.line(`scr_http2_stream_end_str(${arg(0)}, ${arg(1)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http2.streamEndBytes":
            E.line(`scr_http2_stream_end_bytes(${arg(0)}, ${arg(1)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http2.streamClose":
            E.line(`scr_http2_stream_close(${arg(0)}, ${arg(1)}, NULL);${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http2.streamCloseCb": {
            const cb = args[2]!;
            E.moveTemp(cb);
            E.line(`scr_http2_stream_close(${arg(0)}, ${arg(1)}, ${cb.name});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "http2.streamDestroy":
            E.line(`scr_http2_stream_destroy(${arg(0)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http2.sessionSettings0":
            E.line(`scr_http2_session_settings(${arg(0)}, NULL, NULL, NULL);${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http2.sessionSettings":
            E.line(`scr_http2_session_settings(${arg(0)}, ${arg(1)}, NULL, NULL);${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http2.sessionSettingsDynCb":
            E.line(`scr_http2_session_settings_dyncb(${arg(0)}, ${arg(1)}, ${arg(2)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http2.sessionSettingsCb0": {
            const cb = args[2]!;
            E.moveTemp(cb);
            E.line(`scr_http2_session_settings(${arg(0)}, ${arg(1)}, ${cb.name}, &scr_http2_settings_thunk0);${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "http2.sessionOnSettingsDyn":
            E.line(`scr_http2_session_on_settings_dyn(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http2.sessionOnSettings0": {
            const cb = args[1]!;
            E.moveTemp(cb);
            E.line(`scr_http2_session_on_settings(${arg(0)}, ${cb.name}, &scr_http2_settings_thunk0, ${arg(2)}, ${arg(3)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "http2.sessionSettingsGet":
            return finish(`scr_http2_session_settings_get(${arg(0)}, ${arg(1)})`);
          case "http2.sessionPendingSettingsAck":
            return finish(`scr_http2_session_pending_settings_ack(${arg(0)})`);
          case "http2.getDefaultSettings":
            return finish(`scr_http2_get_default_settings()`);
          case "http2.streamSetEncoding":
            E.line(`scr_http2_stream_set_encoding(${arg(0)}, ${arg(1)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http2.streamSetEncodingRet":
            // the chaining spelling: same write, answers the receiver +1
            return finish(`scr_http2_stream_set_encoding_ret(${arg(0)}, ${arg(1)})`);
          case "http2.streamResume":
            E.line(`scr_http2_stream_resume(${arg(0)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http2.streamPause":
            E.line(`scr_http2_stream_pause(${arg(0)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http2.streamOnData": {
            const cbT = e.args[1]!.type;
            if (cbT.kind !== "func") throw new Error("emitter bug: streamOnData callback not a func");
            const cb = args[1]!;
            E.moveTemp(cb);
            const adapter =
              cbT.params.length === 0 ? "scr_net_data_thunk0"
              : cbT.params[0]!.kind === "dyn" ? "scr_net_data_thunk_dyn"
              : cbT.params[0]!.kind === "string" ? "scr_net_data_thunk_str"
              : "scr_net_data_thunk_bytes";
            E.line(`scr_http2_stream_on_data(${arg(0)}, ${cb.name}, &${adapter}, ${arg(2)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "http2.streamOnEnd":
          case "http2.streamOnClose":
          case "http2.streamOnAborted": {
            const cb = args[1]!;
            E.moveTemp(cb);
            const fn = e.fn === "http2.streamOnEnd" ? "scr_http2_stream_on_end"
              : e.fn === "http2.streamOnClose" ? "scr_http2_stream_on_close"
              : "scr_http2_stream_on_aborted";
            E.line(`${fn}(${arg(0)}, ${cb.name}, ${arg(2)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "http2.streamOnResponse": {
            const cb = args[1]!;
            E.moveTemp(cb);
            E.line(`scr_http2_stream_on_response(${arg(0)}, ${cb.name}, &scr_http2_resp_thunk, ${arg(2)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "http2.streamId":
            return finish(`scr_http2_stream_id(${arg(0)})`);
          case "http2.streamRstCode":
            return finish(`scr_http2_stream_rst_code(${arg(0)})`);
          case "http2.streamDestroyed":
            return finish(`scr_http2_stream_destroyed(${arg(0)})`);
          case "http2.streamClosed":
            return finish(`scr_http2_stream_closed(${arg(0)})`);
          case "http2.streamAborted":
            return finish(`scr_http2_stream_aborted(${arg(0)})`);
          case "http2.streamPending":
            return finish(`scr_http2_stream_pending(${arg(0)})`);
          case "http2.streamSession":
            return finish(`scr_http2_stream_session(${arg(0)})`);
          case "dyn.toStringCoerce":
            // +1 string or NULL with the exception pending (user
            // toString/valueOf throws propagate). Borrows the dyn.
            return finish(`scr_dyn_string_coerce_js(${arg(0)})`);
          case "error.nodeThrow":
            // The compiler-resolved Node-parity throw (always throws —
            // the typed dummy is abandoned by the pending check's
            // unwind; releases are NULL-tolerant). Borrows both strings.
            return finish(
              `(scr_throw_node_coded(${arg(0)}, ${arg(1)}, ${arg(2)}), ${isRefCounted(e.type) ? `(${cType(e.type).trim()})NULL` : "0"})`,
            );
          case "global.undefRead":
            // A declare-d const nothing defines: Node's catchable
            // ReferenceError at the access (always throws — the typed
            // dummy is abandoned by the pending check's unwind; releases
            // are NULL-tolerant). Borrows the name string.
            return finish(
              `(scr_undef_global_read(${arg(0)}), ${isRefCounted(e.type) ? `(${cType(e.type).trim()})NULL` : "0"})`,
            );
          case "https.request":
          case "https.requestCb": {
            E.usesTimers = true; // an in-flight request holds the loop open
            let cbExpr = "NULL";
            let adapter = "NULL";
            if (e.fn === "https.requestCb") {
              const cbT = e.args[9]!.type;
              if (cbT.kind !== "func") throw new Error("emitter bug: https.requestCb callback not a func");
              const cb = args[9]!;
              E.moveTemp(cb);
              cbExpr = cb.name;
              adapter = cbT.params.length === 0 ? "&scr_http_resp_thunk0" : "&scr_http_resp_thunk_res";
            }
            return finish(
              `scr_https_request(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)}, ${arg(4)}, ${arg(5)}, ${arg(6)}, ${arg(7)}, (const char *)${arg(8)}->data, ${arg(8)}->len, ${cbExpr}, ${adapter})`,
            );
          }
          case "https.requestAgent":
          case "https.requestAgentCb": {
            E.usesTimers = true; // an in-flight request holds the loop open
            let cbExpr = "NULL";
            let adapter = "NULL";
            if (e.fn === "https.requestAgentCb") {
              const cbT = e.args[10]!.type;
              if (cbT.kind !== "func") throw new Error("emitter bug: https.requestAgentCb callback not a func");
              const cb = args[10]!;
              E.moveTemp(cb);
              cbExpr = cb.name;
              adapter = cbT.params.length === 0 ? "&scr_http_resp_thunk0" : "&scr_http_resp_thunk_res";
            }
            return finish(
              `scr_https_request_agent(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)}, ${arg(4)}, ${arg(5)}, ${arg(6)}, ${arg(7)}, (const char *)${arg(8)}->data, ${arg(8)}->len, ${arg(9)}, ${cbExpr}, ${adapter})`,
            );
          }
          case "https.requestFn":
          case "https.requestFnCb": {
            // The requestFn binding's runtime dial: arg 0 picks the client
            // — a C ternary between the two real entry points over the
            // SAME evaluated argument temps (only one side runs; the cb
            // moves into whichever). The https row's reject/ca args are
            // simply unused on the plain side, like Node's http.request
            // with TLS options.
            E.usesTimers = true; // an in-flight request holds the loop open
            let cbExpr = "NULL";
            let adapter = "NULL";
            if (e.fn === "https.requestFnCb") {
              const cbT = e.args[10]!.type;
              if (cbT.kind !== "func") throw new Error("emitter bug: https.requestFnCb callback not a func");
              const cb = args[10]!;
              E.moveTemp(cb);
              cbExpr = cb.name;
              adapter = cbT.params.length === 0 ? "&scr_http_resp_thunk0" : "&scr_http_resp_thunk_res";
            }
            return finish(
              `(${arg(0)} ? scr_https_request(${arg(1)}, ${arg(2)}, ${arg(3)}, ${arg(4)}, ${arg(5)}, ${arg(6)}, ${arg(7)}, ${arg(8)}, (const char *)${arg(9)}->data, ${arg(9)}->len, ${cbExpr}, ${adapter}) : scr_http_request_ex(${arg(1)}, ${arg(2)}, ${arg(3)}, ${arg(4)}, ${arg(5)}, ${arg(6)}, ${arg(7)}, ${cbExpr}, ${adapter}, 80, NULL, NULL))`,
            );
          }
          case "http.clientWrite":
            E.line(`scr_http_client_write_str(${arg(0)}, ${arg(1)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.clientWriteBytes":
            E.line(`scr_http_client_write_bytes(${arg(0)}, ${arg(1)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.clientEnd":
            E.line(`scr_http_client_end(${arg(0)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.clientEndStr":
            E.line(`scr_http_client_end_str(${arg(0)}, ${arg(1)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.clientEndBytes":
            E.line(`scr_http_client_end_bytes(${arg(0)}, ${arg(1)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.clientWriteDyn":
            E.line(`scr_http_client_write_dynv(${arg(0)}, ${arg(1)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.clientEndDyn":
            E.line(`scr_http_client_end_dynv(${arg(0)}, ${arg(1)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.clientDestroy":
            E.line(`scr_http_client_destroy(${arg(0)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.clientDestroyed":
            return finish(`scr_http_client_destroyed(${arg(0)})`);
          case "http.clientOnResponse": {
            const cbT = e.args[1]!.type;
            if (cbT.kind !== "func") throw new Error("emitter bug: http.clientOnResponse callback not a func");
            const cb = args[1]!;
            E.moveTemp(cb);
            const adapter = cbT.params.length === 0 ? "scr_http_resp_thunk0" : "scr_http_resp_thunk_res";
            E.line(`scr_http_client_on_response(${arg(0)}, ${cb.name}, &${adapter}, ${arg(2)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "http.clientOnError": {
            const cbT = e.args[1]!.type;
            if (cbT.kind !== "func") throw new Error("emitter bug: http.clientOnError callback not a func");
            const cb = args[1]!;
            E.moveTemp(cb);
            const adapter = cbT.params.length === 0 ? "scr_child_err_thunk0" : "scr_child_err_thunk_error";
            E.line(`scr_http_client_on_error(${arg(0)}, ${cb.name}, &${adapter}, ${arg(2)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "http.clientOnTimeout":
          case "http.clientOnClose": {
            const cb = args[1]!;
            E.moveTemp(cb);
            const fn = e.fn === "http.clientOnTimeout" ? "scr_http_client_on_timeout" : "scr_http_client_on_close";
            E.line(`${fn}(${arg(0)}, ${cb.name}, ${arg(2)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "child.onError": {
            // Both error-listener shapes have runtime-provided adapters
            // (constructing the %Error instance needs no program types).
            const cbT = e.args[1]!.type;
            if (cbT.kind !== "func") throw new Error("emitter bug: child.onError callback not a func");
            const cb = args[1]!;
            E.moveTemp(cb);
            const adapter =
              cbT.params.length === 0 ? "scr_child_err_thunk0" : "scr_child_err_thunk_error";
            E.line(
              `scr_child_on_error(${arg(0)}, ${cb.name}, &${adapter});${E.srcComment(e.loc)}`,
            );
            return { name: "", type: e.type };
          }
          // fs/promises: already-settled promises — failures REJECT (the
          // runtime moves the pending exception into the promise), so no
          // pending check here; the await re-throws catchably. args[1] of
          // readFile is the (always-"utf8") encoding, evaluated for
          // JS-exact side-effect order and ignored by the runtime.
          case "crypto.randomUUID":
            return finish(`scr_crypto_random_uuid()`);
          case "crypto.randomBytesToString":
            // May throw Node's RangeError (may-throw seed set).
            return finish(`scr_crypto_random_string(${arg(0)}, ${arg(1)})`);
          case "crypto.randomBytes":
            // A real u8 Buffer (+1); same RangeError as the composed form.
            return finish(`scr_crypto_random_bytes(${arg(0)})`);
          case "crypto.hashDigestStr":
            return finish(`scr_crypto_hash_digest_str(${arg(0)}, ${arg(1)}, ${arg(2)})`);
          case "crypto.hashDigestBytes":
            return finish(`scr_crypto_hash_digest_bytes(${arg(0)}, ${arg(1)}, ${arg(2)})`);
          // The Buffer statics (scr_bytes.c): fromStr decodes Node-
          // leniently (never throws), concat copies its borrowed list.
          case "buffer.fromStr":
            return finish(`scr_bytes_from_str(${arg(0)}, ${arg(1)})`);
          case "buffer.concat":
            return finish(`scr_bytes_concat(${arg(0)})`);
          case "buffer.concatLen":
            return finish(`scr_bytes_concat_len(${arg(0)}, ${arg(1)})`);
          case "buffer.byteLenStr":
            return finish(`scr_bytes_byte_length_str(${arg(0)}, ${arg(1)})`);
          case "buffer.isEncoding":
            return finish(`scr_bytes_is_encoding(${arg(0)})`);
          // The checked-dynamic compare/equals validators
          // (scr_bytes_io.c): Node's argument ladders throw catchably
          // (may-throw seed set); all dyn args borrowed.
          case "buffer.compareChk":
            return finish(`scr_buffer_compare_chk(${arg(0)}, ${arg(1)})`);
          case "bytes.equalsChk":
            return finish(`scr_bytes_equals_chk(${arg(0)}, ${arg(1)})`);
          case "bytes.compareChk":
            return finish(`scr_bytes_compare_chk(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)}, ${arg(4)}, ${arg(5)})`);
          case "buffer.newStringFail":
            return finish(`scr_buffer_new_string_fail(${arg(0)})`);
          case "fs.toUnixTimestamp":
            return finish(`scr_fs_to_unix_timestamp(${arg(0)})`);
          // The fs argument-validation ladders: the always-throw Chk
          // forms (validation error or the trailing fence) take the
          // error.nodeThrow dummy pattern; mkdtempSyncChk and the lchmod
          // pair answer real results on a validated pass.
          case "fs.existsChk":
            E.usesTimers = true; // the scheduled answer holds the loop open
            return finish(`scr_fs_exists_async(${arg(0)}, ${arg(1)})`);
          case "fs.mkdtempChk":
            return finish(
              `(scr_fs_mkdtemp_chk(${arg(0)}, ${arg(1)}, ${arg(2)}), ${isRefCounted(e.type) ? `(${cType(e.type).trim()})NULL` : "0"})`,
            );
          case "fs.mkdtempSyncChk":
            return finish(`scr_fs_mkdtemp_sync_chk(${arg(0)}, ${arg(1)}, ${arg(2)})`);
          case "fs.readFileChk":
            return finish(
              `(scr_fs_read_file_chk(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)}), ${isRefCounted(e.type) ? `(${cType(e.type).trim()})NULL` : "0"})`,
            );
          case "fs.opendirChk":
            return finish(
              `(scr_fs_opendir_chk(${arg(0)}, ${arg(1)}, ${arg(2)}), ${isRefCounted(e.type) ? `(${cType(e.type).trim()})NULL` : "0"})`,
            );
          case "fs.watchFileChk":
            return finish(
              `(scr_fs_watch_file_chk(${arg(0)}, ${arg(1)}, ${arg(2)}), ${isRefCounted(e.type) ? `(${cType(e.type).trim()})NULL` : "0"})`,
            );
          case "fs.lchmodChk":
            return finish(
              `(scr_fs_lchmod_chk(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)}), ${isRefCounted(e.type) ? `(${cType(e.type).trim()})NULL` : "0"})`,
            );
          case "fs.lchmodSyncChk":
            return finish(`scr_fs_lchmod_sync_chk(${arg(0)}, ${arg(1)})`);
          case "fsp.lchmodChk":
            return finish(`scr_fsp_lchmod_chk(${arg(0)}, ${arg(1)})`);
          case "fs.readChk":
            return finish(
              `(scr_fs_read_chk(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)}, ${arg(4)}, ${arg(5)}), ${isRefCounted(e.type) ? `(${cType(e.type).trim()})NULL` : "0"})`,
            );
          case "fs.streamOptsChk":
            return finish(
              `(scr_fs_stream_opts_chk(${arg(0)}, ${arg(1)}, ${arg(2)}), ${isRefCounted(e.type) ? `(${cType(e.type).trim()})NULL` : "0"})`,
            );
          case "error.argTypeThrow":
            // Always throws with the runtime-rendered Received tail (the
            // error.nodeThrow dummy pattern). Borrows all three.
            return finish(
              `(scr_throw_arg_type(${arg(0)}, ${arg(1)}, ${arg(2)}), ${isRefCounted(e.type) ? `(${cType(e.type).trim()})NULL` : "0"})`,
            );
          case "error.propTypeThrow":
            // The property flavor ("The \"options.x\" property must be
            // ...") — same always-throw dummy pattern.
            return finish(
              `(scr_throw_prop_type(${arg(0)}, ${arg(1)}, ${arg(2)}), ${isRefCounted(e.type) ? `(${cType(e.type).trim()})NULL` : "0"})`,
            );
          // The fs Buffer forms (scr_bytes_io.c): the sync pair throws
          // like the utf8 forms (may-throw seed set); the promise form
          // rejects instead.
          case "fs.readFileSyncBytes":
            return finish(`scr_fs_read_file_bytes(${arg(0)})`);
          case "fs.writeFileSyncBytes":
            return finish(`scr_fs_write_file_bytes(${arg(0)}, ${arg(1)})`);
          case "fsp.readFileBytes":
            return finish(`scr_fsp_read_file_bytes(${arg(0)})`);
          // zlib (scr_zlib.c — linked only when these appear on the IR):
          // inflate throws on corrupt input (may-throw seed set).
          case "zlib.deflateSync":
            return finish(`scr_zlib_deflate(${arg(0)})`);
          case "zlib.inflateSync":
            return finish(`scr_zlib_inflate(${arg(0)})`);
          case "process.stdoutWriteBytes":
            return finish(`scr_process_stdout_write_bytes(${arg(0)})`);
          case "process.stderrWriteBytes":
            return finish(`scr_process_stderr_write_bytes(${arg(0)})`);
          case "tp.setTimeout":
            return finish(`scr_tp_set_timeout(${arg(0)})`);
          case "tp.setImmediate":
            return finish(`scr_tp_set_immediate()`);
          case "dc.channel":
            return finish(`scr_dc_channel(${arg(0)})`);
          case "dc.subscribe":
            return finish(`scr_dc_subscribe(${arg(0)}, ${arg(1)})`);
          case "dc.unsubscribe":
            return finish(`scr_dc_unsubscribe(${arg(0)}, ${arg(1)})`);
          case "dc.hasSubscribers":
            return finish(`scr_dc_has_subscribers(${arg(0)})`);
          case "dc.publish":
            return finish(`scr_dc_publish(${arg(0)}, ${arg(1)})`);
          case "dc.chanSubscribe":
            return finish(`scr_dc_chan_subscribe(${arg(0)}, ${arg(1)})`);
          case "dc.chanUnsubscribe":
            return finish(`scr_dc_chan_unsubscribe(${arg(0)}, ${arg(1)})`);
          case "dc.chanHasSubscribers":
            return finish(`scr_dc_chan_has_subscribers(${arg(0)})`);
          case "dc.chanName":
            return finish(`scr_dc_chan_name(${arg(0)})`);
          case "timers.setImmediateFnValue":
            // Calling the minted value schedules a real immediate — the
            // loop must run to fire it.
            E.usesTimers = true;
            return finish(`scr_set_immediate_dyn_value()`);
          case "timers.immediatePromise":
            E.usesTimers = true;
            return finish(`scr_immediate_promise()`);
          case "dc.tracingChannel":
            return finish(`scr_dc_tracing_channel(${arg(0)})`);
          case "dc.tracingChannelOf":
            return finish(`scr_dc_tracing_channel_of(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)}, ${arg(4)})`);
          case "dc.tcChannel":
            return finish(`scr_dc_tc_channel(${arg(0)}, ${arg(1)})`);
          case "dc.tcHasSubscribers":
            return finish(`scr_dc_tc_has_subscribers(${arg(0)})`);
          case "dc.tcSubscribe":
            return finish(`scr_dc_tc_subscribe(${arg(0)}, ${arg(1)})`);
          case "dc.tcUnsubscribe":
            return finish(`scr_dc_tc_unsubscribe(${arg(0)}, ${arg(1)})`);
          case "dc.tcTraceSync":
            return finish(`scr_dc_tc_trace_sync(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)}, ${arg(4)})`);
          case "dc.tcTraceCallback":
            return finish(`scr_dc_tc_trace_callback(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)}, ${arg(4)}, ${arg(5)})`);
          case "assert.expectsErrDyn":
            return finish(`scr_assert_expects_err_dyn(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)})`);
          case "async.hop":
            E.usesTimers = true;
            return finish(`scr_await_hop()`);
          case "async.awaitDyn":
            E.usesTimers = true; // the hop rides the loop
            return finish(`scr_await_dyn_value(${arg(0)})`);
          case "als.new":
            return finish(`scr_als_new()`);
          case "als.get":
            return finish(`scr_als_get(${arg(0)})`);
          case "als.run":
            return finish(`scr_als_run(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)})`);
          case "als.exitRun":
            return finish(`scr_als_exit_run(${arg(0)}, ${arg(1)}, ${arg(2)})`);
          case "als.enterWith":
            return finish(`scr_als_enter_with(${arg(0)}, ${arg(1)})`);
          case "als.disable":
            return finish(`scr_als_disable(${arg(0)})`);
          case "dc.chanBindStore":
            return finish(`scr_dc_chan_bind_store(${arg(0)}, ${arg(1)}, ${arg(2)})`);
          case "dc.chanUnbindStore":
            return finish(`scr_dc_chan_unbind_store(${arg(0)}, ${arg(1)})`);
          case "dc.chanRunStores":
            return finish(`scr_dc_chan_run_stores(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)}, ${arg(4)})`);
          case "dc.tcTracePromise":
            // The reaction fiber needs the loop to drain it.
            E.usesTimers = true;
            return finish(`scr_dc_tc_trace_promise(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)}, ${arg(4)})`);
          case "process.onWarning":
            return finish(`scr_process_on_warning(${arg(0)})`);
          case "process.offWarning":
            return finish(`scr_process_off_warning(${arg(0)})`);
          case "process.emitWarning":
            return finish(`scr_process_emit_warning(${arg(0)})`);
          case "process.onUnhandledRejection":
            // The report at loop end dispatches the listeners.
            E.usesTimers = true;
            return finish(`scr_process_on_unhandled_rejection(${arg(0)}, ${arg(1)})`);
          case "process.offUnhandledRejection":
            return finish(`scr_process_off_unhandled_rejection(${arg(0)})`);
          case "process.onRejectionHandled":
            // Fires (if ever) during the loop-end report's listener
            // dispatch — the loop must be live for the report to run.
            E.usesTimers = true;
            return finish(`scr_process_on_rejection_handled(${arg(0)}, ${arg(1)})`);
          case "process.offRejectionHandled":
            return finish(`scr_process_off_rejection_handled(${arg(0)})`);
          case "fsp.readFile":
            return finish(`scr_fsp_read_file(${arg(0)})`);
          case "fsp.writeFile":
            return finish(`scr_fsp_write_file(${arg(0)}, ${arg(1)})`);
          case "fsp.mkdir":
            return finish(`scr_fsp_mkdir(${arg(0)})`);
          case "fsp.mkdirMode":
            return finish(`scr_fsp_mkdir_mode(${arg(0)}, ${arg(1)})`);
          case "fsp.mkdirRecursive":
            return finish(`scr_fsp_mkdir_recursive(${arg(0)})`);
          case "fsp.mkdirRecursiveMode":
            return finish(`scr_fsp_mkdir_recursive_mode(${arg(0)}, ${arg(1)})`);
          case "fsp.unlink":
            return finish(`scr_fsp_unlink(${arg(0)})`);
          case "fsp.chmod":
            return finish(`scr_fsp_chmod(${arg(0)}, ${arg(1)})`);
          case "fsp.readdir":
            return finish(`scr_fsp_readdir(${arg(0)})`);
          case "fsp.rm":
            return finish(`scr_fsp_rm(${arg(0)})`);
          case "fsp.stat":
            return finish(`scr_fsp_stat(${arg(0)})`);
          case "process.argv":
            return finish(`scr_process_argv()`);
          case "process.platform":
            return finish(`scr_process_platform()`);
          case "process.cwd":
            return finish(`scr_process_cwd()`);
          case "process.stdoutWrite":
            return finish(`scr_process_stdout_write(${arg(0)})`);
          case "process.stderrWrite":
            return finish(`scr_process_stderr_write(${arg(0)})`);
          case "process.envGet": {
            // getenv(3): +1 fresh string, or NULL when unset. The union
            // construction is type-directed HERE — the runtime knows no
            // tags: present wraps the string arm (ownership of the fresh
            // string MOVES into the box), absent yields the interned
            // immortal undefined-arm instance (releases no-op on it).
            if (e.type.kind !== "union") {
              throw new Error("emitter bug: process.envGet result is not a union");
            }
            const def = E.unionsById.get(e.type.unionId);
            const strTag = def ? def.arms.findIndex((a) => a.kind === "string") : -1;
            const undefTag = E.undefinedArmTag(e.type);
            if (strTag < 0 || undefTag < 0) {
              throw new Error("emitter bug: process.envGet union lacks its arms");
            }
            const s = E.newTemp(STRING, `scr_env_get(${arg(0)})`);
            E.moveTemp(s); // moves into the box when present; NULL otherwise
            const present = `scr_union_new_ref(${strTag}, ${s.name}, &scr_str_retain_v, &scr_str_release_v, NULL)`;
            const absent = E.unitInstanceRef(e.type.unionId, undefTag);
            return E.newTemp(e.type, `${s.name} ? ${present} : ${absent}`);
          }
          case "process.envSet":
            return finish(`scr_env_set(${arg(0)}, ${arg(1)})`);
          case "process.envUnset":
            return finish(`scr_env_unset(${arg(0)})`);
          case "process.envPairs":
            return finish(`scr_env_pairs()`);
          case "process.pid":
            return finish(`scr_process_pid()`);
          case "dyn.this":
            return finish(`scr_dyn_this_get()`);
          case "process.getuid":
            return finish(`scr_process_getuid()`);
          case "process.uptime":
            return finish(`scr_process_uptime()`);
          case "perf.now":
            return finish(`scr_perf_now()`);
          case "process.availableMemory":
            return finish(`scr_available_memory()`);
          case "process.constrainedMemory":
            return finish(`scr_constrained_memory()`);
          case "process.cpuUser":
            return finish(`scr_cpu_user()`);
          case "process.cpuSystem":
            return finish(`scr_cpu_system()`);
          case "process.cpuUserDiff":
            return finish(`scr_cpu_user_diff(${arg(0)})`);
          case "process.cpuSystemDiff":
            return finish(`scr_cpu_system_diff(${arg(0)})`);
          case "process.threadCpuUser":
            return finish(`scr_thread_cpu_user()`);
          case "process.threadCpuSystem":
            return finish(`scr_thread_cpu_system()`);
          case "process.threadCpuUserDiff":
            return finish(`scr_thread_cpu_user_diff(${arg(0)})`);
          case "process.threadCpuSystemDiff":
            return finish(`scr_thread_cpu_system_diff(${arg(0)})`);
          case "process.cpuPrevValidate":
            // MAY THROW: negative/non-finite prev fields raise Node's
            // ERR_INVALID_ARG_VALUE RangeError (finish emits the check).
            return finish(`scr_cpu_prev_validate(${arg(0)}, ${arg(1)})`);
          case "process.rusage":
            return finish(`scr_process_rusage(${arg(0)})`);
          case "process.activeResources":
            // The loop's bookkeeping needs the loop linked.
            E.usesTimers = true;
            return finish(`scr_active_resources()`);
          case "process.getgid":
            return finish(`scr_process_getgid()`);
          case "process.execPath":
            return finish(`scr_process_exec_path()`);
          case "process.arch":
            return finish(`scr_process_arch()`);
          case "process.versionsNode":
            return finish(`scr_process_versions_node()`);
          case "process.versionsOpenssl":
            return finish(`scr_process_versions_openssl()`);
          case "process.umask":
            return finish(`scr_process_umask(${arg(0)})`);
          case "process.chdir":
            return finish(`scr_process_chdir(${arg(0)})`);
          case "process.exiting":
            return finish(`scr_process_exiting()`);
          case "net.getAutoSelTimeout":
            return finish(`scr_net_get_autosel_timeout()`);
          case "net.setAutoSelTimeout":
            return finish(`scr_net_set_autosel_timeout(${arg(0)})`);
          case "fs.realpathSync":
            return finish(`scr_fs_realpath(${arg(0)})`);
          case "process.kill":
            // Throws Node's kill errors (bad pid TypeError, unknown-signal
            // TypeError, ESRCH/EPERM Error); the pending check comes from
            // the may-throw set.
            return finish(`scr_process_kill_named(${arg(0)}, ${arg(1)})`);
          case "process.killNum":
            return finish(`scr_process_kill(${arg(0)}, ${arg(1)})`);
          case "process.exit":
            // Flushes stdout and _Exit()s — never returns (exit handlers,
            // including the RC audit, deliberately do not run).
            return finish(`scr_process_exit(${arg(0)})`);
          case "timers.setTimeout": {
            // The loop owns the callback until it fires.
            E.usesTimers = true;
            const cb = args[0]!;
            E.moveTemp(cb);
            return finish(`scr_set_timeout(${cb.name}, ${arg(1)})`);
          }
          case "timers.setInterval": {
            // The loop owns the callback until clearInterval; the f64
            // handle comes back. A live interval keeps the loop alive.
            E.usesTimers = true;
            const cb = args[0]!;
            E.moveTemp(cb);
            return finish(`scr_set_interval(${cb.name}, ${arg(1)})`);
          }
          case "timers.clearInterval":
            return finish(`scr_clear_interval(${arg(0)})`);
          case "timers.setTimeoutHandle": {
            E.usesTimers = true;
            const cb = args[0]!;
            E.moveTemp(cb);
            return finish(`scr_set_timeout_handle(${cb.name}, ${arg(1)})`);
          }
          case "timers.clearTimeout":
            return finish(`scr_clear_interval(${arg(0)})`);
          case "timers.unref":
            // Returns the handle for chaining (comma expr: bookkeep, yield).
            return E.newTemp(e.type, `(scr_timer_unref(${arg(0)}), ${arg(0)})`);
          case "timers.ref":
            return E.newTemp(e.type, `(scr_timer_ref(${arg(0)}), ${arg(0)})`);
          case "timers.hasRef":
            return finish(`scr_timer_has_ref(${arg(0)})`);
          case "timers.refresh":
            return E.newTemp(e.type, `(scr_timer_refresh(${arg(0)}), ${arg(0)})`);
          case "timers.setImmediate": {
            // The loop owns the callback until the check phase fires it.
            E.usesTimers = true;
            const cb = args[0]!;
            E.moveTemp(cb);
            return finish(`scr_set_immediate(${cb.name})`);
          }
          case "timers.queueMicrotask": {
            // The envelope owns the callback until the drain runs it; the
            // loop must run so a main-queued microtask fires after %main.
            E.usesTimers = true;
            const cb = args[0]!;
            E.moveTemp(cb);
            return finish(`scr_queue_microtask(${cb.name})`);
          }
          case "timers.queueMicrotaskDyn":
            // Borrowed dyn; a non-function throws ERR_INVALID_ARG_TYPE
            // synchronously (may-throw seed set).
            E.usesTimers = true;
            return finish(`scr_queue_microtask_dyn(${arg(0)})`);
          case "timers.clearImmediate":
            return finish(`scr_clear_immediate(${arg(0)})`);
          case "process.nextTick": {
            // The tick queue owns the callback until the drain fires it;
            // ticks run before promise jobs at every loop checkpoint and
            // keep the loop alive while queued, so main runs the loop.
            E.usesTimers = true;
            const cb = args[0]!;
            E.moveTemp(cb);
            return finish(`scr_next_tick(${cb.name})`);
          }
          case "timers.immediateUnref":
            return E.newTemp(e.type, `(scr_immediate_unref(${arg(0)}), ${arg(0)})`);
          case "timers.immediateRef":
            return E.newTemp(e.type, `(scr_immediate_ref(${arg(0)}), ${arg(0)})`);
          case "timers.immediateHasRef":
            return finish(`scr_immediate_has_ref(${arg(0)})`);
          case "timers.clearNoop":
            // clearTimeout(null) and friends: Node silently ignores
            // non-handles — nothing runs.
            return { name: "", type: e.type };
          case "process.onSignal": {
            // The registry owns the callback (zero-param — frontend-pinned)
            // until off/once removes it. The loop dispatches deliveries.
            E.usesTimers = true;
            const cb = args[1]!;
            E.moveTemp(cb);
            return finish(`scr_signal_on(${arg(0)}, ${cb.name}, ${arg(2)})`);
          }
          case "process.offSignal":
            // Borrowed callback: removal is by pointer identity.
            return finish(`scr_signal_off(${arg(0)}, ${arg(1)})`);
          case "process.onExit": {
            // Runtime adapters cover both shapes (the code is a plain
            // double); the registry owns the callback.
            const cbT = e.args[0]!.type;
            if (cbT.kind !== "func") throw new Error("emitter bug: process.onExit callback not a func");
            const cb = args[0]!;
            E.moveTemp(cb);
            const adapter = cbT.params.length === 0 ? "scr_exit_thunk0" : "scr_exit_thunk_code";
            E.line(`scr_process_on_exit(${cb.name}, &${adapter}, ${arg(1)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "process.offExit":
            return finish(`scr_process_off_exit(${arg(0)})`);
          case "stdin.onData": {
            // A data listener is a consumer: the loop watches fd 0 and
            // stays alive until EOF, so main must run it.
            E.usesTimers = true;
            const cbT = e.args[0]!.type;
            if (cbT.kind !== "func") throw new Error("emitter bug: stdin.onData callback not a func");
            const cb = args[0]!;
            E.moveTemp(cb);
            const adapter =
              cbT.params.length === 0 ? "scr_stdin_data_thunk0" : "scr_stdin_data_thunk_bytes";
            E.line(`scr_stdin_on_data(${cb.name}, &${adapter}, ${arg(1)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "stdin.onEnd": {
            E.usesTimers = true;
            const cb = args[0]!;
            E.moveTemp(cb);
            return finish(`scr_stdin_on_end(${cb.name}, ${arg(1)})`);
          }
          case "stdin.onError": {
            // The child error adapters fit exactly (message → %Error).
            E.usesTimers = true;
            const cbT = e.args[0]!.type;
            if (cbT.kind !== "func") throw new Error("emitter bug: stdin.onError callback not a func");
            const cb = args[0]!;
            E.moveTemp(cb);
            const adapter =
              cbT.params.length === 0 ? "scr_child_err_thunk0" : "scr_child_err_thunk_error";
            E.line(`scr_stdin_on_error(${cb.name}, &${adapter}, ${arg(1)});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "stdin.nextChunk":
            // +1 promise of the next chunk (empty = EOF); the await parks
            // the fiber while the loop watches fd 0.
            E.usesTimers = true;
            return finish(`scr_stdin_next_chunk()`);
          case "error.new": {
            // Which builtin the runtime constructs is named by the RESULT
            // type; the message is borrowed (the runtime retains its copy).
            // Never throws.
            if (e.type.kind !== "object") throw new Error("emitter bug: error.new result is not a class");
            const rec = RUNTIME_ERROR_CLASSES.get(e.type.className);
            if (!rec) throw new Error(`emitter bug: error.new of ${e.type.className}`);
            return finish(`scr_error_new(${rec.kind}, ${arg(0)})`);
          }
          case "error.ctor": {
            // super(message) into the builtin base: stamps name/message on
            // the receiver (borrowed, like the message). The RECEIVER'S
            // static class names which builtin name to stamp.
            const recvT = e.args[0]!.type;
            if (recvT.kind !== "object") throw new Error("emitter bug: error.ctor receiver is not a class");
            const rec = RUNTIME_ERROR_CLASSES.get(recvT.className);
            if (!rec) throw new Error(`emitter bug: error.ctor on ${recvT.className}`);
            return finish(`scr_error_init(${arg(0)}, ${rec.kind}, ${arg(1)})`);
          }
          case "error.toString":
            // Borrowed receiver; +1 "name: message" (Node's toString rules).
            return finish(`scr_error_to_string(${arg(0)})`);
          case "error.newDom":
            // new DOMException(message?, nameOrOptions?) — both dyn args
            // borrowed (WebIDL resolution runs in the runtime); +1
            // %DOMException. Never throws.
            return finish(`scr_domex_new(${arg(0)}, ${arg(1)})`);
          case "error.domCode":
            // The WebIDL legacy numeric code (0 off-table). Borrowed.
            return finish(`scr_domex_code(${arg(0)})`);
          case "error.domHasCause":
            // `'cause' in e` — the options form's own-property record.
            return finish(`scr_domex_has_cause(${arg(0)})`);
          case "error.domCause":
            // +1 cause dyn value (the dyn undefined when absent).
            return finish(`scr_domex_cause(${arg(0)})`);
          case "error.domClone":
            // WebIDL serialization: name/message copy, code re-derives.
            // Borrowed receiver + borrowed options; +1 %DOMException.
            // Option errors throw (may-throw seed set).
            return finish(`scr_domex_clone(${arg(0)}, ${arg(1)})`);
          case "dyn.objKeys":
            return finish(`scr_dyn_obj_keys(${arg(0)})`);
          case "dyn.assign":
            // Object.assign over dyn values: own members copy, the target
            // returns (+1); non-object receivers throw like Node.
            return finish(`scr_dyn_assign(${arg(0)}, ${arg(1)})`);
          case "dyn.packPush":
            // Variadic Object.assign's source pack: a plain source
            // retains in (both args borrowed). Never throws.
            return finish(`scr_dyn_pack_push(${arg(0)}, ${arg(1)})`);
          case "dyn.packPushSpread":
            // A spread source flattens through the spread-call walk —
            // V8's exact TypeError texts (may-throw seed set); the string
            // spells the spread expression for the nullish form.
            return finish(`scr_dyn_pack_push_spread(${arg(0)}, ${arg(1)}, ${arg(2)})`);
          case "dyn.packPushSpreadIter":
            // The non-last/multi-spread positions: V8's iterator-protocol
            // failure texts describe the value (may-throw seed set).
            return finish(`scr_dyn_pack_push_spread_iter(${arg(0)}, ${arg(1)})`);
          case "dyn.assignAll":
            // The flattened pack copies onto the target left to right;
            // the target returns (+1). Nullish targets throw like Node.
            return finish(`scr_dyn_assign_all(${arg(0)}, ${arg(1)})`);
          case "dyn.objCreateNullProto":
            // Object.create(null): the fresh null-prototype dictionary
            // (+1). Never throws.
            return finish(`scr_dyn_new_obj_null_proto()`);
          case "dyn.hasOwn":
            // Object.hasOwn over a dyn receiver (throws on nullish, like
            // Node's ToObject).
            return finish(`scr_dyn_has_own(${arg(0)}, ${arg(1)})`);
          case "dyn.objValues":
            return finish(`scr_dyn_obj_values(${arg(0)})`);
          case "dyn.objEntries":
            return finish(`scr_dyn_obj_entries(${arg(0)})`);
          case "dyn.errInstanceof":
            // The from_error cache resolves the dyn value to its runtime
            // error; the class's stamped interval answers. Never throws.
            return finish(`scr_dyn_err_instanceof(${arg(0)}, ${arg(1)})`);
          case "dyn.structuredClone":
            // Deep dyn clone (+1); option/DataClone/cycle errors throw
            // (may-throw seed set). Both args borrowed.
            return finish(`scr_structured_clone(${arg(0)}, ${arg(1)})`);
          case "dyn.cloneMissing":
            // Always throws ERR_MISSING_ARGS; the result never exists.
            return finish(`scr_structured_clone_missing()`);
          case "dyn.cloneTransferFail":
            // Always throws DataCloneError; the result never exists.
            return finish(`scr_structured_clone_transfer_fail()`);
          case "regex.new":
            // Eager compile: bad patterns/flags throw catchable
            // SyntaxError (may-throw seed set). Borrowed strings; +1.
            return finish(`scr_regex_new(${arg(0)}, ${arg(1)})`);
          // node:events EventEmitter (scr_events_emitter.c — linked
          // exactly when these appear, moduleUsesEmitter). Receivers are
          // borrowed and reinterpret to the runtime's ScrEmitter prefix;
          // the chaining forms answer the receiver +1 (Node's `return
          // this`), cast back to the receiver's static struct.
          case "emitter.new":
            // +1 bare emitter, collector-headered (the registry owns
            // listener closures — unconditionally cycle-capable).
            return finish(`scr_emitter_new()`);
          case "emitter.ctor":
            // super() into the prefix: the allocation already initialized
            // it (registry NULL, display name stamped by the newFn).
            return finish(`scr_emitter_init(${arg(0)})`);
          case "emitter.on": {
            // (recv, name, cb /moves/, once, prepend): the listener rides
            // the registry with its emitted per-signature invoke adapter.
            // May-throw: 'newListener' meta listeners run inside.
            const cbT = e.args[2]!.type;
            const cb = args[2]!;
            E.moveTemp(cb);
            const thunk = E.emitterInvokeThunkFor(cbT);
            return finish(
              `(${cType(e.type).trim()})scr_emitter_on((ScrEmitter *)${arg(0)}, ${arg(1)}, ${cb.name}, &${thunk}, ${arg(3)}, ${arg(4)})`,
            );
          }
          case "emitter.off":
            // (recv, name, cb /borrowed — identity match/). May-throw:
            // 'removeListener' meta listeners run inside.
            return finish(
              `(${cType(e.type).trim()})scr_emitter_off((ScrEmitter *)${arg(0)}, ${arg(1)}, ${arg(2)})`,
            );
          case "emitter.checkListener":
            // Node's registration-family listener type check: a
            // non-function dyn throws the catchable ERR_INVALID_ARG_TYPE
            // TypeError (may-throw seed).
            return finish(`scr_emitter_check_listener(${arg(0)})`);
          case "emitter.onDyn": {
            // (recv, name, cb /borrowed dyn — the identity/, adapter
            // /moves/, once, prepend): the ADAPTER (the frontend's
            // dynCheck value — it boxes the tuple to dyn and calls the
            // original) rides the registry with its own invoke thunk; the
            // runtime keeps the original as the entry's identity.
            const adT = e.args[3]!.type;
            const adapter = args[3]!;
            E.moveTemp(adapter);
            const dynThunk = E.emitterInvokeThunkFor(adT);
            return finish(
              `(${cType(e.type).trim()})scr_emitter_on_dyn((ScrEmitter *)${arg(0)}, ${arg(1)}, ${arg(2)}, ${adapter.name}, &${dynThunk}, ${arg(4)}, ${arg(5)})`,
            );
          }
          case "emitter.onData": {
            // The stream-'data' registration: same runtime entry as
            // emitter.on, but the DATA invoke thunk (the two-slot payload
            // ABI — see scr_stream_emit_data).
            const cbT = e.args[2]!.type;
            const cb = args[2]!;
            E.moveTemp(cb);
            const thunk = E.streamDataThunkFor(cbT);
            return finish(
              `(${cType(e.type).trim()})scr_emitter_on((ScrEmitter *)${arg(0)}, ${arg(1)}, ${cb.name}, &${thunk}, ${arg(3)}, ${arg(4)})`,
            );
          }
          case "emitter.onDataDyn": {
            // The dyn-listener flavor: the frontend's adapter takes ONE
            // dyn parameter; the data thunk boxes the payload by tag.
            const adT = e.args[3]!.type;
            const adapter = args[3]!;
            E.moveTemp(adapter);
            const dynThunk = E.streamDataThunkFor(adT);
            return finish(
              `(${cType(e.type).trim()})scr_emitter_on_dyn((ScrEmitter *)${arg(0)}, ${arg(1)}, ${arg(2)}, ${adapter.name}, &${dynThunk}, ${arg(4)}, ${arg(5)})`,
            );
          }
          case "emitter.emitData": {
            // A user emit('data', chunk) on a stream-rooted receiver:
            // fill the matching payload slot, NULL the other.
            const chunkT = e.args[2]!.type;
            const both =
              chunkT.kind === "string"
                ? `(ScrBytes *)NULL, ${arg(2)}`
                : `${arg(2)}, (ScrStr *)NULL`;
            return finish(`scr_emitter_emit((ScrEmitter *)${arg(0)}, ${arg(1)}, ${both})`);
          }
          case "emitter.offDyn":
            // (recv, name, cb /borrowed dyn/): identity is the dyn box's
            // underlying closure. May-throw ('removeListener' meta).
            return finish(
              `(${cType(e.type).trim()})scr_emitter_off_dyn((ScrEmitter *)${arg(0)}, ${arg(1)}, ${arg(2)})`,
            );
          case "emitter.removeAll":
            return finish(
              `(${cType(e.type).trim()})scr_emitter_remove_all((ScrEmitter *)${arg(0)}, ${arg(1)}, ${arg(2)})`,
            );
          case "emitter.emit":
            // The variadic dispatch: the event's unified tuple rides the
            // C variadic tail, every argument borrowed (the invoke
            // adapters retain each callee's +1). May-throw (listeners).
            return finish(
              `scr_emitter_emit((ScrEmitter *)${arg(0)}, ${arg(1)}${e.args.slice(2).map((_, i) => `, ${arg(i + 2)}`).join("")})`,
            );
          case "emitter.emitError":
            // emit('error', err): unhandled ⇒ the runtime throws the
            // payload through the exception cell (may-throw seed).
            return finish(
              `scr_emitter_emit_error((ScrEmitter *)${arg(0)}, ${arg(1)}, ${arg(2)})`,
            );
          case "emitter.count":
            return finish(`scr_emitter_listener_count((ScrEmitter *)${arg(0)}, ${arg(1)})`);
          case "emitter.countFn":
            return finish(`scr_emitter_listener_count_fn((ScrEmitter *)${arg(0)}, ${arg(1)}, ${arg(2)})`);
          case "emitter.names":
            // +1 string[] in first-registration order.
            return finish(`scr_emitter_event_names((ScrEmitter *)${arg(0)})`);
          case "emitter.listeners":
            // +1 closure array (originals — once wrappers are runtime-
            // internal; SEMANTICS.md documents the rawListeners stance).
            return finish(`scr_emitter_listeners((ScrEmitter *)${arg(0)}, ${arg(1)})`);
          case "emitter.setMax":
            return finish(
              `(${cType(e.type).trim()})scr_emitter_set_max((ScrEmitter *)${arg(0)}, ${arg(1)})`,
            );
          case "emitter.setMaxChk":
            // The checked-dynamic ladder (may throw); +1 receiver back.
            return finish(
              `(${cType(e.type).trim()})scr_emitter_set_max_chk((ScrEmitter *)${arg(0)}, ${arg(1)})`,
            );
          case "emitter.getMax":
            return finish(`scr_emitter_get_max((ScrEmitter *)${arg(0)})`);
          case "emitter.setDefaultMax":
            return finish(`scr_emitter_set_default_max(${arg(0)})`);
          case "emitter.setDefaultMaxChk":
            return finish(`scr_emitter_set_default_max_chk(${arg(0)}, ${arg(1)})`);
          case "emitter.getDefaultMax":
            return finish(`scr_emitter_get_default_max()`);
          // node:stream (scr_stream.c — linked exactly when these appear,
          // moduleUsesStream). Receivers reinterpret to the shared
          // ScrStream layout (the ScrEmitter prefix plus the stream-state
          // pointer); chaining forms answer the receiver +1 cast back to
          // its static class. Any operation that can run user code holds
          // the loop open (deferred next-tick emissions): usesTimers.
          case "readable.new":
          case "writable.new":
          case "duplex.new":
          case "transform.new":
          case "passthrough.new":
          case "readable.init":
          case "writable.init":
          case "duplex.init":
          case "transform.init":
          case "passthrough.init": {
            E.usesTimers = true;
            // Head args then flags then the PRESENT callbacks in canonical
            // order — the flags literal names which; absent ones emit NULL.
            // The .init forms (a subclass constructor's super(options))
            // carry the BORROWED receiver at arg 0 and shift everything by
            // one; scr_stream_init_* fills the already-allocated struct.
            const base = fn.slice(0, fn.indexOf("."));
            const isInit = fn.endsWith(".init");
            const off = isInit ? 1 : 0;
            const duplexShape = base !== "readable" && base !== "writable";
            const headLen = duplexShape ? 8 : 4;
            const flagsArg = e.args[off + headLen - 1]!;
            if (flagsArg.kind !== "numLit") throw new Error(`emitter bug: ${fn} flags not a literal`);
            const flags = flagsArg.value;
            const canonical: { name: string; kind: "r" | "w" | "f" | "d" | "t" | "l" }[] =
              base === "readable"
                ? [{ name: "read", kind: "r" }, { name: "destroy", kind: "d" }]
                : base === "writable"
                  ? [{ name: "write", kind: "w" }, { name: "final", kind: "f" }, { name: "destroy", kind: "d" }]
                  : base === "duplex"
                    ? [{ name: "read", kind: "r" }, { name: "write", kind: "w" }, { name: "final", kind: "f" }, { name: "destroy", kind: "d" }]
                    : [{ name: "transform", kind: "t" }, { name: "flush", kind: "l" }, { name: "destroy", kind: "d" }];
            const cbArgs: string[] = [];
            let at = off + headLen;
            for (let i = 0; i < canonical.length; i++) {
              if ((flags & (1 << i)) === 0) {
                cbArgs.push("NULL", "NULL");
                continue;
              }
              const cb = args[at]!;
              const cbT = e.args[at]!.type;
              E.moveTemp(cb); // the callback closure MOVES into the stream
              cbArgs.push(cb.name, `&${E.streamCbThunkFor(canonical[i]!.kind, cbT)}`);
              at++;
            }
            const entry = isInit ? `scr_stream_init_${base}` : `scr_stream_new_${base}`;
            const headIdx = duplexShape ? [0, 1, 2, 3, 4, 5, 6] : [0, 1, 2];
            const head = headIdx.map((i) => arg(off + i)).join(", ");
            if (isInit) {
              return finish(`${entry}((ScrStream *)${arg(0)}, ${head}, ${cbArgs.join(", ")})`);
            }
            return finish(`(${cType(e.type).trim()})${entry}(${head}, ${cbArgs.join(", ")})`);
          }
          case "stream.setRead":
          case "stream.setWrite":
          case "stream.setFinal":
          case "stream.setDestroy":
          case "stream.setTransform":
          case "stream.setFlush": {
            // The underscore-method assignment surface: the runtime slot
            // swaps its closure (+1 moves in) and invoke thunk — the next
            // _read/_write/... dispatch uses it, Node's timing.
            E.usesTimers = true;
            const kindOf: Record<string, "r" | "w" | "f" | "d" | "t" | "l"> = {
              "stream.setRead": "r", "stream.setWrite": "w", "stream.setFinal": "f",
              "stream.setDestroy": "d", "stream.setTransform": "t", "stream.setFlush": "l",
            };
            const symOf: Record<string, string> = {
              "stream.setRead": "scr_stream_set_read", "stream.setWrite": "scr_stream_set_write",
              "stream.setFinal": "scr_stream_set_final", "stream.setDestroy": "scr_stream_set_destroy",
              "stream.setTransform": "scr_stream_set_transform", "stream.setFlush": "scr_stream_set_flush",
            };
            const cb = args[1]!;
            const cbT = e.args[1]!.type;
            E.moveTemp(cb); // the callback closure MOVES into the stream
            return finish(`${symOf[fn]!}((ScrStream *)${arg(0)}, ${cb.name}, &${E.streamCbThunkFor(kindOf[fn]!, cbT)})`);
          }
          case "stream.finished":
          case "stream.finishedDyn": {
            // finished(s, cb): the +1 cleanup closure answers. Typed
            // callbacks ride the "e" thunk (this + Error|null prefix);
            // dyn values ride the runtime's own inv.
            E.usesTimers = true;
            if (fn === "stream.finishedDyn") {
              return finish(`(${cType(e.type).trim()})scr_stream_finished_dyn((ScrStream *)${arg(0)}, ${arg(1)})`);
            }
            const cb = args[1]!;
            E.moveTemp(cb); // the watcher closure MOVES into the stream
            const thunk = E.streamCbThunkFor("e", e.args[1]!.type);
            return finish(`(${cType(e.type).trim()})scr_stream_finished((ScrStream *)${arg(0)}, ${cb.name}, &${thunk})`);
          }
          case "stream.pipeline":
          case "stream.pipelineDyn": {
            // pipeline(count, s1..sn, cb): the destination answers +1.
            E.usesTimers = true;
            const countArg = e.args[0]!;
            if (countArg.kind !== "numLit") throw new Error(`emitter bug: ${fn} count not a literal`);
            const n = countArg.value;
            const list = Array.from({ length: n }, (_, i) => `(ScrStream *)${arg(1 + i)}`).join(", ");
            if (fn === "stream.pipelineDyn") {
              return finish(
                `(${cType(e.type).trim()})scr_stream_pipeline_dyn(${n}, (ScrStream *[]){ ${list} }, ${arg(1 + n)})`,
              );
            }
            const cb = args[1 + n]!;
            E.moveTemp(cb);
            const thunk = E.streamCbThunkFor("e", e.args[1 + n]!.type);
            return finish(
              `(${cType(e.type).trim()})scr_stream_pipeline(${n}, (ScrStream *[]){ ${list} }, ${cb.name}, &${thunk})`,
            );
          }
          case "sp.finished":
            // The stream/promises form: a +1 pending promise the terminal
            // watcher settles — no callback, no cleanup exposure.
            E.usesTimers = true;
            return finish(`scr_sp_finished((ScrStream *)${arg(0)})`);
          case "sp.pipeline": {
            // pipeline(count, s1..sn) settling a void promise; the stream
            // list rides the callback form's compound literal.
            E.usesTimers = true;
            const countArg = e.args[0]!;
            if (countArg.kind !== "numLit") throw new Error(`emitter bug: ${fn} count not a literal`);
            const n = countArg.value;
            const list = Array.from({ length: n }, (_, i) => `(ScrStream *)${arg(1 + i)}`).join(", ");
            return finish(`scr_sp_pipeline(${n}, (ScrStream *[]){ ${list} })`);
          }
          case "sc.text":
            // stream/consumers: +1 pending promises the accumulate-and-
            // settle machinery resolves or rejects (the stream's
            // error / premature close / json's SyntaxError).
            E.usesTimers = true;
            return finish(`scr_sc_text((ScrStream *)${arg(0)})`);
          case "sc.json":
            E.usesTimers = true;
            return finish(`scr_sc_json((ScrStream *)${arg(0)})`);
          case "sc.buffer":
            E.usesTimers = true;
            return finish(`scr_sc_buffer((ScrStream *)${arg(0)})`);
          case "readable.newDyn":
          case "writable.newDyn":
          case "duplex.newDyn":
          case "transform.newDyn":
          case "passthrough.newDyn": {
            // The dyn-options constructor: the runtime walks the record
            // (borrowed). MAY THROW (NULL result with the exception
            // pending — the seed set carries these).
            E.usesTimers = true;
            const base = fn.slice(0, fn.indexOf("."));
            return finish(`(${cType(e.type).trim()})scr_stream_new_${base}_dyn(${arg(0)})`);
          }
          case "readable.initDyn":
          case "writable.initDyn":
          case "duplex.initDyn":
          case "transform.initDyn":
          case "passthrough.initDyn": {
            // The dyn-options super(options): borrowed receiver + record,
            // then the FALLBACK underscore-method wrappers in canonical
            // order (flags names which; absent ones emit NULL — exactly
            // the .init callback ABI; wrappers MOVE).
            E.usesTimers = true;
            const base = fn.slice(0, fn.indexOf("."));
            const flagsArg = e.args[2]!;
            if (flagsArg.kind !== "numLit") throw new Error(`emitter bug: ${fn} flags not a literal`);
            const flags = flagsArg.value;
            const canonical: { name: string; kind: "r" | "w" | "f" | "d" | "t" | "l" }[] =
              base === "readable"
                ? [{ name: "read", kind: "r" }, { name: "destroy", kind: "d" }]
                : base === "writable"
                  ? [{ name: "write", kind: "w" }, { name: "final", kind: "f" }, { name: "destroy", kind: "d" }]
                  : base === "duplex"
                    ? [{ name: "read", kind: "r" }, { name: "write", kind: "w" }, { name: "final", kind: "f" }, { name: "destroy", kind: "d" }]
                    : [{ name: "transform", kind: "t" }, { name: "flush", kind: "l" }, { name: "destroy", kind: "d" }];
            const cbArgs: string[] = [];
            let at = 3;
            for (let i = 0; i < canonical.length; i++) {
              if ((flags & (1 << i)) === 0) {
                cbArgs.push("NULL", "NULL");
                continue;
              }
              const cb = args[at]!;
              const cbT = e.args[at]!.type;
              E.moveTemp(cb);
              cbArgs.push(cb.name, `&${E.streamCbThunkFor(canonical[i]!.kind, cbT)}`);
              at++;
            }
            return finish(`scr_stream_init_${base}_dyn((ScrStream *)${arg(0)}, ${arg(1)}, ${cbArgs.join(", ")})`);
          }
          case "readable.push":
            E.usesTimers = true;
            return finish(`scr_stream_push((ScrStream *)${arg(0)}, ${arg(1)})`);
          case "readable.pushStr":
            E.usesTimers = true;
            return finish(`scr_stream_push_str((ScrStream *)${arg(0)}, ${arg(1)})`);
          case "readable.pushStrEnc":
            // push(chunk, enc) with a literal non-utf8 encoding.
            E.usesTimers = true;
            return finish(`scr_stream_push_str_enc((ScrStream *)${arg(0)}, ${arg(1)}, ${arg(2)})`);
          case "readable.pushEncoding":
            // The defaultEncoding option's push side (chaining, +1).
            E.usesTimers = true;
            return finish(`(${cType(e.type).trim()})scr_stream_set_push_encoding((ScrStream *)${arg(0)}, ${arg(1)})`);
          case "readable.pushNull":
            E.usesTimers = true;
            return finish(`scr_stream_push_null((ScrStream *)${arg(0)})`);
          case "readable.pushU":
          case "writable.writeU": {
            // Union-typed chunk: dispatch by tag (bytes / string / null
            // arms — the frontend admitted exactly those).
            E.usesTimers = true;
            const t = e.args[1]!.type;
            if (t.kind !== "union") throw new Error(`emitter bug: ${fn} chunk not a union`);
            const def = E.unionsById.get(t.unionId);
            if (!def) throw new Error(`emitter bug: ${fn} union unknown`);
            const bytesTag = def.arms.findIndex((a) => a.kind === "bytes");
            const strTag = def.arms.findIndex((a) => a.kind === "string");
            const nullTag = def.arms.findIndex((a) => a.kind === "nullT");
            const u = arg(1);
            const recv = `(ScrStream *)${arg(0)}`;
            const pushing = fn === "readable.pushU";
            const onBytes = pushing
              ? `scr_stream_push(${recv}, (ScrBytes *)scr_union_peek(${u}))`
              : `scr_stream_write(${recv}, (ScrBytes *)scr_union_peek(${u}), NULL)`;
            const onStr = pushing
              ? `scr_stream_push_str(${recv}, (ScrStr *)scr_union_peek(${u}))`
              : `scr_stream_write_str(${recv}, (ScrStr *)scr_union_peek(${u}), NULL)`;
            const onNull = pushing
              ? `scr_stream_push_null(${recv})`
              : `scr_stream_write_null(${recv})`;
            const present: { tag: number; expr: string }[] = [
              ...(nullTag >= 0 ? [{ tag: nullTag, expr: onNull }] : []),
              ...(strTag >= 0 ? [{ tag: strTag, expr: onStr }] : []),
              ...(bytesTag >= 0 ? [{ tag: bytesTag, expr: onBytes }] : []),
            ];
            if (present.length === 0) throw new Error(`emitter bug: ${fn} union lacks its arms`);
            const tail = present[present.length - 1]!.expr;
            const chain = present.slice(0, -1).map((a) => `${u}->tag == ${a.tag} ? ${a.expr}`);
            return finish(chain.length > 0 ? `(${chain.join(" : ")} : ${tail})` : tail);
          }
          case "readable.pushDyn":
            E.usesTimers = true;
            return finish(`scr_stream_push_dyn((ScrStream *)${arg(0)}, ${arg(1)})`);
          case "readable.unshift":
            E.usesTimers = true;
            return finish(`scr_stream_unshift((ScrStream *)${arg(0)}, ${arg(1)})`);
          case "readable.unshiftStr":
            E.usesTimers = true;
            return finish(`scr_stream_unshift_str((ScrStream *)${arg(0)}, ${arg(1)})`);
          case "readable.read": {
            // +1 Buffer or NULL → the `Buffer | null` union, constructed
            // type-directedly (the error.code pattern).
            E.usesTimers = true;
            if (e.type.kind !== "union") throw new Error("emitter bug: readable.read result is not a union");
            const def = E.unionsById.get(e.type.unionId);
            const bytesTag = def ? def.arms.findIndex((a) => a.kind === "bytes") : -1;
            const nullTag = def ? def.arms.findIndex((a) => a.kind === "nullT") : -1;
            if (bytesTag < 0 || nullTag < 0) throw new Error("emitter bug: readable.read union lacks its arms");
            const b = E.newTemp(bytesOf("u8"), `scr_stream_read((ScrStream *)${arg(0)}, ${arg(1)})`);
            E.emitPendingCheck();
            E.moveTemp(b); // moves into the union arm when present
            const present = `scr_union_new_ref(${bytesTag}, ${b.name}, &scr_bytes_retain_v, &scr_bytes_release_v, NULL)`;
            return E.newTemp(e.type, `${b.name} ? ${present} : scr_union_retain(${E.unitInstanceRef(e.type.unionId, nullTag)})`);
          }
          case "readable.pause":
            return finish(`(${cType(e.type).trim()})scr_stream_pause((ScrStream *)${arg(0)})`);
          case "readable.setEncoding":
            E.usesTimers = true;
            return finish(`(${cType(e.type).trim()})scr_stream_set_encoding((ScrStream *)${arg(0)}, ${arg(1)})`);
          case "readable.nextChunk":
            // +1 promise; may run the user _read synchronously (may-throw).
            E.usesTimers = true;
            return finish(`scr_stream_next_chunk((ScrStream *)${arg(0)})`);
          case "readable.nextChunkDyn":
            E.usesTimers = true;
            return finish(`scr_stream_next_chunk_dyn((ScrStream *)${arg(0)})`);
          case "readable.fromArr":
            E.usesTimers = true;
            return finish(`(${cType(e.type).trim()})scr_stream_from_arr(${arg(0)}, ${arg(1)})`);
          case "readable.resume":
            E.usesTimers = true;
            return finish(`(${cType(e.type).trim()})scr_stream_resume((ScrStream *)${arg(0)})`);
          case "readable.isPaused":
            return finish(`scr_stream_is_paused((ScrStream *)${arg(0)})`);
          case "readable.pipe":
            E.usesTimers = true;
            return finish(`(${cType(e.type).trim()})scr_stream_pipe((ScrStream *)${arg(0)}, (ScrStream *)${arg(1)}, ${arg(2)})`);
          case "readable.unpipe":
            E.usesTimers = true;
            return finish(
              e.args.length > 1
                ? `(${cType(e.type).trim()})scr_stream_unpipe((ScrStream *)${arg(0)}, (ScrStream *)${arg(1)})`
                : `(${cType(e.type).trim()})scr_stream_unpipe((ScrStream *)${arg(0)}, NULL)`,
            );
          case "readable.flowing": {
            // -1 (null: never kicked) / 0 / 1 → the `boolean | null` union.
            if (e.type.kind !== "union") throw new Error("emitter bug: readable.flowing result is not a union");
            const def = E.unionsById.get(e.type.unionId);
            const boolTag = def ? def.arms.findIndex((a) => a.kind === "bool") : -1;
            const nullTag = def ? def.arms.findIndex((a) => a.kind === "nullT") : -1;
            if (boolTag < 0 || nullTag < 0) throw new Error("emitter bug: readable.flowing union lacks its arms");
            const f = E.newTemp({ kind: "f64" }, `scr_stream_flowing((ScrStream *)${arg(0)})`);
            return E.newTemp(
              e.type,
              `${f.name} < 0 ? scr_union_retain(${E.unitInstanceRef(e.type.unionId, nullTag)}) : scr_union_new_bool(${boolTag}, ${f.name} > 0)`,
            );
          }
          case "writable.writeDyn":
            E.usesTimers = true;
            return finish(`scr_stream_write_dyn((ScrStream *)${arg(0)}, ${arg(1)}, NULL)`);
          case "writable.write":
          case "writable.writeStr": {
            E.usesTimers = true;
            const entry = fn === "writable.write" ? "scr_stream_write" : "scr_stream_write_str";
            if (e.args.length > 2) {
              const cb = args[2]!;
              E.moveTemp(cb); // the user's completion callback MOVES
              return finish(`${entry}((ScrStream *)${arg(0)}, ${arg(1)}, ${cb.name})`);
            }
            return finish(`${entry}((ScrStream *)${arg(0)}, ${arg(1)}, NULL)`);
          }
          case "writable.end": {
            // (recv, flags[, chunk][, cb]) — flags: 1 bytes chunk, 2 string
            // chunk, 4 callback.
            E.usesTimers = true;
            const flagsArg = e.args[1]!;
            if (flagsArg.kind !== "numLit") throw new Error("emitter bug: writable.end flags not a literal");
            const flags = flagsArg.value;
            let at = 2;
            let chunkB = "NULL";
            let chunkS = "NULL";
            let chunkD: string | null = null;
            if (flags & 1) chunkB = arg(at++);
            else if (flags & 2) chunkS = arg(at++);
            else if (flags & 8) chunkD = arg(at++); // dyn chunk: write first
            let cbName = "NULL";
            if (flags & 4) {
              const cb = args[at]!;
              E.moveTemp(cb);
              cbName = cb.name;
            }
            const endCall = `(${cType(e.type).trim()})scr_stream_end((ScrStream *)${arg(0)}, ${chunkB}, ${chunkS}, ${cbName})`;
            if (chunkD !== null) {
              // end(chunk) with a checked-dynamic chunk: write, then end
              // (exactly Node's end(chunk) decomposition).
              return finish(`(scr_stream_write_dyn((ScrStream *)${arg(0)}, ${chunkD}, NULL), ${endCall})`);
            }
            return finish(endCall);
          }
          case "writable.cork":
            return finish(`scr_stream_cork((ScrStream *)${arg(0)})`);
          case "writable.uncork":
            E.usesTimers = true;
            return finish(`scr_stream_uncork((ScrStream *)${arg(0)})`);
          case "stream.destroy":
            E.usesTimers = true;
            return finish(`(${cType(e.type).trim()})scr_stream_destroy((ScrStream *)${arg(0)}, NULL)`);
          case "stream.destroyErr":
            E.usesTimers = true;
            return finish(`(${cType(e.type).trim()})scr_stream_destroy((ScrStream *)${arg(0)}, ${arg(1)})`);
          case "stream.prop": {
            // The property NAME is a compile-time literal; args[1]'s
            // emitted temp is unused (released with the statement's frame).
            const nameArg = e.args[1]!;
            if (nameArg.kind !== "strLit") throw new Error("emitter bug: stream.prop name not a literal");
            const c = `scr_stream_prop((ScrStream *)${arg(0)}, "${nameArg.value}")`;
            return finish(e.type.kind === "bool" ? `(${c} != 0)` : c);
          }
          case "stream.errored": {
            // +1 error or NULL → the `Error | null` union (error.code's
            // construction pattern).
            if (e.type.kind !== "union") throw new Error("emitter bug: stream.errored result is not a union");
            const def = E.unionsById.get(e.type.unionId);
            const errTag = def ? def.arms.findIndex((a) => a.kind === "object") : -1;
            const nullTag = def ? def.arms.findIndex((a) => a.kind === "nullT") : -1;
            if (errTag < 0 || nullTag < 0) throw new Error("emitter bug: stream.errored union lacks its arms");
            const er = E.newTemp({ kind: "object", className: "%Error" }, `scr_stream_errored((ScrStream *)${arg(0)})`);
            E.moveTemp(er);
            const present = `scr_union_new_ref(${errTag}, ${er.name}, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg())`;
            return E.newTemp(e.type, `${er.name} ? ${present} : scr_union_retain(${E.unitInstanceRef(e.type.unionId, nullTag)})`);
          }
          case "error.code": {
            // `string | undefined`, constructed type-directedly like
            // process.envGet: a stamped code wraps the string arm (+1
            // moves into the box); absent yields the interned
            // undefined-arm instance. The receiver may be a user subclass
            // struct — the code slot sits in its ScrError prefix, so the
            // cast is the ordinary upcast reinterpret.
            if (e.type.kind !== "union") {
              throw new Error("emitter bug: error.code result is not a union");
            }
            const def = E.unionsById.get(e.type.unionId);
            const strTag = def ? def.arms.findIndex((a) => a.kind === "string") : -1;
            const undefTag = E.undefinedArmTag(e.type);
            if (strTag < 0 || undefTag < 0) {
              throw new Error("emitter bug: error.code union lacks its arms");
            }
            const s = E.newTemp(STRING, `scr_error_code((ScrError *)${arg(0)})`);
            E.moveTemp(s); // moves into the box when present; NULL otherwise
            const present = `scr_union_new_ref(${strTag}, ${s.name}, &scr_str_retain_v, &scr_str_release_v, NULL)`;
            const absent = E.unitInstanceRef(e.type.unionId, undefTag);
            return E.newTemp(e.type, `${s.name} ? ${present} : ${absent}`);
          }
          // node:assert (scr_assert.c; match in scr_regex.c): all args
          // borrowed; failures throw the catchable AssertionError (the
          // may-throw seed runs the pending check after each).
          case "assert.ok":
            return finish(`scr_assert_ok(${arg(0)}, ${arg(1)})`);
          case "assert.eqF64":
            return finish(`scr_assert_eq_f64(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)}, ${arg(4)}, ${arg(5)})`);
          case "assert.eqStr":
            return finish(`scr_assert_eq_str(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)}, ${arg(4)}, ${arg(5)})`);
          case "assert.eqBool":
            return finish(`scr_assert_eq_bool(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)}, ${arg(4)}, ${arg(5)})`);
          case "assert.eqSym":
            // Symbol strict equality: pointer identity, v24's
            // "Symbol(desc)" stacked-diff messages (scr_symbol.c).
            return finish(`scr_assert_eq_sym(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)}, ${arg(4)}, ${arg(5)})`);
          case "assert.eqDyn":
            // The quartet over checked-dynamic operands: SameValue /
            // dyn-walk deep equality, assertion_error.js messages.
            return finish(`scr_assert_eq_dyn(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)}, ${arg(4)}, ${arg(5)})`);
          case "assert.deepResult":
            return finish(`scr_assert_deep_result(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)})`);
          case "assert.deqEnter":
            return finish(`scr_assert_deq_enter(${arg(0)}, ${arg(1)})`);
          case "assert.deqLeave":
            return finish(`scr_assert_deq_leave()`);
          case "assert.sameValue":
            return finish(`scr_assert_same_value_f64(${arg(0)}, ${arg(1)})`);
          case "assert.match":
            return finish(`scr_assert_match(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)}, ${arg(4)})`);
          case "assert.throwsNone":
            return finish(`scr_assert_throws_none(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)}, ${arg(4)})`);
          case "assert.throwsMismatch":
            return finish(`scr_assert_throws_mismatch(${arg(0)}, (ScrError *)${arg(1)}, ${arg(2)}, ${arg(3)})`);
          case "assert.throwsRegex":
            // assert.throws(fn, /re/): Node tests String(error)
            // (scr_regex.c — the regex argument keeps the link switch on).
            return finish(`scr_assert_throws_regex(${arg(0)}, (ScrError *)${arg(1)}, ${arg(2)}, ${arg(3)})`);
          // The throws(fn, {shape}) accumulator: begin/slot calls never
          // throw; shapeEnd throws the byte-exact Comparison diff on
          // mismatch.
          case "assert.shapeBegin":
            return finish(`scr_assert_shape_begin((ScrError *)${arg(0)})`);
          case "assert.shapeStr":
            return finish(`scr_assert_shape_str(${arg(0)}, ${arg(1)})`);
          case "assert.shapeRe":
            return finish(`scr_assert_shape_re(${arg(0)}, ${arg(1)})`);
          case "assert.shapeEnd":
            return finish(`scr_assert_shape_end(${arg(0)}, ${arg(1)})`);
          case "assert.regexErrTest":
            return finish(`scr_assert_regex_err_test(${arg(0)}, (ScrError *)${arg(1)})`);
          case "assert.unwantedRejection":
            return finish(`scr_assert_unwanted_rejection((ScrError *)${arg(0)}, ${arg(1)}, ${arg(2)})`);
          // assert.ifError's per-type throws (always throw — Node rejects
          // falsy values too; null/undefined never reach the runtime).
          case "assert.ifErrorErr":
            return finish(`scr_assert_iferror_err((ScrError *)${arg(0)})`);
          case "assert.ifErrorF64":
            return finish(`scr_assert_iferror_f64(${arg(0)})`);
          case "assert.ifErrorStr":
            return finish(`scr_assert_iferror_str(${arg(0)})`);
          case "assert.ifErrorBool":
            return finish(`scr_assert_iferror_bool(${arg(0)})`);
          case "assert.ifErrorDyn":
            // The checked-dynamic argument (test/common's mustSucceed):
            // units pass quietly, %error-marked objects throw with the
            // error's message, everything else with the inspection.
            return finish(`scr_assert_iferror_dyn(${arg(0)})`);
          case "assert.refEqBytes":
            // strictEqual/notStrictEqual over bytes: pointer identity,
            // Node's object-comparison headers (brands_eq is the static
            // brand agreement — it shapes only the failure header).
            return finish(`scr_assert_ref_eq_bytes(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)}, ${arg(4)}, ${arg(5)})`);
          case "assert.refEqFn":
            // strictEqual/notStrictEqual over functions: pointer identity,
            // the object-comparison headers.
            return finish(`scr_assert_ref_eq_fn(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)}, ${arg(4)})`);
          case "assert.bytesDeepEq":
            // deepStrictEqual's verdict: static brand agreement AND
            // content equality. Never throws.
            return finish(`scr_assert_bytes_deep_eq(${arg(0)}, ${arg(1)}, ${arg(2)})`);
          // util.inspect (scr_inspect.c): all args borrowed; string
          // results +1. Only insp.jsval throws (composite island values —
          // the may-throw seed runs the pending check).
          case "insp.f64":
            return finish(`scr_insp_f64(${arg(0)})`);
          case "insp.jsonDyn":
            return finish(`scr_dyn_format_j(${arg(0)})`);
          case "insp.str":
            return finish(`scr_insp_str(${arg(0)})`);
          case "insp.regex":
            return finish(`scr_insp_regex(${arg(0)})`);
          case "insp.buffer":
            return finish(`scr_insp_buffer(${arg(0)})`);
          case "insp.error":
            // The receiver may be a user subclass struct — its ScrError
            // prefix carries the name/message/code slots (the error.code
            // precedent).
            return finish(`scr_insp_error((ScrError *)${arg(0)}, ${arg(1)}, ${arg(2)})`);
          case "insp.dyn":
            return finish(`scr_insp_dyn(${arg(0)}, ${arg(1)}, ${arg(2)})`);
          case "insp.dynS":
            return finish(`scr_insp_dyn_s(${arg(0)}, ${arg(1)})`);
          case "insp.jsval":
            return finish(`scr_insp_jsval(${arg(0)}, ${arg(1)}, ${arg(2)})`);
          case "insp.begin":
            return finish(`scr_insp_begin(${arg(0)})`);
          // Circular references over cycle-capable composites: check/push/
          // wrap drive Node's seen/circular machinery (scr_inspect.c).
          case "insp.circCheck":
            return finish(`scr_insp_circ_check(${arg(0)})`);
          case "insp.seenPush":
            return finish(`scr_insp_seen_push(${arg(0)})`);
          case "insp.refWrap":
            return finish(`scr_insp_ref_wrap(${arg(0)}, ${arg(1)})`);
          case "insp.circular":
            return finish(`scr_insp_circular(${arg(0)})`);
          case "insp.entry":
            return finish(`scr_insp_entry(${arg(0)}, ${arg(1)})`);
          case "insp.key":
            return finish(`scr_insp_key(${arg(0)})`);
          case "insp.moreItems":
            return finish(`scr_insp_more_items(${arg(0)})`);
          case "insp.end":
            return finish(`scr_insp_end(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)}, ${arg(4)}, ${arg(5)})`);
          // node:readline (scr_readline.c, the events gate): an OPEN
          // interface is a stdin consumer — the loop must run.
          case "rl.create":
            E.usesTimers = true;
            return finish(`scr_rl_create()`);
          case "rl.question": {
            E.usesTimers = true;
            const cbT = e.args[2]!.type;
            if (cbT.kind !== "func") throw new Error("emitter bug: rl.question callback not a func");
            const cb = args[2]!;
            E.moveTemp(cb);
            const adapter =
              cbT.params.length === 0 ? "scr_rl_answer_thunk0" : "scr_rl_answer_thunk_str";
            // Throws Node's use-after-close error; the pending check comes
            // from the may-throw seed.
            E.line(`scr_rl_question(${arg(0)}, ${arg(1)}, ${cb.name}, &${adapter});${E.srcComment(e.loc)}`);
            E.emitPendingCheck();
            return { name: "", type: e.type };
          }
          case "rl.close":
            return finish(`scr_rl_close(${arg(0)})`);
          case "rl.onClose": {
            E.usesTimers = true;
            const cb = args[1]!;
            E.moveTemp(cb);
            E.line(`scr_rl_on_close(${arg(0)}, ${cb.name});${E.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          // The StringDecoder trio (scr_bytes.c): pure functions over the
          // canonical encoding name + packed-f64 pending state; never
          // throw.
          case "strdec.write":
            return finish(`scr_strdec_write(${arg(0)}, ${arg(1)}, ${arg(2)})`);
          case "strdec.next":
            return finish(`scr_strdec_next(${arg(0)}, ${arg(1)}, ${arg(2)})`);
          case "strdec.end":
            return finish(`scr_strdec_end(${arg(0)}, ${arg(1)})`);
          // The Number statics (scr_lib.c): pure f64 → bool, never throw.
          case "number.isFinite":
            return finish(`scr_num_is_finite(${arg(0)})`);
          case "number.isNaN":
            return finish(`scr_num_is_nan(${arg(0)})`);
          case "number.isInteger":
            return finish(`scr_num_is_integer(${arg(0)})`);
          case "number.isSafeInteger":
            return finish(`scr_num_is_safe_integer(${arg(0)})`);
          case "date.now":
            // Node's integer milliseconds since epoch. Never throws.
            return finish(`scr_date_now()`);
          case "date.toISOString":
            // +1 string, or Node's "Invalid time value" RangeError
            // (may-throw seed set).
            return finish(`scr_date_to_iso(${arg(0)})`);
          case "date.parseGetTime":
            // The bounded date-string parse (X509 validity + ECMA format);
            // NaN elsewhere. Never throws.
            return finish(`scr_date_parse_get_time(${arg(0)})`);
          case "date.utc":
            // MakeDay/MakeTime/TimeClip over seven completed number
            // arguments; NaN outside the time range. Never throws.
            return finish(
              `scr_date_utc(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)}, ${arg(4)}, ${arg(5)}, ${arg(6)})`,
            );
          case "text.decode":
            // WHATWG utf-8 decode with the leading BOM stripped
            // (scr_bytes.c). Borrowed bytes; +1 string; never throws.
            return finish(`scr_text_decode(${arg(0)})`);
          // The fs option forms (scr_lib.c) — all in the may-throw seed,
          // like the rest of sync fs.
          case "fs.mkdirRecursiveSync":
            return finish(`scr_fs_mkdir_recursive(${arg(0)})`);
          case "fs.rmOptsSync":
            return finish(`scr_fs_rm_opts(${arg(0)}, ${arg(1)}, ${arg(2)})`);
          case "fs.rmRetrySync":
            return finish(`scr_fs_rm_opts_retry(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)}, ${arg(4)})`);
          case "fs.mkdtempSync":
            return finish(`scr_fs_mkdtemp(${arg(0)})`);
          case "fs.accessSync":
            return finish(`scr_fs_access(${arg(0)}, ${arg(1)})`);
          // The wider sync fs slice (scr_lib.c): syscall wrappers with
          // Node's errno message shapes, `.code` stamped like the rest.
          case "fs.unlinkSync":
            return finish(`scr_fs_unlink(${arg(0)})`);
          case "fs.chmodSync":
            return finish(`scr_fs_chmod(${arg(0)}, ${arg(1)})`);
          case "fs.chownSync":
            return finish(`scr_fs_chown(${arg(0)}, ${arg(1)}, ${arg(2)})`);
          case "fs.copyFileSync":
            return finish(`scr_fs_copyfile(${arg(0)}, ${arg(1)})`);
          case "fs.lstatSync":
            return finish(`scr_fs_lstat(${arg(0)})`);
          case "fs.writeFileModeSync":
            return finish(`scr_fs_write_file_mode(${arg(0)}, ${arg(1)}, ${arg(2)})`);
          case "fs.mkdirModeSync":
            return finish(`scr_fs_mkdir_mode(${arg(0)}, ${arg(1)})`);
          case "fs.mkdirRecursiveModeSync":
            return finish(`scr_fs_mkdir_recursive_mode(${arg(0)}, ${arg(1)})`);
          // Atomics.wait — the synchronous-sleep idiom (scr_lib.c): a
          // real nanosleep; +1 string result; never throws.
          case "atomics.wait":
            return finish(`scr_atomics_wait(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)})`);
          case "fs.readFdSync":
            // args[1] is the (always-"utf8") encoding: evaluated for
            // JS-exact side-effect order, ignored by the runtime.
            return finish(`scr_fs_read_fd(${arg(0)})`);
          case "fs.readFdSyncBytes":
            return finish(`scr_fs_read_fd_bytes(${arg(0)})`);
          case "process.isTTY":
            return finish(`scr_process_is_tty(${arg(0)})`);
          case "process.columns": {
            // ioctl(TIOCGWINSZ): a non-negative width wraps the f64 arm;
            // a non-TTY stream (or an ioctl refusal) comes back negative
            // and yields the interned undefined-arm instance — Node's
            // missing `.columns`. Type-directed union construction, like
            // process.envGet.
            if (e.type.kind !== "union") {
              throw new Error("emitter bug: process.columns result is not a union");
            }
            const def = E.unionsById.get(e.type.unionId);
            const f64Tag = def ? def.arms.findIndex((a) => a.kind === "f64") : -1;
            const undefTag = E.undefinedArmTag(e.type);
            if (f64Tag < 0 || undefTag < 0) {
              throw new Error("emitter bug: process.columns union lacks its arms");
            }
            const w = E.newTemp(F64, `scr_process_columns(${arg(0)})`);
            const present = `scr_union_new_f64(${f64Tag}, ${w.name})`;
            const absent = E.unitInstanceRef(e.type.unionId, undefTag);
            return E.newTemp(e.type, `${w.name} >= 0 ? ${present} : ${absent}`);
          }
          case "string.fromCharCode":
            // One packed f64[] (the frontend built it) or one bytes value
            // (the spread-typed-array form); +1 string.
            return finish(
              e.args[0]!.type.kind === "bytes"
                ? `scr_str_from_char_code_bytes(${arg(0)})`
                : `scr_str_from_char_code(${arg(0)})`,
            );
          case "string.lastIndexOf":
            return finish(`scr_str_last_index_of(${arg(0)}, ${arg(1)})`);
          case "string.raw":
            // Raw literals + pre-stringified substitutions; +1 string.
            return finish(`scr_str_raw(${arg(0)}, ${arg(1)})`);
          case "process.stdinDestroy":
            // A deliberate no-op (SEMANTICS.md).
            return finish(`scr_process_stdin_destroy()`);
          case "process.stdinSetRawMode":
            // TTY: termios raw mode (libuv's UV_TTY_MODE_RAW set). Non-TTY:
            // Node's exact catchable TypeError (the may-throw seed).
            return finish(`scr_process_stdin_set_raw_mode(${arg(0)})`);
          case "class.name":
            // `X.name` through a class value: the class object's stored
            // .name string (+1 — a no-op retain on the interned immortal).
            return finish(`scr_classobj_name(${arg(0)})`);
          default: {
            const _exhaustive: never = fn;
            void _exhaustive;
            throw new Error("unreachable");
          }
        }
      }
      case "jsonStringify": {
        // Type-directed serialization: the STATIC type picks an emitted
        // serializer (interned per type) — no dyn, no runtime dispatch. The
        // value temp is BORROWED (released with this statement's frame);
        // the result string is owned (+1). Throws only over CYCLE-CAPABLE
        // types (recursive records — the circular-structure TypeError) and
        // dyn roots; everything else keeps the throw-free path.
        const v = E.emitExpr(e.value);
        // A dyn root: the runtime's dyn walker (scr_dyn_format_j — the %j
        // serializer IS JSON.stringify over the checked-dynamic tree: number/string/bool/
        // null/array/object exact, dropped members omitted, a dropped ROOT
        // becomes the text "undefined", a runtime handle inside the tree
        // throws) — fallible, so the pending-exception check runs.
        const compact =
          e.value.type.kind === "dyn"
            ? E.fallibleTemp(e.type, `scr_dyn_format_j(${v.name})`)
            : (() => {
                const helper = E.jsonWriteHelper(e.value.type);
                const buf = `sc_t${E.tempCounter++}`;
                E.line(`ScrJsonBuf ${buf}; scr_jb_init(&${buf});${E.srcComment(e.loc)}`);
                E.line(`${helper}(&${buf}, ${v.name});`);
                const t = E.newTemp(e.type, `scr_jb_finish(&${buf})`);
                // A cycle-capable root can throw the circular-structure
                // TypeError mid-walk: finish still runs (frees the buffer,
                // the partial string joins the frame and releases on
                // unwind), then the pending check unwinds.
                if (E.traceAdapterC(e.value.type) !== null) E.emitPendingCheck();
                return t;
              })();
        // A pretty-print form (`stringify(v, null, 2)`): the frontend
        // resolved the space to a compile-time indent string (Node's
        // clamp/truncate rules) riding as an extra property; the interned
        // re-indenter rewrites the compact text with Node's gap algorithm.
        // Compact temp stays frame-owned; the pretty string is a fresh +1.
        const indent = (e as { indent?: string }).indent;
        if (!indent) return compact;
        const bytes = Buffer.from(indent, "utf8");
        return E.newTemp(
          e.type,
          `${E.jsonIndentHelper()}(${compact.name}, ${cStringLiteral(bytes)}, ${bytes.length})`,
        );
      }
      case "dynCheck": {
        // The dynamic boundary: validate the checked-dynamic tree against the target type
        // and BUILD the typed value (+1) — or throw a catchable
        // TypeError-shaped, path-annotated string. The dyn temp is BORROWED;
        // the result joins the frame BEFORE the pending check so an unwind
        // releases the dummy (NULL for refcounted targets) harmlessly.
        const dyn = E.emitExpr(e.value);
        const helper = E.dynCheckHelper(e.type);
        return E.fallibleTemp(e.type, `${helper}(${dyn.name}, NULL)`);
      }
      case "yieldExpr": {
        // Park the operand in the generator's OUT slot (moved in, typed by
        // the function's yield channel) and switch back to the resumer.
        // Control returns at the next resume — possibly with an injected
        // .throw payload or the GENRET sentinel pending, hence the check.
        // The result is the .next(v) argument, moved out of the IN slot.
        const gen = E.currentGenerator;
        if (!gen) throw new Error("emitter bug: yieldExpr outside a generator body");
        if (e.value === null) throw new Error("emitter bug: yieldExpr with no operand (frontend fills undefined)");
        const v = E.emitExpr(e.value);
        const yt = e.value.type;
        if (yt.kind === "f64") {
          E.line(`scr_gen_yield_f64(${v.name});${E.srcComment(e.loc)}`);
        } else if (yt.kind === "bool") {
          E.line(`scr_gen_yield_bool(${v.name});${E.srcComment(e.loc)}`);
        } else {
          E.moveTemp(v); // the OUT slot takes ownership
          E.line(`scr_gen_yield_ref(${v.name}, ${vAdapters(yt).release});${E.srcComment(e.loc)}`);
        }
        E.emitPendingCheck();
        switch (e.type.kind) {
          case "void":
            // An undefined next-channel: nothing to read (the frontend
            // fences value-position yields on this channel).
            return { name: "", type: e.type };
          case "f64":
            return E.newTemp(e.type, `scr_gen_take_in_f64()`);
          case "bool":
            return E.newTemp(e.type, `scr_gen_take_in_bool()`);
          default:
            // Refcounted channels (dyn included): the slot's +1 moves out.
            return E.newTemp(e.type, `(${cType(e.type).trim()})scr_gen_take_in_ref()`);
        }
      }
      case "genResume": {
        // One consumer resume: park the sent value (typed per mode), hop
        // into the fiber, propagate a body exception (pending check), and
        // build the IteratorResult record through the interned helper.
        const genT = e.gen.type;
        if (genT.kind !== "generator") throw new Error("emitter bug: genResume on a non-generator");
        if (e.type.kind !== "record") throw new Error("emitter bug: genResume result is not a record");
        const g = E.emitExpr(e.gen); // borrowed for the calls below
        const sendArg = (store: (a: Temp) => string): void => {
          const a = E.emitExpr(e.arg!);
          if (isRefCounted(e.arg!.type)) E.moveTemp(a); // the slot takes ownership
          E.line(store(a));
        };
        if (e.mode === "next") {
          if (e.arg === null) {
            // Valueless resume: dyn channels read JS's undefined; unit
            // channels have nothing to read.
            if (genT.nextT.kind === "dyn") {
              E.line(`scr_gen_in_ref(${g.name}, scr_dyn_retain(scr_dyn_undefined()), scr_dyn_release_v);${E.srcComment(e.loc)}`);
            } else {
              E.line(`scr_gen_in_none(${g.name});${E.srcComment(e.loc)}`);
            }
          } else {
            const nt = e.arg.type;
            sendArg((a) =>
              nt.kind === "f64" ? `scr_gen_in_f64(${g.name}, ${a.name});${E.srcComment(e.loc)}`
              : nt.kind === "bool" ? `scr_gen_in_bool(${g.name}, ${a.name});${E.srcComment(e.loc)}`
              : `scr_gen_in_ref(${g.name}, ${a.name}, ${vAdapters(nt).release});${E.srcComment(e.loc)}`);
          }
          E.line(`scr_gen_resume(${g.name});`);
        } else if (e.mode === "return") {
          if (e.arg === null) {
            E.line(`scr_gen_ret_none(${g.name});${E.srcComment(e.loc)}`);
          } else {
            const rt = e.arg.type;
            sendArg((a) =>
              rt.kind === "f64" ? `scr_gen_ret_f64(${g.name}, ${a.name});${E.srcComment(e.loc)}`
              : rt.kind === "bool" ? `scr_gen_ret_bool(${g.name}, ${a.name});${E.srcComment(e.loc)}`
              : `scr_gen_ret_ref(${g.name}, ${a.name}, ${vAdapters(rt).release});${E.srcComment(e.loc)}`);
          }
          E.line(`scr_gen_resume_return(${g.name});`);
        } else {
          // .throw(e): park the payload in the CALLER's cell (the throw
          // statement's exact kind dispatch), then resume — the runtime
          // moves it into the fiber, or leaves it pending (non-suspended
          // generators: the .throw call itself throws at the check below).
          if (e.arg === null) throw new Error("emitter bug: genResume throw with no payload");
          const a = E.emitExpr(e.arg);
          const t = e.arg.type;
          if (isRefCounted(t)) E.moveTemp(a); // the cell takes ownership
          if (t.kind === "f64") {
            E.line(`scr_throw_f64(${a.name});${E.srcComment(e.loc)}`);
          } else if (t.kind === "bool") {
            E.line(`scr_throw_bool(${a.name});${E.srcComment(e.loc)}`);
          } else if (t.kind === "string") {
            E.line(`scr_throw_str(${a.name});${E.srcComment(e.loc)}`);
          } else if (t.kind === "object" && E.classMeta.get(t.className)?.hierarchy) {
            const rc = vAdapters(t);
            E.line(`scr_throw_obj(${a.name}, &${rc.retain}, &${rc.release}, ${E.traceArgC(t)});${E.srcComment(e.loc)}`);
          } else {
            const rc = vAdapters(t);
            E.line(`scr_throw_ref(${a.name}, &${rc.retain}, &${rc.release}, ${E.traceArgC(t)});${E.srcComment(e.loc)}`);
          }
          E.line(`scr_gen_resume_throw(${g.name});`);
        }
        const helper = genResultThunkFor(E, genT, e.type);
        // The record builds before the check so an unwind (a propagated
        // body exception) releases it as the frame's never-read dummy.
        return E.fallibleTemp(e.type, `${helper}(${g.name})`);
      }
      case "awaitExpr": {
        // Parks the fiber until the promise settles; rejected promises
        // re-throw here (hence the pending check). Promise temp borrowed;
        // refcounted results arrive +1 and join the frame pre-check so an
        // unwind releases the dummy (NULL) harmlessly.
        const pr = E.emitExpr(e.value);
        let read: string;
        switch (e.type.kind) {
          case "f64":
            read = `scr_await_f64(${pr.name})`;
            break;
          case "bool":
            read = `scr_await_bool(${pr.name})`;
            break;
          case "string":
            read = `scr_await_str(${pr.name})`;
            break;
          case "void": {
            E.line(`scr_await_void(${pr.name});${E.srcComment(e.loc)}`);
            E.emitPendingCheck();
            return { name: "", type: e.type };
          }
          case "dyn":
            // The checked-dynamic tree-crossing await: void fulfillments (a boxed
            // promise<void> that skipped its adapter) answer the
            // undefined VALUE, never NULL.
            read = `scr_await_dyn(${pr.name})`;
            break;
          default:
            read = `(${cType(e.type).trim()})scr_await_ref(${pr.name})`;
        }
        return E.fallibleTemp(e.type, read);
      }
      case "awaitUnionExpr": {
        // Await of a promise-or-absent union: the promise arm awaits like
        // awaitExpr (parks, re-throws rejections); a unit arm takes exactly
        // one microtask hop (JS: await of a non-thenable) and yields
        // itself. The union temp is borrowed; a value-carrying result joins
        // the frame BEFORE the pending check so an unwind releases the
        // dummy (a union box holding the never-read NULL payload, or NULL)
        // harmlessly.
        if (e.value.type.kind !== "union") {
          throw new Error("emitter bug: awaitUnion of a non-union");
        }
        const def = E.unionsById.get(e.value.type.unionId);
        const promiseArm = def?.arms[e.promiseTag];
        if (!def || promiseArm?.kind !== "promise") {
          throw new Error("emitter bug: awaitUnion arm is not a promise");
        }
        const inner = promiseArm.inner;
        const u = E.emitExpr(e.value);
        const peek = `(ScrPromise *)scr_union_peek(${u.name})`;
        if (e.type.kind === "void") {
          E.line(
            `if (${u.name}->tag == ${e.promiseTag}) scr_await_void(${peek}); else scr_await_hop();${E.srcComment(e.loc)}`,
          );
          E.emitPendingCheck();
          return { name: "", type: e.type };
        }
        if (e.type.kind !== "union") {
          throw new Error("emitter bug: awaitUnion result is neither void nor a union");
        }
        const resDef = E.unionsById.get(e.type.unionId);
        if (!resDef) throw new Error("emitter bug: awaitUnion result union unknown");
        const resTagOf = (arm: (typeof resDef.arms)[number]): number => {
          const tag = resDef.arms.findIndex((a) => typeEquals(a, arm));
          if (tag < 0) throw new Error("emitter bug: awaitUnion result arm missing");
          return tag;
        };
        const innerTag = resTagOf(inner);
        const name = `sc_t${E.tempCounter++}`;
        E.line(`${cDecl(e.type, name)} = NULL;${E.srcComment(e.loc)}`);
        E.currentFrame().push({ name, type: e.type });
        E.line(`if (${u.name}->tag == ${e.promiseTag}) {`);
        E.indent++;
        let wrap: string;
        switch (inner.kind) {
          case "f64":
            wrap = `scr_union_new_f64(${innerTag}, scr_await_f64(${peek}))`;
            break;
          case "bool":
            wrap = `scr_union_new_bool(${innerTag}, scr_await_bool(${peek}))`;
            break;
          case "string":
            wrap = `scr_union_new_ref(${innerTag}, scr_await_str(${peek}), scr_str_retain_v, scr_str_release_v, NULL)`;
            break;
          default: {
            const v = vAdapters(inner);
            wrap = `scr_union_new_ref(${innerTag}, scr_await_ref(${peek}), ${v.retain}, ${v.release}, ${E.traceArgC(inner)})`;
          }
        }
        E.line(`${name} = ${wrap};`);
        E.indent--;
        E.line(`} else {`);
        E.indent++;
        E.line(`scr_await_hop();`);
        const unitTags = def.arms.flatMap((a, i) => (isUnitType(a) ? [i] : []));
        if (unitTags.length === 1) {
          E.line(`${name} = ${E.unitInstanceRef(e.type.unionId, resTagOf(def.arms[unitTags[0]!]!))};`);
        } else {
          E.line(`switch (${u.name}->tag) {`);
          for (const t of unitTags) {
            E.line(`case ${t}: ${name} = ${E.unitInstanceRef(e.type.unionId, resTagOf(def.arms[t]!))}; break;`);
          }
          E.line(`default: break;`);
          E.line(`}`);
        }
        E.indent--;
        E.line(`}`);
        E.emitPendingCheck();
        return { name, type: e.type };
      }
      case "newPromise": {
        // Pending promise + resolve closure, executor run synchronously
        // (its throw rejects — handled inside the runtime helper, so no
        // pending check here). Executor/resolve temps are frame-owned.
        if (e.type.kind !== "promise") throw new Error("emitter bug: newPromise type");
        const inner = e.type.inner;
        const p = E.newTemp(e.type, `scr_promise_new()`);
        // Zero-param executor: no resolve exists — a forever-pending
        // promise unless the executor throws (which rejects it).
        if (e.executor.type.kind === "func" && e.executor.type.params.length === 0) {
          const exec0 = E.emitExpr(e.executor);
          E.line(
            `scr_promise_run_executor0(${p.name}, ${exec0.name});${E.srcComment(e.loc)}`,
          );
          return p;
        }
        let mk: string;
        switch (inner.kind) {
          case "f64":
            mk = `scr_make_resolve(${p.name}, 0)`;
            break;
          case "bool":
            mk = `scr_make_resolve(${p.name}, 1)`;
            break;
          case "string":
            mk = `scr_make_resolve(${p.name}, 2)`;
            break;
          case "void":
            mk = `scr_make_resolve(${p.name}, 3)`;
            break;
          default:
            mk = `scr_make_resolve_fn(${p.name}, (void *)&${E.resolveThunkFor(inner)})`;
        }
        const resolve = E.newTemp(
          { kind: "func", params: inner.kind === "void" ? [] : [inner], ret: { kind: "void" } },
          mk,
        );
        // Two-param executor: reject is a runtime-provided closure rejecting
        // the promise with its Error reason (OBJ payload — catch instanceof
        // and the uncaught printer see exactly a thrown Error). First settle
        // wins in the runtime; both closures' +1 move into the call.
        if (e.executor.type.kind === "func" && e.executor.type.params.length === 2) {
          const reject = E.newTemp(
            { kind: "func", params: [{ kind: "object", className: "%Error" }], ret: { kind: "void" } },
            `scr_make_reject(${p.name})`,
          );
          const exec2 = E.emitExpr(e.executor);
          E.moveTemp(resolve);
          E.moveTemp(reject);
          E.line(
            `scr_promise_run_executor2(${p.name}, ${exec2.name}, ${resolve.name}, ${reject.name});${E.srcComment(e.loc)}`,
          );
          return p;
        }
        const exec = E.emitExpr(e.executor);
        // The executor is a compiled closure and OWNS its params (it
        // releases them on exit) — resolve's +1 moves into the call. The
        // executor closure itself is borrowed (frame-released here).
        E.moveTemp(resolve);
        E.line(
          `scr_promise_run_executor(${p.name}, ${exec.name}, ${resolve.name});${E.srcComment(e.loc)}`,
        );
        return p;
      }
      case "promiseWithResolvers": {
        // The newPromise pieces without an executor: a pending promise,
        // its runtime resolve closure (typed per the inner kind), and
        // the reject closure, written into the fresh record. Closure +1s
        // move into the record's fields; never throws.
        if (e.type.kind !== "record") throw new Error("emitter bug: promiseWithResolvers type");
        const shape = E.recordsById.get(e.type.shapeId);
        const promT = shape?.fields.find((f) => f.name === "promise")?.type;
        const resolveT = shape?.fields.find((f) => f.name === "resolve")?.type;
        const rejectT = shape?.fields.find((f) => f.name === "reject")?.type;
        if (!shape || promT?.kind !== "promise" || !resolveT || !rejectT) {
          throw new Error("emitter bug: promiseWithResolvers record shape");
        }
        const inner = promT.inner;
        const p = E.newTemp(promT, `scr_promise_new()`);
        let mk: string;
        switch (inner.kind) {
          case "f64":
            mk = `scr_make_resolve(${p.name}, 0)`;
            break;
          case "bool":
            mk = `scr_make_resolve(${p.name}, 1)`;
            break;
          case "string":
            mk = `scr_make_resolve(${p.name}, 2)`;
            break;
          case "void":
            mk = `scr_make_resolve(${p.name}, 3)`;
            break;
          default:
            mk = `scr_make_resolve_fn(${p.name}, (void *)&${E.resolveThunkFor(inner)})`;
        }
        const resolve = E.newTemp(resolveT, mk);
        const reject = E.newTemp(rejectT, `scr_make_reject(${p.name})`);
        const rec = E.newTemp(e.type, `${mangleRecordNew(e.type.shapeId)}()`);
        // The promise's +1 moves into the record; the record's own read
        // of it at the call site retains per field access as usual.
        E.moveTemp(p);
        E.moveTemp(resolve);
        E.moveTemp(reject);
        E.line(`${rec.name}->${mangleField("promise")} = ${p.name};`);
        E.line(`${rec.name}->${mangleField("resolve")} = ${resolve.name};`);
        E.line(`${rec.name}->${mangleField("reject")} = ${reject.name};`);
        return rec;
      }
      case "jsMarshal": {
        // Static → island (--dynamic only). Primitives by value; JSON-safe
        // composites deep-copy through the emitted type-directed serializer
        // and the engine's JSON parser (documented aliasing divergence).
        // Operand borrowed; result +1. from_json cannot fail on this
        // machine-produced JSON but reports engine surprises via NULL +
        // pending — check like a may-throw so the dummy unwinds cleanly.
        const v = E.emitExpr(e.value);
        switch (e.value.type.kind) {
          case "f64":
            return E.newTemp(e.type, `scr_jsval_from_f64(${v.name})`);
          case "bool":
            return E.newTemp(e.type, `scr_jsval_from_bool(${v.name})`);
          case "string":
            return E.newTemp(e.type, `scr_jsval_from_str(${v.name})`);
          case "dyn":
            // A CHECKED-DYNAMIC (dyn) value entering the island: deep
            // copy, data kinds only — boxed functions/handles/promises
            // throw the catchable TypeError in the runtime.
            return E.fallibleTemp(e.type, `scr_jsval_from_dyn(${v.name})`);
          case "bytes":
            // A typed array crossing IN: an engine typed array of the same
            // element kind — a COPY (the boundary's copy stance).
            return E.fallibleTemp(e.type, `scr_jsval_from_bytes(${v.name})`);
          case "url":
            // A URL crossing IN: an engine URL instance built from href.
            return E.fallibleTemp(e.type, `scr_jsval_from_url(${v.name})`);
          case "promise": {
            // A STATIC promise crossing IN: a real engine thenable
            // settled when the scriptc promise settles (the async-
            // callback return bridge). from_promise takes ownership of a
            // +1 — retain past the borrowed frame temp.
            const tag = islandPromisePayloadTag(e.value.type.inner);
            if (!tag) throw new Error("emitter bug: jsMarshal of a promise outside the bridge payload domain");
            const tagC = {
              void: "SCR_ISLP_VOID", f64: "SCR_ISLP_F64", bool: "SCR_ISLP_BOOL",
              string: "SCR_ISLP_STR", jsval: "SCR_ISLP_JSVAL", jsvalArr: "SCR_ISLP_JSVAL_ARR",
            }[tag];
            return E.fallibleTemp(e.type, `scr_jsval_from_promise(scr_promise_retain(${v.name}), ${tagC})`);
          }
          case "func": {
            // A closure entering the island as a host function (the
            // package-callback pattern). from_closure retains the closure;
            // the engine's finalizer releases it at teardown — which runs
            // before the RC audit. The per-signature adapter gives the
            // runtime one uniform call shape over the closure ABI: the
            // interned (arity, return) adapters for the all-'any' shape,
            // or a typed adapter converting each incoming argument to the
            // param's static type through the exit machinery.
            const fn = e.value.type;
            const adapter = canMarshalFuncIntoIsland(fn)
              ? E.islandAdapter(
                  fn.params.length,
                  fn.ret.kind as "void" | "jsval" | "f64" | "bool" | "string",
                )
              : E.islandTypedAdapter(fn);
            // ISLAND-REST closures encode a NEGATIVE arity: the wrapper
            // pads the leading declared params and hands the trailing
            // slot the ENGINE array of the surplus arguments.
            const arity = fn.rest === true && fn.restAbi === "jsval" ? -fn.params.length : fn.params.length;
            return E.newTemp(
              e.type,
              `scr_jsval_from_closure(${v.name}, ${arity}, ${adapter})`,
            );
          }
          default: {
            const helper = E.jsonWriteHelper(e.value.type);
            const buf = `sc_t${E.tempCounter++}`;
            E.line(`ScrJsonBuf ${buf}; scr_jb_init(&${buf});${E.srcComment(e.loc)}`);
            E.line(`${helper}(&${buf}, ${v.name});`);
            const json = E.newTemp(STRING, `scr_jb_finish(&${buf})`);
            return E.fallibleTemp(e.type, `scr_jsval_from_json(${json.name})`);
          }
        }
      }
      case "jsOp": {
        // Island operation: JS semantics via the engine (prelude helper
        // closures), never C reimplementations. jsval args are borrowed
        // frame temps; jsval/string results +1. Engine exceptions bridge
        // into the cell — pending checks after every fallible op.
        const args = e.args.map((a) => E.emitExpr(a));
        const a = (i: number) => args[i]!.name;
        const nameSym = () => `(ScrStr *)&${E.internLiteral(e.name!)}`;
        const finishFallible = (call: string): Temp => E.fallibleTemp(e.type, call);
        const argPack = (list: string[]): string => {
          if (list.length === 0) return "NULL";
          const arr = `sc_t${E.tempCounter++}`;
          E.line(`ScrJsval *${arr}[] = { ${list.join(", ")} };`);
          return arr;
        };
        switch (e.op) {
          case "add": case "sub": case "mul": case "div": case "mod": case "pow": {
            const c = `SCR_JSOP_${e.op.toUpperCase()}`;
            return finishFallible(`scr_jsval_binop(${c}, ${a(0)}, ${a(1)})`);
          }
          case "lt": case "le": case "gt": case "ge": case "eq": case "neq": {
            const c = `SCR_JSOP_${e.op.toUpperCase()}`;
            return finishFallible(`(scr_jsval_cmp(${c}, ${a(0)}, ${a(1)}) == 1)`);
          }
          case "instanceOf":
            return finishFallible(`(scr_jsval_instance_of(${a(0)}, ${a(1)}) == 1)`);
          case "neg":
            return finishFallible(`scr_jsval_neg(${a(0)})`);
          case "plus":
            return finishFallible(`scr_jsval_plus(${a(0)})`);
          case "truthy":
            return E.newTemp(e.type, `(scr_jsval_truthy(${a(0)}) != 0)`);
          case "not":
            return E.newTemp(e.type, `(scr_jsval_truthy(${a(0)}) == 0)`);
          case "typeof":
            return E.newTemp(e.type, `scr_jsval_typeof(${a(0)})`);
          case "toStr":
            return finishFallible(`scr_jsval_to_str(${a(0)})`);
          case "getProp":
            return finishFallible(`scr_jsval_get_prop(${a(0)}, ${nameSym()})`);
          case "globalGet":
            return finishFallible(`scr_jsval_global_get(${nameSym()})`);
          case "setProp":
            E.line(`scr_jsval_set_prop(${a(0)}, ${nameSym()}, ${a(1)});${E.srcComment(e.loc)}`);
            E.emitPendingCheck();
            return { name: "", type: e.type };
          case "getIdx":
            return finishFallible(`scr_jsval_get_idx(${a(0)}, ${a(1)})`);
          case "iterNew":
            return finishFallible(`scr_jsval_iter_new(${a(0)})`);
          case "setIdx":
            E.line(`scr_jsval_set_idx(${a(0)}, ${a(1)}, ${a(2)});${E.srcComment(e.loc)}`);
            E.emitPendingCheck();
            return { name: "", type: e.type };
          case "optCallMethod": {
            const pack = argPack(args.slice(1).map((x) => x.name));
            return finishFallible(
              `scr_jsval_opt_call_method(${a(0)}, ${nameSym()}, ${args.length - 1}, ${pack})`,
            );
          }
          case "callMethod": {
            const pack = argPack(args.slice(1).map((x) => x.name));
            return finishFallible(
              `scr_jsval_call_method(${a(0)}, ${nameSym()}, ${args.length - 1}, ${pack})`,
            );
          }
          case "callFn": {
            const pack = argPack(args.slice(1).map((x) => x.name));
            return finishFallible(`scr_jsval_call(${a(0)}, ${args.length - 1}, ${pack})`);
          }
          case "callSpread":
            // Spread application (`f(...pre, ...s)`): the prelude helper's
            // real spread syntax — iterator protocols are the engine's
            // own, the guards front-run V8's spread-call TypeError texts
            // (the name literal is the spread expression's spelling).
            return finishFallible(`scr_jsval_call_spread(${a(0)}, ${a(1)}, ${a(2)}, ${nameSym()})`);
          case "construct": {
            // `new X(...)` on an island callee: JS_CallConstructor.
            const pack = argPack(args.slice(1).map((x) => x.name));
            return finishFallible(`scr_jsval_construct(${a(0)}, ${args.length - 1}, ${pack})`);
          }
          case "objLit": {
            const pack = argPack(args.map((x) => x.name));
            return E.newTemp(e.type, `scr_jsval_obj_lit(${args.length / 2}, ${pack})`);
          }
          case "tplStrings": {
            const pack = argPack(args.map((x) => x.name));
            return E.newTemp(e.type, `scr_jsval_tpl_strings(${args.length / 2}, ${pack})`);
          }
          case "objSpread":
            // Spread completion: engine CopyDataProperties (getters can
            // throw — fallible); answers the target (+1).
            return finishFallible(`scr_jsval_obj_spread(${a(0)}, ${a(1)})`);
          case "defineGetter":
            // Getter completion for an island literal: defines key (a(1))
            // on obj (a(0)) as an engine getter invoking a(2); answers the
            // object (+1) for chaining.
            return E.newTemp(e.type, `scr_jsval_define_getter(${a(0)}, ${a(1)}, ${a(2)})`);
          case "arrLit": {
            const pack = argPack(args.map((x) => x.name));
            return E.newTemp(e.type, `scr_jsval_arr_lit(${args.length}, ${pack})`);
          }
          case "undefLit":
            return E.newTemp(e.type, `scr_jsval_undefined()`);
          case "nullLit":
            return E.newTemp(e.type, `scr_jsval_null()`);
          default: {
            const _exhaustive: never = e;
            void _exhaustive;
            throw new Error("unreachable");
          }
        }
      }
      case "jsExit": {
        // Island → static validated exit. Primitives extract strictly (no
        // coercion — a non-number refuses to exit as number); composites
        // round-trip engine JSON.stringify → json.parse → the existing
        // dynCheck walker, inheriting its width tolerance and path-annotated
        // failures. Every step is a may-throw with the standard pending
        // discipline; intermediate temps are frame-owned.
        const v = E.emitExpr(e.value);
        switch (e.type.kind) {
          case "f64":
          case "bool": {
            const name = `sc_t${E.tempCounter++}`;
            const ctype = e.type.kind === "f64" ? "double" : "bool";
            const fn = e.type.kind === "f64" ? "scr_jsval_exit_f64" : "scr_jsval_exit_bool";
            E.line(`${ctype} ${name} = 0;${E.srcComment(e.loc)}`);
            E.line(`${fn}(${v.name}, &${name});`);
            E.emitPendingCheck();
            return { name, type: e.type };
          }
          case "string":
            return E.fallibleTemp(e.type, `scr_jsval_exit_str(${v.name})`);
          case "bytes":
            // Uint8Array exit: kind-checked, copied out (+1) — engine
            // Buffers pass (they ARE Uint8Arrays). The frontend only
            // emits u8 targets (canExitIslandToType).
            return E.fallibleTemp(e.type, `scr_jsval_exit_bytes(${v.name})`);
          default: {
            // `any[]`-declared slot: the engine array exits Array.isArray-
            // gated, elements BY REFERENCE (identity crosses; the spine is
            // a snapshot copy). JSON-safe element types keep the round
            // trip below.
            if (e.type.kind === "array" && e.type.elem.kind === "jsval") {
              return E.fallibleTemp(e.type, `scr_jsval_exit_jsval_arr(${v.name})`);
            }
            // An undefined-armed union target: the engine's undefined takes
            // the undefined arm FIRST — JSON cannot spell it (to_json would
            // refuse the exit) — then null and data ride the round trip
            // into the union's dynCheck like any composite (or, for the
            // `any[] | undefined` defaulted-parameter spelling, the
            // jsval-element array exit wrapped into the data arm).
            const undefTag = e.type.kind === "union" ? E.undefinedArmTag(e.type) : -1;
            if (e.type.kind === "union" && undefTag >= 0) {
              const name = `sc_t${E.tempCounter++}`;
              E.line(`${cDecl(e.type, name)};`);
              E.line(`if (scr_jsval_is_undefined(${v.name})) {`);
              E.indent++;
              E.line(`${name} = ${E.unitInstanceRef(e.type.unionId, undefTag)};`);
              E.indent--;
              E.line(`} else {`);
              E.indent++;
              E.frames.push([]);
              const unionDef = E.unionsById.get(e.type.unionId);
              const dataArms = unionDef ? unionDef.arms.flatMap((a, i) => (isUnitType(a) ? [] : [{ a, i }])) : [];
              const jsvalArr = dataArms.length === 1 && dataArms[0]!.a.kind === "array" && dataArms[0]!.a.elem.kind === "jsval" ? dataArms[0]! : null;
              if (jsvalArr) {
                // The `any[] | undefined` defaulted-parameter spelling:
                // the engine array exits BY REFERENCE into the data arm.
                const arr = E.fallibleTemp(jsvalArr.a, `scr_jsval_exit_jsval_arr(${v.name})`);
                E.moveTemp(arr);
                E.line(`${name} = scr_union_new_ref(${jsvalArr.i}, ${arr.name}, &scr_arr_retain_v, &scr_arr_release_v, NULL);`);
              } else {
                const json = E.fallibleTemp(STRING, `scr_jsval_to_json(${v.name})`);
                const dom = E.fallibleTemp(DYN, `scr_json_parse(${json.name})`);
                const out = E.fallibleTemp(e.type, `${E.dynCheckHelper(e.type)}(${dom.name}, NULL)`);
                E.moveTemp(out);
                E.line(`${name} = ${out.name};`);
              }
              E.releaseFrame(E.frames.pop()!);
              E.indent--;
              E.line(`}`);
              E.currentFrame().push({ name, type: e.type });
              return { name, type: e.type };
            }
            const json = E.fallibleTemp(STRING, `scr_jsval_to_json(${v.name})`);
            const dom = E.fallibleTemp(DYN, `scr_json_parse(${json.name})`);
            return E.fallibleTemp(e.type, `${E.dynCheckHelper(e.type)}(${dom.name}, NULL)`);
          }
        }
      }
      case "jsBridgePromise": {
        // Island → static promise bridge: a fresh pending ScrPromise the
        // engine promise settles (fulfillment = retained jsval cell or
        // void; rejection = the bridged reason). Operand borrowed; the +1
        // promise joins the frame. Fails only on an engine-level surprise
        // minting the subscription — pending check like other island ops.
        const v = E.emitExpr(e.value);
        const payload =
          e.type.kind === "promise" && e.type.inner.kind === "void"
            ? "SCR_ISLP_VOID"
            : e.type.kind === "promise" && e.type.inner.kind === "array" && e.type.inner.elem.kind === "jsval"
              ? "SCR_ISLP_JSVAL_ARR" // `any[]` fulfillment: the Array.isArray-gated by-reference exit at settle
              : "SCR_ISLP_JSVAL";
        return E.fallibleTemp(e.type, `scr_jsval_bridge_promise(${v.name}, ${payload})`);
      }
      default: {
        const _exhaustive: never = e;
        void _exhaustive;
        throw new Error("unreachable");
      }
    }
  }
