import { InternalCompilerError } from "../../errors.js";
/* Statement-level C emission: function bodies, blocks/scopes, the statement
 * dispatch (emitStmt), try/catch lowering, and switch — plus the small
 * branch/condition helpers they share with expression emission. All frame,
 * scope, and temp state lives on CEmitter; these functions drive it. */
import type { CEmitter, ScopeEntry } from "./c-emitter.js";
import type { IrFunction } from "../../ir/ir.js";
import { mangleField, mangleGlobal, mangleLocal, mangleRawParam } from "../mangle.js";
import { BOOL, CAUGHT, IrExpr, IrStmt, RUNTIME_ERROR_CLASSES, isRefCounted } from "../../ir/ir.js";
import { boxAccess, cDecl, cStringLiteral, elemAccess, vAdapters } from "./types.js";
import { OVERFLOW_MEMBER } from "./shapes.js";
import { emitBytesReceiver } from "./exprs.js";
import { matchIntegerBytesForLoop } from "../../ir/integer-loops.js";
import { endsWithJump, matchStringSelfConcat } from "../../ir/analysis.js";






export function emitFunction(emitter: CEmitter, fn: IrFunction): void {
    emitter.tempCounter = 0;
    emitter.frames = [];
    emitter.scopes = [];
    emitter.jumpTargets = [];
    emitter.tryStack = [];
    emitter.finallyStack = [];
    emitter.currentReturnType = fn.returnType;
    emitter.currentGenerator = fn.generator ?? null;
    emitter.labelCounter = 0;
    emitter.currentLocals = new Map(fn.locals.map((l) => [l.id, l]));
    emitter.captureIds = new Set((fn.captures ?? []).map((c) => c.localId));
    emitter.integerLoopBindings.clear();

    emitter.line(`${emitter.signature(fn)} {${emitter.srcComment(fn.loc)}`);
    emitter.indent++;

    // The pending-return slot: a `return` crossing a finally computes its
    // value FIRST (before the finally runs — snapshotting it here is what
    // makes finally mutations of returned locals invisible, Node-exact),
    // then jumps through every crossed finally; the last dispatch returns
    // the slot. Declared only when some return actually crosses a finally.
    if (fn.returnType.kind !== "void" && returnCrossesFinally(fn.body)) {
      const init = isRefCounted(fn.returnType) ? "NULL" : "0";
      emitter.line(`${cDecl(fn.returnType, "sc_pret")} = ${init}; /* pending return (through finally) */`);
    }

    // Captured bindings come in through the environment — borrowed for the
    // whole call (the closure owns them): bound here, never released here.
    (fn.captures ?? []).forEach((c, i) => {
      emitter.line(`ScrBox *${mangleLocal(c.localId)} = sc_env->caps[${i}]; /* captured ${c.name} */`);
    });

    const paramIds = new Set(fn.params.map((p) => p.localId));
    for (const local of fn.locals) {
      if (paramIds.has(local.id) || emitter.captureIds.has(local.id)) continue;
      if (local.boxed) {
        emitter.line(`ScrBox *${mangleLocal(local.id)} = NULL; /* ${local.name} (boxed) */`);
      } else {
        const init = isRefCounted(local.type) ? " = NULL" : "";
        emitter.line(`${cDecl(local.type, mangleLocal(local.id))}${init}; /* ${local.name} */`);
      }
    }

    // Function scope owns refcounted params (callees own their params).
    // Boxed params: allocate the shared binding and move the raw value in.
    const fnScope: ScopeEntry[] = [];
    for (const p of fn.params) {
      const local = emitter.currentLocals.get(p.localId)!;
      if (local.boxed) {
        const box = mangleLocal(p.localId);
        emitter.line(`ScrBox *${box} = ${emitter.boxNewC(p.type)}; /* ${p.name} (boxed param) */`);
        emitter.line(`scr_box_set_${boxAccess(p.type)}(${box}, ${mangleRawParam(p.localId)});`);
        fnScope.push({ name: box, type: p.type, boxed: true });
      } else if (isRefCounted(p.type)) {
        fnScope.push({ name: mangleLocal(p.localId), type: p.type });
      }
    }
    emitter.scopes.push(fnScope);
    emitter.emitStmts(fn.body);
    // Implicit exit of a void function: release function-scope refcounted
    // locals (unless the body already ended in an explicit return or a
    // throw, whose unwind released everything down to depth 0).
    const last = fn.body[fn.body.length - 1]?.kind;
    const endedWithReturn = last === "return" || last === "throw" || last === "rethrow" || last === "runtimeFence";
    if (fn.returnType.kind === "void" && !endedWithReturn) {
      emitter.releaseFrame(emitter.scopes[0]!);
    }
    emitter.scopes.pop();

    emitter.indent--;
    emitter.line(`}`);
    emitter.line(``);
  }

/** The statement bodies nested directly under a statement — the shared
   * walk for returnCrossesFinally. */
  function childBodies(s: IrStmt): IrStmt[][] {
    switch (s.kind) {
      case "if":
        return s.else_ ? [s.then, s.else_] : [s.then];
      case "while":
      case "doWhile":
      case "forOf":
      case "block":
        return [s.body];
      case "for":
        return [s.body];
      case "switch":
        return s.cases.map((c) => c.body);
      case "tryCatch":
        return [
          s.tryBody,
          ...(s.catchBody ? [s.catchBody] : []),
          ...(s.finallyBody ? [s.finallyBody] : []),
        ];
      default:
        return [];
    }
  }

/** True when some `return` sits inside the tryBody/catchBody of a
   * try-with-finally, at any nesting depth — exactly the returns the
   * pending-return path routes, and so exactly when emitFunction must
   * declare the sc_pret slot. */
  function returnCrossesFinally(stmts: IrStmt[]): boolean {
    const hasReturn = (body: IrStmt[]): boolean =>
      body.some((s) => s.kind === "return" || childBodies(s).some(hasReturn));
    const walk = (body: IrStmt[]): boolean =>
      body.some((s) => {
        if (
          s.kind === "tryCatch" &&
          s.finallyBody !== null &&
          (hasReturn(s.tryBody) || (s.catchBody !== null && hasReturn(s.catchBody)))
        ) {
          return true;
        }
        return childBodies(s).some(walk);
      });
    return walk(stmts);
  }

/** Emits a block in its own lexical scope (refcounted locals released at
   * end). `setup` runs after the scope opens, before the statements — the
   * catch-binding hook: it may emit prelude lines and register entries the
   * scope owns (released on every exit, jumps and unwinds included). */
  export function emitBlock(emitter: CEmitter, stmts: IrStmt[], setup?: (scope: ScopeEntry[]) => void): void {
    emitter.line(`{`);
    emitter.indent++;
    const scope: ScopeEntry[] = [];
    emitter.scopes.push(scope);
    setup?.(scope);
    emitter.emitStmts(stmts);
    const endedWithJump = endsWithJump(stmts);
    emitter.scopes.pop();
    if (!endedWithJump) emitter.releaseFrame(scope);
    emitter.indent--;
    emitter.line(`}`);
  }

export function emitStmts(emitter: CEmitter, stmts: IrStmt[]): void {
    for (const s of stmts) emitter.emitStmt(s);
  }

export function emitStmt(emitter: CEmitter, s: IrStmt): void {
    emitter.frames.push([]);
    switch (s.kind) {
      case "varDecl": {
        const local = emitter.currentLocals.get(s.localId)!;
        const target = mangleLocal(s.localId);
        if (s.init === null) {
          // Declared, uninitialized (`let x: number;`). tsc's TS2454 rejects
          // any read before assignment, so no runtime check is needed — but
          // the declaration must still RESET the C local: inside a loop the
          // previous iteration's scope exit released the old value and left
          // a stale pointer, and the scope-exit release below runs whether
          // or not an `assign` ever did (runtime releases are NULL-tolerant).
          if (local.boxed) {
            // The box must exist immediately: closures created before the
            // first assignment capture it. (tsc's TS2454 can't see through
            // closures — a call before the first assignment reads 0/false
            // for scalars and traps for refcounted kinds, where JS has
            // `undefined`.)
            // A SCALAR TDZ box rides an ARR-kind box: the value lives in a
            // one-element array cell, so the empty (NULL) slot stays the
            // not-yet-initialized sentinel — a raw scalar slot has no spare
            // bit pattern to spend on it.
            const boxNew =
              local.tdz && boxAccess(local.type) !== "ref"
                ? "scr_box_new(SCR_BOX_ARR)"
                : emitter.boxNewC(local.type);
            emitter.line(`${target} = ${boxNew};${emitter.srcComment(s.loc)} /* let ${local.name}; */`);
            emitter.scopes[emitter.scopes.length - 1]!.push({ name: target, type: local.type, boxed: true });
          } else if (isRefCounted(local.type)) {
            emitter.line(`${target} = NULL;${emitter.srcComment(s.loc)} /* let ${local.name}; */`);
            emitter.scopes[emitter.scopes.length - 1]!.push({ name: target, type: local.type });
          }
          // Scalars need nothing: the C local exists from the prologue and
          // no read happens before an assign writes it.
          break;
        }
        if (local.boxed) {
          // Box FIRST, then evaluate the initializer: a named function
          // expression's closure captures this box during init evaluation.
          emitter.line(`${target} = ${emitter.boxNewC(local.type)};${emitter.srcComment(s.loc)}`);
          emitter.scopes[emitter.scopes.length - 1]!.push({ name: target, type: local.type, boxed: true });
          const v = emitter.emitExpr(s.init);
          if (isRefCounted(v.type)) emitter.moveTemp(v); // the box takes ownership
          emitter.line(`scr_box_set_${boxAccess(local.type)}(${target}, ${v.name});`);
          break;
        }
        const v = emitter.emitExpr(s.init);
        emitter.moveTemp(v);
        emitter.line(`${target} = ${v.name};${emitter.srcComment(s.loc)}`);
        if (isRefCounted(v.type)) {
          emitter.scopes[emitter.scopes.length - 1]!.push({ name: target, type: v.type });
        }
        break;
      }
      case "assign": {
        const local = emitter.currentLocals.get(s.localId);
        const concat = s.value;
        const suffix = matchStringSelfConcat(s.localId, concat);
        if (suffix && concat.kind === "strConcat") {
          // Snapshot the old left value before evaluating the suffix.  The
          // snapshot is a normal frame-owned +1: the suffix may reassign the
          // destination or throw, in which case unwinding must still release
          // it while leaving the original binding intact.
          const snapshot = emitter.emitExpr(concat.left);
          const right = emitter.emitExpr(suffix);
          const target = local ? mangleLocal(s.localId) : mangleGlobal(s.localId);
          if (local?.boxed) {
            // set_ref unlinks then releases the binding's CURRENT value. It
            // may differ from snapshot when the suffix itself assigned target.
            emitter.line(`scr_box_set_ref(${target}, NULL);`);
          } else {
            const old = `sc_t${emitter.tempCounter++}`;
            emitter.line(`ScrStr *${old} = ${target};`);
            emitter.line(`${target} = NULL;`);
            emitter.releaseValue(old, snapshot.type);
          }
          const result = emitter.newTemp(s.value.type, `scr_str_concat(${snapshot.name}, ${right.name})`);
          if (local?.boxed) {
            emitter.moveTemp(result); // the box takes the concat result's +1
            emitter.line(`scr_box_set_ref(${target}, ${result.name});${emitter.srcComment(s.loc)}`);
          } else {
            emitter.moveTemp(result); // binding takes the concat result's +1
            emitter.line(`${target} = ${result.name};${emitter.srcComment(s.loc)}`);
          }
          break;
        }
        if (!local) {
          // Module global: plain static storage, never boxed. Old-value
          // release is NULL-tolerant (statics start NULL).
          const g = emitter.globalsById.get(s.localId);
          if (!g) throw new InternalCompilerError(`emitter bug: assign to unknown binding ${s.localId}`);
          const target = mangleGlobal(g.id);
          const v = emitter.emitExpr(s.value);
          emitter.moveTemp(v);
          if (isRefCounted(v.type)) emitter.releaseValue(target, v.type);
          emitter.line(`${target} = ${v.name};${emitter.srcComment(s.loc)}`);
          break;
        }
        const target = mangleLocal(s.localId);
        const v = emitter.emitExpr(s.value);
        if (local!.boxed) {
          // A scalar TDZ box (forward-captured const): the initializing
          // write mints the one-element array cell — set_ref moves it in
          // (and the empty-slot sentinel ends here).
          if (local!.tdz && boxAccess(local!.type) !== "ref") {
            const acc = boxAccess(local!.type);
            const cell = `sc_t${emitter.tempCounter++}`;
            emitter.line(`ScrArr *${cell} = ${emitter.arrNewC(local!.type, 1)};${emitter.srcComment(s.loc)}`);
            emitter.line(`scr_arr_push_${acc}(${cell}, ${v.name});`);
            emitter.line(`scr_box_set_ref(${target}, ${cell});`);
            break;
          }
          if (isRefCounted(v.type)) emitter.moveTemp(v); // set_ref releases the old value
          emitter.line(`scr_box_set_${boxAccess(local!.type)}(${target}, ${v.name});${emitter.srcComment(s.loc)}`);
          break;
        }
        emitter.moveTemp(v);
        if (isRefCounted(v.type)) emitter.releaseValue(target, v.type);
        emitter.line(`${target} = ${v.name};${emitter.srcComment(s.loc)}`);
        break;
      }
      case "exprStmt":
        emitter.emitExpr(s.expr);
        break;
      case "if": {
        const cond = emitter.emitCondition(s.cond);
        emitter.line(`if (${cond}) `);
        emitter.mergeBrace(() => emitter.emitBlock(s.then));
        if (s.else_) {
          emitter.line(`else `);
          emitter.mergeBrace(() => emitter.emitBlock(s.else_!));
        }
        break;
      }
      case "while": {
        emitter.line(`for (;;) {${emitter.srcComment(s.loc)}`);
        emitter.indent++;
        const cond = emitter.emitCondition(s.cond);
        emitter.line(`if (!(${cond})) break;`);
        // C continue re-evaluates the condition at the top: exactly right
        // for the unlabeled loop. A LABELED while allocates a continue
        // label placed at the END of the body (falling off it re-enters
        // the condition — the same point) so a labeled continue from a
        // NESTED loop can goto it, and a lazy end label for labeled break.
        const loop = emitter.loopTarget(null, s.labels);
        emitter.jumpTargets.push(loop);
        emitter.emitBlock(s.body);
        emitter.jumpTargets.pop();
        if (loop.usedContinue && loop.continueLabel) emitter.line(`${loop.continueLabel}:;`);
        emitter.indent--;
        emitter.line(`}`);
        if (loop.usedEnd) emitter.line(`${loop.endLabel}:;`);
        break;
      }
      case "doWhile": {
        // `for (;;) { body; cont: cond; if (!cond) break; }` — the body runs
        // before the first condition check (at least once), and `continue`
        // routes through the label so the condition still evaluates.
        emitter.line(`for (;;) {${emitter.srcComment(s.loc)}`);
        emitter.indent++;
        const loop = emitter.loopTarget(`sc_cont_${emitter.labelCounter++}`, s.labels);
        emitter.jumpTargets.push(loop);
        emitter.emitBlock(s.body);
        emitter.jumpTargets.pop();
        if (loop.usedContinue) emitter.line(`${loop.continueLabel}:;`);
        const cond = emitter.emitCondition(s.cond);
        emitter.line(`if (!(${cond})) break;`);
        emitter.indent--;
        emitter.line(`}`);
        if (loop.usedEnd) emitter.line(`${loop.endLabel}:;`);
        break;
      }
      case "switch":
        emitter.emitSwitch(s);
        break;
      case "for": {
        // Desugared in place; the init's scope wraps the whole loop, so
        // break/continue must NOT release it (scopeDepth captured after).
        const integerLoop = matchIntegerBytesForLoop(s, emitter.currentLocals);
        emitter.line(`{${emitter.srcComment(s.loc)}`);
        emitter.indent++;
        emitter.scopes.push([]);
        let integerShadow: string | null = null;
        if (integerLoop) {
          integerShadow = `sc_i${emitter.tempCounter++}`;
          emitter.line(`uint64_t ${integerShadow} = 0; /* integer induction ${emitter.currentLocals.get(integerLoop.localId)!.name} */`);
          emitter.integerLoopBindings.set(integerLoop.localId, integerShadow);
        } else if (s.init) {
          emitter.emitStmt(s.init);
        }
        emitter.line(`for (;;) {`);
        emitter.indent++;
        if (integerLoop && integerShadow) {
          const receiver = emitBytesReceiver(emitter, integerLoop.limitReceiver, []);
          emitter.line(`if (!(${integerShadow} < ${receiver.name}->len)) break;`);
        } else if (s.cond) {
          const cond = emitter.emitCondition(s.cond);
          emitter.line(`if (!(${cond})) break;`);
        }
        // C continue would skip the update; route it through a label instead.
        const loop = emitter.loopTarget(`sc_cont_${emitter.labelCounter++}`, s.labels);
        emitter.jumpTargets.push(loop);
        emitter.emitBlock(s.body);
        emitter.jumpTargets.pop();
        if (loop.usedContinue) emitter.line(`${loop.continueLabel}:;`);
        // JS `for (let i ...)`: each iteration gets a FRESH binding holding a
        // copy of the previous one, and the update mutates the fresh binding
        // — that's why closures made in iteration k keep seeing iteration
        // k's value. Only observable (and only emitted) when captured.
        if (s.init?.kind === "varDecl") {
          const initLocal = emitter.currentLocals.get(s.init.localId);
          if (initLocal?.boxed) {
            const box = mangleLocal(initLocal.id);
            const fresh = `sc_t${emitter.tempCounter++}`;
            const acc = boxAccess(initLocal.type);
            emitter.line(`ScrBox *${fresh} = ${emitter.boxNewC(initLocal.type)}; /* per-iteration ${initLocal.name} */`);
            emitter.line(`scr_box_set_${acc}(${fresh}, scr_box_get_${acc}(${box}));`);
            emitter.line(`scr_box_release(${box});`);
            emitter.line(`${box} = ${fresh};`);
            // The wrapper scope's entry releases whatever `box` points to at
            // loop exit — which is now the freshest binding. Nothing to fix.
          }
        }
        if (integerLoop && integerShadow) emitter.line(`${integerShadow}++;`);
        else if (s.update) emitter.emitStmt(s.update);
        emitter.indent--;
        emitter.line(`}`);
        // A labeled break lands exactly where C break does: BEFORE the
        // init scope's release (the goto path must run the same releases
        // as the fall-through path).
        if (loop.usedEnd) emitter.line(`${loop.endLabel}:;`);
        emitter.releaseFrame(emitter.scopes.pop()!);
        if (integerLoop) emitter.integerLoopBindings.delete(integerLoop.localId);
        emitter.indent--;
        emitter.line(`}`);
        break;
      }
      case "arraySet": {
        // Evaluation order matches JS: array, index, then value. Ownership
        // of a refcounted value moves into the array (the runtime releases
        // the replaced element itself).
        const arr = emitter.emitExpr(s.arr);
        const idx = emitter.emitExpr(s.index);
        const v = emitter.emitExpr(s.value);
        if (s.arr.type.kind !== "array") throw new InternalCompilerError("emitter bug: arraySet on non-array");
        const acc = elemAccess(s.arr.type.elem);
        if (acc === "ref") emitter.moveTemp(v);
        emitter.line(`scr_arr_set_${acc}(${arr.name}, ${idx.name}, ${v.name});${emitter.srcComment(s.loc)}`);
        break;
      }
      case "bytesSet": {
        // Typed-array element write: same evaluation order as arraySet;
        // the value is a scalar (the inline kind-specific accessor coerces
        // JS-exactly), so no ownership moves. Any invalid index traps — no
        // append. The IR carries the element kind; do not rediscover it in
        // the generic runtime accessor on every loop iteration.
        const arr = emitBytesReceiver(emitter, s.arr, [s.index, s.value]);
        const integerIndex = emitter.integerLoopIndex(s.index);
        const idx = integerIndex === null ? emitter.emitExpr(s.index).name : integerIndex;
        const v = emitter.emitExpr(s.value);
        if (s.arr.type.kind !== "bytes") throw new InternalCompilerError("emitter bug: bytesSet on non-bytes");
        emitter.line(
          `${emitter.bytesElementHelper("set", s.arr.type.elem, integerIndex !== null)}(${arr.name}, ${idx}, ${v.name});${emitter.srcComment(s.loc)}`,
        );
        break;
      }
      case "fieldSet":
      case "recordSet": {
        // Evaluation order: obj, then value. New value moved in; the old
        // value is released AFTER the field is overwritten (releases are
        // NULL-tolerant — fields start NULL from the zeroed allocation).
        // Unlink-then-release is load-bearing: a release can trigger a
        // cycle collection, which must never see a heap edge whose count
        // was already given up (scr_cycle.c). Classes and records share
        // the struct layout, so one emission.
        const obj = emitter.emitExpr(s.obj);
        const v = emitter.emitExpr(s.value);
        // Runtime error classes use ScrError's own member names.
        const member =
          s.kind === "fieldSet" && RUNTIME_ERROR_CLASSES.has(s.className)
            ? s.field
            : mangleField(s.field);
        const field = `${obj.name}->${member}`;
        if (isRefCounted(v.type)) {
          emitter.moveTemp(v);
          const old = `sc_t${emitter.tempCounter++}`;
          emitter.line(`${cDecl(v.type, old)} = ${field};`);
          emitter.line(`${field} = ${v.name};${emitter.srcComment(s.loc)}`);
          emitter.releaseValue(old, v.type);
        } else {
          emitter.line(`${field} = ${v.name};${emitter.srcComment(s.loc)}`);
        }
        break;
      }
      case "recordKeyDelete": {
        // `delete obj[k]` on a pure index-signature shape: a Map delete on
        // the overflow (key and value released; absent keys no-op).
        const obj = emitter.emitExpr(s.obj);
        const key = emitter.emitExpr(s.key);
        emitter.line(`scr_map_delete_str(${obj.name}->${OVERFLOW_MEMBER}, ${key.name});${emitter.srcComment(s.loc)}`);
        break;
      }
      case "recordKeySet": {
        // Dynamic-keyed record write through the per-shape helper (declared
        // keys write through with validation, undeclared keys land in the
        // overflow map). Evaluation order: obj, key, value. The helper OWNS
        // the value (+1 moves in). MAY THROW when a dyn value must validate
        // against a declared field's type — the pending check runs then.
        const obj = emitter.emitExpr(s.obj);
        const key = emitter.emitExpr(s.key);
        const v = emitter.emitExpr(s.value);
        if (isRefCounted(v.type)) emitter.moveTemp(v);
        // A LITERAL key naming no declared field is a plain overflow map
        // insert — no helper, no validation, no throw.
        if (s.overflowOnly) {
          const acc = v.type.kind === "f64" ? "f64" : v.type.kind === "bool" ? "bool" : "ref";
          emitter.line(
            `scr_map_set_str_${acc}(${obj.name}->${OVERFLOW_MEMBER}, ${key.name}, ${v.name});${emitter.srcComment(s.loc)}`,
          );
          break;
        }
        const helper = emitter.recordKeySetHelper(s.shapeId);
        emitter.line(`${helper}(${obj.name}, ${key.name}, ${v.name});${emitter.srcComment(s.loc)}`);
        const shape = emitter.recordsById.get(s.shapeId);
        // MAY THROW: a dyn value validating against a declared field, or a
        // signature-free shape's key MISS (scr_record_key_miss).
        if (shape && (!shape.indexValue || (shape.indexValue.kind === "dyn" && shape.fields.length > 0))) {
          emitter.emitPendingCheck();
        }
        break;
      }
      case "forOf": {
        // Ascending index loop; the length is re-read every iteration
        // (JS-exact — pushes inside the body extend the iteration). The
        // iterable temp lives in this statement's frame, so it is released
        // when the whole loop ends (and by `return`'s frame sweep). A real
        // C for-loop makes plain `continue` correct: the update still runs.
        if (s.iterable.type.kind !== "array") throw new InternalCompilerError("emitter bug: forOf over non-array");
        const elem = s.iterable.type.elem;
        const arr = emitter.emitExpr(s.iterable);
        const idx = `sc_t${emitter.tempCounter++}`;
        emitter.line(
          `for (double ${idx} = 0; ${idx} < scr_arr_len(${arr.name}); ${idx} += 1) {${emitter.srcComment(s.loc)}`,
        );
        emitter.indent++;
        // A real C for-loop makes plain `continue` correct (the update
        // still runs); a LABELED forOf allocates a continue label placed at
        // the END of the iteration (after the per-iteration scope release —
        // the goto path released it itself) so nested loops can goto it.
        const loop = emitter.loopTarget(null, s.labels);
        emitter.jumpTargets.push(loop);
        // The loop variable is a fresh const per iteration: its scope opens
        // here, holds the (for ref elements: owned +1) current element, and
        // releases it at the end of each iteration.
        emitter.scopes.push([]);
        const local = mangleLocal(s.localId);
        const localInfo = emitter.currentLocals.get(s.localId);
        if (localInfo?.boxed) {
          // Captured loop variable: a fresh box per iteration, matching the
          // fresh const binding (closures made in iteration k keep seeing
          // iteration k's element). The box takes ownership of a ref
          // element's +1 and is released with the iteration's scope.
          emitter.line(`${local} = ${emitter.boxNewC(elem)}; /* per-iteration ${localInfo.name} */`);
          emitter.line(`scr_box_set_${boxAccess(elem)}(${local}, scr_arr_get_${elemAccess(elem)}(${arr.name}, ${idx}));`);
          emitter.scopes[emitter.scopes.length - 1]!.push({ name: local, type: elem, boxed: true });
        } else {
          emitter.line(`${local} = scr_arr_get_${elemAccess(elem)}(${arr.name}, ${idx});`);
          if (isRefCounted(elem)) emitter.scopes[emitter.scopes.length - 1]!.push({ name: local, type: elem });
        }
        emitter.emitStmts(s.body);
        const endedWithJump = endsWithJump(s.body);
        const scope = emitter.scopes.pop()!;
        if (!endedWithJump) emitter.releaseFrame(scope);
        emitter.jumpTargets.pop();
        if (loop.usedContinue && loop.continueLabel) emitter.line(`${loop.continueLabel}:;`);
        emitter.indent--;
        emitter.line(`}`);
        if (loop.usedEnd) emitter.line(`${loop.endLabel}:;`);
        break;
      }
      case "block": {
        if (s.labels === undefined) {
          emitter.emitBlock(s.body);
          break;
        }
        // A labeled block: `break lbl` inside jumps to the end label
        // (releasing the block's scope itself); nothing else can target it.
        const target = {
          kind: "block" as const,
          endLabel: `sc_end_${emitter.labelCounter++}`,
          usedEnd: false,
          labels: s.labels,
          scopeDepth: emitter.scopes.length,
          frameDepth: emitter.frames.length,
        };
        emitter.jumpTargets.push(target);
        emitter.emitBlock(s.body);
        emitter.jumpTargets.pop();
        if (target.usedEnd) emitter.line(`${target.endLabel}:;`);
        break;
      }
      case "break": {
        // Unlabeled: binds to the innermost loop OR switch (labeled block
        // targets are skipped). Labeled: binds to the entry carrying the
        // label. Release every scope entered since that target started
        // (the body scope and anything nested); their natural end-of-block
        // releases are on the fall-through path this jump bypasses. Same
        // for pending frame temps of statements the jump exits (a nested
        // switch's discriminant) — but NOT the target's own frame: a
        // loop's releases after the loop and a switch's after its end
        // label are still on this jump's path.
        let target: (typeof emitter.jumpTargets)[number] | undefined;
        for (let i = emitter.jumpTargets.length - 1; i >= 0; i--) {
          const t = emitter.jumpTargets[i]!;
          if (s.label !== undefined ? t.labels?.includes(s.label) : t.kind !== "block") {
            target = t;
            break;
          }
        }
        if (!target) throw new InternalCompilerError("emitter bug: break target not found");
        emitter.releaseForJump(target.frameDepth, target.scopeDepth);
        if (target.kind !== "loop" || s.label !== undefined) {
          // Switches are emitted as goto chains and blocks aren't C loops
          // at all, so a C `break` cannot target either; and a LABELED
          // break may target an outer loop a C break would never reach.
          // All three jump to the target's end label (labeled loops always
          // allocate one — loopTarget).
          target.usedEnd = true;
          emitter.line(`goto ${target.endLabel!};${emitter.srcComment(s.loc)}`);
        } else {
          emitter.line(`break;${emitter.srcComment(s.loc)}`);
        }
        break;
      }
      case "continue": {
        // Unlabeled: binds to the innermost LOOP, skipping any switches and
        // labeled blocks in between (their scopes are still released — the
        // jump exits them). Labeled: binds to the loop carrying the label.
        let loop: ((typeof emitter.jumpTargets)[number] & { kind: "loop" }) | undefined;
        for (let i = emitter.jumpTargets.length - 1; i >= 0; i--) {
          const t = emitter.jumpTargets[i]!;
          if (t.kind === "loop" && (s.label === undefined || t.labels?.includes(s.label))) {
            loop = t;
            break;
          }
        }
        if (!loop) throw new InternalCompilerError("emitter bug: continue target not found");
        emitter.releaseForJump(loop.frameDepth, loop.scopeDepth);
        if (loop.continueLabel) {
          // Labeled loops always allocate one (a labeled continue may
          // target an outer loop a C continue could never reach); for/
          // do-while allocate one for their update/condition point.
          loop.usedContinue = true;
          emitter.line(`goto ${loop.continueLabel};${emitter.srcComment(s.loc)}`);
        } else {
          emitter.line(`continue;${emitter.srcComment(s.loc)}`);
        }
        break;
      }
      case "return": {
        const fin = emitter.finallyStack[emitter.finallyStack.length - 1];
        if (fin) {
          // Crossing ≥1 finally: the value is computed and snapshotted
          // FIRST (a finally mutating the returned local cannot change
          // it — Node's semantics), then everything down to the innermost
          // region releases and control runs that region's pending-return
          // finally copy; its tail dispatches further out or returns.
          if (s.value) {
            const v = emitter.emitExpr(s.value);
            emitter.moveTemp(v); // ownership parks in the slot until the dispatch returns it
            emitter.line(`sc_pret = ${v.name};${emitter.srcComment(s.loc)}`);
          }
          fin.used = true;
          emitter.releaseForJump(fin.frameDepth, fin.scopeDepth);
          emitter.line(`goto ${fin.label};${s.value ? "" : emitter.srcComment(s.loc)}`);
          break;
        }
        if (s.value) {
          const v = emitter.emitExpr(s.value);
          emitter.moveTemp(v);
          // Everything down to function depth releases; the moved result is
          // exempt (already struck from its frame).
          emitter.releaseForJump(0, 0);
          emitter.line(`return ${v.name};${emitter.srcComment(s.loc)}`);
        } else {
          emitter.releaseForJump(0, 0);
          emitter.line(`return;${emitter.srcComment(s.loc)}`);
        }
        break;
      }
      case "throw": {
        // Evaluate, move ownership into the runtime's exception cell, then
        // unwind unconditionally (the innermost try handler, or out of the
        // function) — the same release path as return/break/continue.
        const v = emitter.emitExpr(s.value);
        const t = s.value.type;
        if (isRefCounted(t)) emitter.moveTemp(v); // the cell takes ownership
        if (t.kind === "date") {
          throw new InternalCompilerError("emitter bug: Date throw reached backend");
        } else if (t.kind === "f64") {
          emitter.line(`scr_throw_f64(${v.name});${emitter.srcComment(s.loc)}`);
        } else if (t.kind === "bool") {
          emitter.line(`scr_throw_bool(${v.name});${emitter.srcComment(s.loc)}`);
        } else if (t.kind === "string") {
          emitter.line(`scr_throw_str(${v.name});${emitter.srcComment(s.loc)}`);
        } else if (t.kind === "object" && emitter.classMeta.get(t.className)?.hierarchy) {
          // Hierarchy instances carry a vtable word: the OBJ kind keeps the
          // dynamic class inspectable (catch-binding instanceof, and the
          // uncaught printer's "name: message" for Error instances).
          const rc = vAdapters(t);
          emitter.line(`scr_throw_obj(${v.name}, &${rc.retain}, &${rc.release}, ${emitter.traceArgC(t)});${emitter.srcComment(s.loc)}`);
        } else {
          const rc = vAdapters(t);
          emitter.line(`scr_throw_ref(${v.name}, &${rc.retain}, &${rc.release}, ${emitter.traceArgC(t)});${emitter.srcComment(s.loc)}`);
        }
        emitter.emitUnwind();
        break;
      }
      case "runtimeFence": {
        // The deferred JS compile fence: throw a catchable Error naming
        // the construct (message) with the SC code stamped on `code`,
        // then unwind exactly like `throw`.
        const bytes = Buffer.from(s.message, "utf8");
        emitter.line(
          `scr_throw_error_msg_code(SCR_ERR_ERROR, ${cStringLiteral(bytes)}, ${bytes.length}, "${s.code}");${emitter.srcComment(s.loc)}`,
        );
        emitter.emitUnwind();
        break;
      }
      case "rethrow":
        // Re-raise the saved snapshot (payload retained — the binding local
        // releases with its scope) and unwind like `throw`.
        emitter.line(`scr_rethrow(${mangleLocal(s.localId)});${emitter.srcComment(s.loc)}`);
        emitter.emitUnwind();
        break;
      case "tryCatch":
        emitter.emitTryCatch(s);
        break;
      default: {
        const _exhaustive: never = s;
        void _exhaustive;
      }
    }
    const frame = emitter.frames.pop()!;
    // return/throw already released their frames on the jump path; emitting
    // the fall-through releases after them would be dead double-release code.
    if (s.kind !== "return" && s.kind !== "throw" && s.kind !== "rethrow" && s.kind !== "runtimeFence") emitter.releaseFrame(frame);
  }

/** try/catch/finally via pending-flag unwinding. Entering a try emits NO
   * code: the try context is compile-time state (tryStack) that redirects
   * unwinds inside the region to a label here instead of out of the
   * function. Shape:
   *
   *   { try body }          unwinds inside release frames/scopes down to
   *                         this statement's depths, then goto the handler
   *   goto after;           (normal completion skips the handler)
   *   sc_catch_N:;         (emitted only when some unwind targets it)
   *     scr_exc_clear();   catch TAKES the exception (payload discarded —
   *     { catch body }      the supported catch form is bindingless)
   *   after/sc_fin_N:;
   *   { finally body }      normal path
   *   goto sc_tryend_N;
   *   sc_finexc_N:;        exception path: pending flag still set
   *   { finally body }      (emitted twice — fresh temps/labels each time;
   *   <unwind>               duplication is safe, and the pending flag is
   *   sc_tryend_N:;         the dispatch)
   *
   * Without a catch, unwinds in the try body target sc_finexc_N directly.
   * A catch body's own exceptions target sc_finexc_N (when a finally
   * exists) or the ENCLOSING context — never its own handler. After the
   * exception-path finally, propagation continues (emitUnwind: enclosing
   * handler or dummy return). A `return` inside the try/catch body rides a
   * THIRD finally copy (sc_finret_N — the pending-return path: value
   * snapshotted into sc_pret at the return site, dispatch outward after
   * the copy runs); break/continue never cross a finally and no jump
   * leaves a finally body (frontend fence + validator backstop), so
   * normal, exception, and pending-return are the only paths a finally
   * must model; jumps out of PLAIN try/catch need nothing here —
   * release-on-jump already walks the try scopes. */
  export function emitTryCatch(emitter: CEmitter, s: IrStmt & { kind: "tryCatch" }): void {
    const id = emitter.labelCounter++;
    const hasCatch = s.catchBody !== null;
    const hasFinally = s.finallyBody !== null;
    const catchLabel = `sc_catch_${id}`;
    const finExcLabel = `sc_finexc_${id}`;
    const endLabel = `sc_tryend_${id}`;
    // Where the try body's normal completion continues.
    const afterTryLabel = hasFinally ? `sc_fin_${id}` : endLabel;
    let afterTryLabelUsed = false;

    const handler = {
      label: hasCatch ? catchLabel : finExcLabel,
      used: false,
      frameDepth: emitter.frames.length,
      scopeDepth: emitter.scopes.length,
    };
    // The pending-return region: returns inside tryBody/catchBody snapshot
    // their value and jump here-ish (the pending-return finally copy below)
    // instead of returning directly. Same depths as the unwind handler.
    const retEntry = hasFinally
      ? {
          label: `sc_finret_${id}`,
          used: false,
          frameDepth: emitter.frames.length,
          scopeDepth: emitter.scopes.length,
        }
      : null;
    emitter.line(`/* try */${emitter.srcComment(s.loc)}`);
    if (retEntry) emitter.finallyStack.push(retEntry);
    emitter.tryStack.push(handler);
    emitter.emitBlock(s.tryBody);
    emitter.tryStack.pop();

    // Exceptions raised in the CATCH body unwind to the exception-path
    // finally (pending stays set through it) when one exists.
    const excHandler = {
      label: finExcLabel,
      used: !hasCatch && handler.used,
      frameDepth: emitter.frames.length,
      scopeDepth: emitter.scopes.length,
    };

    if (hasCatch && handler.used) {
      if (!endsWithJump(s.tryBody)) {
        emitter.line(`goto ${afterTryLabel};`);
        afterTryLabelUsed = true;
      }
      if (hasFinally) emitter.tryStack.push(excHandler);
      // Generator bodies: a pending GENRET sentinel (.return(v) injected at
      // a yield) is a RETURN completion, not a throw — catch must not take
      // it. Re-unwind past this handler (finally still runs — the unwind
      // targets the exception-path finally or the enclosing context; the
      // runtime depths here equal the handler's, so no double release).
      const genretPrologue = (): void => {
        if (emitter.currentGenerator === null) return;
        emitter.line(`if (scr_exc_genret_pending()) { /* .return(): not catchable */`);
        emitter.indent++;
        emitter.emitUnwind();
        emitter.indent--;
        emitter.line(`}`);
      };
      if (s.catchLocalId !== null) {
        // catch (e): the exception MOVES into the binding's snapshot box,
        // owned by the catch body's scope (released on every exit — normal
        // fall-through, jumps out, and unwinds from the body).
        const binding = mangleLocal(s.catchLocalId);
        emitter.line(`${catchLabel}:; /* catch (${emitter.currentLocals.get(s.catchLocalId)?.name ?? "e"}) — takes the exception */`);
        genretPrologue();
        emitter.emitBlock(s.catchBody!, (scope) => {
          emitter.line(`${binding} = scr_exc_take();`);
          scope.push({ name: binding, type: CAUGHT });
        });
      } else {
        emitter.line(`${catchLabel}:; /* catch — takes the exception */`);
        genretPrologue();
        emitter.line(`scr_exc_clear();`);
        emitter.emitBlock(s.catchBody!);
      }
      if (hasFinally) emitter.tryStack.pop();
      // Normal completion of the catch falls through to afterTryLabel.
    }
    if (retEntry) emitter.finallyStack.pop();

    if (hasFinally) {
      if (afterTryLabelUsed) emitter.line(`${afterTryLabel}:;`);
      emitter.line(`/* finally (normal path) */`);
      emitter.emitBlock(s.finallyBody!);
      const needEnd = excHandler.used || retEntry!.used;
      if (needEnd) emitter.line(`goto ${endLabel};`);
      if (excHandler.used) {
        // The pending exception is STASHED across the finally body (a
        // ScrCaught snapshot, re-raised after) so the body runs with a
        // CLEAN cell: its own may-throw calls' pending checks answer for
        // themselves — not for the in-flight exception — and a generator
        // suspending here (a yield inside a finally on the .return()/
        // .throw() unwind) resumes into the REST of the finally, exactly
        // Node. A throw inside the body REPLACES the stash (it unwinds
        // past the release through the synthetic scope entry below —
        // JS's replace semantics); normal completion re-raises the stash
        // and keeps propagating.
        const stash = `sc_fexc_${id}`;
        emitter.line(`${finExcLabel}:; /* finally (exception path — stashed) */`);
        emitter.line(`ScrCaught *${stash} = scr_exc_take();`);
        emitter.scopes.push([{ name: stash, type: CAUGHT }]);
        emitter.emitBlock(s.finallyBody!);
        emitter.scopes.pop(); // normal completion keeps the stash for the re-raise
        emitter.line(`scr_rethrow(${stash});`);
        emitter.line(`scr_caught_release(${stash});`);
        emitter.emitUnwind();
      }
      if (retEntry!.used) {
        // Pending-return path: a return in the try/catch body parked its
        // value in sc_pret and jumped here after releasing down to this
        // region. The finally body runs (third copy — fresh temps/labels,
        // like the exception copy), then the dispatch continues outward:
        // the next enclosing finally region of this function, or the
        // actual return. A THROW inside this copy replaces the pending
        // return (JS): the slot's owned value rides a synthetic scope
        // entry so the unwind releases it.
        emitter.line(`${retEntry!.label}:; /* finally (pending-return path) */`);
        const retT = emitter.currentReturnType;
        const own = isRefCounted(retT);
        if (own) emitter.scopes.push([{ name: "sc_pret", type: retT }]);
        emitter.emitBlock(s.finallyBody!);
        if (own) emitter.scopes.pop();
        const outer = emitter.finallyStack[emitter.finallyStack.length - 1];
        if (outer) {
          outer.used = true;
          emitter.releaseForJump(outer.frameDepth, outer.scopeDepth);
          emitter.line(`goto ${outer.label};`);
        } else {
          emitter.releaseForJump(0, 0);
          emitter.line(retT.kind === "void" ? `return;` : `return sc_pret;`);
        }
      }
      if (needEnd) emitter.line(`${endLabel}:;`);
    } else if (afterTryLabelUsed) {
      emitter.line(`${endLabel}:;`);
    }
  }

/** JS-exact switch as a goto chain — C `switch` cannot express lazily
   * evaluated, arbitrary-expression case tests. Shape:
   *
   *   disc temp
   *   NULL-reset of refcounted case-body locals   (see below)
   *   per test, in source order: eval test; if (== disc) goto case_i;
   *   goto default (or end when there is none)
   *   case_0:; body_0   ─┐ bodies in source order fall through
   *   case_1:; body_1   ─┘ naturally, JS-exact
   *   scope releases (natural fall-off path)
   *   end:;                (break jumps here, after releasing scopes itself)
   *
   * All case bodies share ONE scope (JS: one lexical scope per switch body).
   * Because dispatch can jump PAST a varDecl into a later case, a refcounted
   * local of a skipped body is never written — and inside an enclosing loop
   * it still holds the pointer a previous iteration's scope exit already
   * released. The declarations are therefore NULL-reset up front; the
   * scope-exit releases rely on the runtime's NULL-tolerant release calls. */
  export function emitSwitch(emitter: CEmitter, s: IrStmt & { kind: "switch" }): void {
    if (s.disc.type.kind !== "f64" && s.disc.type.kind !== "string" && s.disc.type.kind !== "bool") {
      throw new InternalCompilerError(`emitter bug: switch on ${s.disc.type.kind}`);
    }
    const id = emitter.labelCounter++;
    const endLabel = `sc_swend_${id}`;
    const caseLabel = (i: number) => `sc_swcase_${id}_${i}`;

    // The disc temp lives in the whole statement's frame: for a string
    // discriminant it stays alive across every test and body, released when
    // the switch statement ends (break lands before that release; return
    // sweeps frames itself).
    const disc = emitter.emitExpr(s.disc);

    // NULL-reset refcounted/boxed locals declared at the top level of case
    // bodies (nested blocks manage their own scopes on normal control flow).
    for (const c of s.cases) {
      for (const stmt of c.body) {
        if (stmt.kind !== "varDecl") continue;
        const local = emitter.currentLocals.get(stmt.localId)!;
        if (local.boxed || isRefCounted(local.type)) {
          emitter.line(`${mangleLocal(local.id)} = NULL; /* case-scoped ${local.name} */`);
        }
      }
    }

    // Dispatch: lazy source-order test evaluation (a test after the match
    // never runs). Each test's temps release right after its comparison.
    let defaultIdx = -1;
    s.cases.forEach((c, i) => {
      if (c.test === null) {
        defaultIdx = i;
        return;
      }
      emitter.frames.push([]);
      const t = emitter.emitExpr(c.test);
      const cmp =
        c.test.type.kind === "string"
          ? `scr_str_eq(${disc.name}, ${t.name})`
          : `${disc.name} == ${t.name}`;
      const hit = emitter.newTemp(BOOL, cmp);
      emitter.releaseFrame(emitter.frames.pop()!);
      emitter.line(`if (${hit.name}) goto ${caseLabel(i)};`);
    });
    emitter.line(`goto ${defaultIdx >= 0 ? caseLabel(defaultIdx) : endLabel};`);

    // Bodies in source order: entering one falls through the rest (JS-exact)
    // until a break jumps to the end label.
    const target = {
      kind: "switch" as const,
      endLabel,
      usedEnd: defaultIdx < 0,
      ...(s.labels !== undefined && { labels: s.labels }),
      scopeDepth: emitter.scopes.length,
      frameDepth: emitter.frames.length,
    };
    emitter.jumpTargets.push(target);
    emitter.scopes.push([]);
    s.cases.forEach((c, i) => {
      emitter.line(`${caseLabel(i)}:;`);
      emitter.indent++;
      emitter.emitStmts(c.body);
      emitter.indent--;
    });
    emitter.jumpTargets.pop();
    const scope = emitter.scopes.pop()!;
    // Natural fall-off of the last body releases the shared scope here; a
    // jump (break/return/continue/throw) already released it before jumping.
    const lastBody = s.cases[s.cases.length - 1]?.body;
    if (!lastBody || !endsWithJump(lastBody)) emitter.releaseFrame(scope);
    if (target.usedEnd) emitter.line(`${endLabel}:;`);
  }

/** Emits `if (cond) ` followed by a block on the same line for readability. */
  export function mergeBrace(emitter: CEmitter, emitBlockFn: () => void): void {
    const head = emitter.lines.pop()!;
    const before = emitter.lines.length;
    emitBlockFn();
    emitter.lines[before] = head + emitter.lines[before]!.trimStart();
  }

/** Evaluates `expr` in its own statement frame inside an already-open
   * branch and moves the result into the C lvalue `target`: the chosen
   * value's ownership transfers, every other temp the evaluation allocated
   * releases inside the branch. The shared core of the lazily-branched
   * expressions (`logical`, `ternary`); the caller owns the surrounding
   * braces/indentation and registers `target` in ITS frame. */
  export function emitBranchInto(emitter: CEmitter, target: string, expr: IrExpr): void {
    emitter.frames.push([]);
    const v = emitter.emitExpr(expr);
    emitter.moveTemp(v);
    emitter.line(`${target} = ${v.name};`);
    emitter.releaseFrame(emitter.frames.pop()!);
  }

/** Evaluates a condition; its string temps are released before the branch,
   * which is safe because the result is a scalar bool. */
  export function emitCondition(emitter: CEmitter, cond: IrExpr): string {
    const t = emitter.emitExpr(cond);
    const frame = emitter.currentFrame();
    emitter.releaseFrame(frame);
    frame.length = 0;
    return t.name;
  }
