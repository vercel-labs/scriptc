import { varRef } from "../../../ir/build.js";
import * as ts from "../../ts7/adapter.js";
import type { Lowerer } from "../lowerer.js";
import {
  BOOL,
  DYN,
  type IrExpr,
  type IrStmt,
  type IrType,
  STRING,
  type SrcLoc,
} from "../../../ir/ir.js";
import { locOf } from "../../program.js";

/* ── dyn METHOD receivers ──────────────────────────────────────────────────
 * Method calls on `unknown`/JSON.parse-derived receivers (`pkg.name
 * .replace(...)`, `ws.packages.filter(...)`): validate the receiver's dyn
 * kind, extract, then ride the STATIC method machinery — the dyn boundary's
 * trust-but-VERIFY stance extended to receivers. A receiver of the wrong
 * kind throws the catchable Node-shaped TypeError V8 would ("x.replace is
 * not a function"; nullish receivers throw the property-READ message,
 * "Cannot read properties of undefined (reading 'replace')"). */

/** a + b (+ c...) over strConcat. */
export function concatStrings(pieces: IrExpr[], loc: SrcLoc): IrExpr {
  return pieces.reduce((left, right) => ({ kind: "strConcat", left, right, type: STRING, loc }));
}

const TYPE_ERROR_T: IrType = { kind: "object", className: "%TypeError" };

/** `throw new TypeError(<msg>)` from IR pieces (the runtime error class —
 * catchable, instanceof TypeError). */
export function throwTypeError(msg: IrExpr, loc: SrcLoc): IrStmt {
  return {
    kind: "throw",
    value: { kind: "libCall", fn: "error.new", args: [msg], type: TYPE_ERROR_T, loc },
    loc,
  };
}

/** The three mismatch throws of a dyn method receiver, Node's own order and
 * messages: undefined/null receivers fail the property READ ("Cannot read
 * properties of undefined (reading 'replace')"), anything else of the wrong
 * kind fails the CALL ("pkg.name.replace is not a function"). `m` and
 * `full` are the helper's string params holding the method name and the
 * source text of the whole access. */
export function dynamicReceiverThrows(
  dRef: IrExpr,
  mRef: IrExpr,
  fullRef: IrExpr,
  loc: SrcLoc,
): IrStmt[] {
  const reading = (unit: "undefined" | "null"): IrStmt => ({
    kind: "if",
    cond: { kind: "dynTest", test: unit, value: dRef, type: BOOL, loc },
    then: [
      throwTypeError(
        concatStrings(
          [
            {
              kind: "strLit",
              value: `Cannot read properties of ${unit} (reading '`,
              type: STRING,
              loc,
            },
            mRef,
            { kind: "strLit", value: "')", type: STRING, loc },
          ],
          loc,
        ),
        loc,
      ),
    ],
    else_: null,
    loc,
  });
  return [
    reading("undefined"),
    reading("null"),
    throwTypeError(
      concatStrings(
        [fullRef, { kind: "strLit", value: " is not a function", type: STRING, loc }],
        loc,
      ),
      loc,
    ),
  ];
}

/** The interned `%dyn.recvstr` helper: validate a dyn receiver as a STRING
 * and extract it (+1), or throw the Node-shaped TypeError. One helper for
 * the whole module — the method name and access text ride as arguments. */
function dynamicStringReceiverHelper(lowerer: Lowerer, loc: SrcLoc): string {
  const key = "dynrecv:string";
  const existing = lowerer.arrHofHelpers.get(key);
  if (existing) return existing;
  const name = "%dyn.recvstr";
  lowerer.arrHofHelpers.set(key, name);

  const d = varRef("d.0", DYN, loc);
  const body: IrStmt[] = [
    {
      kind: "if",
      cond: { kind: "dynTest", test: "string", value: d, type: BOOL, loc },
      then: [{ kind: "return", value: { kind: "dynCheck", value: d, type: STRING, loc }, loc }],
      else_: null,
      loc,
    },
    ...dynamicReceiverThrows(d, varRef("m.0", STRING, loc), varRef("full.0", STRING, loc), loc),
  ];
  lowerer.liftedFns.push({
    name,
    params: [
      { localId: "d.0", name: "d", type: DYN },
      { localId: "m.0", name: "m", type: STRING },
      { localId: "full.0", name: "full", type: STRING },
    ],
    returnType: STRING,
    locals: [
      { id: "d.0", name: "d", type: DYN, mutable: false },
      { id: "m.0", name: "m", type: STRING, mutable: false },
      { id: "full.0", name: "full", type: STRING, mutable: false },
    ],
    body,
    loc,
  });
  return name;
}

/** The validated-STRING extraction of a dyn method receiver — the receiver
 * expression the string/regex method lowerings consume. */
export function dynStringReceiver(
  lowerer: Lowerer,
  recv: IrExpr,
  access: ts.PropertyAccessExpression,
): IrExpr {
  const loc = locOf(access);
  const helper = dynamicStringReceiverHelper(lowerer, loc);
  return {
    kind: "call",
    callee: helper,
    args: [
      recv,
      { kind: "strLit", value: access.name.text, type: STRING, loc },
      { kind: "strLit", value: ts.getTextOfNode(access), type: STRING, loc },
    ],
    type: STRING,
    loc,
  };
}
