import { keyedHelperName } from "./stable-names.js";
import { varRef } from "../../ir/build.js";
import {
  type IrExpr,
  type IrLocal,
  type IrParam,
  type IrType,
  type SrcLoc,
  VOID,
  funcOf,
  typeKey,
} from "../../ir/ir.js";
import { newFnCtx, type Lowerer } from "./lowerer.js";

/** An executor VALUE whose parameters are checked-dynamic (a JavaScript
 * function declaration: `function run(resolve, reject) {...}; return new
 * Promise(run)`): the promise's native executor is an adapter closure that
 * receives the native (resolve, reject) pair and calls the original with
 * both boxed into the checked-dynamic tree, so the JavaScript body calls
 * them like any function value. Null when the executor's shape is not
 * adaptable (more than two parameters, a rest parameter, or a parameter
 * that neither is dyn nor already the native closure). */
export function adaptPromiseExecutor(
  lowerer: Lowerer,
  executor: IrExpr,
  inner: IrType,
  loc: SrcLoc,
): IrExpr | null {
  const execT = executor.type;
  if (execT.kind !== "func" || execT.rest || execT.params.length > 2) return null;
  if (!execT.params.some((p) => p.kind === "dyn")) return null;
  const resolveT = funcOf(inner.kind === "void" ? [] : [inner], VOID);
  const rejectT = funcOf([{ kind: "object", className: "%Error" }], VOID);
  const native = [resolveT, rejectT];
  if (
    !execT.params.every((p, i) => p.kind === "dyn" || typeKey(p) === typeKey(native[i]!)) ||
    !native.slice(0, execT.params.length).every((t) => lowerer.dynConvertible(t))
  )
    return null;
  const adaptT = funcOf(native, VOID);
  const key = `promise.executor:${typeKey(execT)}:${typeKey(inner)}`;
  let name = lowerer.arrHofHelpers.get(key);
  if (name === undefined) {
    name = keyedHelperName(lowerer, "%promise.executor", key);
    lowerer.arrHofHelpers.set(key, name);
    const impl = `${name}.impl`;
    const captured: IrLocal = { id: "f.0", name: "f", type: execT, mutable: false, boxed: true };
    const params: IrParam[] = [
      { localId: "resolve.0", name: "resolve", type: resolveT },
      { localId: "reject.0", name: "reject", type: rejectT },
    ];
    const ctx = newFnCtx(false, null, null, VOID);
    lowerer.fnStack.push(ctx);
    let args: IrExpr[];
    try {
      args = execT.params.map((p, i) =>
        lowerer.coerceToExpected(varRef(params[i]!.localId, native[i]!, loc), p),
      );
    } finally {
      lowerer.fnStack.pop();
    }
    lowerer.liftedFns.push({
      name: impl,
      params,
      returnType: VOID,
      captures: [{ localId: captured.id, name: captured.name, type: execT }],
      locals: [
        captured,
        ...params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false })),
        ...ctx.locals,
      ],
      body: [
        {
          kind: "exprStmt",
          expr: {
            kind: "callValue",
            callee: varRef(captured.id, execT, loc),
            args,
            type: execT.ret,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
    lowerer.liftedFns.push({
      name,
      params: [{ localId: captured.id, name: captured.name, type: execT }],
      returnType: adaptT,
      locals: [captured],
      body: [
        {
          kind: "return",
          value: { kind: "closure", fnName: impl, captures: [captured.id], type: adaptT, loc },
          loc,
        },
      ],
      loc,
    });
  }
  return { kind: "call", callee: name, args: [executor], type: adaptT, loc };
}
