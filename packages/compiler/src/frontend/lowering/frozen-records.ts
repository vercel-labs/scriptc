import * as ts from "../ts7/adapter.js";
import {
  BOOL,
  VOID,
  shapeHasAccessorSlots,
  typeKey,
  type IrExpr,
  type IrFunction,
  type IrStmt,
  type IrType,
  type SrcLoc,
} from "../../ir/ir.js";
import { numLit, strLit, varRef } from "../../ir/build.js";
import { everyStmtList, transformStmtList } from "../../ir/traverse.js";
import type { Lowerer } from "./lowerer.js";
import { recordHasOwnHelper } from "./lower-calls.js";
import { isStrictCode } from "./strict-mode.js";

/* Object.freeze of records and arrays that other references can still
 * write. Only the types a program may freeze pay for it. A record keeps its
 * frozen bit in the rc word (scr_rc.h SCR_RC_FROZEN), which its release
 * ignores, and every write to it checks the bit first
 * (guardFrozenWrites). An array keeps it in its storage flags
 * (scr_array.h SCR_ARR_FROZEN), which the backend's array write guards test
 * for the array types the module lists (IrModule.freezableArrays). A type is
 * freezable when a static Object.freeze names it, or, in a program that
 * freezes, seals or prevents extensions of untyped values
 * (noteUntypedIntegrity), when a value of it or of a type reaching it can be
 * held as a live untyped reference. */

type RecordType = Extract<IrType, { kind: "record" }>;
type RecordWrite = Extract<IrStmt, { kind: "recordSet" | "recordKeySet" | "recordKeyDelete" }>;
type FreezeFn = "record.freeze" | "array.freeze" | "collection.preventExtensions";

/** Object.freeze of a record or an array, or Object.freeze, seal or
 * preventExtensions of a Map or Set: `fn` sets the value's bit, and the
 * call answers the value. */
export function lowerNativeFreeze(
  lowerer: Lowerer,
  fn: FreezeFn,
  target: IrExpr,
  loc: SrcLoc,
): IrExpr {
  const type = target.type;
  const slot = lowerer.declareHiddenLocal("%freezeTarget", type);
  const receiver = (): IrExpr => varRef(slot.id, type, loc);
  return {
    kind: "seqExpr",
    stmts: [
      { kind: "varDecl", localId: slot.id, init: target, loc },
      {
        kind: "exprStmt",
        expr: { kind: "libCall", fn, args: [receiver()], type: VOID, loc },
        loc,
      },
    ],
    result: receiver(),
    type,
    loc,
  };
}

/** Records that the program freezes, seals or prevents extensions of the
 * untyped value `node` lowers to. Unless it is a fresh object or array
 * literal, the value can be any record, array or class instance the program
 * holds as an untyped reference, so those types become freezable. */
export function noteUntypedIntegrity(lowerer: Lowerer, node: ts.Expression): void {
  let inner = node;
  while (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner)) inner = inner.expression;
  if (!ts.isObjectLiteralExpression(inner) && !ts.isArrayLiteralExpression(inner))
    lowerer.untypedIntegrity = true;
}

function isRecordWrite(s: IrStmt): s is RecordWrite {
  return s.kind === "recordSet" || s.kind === "recordKeySet" || s.kind === "recordKeyDelete";
}

/** The key of a record write's source range: strict mode is lexical, so
 * every write lowered from the same range shares its mode. */
function writeKey(loc: SrcLoc): string {
  return `${loc.file}\0${loc.start}\0${loc.end}`;
}

/** Records the record writes of `stmt`, lowered from `node`, as sloppy-mode
 * writes when `node` is sloppy-mode code: a write to a frozen record then
 * leaves it unchanged instead of throwing. `deletes` says `stmt` is the
 * absent-state write of `delete r.f`, which Node refuses only while the
 * field is present. */
export function markSloppyRecordWrites(
  lowerer: Lowerer,
  stmt: IrStmt,
  node: ts.Node,
  deletes = false,
): IrStmt {
  if (deletes) lowerer.recordFieldDeletes.add(writeKey(stmt.loc));
  if (isStrictCode(node)) return stmt;
  everyStmtList([stmt], {
    stmt: (s) => {
      if (s.kind === "recordSet" || s.kind === "recordKeySet" || s.kind === "recordKeyDelete")
        lowerer.sloppyRecordWrites.add(writeKey(s.loc));
      return true;
    },
    expr: () => true,
  });
  return stmt;
}

/** Whether a field write's value can be an optional field's absent state,
 * which only a field write itself can hold. */
function holdsAbsentState(e: IrExpr): boolean {
  if (e.kind === "fieldAbsent") return true;
  return e.kind === "ternary" && (holdsAbsentState(e.then) || holdsAbsentState(e.else_));
}

/** The record shapes and array types (typeKeys) whose values the program
 * may freeze. */
function freezableTypes(
  lowerer: Lowerer,
  functions: IrFunction[],
): { shapes: Set<string>; arrays: Set<string> } {
  const shapes = new Set<string>();
  const arrays = new Set<string>();
  const live: IrType[] = [];
  for (const fn of functions)
    everyStmtList(fn.body, {
      expr: (e) => {
        if (e.kind === "libCall" && e.fn === "record.freeze") {
          const target = e.args[0];
          if (target && target.type.kind === "record") shapes.add(target.type.shapeId);
        } else if (e.kind === "libCall" && e.fn === "array.freeze") {
          const target = e.args[0];
          if (target && target.type.kind === "array") arrays.add(typeKey(target.type));
        } else if (e.kind === "dynFrom") live.push(e.value.type);
        return true;
      },
      stmt: () => true,
    });
  if (!lowerer.untypedIntegrity) return { shapes, arrays };
  // An untyped reference to a class instance, or to a record or array
  // boxed live, reaches the values its fields and elements hold as further
  // live references. Class instances also cross into untyped code through
  // compiled callbacks, so every class is a root.
  const stack = [...live];
  for (const info of lowerer.classes.values())
    for (const field of info.def.fields) stack.push(field.type);
  const seen = new Set<string>();
  while (stack.length > 0) {
    const type = stack.pop()!;
    switch (type.kind) {
      case "record": {
        if (seen.has(`record:${type.shapeId}`)) break;
        seen.add(`record:${type.shapeId}`);
        shapes.add(type.shapeId);
        const shape = lowerer.shapes.get(type.shapeId);
        for (const field of shape?.fields ?? []) stack.push(field.type);
        if (shape?.indexValue) stack.push(shape.indexValue);
        break;
      }
      case "union":
        if (seen.has(`union:${type.unionId}`)) break;
        seen.add(`union:${type.unionId}`);
        for (const arm of lowerer.unions.get(type.unionId)?.arms ?? []) stack.push(arm);
        break;
      case "array": {
        const key = typeKey(type);
        if (seen.has(key)) break;
        seen.add(key);
        arrays.add(key);
        stack.push(type.elem);
        break;
      }
      case "set":
        stack.push(type.elem);
        break;
      case "map":
        stack.push(type.key, type.value);
        break;
      case "promise":
        stack.push(type.inner);
        break;
      case "generator":
        stack.push(type.yieldT, type.retT, type.nextT);
        break;
      case "func":
        for (const param of type.params) stack.push(param);
        stack.push(type.ret);
        break;
      default:
        break;
    }
  }
  return { shapes, arrays };
}

/** The guarded form of a write to a freezable record: the receiver and the
 * operands are evaluated first, in source order, then the frozen bit decides
 * between the write and `reject`. */
function guardedWrite(
  receiver: IrExpr,
  decls: IrStmt[],
  reject: IrStmt[],
  store: IrStmt,
  loc: SrcLoc,
): IrStmt {
  return {
    kind: "block",
    body: [
      ...decls,
      {
        kind: "if",
        cond: { kind: "libCall", fn: "record.isFrozen", args: [receiver], type: BOOL, loc },
        then: reject,
        else_: [store],
        loc,
      },
    ],
    loc,
  };
}

/** Checks the frozen bit before every write to a record of a freezable
 * shape, and lists the freezable array types, whose writes the backend
 * guards (IrModule.freezableArrays). A write to a frozen record throws
 * Node's TypeError in strict mode code; in sloppy-mode code it leaves the
 * record unchanged. Deleting a key the record does not have succeeds either
 * way. */
export function guardFrozenWrites(lowerer: Lowerer, functions: IrFunction[]): void {
  const { shapes: freezable, arrays } = freezableTypes(lowerer, functions);
  for (const id of freezable) {
    const shape = lowerer.shapes.get(id);
    if (shape) shape.freezable = true;
  }
  for (const key of arrays) lowerer.freezableArrays.add(key);
  if (freezable.size === 0) return;
  const lifted = lowerer.liftedFns.length;
  for (const fn of functions) {
    const local = (type: IrType, loc: SrcLoc): Extract<IrExpr, { kind: "varRef" }> => {
      const id = `%frozenWrite.${fn.locals.length}`;
      fn.locals.push({ id, name: id, type, mutable: false });
      return { kind: "varRef", localId: id, type, loc };
    };
    const guarded = new Set<IrStmt>();
    fn.body = transformStmtList(fn.body, {
      stmt: (statement) => {
        if (!isRecordWrite(statement) || guarded.has(statement)) return statement;
        if (!freezable.has(statement.shapeId)) return statement;
        const sloppy = lowerer.sloppyRecordWrites.has(writeKey(statement.loc));
        const deletes =
          statement.kind === "recordSet" && lowerer.recordFieldDeletes.has(writeKey(statement.loc));
        const loc = statement.loc;
        const shapeId = statement.shapeId;
        const receiver = local(statement.obj.type, loc);
        const decls: IrStmt[] = [
          { kind: "varDecl", localId: receiver.localId, init: statement.obj, loc },
        ];
        const owner = strLit(
          lowerer.shapes.get(shapeId)?.tuple ? "[object Array]" : "#<Object>",
          loc,
        );
        const thrown = (key: IrExpr, operation: number): IrStmt => ({
          kind: "exprStmt",
          expr: {
            kind: "libCall",
            fn: "record.throwFrozen",
            args: [key, owner, numLit(operation, loc)],
            type: VOID,
            loc,
          },
          loc,
        });
        if (statement.kind === "recordSet") {
          let value = statement.value;
          if (!holdsAbsentState(value)) {
            const slot = local(value.type, loc);
            decls.push({ kind: "varDecl", localId: slot.localId, init: value, loc });
            value = slot;
          }
          const store: IrStmt = {
            kind: "recordSet",
            obj: receiver,
            shapeId,
            field: statement.field,
            value,
            loc,
          };
          guarded.add(store);
          const field = strLit(statement.field, loc);
          // `delete r.f` of an optional field writes its absent state: Node
          // only refuses it when the field is present.
          const reject: IrStmt[] = sloppy
            ? []
            : deletes
              ? [
                  {
                    kind: "if",
                    cond: lowerer.recordFieldPresent(receiver, shapeId, statement.field, loc),
                    then: [thrown(field, 2)],
                    else_: null,
                    loc,
                  },
                ]
              : [thrown(field, 0)];
          return guardedWrite(receiver, decls, reject, store, loc);
        }
        const key = local(statement.key.type, loc);
        decls.push({ kind: "varDecl", localId: key.localId, init: statement.key, loc });
        const named = key.type.kind === "string";
        const present: IrExpr = named
          ? {
              kind: "call",
              callee: recordHasOwnHelper(lowerer, shapeId, loc),
              args: [receiver, key],
              type: BOOL,
              loc,
            }
          : { kind: "boolLit", value: true, type: BOOL, loc };
        const text: IrExpr = named ? key : strLit("[key]", loc);
        if (statement.kind === "recordKeySet") {
          const value = local(statement.value.type, loc);
          decls.push({ kind: "varDecl", localId: value.localId, init: statement.value, loc });
          const store: IrStmt = {
            kind: "recordKeySet",
            obj: receiver,
            shapeId,
            key,
            value,
            ...(statement.overflowOnly ? { overflowOnly: true as const } : {}),
            loc,
          };
          guarded.add(store);
          const reject: IrStmt[] = sloppy
            ? []
            : [
                {
                  kind: "if",
                  cond: present,
                  then: [thrown(text, 0)],
                  else_: [thrown(text, 1)],
                  loc,
                },
              ];
          return guardedWrite(receiver, decls, reject, store, loc);
        }
        const store: IrStmt = { kind: "recordKeyDelete", obj: receiver, shapeId, key, loc };
        guarded.add(store);
        const reject: IrStmt[] = sloppy
          ? []
          : [{ kind: "if", cond: present, then: [thrown(text, 2)], else_: null, loc }];
        return guardedWrite(receiver, decls, reject, store, loc);
      },
      expr: (expression) => expression,
    });
  }
  // The key-presence helpers the guards call.
  for (const helper of lowerer.liftedFns.slice(lifted)) functions.push(helper);
}

/** Whether a statically typed Object.freeze can freeze a value of `type`:
 * a record whose shape has no accessor properties. */
export function freezableRecordType(lowerer: Lowerer, type: IrType): type is RecordType {
  if (type.kind !== "record") return false;
  const shape = lowerer.shapes.get(type.shapeId);
  return shape !== undefined && !shapeHasAccessorSlots(shape);
}

/** The source ranges (writeKey) of untyped property writes in sloppy-mode
 * code (IrModule.sloppyDynWrites): an assignment there that strict mode
 * refuses with a TypeError (a frozen or non-extensible object, a read-only
 * property) leaves the object unchanged instead. Only programs with such
 * writes list any; the backend calls the sloppy entry points for them. */
export function sloppyDynamicWrites(lowerer: Lowerer, functions: readonly IrFunction[]): string[] {
  const keys = new Set<string>();
  const strictness = new Map<string, boolean>();
  for (const fn of functions) {
    everyStmtList(fn.body, {
      stmt: () => true,
      expr: (e) => {
        if (e.kind !== "libCall" || (e.fn !== "dyn.keySet" && e.fn !== "dyn.keySetComputed"))
          return true;
        const key = writeKey(e.loc);
        let sloppy = strictness.get(key);
        if (sloppy === undefined) {
          sloppy = isSloppyAt(lowerer, e.loc);
          strictness.set(key, sloppy);
        }
        if (sloppy) keys.add(key);
        return true;
      },
    });
  }
  return [...keys].sort();
}

/** Whether the source at `loc` is sloppy-mode code (isStrictCode). */
export function isSloppyAt(lowerer: Lowerer, loc: SrcLoc): boolean {
  const node = lowerer.nodeAtLoc(loc);
  return node !== null && !isStrictCode(node);
}
