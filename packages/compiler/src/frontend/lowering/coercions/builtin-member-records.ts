/* A builtin handle flowing into a record of its members (`const sink: Sink =
 * process.stdout` with `interface Sink { write(s: string): void }`, or
 * process.stderr passed to a `{ write }` parameter): tsc accepts the flow
 * because the handle's type has every member the record declares.
 *
 * In Node the record IS the object, so a method call through it reads the
 * object's current member and runs it with the object as receiver. The
 * projection keeps that: each record method is a closure over the object's
 * checked-dynamic view that invokes the member by name, boxing the
 * arguments and checking the result against the field's declared return
 * type. A member the program replaced (`process.stdout.write = fn`) is the
 * one the call reaches.
 *
 * A DATA member is read once, at the projection, through the same view and
 * checked against its declared type: the copy stance every width conversion
 * takes. `help(command, { stream: process.stderr })` with
 * `HelpOptions.stream: { isTTY?: boolean }` is the shape.
 *
 * The record is a new value, as every width copy is: it is not identical
 * to the object, and it exposes only the declared members. Records that
 * declare index signatures or reserved slots are outside the projection and
 * keep SC2002. */
import { DYN, HANDLE_KINDS, VOID, typeEquals, canDynCheckTo } from "../../../ir/ir.js";
import type { IrExpr, IrLocal, IrStmt, IrType, SrcLoc } from "../../../ir/ir.js";
import { strLit, varRef } from "../../../ir/build.js";
import { typeKey } from "../../type-mapper.js";
import { keyedHelperName } from "../stable-names.js";
import { InternalCompilerError } from "../../../errors.js";
import type { Lowerer } from "../lowerer.js";

type FuncType = IrType & { kind: "func" };

/** One record field the projection produces: a METHOD as an invoker
 * closure, a DATA member as the value read off the object. */
type FieldPlan =
  | { name: string; kind: "method"; type: FuncType }
  | { name: string; kind: "value"; type: IrType };

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

/** The record's members when every one is projectable: a method whose
 * arguments box into the dynamic tier and whose result checks back out of
 * it, or a data member whose type checks back out of it. Else null. A
 * variadic method is outside the projection: the invoker calls the member
 * through the dynamic tier, which has no spread form, and the closure's
 * declared type would carry a rest ABI the invoker does not implement. */
function memberPlan(lowerer: Lowerer, shapeId: string): FieldPlan[] | null {
  const shape = lowerer.shapes.get(shapeId);
  if (!shape || shape.indexValue || shape.tuple || shape.fields.length === 0) return null;
  const fields: FieldPlan[] = [];
  for (const field of shape.fields) {
    if (field.name.startsWith("%")) return null;
    if (field.type.kind === "func") {
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
      fields.push({ name: field.name, kind: "method", type: fn });
      continue;
    }
    if (
      !canDynCheckTo(
        field.type,
        (id) => lowerer.shapes.get(id),
        (id) => lowerer.unions.get(id),
      )
    )
      return null;
    fields.push({ name: field.name, kind: "value", type: field.type });
  }
  return fields;
}

/** Whether a handle's members project into this record shape. Type-only, so
 * width planning can ask without building. */
export function canProjectBuiltinMembers(
  lowerer: Lowerer,
  source: IrType,
  shapeId: string,
): boolean {
  return isBuiltinHandle(lowerer, source) && memberPlan(lowerer, shapeId) !== null;
}

/** Interned `%builtin.members.<n>(o)`: the record of `o`'s members the
 * target declares, or null when the pair is outside the projection. */
export function builtinMemberHelper(
  lowerer: Lowerer,
  source: IrType,
  shapeId: string,
  loc: SrcLoc,
): string | null {
  if (!isBuiltinHandle(lowerer, source)) return null;
  const plan = memberPlan(lowerer, shapeId);
  if (!plan) return null;
  const key = `builtin-members:${typeKey(source)}:${shapeId}`;
  let name = lowerer.valueHelpers.get(key);
  if (!name) {
    name = keyedHelperName(lowerer, "%builtin.members", key);
    lowerer.valueHelpers.set(key, name);
    buildProjection(lowerer, name, source, shapeId, plan, loc);
  }
  return name;
}

/** The record of `expr`'s members the target declares, or null when the pair
 * is outside the projection. */
export function builtinMemberRecord(
  lowerer: Lowerer,
  expr: IrExpr,
  shapeId: string,
  loc: SrcLoc,
): IrExpr | null {
  const name = builtinMemberHelper(lowerer, expr.type, shapeId, loc);
  if (!name) return null;
  const type: IrType = { kind: "record", shapeId };
  return { kind: "call", callee: name, args: [expr], type, loc };
}

function buildProjection(
  lowerer: Lowerer,
  name: string,
  source: IrType,
  shapeId: string,
  plan: FieldPlan[],
  loc: SrcLoc,
): void {
  const result: IrType = { kind: "record", shapeId };
  const view: IrExpr = varRef("view.0", DYN, loc);
  const fields = plan.map((entry, i) => {
    if (entry.kind === "method") {
      const fnName = `${name}.${i}`;
      lowerer.liftedFns.push(memberInvoker(lowerer, fnName, entry.name, entry.type, loc));
      lowerer.noteEdge(fnName);
      const closure: IrExpr = {
        kind: "closure",
        fnName,
        captures: ["view.0"],
        type: entry.type,
        loc,
      };
      return { name: entry.name, value: closure };
    }
    const read: IrExpr = {
      kind: "dynKeyGet",
      value: view,
      key: strLit(entry.name, loc),
      type: DYN,
      loc,
    };
    return { name: entry.name, value: lowerer.coerceToExpected(read, entry.type) };
  });
  const checked = lowerer.coerceToExpected(varRef("o.0", source, loc), DYN);
  if (!typeEquals(checked.type, DYN))
    throw new InternalCompilerError(
      `lowerer bug: ${lowerer.fmt(source)} has no checked-dynamic view`,
    );
  const body: IrStmt[] = [
    { kind: "varDecl", localId: "view.0", init: checked, loc },
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
