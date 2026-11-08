import { varRef } from "../../ir/build.js";
import * as ts from "../ts7/adapter.js";
import { BOOL, DYN, type IrExpr, type IrFunction, type IrStmt, type SrcLoc } from "../../ir/ir.js";
import type { Lowerer } from "./lowerer.js";
import { PoisonError, newFnCtx } from "./lowerer.js";
import type { ClassInfo } from "./lower-classes.js";
import { classMethodValue, declaredLength, readsReceiver } from "./class-method-values.js";
import { classInstanceOf } from "./class-dynamic-dispatch.js";

/** A member of a generic class's prototype as dynamic code reads it
 * (genericPrototypeMember): the function that picks, by receiver, the
 * member of the instantiation the receiver is an instance of. */
export interface GenericPrototypeMember {
  family: ClassInfo;
  method: string;
  /** The member never reads its receiver: it answers on any receiver. */
  receiverless: boolean;
  select: IrFunction;
  /** The member's value per instantiation, null where it has none. */
  arms: Map<string, { info: ClassInfo; value: IrExpr | null }>;
  loc: SrcLoc;
}

/** Whether `info` is a generic class, an instantiation of one, or a class
 * below one. */
export function inGenericChain(info: ClassInfo): boolean {
  for (let current: ClassInfo | null = info; current; current = current.base)
    if (current.generic || current.genericInstance) return true;
  return false;
}

/** The globals that hold the first constructor of generic class `family`
 * that became a dynamic value. JavaScript has one class object per
 * declaration: every instantiation's constructor is that value to `===`
 * and answers with its table (instantiationStaticTable). */
export function genericClassFirst(
  lowerer: Lowerer,
  family: ClassInfo,
): { firstId: string; readyId: string } {
  const firstId = `%g.%class.statics:${family.def.name}.first`;
  const readyId = `${firstId}.ready`;
  if (!family.genericFirstConstructor) {
    family.genericFirstConstructor = true;
    const name = family.def.jsName ?? family.def.name;
    lowerer.globalsList.push(
      { id: firstId, name: `${name} constructor`, type: DYN, mutable: true },
      { id: readyId, name: `${name} constructor.ready`, type: BOOL, mutable: true },
    );
  }
  return { firstId, readyId };
}

/** The getter of `constructor` on a generic class's prototype: the first
 * constructor of the class that became a dynamic value. Before there is
 * one, no dynamic value is the class, and the read is refused by name. */
export function genericClassConstructor(lowerer: Lowerer, family: ClassInfo, loc: SrcLoc): IrExpr {
  const name = `%prototype.constructor:${family.def.name}`;
  if (lowerer.liftedFnNamed(name) === undefined) {
    const { firstId, readyId } = genericClassFirst(lowerer, family);
    lowerer.liftedFns.push({
      name,
      params: [],
      locals: [],
      returnType: DYN,
      body: [
        {
          kind: "if",
          cond: varRef(readyId, BOOL, loc),
          then: [{ kind: "return", value: varRef(firstId, DYN, loc), loc }],
          else_: null,
          loc,
        },
        {
          kind: "runtimeFence",
          code: "SC1090",
          message:
            "the constructor of a generic class read from its prototype before the class was used as a value is not supported yet",
          loc,
        },
      ],
      loc,
    });
  }
  return {
    kind: "closure",
    fnName: name,
    captures: [],
    type: { kind: "func", params: [], ret: DYN },
    loc,
  };
}

/** The value of member `method` on the prototype of generic class `family`
 * as dynamic code sees it. The declaration has one function per
 * instantiation, so the value takes its receiver and arguments unchecked
 * and applies the function of the instantiation the receiver belongs to
 * (the declaration's own function, never an override below it). A receiver
 * of no instantiation is refused by name, unless the member never reads its
 * receiver. The instantiations join as the program's lowering finds them
 * (refreshGenericPrototypeMembers). */
export function genericPrototypeMember(
  lowerer: Lowerer,
  family: ClassInfo,
  member: ts.MethodDeclaration | ts.AccessorDeclaration,
  method: string,
  loc: SrcLoc,
): IrExpr {
  const name = `%prototype.member:${family.def.name}.${method}`;
  const selectName = `%prototype.select:${family.def.name}.${method}`;
  if (!lowerer.genericPrototypeMembers.has(selectName)) {
    const select: IrFunction = {
      name: selectName,
      params: [{ localId: "this.0", name: "this", type: DYN }],
      locals: [{ id: "this.0", name: "this", type: DYN, mutable: false }],
      returnType: DYN,
      body: [],
      loc,
    };
    const entry: GenericPrototypeMember = {
      family,
      method,
      receiverless: !readsReceiver(member),
      select,
      arms: new Map(),
      loc,
    };
    select.body = selectBody(lowerer, entry);
    lowerer.genericPrototypeMembers.set(selectName, entry);
    const receiver = varRef("receiver", DYN, loc);
    lowerer.liftedFns.push(select, {
      name,
      params: [
        { localId: "first", name: "first", type: DYN },
        { localId: "values", name: "values", type: DYN },
      ],
      locals: [
        { id: "first", name: "first", type: DYN, mutable: false },
        { id: "values", name: "values", type: DYN, mutable: false },
        { id: "receiver", name: "receiver", type: DYN, mutable: false },
      ],
      returnType: DYN,
      body: [
        {
          kind: "varDecl",
          localId: "receiver",
          init: { kind: "libCall", fn: "dyn.this", args: [], type: DYN, loc },
          loc,
        },
        {
          kind: "return",
          value: {
            kind: "libCall",
            fn: "dyn.reflectApply",
            args: [
              { kind: "call", callee: selectName, args: [receiver], type: DYN, loc },
              receiver,
              varRef("values", DYN, loc),
            ],
            type: DYN,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
  }
  const length = ts.isMethodDeclaration(member) ? declaredLength(member) : 1;
  return {
    kind: "closure",
    fnName: name,
    captures: [],
    ...(length !== 1 ? { length } : {}),
    type: { kind: "func", params: [DYN], ret: DYN, rest: true, argumentsAll: true },
    loc,
  };
}

function selectBody(lowerer: Lowerer, entry: GenericPrototypeMember): IrStmt[] {
  const loc = entry.loc;
  const receiver = varRef("this.0", DYN, loc);
  const refusal = (message: string): IrStmt => ({
    kind: "runtimeFence",
    code: "SC1090",
    message,
    loc,
  });
  const answer = (value: IrExpr | null): IrStmt =>
    value
      ? { kind: "return", value, loc }
      : refusal(
          `the member '${entry.method}' of a generic class read through its prototype has no value for this instantiation yet`,
        );
  const body: IrStmt[] = [];
  for (const { info, value } of entry.arms.values())
    body.push({
      kind: "if",
      cond: classInstanceOf(lowerer, receiver, info, loc),
      then: [answer(value)],
      else_: null,
      loc,
    });
  const first = [...entry.arms.values()].find((arm) => arm.value !== null);
  body.push(
    entry.receiverless && first
      ? answer(first.value)
      : refusal(
          `the member '${entry.method}' of a generic class called through its prototype on a receiver that is not an instance of the class is not supported yet`,
        ),
  );
  return body;
}

/** Adds the instantiations found since the last call to every generic
 * prototype member. True when one grew. */
export function refreshGenericPrototypeMembers(lowerer: Lowerer): boolean {
  let changed = false;
  for (const entry of lowerer.genericPrototypeMembers.values()) {
    const generic = entry.family.generic;
    if (!generic) continue;
    let added = false;
    // The members lower outside any source function; their `this` is their
    // own receiver.
    const context = newFnCtx(false, null, null, DYN);
    context.thisBoundary = true;
    lowerer.fnStack.push(context);
    try {
      for (const instance of generic.instances.values()) {
        const info = instance.info;
        if (!info || entry.arms.has(info.def.name)) continue;
        const before = lowerer.diags.length;
        let value: IrExpr | null = null;
        try {
          const compiled = classMethodValue(lowerer, generic.decl, info, entry.method, entry.loc);
          if (compiled && lowerer.dynConvertible(compiled.type))
            value = lowerer.coerceToExpected(compiled, DYN);
        } catch (error) {
          if (!(error instanceof PoisonError)) throw error;
          lowerer.diags.splice(before);
        }
        entry.arms.set(info.def.name, { info, value });
        added = true;
      }
      if (added) entry.select.body = selectBody(lowerer, entry);
    } finally {
      entry.select.locals.push(...context.locals);
      lowerer.fnStack.pop();
    }
    changed ||= added;
  }
  return changed;
}
