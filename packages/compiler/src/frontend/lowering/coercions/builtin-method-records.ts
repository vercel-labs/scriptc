/* A builtin handle flowing into a record of methods (`const sink: Sink =
 * process.stdout` with `interface Sink { write(s: string): void }`, or
 * process.stderr passed to a `{ write }` parameter): tsc accepts the flow
 * because the handle's type has every member the record declares.
 *
 * In Node the record IS the object, so a method call through it reads the
 * object's current member and runs it with the object as receiver. The
 * projection keeps that: each record field is a closure over the object's
 * checked-dynamic view that invokes the member by name, boxing the
 * arguments and checking the result against the field's declared return
 * type. A member the program replaced (`process.stdout.write = fn`) is the
 * one the call reaches.
 *
 * The record is a new value, as every width copy is: it is not identical
 * to the object, and it exposes only the declared members. Records that
 * declare data members, optional members or index signatures are outside
 * the projection and keep SC2002. */
import { DYN, HANDLE_KINDS, VOID, typeEquals, canDynCheckTo } from "../../../ir/ir.js";
import type { IrExpr, IrFunction, IrLocal, IrStmt, IrType, SrcLoc } from "../../../ir/ir.js";
import { varRef } from "../../../ir/build.js";
import { everyStmtList } from "../../../ir/traverse.js";
import { handleProjectionObservedDiag } from "../../../diagnostics/diagnostic.js";
import { EXPOSING_LIB_CALLS } from "../record-links.js";
import { typeKey } from "../../type-mapper.js";
import { keyedHelperName } from "../stable-names.js";
import { InternalCompilerError } from "../../../errors.js";
import type { Lowerer } from "../lowerer.js";

type FuncType = IrType & { kind: "func" };

const local = (id: string, name: string, type: IrType, boxed = false): IrLocal => ({
  id,
  name,
  type,
  mutable: false,
  ...(boxed ? { boxed: true } : {}),
});

/** An opaque runtime handle (HANDLE_KINDS: the process and child stdio
 * handles, sockets, servers, ...) that has a checked-dynamic view.
 * Instances of the runtime classes (stream.Writable and the other stream
 * classes) are outside it: an untyped member call on one rebuilds the
 * instance's method view on every call, which is slower than Node. */
function isBuiltinHandle(lowerer: Lowerer, type: IrType): boolean {
  return HANDLE_KINDS.has(type.kind) && lowerer.dynConvertible(type);
}

/** The record's methods when every field is one whose arguments box into
 * the dynamic tier and whose result checks back out of it, else null. A
 * variadic method is outside the projection: the invoker calls the member
 * through the dynamic tier, which has no spread form, and the closure's
 * declared type would carry a rest ABI the invoker does not implement. */
function methodFields(
  lowerer: Lowerer,
  shapeId: string,
): { name: string; type: FuncType }[] | null {
  const shape = lowerer.shapes.get(shapeId);
  if (!shape || shape.indexValue || shape.tuple || shape.fields.length === 0) return null;
  const methods: { name: string; type: FuncType }[] = [];
  for (const field of shape.fields) {
    if (field.name.startsWith("%") || field.type.kind !== "func") return null;
    const fn = field.type;
    if (fn.rest === true) return null;
    if (!fn.params.every((p) => lowerer.dynConvertible(p))) return null;
    if (
      fn.ret.kind !== "void" &&
      !canDynCheckTo(
        fn.ret,
        (id) => lowerer.shapes.get(id),
        (id) => lowerer.unions.get(id),
      )
    )
      return null;
    methods.push({ name: field.name, type: fn });
  }
  return methods;
}

/** Interned `%builtin.methods.<n>(o)`: the record of `o`'s members the
 * target declares, or null when the pair is outside the projection. */
export function builtinMethodRecord(
  lowerer: Lowerer,
  expr: IrExpr,
  shapeId: string,
  loc: SrcLoc,
): IrExpr | null {
  const source = expr.type;
  if (!isBuiltinHandle(lowerer, source)) return null;
  const methods = methodFields(lowerer, shapeId);
  if (!methods) return null;
  const key = `builtin-methods:${typeKey(source)}:${shapeId}`;
  let name = lowerer.valueHelpers.get(key);
  if (!name) {
    name = keyedHelperName(lowerer, "%builtin.methods", key);
    lowerer.valueHelpers.set(key, name);
    buildProjection(lowerer, name, source, shapeId, methods, loc);
  }
  const type: IrType = { kind: "record", shapeId };
  return { kind: "call", callee: name, args: [expr], type, loc };
}

function buildProjection(
  lowerer: Lowerer,
  name: string,
  source: IrType,
  shapeId: string,
  methods: { name: string; type: FuncType }[],
  loc: SrcLoc,
): void {
  const result: IrType = { kind: "record", shapeId };
  const fields = methods.map(({ name: field, type }, i) => {
    const fnName = `${name}.${i}`;
    lowerer.liftedFns.push(memberInvoker(lowerer, fnName, field, type, loc));
    lowerer.noteEdge(fnName);
    const closure: IrExpr = { kind: "closure", fnName, captures: ["view.0"], type, loc };
    return { name: field, value: closure };
  });
  const view = lowerer.coerceToExpected(varRef("o.0", source, loc), DYN);
  if (!typeEquals(view.type, DYN))
    throw new InternalCompilerError(
      `lowerer bug: ${lowerer.fmt(source)} has no checked-dynamic view`,
    );
  const body: IrStmt[] = [
    { kind: "varDecl", localId: "view.0", init: view, loc },
    { kind: "return", value: { kind: "recordLit", fields, type: result, loc }, loc },
  ];
  lowerer.liftedFns.push({
    name,
    params: [{ localId: "o.0", name: "o", type: source }],
    returnType: result,
    locals: [local("o.0", "o", source), local("view.0", "view", DYN, true)],
    body,
    loc,
  });
}

/** `(a0, ..., an) => view[member](a0, ..., an)`, the result checked
 * against the method's declared return type. */
function memberInvoker(
  lowerer: Lowerer,
  fnName: string,
  member: string,
  type: FuncType,
  loc: SrcLoc,
) {
  const params = type.params.map((p, i) => ({ localId: `a${i}.0`, name: `a${i}`, type: p }));
  const call: IrExpr = {
    kind: "dynInvoke",
    recv: varRef("view.0", DYN, loc),
    method: member,
    calleeName: member,
    args: params.map((p) => lowerer.coerceToExpected(varRef(p.localId, p.type, loc), DYN)),
    type: DYN,
    loc,
  };
  const body: IrStmt[] =
    type.ret.kind === "void"
      ? [
          { kind: "exprStmt", expr: call, loc },
          { kind: "return", value: null, loc },
        ]
      : [{ kind: "return", value: lowerer.coerceToExpected(call, type.ret), loc }];
  return {
    name: fnName,
    params,
    returnType: type.ret.kind === "void" ? VOID : type.ret,
    captures: [{ localId: "view.0", name: "view", type: DYN }],
    locals: [
      ...params.map((p) => local(p.localId, p.name, p.type)),
      local("view.0", "view", DYN, true),
    ],
    body,
    loc,
  };
}

const PROJECTION_KEY = "builtin-methods:";

/** Whether a value of type `t` is, or holds, a record of shape `shapeId`. */
function holdsShape(lowerer: Lowerer, t: IrType, shapeId: string, seen: Set<string>): boolean {
  switch (t.kind) {
    case "record": {
      if (t.shapeId === shapeId) return true;
      if (seen.has(t.shapeId)) return false;
      seen.add(t.shapeId);
      const shape = lowerer.shapes.get(t.shapeId);
      if (!shape) return false;
      if (shape.indexValue && holdsShape(lowerer, shape.indexValue, shapeId, seen)) return true;
      return shape.fields.some((field) => holdsShape(lowerer, field.type, shapeId, seen));
    }
    case "array":
    case "set":
      return holdsShape(lowerer, t.elem, shapeId, seen);
    case "map":
      return (
        holdsShape(lowerer, t.key, shapeId, seen) || holdsShape(lowerer, t.value, shapeId, seen)
      );
    case "promise":
      return holdsShape(lowerer, t.inner, shapeId, seen);
    case "union": {
      if (seen.has(t.unionId)) return false;
      seen.add(t.unionId);
      const arms = lowerer.unions.get(t.unionId)?.arms ?? [];
      return arms.some((arm) => holdsShape(lowerer, arm, shapeId, seen));
    }
    default:
      return false;
  }
}

/** Refuses a program that observes a projected record as a whole object.
 *
 * In Node the record a handle is stored as IS the handle: its keys are the
 * handle's, it is identical to the handle, and untyped code that receives
 * it sees the handle. The projection is a separate record of the declared
 * methods, so a program that lists such a record's keys, converts it to a
 * string, serializes it, or hands it to untyped code (which is also how a
 * record is compared with a handle) would answer for that record instead.
 * The check runs once every function is lowered, over the record types the
 * program really projects a handle into: a type no handle reaches is not
 * looked at, and a program without a projection pays nothing. */
export function refuseObservedHandleProjections(
  lowerer: Lowerer,
  functions: readonly IrFunction[],
): void {
  const helpers = new Map<string, { shapeId: string; source: IrType }>();
  for (const [key, name] of lowerer.valueHelpers) {
    if (!key.startsWith(PROJECTION_KEY)) continue;
    const source = lowerer.liftedFnNamed(name)?.params[0]?.type;
    if (source) helpers.set(name, { shapeId: key.slice(key.lastIndexOf(":") + 1), source });
  }
  if (helpers.size === 0) return;
  const all = [...functions, ...lowerer.liftedFns];
  // The projections the program calls: one a discarded attempt built is
  // interned and never reached.
  const projected = new Map<string, IrType>();
  for (const fn of all)
    everyStmtList(fn.body, {
      stmt: () => true,
      expr: (e) => {
        const helper = e.kind === "call" ? helpers.get(e.callee) : undefined;
        if (helper) projected.set(helper.shapeId, helper.source);
        return true;
      },
    });
  if (projected.size === 0) return;
  const holder = (t: IrType): string | undefined => {
    for (const shapeId of projected.keys())
      if (holdsShape(lowerer, t, shapeId, new Set())) return shapeId;
    return undefined;
  };
  const refuse = (shapeId: string, how: string, loc: SrcLoc): void =>
    lowerer.pushDiag(
      handleProjectionObservedDiag(
        lowerer.fmt(projected.get(shapeId)!),
        lowerer.fmt({ kind: "record", shapeId }),
        how,
        loc,
      ),
    );
  for (const helper of lowerer.linkedHelpers)
    if (projected.has(helper.shapeId))
      refuse(
        helper.shapeId,
        helper.kind === "keys" || helper.kind === "hasOwn"
          ? "lists or tests its keys"
          : "converts it to a string or inspects it",
        helper.fn.loc,
      );
  for (const call of lowerer.recordMethodCalls)
    if (projected.has(call.shapeId)) refuse(call.shapeId, `calls '${call.method}' on it`, call.loc);
  // A union operand is compared arm by arm in an equality helper, where a
  // record arm never equals a handle.
  const equality = new Set(lowerer.equalityHelpers.values());
  for (const fn of all) {
    // The projection's own helpers box the handle, never the record.
    if (helpers.has(fn.name)) continue;
    everyStmtList(fn.body, {
      stmt: () => true,
      expr: (e) => {
        if (e.kind === "call" && equality.has(e.callee) && e.args.length === 2) {
          const [left, right] = [e.args[0]!.type, e.args[1]!.type];
          const shapeId = HANDLE_KINDS.has(right.kind)
            ? holder(left)
            : HANDLE_KINDS.has(left.kind)
              ? holder(right)
              : undefined;
          if (shapeId) refuse(shapeId, "compares it with the handle", e.loc);
        } else if (e.kind === "dynFrom") {
          const shapeId = holder(e.value.type);
          if (shapeId)
            refuse(shapeId, "hands it to untyped code or compares it with the handle", e.loc);
        } else if (e.kind === "jsonStringify") {
          const shapeId = holder(e.value.type);
          if (shapeId) refuse(shapeId, "serializes it", e.loc);
        } else if (e.kind === "libCall" && EXPOSING_LIB_CALLS.test(e.fn)) {
          for (const arg of e.args) {
            const shapeId = holder(arg.type);
            if (shapeId) refuse(shapeId, "prints or serializes it", e.loc);
          }
        }
        return true;
      },
    });
  }
}
