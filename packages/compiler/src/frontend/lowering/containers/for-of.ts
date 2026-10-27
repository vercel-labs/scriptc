import { numLit, varRef } from "../../../ir/build.js";
import { InternalCompilerError } from "../../../errors.js";
import * as ts from "../../ts7/adapter.js";
import type { Lowerer } from "../lowerer.js";
import {
  BOOL,
  CAUGHT,
  F64,
  type IrExpr,
  type IrMapIntrinsicMethod,
  type IrSetIntrinsicMethod,
  type IrStmt,
  type IrType,
  STRING,
  VOID,
  typeEquals,
} from "../../../ir/ir.js";
import { forOfVarTarget, lowerDestructuringAssign } from "../lower-stmts.js";
import { locOf } from "../../program.js";
import { arrayValueRead, arrayValueType } from "../array-values.js";

/** `for (const [k, v] of m)` / `for (const e of m)` — for-of over a Map,
 * desugared IN PLACE (the body is user code, so no helper function) over
 * the same iteration primitives as the forEach desugar, with the same
 * Node-exact live-iteration contract: iterCount re-read every pass
 * (entries appended by the body are visited), tombstones skipped
 * (deleted entries are not). Shape:
 *
 *   %m = <iterable>; %m.iterEnter();
 *   try {
 *     for (%i = %m.iterStart; %i < %m.iterCount; %i++) {
 *       if (%m.iterLive(%i)) { <bindings>; <body> }
 *     }
 *   } catch (%c) { %m.iterExit(); rethrow %c; }
 *   %m.iterExit();
 *
 * catch-and-rethrow instead of a finally because break/continue/return
 * may not cross a finally (the emitter's documented contract) and a
 * for-of body legitimately contains all three: break/continue bind to
 * the desugared loop INSIDE the plain try (jumps out of plain try need
 * nothing), and every `return` in the body gets an iterExit inserted
 * before it (exitBeforeReturns) so the depth count stays exact on that
 * path too. A `[k, v]` head of plain identifiers binds straight from
 * iterKey/iterValue — the tuple record never materializes; an identifier
 * head binds the checker's own [K, V] tuple built per iteration. */
/** The iterator-method projections a for-of can ride directly:
 * `for (const k of m.keys())`, `.values()`, `.entries()` — the SAME
 * live-iteration walk as `for..of m` (JS's container iterators are live
 * views, not snapshots), just yielding the key, the value, or the pair. */
export type ForOfIterProjection = "keys" | "values" | "entries";

/** for-of over a URLSearchParams (and its keys()/values()/entries()
 * projections consumed directly by the head): the LIVE index walk —
 * sp.size re-reads every pass, so entries appended mid-walk are visited
 * and deletes shift, the spec's index-based iterator exactly. No
 * enter/exit bracketing: the pair list compacts immediately (no
 * tombstones), so there is no iteration depth to keep exact. */
export function lowerForOfSearchParams(
  lowerer: Lowerer,
  stmt: ts.ForOfStatement,
  iterable: IrExpr,
  proj?: ForOfIterProjection,
): IrStmt {
  const loc = locOf(stmt);
  const SP: IrType = iterable.type;
  const yieldsPair = proj === undefined || proj === "entries";
  if (!ts.isVariableDeclarationList(stmt.initializer)) {
    lowerer.unsupported(
      "SC1090",
      stmt.initializer,
      "for-of over a pre-declared variable (declare the loop variable in the loop: for (const x of ...))",
    );
  }
  const list = stmt.initializer;
  if ((list.flags & ts.NodeFlags.Using) !== 0) {
    lowerer.unsupported("SC1090", list, "'using' declarations (dispose-at-scope-exit semantics)");
  }
  const isVar = (list.flags & ts.NodeFlags.BlockScoped) === 0;
  const isLet = (list.flags & ts.NodeFlags.Let) !== 0 || isVar;
  const decl = list.declarations.nodes[0]!; // the grammar allows exactly one
  lowerer.scopes.push(new Map());
  try {
    const sp = lowerer.declareHiddenLocal("%spof", SP);
    const i = lowerer.declareHiddenLocal("%iterof", F64);
    i.mutable = true;

    const read = (fn: "sp.size" | "sp.keyAt" | "sp.valAt", idx: boolean): IrExpr => ({
      kind: "libCall",
      fn,
      args: idx ? [varRef(sp.id, SP, loc), varRef(i.id, F64, loc)] : [varRef(sp.id, SP, loc)],
      type: idx ? STRING : F64,
      loc,
    });
    const keyRead = (): IrExpr => read("sp.keyAt", true);
    const valRead = (): IrExpr => read("sp.valAt", true);
    const singleRead = (): IrExpr => (proj === "values" ? valRead() : keyRead());

    const binds: IrStmt[] = [];
    const isPlainIdent = (
      el: ts.ArrayBindingElement,
    ): el is ts.BindingElement & { name: ts.Identifier } =>
      ts.isBindingElement(el) &&
      el.name !== undefined &&
      ts.isIdentifier(el.name) &&
      !el.initializer &&
      !el.dotDotDotToken;
    if (
      yieldsPair &&
      !isVar && // var pattern names assign hoisted slots — the generic desugar below owns them
      ts.isArrayBindingPattern(decl.name) &&
      decl.name.elements.nodes.length >= 1 &&
      decl.name.elements.nodes.length <= 2 &&
      decl.name.elements.nodes.every(isPlainIdent)
    ) {
      // `for (const [k, v] of sp)` — bind straight from the reads; the
      // tuple never exists. `[k]` alone reads only the key.
      const els = decl.name.elements.nodes as readonly (ts.BindingElement & {
        name: ts.Identifier;
      })[];
      const kLocal = lowerer.declareLocal(els[0]!.name, els[0]!.name.text, STRING, isLet);
      binds.push({ kind: "varDecl", localId: kLocal.id, init: keyRead(), loc });
      if (els[1]) {
        const vLocal = lowerer.declareLocal(els[1].name, els[1].name.text, STRING, isLet);
        binds.push({ kind: "varDecl", localId: vLocal.id, init: valRead(), loc });
      }
    } else {
      // Identifier heads and the remaining patterns bind through the
      // checker's own element type — [string, string] for pair yields,
      // string otherwise — the Map desugar's exact shape.
      const elemT = lowerer.mapTypeOf(lowerer.checker.getTypeAtLocation(decl.name));
      if (yieldsPair) {
        const shape = elemT?.kind === "record" ? lowerer.shapes.get(elemT.shapeId) : null;
        if (
          elemT?.kind !== "record" ||
          !shape?.tuple ||
          shape.fields.length !== 2 ||
          shape.fields.some((f) => f.type.kind !== "string")
        ) {
          lowerer.badType(decl.name, lowerer.checker.getTypeAtLocation(decl.name)); // defensive: the lib declares [string, string]
        }
      } else if (elemT?.kind !== "string") {
        lowerer.badType(decl.name, lowerer.checker.getTypeAtLocation(decl.name)); // defensive: the lib declares string
      }
      const elemInit: IrExpr = yieldsPair
        ? {
            kind: "recordLit",
            fields: [
              { name: "0", value: keyRead() },
              { name: "1", value: valRead() },
            ],
            type: elemT!,
            loc,
          }
        : singleRead();
      if (ts.isIdentifier(decl.name)) {
        const varTarget = forOfVarTarget(lowerer, decl, elemT!);
        if (varTarget) {
          // `for (var x of ...)`: one function-scoped binding, assigned
          // per pass — closures made in the loop share it, and the value
          // persists after the loop (both Node-exact for var).
          const tmp = lowerer.declareHiddenLocal("%vof", elemT!);
          binds.push({ kind: "varDecl", localId: tmp.id, init: elemInit, loc });
          binds.push({
            kind: "assign",
            localId: varTarget.id,
            value: lowerer.coerceInto(
              decl.name,
              { kind: "varRef", localId: tmp.id, type: elemT!, loc },
              varTarget.type,
            ),
            loc,
          });
        } else {
          const local = lowerer.declareLocal(decl.name, decl.name.text, elemT!, isLet);
          binds.push({ kind: "varDecl", localId: local.id, init: elemInit, loc });
        }
      } else {
        const tmp = lowerer.declareHiddenLocal("%destr", elemT!);
        binds.push({ kind: "varDecl", localId: tmp.id, init: elemInit, loc });
        lowerer.lowerBindingPattern(
          decl.name,
          () => ({ kind: "varRef", localId: tmp.id, type: elemT!, loc }),
          elemT!,
          isLet,
          binds,
        );
      }
    }

    const body = lowerer.inCtl("loop", () => lowerer.lowerScopedBlock(stmt.statement));
    const loop: IrStmt = {
      kind: "for",
      init: { kind: "varDecl", localId: i.id, init: numLit(0, loc), loc },
      cond: {
        kind: "bin",
        op: "<",
        left: varRef(i.id, F64, loc),
        right: read("sp.size", false),
        type: BOOL,
        loc,
      },
      update: {
        kind: "assign",
        localId: i.id,
        value: {
          kind: "bin",
          op: "+",
          left: varRef(i.id, F64, loc),
          right: numLit(1, loc),
          type: F64,
          loc,
        },
        loc,
      },
      body: [...binds, ...body],
      loc,
    };
    return {
      kind: "block",
      body: [{ kind: "varDecl", localId: sp.id, init: iterable, loc }, loop],
      loc,
    };
  } finally {
    lowerer.scopes.pop();
  }
}

/** for-of over an ARRAY/typed-array keys()/entries() projection consumed directly
 * by the head (`for (const [index, line] of lines.entries())` — the
 * dominant formatter idiom): the LIVE index walk — the length re-reads
 * every pass, exactly the array iterator's contract (elements appended
 * mid-walk are visited; a shrink ends the loop early) — yielding the
 * index (`keys`, a number) or the [index, element] pair (`entries`).
 * `values` never lands here: lowerForOf's receiver unwrap owns it. A
 * `[i, v]` head of plain identifiers binds straight from the reads (the
 * tuple never materializes); identifier heads and the remaining
 * patterns bind through the checker's own element type — the interned
 * [number, T] tuple record. Stored iterator OBJECTS keep their fence
 * (only the direct for-of position unwraps). */
export function lowerForOfArrayIter(
  lowerer: Lowerer,
  stmt: ts.ForOfStatement,
  iterable: IrExpr,
  proj: "keys" | "entries",
): IrStmt {
  const loc = locOf(stmt);
  const arrT = iterable.type;
  if (arrT.kind !== "array" && arrT.kind !== "bytes")
    throw new InternalCompilerError("array iterator requires indexed storage");
  const elemT = arrT.kind === "array" ? arrayValueType(lowerer, arrT.elem) : F64;
  const yieldsPair = proj === "entries";
  if (!ts.isVariableDeclarationList(stmt.initializer)) {
    lowerer.unsupported(
      "SC1090",
      stmt.initializer,
      "for-of over a pre-declared variable (declare the loop variable in the loop: for (const x of ...))",
    );
  }
  const list = stmt.initializer;
  if ((list.flags & ts.NodeFlags.Using) !== 0) {
    lowerer.unsupported("SC1090", list, "'using' declarations (dispose-at-scope-exit semantics)");
  }
  const isVar = (list.flags & ts.NodeFlags.BlockScoped) === 0;
  const isLet = (list.flags & ts.NodeFlags.Let) !== 0 || isVar;
  const decl = list.declarations.nodes[0]!; // the grammar allows exactly one
  lowerer.scopes.push(new Map());
  try {
    const arr = lowerer.declareHiddenLocal("%arof", arrT);
    const i = lowerer.declareHiddenLocal("%iterof", F64);
    i.mutable = true;

    const keyRead = (): IrExpr => varRef(i.id, F64, loc);
    const valRead = (): IrExpr =>
      arrT.kind === "array"
        ? arrayValueRead(lowerer, varRef(arr.id, arrT, loc), varRef(i.id, F64, loc), arrT.elem, loc)
        : {
            kind: "bytesIntrinsic",
            method: "get",
            receiver: varRef(arr.id, arrT, loc),
            args: [varRef(i.id, F64, loc)],
            type: F64,
            loc,
          };

    const binds: IrStmt[] = [];
    const isPlainIdent = (
      el: ts.ArrayBindingElement,
    ): el is ts.BindingElement & { name: ts.Identifier } =>
      ts.isBindingElement(el) &&
      el.name !== undefined &&
      ts.isIdentifier(el.name) &&
      !el.initializer &&
      !el.dotDotDotToken;
    if (
      yieldsPair &&
      !isVar && // var pattern names assign hoisted slots — the generic desugar below owns them
      ts.isArrayBindingPattern(decl.name) &&
      decl.name.elements.nodes.length >= 1 &&
      decl.name.elements.nodes.length <= 2 &&
      decl.name.elements.nodes.every(isPlainIdent)
    ) {
      // `for (const [i, v] of xs.entries())` — bind straight from the
      // reads; the tuple never exists. `[i]` alone reads only the index.
      const els = decl.name.elements.nodes as readonly (ts.BindingElement & {
        name: ts.Identifier;
      })[];
      const kLocal = lowerer.declareLocal(els[0]!.name, els[0]!.name.text, F64, isLet);
      binds.push({ kind: "varDecl", localId: kLocal.id, init: keyRead(), loc });
      if (els[1]) {
        const vLocal = lowerer.declareLocal(els[1].name, els[1].name.text, elemT, isLet);
        if (arrT.kind === "array" && !typeEquals(elemT, arrT.elem)) {
          const root = lowerer.runtimeOptionalRootOf(vLocal);
          lowerer.runtimeOptionalLocals.add(root);
          lowerer.runtimeOptionalStorageLocals.add(root);
        }
        binds.push({ kind: "varDecl", localId: vLocal.id, init: valRead(), loc });
      }
    } else {
      // Identifier heads and the remaining patterns bind through the
      // checker's own element type — [number, T] for pair yields,
      // number otherwise — the Map desugar's exact shape.
      const declT = lowerer.mapTypeOf(lowerer.checker.getTypeAtLocation(decl.name));
      if (yieldsPair) {
        const shape = declT?.kind === "record" ? lowerer.shapes.get(declT.shapeId) : null;
        if (declT?.kind === "record" && shape?.tuple && arrT.kind === "array") {
          const valueField = shape.fields.find((field) => field.name === "1");
          if (
            valueField &&
            typeEquals(valueField.type, arrT.elem) &&
            !typeEquals(elemT, arrT.elem)
          ) {
            valueField.type = elemT;
            lowerer.runtimeOptionalFields.add(lowerer.runtimeOptionalFieldKey(declT.shapeId, "1"));
          }
        }
        if (
          declT?.kind !== "record" ||
          !shape?.tuple ||
          shape.fields.length !== 2 ||
          shape.fields.find((f) => f.name === "0")?.type.kind !== "f64" ||
          !typeEquals(shape.fields.find((f) => f.name === "1")?.type ?? F64, elemT)
        ) {
          lowerer.badType(decl.name, lowerer.checker.getTypeAtLocation(decl.name)); // defensive: the lib declares [number, T]
        }
      } else if (declT?.kind !== "f64") {
        lowerer.badType(decl.name, lowerer.checker.getTypeAtLocation(decl.name)); // defensive: the lib declares number
      }
      const elemInit: IrExpr = yieldsPair
        ? {
            kind: "recordLit",
            fields: [
              { name: "0", value: keyRead() },
              { name: "1", value: valRead() },
            ],
            type: declT!,
            loc,
          }
        : keyRead();
      if (ts.isIdentifier(decl.name)) {
        const varTarget = forOfVarTarget(lowerer, decl, declT!);
        if (varTarget) {
          // `for (var x of ...)`: one function-scoped binding, assigned
          // per pass — closures made in the loop share it, and the value
          // persists after the loop (both Node-exact for var).
          const tmp = lowerer.declareHiddenLocal("%vof", declT!);
          binds.push({ kind: "varDecl", localId: tmp.id, init: elemInit, loc });
          binds.push({
            kind: "assign",
            localId: varTarget.id,
            value: lowerer.coerceInto(
              decl.name,
              { kind: "varRef", localId: tmp.id, type: declT!, loc },
              varTarget.type,
            ),
            loc,
          });
        } else {
          const local = lowerer.declareLocal(decl.name, decl.name.text, declT!, isLet);
          binds.push({ kind: "varDecl", localId: local.id, init: elemInit, loc });
        }
      } else {
        const tmp = lowerer.declareHiddenLocal("%destr", declT!);
        binds.push({ kind: "varDecl", localId: tmp.id, init: elemInit, loc });
        lowerer.lowerBindingPattern(
          decl.name,
          () => ({ kind: "varRef", localId: tmp.id, type: declT!, loc }),
          declT!,
          isLet,
          binds,
        );
      }
    }

    const body = lowerer.inCtl("loop", () => lowerer.lowerScopedBlock(stmt.statement));
    const loop: IrStmt = {
      kind: "for",
      init: { kind: "varDecl", localId: i.id, init: numLit(0, loc), loc },
      cond: {
        kind: "bin",
        op: "<",
        left: varRef(i.id, F64, loc),
        right:
          arrT.kind === "array"
            ? {
                kind: "arrIntrinsic",
                method: "length",
                receiver: varRef(arr.id, arrT, loc),
                args: [],
                type: F64,
                loc,
              }
            : {
                kind: "bytesIntrinsic",
                method: "length",
                receiver: varRef(arr.id, arrT, loc),
                args: [],
                type: F64,
                loc,
              },
        type: BOOL,
        loc,
      },
      update: {
        kind: "assign",
        localId: i.id,
        value: {
          kind: "bin",
          op: "+",
          left: varRef(i.id, F64, loc),
          right: numLit(1, loc),
          type: F64,
          loc,
        },
        loc,
      },
      body: [...binds, ...body],
      loc,
    };
    return {
      kind: "block",
      body: [{ kind: "varDecl", localId: arr.id, init: iterable, loc }, loop],
      loc,
    };
  } finally {
    lowerer.scopes.pop();
  }
}

export function lowerForOfMap(
  lowerer: Lowerer,
  stmt: ts.ForOfStatement,
  iterable: IrExpr,
  mapT: IrType & { kind: "map" },
  proj?: ForOfIterProjection,
): IrStmt {
  return lowerForOfMapOrSet(lowerer, stmt, iterable, mapT, proj);
}

/** `for (const v of s)` — for-of over a Set: the Map desugar with iterKey
 * as the (single) element read; same live-iteration contract. */
export function lowerForOfSet(
  lowerer: Lowerer,
  stmt: ts.ForOfStatement,
  iterable: IrExpr,
  setT: IrType & { kind: "set" },
  proj?: ForOfIterProjection,
): IrStmt {
  return lowerForOfMapOrSet(lowerer, stmt, iterable, setT, proj);
}

function lowerForOfMapOrSet(
  lowerer: Lowerer,
  stmt: ts.ForOfStatement,
  iterable: IrExpr,
  contT: (IrType & { kind: "map" }) | (IrType & { kind: "set" }),
  proj?: ForOfIterProjection,
): IrStmt {
  const loc = locOf(stmt);
  const isMap = contT.kind === "map";
  // What each pass YIELDS: a [first, second] pair (the Map default and
  // `.entries()` — a Set's entries are [v, v], like JS), or one value
  // (the Set default/keys/values; a Map's `.keys()` or `.values()`).
  const yieldsPair = proj === "entries" || (isMap && proj === undefined);
  // Expression heads (`for ([k = "", v = false] of map)`): the pair (or
  // single value) builds into a hidden per-iteration local and the
  // destructuring-assignment machinery assigns the pre-declared
  // bindings — handled below where the reads exist. Identifier heads
  // ride the same shape.
  const exprHead = !ts.isVariableDeclarationList(stmt.initializer) ? stmt.initializer : null;
  let isVar = false;
  let isLet = false;
  let decl: ts.VariableDeclaration | null = null;
  if (!exprHead) {
    const list = stmt.initializer as ts.VariableDeclarationList;
    if ((list.flags & ts.NodeFlags.Using) !== 0) {
      lowerer.unsupported("SC1090", list, "'using' declarations (dispose-at-scope-exit semantics)");
    }
    isVar = (list.flags & ts.NodeFlags.BlockScoped) === 0;
    isLet = (list.flags & ts.NodeFlags.Let) !== 0 || isVar;
    decl = list.declarations.nodes[0]!; // the grammar allows exactly one
  }
  lowerer.scopes.push(new Map());
  try {
    const m = lowerer.declareHiddenLocal(isMap ? "%mapof" : "%setof", contT);
    const i = lowerer.declareHiddenLocal("%iterof", F64);
    i.mutable = true; // the loop counter reassigns (hidden locals default const)

    const iter = (method: string, args: IrExpr[], type: IrType): IrExpr =>
      isMap
        ? {
            kind: "mapIntrinsic",
            method: method as IrMapIntrinsicMethod,
            receiver: varRef(m.id, contT, loc),
            args,
            type,
            loc,
          }
        : {
            kind: "setIntrinsic",
            method: method as IrSetIntrinsicMethod,
            receiver: varRef(m.id, contT, loc),
            args,
            type,
            loc,
          };
    const keyT = isMap
      ? (contT as IrType & { kind: "map" }).key
      : (contT as IrType & { kind: "set" }).elem;
    const keyRead = (): IrExpr => iter("iterKey", [varRef(i.id, F64, loc)], keyT);
    const valRead = (): IrExpr =>
      iter("iterValue", [varRef(i.id, F64, loc)], (contT as IrType & { kind: "map" }).value);
    // The pair's second position (a Map's value; a Set entry repeats the
    // element — JS's [v, v]) and the single yield (a Map's `.values()`
    // reads the value; everything else reads the key/element).
    const secondT = isMap ? (contT as IrType & { kind: "map" }).value : keyT;
    const secondRead = (): IrExpr => (isMap ? valRead() : keyRead());
    const singleT = isMap && proj === "values" ? (contT as IrType & { kind: "map" }).value : keyT;
    const singleRead = (): IrExpr => (isMap && proj === "values" ? valRead() : keyRead());

    // The per-iteration bindings at the top of the loop body.
    const binds: IrStmt[] = [];
    if (exprHead) {
      // A PRE-DECLARED head: the element (the [K, V] pair or the single
      // value) lands in a hidden per-iteration local, then either the
      // plain assignment or the destructuring-assignment machinery
      // writes the existing bindings — the array for-of's exact rule.
      let target = exprHead as ts.Expression;
      while (ts.isParenthesizedExpression(target)) target = target.expression;
      const elemT: IrType = yieldsPair
        ? {
            kind: "record",
            shapeId: lowerer.shapes.intern(
              [
                { name: "0", type: keyT },
                { name: "1", type: secondT },
              ],
              true,
            ),
          }
        : singleT;
      const elemInit: IrExpr = yieldsPair
        ? {
            kind: "recordLit",
            fields: [
              { name: "0", value: keyRead() },
              { name: "1", value: secondRead() },
            ],
            type: elemT,
            loc,
          }
        : singleRead();
      const tmp = lowerer.declareHiddenLocal("%vof", elemT);
      binds.push({ kind: "varDecl", localId: tmp.id, init: elemInit, loc });
      const elemRef: IrExpr = { kind: "varRef", localId: tmp.id, type: elemT, loc };
      if (ts.isIdentifier(target)) {
        const w = lowerer.resolveWritable(target);
        if (!w)
          lowerer.rejectUnresolved(
            target,
            `assignment to '${target.text}' (not a writable local or module global)`,
          );
        binds.push({
          kind: "assign",
          localId: w.id,
          value: lowerer.coerceInto(target, elemRef, w.type),
          loc,
        });
      } else if (ts.isObjectLiteralExpression(target) || ts.isArrayLiteralExpression(target)) {
        binds.push(lowerDestructuringAssign(lowerer, target, elemRef, target, loc));
      } else {
        lowerer.unsupported(
          "SC1090",
          exprHead,
          "for-of heads assigning member expressions (assign a variable, then write the member out)",
        );
      }
    } else {
      const isPlainIdent = (
        el: ts.ArrayBindingElement,
      ): el is ts.BindingElement & { name: ts.Identifier } =>
        ts.isBindingElement(el) &&
        el.name !== undefined &&
        ts.isIdentifier(el.name) &&
        !el.initializer &&
        !el.dotDotDotToken;
      if (
        yieldsPair &&
        !isVar && // var pattern names assign hoisted slots — the generic desugar below owns them
        ts.isArrayBindingPattern(decl!.name) &&
        decl!.name.elements.nodes.length >= 1 &&
        decl!.name.elements.nodes.length <= 2 &&
        decl!.name.elements.nodes.every(isPlainIdent)
      ) {
        // `for (const [k, v] of m)` — bind straight from the primitives;
        // the tuple never exists. `[k]` alone reads only the key.
        const els = decl!.name.elements.nodes as readonly (ts.BindingElement & {
          name: ts.Identifier;
        })[];
        const kLocal = lowerer.declareLocal(els[0]!.name, els[0]!.name.text, keyT, isLet);
        binds.push({ kind: "varDecl", localId: kLocal.id, init: keyRead(), loc });
        if (els[1]) {
          const vLocal = lowerer.declareLocal(els[1].name, els[1].name.text, secondT, isLet);
          binds.push({ kind: "varDecl", localId: vLocal.id, init: secondRead(), loc });
        }
      } else {
        // Derive the yielded layout from the represented container. JS
        // inference can leave the pattern at any even when the Map's
        // native key/value types are known after specialization.
        const elemT: IrType = yieldsPair
          ? {
              kind: "record",
              shapeId: lowerer.shapes.intern(
                [
                  { name: "0", type: keyT },
                  { name: "1", type: secondT },
                ],
                true,
              ),
            }
          : singleT;
        const elemInit: IrExpr = yieldsPair
          ? {
              kind: "recordLit",
              fields: [
                { name: "0", value: keyRead() },
                { name: "1", value: secondRead() },
              ],
              type: elemT!,
              loc,
            }
          : singleRead();
        if (ts.isIdentifier(decl!.name)) {
          const varTarget = forOfVarTarget(lowerer, decl!, elemT!);
          if (varTarget) {
            // `for (var x of ...)`: one function-scoped binding, assigned
            // per pass — closures made in the loop share it, and the value
            // persists after the loop (both Node-exact for var).
            const tmp = lowerer.declareHiddenLocal("%vof", elemT!);
            binds.push({ kind: "varDecl", localId: tmp.id, init: elemInit, loc });
            binds.push({
              kind: "assign",
              localId: varTarget.id,
              value: lowerer.coerceInto(
                decl!.name,
                { kind: "varRef", localId: tmp.id, type: elemT!, loc },
                varTarget.type,
              ),
              loc,
            });
          } else {
            const local = lowerer.declareLocal(decl!.name, decl!.name.text, elemT!, isLet);
            binds.push({ kind: "varDecl", localId: local.id, init: elemInit, loc });
          }
        } else {
          const tmp = lowerer.declareHiddenLocal("%destr", elemT!);
          binds.push({ kind: "varDecl", localId: tmp.id, init: elemInit, loc });
          lowerer.lowerBindingPattern(
            decl!.name,
            () => ({ kind: "varRef", localId: tmp.id, type: elemT!, loc }),
            elemT!,
            isLet,
            binds,
          );
        }
      }
    }
    const body = lowerer.inCtl("loop", () => lowerer.lowerScopedBlock(stmt.statement));
    const exitStmt = (): IrStmt => ({ kind: "exprStmt", expr: iter("iterExit", [], VOID), loc });
    // iterStart is the first live index: a map that removes its oldest
    // entries skips its deleted prefix once (the walk would skip those
    // entries anyway), so a body that breaks after the first live entry
    // does not walk it again on every loop.
    const loop: IrStmt = {
      kind: "for",
      init: { kind: "varDecl", localId: i.id, init: iter("iterStart", [], F64), loc },
      cond: {
        kind: "bin",
        op: "<",
        left: varRef(i.id, F64, loc),
        right: iter("iterCount", [], F64),
        type: BOOL,
        loc,
      },
      update: {
        kind: "assign",
        localId: i.id,
        value: {
          kind: "bin",
          op: "+",
          left: varRef(i.id, F64, loc),
          right: numLit(1, loc),
          type: F64,
          loc,
        },
        loc,
      },
      body: [
        {
          kind: "if",
          cond: iter("iterLive", [varRef(i.id, F64, loc)], BOOL),
          then: [...binds, ...exitBeforeReturns(body, exitStmt)],
          else_: null,
          loc,
        },
      ],
      loc,
    };
    const caught = lowerer.declareHiddenLocal("%iterexc", CAUGHT);
    return {
      kind: "block",
      body: [
        { kind: "varDecl", localId: m.id, init: iterable, loc },
        { kind: "exprStmt", expr: iter("iterEnter", [], VOID), loc },
        {
          kind: "tryCatch",
          tryBody: [loop],
          catchBody: [exitStmt(), { kind: "rethrow", localId: caught.id, loc }],
          catchLocalId: caught.id,
          finallyBody: null,
          loc,
        },
        exitStmt(),
      ],
      loc,
    };
  } finally {
    lowerer.scopes.pop();
  }
}

/** Rewrites a lowered for-of-over-Map/Set body so every `return` runs the
 * loop's iterExit first (JS closes the live iterator before returning).
 * Recurses through every nested statement list; nested functions are
 * lifted elsewhere and never appear here, so every return found exits
 * THIS function through the active iteration. */
export function exitBeforeReturns(stmts: IrStmt[], make: () => IrStmt): IrStmt[] {
  const walk = (list: IrStmt[]): IrStmt[] =>
    list.flatMap((s): IrStmt[] => {
      switch (s.kind) {
        case "return":
          return [make(), s];
        case "if":
          return [{ ...s, then: walk(s.then), else_: s.else_ ? walk(s.else_) : null }];
        case "for":
          return [{ ...s, body: walk(s.body) }];
        case "while":
        case "doWhile":
        case "forOf":
        case "block":
          return [{ ...s, body: walk(s.body) }];
        case "switch":
          return [
            {
              ...s,
              cases: s.cases.map((c) => {
                if (!c) throw new InternalCompilerError("missing switch clause");
                return { ...c, body: walk(c.body) };
              }),
            },
          ];
        case "tryCatch":
          return [
            {
              ...s,
              tryBody: walk(s.tryBody),
              catchBody: s.catchBody ? walk(s.catchBody) : null,
              finallyBody: s.finallyBody ? walk(s.finallyBody) : null,
            },
          ];
        default:
          return [s];
      }
    });
  return walk(stmts);
}
