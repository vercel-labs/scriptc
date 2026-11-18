/* Member reads and `in` on an instance whose prototype Object.setPrototypeOf
 * may have replaced (Lowerer.reprototypedClasses, class-method-mutations.ts).
 *
 * Such an instance looks its methods and accessors up through the prototype
 * it was given. The declared read answers for every instance that kept its
 * class's prototype; once the runtime reports that some instance's prototype
 * changed (one global test), the read asks this instance, and a replaced one
 * takes the checked-dynamic read, which walks the prototype it has. The
 * receiver is read twice, so only a name or `this` takes the guard; another
 * receiver keeps the declared read. */
import { BOOL, DYN, type IrExpr, type SrcLoc } from "../../ir/ir.js";
import * as ts from "../ts7/adapter.js";
import { withoutParentheses } from "../outer-expressions.js";
import { mayReplacePrototype } from "./class-method-mutations.js";
import type { Lowerer } from "./lowerer.js";

/** The nodes whose declared read is being lowered inside the guard. */
const guarded = new Set<ts.Node>();

/** The receiver `node`, a name or `this` whose value is an instance of a
 * class a setPrototypeOf call may reprototype; null otherwise. */
export function reprototypedReceiver(lowerer: Lowerer, node: ts.Expression): ts.Expression | null {
  const receiver = withoutParentheses(node);
  if (!ts.isIdentifier(receiver) && receiver.kind !== ts.SyntaxKind.ThisKeyword) return null;
  const type = lowerer.mapTypeOf(lowerer.typeOf(receiver));
  if (type?.kind !== "object") return null;
  const info = lowerer.classes.get(type.className);
  if (!info || !mayReplacePrototype(lowerer, info)) return null;
  return lowerer.lowerExpr(receiver).type.kind === "object" ? receiver : null;
}

/** `declared` behind the test that the receiver's prototype is its
 * class's; `dynamic` reads the boxed receiver otherwise. Null when the
 * site takes no guard (it is already being lowered inside one, or its
 * receiver is not a guarded one). */
export function reprototypedGuard(
  lowerer: Lowerer,
  site: ts.Node,
  receiverNode: ts.Expression,
  loc: SrcLoc,
  dynamic: (boxed: IrExpr) => IrExpr,
  declared: () => IrExpr,
): IrExpr | null {
  if (guarded.has(site)) return null;
  const receiver = reprototypedReceiver(lowerer, receiverNode);
  if (receiver === null) return null;
  guarded.add(site);
  let answer: IrExpr;
  try {
    answer = declared();
  } finally {
    guarded.delete(site);
  }
  if (answer.type.kind === "void") return null;
  const boxed = (): IrExpr => lowerer.coerceToExpected(lowerer.lowerExpr(receiver), DYN);
  return {
    kind: "ternary",
    cond: {
      kind: "logical",
      op: "&&",
      left: { kind: "libCall", fn: "dyn.prototypesReplaced", args: [], type: BOOL, loc },
      right: { kind: "libCall", fn: "dyn.prototypeReplaced", args: [boxed()], type: BOOL, loc },
      type: BOOL,
      loc,
    },
    then: lowerer.coerceToExpected(dynamic(boxed()), answer.type),
    else_: answer,
    type: answer.type,
    loc,
  };
}
